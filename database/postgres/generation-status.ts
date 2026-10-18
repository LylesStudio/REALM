import type { Pool } from "pg";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import type { GenerationStatus } from "../../modules/streaming/generation-status.ts";

/** Coarse cross-worker occupancy. Never select job payloads, identities, criteria or model text. */
export async function readPersistentGenerationStatus(pool: Pool, workspaceId: string, recordId: string): Promise<GenerationStatus> {
  return withWorkspaceTransaction(pool, workspaceId, async (client) => {
    const result = await client.query<{ queued: boolean; opening: boolean; active: boolean; judge: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM realm_durable_jobs WHERE workspace_id = $1 AND record_id = $2
           AND job_kind IN ('record-turn', 'first-night', 'self-play-beat') AND state = 'pending') AS queued,
         EXISTS (SELECT 1 FROM realm_durable_jobs WHERE workspace_id = $1 AND record_id = $2
           AND job_kind = 'first-night' AND state = 'claimed') AS opening,
         EXISTS (SELECT 1 FROM realm_durable_jobs WHERE workspace_id = $1 AND record_id = $2
           AND job_kind IN ('record-turn', 'self-play-beat') AND state = 'claimed') AS active,
         EXISTS (SELECT 1 FROM goal_assessment_jobs WHERE workspace_id = $1 AND record_id = $2
           AND state = 'running' AND lease_expires_at > CURRENT_TIMESTAMP) AS judge`,
      [workspaceId, recordId],
    );
    const row = result.rows[0];
    const activities: GenerationStatus["activities"][number][] = [];
    if (row?.queued) activities.push({ phase: "queued" });
    if (row?.opening) activities.push({ phase: "opening" });
    if (row?.active) activities.push({ phase: "preparing" });
    // The assessment may belong to a hidden Goal: reveal occupancy, not its stage.
    if (row?.judge && !row.active) activities.push({ phase: "preparing" });
    return { busy: activities.length > 0, activities };
  }, { readOnly: true });
}
