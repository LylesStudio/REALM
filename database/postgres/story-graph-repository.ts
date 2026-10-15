import type { PoolClient } from "pg";
import {
  evaluateUnlockRule,
  getEligibleStoryRecordNodes,
  normalizeStoryDefinition,
  storyDefinitionHashFor,
  storyNodeInstanceIdFor,
  storyRecordIdFor,
  storyUnlockEvidenceHashFor,
  storyUnlockIdempotencyKeyFor,
  storyUnlockLedgerIdFor,
  type StoryDefinition,
  type StoryGraphFacts,
  type StoryGoalScope,
  type StoryGoalState,
  type StoryNodeRuntimeSnapshot,
  type StoryNodeState,
} from "../../modules/story-graph/public.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export type StoryGraphRepositoryErrorCode =
  | "STORY_NOT_FOUND"
  | "STORY_NOT_WRITABLE"
  | "STORY_DEFINITION_CONFLICT"
  | "STORY_RECORD_INSTANTIATION_FAILED"
  | "STORY_NODE_STATE_INVALID"
  | "STORY_UNLOCK_REPLAY_CONFLICT"
  | "STORY_GRAPH_READ_FAILED";

export class StoryGraphRepositoryError extends Error {
  readonly code: StoryGraphRepositoryErrorCode;

  constructor(code: StoryGraphRepositoryErrorCode, message: string) {
    super(message);
    this.name = "StoryGraphRepositoryError";
    this.code = code;
  }
}

export interface StoryNodeProjection extends StoryNodeRuntimeSnapshot {
  definitionHash: string;
}

export interface StoryGraphSnapshot {
  storyId: string;
  worldId: string;
  worldlineId: string;
  definitionHash: string;
  nodes: readonly StoryNodeProjection[];
}

export interface StoryGraphReconcileResult extends StoryGraphSnapshot {
  /** Nodes whose rules are satisfied by the authoritative facts read in this run. */
  unlockedNodeKeys: readonly string[];
}

export interface StoryGraphRepository {
  materialize(input: {
    workspaceId: string;
    storyId: string;
    definition: StoryDefinition;
  }): Promise<StoryGraphSnapshot>;
  reconcile(input: {
    workspaceId: string;
    storyId: string;
    definition: StoryDefinition;
  }): Promise<StoryGraphReconcileResult>;
}

interface StoryRow {
  world_id: string;
  worldline_id: string;
  status: string;
  world_version: string;
}

interface NodeRow {
  node_key: string;
  id: string;
  state: StoryNodeState;
  revision: string | number;
  record_id: string | null;
  definition_hash: string;
  unlock_evidence_event_ids: string[];
  unlock_evidence: unknown;
}

interface RuntimeStoryScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  storyId: string;
}

export function createPostgresStoryGraphRepository(
  database: WorkspaceDatabase,
): StoryGraphRepository {
  return {
    async materialize({ workspaceId, storyId, definition }) {
      const normalized = normalizeStoryDefinition(definition);
      return withWorkspaceTransaction(database, workspaceId, async (client) => {
        const story = await lockStory(client, workspaceId, storyId);
        const scope: RuntimeStoryScope = {
          workspaceId,
          worldId: story.world_id,
          worldlineId: story.worldline_id,
          storyId,
        };
        const definitionHash = storyDefinitionHashFor(normalized);
        await ensureNodeRows(client, scope, normalized, definitionHash);
        const facts = await loadFacts(client, scope, story.status !== "draft");
        await activateEligibleNodes(client, scope, normalized, definitionHash, facts);
        return readSnapshot(client, scope, normalized, definitionHash);
      });
    },

    async reconcile({ workspaceId, storyId, definition }) {
      const normalized = normalizeStoryDefinition(definition);
      return withWorkspaceTransaction(database, workspaceId, async (client) => {
        const story = await lockStory(client, workspaceId, storyId);
        const scope: RuntimeStoryScope = {
          workspaceId,
          worldId: story.world_id,
          worldlineId: story.worldline_id,
          storyId,
        };
        const definitionHash = storyDefinitionHashFor(normalized);
        await ensureNodeRows(client, scope, normalized, definitionHash);
        const facts = await loadFacts(client, scope, story.status !== "draft");
        const satisfiedNodeKeys = normalized.nodes
          .filter((node) => node.unlock && factsForNode(node.unlock, facts))
          .map((node) => node.nodeKey);
        await activateEligibleNodes(client, scope, normalized, definitionHash, facts);
        return {
          ...(await readSnapshot(client, scope, normalized, definitionHash)),
          unlockedNodeKeys: satisfiedNodeKeys,
        };
      });
    },
  };
}

