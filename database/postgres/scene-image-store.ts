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
    async claimOrCreateGeneration(scope: {
      workspaceId: string;
      worldId: string;
      recordId: string;
      sceneId: string;
      queuePrompt: () => Promise<string>;
    }): Promise<{ generation: SceneImageGeneration; reused: boolean }> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [scope.workspaceId, scope.recordId],
          );
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
            await client.query(
              `UPDATE scene_image_generations SET updated_at = CURRENT_TIMESTAMP
               WHERE workspace_id = $1 AND id = $2`,
              [scope.workspaceId, active.rows[0].id],
            );
            return { generation: toGeneration(active.rows[0]), reused: true };
          }
          const promptId = await scope.queuePrompt();
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
