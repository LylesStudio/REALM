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
