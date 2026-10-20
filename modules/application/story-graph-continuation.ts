/**
 * Server-owned Story Graph continuation.
 *
 * After an authoritative command commits (milestone confirmation, record
 * finance application, committed facts), the engine reconciles every
 * writable Story of the worldline against committed database facts so newly
 * satisfied unlock rules activate their nodes atomically through the normal
 * Story Graph repository path.
 *
 * The Story definition is ALWAYS resolved server-side from the persisted
 * story_definition_bindings row; this module never accepts a client-supplied
 * definition, score, or completion fact.
 *
 * F1b atomic orchestration: runCommandWithStoryContinuation composes the
 * existing WorkspaceDatabase = Pool | PoolClient contract. One outer
 * withWorkspaceTransaction over the route pool passes the SAME client into
 * the command store/service and every Story reconcile, so command, receipt,
 * head/ledger and ALL Story writes commit once together or roll back
 * together. Inner withWorkspaceTransaction calls on that client are
 * savepoints; an inner savepoint completing is never the authoritative
 * commit.
 */
import type { PoolClient } from "pg";
import {
  createPostgresStoryGraphRepository,
  StoryGraphRepositoryError,
} from "../../database/postgres/story-graph-repository.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "../../database/postgres/workspace-transaction.ts";

export interface StoryContinuationScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
}

export interface StoryContinuationUnlock {
  storyId: string;
  nodeKey: string;
  recordId: string;
}

export interface StoryContinuationSummary {
  reconciledStoryIds: readonly string[];
  unlocks: readonly StoryContinuationUnlock[];
}

/**
 * Explicit, stable code reported when an already-committed (historical)
 * command is replayed but its Story continuation cannot currently reconcile.
 * The old receipt stays committed; this is never a fake success and never a
 * promise of autonomous retry — an explicit same-key retry after the fault
 * is corrected reconciles idempotently.
 */
export const STORY_CONTINUATION_BLOCKED = "STORY_CONTINUATION_BLOCKED";

export type StoryContinuationOutcome =
  | { status: "applied"; summary: StoryContinuationSummary }
  | { status: "blocked"; code: typeof STORY_CONTINUATION_BLOCKED };

/**
 * Reconcile every non-terminal Story of the worldline that has a persisted
 * definition binding. A Story whose graph rows exist but whose binding is
 * missing (legacy graph predating binding persistence) fails closed with
 * STORY_DEFINITION_NOT_FOUND instead of being silently skipped; a Story
 * with neither graph rows nor a binding never materialized and is
 * legitimately ignored. Archived/completed Stories are not writable and are
 * left untouched. Repository errors other than a terminal-status race
 * propagate: they indicate a real consistency defect, not a client fault.
 */
export async function reconcileWorldlineStories(
  database: WorkspaceDatabase,
  scope: StoryContinuationScope,
): Promise<StoryContinuationSummary> {
  const storyIds = await listContinuationStoryIds(database, scope);
  const repository = createPostgresStoryGraphRepository(database);
  const reconciledStoryIds: string[] = [];
  const unlocks: StoryContinuationUnlock[] = [];
  for (const storyId of storyIds) {
    let snapshot;
    try {
      snapshot = await repository.reconcile({ workspaceId: scope.workspaceId, storyId });
    } catch (error) {
      if (error instanceof StoryGraphRepositoryError && error.code === "STORY_NOT_WRITABLE") {
        continue; // status raced to a terminal state between listing and reconcile
      }
      throw error;
    }
    reconciledStoryIds.push(storyId);
    const recordByNodeKey = new Map(
      snapshot.nodes.map((node) => [node.nodeKey, node.recordId] as const),
    );
    for (const nodeKey of snapshot.activatedNodeKeys) {
      const recordId = recordByNodeKey.get(nodeKey);
      if (recordId) unlocks.push({ storyId, nodeKey, recordId });
    }
  }
  return { reconciledStoryIds, unlocks };
}

/**
 * List writable Stories before any continuation write, distinguishing a
 * bound graph, a legacy graph without binding (explicit compatibility
 * error), and a never-materialized Story (legitimately skipped).
 */
