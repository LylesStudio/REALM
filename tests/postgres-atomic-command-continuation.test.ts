/**
 * F1b — atomic authoritative command + all-Story continuation.
 *
 * Against disposable scratch PostgreSQL (full migration chain), through the
 * REAL bridge command routes:
 * - a new command whose Story continuation fails rolls back command,
 *   receipt, milestone/project version, ledger/head and every partial Story
 *   write together (HTTP 503 with a Story-specific code);
 * - a failure on a later Story rolls back an earlier Story's unlock too;
 * - correcting the fault and retrying the SAME idempotency key commits once;
 *   a further retry replays without duplicates;
 * - legacy graph rows without a persisted definition binding fail with the
 *   explicit STORY_DEFINITION_NOT_FOUND compatibility error (never silently
 *   skipped), while a Story with no graph at all stays legitimately ignored;
 * - an old already-committed receipt replays honestly with explicit blocked
 *   continuation metadata (never retroactively uncommitted, never a fake
 *   success), and a same-key retry after repair finishes the projection
 *   exactly once;
 * - real finance cash/obligation commands unlock persisted Story rules
 *   through the same atomic continuation.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresStoryGraphRepository,
} from "../database/postgres/public.ts";
import {
  normalizeStoryDefinition,
  storyDefinitionHashFor,
  storyRecordIdFor,
  type StoryDefinition,
  type StoryUnlockRule,
} from "../modules/story-graph/public.ts";
import {
  projectFinanceCommandFingerprintFor,
  projectFinanceCommandGroupIdFor,
} from "../modules/projects/public.ts";
import { POST as projectCommandsPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { POST as financeCommandsPOST } from "../app/api/bridge/v1/finance/commands/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { installTestSessionSecret } from "./helpers/session-proof.ts";

installTestSessionSecret();

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const WS = POSTGRES_DEMO_IDS.workspace;
const PRINCIPAL = POSTGRES_DEMO_IDS.principal;

function pools() {
  const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
  owner.on("error", () => {});
  runtime.on("error", () => {});
  return { owner, runtime };
}

function definitionFor(
  suffix: string,
  nodes: { nodeKey: string; recordKey: string; unlock: StoryUnlockRule }[],
): StoryDefinition {
  return normalizeStoryDefinition({
    storyKey: `story.atomic.${suffix}`,
    title: "Atomic story",
    premise: "F1b atomic continuation rehearsal.",
    policyVersion: "story-graph-v1",
    nodes: [
      { kind: "record", nodeKey: "opening", recordKey: "opening-record", title: "Opening", sequence: 1, initial: true },
      ...nodes.map((node, index) => ({
        kind: "record" as const,
        nodeKey: node.nodeKey,
        recordKey: node.recordKey,
        title: node.nodeKey,
        sequence: index + 2,
        unlock: node.unlock,
      })),
    ],
  });
}

async function seedWorldline(owner: pg.Pool, suffix: string, label: string) {
  const worldId = `world_atomic_${label}_${suffix}`;
  const worldlineId = `wl_atomic_${label}_${suffix}`;
  const storyId = `story_atomic_${label}_${suffix}`;
  await owner.query(
    `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
     VALUES ($1, $2, 'Atomic rehearsal', 'active', 'native_calendar', '{}'::jsonb)`,
    [WS, worldId],
  );
  await owner.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
     VALUES ($1, $2, $3, 'Atomic line', 'active', 0, 0)`,
    [WS, worldId, worldlineId],
  );
  await owner.query(
    `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [WS, worldId, PRINCIPAL],
  );
  await owner.query(
    `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, 'Atomic story', 'active', 'F1b rehearsal.', 0, 0)`,
    [WS, worldId, worldlineId, storyId],
  );
  return { worldId, worldlineId, storyId };
}

async function seedMilestoneProject(
  owner: pg.Pool,
  ids: { worldId: string; worldlineId: string; storyId: string },
  suffix: string,
  label: string,
) {
  const projectId = `proj_atomic_${label}_${suffix}`;
  const milestoneId = `mile_atomic_${label}_${suffix}`;
  await owner.query(
    `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
     VALUES ($1, $2, $3, $4, 'production', 'active', 'funding', 'Atomic production', 'JPY', NULL, NULL, 1)`,
    [WS, ids.worldId, ids.worldlineId, projectId],
  );
  await owner.query(
    `INSERT INTO project_story_links (workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind)
     VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
    [WS, ids.worldId, ids.worldlineId, `link_atomic_${label}_${suffix}`, projectId, ids.storyId],
  );
  await owner.query(
    `INSERT INTO project_milestones (workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
     VALUES ($1, $2, $3, $4, $5, 1, 'Atomic gate', 'planned', NULL, NULL, NULL)`,
    [WS, ids.worldId, ids.worldlineId, milestoneId, projectId],
  );
  return { projectId, milestoneId };
}

/**
 * The schema leak fence (postgres-project-finance-schema) requires empty
 * Project/Finance tables after the suite; this file sorts before it, so every
 * test removes its own seeded worldlines. obligation_settlements has no
 * cascade from obligations, so it is deleted first; the rest cascades from
 * worlds (memberships, worldlines, stories, node instances, bindings,
 * records, projects, milestones, links, command groups, accounts, ledger).
 */
