import type { PoolClient } from "pg";

/** 最小可查询接口：PoolClient / pg.Client（LISTEN 专用连接）均满足。 */
export type GraphInvalidationQueryable = Pick<PoolClient, "query">;

/**
 * 批次 T11-A2：图谱/CANON 失效账本（graph_invalidation_events，迁移 0024）。
 *
 * 不变量（public documentation §二）：
 * - 失效记录与业务写同一事务插入——事务回滚则事件同样回滚；
 * - pg_notify 只是低延迟唤醒（PG 保证提交后才送达），账本才是重放依据；
 * - 事件只携带作用域与 kind/reason，不携带实体/Claim/提案内容。
 */

export const GRAPH_INVALIDATION_CHANNEL = "graph_invalidation";

export type GraphInvalidationKind =
  | "entity"
  | "claim"
  | "relation"
  | "article"
  | "canon_proposal"
  | "canon_decision"
  | "canon_merge";

export interface GraphInvalidationScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
}

export interface GraphInvalidationEvent {
  cursor: number;
  id: string;
  worldId: string;
  worldlineId: string;
  kind: GraphInvalidationKind;
  reason: string;
  createdAt: string;
}

/**
 * 在调用方的事务 client 内追加失效记录并发出 NOTIFY 唤醒。
 * 必须在 withWorkspaceTransaction（或等价事务/savepoint）内调用——
 * 本函数不自行开启事务，提交/回滚由调用方事务决定。
 */
export async function appendGraphInvalidation(
  client: GraphInvalidationQueryable,
  scope: GraphInvalidationScope,
  kind: GraphInvalidationKind,
  reason: string,
): Promise<number> {
  const id = `gie_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const inserted = await client.query<{ cursor: string }>(
    `INSERT INTO graph_invalidation_events (
       workspace_id, world_id, worldline_id, id, kind, reason
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING cursor`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, id, kind, reason],
  );
  const cursor = Number(inserted.rows[0].cursor);
  // NOTIFY 载荷仅作唤醒提示；消费方按 cursor 重查账本，不信任载荷内容。
  await client.query(`SELECT pg_notify($1, $2)`, [
    GRAPH_INVALIDATION_CHANNEL,
    JSON.stringify({
      cursor,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      kind,
    }),
  ]);
  return cursor;
}

/**
 * 按作用域重放 afterCursor 之后的失效记录（按 cursor 升序）。
 * 调用方负责在已设置 realm.workspace_id 的事务内调用（RLS 依赖）。
 */
export async function listGraphInvalidationsAfter(
  client: GraphInvalidationQueryable,
  scope: GraphInvalidationScope,
  afterCursor: number,
): Promise<GraphInvalidationEvent[]> {
  const result = await client.query(
    `SELECT cursor, id, world_id, worldline_id, kind, reason, created_at
     FROM graph_invalidation_events
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND cursor > $4
     ORDER BY cursor`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, afterCursor],
  );
  return result.rows.map((row) => ({
    cursor: Number(row.cursor),
    id: row.id as string,
    worldId: row.world_id as string,
    worldlineId: row.worldline_id as string,
    kind: row.kind as GraphInvalidationKind,
    reason: row.reason as string,
    createdAt: (row.created_at as Date).toISOString(),
  }));
}
