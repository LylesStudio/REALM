/**
 * 场景图生成台账 + world_files 绑定（server-only repository）。
 * 语义：一条 Record 同时最多一条 active（queued/running）生成——复用不新建；
 * ready 绑定 file_id（world_files 同事务写入）；failed 只留安全分类码；
 * 无 DELETE（台账不可删）。所有读写经 withWorkspaceTransaction（RLS）。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";
import {
  settleRequestCompletedWithClient,
  settleRequestFailedWithClient,
} from "./scene-image-queue.ts";

/** worker lease fencing 输入：queue 请求 id + claim 时的 lease_revision。 */
export interface SceneImageFence {
  requestId: string;
  leaseRevision: number;
}

/** authority 已失（stale lease）的写入一律拒绝。 */
export class SceneImageFenceError extends Error {
  constructor() {
    super("SCENE_IMAGE_FENCE_STALE");
    this.name = "SceneImageFenceError";
  }
}

/**
 * authority 原子谓词（M8）：请求行仍 leased 且 lease_revision 等于当前值。
 * 规则：过期本身不撤销 authority；只有恢复后由新 worker 再 claim
 * （lease_revision 前进）或终态才使旧 worker 失去写入权。
 */
const FENCE_PREDICATE_SQL = `SELECT 1 FROM scene_image_requests
  WHERE workspace_id = $1 AND id = $2 AND status = 'leased' AND lease_revision = $3
  LIMIT 1`;

async function assertFence(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  workspaceId: string,
  fence: SceneImageFence,
): Promise<void> {
  const result = await client.query(FENCE_PREDICATE_SQL, [
    workspaceId, fence.requestId, fence.leaseRevision,
  ]);
  if (result.rows.length === 0) throw new SceneImageFenceError();
}

/**
 * 锁定重验（queuePrompt TOCTOU 收口）：外部 provider 调用返回后、台账
 * 写入/副作用前调用。FOR UPDATE 行锁使本事务与 recoverStale/claim 的
 * UPDATE 互斥——要么我们先锁定并提交（接管方随后看到已落台账，走正常
 * reuse/接管语义），要么接管先生效（锁解除后重读发现 revision 已前进/
 * 非 leased）→ SceneImageFenceError。慢速 provider 调用期间绝不持有
 * 该 request 行锁。
 */
