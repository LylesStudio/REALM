import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { POSTGRES_DEMO_IDS, RealmRuntimeSaveRepositoryError, createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer, createPostgresStoryGraphRepository } from "../database/postgres/public.ts";
import { reconcileWorldlineStories } from "../modules/application/story-graph-continuation.ts";
import { normalizeStoryDefinition, storyDefinitionHashFor, storyRecordIdFor, type StoryDefinition } from "../modules/story-graph/public.ts";
import { parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { POST as whole_saveRoutePOST } from "../app/api/record/backup/route.ts";
import { POST as projectCommandsPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { installTestSessionSecret } from "./helpers/session-proof.ts";

{

// Explicit operator fixture for the frozen whole-closure tests; HTTP and SQL
// still evaluate exact operator + current World owner on every request.
let wholePreviousOperators: string | undefined;
test.beforeEach(()=>{wholePreviousOperators=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;});
test.afterEach(()=>{if(wholePreviousOperators===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=wholePreviousOperators;});


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

function definitionFor(suffix: string, milestoneId: string): StoryDefinition {
  return normalizeStoryDefinition({
    storyKey: `story.bindings.${suffix}`,
    title: "Binding story",
    premise: "F1 binding rehearsal.",
    policyVersion: "story-graph-v1",
    nodes: [
      { kind: "record", nodeKey: "opening", recordKey: "opening-record", title: "Opening", sequence: 1, initial: true },
      {
        kind: "record",
        nodeKey: "encore",
        recordKey: "encore-record",
        title: "Encore",
        sequence: 2,
        unlock: { kind: "milestone_status", milestoneId, status: "completed" },
      },
    ],
  });
}

async function seedWorldline(owner: pg.Pool, suffix: string) {
  const worldId = `world_bind_${suffix}`;
  const worldlineId = `wl_bind_${suffix}`;
  const storyId = `story_bind_${suffix}`;
  await owner.query(
    `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
     VALUES ($1, $2, 'Binding rehearsal', 'active', 'native_calendar', '{}'::jsonb)`,
    [WS, worldId],
  );
  await owner.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
     VALUES ($1, $2, $3, 'Binding line', 'active', 0, 0)`,
    [WS, worldId, worldlineId],
  );
  await owner.query(
    `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [WS, worldId, PRINCIPAL],
  );
  await owner.query(
    `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, 'Binding story', 'active', 'F1 rehearsal.', 0, 0)`,
    [WS, worldId, worldlineId, storyId],
  );
  return { worldId, worldlineId, storyId };
}


async function seedSceneAndPolicy(
  owner: pg.Pool,
  ids: { worldId: string; worldlineId: string; recordId: string },
  suffix: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, $5, 'Opening scene', 'active', 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, ids.recordId, `scene_bind_${suffix}`],
  );
  await owner.query(
    `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
     VALUES ($1, $2, $3, $4, $5, 'opening', 1, 'public')`,
    [WS, ids.worldId, ids.worldlineId, ids.recordId, `policy_bind_${suffix}`],
  );
  // The save route resolves a player seat: a principal-bound narrator
  // participant (restores rebind it to the restoring principal).
  await owner.query(
    `INSERT INTO participants (
       workspace_id, world_id, worldline_id, record_id, id, participant_kind,
       character_instance_id, principal_id, controller_mode, is_active, speaking_order
     ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, $6, 'human', true, 0)`,
    [WS, ids.worldId, ids.worldlineId, ids.recordId, `part_bind_${suffix}`, PRINCIPAL],
  );
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

test(
  "0069 installs the immutable Story definition binding table with forced RLS and least grants",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools();
    t.after(async () => {
      await runtime.end();
      await owner.end();
    });
    const table = await owner.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class
       WHERE relname = 'story_definition_bindings' AND relkind = 'r'`,
    );
    assert.deepEqual(table.rows, [{ relforcerowsecurity: true }]);
    const trigger = await owner.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'story_definition_bindings'::regclass
         AND tgname = 'story_definition_bindings_append_only_guard'`,
    );
    assert.equal(trigger.rowCount, 1);
    const grants = await owner.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'realm_runtime' AND table_name = 'story_definition_bindings'
       ORDER BY privilege_type`,
    );
    assert.deepEqual(grants.rows.map((row) => row.privilege_type), ["INSERT", "SELECT"]);

    // Immutability holds even for the owner connection (direct UPDATE/DELETE).
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { worldId, worldlineId, storyId } = await seedWorldline(owner, suffix);
    await owner.query(
      `INSERT INTO story_definition_bindings (
         workspace_id, world_id, worldline_id, story_id, definition_hash, definition, origin
       ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'materialization')`,
      [WS, worldId, worldlineId, storyId, "a".repeat(64)],
    );
    await assert.rejects(
      owner.query(
        `UPDATE story_definition_bindings SET definition_hash = $5
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4`,
        [WS, worldId, worldlineId, storyId, "b".repeat(64)],
      ),
      /immutable/,
    );
    await assert.rejects(
      owner.query(
        `DELETE FROM story_definition_bindings
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4`,
        [WS, worldId, worldlineId, storyId],
      ),
      /immutable/,
    );
    await owner.query("DELETE FROM stories WHERE workspace_id = $1 AND id = $2", [WS, storyId]);
    const leftover = await owner.query(
      `SELECT count(*)::text AS count FROM story_definition_bindings
       WHERE workspace_id = $1 AND story_id = $2`,
      [WS, storyId],
    );
    assert.equal(leftover.rows[0]?.count, "0", "Story deletion cascades the binding");
  },
);

test(
  "ordinary save route works with only recordId once materialization persisted the binding",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    // Explicit server backup capability for this isolated fixture only.
    const previousBackupOperators = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = PRINCIPAL;
    try {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await runtime.end();
      await owner.end();
    });
    const { worldId, worldlineId, storyId } = await seedWorldline(owner, suffix);
    const milestoneId = `mile_bind_${suffix}`;
    const definition = definitionFor(suffix, milestoneId);
    const definitionHash = storyDefinitionHashFor(definition);

    // Second Story with a DIFFERENT definition binding in the same worldline.
    const story2Id = `story_bind_b_${suffix}`;
    await owner.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, 'Binding story B', 'active', 'Second binding.', 0, 0)`,
      [WS, worldId, worldlineId, story2Id],
    );
    const definition2 = normalizeStoryDefinition({
      storyKey: `story.bindings.${suffix}.b`,
      title: "Binding story B",
      premise: "Second binding.",
      policyVersion: "story-graph-v1",
      nodes: [
        { kind: "record", nodeKey: "start", recordKey: "start-record", title: "Start", sequence: 1, initial: true },
      ],
    });

    const storyGraph = createPostgresStoryGraphRepository(runtime);
    const scope = { workspaceId: WS, worldId, worldlineId, storyId };
    const materialized = await storyGraph.materialize({ workspaceId: WS, storyId, definition });
    const recordId = storyRecordIdFor(scope, "opening");
    assert.equal(materialized.nodes.find((node) => node.nodeKey === "opening")?.recordId, recordId);
    await storyGraph.materialize({ workspaceId: WS, storyId: story2Id, definition: definition2 });
    await seedSceneAndPolicy(owner, { worldId, worldlineId, recordId }, suffix);

    // The binding rows exist with exact hashes.
    const stored = await owner.query<{ story_id: string; definition_hash: string; origin: string }>(
      `SELECT story_id, definition_hash, origin FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2 ORDER BY story_id`,
      [WS, worldlineId],
    );
    // SQL ORDER BY 是字节序；期望侧也必须字节序排序（localeCompare 的
    // ICU 规则会忽略 '_'，对随机 hex 后缀产生不稳定顺序）。
    const expectedBindings = [
      { story_id: storyId, definition_hash: definitionHash, origin: "materialization" },
      { story_id: story2Id, definition_hash: storyDefinitionHashFor(definition2), origin: "materialization" },
    ].sort((left, right) => (left.story_id < right.story_id ? -1 : left.story_id > right.story_id ? 1 : 0));
    assert.deepEqual(stored.rows, expectedBindings);

    // Fresh process boundary: drop every pool the route could reuse.
    await endSharedRuntimePools();

    // REAL save route: only recordId, no definitions anywhere.
    const response = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId }));
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const archive = parseRealmRuntimeSaveArchive(bytes);
    assert.ok(archive.domain);
    const expectedCarried = [[storyId, definitionHash], [story2Id, storyDefinitionHashFor(definition2)]]
      .sort((left, right) => left[0].localeCompare(right[0]));
    assert.deepEqual(
      archive.domain.storyDefinitions!.map((entry) => [entry.storyId, entry.definitionHash] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
      expectedCarried,
      "both node-bearing Stories carry their persisted authoritative definitions",
    );

    // Route hardening: unknown fields and missing session fail closed.
    const unknownField = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId, storyDefinitions: {} }));
    assert.equal(unknownField.status, 400);
    const anonymous = await whole_saveRoutePOST(new Request("http://localhost/api/record/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId }),
    }));
    assert.equal(anonymous.status, 401);

    // Legacy graph without a persisted binding fails closed with the explicit
    // compatibility error (no fabricated definition from node rows).
    const legacyStoryId = `story_bind_legacy_${suffix}`;
    const worldline2Id = `wl_bind_legacy_${suffix}`;
    await owner.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'Legacy line', 'active', 0, 0)`,
      [WS, worldId, worldline2Id],
    );
    await owner.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, 'Legacy story', 'active', 'Pre-binding graph.', 0, 0)`,
      [WS, worldId, worldline2Id, legacyStoryId],
    );
    const legacyRecordId = `record_bind_legacy_${suffix}`;
    await owner.query(
      `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind, linked_record_id)
       VALUES ($1, $2, $3, $4, $5, 'Legacy record', 'active', 0, 0, 'primary', NULL)`,
      [WS, worldId, worldline2Id, legacyStoryId, legacyRecordId],
    );
    await owner.query(
      `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_world_tick, last_world_ordinal)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
      [WS, worldId, worldline2Id, legacyRecordId],
    );
    await seedSceneAndPolicy(owner, { worldId, worldlineId: worldline2Id, recordId: legacyRecordId }, `legacy_${suffix}`);
    const legacyNodeId = `node_bind_legacy_${suffix}`;
    await owner.query(
      `INSERT INTO story_node_instances (
         workspace_id, world_id, worldline_id, story_id, node_key, id,
         state, revision, definition_hash, unlock_evidence_event_ids, unlock_evidence
       ) VALUES ($1, $2, $3, $4, 'opening', $5, 'locked', 0, $6, ARRAY[]::text[], '{}'::jsonb)`,
      [WS, worldId, worldline2Id, legacyStoryId, legacyNodeId, "c".repeat(64)],
    );
    const legacySave = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId: legacyRecordId }));
    assert.equal(legacySave.status, 422);
    const legacyBody = await legacySave.json() as { ok: false; error: { code: string; message: string } };
    assert.equal(legacyBody.error.code, "RUNTIME_SAVE_INVALID");
    assert.match(legacyBody.error.message, /predate persisted definition bindings/);

    // Re-materializing the legacy graph with its authoritative definition
    // back-fills the binding atomically (hash must match the node rows).
    const legacyDefinition = definitionFor(`legacy.${suffix}`, milestoneId);
    await assert.rejects(
      storyGraph.materialize({ workspaceId: WS, storyId: legacyStoryId, definition: legacyDefinition }),
      /definition changed after runtime materialization/,
      "a different definition cannot take over a legacy graph",
    );
    } finally {
      if (previousBackupOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
      else process.env.REALM_OPERATOR_PRINCIPALS = previousBackupOperators;
    }
  },
);

test(
  "restore persists the remapped binding; fresh continuation unlocks and saves again",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    // Explicit server backup capability for this isolated fixture only.
    const previousBackupOperators = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = PRINCIPAL;
    try {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await runtime.end();
      await owner.end();
    });
    const { worldId, worldlineId, storyId } = await seedWorldline(owner, suffix);
    const milestoneId = `mile_bind_${suffix}`;
    const projectId = `proj_bind_${suffix}`;
    const definition = definitionFor(suffix, milestoneId);
    const sourceHash = storyDefinitionHashFor(definition);
    const scope = { workspaceId: WS, worldId, worldlineId };

    await owner.query(
      `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
       VALUES ($1, $2, $3, $4, 'production', 'active', 'funding', 'Binding production', 'JPY', NULL, NULL, 1)`,
      [WS, worldId, worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [WS, worldId, worldlineId, `link_bind_${suffix}`, projectId, storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'Encore gate', 'planned', NULL, NULL, NULL)`,
      [WS, worldId, worldlineId, milestoneId, projectId],
    );

    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId, definition });
    const recordId = storyRecordIdFor({ ...scope, storyId }, "opening");
    await seedSceneAndPolicy(owner, { worldId, worldlineId, recordId }, suffix);

    // Save through the reader (production input shape) and restore.
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive?.domain);
    assert.equal(
      archive.domain.storyDefinitions![0]?.sourceBinding,
      undefined,
      "a native materialization has no restore origin; the field stays absent (old-format shape)",
    );
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
    const restoreKey = `bind-restore-${suffix}`;
    const restored = await restorer.restore({
      workspaceId: WS,
      principalId: PRINCIPAL,
      archive,
      targetWorldId: worldId,
      idempotencyKey: restoreKey,
    });
    assert.equal(restored.replayed, false);
    assert.notEqual(restored.worldlineId, worldlineId);

    // The remapped binding persisted with immutable source identity.
    const binding = await owner.query<{
      definition_hash: string;
      origin: string;
      source_workspace_id: string | null;
      source_story_id: string | null;
      source_definition_hash: string | null;
    }>(
      `SELECT definition_hash, origin, source_workspace_id, source_story_id, source_definition_hash
       FROM story_definition_bindings
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4`,
      [WS, worldId, restored.worldlineId, restored.storyId],
    );
    assert.equal(binding.rowCount, 1);
    assert.equal(binding.rows[0]!.origin, "restore");
    assert.equal(binding.rows[0]!.source_workspace_id, WS);
    assert.equal(binding.rows[0]!.source_story_id, storyId);
    assert.equal(binding.rows[0]!.source_definition_hash, sourceHash);
    assert.notEqual(binding.rows[0]!.definition_hash, sourceHash,
      "the remapped definition binds the target node rows, not the source hash");
    assert.equal(binding.rows[0]!.definition_hash, restored.storyDefinitions?.[0]?.definitionHash);

    // Fresh-process continuation WITHOUT any caller definition: the encore
    // node stays locked until the real milestone command commits.
    const continuationScope = { workspaceId: WS, worldId, worldlineId: restored.worldlineId };
    const idle = await reconcileWorldlineStories(runtime, continuationScope);
    assert.deepEqual(idle.unlocks, []);
    assert.deepEqual(idle.reconciledStoryIds, [restored.storyId]);

    // Commit the target milestone through the REAL production command service.
    const restoredMilestone = await owner.query<{ id: string; project_id: string }>(
      `SELECT id, project_id FROM project_milestones
       WHERE workspace_id = $1 AND worldline_id = $2 AND title = 'Encore gate'`,
      [WS, restored.worldlineId],
    );
    const restoredProject = await owner.query<{ version: string }>(
      `SELECT version::text AS version FROM projects
       WHERE workspace_id = $1 AND worldline_id = $2 AND id = $3`,
      [WS, restored.worldlineId, restoredMilestone.rows[0]!.project_id],
    );
    // F1a：走 REAL 路由并显式指定恢复出的目标 worldlineId——路由必须在
    // 目标世界线提交里程碑并返回 meta.worldlineId/storyUnlocks，而不是
    // 回退到最早世界线报 PROJECT_NOT_FOUND。
    await endSharedRuntimePools();
    const commandResponse = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${worldId}&worldlineId=${restored.worldlineId}`,
      { command: "confirm_milestone", projectId: restoredMilestone.rows[0]!.project_id,
        milestoneId: restoredMilestone.rows[0]!.id,
        expectedProjectVersion: Number(restoredProject.rows[0]!.version) },
      { "idempotency-key": `bind-encore-${suffix}` },
    ));
    const commandJson = await commandResponse.json() as {
      ok: true;
      meta: { worldlineId: string; storyUnlocks: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(commandResponse.status, 200,
      `production bridge must target the restored worldline, not the oldest: ${JSON.stringify(commandJson)}`);
    assert.equal(commandJson.meta.worldlineId, restored.worldlineId);
    assert.equal(commandJson.meta.storyUnlocks.length, 1);
    assert.equal(commandJson.meta.storyUnlocks[0]!.storyId, restored.storyId);
    assert.equal(commandJson.meta.storyUnlocks[0]!.nodeKey, "encore");
    const encoreRecordId = commandJson.meta.storyUnlocks[0]!.recordId;
    assert.ok(encoreRecordId);

    // 源世界线保持不动：源里程碑仍 planned、源项目版本不变、无目标侧
    // 命令组/账本行写回源世界线。
    const sourceState = await owner.query<{
      milestone_status: string;
      project_version: string;
      command_groups: string;
      ledger_rows: string;
      head_tick: string;
      head_ordinal: string;
    }>(
      `SELECT
         (SELECT status FROM project_milestones
           WHERE workspace_id = $1 AND worldline_id = $2 AND id = $3) AS milestone_status,
         (SELECT version::text FROM projects
           WHERE workspace_id = $1 AND worldline_id = $2 AND id = $4) AS project_version,
         (SELECT count(*)::text FROM project_finance_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2) AS command_groups,
         (SELECT count(*)::text FROM ledger_entries
           WHERE workspace_id = $1 AND worldline_id = $2) AS ledger_rows,
         (SELECT head_tick::text FROM worldlines
           WHERE workspace_id = $1 AND id = $2) AS head_tick,
         (SELECT head_ordinal::text FROM worldlines
           WHERE workspace_id = $1 AND id = $2) AS head_ordinal`,
      [WS, worldlineId, milestoneId, projectId],
    );
    assert.deepEqual(sourceState.rows[0], {
      milestone_status: "planned",
      project_version: "1",
      command_groups: "0",
      ledger_rows: "0",
      head_tick: "0",
      head_ordinal: "0",
    }, "source worldline project/milestone/ledger/head unchanged by the target write");

    // Idempotent: reconciling again performs no duplicate unlock.
    const settled = await reconcileWorldlineStories(runtime, continuationScope);
    assert.deepEqual(settled.unlocks, []);

    // Ordinary save works again on the continued worldline (route, recordId
    // only), and the carried definition hash matches the persisted binding.
    await endSharedRuntimePools();
    const saveAgain = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId: restored.recordId }));
    assert.equal(saveAgain.status, 200);
    const reparsed = parseRealmRuntimeSaveArchive(new Uint8Array(await saveAgain.arrayBuffer()));
    assert.equal(reparsed.domain?.storyDefinitions?.[0]?.definitionHash, binding.rows[0]!.definition_hash);
    assert.equal(reparsed.domain?.storyNodes.find((node) => node.nodeKey === "encore")?.state, "active");
    // F1c: the reader carries the persisted first-known origin literally.
    const carriedOrigin = reparsed.domain?.storyDefinitions?.[0]?.sourceBinding;
    assert.deepEqual(carriedOrigin, {
      workspaceId: WS,
      storyId,
      definitionHash: sourceHash,
    });

    // Restore again under a new key; replay under the same key adds nothing.
    const restorer2 = createPostgresRealmRuntimeSaveRestorer(runtime);
    const secondRestore = await restorer2.restore({
      workspaceId: WS,
      principalId: PRINCIPAL,
      archive: reparsed,
      targetWorldId: worldId,
      idempotencyKey: `${restoreKey}-second`,
    });
    assert.equal(secondRestore.replayed, false);
    const secondBindings = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [WS, secondRestore.worldlineId],
    );
    assert.equal(secondBindings.rows[0]?.count, "1");
    // F1c: the second restore preserves the ORIGINAL source binding instead
    // of relabeling the previous target as the origin.
    const secondOrigin = await owner.query<{
      source_workspace_id: string;
      source_story_id: string;
      source_definition_hash: string;
    }>(
      `SELECT source_workspace_id, source_story_id, source_definition_hash
       FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2 AND story_id = $3`,
      [WS, secondRestore.worldlineId, secondRestore.storyId],
    );
    assert.deepEqual(secondOrigin.rows, [{
      source_workspace_id: WS,
      source_story_id: storyId,
      source_definition_hash: sourceHash,
    }], "second restore must preserve the ORIGINAL source binding, not relabel the previous target as origin");

    // Third cycle: save the second-restored worldline (route, recordId only)
    // and restore again — origin metadata stays byte-identical.
    await endSharedRuntimePools();
    const saveThird = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId: secondRestore.recordId }));
    assert.equal(saveThird.status, 200);
    const thirdParsed = parseRealmRuntimeSaveArchive(new Uint8Array(await saveThird.arrayBuffer()));
    assert.equal(
      JSON.stringify(thirdParsed.domain?.storyDefinitions?.[0]?.sourceBinding),
      JSON.stringify(carriedOrigin),
      "origin metadata is byte-identical across repeated save cycles",
    );
    const thirdRestore = await restorer2.restore({
      workspaceId: WS,
      principalId: PRINCIPAL,
      archive: thirdParsed,
      targetWorldId: worldId,
      idempotencyKey: `${restoreKey}-third`,
    });
    assert.equal(thirdRestore.replayed, false);
    const thirdOrigin = await owner.query<{
      source_workspace_id: string;
      source_story_id: string;
      source_definition_hash: string;
    }>(
      `SELECT source_workspace_id, source_story_id, source_definition_hash
       FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2 AND story_id = $3`,
      [WS, thirdRestore.worldlineId, thirdRestore.storyId],
    );
    assert.deepEqual(thirdOrigin.rows, secondOrigin.rows,
      "third restore persists byte-identical origin metadata");
    const replayedRestore = await restorer2.restore({
      workspaceId: WS,
      principalId: PRINCIPAL,
      archive,
      targetWorldId: worldId,
      idempotencyKey: restoreKey,
    });
    assert.equal(replayedRestore.replayed, true);
    const bindingTotal = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM story_definition_bindings
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, worldId],
    );
    assert.equal(bindingTotal.rows[0]?.count, "4", "source + first + second + third restore, no duplicates");

    // Rollback: an archive whose Story definition was tampered with fails
    // the whole restore with the stable integrity code/reason, and leaves
    // ZERO residual writes anywhere in the exact target scope. The
    // before/after counts below cover every worldline/Story/Record/
    // binding/event/project/finance/fact table a domain restore can write,
    // scoped exactly to (workspace_id, world_id) — no `%wildcard%` on
    // generated ids (they carry unrelated hashes and made the old
    // `%tampered%` query vacuous) and no guessed derived ids.
    const tampered = parseRealmRuntimeSaveArchive(
      new Uint8Array(await (await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId }))).arrayBuffer()),
    );
    assert.ok(tampered.domain);
    const tamperedDefinitions = tampered.domain.storyDefinitions!.map((entry) => ({
      ...entry,
      definition: { ...entry.definition, title: "Tampered title" },
    }));
    const tamperedDomain = { ...tampered.domain, storyDefinitions: tamperedDefinitions };
    const tamperedArchive = { ...tampered, domain: tamperedDomain };
    // Closed literal allowlist of restore-writable tables; values are always
    // bound parameters, identifiers come only from this list — never from
    // arbitrary input.
    const TAMPER_SCOPE_TABLES = [
      "worldlines",
      "stories",
      "story_definition_bindings",
      "story_node_instances",
      "story_unlock_ledger",
      "records",
      "scenes",
      "participants",
      "visibility_policies",
      "events",
      "projects",
      "project_story_links",
      "project_milestones",
      "project_finance_command_groups",
      "finance_accounts",
      "budget_allocations",
      "ledger_entries",
      "obligations",
      "obligation_settlements",
      "committed_fact_commands",
      "performance_assessments",
      "member_relationship_revisions",
    ] as const;
    const scopedCounts = async (): Promise<Record<string, string>> => {
      const counts: Record<string, string> = {};
      for (const table of TAMPER_SCOPE_TABLES) {
        const result = await owner.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1 AND world_id = $2`,
          [WS, worldId],
        );
        counts[table] = result.rows[0]!.count;
      }
      return counts;
    };
    const beforeCounts = await scopedCounts();
    await assert.rejects(
      restorer2.restore({
        workspaceId: WS,
        principalId: PRINCIPAL,
        archive: tamperedArchive,
        targetWorldId: worldId,
        idempotencyKey: `${restoreKey}-tampered`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RealmRuntimeSaveRepositoryError,
          "tampered restore must fail with the stable repository error type");
        assert.equal(error.code, "RUNTIME_SAVE_INVALID",
          "tampered restore must fail with the stable integrity code");
        assert.match(error.message, /Story definition hash does not match its content/,
          "tampered restore must fail with the stable hash-mismatch reason");
        return true;
      },
    );
    const afterCounts = await scopedCounts();
    assert.deepEqual(afterCounts, beforeCounts,
      "the rejected tampered restore must leave EVERY target-scope count unchanged (zero residual writes)");
    } finally {
      if (previousBackupOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
      else process.env.REALM_OPERATOR_PRINCIPALS = previousBackupOperators;
    }
  },
);