async function lockStory(
  client: PoolClient,
  workspaceId: string,
  storyId: string,
): Promise<StoryRow> {
  const result = await client.query<StoryRow>(
    `SELECT story.world_id, story.worldline_id, story.status, world.world_version
     FROM stories AS story
     JOIN worlds AS world
       ON world.workspace_id = story.workspace_id
      AND world.id = story.world_id
     WHERE story.workspace_id = $1 AND story.id = $2`,
    [workspaceId, storyId],
  );
  const story = result.rows[0];
  if (!story) {
    throw new StoryGraphRepositoryError("STORY_NOT_FOUND", "Story not found.");
  }
  if (["archived", "completed"].includes(story.status)) {
    throw new StoryGraphRepositoryError("STORY_NOT_WRITABLE", "Story is not writable.");
  }
  return story;
}

async function ensureNodeRows(
  client: PoolClient,
  scope: RuntimeStoryScope,
  definition: StoryDefinition,
  definitionHash: string,
): Promise<void> {
  const existing = await selectNodeRows(client, scope);
  const byKey = new Map(existing.map((row) => [row.node_key, row]));
  const definitionKeys = new Set(definition.nodes.map((node) => node.nodeKey));
  if (existing.some((row) => !definitionKeys.has(row.node_key))) {
    throw new StoryGraphRepositoryError(
      "STORY_DEFINITION_CONFLICT",
      "Story Graph definition removed a node after runtime materialization.",
    );
  }
  for (const node of definition.nodes) {
    const row = byKey.get(node.nodeKey);
    if (row) {
      if (row.definition_hash !== definitionHash) {
        throw new StoryGraphRepositoryError(
          "STORY_DEFINITION_CONFLICT",
          "Story Graph definition changed after runtime materialization.",
        );
      }
      continue;
    }
    await client.query(
      `INSERT INTO story_node_instances (
         workspace_id, world_id, worldline_id, story_id, node_key, id,
         state, revision, definition_hash, unlock_evidence_event_ids, unlock_evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, 'locked', 0, $7, ARRAY[]::text[], '{}'::jsonb)`,
      [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        scope.storyId,
        node.nodeKey,
        storyNodeInstanceIdFor(scope, node.nodeKey),
        definitionHash,
      ],
    );
  }
}

