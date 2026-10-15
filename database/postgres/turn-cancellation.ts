import type { Pool } from "pg";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

/** 跨进程回合取消。行只表示“请在下一个阶段边界停下”，不是正式事件。 */
export interface TurnCancellationStore {
  request(input: { recordId: string; turnId: string }): Promise<void>;
  isRequested(input: { recordId: string; turnId: string }): Promise<boolean>;
}

export function createPostgresTurnCancellation(
  pool: Pool,
  workspaceId: string,
): TurnCancellationStore {
  return {
    async request({ recordId, turnId }) {
      await withWorkspaceTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `INSERT INTO turn_cancel_requests (workspace_id, record_id, turn_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, record_id, turn_id) DO NOTHING`,
          [workspaceId, recordId, turnId],
        );
      });
    },
    async isRequested({ recordId, turnId }) {
      return withWorkspaceTransaction(
        pool,
        workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT 1
             FROM turn_cancel_requests
             WHERE workspace_id = $1 AND record_id = $2 AND turn_id = $3`,
            [workspaceId, recordId, turnId],
          );
          return result.rowCount === 1;
        },
        { readOnly: true },
      );
    },
  };
}
