import type { Pool } from "pg";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

export type PropagationNodeAudienceErrorCode =
  | "PROPAGATION_AUDIENCE_INVALID_INPUT"
  | "PROPAGATION_AUDIENCE_SCOPE_REQUIRED"
  | "PROPAGATION_AUDIENCE_WORLD_ARCHIVED"
  | "PROPAGATION_AUDIENCE_OWNER_REQUIRED"
  | "PROPAGATION_AUDIENCE_NODE_NOT_FOUND"
  | "PROPAGATION_AUDIENCE_NODE_INACTIVE"
  | "PROPAGATION_AUDIENCE_CONTINUITY_NOT_FOUND"
  | "PROPAGATION_AUDIENCE_CONTINUITY_INACTIVE";

export class PropagationNodeAudienceError extends Error {
  readonly code: PropagationNodeAudienceErrorCode;

  constructor(code: PropagationNodeAudienceErrorCode) {
    super(code);
    this.name = "PropagationNodeAudienceError";
    this.code = code;
  }
}

function codeFromDatabaseError(error: unknown): PropagationNodeAudienceErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/PROPAGATION_AUDIENCE_[A-Z_]+/)?.[0];
  switch (code) {
    case "PROPAGATION_AUDIENCE_INVALID_INPUT":
    case "PROPAGATION_AUDIENCE_SCOPE_REQUIRED":
    case "PROPAGATION_AUDIENCE_WORLD_ARCHIVED":
    case "PROPAGATION_AUDIENCE_OWNER_REQUIRED":
    case "PROPAGATION_AUDIENCE_NODE_NOT_FOUND":
    case "PROPAGATION_AUDIENCE_NODE_INACTIVE":
    case "PROPAGATION_AUDIENCE_CONTINUITY_NOT_FOUND":
    case "PROPAGATION_AUDIENCE_CONTINUITY_INACTIVE":
      return code;
    default:
      return null;
  }
}

export function createPostgresPropagationNodeAudienceGovernance(pool: Pool) {
  return {
    async append(
      scope: WorldScope,
      principalId: string,
      input: { nodeKey: string; continuityId: string },
    ): Promise<boolean> {
      try {
        return await withWorkspaceTransaction(
          pool,
          scope.workspaceId,
          async (client) => {
            // v37 C4：capability admission lock——调用事务内先取
            // pg_advisory_xact_lock(7200043)（锁随事务持有至
            // commit/rollback，覆盖 active/idle-in-transaction/prepared，
            // 不依赖 query 文本）；migration runner 的 drain 锁同 key。
            await client.query("SELECT pg_advisory_xact_lock(7200043)");
            const result = await client.query<{ appended: boolean }>(
              `SELECT append_propagation_node_audience(
                 $1, $2, $3, $4, $5, $6
               ) AS appended`,
              [
                scope.workspaceId,
                scope.worldId,
                scope.worldlineId,
                input.nodeKey,
                input.continuityId,
                principalId,
              ],
            );
            return result.rows[0]?.appended === true;
          },
        );
      } catch (error) {
        const code = codeFromDatabaseError(error);
        if (code) throw new PropagationNodeAudienceError(code);
        throw error;
      }
    },
  };
}