test(
  "a foreign-workspace origin string injected as descriptive metadata is carried literally while every target row stays target-scoped (metadata injection, not a real two-workspace export)",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    // Explicit server backup capability for this isolated fixture only.
    const previousBackupOperators = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = PRINCIPAL;
    try {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await runtime.end();
      await owner.end();
    });
    const { worldId, worldlineId, storyId } = await seedWorldline(owner, suffix);
    const milestoneId = `mile_bind_${suffix}`;
    const definition = definitionFor(suffix, milestoneId);
    const sourceHash = storyDefinitionHashFor(definition);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId, definition });
    const recordId = storyRecordIdFor({ workspaceId: WS, worldId, worldlineId, storyId }, "opening");
    await seedSceneAndPolicy(owner, { worldId, worldlineId, recordId }, suffix);

    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive?.domain);

    // HONEST BOUNDARY: this test INJECTS a foreign-workspace origin string
    // directly into the archive as descriptive metadata. It does NOT
    // provision or export from a real second workspace, so it is a metadata
    // isolation negative only — a genuine two-workspace export -> restore
    // workflow remains UNVERIFIED in this suite. The injected metadata is
    // descriptive provenance only: it never re-scopes any target row.
    const foreignOrigin = {
      workspaceId: "ws_origin_foreign",
      storyId: "story_origin_foreign",
      definitionHash: sourceHash,
    };
    const carriedArchive = {
      ...archive,
      domain: {
        ...archive.domain,
        storyDefinitions: archive.domain.storyDefinitions!.map((entry) => ({
          ...entry,
          sourceBinding: foreignOrigin,
        })),
      },
    };
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
    const restored = await restorer.restore({
      workspaceId: WS,
      principalId: PRINCIPAL,
      archive: carriedArchive,
      targetWorldId: worldId,
      idempotencyKey: `bind-foreign-${suffix}`,
    });
    assert.equal(restored.replayed, false);

    const rows = await owner.query<{
      workspace_id: string;
      origin: string;
      source_workspace_id: string;
      source_story_id: string;
      source_definition_hash: string;
      story_workspace_id: string;
    }>(
      `SELECT b.workspace_id, b.origin, b.source_workspace_id, b.source_story_id,
              b.source_definition_hash, st.workspace_id AS story_workspace_id
       FROM story_definition_bindings b
       JOIN stories st
         ON st.workspace_id = b.workspace_id AND st.world_id = b.world_id
        AND st.worldline_id = b.worldline_id AND st.id = b.story_id
       WHERE b.workspace_id = $1 AND b.worldline_id = $2 AND b.story_id = $3`,
      [WS, restored.worldlineId, restored.storyId],
    );
    assert.deepEqual(rows.rows, [{
      workspace_id: WS,
      origin: "restore",
      source_workspace_id: foreignOrigin.workspaceId,
      source_story_id: foreignOrigin.storyId,
      source_definition_hash: sourceHash,
      story_workspace_id: WS,
    }], "origin metadata retains the foreign source while every target scope row remains targetWS");

    // The provenance round-trips through the next ordinary save unchanged.
    await endSharedRuntimePools();
    const saveAgain = await whole_saveRoutePOST(authedJson("http://localhost/api/record/backup", { recordId: restored.recordId }));
    assert.equal(saveAgain.status, 200);
    const reparsed = parseRealmRuntimeSaveArchive(new Uint8Array(await saveAgain.arrayBuffer()));
    assert.deepEqual(reparsed.domain?.storyDefinitions?.[0]?.sourceBinding, foreignOrigin);
    // The CURRENT target definition/hash still remap and verify normally:
    // the carried foreign origin never replaces them.
    const binding = await owner.query<{ definition_hash: string }>(
      `SELECT definition_hash FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2 AND story_id = $3`,
      [WS, restored.worldlineId, restored.storyId],
    );
    assert.equal(reparsed.domain?.storyDefinitions?.[0]?.definitionHash, binding.rows[0]!.definition_hash);
    } finally {
      if (previousBackupOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
      else process.env.REALM_OPERATOR_PRINCIPALS = previousBackupOperators;
    }
  },
);

