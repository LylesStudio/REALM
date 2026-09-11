import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";
import type {
  ChannelRoute,
  SocialNode,
} from "../../modules/propagation/public.ts";

/**
 * 批次 T11-B：显式传播拓扑提供者（规范 §二/§三）。
 * 拓扑唯一真实来源是 propagation_nodes / propagation_routes（迁移 0025）——
 * 不用 world_relations 冒充通信渠道，不用完全图假装传播。
 * 快照在 Canon merge 事务内加载校验并物化进 job input（immutable）；
 * 缺 origin/端点未知/作用域异常一律 fail-closed（TopologyError 使事务回滚）。
 */

export const CANON_ORIGIN_NODE_KEY = "canon_origin";
export const PROPAGATION_TOPOLOGY_ALGORITHM = "realm-propagate-v1";

type Queryable = Pick<PoolClient, "query">;

export class PropagationTopologyError extends Error {
  readonly code:
    | "TOPOLOGY_ORIGIN_MISSING"
    | "TOPOLOGY_ROUTE_UNKNOWN_NODE"
    | "TOPOLOGY_EMPTY";

  constructor(
    code: "TOPOLOGY_ORIGIN_MISSING" | "TOPOLOGY_ROUTE_UNKNOWN_NODE" | "TOPOLOGY_EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "PropagationTopologyError";
    this.code = code;
  }
}

export interface PropagationTopologySnapshot {
  /** 稳定 digest：同内容同版本，拓扑变更只影响之后的新 Campaign。 */
  version: string;
  nodes: readonly SocialNode[];
  routes: readonly ChannelRoute[];
  canonOriginNodeKey: typeof CANON_ORIGIN_NODE_KEY;
}

export interface PropagationTopologyProvider {
  loadSnapshot(
    client: Queryable,
    scope: WorldScope,
  ): Promise<PropagationTopologySnapshot>;
}

export function createPostgresPropagationTopologyProvider(): PropagationTopologyProvider {
  return {
    async loadSnapshot(client, scope) {
      const nodeRows = await client.query(
        `SELECT node_key, clearance FROM propagation_nodes
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           AND active
         ORDER BY node_key`,
        [scope.workspaceId, scope.worldId, scope.worldlineId],
      );
      const routeRows = await client.query(
        `SELECT from_node, to_node, channel, distance, recipient
         FROM propagation_routes
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
         ORDER BY id`,
        [scope.workspaceId, scope.worldId, scope.worldlineId],
      );

      const nodes: SocialNode[] = nodeRows.rows.map((row) => ({
        key: row.node_key as string,
        clearance: row.clearance as SocialNode["clearance"],
      }));
      const nodeKeys = new Set(nodes.map((node) => node.key));
      if (!nodeKeys.has(CANON_ORIGIN_NODE_KEY)) {
        throw new PropagationTopologyError(
          "TOPOLOGY_ORIGIN_MISSING",
          "Propagation topology has no active canon origin node.",
        );
      }
      const routes: ChannelRoute[] = routeRows.rows.map((row) => {
        const from = row.from_node as string;
        const to = row.to_node as string;
        if (!nodeKeys.has(from) || !nodeKeys.has(to)) {
          throw new PropagationTopologyError(
            "TOPOLOGY_ROUTE_UNKNOWN_NODE",
            "Propagation route references an unknown or inactive node.",
          );
        }
        return {
          from,
          to,
          channel: row.channel as ChannelRoute["channel"],
          distance: Number(row.distance),
          ...(row.recipient === null ? {} : { recipient: row.recipient as string }),
        };
      });

      const version = `pt_${createHash("sha256")
        .update(JSON.stringify({ nodes, routes }))
        .digest("hex")
        .slice(0, 24)}`;
      return {
        version,
        nodes,
        routes,
        canonOriginNodeKey: CANON_ORIGIN_NODE_KEY,
      };
    },
  };
}
