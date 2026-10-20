import type { Pool } from "pg";
import { createRealmDevPostgresPool } from "../../database/postgres/realm-dev-pool.ts";
import { withWorkspaceTransaction } from "../../database/postgres/workspace-transaction.ts";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";

/**
 * 批次 T9：路由级共享连接池（按连接串复用，进程生命周期）。
 * 此前 canon/world-knowledge 每请求新建 Pool 且从不回收——空闲客户端在
 * 数据库重启/测试拆库时抛出未捕获错误。池级 error 事件吞掉空闲客户端
 * 终止噪音；测试结束经 endSharedRuntimePools 显式回收。
 */
const sharedPools = new Map<string, Pool>();

export function getSharedRuntimePool(connectionString: string): Pool {
  const cached = sharedPools.get(connectionString);
  if (cached) return cached;
  // v37 C3：realm-dev 专用池——固定 application_name='realm-dev'
  // （pg_stat_activity 归属；worker 不经此路径，不误标）。
  const pool = createRealmDevPostgresPool(connectionString, "realm-dev");
  pool.on("error", () => {});
  sharedPools.set(connectionString, pool);
  return pool;
}

/** 测试/关停路径回收全部共享池。 */
export async function endSharedRuntimePools(): Promise<void> {
  const all = [...sharedPools.values()];
  sharedPools.clear();
  await Promise.all(all.map((pool) => pool.end().catch(() => undefined)));
}

/**
 * 批次 T11-D：semantic review context 的世界头游标解析——与
 * resolveWorldScopeForMember 同一世界线选择语义（最早一条 active 挂接
 * 世界线）+ membership 校验，额外读出 worldlines.head_tick/head_ordinal。
 * 世界不存在或非成员 → null（调用方返回 404，不泄露存在性）。
 * 只读；游标只来自服务端世界线行，客户端不可注入时间事实。
 */
export async function resolveWorldHeadContextForMember(
  database: Pool,
  input: { workspaceId: string; principalId: string; worldId: string },
): Promise<{
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  headTick: number;
  headOrdinal: number;
} | null> {
  return withWorkspaceTransaction(
    database,
    input.workspaceId,
    async (client) => {
      const result = await client.query<{
        worldline_id: string;
        head_tick: string;
        head_ordinal: string;
      }>(
        `SELECT worldline.id AS worldline_id,
                worldline.head_tick,
                worldline.head_ordinal
         FROM worlds AS world
         JOIN player_world_memberships AS membership
           ON membership.workspace_id = world.workspace_id
          AND membership.world_id = world.id
          AND membership.principal_id = $3
         JOIN worldlines AS worldline
           ON worldline.workspace_id = world.workspace_id
          AND worldline.world_id = world.id
         WHERE world.workspace_id = $1 AND world.id = $2
         ORDER BY worldline.created_at ASC, worldline.id ASC
         LIMIT 1`,
        [input.workspaceId, input.worldId, input.principalId],
      );
      const row = result.rows[0];
      if (!row) return null;
      // bigint 由 pg 驱动按字符串返回；bigint 的范围大于 JS Number，必须
      // 在边界处 fail closed，不能把超 safe integer 的游标静默舍入。
      const headTick = Number(row.head_tick);
      const headOrdinal = Number(row.head_ordinal);
      if (
        !Number.isSafeInteger(headTick)
        || headTick < 0
        || !Number.isSafeInteger(headOrdinal)
        || headOrdinal < 0
      ) {
        throw new Error("worldline head cursor exceeds JavaScript safe integer range");
      }
      return {
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        worldlineId: row.worldline_id,
        headTick,
        headOrdinal,
      };
    },
    { readOnly: true },
  );
}

/**
 * 批次 T11-G：membership 角色解析（non-public 传播裁决要求 owner）。
 * 非成员 → null（调用方按既有语义返回 404/409）。
 */