async function activateEligibleNodes(
  client: PoolClient,
  scope: RuntimeStoryScope,
  definition: StoryDefinition,
  definitionHash: string,
  facts: StoryGraphFacts,
): Promise<void> {
  const eligible = getEligibleStoryRecordNodes(definition, facts);
  const rows = await selectNodeRows(client, scope);
  const byKey = new Map(rows.map((row) => [row.node_key, row]));
  const worldline = await client.query<{ head_tick: string; head_ordinal: string }>(
    `SELECT head_tick::text, head_ordinal::text
     FROM worldlines
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3
     FOR KEY SHARE`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  const cursor = worldline.rows[0];
  if (!cursor) throw new StoryGraphRepositoryError("STORY_GRAPH_READ_FAILED", "Worldline not found.");
  const now = new Date();

  for (const candidate of eligible) {
    const current = byKey.get(candidate.node.nodeKey);
    if (!current || current.state !== "locked") continue;
    const recordId = storyRecordIdFor(scope, candidate.node.nodeKey);
    const evidenceHash = storyUnlockEvidenceHashFor({
      definitionHash,
      nodeKey: candidate.node.nodeKey,
      evidence: candidate.evidence,
    });
    const ledgerId = storyUnlockLedgerIdFor(current.id, "unlocked", evidenceHash);
    const idempotencyKey = storyUnlockIdempotencyKeyFor(current.id, "unlocked", evidenceHash);

    try {
      await client.query(
        `INSERT INTO records (
           workspace_id, world_id, worldline_id, story_id, id, title, status,
           start_tick, start_ordinal, timeline_kind, linked_record_id, world_version
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, 'primary', NULL, $9)`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          scope.storyId,
          recordId,
          candidate.node.title,
          cursor.head_tick,
          cursor.head_ordinal,
          await worldVersionFor(client, scope),
        ],
      );
      await client.query(
        `INSERT INTO record_heads (
           workspace_id, world_id, worldline_id, record_id,
           record_version, next_record_ordinal, last_world_tick, last_world_ordinal
         ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6)`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          recordId,
          cursor.head_tick,
          cursor.head_ordinal,
        ],
      );
    } catch {
      throw new StoryGraphRepositoryError(
        "STORY_RECORD_INSTANTIATION_FAILED",
        "Story Record could not be instantiated.",
      );
    }

    const ledger = await client.query(
      `INSERT INTO story_unlock_ledger (
         workspace_id, world_id, worldline_id, story_id, id,
         story_node_instance_id, node_key, transition, idempotency_key,
         record_id, evidence_event_ids, evidence_hash, evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'unlocked', $8, $9, $10::text[], $11, $12::jsonb)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        scope.storyId,
        ledgerId,
        current.id,
        candidate.node.nodeKey,
        idempotencyKey,
        recordId,
        [...candidate.evidence.eventIds],
        evidenceHash,
        JSON.stringify(candidate.evidence),
      ],
    );
    if (ledger.rowCount === 0) {
      throw new StoryGraphRepositoryError(
        "STORY_UNLOCK_REPLAY_CONFLICT",
        "Story unlock replay collided with an incomplete node state.",
      );
    }

    const update = await client.query(
      `UPDATE story_node_instances
       SET state = 'active', revision = revision + 1, record_id = $4,
           unlock_evidence_event_ids = $5::text[], unlock_evidence = $6::jsonb,
           unlocked_at = $7, activated_at = $7, updated_at = $7
       WHERE workspace_id = $1 AND id = $2 AND story_id = $3
         AND state = 'locked'`,
      [
        scope.workspaceId,
        current.id,
        scope.storyId,
        recordId,
        [...candidate.evidence.eventIds],
        JSON.stringify(candidate.evidence),
        now,
      ],
    );
    if (update.rowCount !== 1) {
      throw new StoryGraphRepositoryError(
        "STORY_UNLOCK_REPLAY_CONFLICT",
        "Story node state changed before activation.",
      );
    }
    const updated = byKey.get(candidate.node.nodeKey);
    if (updated) {
      updated.state = "active";
      updated.revision = Number(updated.revision) + 1;
      updated.record_id = recordId;
      updated.unlock_evidence_event_ids = [...candidate.evidence.eventIds];
      updated.unlock_evidence = candidate.evidence;
    }
  }
}

async function worldVersionFor(client: PoolClient, scope: RuntimeStoryScope): Promise<string> {
  const result = await client.query<{ world_version: string }>(
    `SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, scope.worldId],
  );
  const value = result.rows[0]?.world_version;
  if (!value) throw new StoryGraphRepositoryError("STORY_GRAPH_READ_FAILED", "World version is unavailable.");
  return value;
}