test(
  "bridge milestone command route unlocks the gated node via server continuation",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    t.after(async () => {
      await endSharedRuntimePools();
      await runtime.end();
      await owner.end();
    });
    const { worldId, worldlineId, storyId } = await seedWorldline(owner, suffix);
    const milestoneId = `mile_bind_${suffix}`;
    const projectId = `proj_bind_${suffix}`;
    await owner.query(
      `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
       VALUES ($1, $2, $3, $4, 'production', 'active', 'funding', 'Route production', 'JPY', NULL, NULL, 1)`,
      [WS, worldId, worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [WS, worldId, worldlineId, `link_bind_${suffix}`, projectId, storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'Route gate', 'planned', NULL, NULL, NULL)`,
      [WS, worldId, worldlineId, milestoneId, projectId],
    );
    const definition = definitionFor(suffix, milestoneId);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId, definition });
    const scope = { workspaceId: WS, worldId, worldlineId, storyId };
    const encoreRecordId = storyRecordIdFor(scope, "encore");

    await endSharedRuntimePools();
    const response = await projectCommandsPOST(authedJson(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${worldId}`,
      {
        command: "confirm_milestone",
        projectId,
        milestoneId,
        expectedProjectVersion: 1,
      },
      { "idempotency-key": `route-confirm-${suffix}` },
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok: true;
      data: { status: string };
      meta: { storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
    };
    assert.equal(body.data.status, "committed");
    assert.deepEqual(body.meta.storyUnlocks, [{ storyId, nodeKey: "encore", recordId: encoreRecordId }]);

    // The unlock persisted through the normal ledger with target identities.
    const node = await owner.query<{ state: string; record_id: string }>(
      `SELECT state, record_id FROM story_node_instances
       WHERE workspace_id = $1 AND story_id = $2 AND node_key = 'encore'`,
      [WS, storyId],
    );
    assert.deepEqual(node.rows, [{ state: "active", record_id: encoreRecordId }]);

    // Route authorization: anonymous callers never reach the command service.
    const anonymous = await projectCommandsPOST(new Request(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${worldId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `route-anon-${suffix}` },
        body: JSON.stringify({ command: "confirm_milestone", projectId, milestoneId, expectedProjectVersion: 1 }),
      },
    ));
    assert.equal(anonymous.status, 401);
  },
);