async function listContinuationStoryIds(
  database: WorkspaceDatabase,
  scope: StoryContinuationScope,
): Promise<string[]> {
  const rows = await withWorkspaceTransaction(
    database,
    scope.workspaceId,
    async (client) => {
      const result = await client.query<{ id: string; bound: boolean; has_graph: boolean }>(
        `SELECT story.id,
                binding.story_id IS NOT NULL AS bound,
                EXISTS (
                  SELECT 1 FROM story_node_instances AS node
                  WHERE node.workspace_id = story.workspace_id
                    AND node.story_id = story.id
                ) AS has_graph
         FROM stories AS story
         LEFT JOIN story_definition_bindings AS binding
           ON binding.workspace_id = story.workspace_id
          AND binding.world_id = story.world_id
          AND binding.worldline_id = story.worldline_id
          AND binding.story_id = story.id
         WHERE story.workspace_id = $1 AND story.world_id = $2
           AND story.worldline_id = $3
           AND story.status NOT IN ('archived', 'completed')
         ORDER BY story.id ASC`,
        [scope.workspaceId, scope.worldId, scope.worldlineId],
      );
      return result.rows;
    },
    { readOnly: true },
  );
  const storyIds: string[] = [];
  for (const row of rows) {
    if (row.bound) {
      storyIds.push(row.id);
      continue;
    }
    if (row.has_graph) {
      throw new StoryGraphRepositoryError(
        "STORY_DEFINITION_NOT_FOUND",
        "Story graph rows exist without a persisted definition binding; the graph predates binding persistence and must be materialized with its authoritative definition.",
      );
    }
    // No graph rows and no binding: the Story never materialized its graph;
    // there is nothing to reconcile.
  }
  return storyIds;
}

/**
 * Run one authoritative command and the full worldline Story continuation
 * inside a single outer transaction on one client.
 *
 * - NEW command (status "committed"): any continuation failure propagates so
 *   the outer transaction rolls back command, receipt, head/ledger and every
 *   partial Story write together. Never a fake 200.
 * - REPLAYED command (an old receipt committed before this orchestration
 *   existed): the ENTIRE continuation across all Stories runs inside one
 *   savepoint. A failure rolls back only that savepoint and reports an
 *   explicit blocked outcome; the historical receipt is NOT retroactively
 *   reported uncommitted and no partial new Story writes survive.
 *
 * The returned value is produced only after the outer COMMIT succeeded.
 */
export async function runCommandWithStoryContinuation<
  C extends { result: { status: "committed" | "replayed" } },
>(
  database: WorkspaceDatabase,
  scope: StoryContinuationScope,
  command: (client: PoolClient) => Promise<C>,
): Promise<{ command: C; continuation: StoryContinuationOutcome }> {
  return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
    const executed = await command(client);
    if (executed.result.status === "committed") {
      const summary = await reconcileWorldlineStories(client, scope);
      return { command: executed, continuation: { status: "applied", summary } };
    }
    try {
      const summary = await withWorkspaceTransaction(
        client,
        scope.workspaceId,
        (savepointClient) => reconcileWorldlineStories(savepointClient, scope),
      );
      return { command: executed, continuation: { status: "applied", summary } };
    } catch {
      // The savepoint already rolled back every partial Story write. The
      // old receipt remains honestly committed; the caller reports the real
      // replayed receipt with explicit blocked continuation metadata.
      return {
        command: executed,
        continuation: { status: "blocked", code: STORY_CONTINUATION_BLOCKED },
      };
    }
  });
}

/**
 * Response metadata for a continuation outcome: real unlock projections on
 * success, or the explicit blocked state (never a silent/fake success).
 */
export function storyContinuationMeta(
  outcome: StoryContinuationOutcome,
): Record<string, unknown> {
  if (outcome.status === "blocked") {
    return { storyContinuation: { status: "blocked", code: outcome.code } };
  }
  return outcome.summary.unlocks.length === 0
    ? {}
    : {
      storyUnlocks: outcome.summary.unlocks.map((unlock) => ({
        storyId: unlock.storyId,
        nodeKey: unlock.nodeKey,
        recordId: unlock.recordId,
      })),
    };
}