async function cleanupSeededWorlds(owner: pg.Pool): Promise<void> {
  // Append-only tables (obligation_settlements) still need scratch cleanup;
  // triggers are bypassed only inside this disposable-database cleanup
  // transaction, never in any production write path.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    // session_replication_role = replica also disables FK cascade triggers,
    // so every seeded table is deleted explicitly in dependency order.
    const statements = [
      "DELETE FROM obligation_settlements WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM obligations WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM ledger_entries WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM project_finance_command_groups WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM budget_allocations WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM project_story_links WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM project_milestones WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM projects WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM finance_accounts WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM story_node_instances WHERE workspace_id = $1 AND story_id LIKE 'story_atomic_%'",
      "DELETE FROM story_definition_bindings WHERE workspace_id = $1 AND story_id LIKE 'story_atomic_%'",
      "DELETE FROM record_heads WHERE workspace_id = $1 AND worldline_id LIKE 'wl_atomic_%'",
      "DELETE FROM records WHERE workspace_id = $1 AND story_id LIKE 'story_atomic_%'",
      "DELETE FROM stories WHERE workspace_id = $1 AND id LIKE 'story_atomic_%'",
      "DELETE FROM player_world_memberships WHERE workspace_id = $1 AND world_id LIKE 'world_atomic_%'",
      "DELETE FROM worldlines WHERE workspace_id = $1 AND id LIKE 'wl_atomic_%'",
      "DELETE FROM worlds WHERE workspace_id = $1 AND id LIKE 'world_atomic_%'",
    ];
    for (const statement of statements) {
      await client.query(statement, [WS]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function authedJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `realm_session=${createSessionValue(PRINCIPAL)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function tamperNodeHashes(owner: pg.Pool, storyId: string, hash: string): Promise<void> {
  // Valid-shaped inconsistent legacy graph simulates a downstream binding
  // failure. This fixture runs only in disposable scratch.
  await owner.query(
    "UPDATE story_node_instances SET definition_hash = $3 WHERE workspace_id = $1 AND story_id = $2",
    [WS, storyId, hash],
  );
}

async function commandState(owner: pg.Pool, worldlineId: string, milestoneId: string) {
  const result = await owner.query<{
    status: string;
    version: string;
    receipts: string;
    ledger: string;
    head_tick: string;
  }>(
    `SELECT milestone.status, project.version::text AS version,
       (SELECT count(*)::text FROM project_finance_command_groups
        WHERE workspace_id = $1 AND worldline_id = $2) AS receipts,
       (SELECT count(*)::text FROM ledger_entries
        WHERE workspace_id = $1 AND worldline_id = $2) AS ledger,
       (SELECT head_tick::text FROM worldlines
        WHERE workspace_id = $1 AND id = $2) AS head_tick
     FROM project_milestones AS milestone JOIN projects AS project
       ON project.workspace_id = milestone.workspace_id AND project.id = milestone.project_id
     WHERE milestone.workspace_id = $1 AND milestone.worldline_id = $2 AND milestone.id = $3`,
    [WS, worldlineId, milestoneId],
  );
  return result.rows[0]!;
}

async function nodeState(owner: pg.Pool, storyId: string, nodeKey: string) {
  const result = await owner.query<{ state: string; record_id: string | null }>(
    `SELECT state, record_id FROM story_node_instances
     WHERE workspace_id = $1 AND story_id = $2 AND node_key = $3`,
    [WS, storyId, nodeKey],
  );
  return result.rows[0] ?? null;
}

test(
  "new command + continuation failure: 503 with Story-specific code and full rollback",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });
    const ids = await seedWorldline(owner, suffix, "t1");
    const { projectId, milestoneId } = await seedMilestoneProject(owner, ids, suffix, "t1");
    const definition = definitionFor(suffix, [
      { nodeKey: "encore", recordKey: "encore-record", unlock: { kind: "milestone_status", milestoneId, status: "completed" } },
    ]);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId: ids.storyId, definition });
    const encoreRecordId = storyRecordIdFor(
      { workspaceId: WS, worldId: ids.worldId, worldlineId: ids.worldlineId, storyId: ids.storyId },
      "encore",
    );
    await tamperNodeHashes(owner, ids.storyId, "f".repeat(64));

    await endSharedRuntimePools();
    const response = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${ids.worldId}`,
      { command: "confirm_milestone", projectId, milestoneId, expectedProjectVersion: 1 },
      { "idempotency-key": `atomic-t1-${suffix}` },
    ));
    assert.equal(response.status, 503);
    const body = await response.json() as { ok: false; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "STORY_DEFINITION_CONFLICT",
      "Story continuation failure must keep a Story-specific code, not PROJECT_FINANCE_READ_FAILED");

    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "planned", version: "1", receipts: "0", ledger: "0", head_tick: "0",
    }, "HTTP failure must roll back command, receipt and Story continuation together");
    const encore = await nodeState(owner, ids.storyId, "encore");
    assert.equal(encore?.state, "locked");
    const record = await owner.query(
      `SELECT count(*)::text AS n FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, encoreRecordId],
    );
    assert.equal(record.rows[0]?.n, "0", "no newRecord survives the rolled-back unlock");
  },
);

test(
  "failure on a later Story rolls back an earlier Story's unlock in the same command",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });
    const ids = await seedWorldline(owner, suffix, "t2");
    const { projectId, milestoneId } = await seedMilestoneProject(owner, ids, suffix, "t2");
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    const definition = definitionFor(suffix, [
      { nodeKey: "encore", recordKey: "encore-record", unlock: { kind: "milestone_status", milestoneId, status: "completed" } },
    ]);
    await storyGraph.materialize({ workspaceId: WS, storyId: ids.storyId, definition });

    // Second Story (sorts after the first) with a tampered graph: the first
    // Story reconciles and unlocks, the second fails.
    const story2Id = `story_atomic_t2b_${suffix}`;
    await owner.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, 'Atomic story B', 'active', 'Second story.', 0, 0)`,
      [WS, ids.worldId, ids.worldlineId, story2Id],
    );
    const definition2 = normalizeStoryDefinition({
      storyKey: `story.atomic.${suffix}.b`,
      title: "Atomic story B",
      premise: "Second story.",
      policyVersion: "story-graph-v1",
      nodes: [
        { kind: "record", nodeKey: "start", recordKey: "start-record", title: "Start", sequence: 1, initial: true },
      ],
    });
    await storyGraph.materialize({ workspaceId: WS, storyId: story2Id, definition: definition2 });
    await tamperNodeHashes(owner, story2Id, "e".repeat(64));

    await endSharedRuntimePools();
    const response = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${ids.worldId}`,
      { command: "confirm_milestone", projectId, milestoneId, expectedProjectVersion: 1 },
      { "idempotency-key": `atomic-t2-${suffix}` },
    ));
    assert.equal(response.status, 503);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "planned", version: "1", receipts: "0", ledger: "0", head_tick: "0",
    });
    const encore = await nodeState(owner, ids.storyId, "encore");
    assert.equal(encore?.state, "locked",
      "the first Story's unlock must roll back when the second Story fails");
    assert.equal(encore?.record_id, null, "no partial Story record write survives");
  },
);

test(
  "correcting the fault then retrying the SAME key commits once; re-replay has no duplicates",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });
    const ids = await seedWorldline(owner, suffix, "t3");
    const { projectId, milestoneId } = await seedMilestoneProject(owner, ids, suffix, "t3");
    const definition = definitionFor(suffix, [
      { nodeKey: "encore", recordKey: "encore-record", unlock: { kind: "milestone_status", milestoneId, status: "completed" } },
    ]);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId: ids.storyId, definition });
    const correctHash = storyDefinitionHashFor(definition);
    const encoreRecordId = storyRecordIdFor(
      { workspaceId: WS, worldId: ids.worldId, worldlineId: ids.worldlineId, storyId: ids.storyId },
      "encore",
    );
    const key = `atomic-t3-${suffix}`;
    const send = () => projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${ids.worldId}`,
      { command: "confirm_milestone", projectId, milestoneId, expectedProjectVersion: 1 },
      { "idempotency-key": key },
    ));

    await tamperNodeHashes(owner, ids.storyId, "f".repeat(64));
    await endSharedRuntimePools();
    const failed = await send();
    assert.equal(failed.status, 503);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "planned", version: "1", receipts: "0", ledger: "0", head_tick: "0",
    });

    // Correct the fault, retry the SAME idempotency key: commits once with
    // the real Story unlock.
    await owner.query(
      "UPDATE story_node_instances SET definition_hash = $3 WHERE workspace_id = $1 AND story_id = $2",
      [WS, ids.storyId, correctHash],
    );
    await endSharedRuntimePools();
    const committed = await send();
    assert.equal(committed.status, 200);
    const committedBody = await committed.json() as {
      ok: true;
      data: { status: string; projectVersion: number };
      meta: { storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(committedBody.data.status, "committed");
    assert.equal(committedBody.data.projectVersion, 2);
    assert.deepEqual(committedBody.meta.storyUnlocks, [
      { storyId: ids.storyId, nodeKey: "encore", recordId: encoreRecordId },
    ]);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "completed", version: "2", receipts: "1", ledger: "0", head_tick: "0",
    });

    // Same key again: replayed, no duplicate receipt/unlock/record.
    await endSharedRuntimePools();
    const replayed = await send();
    assert.equal(replayed.status, 200);
    const replayedBody = await replayed.json() as {
      data: { status: string };
      meta: { storyUnlocks?: unknown[] };
    };
    assert.equal(replayedBody.data.status, "replayed");
    assert.deepEqual(replayedBody.meta.storyUnlocks ?? [], []);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "completed", version: "2", receipts: "1", ledger: "0", head_tick: "0",
    });
    const records = await owner.query(
      `SELECT count(*)::text AS n FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, encoreRecordId],
    );
    assert.equal(records.rows[0]?.n, "1");
  },
);

test(
  "legacy graph without binding fails explicitly; a graph-less Story stays ignored",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });

    // Legacy worldline: graph rows exist but no persisted binding.
    const legacy = await seedWorldline(owner, suffix, "t4l");
    const legacyProject = await seedMilestoneProject(owner, legacy, suffix, "t4l");
    await owner.query(
      `INSERT INTO story_node_instances (
         workspace_id, world_id, worldline_id, story_id, node_key, id,
         state, revision, definition_hash, unlock_evidence_event_ids, unlock_evidence
       ) VALUES ($1, $2, $3, $4, 'opening', $5, 'locked', 0, $6, ARRAY[]::text[], '{}'::jsonb)`,
      [WS, legacy.worldId, legacy.worldlineId, legacy.storyId, `node_atomic_legacy_${suffix}`, "c".repeat(64)],
    );

    // Graph-less worldline: a Story that never materialized its graph.
    const plain = await seedWorldline(owner, suffix, "t4p");
    const plainProject = await seedMilestoneProject(owner, plain, suffix, "t4p");

    await endSharedRuntimePools();
    const failed = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${legacy.worldId}`,
      {
        command: "confirm_milestone",
        projectId: legacyProject.projectId,
        milestoneId: legacyProject.milestoneId,
        expectedProjectVersion: 1,
      },
      { "idempotency-key": `atomic-t4l-${suffix}` },
    ));
    assert.equal(failed.status, 503);
    const failedBody = await failed.json() as { ok: false; error: { code: string } };
    assert.equal(failedBody.error.code, "STORY_DEFINITION_NOT_FOUND",
      "a legacy graph must fail with the explicit compatibility code, never be silently skipped");
    assert.deepEqual(await commandState(owner, legacy.worldlineId, legacyProject.milestoneId), {
      status: "planned", version: "1", receipts: "0", ledger: "0", head_tick: "0",
    }, "the new command rolls back with the explicit failure");

    await endSharedRuntimePools();
    const okResponse = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${plain.worldId}`,
      {
        command: "confirm_milestone",
        projectId: plainProject.projectId,
        milestoneId: plainProject.milestoneId,
        expectedProjectVersion: 1,
      },
      { "idempotency-key": `atomic-t4p-${suffix}` },
    ));
    assert.equal(okResponse.status, 200);
    const okBody = await okResponse.json() as { data: { status: string }; meta: { storyUnlocks?: unknown[] } };
    assert.equal(okBody.data.status, "committed");
    assert.deepEqual(okBody.meta.storyUnlocks ?? [], []);
  },
);

test(
  "old committed receipt replays with blocked continuation, then a repaired same-key retry finishes once",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });
    const ids = await seedWorldline(owner, suffix, "t5");
    const { projectId, milestoneId } = await seedMilestoneProject(owner, ids, suffix, "t5");
    const definition = definitionFor(suffix, [
      { nodeKey: "encore", recordKey: "encore-record", unlock: { kind: "milestone_status", milestoneId, status: "completed" } },
    ]);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId: ids.storyId, definition });
    const correctHash = storyDefinitionHashFor(definition);
    const scope = { workspaceId: WS, worldId: ids.worldId, worldlineId: ids.worldlineId };
    const encoreRecordId = storyRecordIdFor({ ...scope, storyId: ids.storyId }, "encore");
    const key = `atomic-t5-${suffix}`;

    // Simulate the pre-F1b world: the command+receipt committed while the
    // Story continuation never ran (downstream fault). The receipt rows are
    // seeded exactly as the production command would have written them.
    const request = {
      command: "project.milestone.confirmed",
      projectId,
      milestoneId,
      expectedProjectVersion: 1,
      evidence: null,
    };
    const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
    const commandGroupId = projectFinanceCommandGroupIdFor(scope, key, requestFingerprint);
    const storedResult = {
      status: "committed",
      commandGroupId,
      projectId,
      milestoneId,
      projectVersion: 2,
      eventKind: "project.milestone.confirmed",
    };
    await owner.query(
      `UPDATE project_milestones SET status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND id = $2`,
      [WS, milestoneId],
    );
    await owner.query(
      `UPDATE projects SET version = 2, updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND id = $2`,
      [WS, projectId],
    );
    await owner.query(
      `INSERT INTO project_finance_command_groups (
         workspace_id, world_id, worldline_id, id, idempotency_key,
         request_fingerprint, state, result_manifest, policy_version,
         source_record_id, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'committed', $7::jsonb, 'project-finance-command.v1', NULL, CURRENT_TIMESTAMP)`,
      [WS, ids.worldId, ids.worldlineId, commandGroupId, key, requestFingerprint,
        JSON.stringify({ result: storedResult, request })],
    );
    await tamperNodeHashes(owner, ids.storyId, "f".repeat(64));

    const send = () => projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${ids.worldId}`,
      { command: "confirm_milestone", projectId, milestoneId, expectedProjectVersion: 1 },
      { "idempotency-key": key },
    ));

    // The old receipt is honestly replayed; the failing continuation is an
    // explicit blocked state, not a fake success and not an un-commit.
    await endSharedRuntimePools();
    const blocked = await send();
    assert.equal(blocked.status, 200);
    const blockedBody = await blocked.json() as {
      ok: true;
      data: { status: string; commandGroupId: string; projectVersion: number };
      meta: { storyContinuation?: unknown; storyUnlocks?: unknown };
    };
    assert.equal(blockedBody.data.status, "replayed");
    assert.equal(blockedBody.data.commandGroupId, commandGroupId);
    assert.equal(blockedBody.data.projectVersion, 2);
    assert.deepEqual(blockedBody.meta.storyContinuation, {
      status: "blocked",
      code: "STORY_CONTINUATION_BLOCKED",
    });
    assert.equal(blockedBody.meta.storyUnlocks, undefined);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "completed", version: "2", receipts: "1", ledger: "0", head_tick: "0",
    }, "no new delta and no retrospective un-commit of the historical receipt");
    const stillLocked = await nodeState(owner, ids.storyId, "encore");
    assert.equal(stillLocked?.state, "locked", "no partial unlock survives the blocked continuation");

    // Repair the fault; the explicit same-key retry finishes the projection
    // exactly once, still honestly replayed (no new command).
    await owner.query(
      "UPDATE story_node_instances SET definition_hash = $3 WHERE workspace_id = $1 AND story_id = $2",
      [WS, ids.storyId, correctHash],
    );
    await endSharedRuntimePools();
    const repaired = await send();
    assert.equal(repaired.status, 200);
    const repairedBody = await repaired.json() as {
      data: { status: string };
      meta: { storyContinuation?: unknown; storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(repairedBody.data.status, "replayed");
    assert.equal(repairedBody.meta.storyContinuation, undefined);
    assert.deepEqual(repairedBody.meta.storyUnlocks, [
      { storyId: ids.storyId, nodeKey: "encore", recordId: encoreRecordId },
    ]);

    await endSharedRuntimePools();
    const settled = await send();
    const settledBody = await settled.json() as {
      data: { status: string };
      meta: { storyUnlocks?: unknown[] };
    };
    assert.equal(settledBody.data.status, "replayed");
    assert.deepEqual(settledBody.meta.storyUnlocks ?? [], []);
    assert.deepEqual(await commandState(owner, ids.worldlineId, milestoneId), {
      status: "completed", version: "2", receipts: "1", ledger: "0", head_tick: "0",
    });
    const records = await owner.query(
      `SELECT count(*)::text AS n FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, encoreRecordId],
    );
    assert.equal(records.rows[0]?.n, "1", "the repaired retry projects exactly once");
  },
);

test(
  "real finance cash and obligation commands unlock persisted Story rules atomically",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupSeededWorlds(owner);
      await runtime.end();
      await owner.end();
    });
    const ids = await seedWorldline(owner, suffix, "t6");
    const { projectId } = await seedMilestoneProject(owner, ids, suffix, "t6");
    const accountId = `acct_atomic_${suffix}`;
    const obligationId = `obl_atomic_${suffix}`;
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 2000)`,
      [WS, ids.worldId, ids.worldlineId, accountId],
    );
    await owner.query(
      `INSERT INTO obligations (
         workspace_id, world_id, worldline_id, id, project_id, kind, status,
         principal_minor, outstanding_minor, undelivered_count, version
       ) VALUES ($1, $2, $3, $4, $5, 'loan', 'open', 1000, 1000, 0, 1)`,
      [WS, ids.worldId, ids.worldlineId, obligationId, projectId],
    );
    const definition = definitionFor(suffix, [
      { nodeKey: "cashgate", recordKey: "cashgate-record", unlock: { kind: "cash_at_least", minimumMinor: 2500 } },
      {
        nodeKey: "oblgate",
        recordKey: "oblgate-record",
        unlock: { kind: "obligation_outstanding_at_most", obligationId, maximumMinor: 0 },
      },
    ]);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId: ids.storyId, definition });
    const scope = { workspaceId: WS, worldId: ids.worldId, worldlineId: ids.worldlineId };
    const cashRecordId = storyRecordIdFor({ ...scope, storyId: ids.storyId }, "cashgate");
    const oblRecordId = storyRecordIdFor({ ...scope, storyId: ids.storyId }, "oblgate");

    // Real cash change through the finance route unlocks the cash-gated node.
    await endSharedRuntimePools();
    const income = await financeCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/finance/commands?worldId=${ids.worldId}`,
      {
        command: "record_income",
        accountId,
        amountMinor: 500,
        category: "ticket",
        memo: "Presale",
        occurredAt: "2026-10-16T00:00:00.000Z",
        expectedBalanceMinor: 2000,
      },
      { "idempotency-key": `atomic-t6-income-${suffix}` },
    ));
    assert.equal(income.status, 200);
    const incomeBody = await income.json() as {
      data: { status: string; cash: { balanceMinor: number } };
      meta: { storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(incomeBody.data.status, "committed");
    assert.equal(incomeBody.data.cash.balanceMinor, 2500);
    assert.deepEqual(incomeBody.meta.storyUnlocks, [
      { storyId: ids.storyId, nodeKey: "cashgate", recordId: cashRecordId },
    ], "cash_at_least unlocks through the real finance route");
    assert.equal((await nodeState(owner, ids.storyId, "oblgate"))?.state, "locked",
      "the obligation-gated node is not unlocked by a cash change");

    // Real obligation settlement through the finance route unlocks the
    // obligation-gated node in the same transaction.
    await endSharedRuntimePools();
    const settled = await financeCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/finance/commands?worldId=${ids.worldId}`,
      {
        command: "settle_obligation",
        obligationId,
        settlementKind: "repayment",
        amountMinor: 1000,
        expectedOutstandingMinor: 1000,
        expectedBalanceMinor: 2500,
        accountId,
        category: "loan",
        memo: "Repay",
        occurredAt: "2026-10-16T01:00:00.000Z",
      },
      { "idempotency-key": `atomic-t6-settle-${suffix}` },
    ));
    assert.equal(settled.status, 200);
    const settledBody = await settled.json() as {
      data: { status: string; outstandingMinor: number; cash: { balanceMinor: number } };
      meta: { storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(settledBody.data.status, "committed");
    assert.equal(settledBody.data.outstandingMinor, 0);
    assert.equal(settledBody.data.cash.balanceMinor, 1500);
    assert.deepEqual(settledBody.meta.storyUnlocks, [
      { storyId: ids.storyId, nodeKey: "oblgate", recordId: oblRecordId },
    ], "obligation_outstanding_at_most unlocks through the real finance route");

    // Same-key replay of the settlement: no duplicate ledger/settlement/unlock.
    await endSharedRuntimePools();
    const replayed = await financeCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/finance/commands?worldId=${ids.worldId}`,
      {
        command: "settle_obligation",
        obligationId,
        settlementKind: "repayment",
        amountMinor: 1000,
        expectedOutstandingMinor: 1000,
        expectedBalanceMinor: 2500,
        accountId,
        category: "loan",
        memo: "Repay",
        occurredAt: "2026-10-16T01:00:00.000Z",
      },
      { "idempotency-key": `atomic-t6-settle-${suffix}` },
    ));
    assert.equal(replayed.status, 200);
    const replayedBody = await replayed.json() as {
      data: { status: string };
      meta: { storyUnlocks?: unknown[] };
    };
    assert.equal(replayedBody.data.status, "replayed");
    assert.deepEqual(replayedBody.meta.storyUnlocks ?? [], []);
    const counts = await owner.query<{ ledger: string; settlements: string; records: string }>(
      `SELECT
         (SELECT count(*)::text FROM ledger_entries WHERE workspace_id = $1 AND worldline_id = $2) AS ledger,
         (SELECT count(*)::text FROM obligation_settlements WHERE workspace_id = $1 AND worldline_id = $2) AS settlements,
         (SELECT count(*)::text FROM records WHERE workspace_id = $1 AND worldline_id = $2 AND story_id = $3) AS records`,
      [WS, ids.worldlineId, ids.storyId],
    );
    assert.deepEqual(counts.rows[0], { ledger: "2", settlements: "1", records: "3" });
  },
);