for(const mode of ['local','event','goal','all','any','not'] as const) {
  test(`C3 D6 locked immutable rule dependency ${mode}`,{skip:!adminConnectionString||!runtimeConnectionString,timeout:120_000},async t=>{
    const {owner,runtime}=pools();
    const ended:Promise<void>[]=[];for(const pool of [owner,runtime])pool.on('connect',client=>ended.push(new Promise(resolve=>client.once('end',resolve))));
    t.after(async()=>{await endSharedRuntimePools();await runtime.end();await owner.end();await Promise.all(ended);});
    const suffix=randomUUID().replaceAll('-','').slice(0,12);
    const {worldId,worldlineId,storyId}=await seedWorldline(owner,suffix);
    const opening=storyRecordIdFor({workspaceId:WS,worldId,worldlineId,storyId},'opening');
    const foreign=`private_record_${suffix}`;
    // A legal same-Story Record which is deliberately outside the ordinary closure.
    await owner.query(`INSERT INTO records(workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal)
      VALUES($1,$2,$3,$4,$5,'Private non-node Record','active',0,0)`,[WS,worldId,worldlineId,storyId,foreign]);
    const localRule={kind:'event_count' as const,eventKind:'goal.transition.committed',recordId:opening,threshold:1};
    const eventRule={...localRule,recordId:foreign};
    const goalRule={kind:'goal_state' as const,scope:'record' as const,goalKey:'absent',state:'active' as const,recordId:foreign};
    const unlock=mode==='local'?localRule:mode==='event'?eventRule:mode==='goal'?goalRule:
      mode==='all'?{kind:'all' as const,rules:[localRule,eventRule]}:
      mode==='any'?{kind:'any' as const,rules:[localRule,goalRule]}:
      {kind:'all' as const,rules:[localRule,{kind:'not' as const,rule:eventRule}]};
    const definition=normalizeStoryDefinition({storyKey:`c3.dependencies.${suffix}`,title:'Locked dependency',premise:'Persisted locked successor dependencies',policyVersion:'story-graph-v1',nodes:[
      {kind:'record',nodeKey:'opening',recordKey:'opening',title:'Opening',sequence:1,initial:true},
      {kind:'record',nodeKey:'locked',recordKey:'locked',title:'Locked successor',sequence:2,unlock},
    ]});
    await createPostgresStoryGraphRepository(runtime).materialize({workspaceId:WS,storyId,definition});
    await seedSceneAndPolicy(owner,{worldId,worldlineId,recordId:opening},suffix);
    const locked=await owner.query("SELECT state,record_id FROM story_node_instances WHERE workspace_id=$1 AND story_id=$2 AND node_key='locked'",[WS,storyId]);
    assert.deepEqual(locked.rows,[{state:'locked',record_id:null}]);
    const image=async()=>{
      const rows:Record<string,unknown>={};
      for(const table of ['worldlines','stories','records','record_heads','events','record_goal_restore_admissions','story_definition_bindings','story_node_instances','story_unlock_ledger'])
        rows[table]=(await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM ${table} r WHERE workspace_id=$1 AND world_id=$2`,[WS,worldId])).rows[0].rows;
      return rows;
    };
    if(mode!=='local'){
      const {executeRecordGoalCommand}=await import('../modules/application/record-goal-command.ts');
      const {sessionProofFor}=await import('./helpers/session-proof.ts');
      await executeRecordGoalCommand(runtime,{scope:{workspaceId:WS,worldId,worldlineId,recordId:opening},principalId:PRINCIPAL,sessionProof:sessionProofFor(PRINCIPAL),idempotencyKey:`c3.source.${suffix}`,command:{operation:'create',recordId:opening,expectedHead:{recordVersion:0,ordinal:0},draft:{title:'Native branch evidence',description:'C3',successConditions:['Keep formal direction'],failureConditions:[],changePolicy:'fixed',visible:true}}});
    }
    const before=await image();
    const {POST:savePOST}=await import('../app/api/record/save/route.ts');
    const {POST:branchPOST}=await import('../app/api/record/branch/route.ts');
    const response=await savePOST(authedJson('http://localhost/api/record/save',{recordId:opening}));
    if(mode!=='local'){
      assert.equal(response.status,422);assert.equal((await response.json()).error.code,'RUNTIME_SAVE_INVALID');
      const branch=await branchPOST(authedJson('http://localhost/api/record/branch',{recordId:opening,idempotencyKey:`c3.dep.${suffix}`}));
      assert.equal(branch.status,422);assert.equal((await branch.json()).error.code,'RUNTIME_SAVE_INVALID');
      assert.deepEqual(await image(),before,'failed exports and branches leave all authority unchanged');
    }else{
      assert.equal(response.status,200);
      const archive=parseRealmRuntimeSaveArchive(new Uint8Array(await response.arrayBuffer()));
      assert.deepEqual(archive.domain?.records,[]);assert.equal(archive.domain?.storyDefinitions?.length,1);
      assert.deepEqual(await image(),before,'successful ordinary export is read only');
      const {sessionProofFor}=await import('./helpers/session-proof.ts');
      const input={workspaceId:WS,targetWorldId:worldId,principalId:PRINCIPAL,sessionProof:sessionProofFor(PRINCIPAL),archive,idempotencyKey:`c3.dep.restore.${suffix}`};
      const restorer=createPostgresRealmRuntimeSaveRestorer(runtime),target=await restorer.restore(input);
      const targetScope={workspaceId:WS,worldId,worldlineId:target.worldlineId,recordId:target.recordId};
      assert.deepEqual((await reconcileWorldlineStories(runtime,targetScope)).unlocks,[],'successor remains locked without evidence');
      // A real native command supplies committed evidence after restore. No
      // definition is supplied to continuation: it resolves the persisted binding.
      const {executeRecordGoalCommand}=await import('../modules/application/record-goal-command.ts');
      await executeRecordGoalCommand(runtime,{scope:targetScope,principalId:PRINCIPAL,sessionProof:sessionProofFor(PRINCIPAL),idempotencyKey:`c3.unlock.${suffix}`,command:{operation:'create',recordId:target.recordId,expectedHead:{recordVersion:0,ordinal:0},draft:{title:'A committed goal',description:'C3',successConditions:['Reach a formal outcome'],failureConditions:[],changePolicy:'fixed',visible:true}}});
      const kinds=(await owner.query('SELECT event_kind FROM events WHERE workspace_id=$1 AND record_id=$2',[WS,target.recordId])).rows;
      // The rule names the native command event, so this also checks its real wire identity.
      assert.ok(kinds.some(row=>row.event_kind===localRule.eventKind),JSON.stringify(kinds));
      const unlocked=await reconcileWorldlineStories(runtime,targetScope);
      assert.equal(unlocked.unlocks.length,1);assert.equal(unlocked.unlocks[0]!.nodeKey,'locked');assert.equal(unlocked.unlocks[0]!.storyId,target.storyId);
      const targetRows=(await owner.query("SELECT state,record_id,unlock_evidence_event_ids FROM story_node_instances WHERE workspace_id=$1 AND story_id=$2 AND node_key='locked'",[WS,target.storyId])).rows;
      assert.equal(targetRows[0].state,'active');assert.equal(targetRows[0].record_id,unlocked.unlocks[0]!.recordId);assert.ok(targetRows[0].unlock_evidence_event_ids.length>0);
      assert.deepEqual((await reconcileWorldlineStories(runtime,targetScope)).unlocks,[]);
      assert.equal((await restorer.restore(input)).replayed,true);
      assert.deepEqual((await owner.query("SELECT state,record_id FROM story_node_instances WHERE workspace_id=$1 AND story_id=$2 AND node_key='locked'",[WS,storyId])).rows,[{state:'locked',record_id:null}]);
    }
    console.log('C3_D6_RULE',JSON.stringify({mode,status:response.status}));
  });
}

}