async function assertFenceLocked(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  workspaceId: string,
  fence: SceneImageFence,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM scene_image_requests
     WHERE workspace_id = $1 AND id = $2 AND status = 'leased' AND lease_revision = $3
     FOR UPDATE`,
    [workspaceId, fence.requestId, fence.leaseRevision],
  );
  if (result.rows.length === 0) throw new SceneImageFenceError();
}

export type SceneImageGenerationStatus = "queued" | "running" | "ready" | "failed";

export interface SceneImageGeneration {
  id: string;
  worldId: string;
  recordId: string;
  sceneId: string;
  status: SceneImageGenerationStatus;
  fileId: string | null;
  promptId: string | null;
  errorCode: string | null;
}

export interface SceneImageFileInput {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
  data: Buffer;
}

export function createPostgresSceneImageStore(database: WorkspaceDatabase) {
  return {
    /** 当前 Record 的活跃生成（queued/running），用于重复点击复用。 */
    async findActiveGeneration(
      scope: { workspaceId: string; recordId: string },
    ): Promise<SceneImageGeneration | null> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT id, world_id, record_id, scene_id, status, file_id, prompt_id, error_code
             FROM scene_image_generations
             WHERE workspace_id = $1 AND record_id = $2
               AND status IN ('queued', 'running')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [scope.workspaceId, scope.recordId],
          );
          return result.rows[0] ? toGeneration(result.rows[0]) : null;
        },
        { readOnly: true },
      );
    },

    /**
     * 原子 claim：同一 workspace/Record 在 queue 前由事务 advisory lock
     * 串行化 active 检查。已有 active 只更新时间并复用；没有 active 才调用
     * queuePrompt 并在同一事务创建 running 台账。
     */
    async claimOrCreateGeneration(
      scope: {
        workspaceId: string;
        worldId: string;
        recordId: string;
        sceneId: string;
        queuePrompt: () => Promise<string>;
      },
      options?: { fence?: SceneImageFence },
    ): Promise<{ generation: SceneImageGeneration; reused: boolean }> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          // 锁序（文档化）：① record advisory lock → ② fence 谓词（fail-fast，
          // 避免已失效时仍发起 provider 调用）→ ③ generation 行（reuse/create）
          // → ④（settle 时）world_files → ⑤ generation 终态 → ⑥ request 终态。
          // TOCTOU 收口：provider queuePrompt() 慢调用期间不持 request 行锁；
          // 返回后在台账 INSERT / reuse 副作用前用 FOR UPDATE 锁定重验
          // （与 recoverStale/claim 的 UPDATE 互斥），authority 已失即拒绝。
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [scope.workspaceId, scope.recordId],
          );
          if (options?.fence) {
            await assertFence(client, scope.workspaceId, options.fence);
          }
          const active = await client.query(
            `SELECT id, world_id, record_id, scene_id, status, file_id, prompt_id, error_code
             FROM scene_image_generations
             WHERE workspace_id = $1 AND record_id = $2
               AND status IN ('queued', 'running')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [scope.workspaceId, scope.recordId],
          );
          if (active.rows[0]) {
            if (options?.fence) {
              await assertFenceLocked(client, scope.workspaceId, options.fence);
            }
            await client.query(
              `UPDATE scene_image_generations SET updated_at = CURRENT_TIMESTAMP
               WHERE workspace_id = $1 AND id = $2`,
              [scope.workspaceId, active.rows[0].id],
            );
            return { generation: toGeneration(active.rows[0]), reused: true };
          }
          const promptId = await scope.queuePrompt();
          if (options?.fence) {
            await assertFenceLocked(client, scope.workspaceId, options.fence);
          }
          const id = `sceneimg_${randomBytes(12).toString("hex")}`;
          const created = await client.query(
            `INSERT INTO scene_image_generations
               (workspace_id, id, world_id, record_id, scene_id, status, prompt_id)
             VALUES ($1, $2, $3, $4, $5, 'running', $6)
             RETURNING id, world_id, record_id, scene_id, status, file_id, prompt_id, error_code`,
            [scope.workspaceId, id, scope.worldId, scope.recordId, scope.sceneId, promptId],
          );
          return { generation: toGeneration(created.rows[0]), reused: false };
        },
      );
    },

    /** 当前 Record 最新 ready 背景（envelope 透出用）。 */
    async findLatestReady(
      scope: { workspaceId: string; recordId: string },
    ): Promise<SceneImageGeneration | null> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT id, world_id, record_id, scene_id, status, file_id, prompt_id, error_code
             FROM scene_image_generations
             WHERE workspace_id = $1 AND record_id = $2 AND status = 'ready'
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [scope.workspaceId, scope.recordId],
          );
          return result.rows[0] ? toGeneration(result.rows[0]) : null;
        },
        { readOnly: true },
      );
    },

    async createGeneration(scope: {
      workspaceId: string;
      worldId: string;
      recordId: string;
      sceneId: string;
      promptId: string;
    }): Promise<SceneImageGeneration> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const id = `sceneimg_${randomBytes(12).toString("hex")}`;
          const result = await client.query(
            `INSERT INTO scene_image_generations
               (workspace_id, id, world_id, record_id, scene_id, status, prompt_id)
             VALUES ($1, $2, $3, $4, $5, 'running', $6)
             RETURNING id, world_id, record_id, scene_id, status, file_id, prompt_id, error_code`,
            [scope.workspaceId, id, scope.worldId, scope.recordId, scope.sceneId, scope.promptId],
          );
          return toGeneration(result.rows[0]);
        },
      );
    },

    /** 台账 running（重复点击复用后重新轮询前刷新 updated_at）。 */
    async touchGeneration(scope: { workspaceId: string; id: string }): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `UPDATE scene_image_generations SET updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
            [scope.workspaceId, scope.id],
          );
        },
      );
    },

    /**
     * 完成：world_files 行与台账 ready 同事务（文件不落库则台账不 ready，
     * 绝不留可见半成品）。
     */
    async completeGeneration(
      scope: { workspaceId: string; worldId: string; id: string },
      file: SceneImageFileInput,
    ): Promise<{ fileId: string }> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const fileId = `file_${createHash("sha256")
            .update(file.data)
            .digest("hex")
            .slice(0, 32)}`;
          // content-addressed id：相同字节重存是幂等复用（不报错、不重复行）。
          await client.query(
            `INSERT INTO world_files
               (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
             VALUES ($1, $2, $3, 'scene_background', $4, $5, $6, $7, $8)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              fileId,
              file.contentType,
              file.filename,
              createHash("sha256").update(file.data).digest("hex"),
              file.data.length,
              file.data,
            ],
          );
          const updated = await client.query(
            `UPDATE scene_image_generations
             SET status = 'ready', file_id = $3, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
            [scope.workspaceId, scope.id, fileId],
          );
          if ((updated.rowCount ?? 0) === 0) {
            throw new Error("scene image generation is no longer active");
          }
          return { fileId };
        },
      );
    },

    /**
     * 当前持有者的原子完成（M8）：request advisory lock → 幂等读回/fence
     * 谓词 → world_files 写入 → generation ready → request completed，同一
     * 事务；任何一步失败整体回滚（不留半成品/部分终态）。
     *
     * 恢复契约（crash-after-commit）：提交已提交但 worker 未收到确认时，
     * 同一 request+revision+generation 的重放返回 `{ replayed: true,
     * fileId: 既有 }`，零写入。不同 request、旧 revision、不同 generation
     * 或任何 authority 已失的写入一律 SceneImageFenceError（fail-closed，
     * 绝不静默成功）。
     */
    async completeGenerationAndSettle(
      scope: { workspaceId: string; worldId: string; id: string },
      file: SceneImageFileInput,
      fence: SceneImageFence,
    ): Promise<{ fileId: string; replayed: boolean }> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          // 锁序（文档化）：① request advisory lock（序列化原始完成与
          // crash 后重放/并发重复完成）→ ② 幂等读回或 fence 谓词 →
          // ③ world_files → ④ generation 终态 → ⑤ request 终态。
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [scope.workspaceId, fence.requestId],
          );
          // 幂等读回：精确匹配同一 request + 同一 lease revision + 同一
          // generation 的已完成终态，返回既有 fileId，零写入。
          const replay = await client.query(
            `SELECT generation.file_id AS file_id
             FROM scene_image_requests AS request
             JOIN scene_image_generations AS generation
               ON generation.workspace_id = request.workspace_id
              AND generation.id = request.generation_id
             WHERE request.workspace_id = $1
               AND request.id = $2
               AND request.status = 'completed'
               AND request.lease_revision = $3
               AND request.generation_id = $4`,
            [scope.workspaceId, fence.requestId, fence.leaseRevision, scope.id],
          );
          const replayFileId = (replay.rows[0] as { file_id?: unknown } | undefined)?.file_id;
          if (typeof replayFileId === "string") {
            return { fileId: replayFileId, replayed: true };
          }
          await assertFence(client, scope.workspaceId, fence);
          const fileId = `file_${createHash("sha256")
            .update(file.data)
            .digest("hex")
            .slice(0, 32)}`;
          // content-addressed id：相同字节重存是幂等复用（不报错、不重复行）。
          await client.query(
            `INSERT INTO world_files
               (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
             VALUES ($1, $2, $3, 'scene_background', $4, $5, $6, $7, $8)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              fileId,
              file.contentType,
              file.filename,
              createHash("sha256").update(file.data).digest("hex"),
              file.data.length,
              file.data,
            ],
          );
          const updated = await client.query(
            `UPDATE scene_image_generations
             SET status = 'ready', file_id = $3, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
            [scope.workspaceId, scope.id, fileId],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error("scene image generation is no longer active");
          }
          const settled = await settleRequestCompletedWithClient(
            client,
            { workspaceId: scope.workspaceId, id: fence.requestId, leaseRevision: fence.leaseRevision },
            scope.id,
          );
          if (!settled) throw new SceneImageFenceError();
          return { fileId, replayed: false };
        },
      );
    },

    /**
     * 同上的原子失败终态（generation failed + request failed 同事务）。
     * 恢复契约：request failed 是终态，recoverStale 不会重捡，crash-after-
     * commit 无需重放；任何重放/stale 写入一律 SceneImageFenceError。
     */
    async failGenerationAndSettle(
      scope: { workspaceId: string; id: string },
      errorCode: string,
      fence: SceneImageFence,
    ): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          // 与 completeGenerationAndSettle 同一锁序：request advisory lock
          // → fence 谓词 → generation 终态 → request 终态。
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [scope.workspaceId, fence.requestId],
          );
          await assertFence(client, scope.workspaceId, fence);
          const updated = await client.query(
            `UPDATE scene_image_generations
             SET status = 'failed', error_code = $3, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
            [scope.workspaceId, scope.id, errorCode.slice(0, 64)],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error("scene image generation is no longer active");
          }
          const settled = await settleRequestFailedWithClient(
            client,
            { workspaceId: scope.workspaceId, id: fence.requestId, leaseRevision: fence.leaseRevision },
            errorCode,
          );
          if (!settled) throw new SceneImageFenceError();
        },
      );
    },

    /** 失败：只记安全分类码（绝不写 provider body/路径/URL）。 */
    async failGeneration(
      scope: { workspaceId: string; id: string },
      errorCode: string,
    ): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `UPDATE scene_image_generations
             SET status = 'failed', error_code = $3, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
            [scope.workspaceId, scope.id, errorCode.slice(0, 64)],
          );
        },
      );
    },
  };
}

function toGeneration(row: Record<string, unknown>): SceneImageGeneration {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    recordId: String(row.record_id),
    sceneId: String(row.scene_id),
    status: String(row.status) as SceneImageGenerationStatus,
    fileId: row.file_id === null ? null : String(row.file_id),
    promptId: row.prompt_id === null ? null : String(row.prompt_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
  };
}

export type SceneImageStore = ReturnType<typeof createPostgresSceneImageStore>;