async function loadFacts(
  client: PoolClient,
  scope: RuntimeStoryScope,
  storyStarted: boolean,
): Promise<StoryGraphFacts> {
  const events = await client.query<{ id: string; event_kind: string; record_id: string; record_ordinal: string }>(
    `SELECT event.id, event.event_kind, event.record_id, event.record_ordinal::text
     FROM events AS event
     JOIN records AS record
       ON record.workspace_id = event.workspace_id
      AND record.world_id = event.world_id
      AND record.worldline_id = event.worldline_id
      AND record.id = event.record_id
     WHERE event.workspace_id = $1 AND record.story_id = $2
     ORDER BY event.record_ordinal ASC, event.id ASC`,
    [scope.workspaceId, scope.storyId],
  );
  const goals = await client.query<{ goal_key: string; scope_kind: StoryGoalScope; state: StoryGoalState; record_id: string | null }>(
    `SELECT goal.goal_key, goal.scope_kind, goal.state, goal.record_id
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1
       AND goal.world_id = $2
       AND goal.worldline_id = $3
       AND (
         (goal.scope_kind = 'story' AND goal.story_id = $4)
         OR goal.scope_kind = 'worldline'
         OR (
           goal.scope_kind = 'record'
           AND EXISTS (
             SELECT 1 FROM records AS record
             WHERE record.workspace_id = goal.workspace_id
               AND record.world_id = goal.world_id
               AND record.worldline_id = goal.worldline_id
               AND record.story_id = $4
               AND record.id = goal.record_id
           )
         )
       )
     ORDER BY goal.goal_key ASC, goal.attempt DESC`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId],
  );
  const nodes = await selectNodeRows(client, scope);
  const milestones = await client.query<{ id: string; status: "planned" | "active" | "completed" | "cancelled" }>(
    `SELECT milestone.id, milestone.status
     FROM project_milestones AS milestone
     JOIN project_story_links AS link
       ON link.workspace_id = milestone.workspace_id
      AND link.world_id = milestone.world_id
      AND link.worldline_id = milestone.worldline_id
      AND link.project_id = milestone.project_id
     WHERE milestone.workspace_id = $1
       AND milestone.world_id = $2
       AND milestone.worldline_id = $3
       AND link.story_id = $4
     ORDER BY milestone.id ASC`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId],
  );
  const obligations = await client.query<{ id: string; outstanding_minor: string }>(
    `SELECT obligation.id, obligation.outstanding_minor::text
     FROM obligations AS obligation
     JOIN project_story_links AS link
       ON link.workspace_id = obligation.workspace_id
      AND link.world_id = obligation.world_id
      AND link.worldline_id = obligation.worldline_id
      AND link.project_id = obligation.project_id
     WHERE obligation.workspace_id = $1
       AND obligation.world_id = $2
       AND obligation.worldline_id = $3
       AND link.story_id = $4
     ORDER BY obligation.id ASC`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId],
  );
  const accounts = await client.query<{ balance_minor: string }>(
    `SELECT (
       account.opening_balance_minor + COALESCE(SUM(
         CASE
           WHEN entry.kind = 'income' THEN entry.amount_minor
           WHEN entry.kind = 'expense' THEN -entry.amount_minor
           WHEN entry.kind = 'adjustment' AND entry.direction = 'income' THEN entry.amount_minor
           WHEN entry.kind = 'adjustment' AND entry.direction = 'expense' THEN -entry.amount_minor
           ELSE 0
         END
       ), 0)
     )::text AS balance_minor
     FROM finance_accounts AS account
     LEFT JOIN ledger_entries AS entry
       ON entry.workspace_id = account.workspace_id
      AND entry.world_id = account.world_id
      AND entry.worldline_id = account.worldline_id
      AND entry.account_id = account.id
     WHERE account.workspace_id = $1
       AND account.world_id = $2
       AND account.worldline_id = $3
       AND account.status = 'active'
     GROUP BY account.id, account.opening_balance_minor`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  return {
    storyStarted,
    events: events.rows.map((event) => ({
      id: event.id,
      kind: event.event_kind,
      recordId: event.record_id,
      ordinal: Number(event.record_ordinal),
    })),
    goals: goals.rows.map((goal) => ({
      goalKey: goal.goal_key,
      scope: goal.scope_kind,
      state: goal.state,
      ...(goal.record_id === null ? {} : { recordId: goal.record_id }),
    })),
    nodes: nodes.map((row) => ({
      nodeKey: row.node_key,
      state: row.state,
      recordId: row.record_id,
      revision: Number(row.revision),
    })),
    milestones: milestones.rows.map((row) => ({ id: row.id, status: row.status })),
    obligations: obligations.rows.map((row) => ({
      id: row.id,
      outstandingMinor: Number(row.outstanding_minor),
    })),
    ...(accounts.rowCount === 1
      ? { cashBalanceMinor: Number(accounts.rows[0]?.balance_minor) }
      : {}),
  };
}

async function selectNodeRows(client: PoolClient, scope: RuntimeStoryScope): Promise<NodeRow[]> {
  const result = await client.query<NodeRow>(
    `SELECT node_key, id, state, revision, record_id, definition_hash,
            unlock_evidence_event_ids, unlock_evidence
     FROM story_node_instances
     WHERE workspace_id = $1 AND world_id = $2
       AND worldline_id = $3 AND story_id = $4
     ORDER BY node_key ASC
     FOR UPDATE`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId],
  );
  return result.rows;
}

async function readSnapshot(
  client: PoolClient,
  scope: RuntimeStoryScope,
  definition: StoryDefinition,
  definitionHash: string,
): Promise<StoryGraphSnapshot> {
  const rows = await selectNodeRows(client, scope);
  const byKey = new Map(rows.map((row) => [row.node_key, row]));
  return {
    storyId: scope.storyId,
    worldId: scope.worldId,
    worldlineId: scope.worldlineId,
    definitionHash,
    nodes: definition.nodes.map((node) => {
      const row = byKey.get(node.nodeKey);
      if (!row) throw new StoryGraphRepositoryError("STORY_GRAPH_READ_FAILED", "Story node row is missing.");
      return {
        nodeKey: row.node_key,
        state: row.state,
        recordId: row.record_id,
        revision: Number(row.revision),
        definitionHash: row.definition_hash,
      };
    }),
  };
}

function factsForNode(
  rule: StoryDefinition["nodes"][number]["unlock"],
  facts: StoryGraphFacts,
): boolean {
  return evaluateUnlockRule(rule, facts).satisfied;
}
