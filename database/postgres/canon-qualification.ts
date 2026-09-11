import type { Pool } from "pg";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

/**
 * 批次 T11-H：Canon 资格预检（只读）。
 * 返回 owner operator surface 所需的全部服务端事实：membership 角色、
 * 当前 worldline 的 active continuity 选项（稳定 id + 显示名）、传播拓扑
 * 节点/路线/node→continuity 映射摘要与 secret readiness。
 * 不含连接串/凭据；不接受客户端指定 workspace/worldline（作用域由路由
 * 经 resolveWorldScopeForMember 解析）。
 */

export interface CanonQualificationContinuity {
  id: string;
  displayName: string;
}

export interface CanonQualificationTopology {
  nodes: readonly { key: string; clearance: string }[];
  routes: readonly {
    from: string;
    to: string;
    channel: string;
    recipient: string | null;
  }[];
  nodeAudiences: readonly { nodeKey: string; continuityId: string }[];
  /** secret 就绪：存在路线、全部 private_letter、每个 recipient 恰一映射。 */
  secretReady: boolean;
}

export interface CanonQualification {
  scope: { worldId: string; worldlineId: string };
  membershipRole: string;
  continuities: readonly CanonQualificationContinuity[];
  topology: CanonQualificationTopology;
}

export function createPostgresCanonQualificationReader(pool: Pool) {
  return {
    async load(
      scope: WorldScope,
      principalId: string,
    ): Promise<CanonQualification | null> {
      return withWorkspaceTransaction(
        pool,
        scope.workspaceId,
        async (client) => {
          const role = await client.query<{ role: string }>(
            `SELECT role FROM player_world_memberships
             WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
            [scope.workspaceId, scope.worldId, principalId],
          );
          const membershipRole = role.rows[0]?.role;
          if (!membershipRole) return null;

          const continuities = await client.query<{
            id: string;
            display_name: string;
          }>(
            `SELECT continuity.id, definition.display_name
             FROM character_continuities AS continuity
             JOIN character_definitions AS definition
               ON definition.workspace_id = continuity.workspace_id
              AND definition.world_id = continuity.world_id
              AND definition.id = continuity.definition_id
             WHERE continuity.workspace_id = $1
               AND continuity.world_id = $2
               AND continuity.worldline_id = $3
               AND continuity.status = 'active'
             ORDER BY definition.display_name, continuity.id`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          );
          const nodes = await client.query(
            `SELECT node_key, clearance FROM propagation_nodes
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND active
             ORDER BY node_key`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          );
          const routes = await client.query(
            `SELECT from_node, to_node, channel, distance, recipient
             FROM propagation_routes
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             ORDER BY id`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          );
          const mappings = await client.query(
            `SELECT node_key, continuity_id FROM propagation_node_audiences
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             ORDER BY node_key, continuity_id`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          );

          const routeList = routes.rows.map((row) => ({
            from: row.from_node as string,
            to: row.to_node as string,
            channel: row.channel as string,
            recipient: (row.recipient as string | null) ?? null,
          }));
          const mappingList = mappings.rows.map((row) => ({
            nodeKey: row.node_key as string,
            continuityId: row.continuity_id as string,
          }));
          const activeContinuityIds = new Set(
            continuities.rows.map((row) => row.id),
          );
          const activeNodeKeys = new Set(nodes.rows.map((row) => row.node_key));
          const secretReady = routeList.length > 0
            && routeList.every((route) =>
              route.channel === "private_letter"
              && route.recipient !== null
              && route.recipient === route.to
              && activeNodeKeys.has(route.from)
              && activeNodeKeys.has(route.to)
              && mappingList.filter((mapping) => mapping.nodeKey === route.recipient)
                .length === 1
              && activeContinuityIds.has(
                mappingList.find((mapping) => mapping.nodeKey === route.recipient)!.continuityId,
              )
            );

          return {
            scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
            membershipRole,
            continuities: continuities.rows.map((row) => ({
              id: row.id,
              displayName: row.display_name,
            })),
            topology: {
              nodes: nodes.rows.map((row) => ({
                key: row.node_key as string,
                clearance: row.clearance as string,
              })),
              routes: routeList,
              nodeAudiences: mappingList,
              secretReady,
            },
          };
        },
        { readOnly: true },
      );
    },
  };
}