export async function resolveMembershipRole(
  database: Pool,
  input: { workspaceId: string; worldId: string; principalId: string },
): Promise<string | null> {
  return withWorkspaceTransaction(
    database,
    input.workspaceId,
    async (client) => {
      const result = await client.query<{ role: string }>(
        `SELECT role FROM player_world_memberships
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [input.workspaceId, input.worldId, input.principalId],
      );
      return result.rows[0]?.role ?? null;
    },
    { readOnly: true },
  );
}

/**
 * 批次 T9：canon/图谱 API 的显式世界作用域解析——按目标世界当前
 * active 世界线（最早一条，与 library 挂接语义一致）+ membership 校验。
 * 世界不存在或非成员 → null（调用方返回 404，不泄露存在性）。
 */
export async function resolveWorldScopeForMember(
  database: Pool,
  input: { workspaceId: string; principalId: string; worldId: string },
): Promise<WorldScope | null> {
  return withWorkspaceTransaction(
    database,
    input.workspaceId,
    async (client) => {
      const result = await client.query<{ worldline_id: string }>(
        `SELECT worldline.id AS worldline_id
         FROM worlds AS world
         JOIN player_world_memberships AS membership
           ON membership.workspace_id = world.workspace_id
          AND membership.world_id = world.id
          AND membership.principal_id = $3
         JOIN worldlines AS worldline
           ON worldline.workspace_id = world.workspace_id
          AND worldline.world_id = world.id
         WHERE world.workspace_id = $1 AND world.id = $2
         ORDER BY worldline.created_at ASC, worldline.id ASC
         LIMIT 1`,
        [input.workspaceId, input.worldId, input.principalId],
      );
      const worldlineId = result.rows[0]?.worldline_id;
      if (!worldlineId) return null;
      return {
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        worldlineId,
      };
    },
    { readOnly: true },
  );
}

/**
 * F1a：Bridge 命令路由的显式世界线选择与读写分离授权。
 *
 * 与 resolveWorldScopeForMember 的读语义分离：
 * - 显式 worldlineId 必须在同一 workspace/world 内存在——不存在、跨世界、
 *   非成员一律 not_found（404，不泄露存在性），绝不回退到最早世界线；
 * - 写访问要求 membership 角色 owner/player，observer → forbidden（403）；
 * - 写访问下显式目标必须 active（frozen/archived → not_writable）；
 * - 写访问缺省选择只在可写（active）世界线恰好一条时成立，多条 →
 *   scope_required，绝不静默选最旧；零条 → not_writable；
 * - 读访问缺省保持既有"最早一条挂接世界线"语义，显式选择只校验归属。
 * 客户端 workspace/principal 永远不参与裁决：二者都来自服务端会话与
 * LOCAL_RECORD_SCOPE，worldlineId 只作为世界线身份输入。
 */
export type BridgeWorldScopeAccess = "read" | "write";

export type BridgeWorldScopeResolution =
  | { status: "ok"; scope: WorldScope; role: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "scope_required" }
  | { status: "not_writable" };

const WRITE_ROLES = new Set(["owner", "player"]);

export async function resolveBridgeWorldScopeForMember(
  database: Pool,
  input: {
    workspaceId: string;
    principalId: string;
    worldId: string;
    worldlineId?: string;
    access: BridgeWorldScopeAccess;
  },
): Promise<BridgeWorldScopeResolution> {
  return withWorkspaceTransaction(
    database,
    input.workspaceId,
    async (client) => {
      const membership = await client.query<{ role: string }>(
        `SELECT membership.role AS role
         FROM worlds AS world
         JOIN player_world_memberships AS membership
           ON membership.workspace_id = world.workspace_id
          AND membership.world_id = world.id
          AND membership.principal_id = $3
         WHERE world.workspace_id = $1 AND world.id = $2`,
        [input.workspaceId, input.worldId, input.principalId],
      );
      const role = membership.rows[0]?.role;
      if (!role) return { status: "not_found" };
      if (input.access === "write" && !WRITE_ROLES.has(role)) {
        return { status: "forbidden" };
      }
      const scope = (worldlineId: string): BridgeWorldScopeResolution => ({
        status: "ok",
        scope: {
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          worldlineId,
        },
        role,
      });

      if (input.worldlineId !== undefined) {
        const explicit = await client.query<{ status: string }>(
          `SELECT status FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [input.workspaceId, input.worldId, input.worldlineId],
        );
        const worldline = explicit.rows[0];
        if (!worldline) return { status: "not_found" };
        if (input.access === "write" && worldline.status !== "active") {
          return { status: "not_writable" };
        }
        return scope(input.worldlineId);
      }

      if (input.access === "write") {
        const writable = await client.query<{ id: string }>(
          `SELECT id FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND status = 'active'
           ORDER BY created_at ASC, id ASC`,
          [input.workspaceId, input.worldId],
        );
        if (writable.rows.length === 0) return { status: "not_writable" };
        if (writable.rows.length > 1) return { status: "scope_required" };
        return scope(writable.rows[0]!.id);
      }

      const readable = await client.query<{ id: string }>(
        `SELECT id FROM worldlines
         WHERE workspace_id = $1 AND world_id = $2
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [input.workspaceId, input.worldId],
      );
      const worldlineId = readable.rows[0]?.id;
      if (!worldlineId) return { status: "not_found" };
      return scope(worldlineId);
    },
    { readOnly: true },
  );
}
