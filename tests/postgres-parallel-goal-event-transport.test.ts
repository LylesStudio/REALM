/** NOT_RUN in F5b. Syntax/types only; future authorized disposable PG execution. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { executeTurn } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

import { executeRecordGoalCommand } from "../modules/application/record-goal-command.ts";
import { createRecordGoalDefinitionResolver } from "../modules/application/record-goal-definition.ts";
import { createPostgresGoalAssessmentJobQueue } from "../database/postgres/goal-assessment-job-queue.ts";
import { planRecordGoalReplacement, decodeRecordGoalDefinition } from "../modules/goals/record-authoring.ts";

// MIGRATION_COUNT_EVOLUTION: frozen accepted filenames plus exactly 0079.
const EXPECTED_MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0028_propagation_node_audiences_owner_append.sql",
  "0029_record_scene_tension.sql",
  "0030_character_instance_state.sql",
  "0031_keen_insight_discovery.sql",
  "0032_character_activity_grants.sql",
  "0033_base_skill_metadata_grant.sql",
  "0034_revoke_broad_skill_metadata_grant.sql",
  "0035_keen_insight_concrete_discovery.sql",
  "0036_keen_insight_location_context.sql",
  "0037_record_archive_grant.sql",
  "0038_remove_base_skill_hidden_clue.sql",
  "0039_scene_weather_snapshot.sql",
  "0040_scene_display_time_snapshot.sql",
  "0041_article_qualification_and_import_entries.sql",
  "0042_realm_transfer_and_import_jobs.sql",
  "0043_propagation_node_audience_archived_guard.sql",
  "0044_record_branch_timeline_kind.sql",
  "0045_lobby_rooms.sql",
  "0046_lobby_room_world_link.sql",
  "0047_lobby_host_lease.sql",
  "0048_scene_image_generations.sql",
  "0049_scene_image_mode.sql",
  "0050_scene_image_requests.sql",
  "0051_account_password_hash.sql",
  "0052_scene_image_queue_lease_fencing.sql",
  "0053_membership_capability.sql",
  "0054_world_version_identity.sql",
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  "0057_realmworld_record_binding.sql",
  "0058_durable_job_queue.sql",
  "0059_world_commands.sql",
  "0060_goal_scope_terminal_lifecycle.sql",
  "0061_story_graph_runtime.sql",
  "0062_project_finance_foundation.sql",
  "0063_genesis_creation_requests.sql",
  "0064_record_turn_jobs.sql",
  "0065_funding_obligations.sql",
  "0066_committed_fact_commands.sql",
  "0067_member_relationship_revisions.sql",
  "0068_inventory_grant_command.sql",
  "0069_record_goal_authoring.sql",
  "0070_record_goal_authoring_capability.sql",
  "0071_record_narrative_state.sql",
  "0072_record_goal_evolution_capability.sql",
  "0073_record_goal_genesis_capability.sql",
  "0074_record_goal_restore_capability.sql",
  "0075_record_goal_branch_capability.sql",
  "0076_story_definition_bindings.sql",
  "0077_grouped_record_goal_restore_capability.sql",
  "0078_bridge_command_write_authorization.sql",
  "0079_restored_outbox_delivery_origin.sql",
  "0080_realmworld_command_materializations.sql",
  "0081_command_policy_record_lock.sql",
  "0082_performance_evidence_snapshots.sql",
  "0083_goal_content_instance_bindings.sql",
  "0084_performance_evidence_transport_provenance.sql",
  "0085_runtime_performance_transport_body_v3.sql",
  "0086_unsigned_import_declaration_guard.sql",
];

async function fixture(t: test.TestContext) {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "authorized disposable full-migration runner required before pool allocation");
  assert.ok(process.env.DATABASE_URL && process.env.REALM_RUNTIME_DATABASE_URL);
  installTestSessionSecret();
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); t.after(() => owner.end());
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 }); t.after(() => runtime.end());
  // Each finalizer is registered immediately after allocation, before any
  // fallible setup. Immutable history belongs to disposable cluster teardown.
  const suffix = randomUUID().replaceAll("-", ""), workspaceId = `f5b_ws_${suffix}`, otherWorkspaceId = `f5b_other_${suffix}`, principalId = `principal_f5b_owner_${suffix}`;
  const required = (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort();
  const applied = (await owner.query<{ filename: string }>("SELECT filename FROM realm_schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.equal(required.length, 86); assert.deepEqual(required, EXPECTED_MIGRATIONS); assert.deepEqual(applied, required, "complete inherited migration chain, never a reduced fixture schema");
  await seedPostgresDemo(owner, { workspaceId, principalId }); await seedCapabilitySessionKey(owner, workspaceId);
  await seedPostgresDemo(owner, { workspaceId: otherWorkspaceId, principalId }); await seedCapabilitySessionKey(owner, otherWorkspaceId);
  const worldId = `f5b_world_${suffix}`, worldlineId = `f5b_line_${suffix}`, recordId = `f5b_record_${suffix}`, storyId = `f5b_story_${suffix}`, sceneId = `f5b_scene_${suffix}`, policyId = `f5b_policy_${suffix}`;
  await withWorkspaceTransaction(owner, workspaceId, async client => {
    const clone = async (table: string, predicate: string, source: string, patch: object) => {
      const r = await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), workspaceId, source]);
      assert.equal(r.rowCount, 1, `fixture ${table}`);
    };
    const scope = { world_id: worldId, worldline_id: worldlineId, record_id: recordId };
    await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: worldId, world_version: "0.0.0-local", name: "F5b isolated transport" });
    await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: worldlineId, world_id: worldId, head_tick: 0, head_ordinal: 0, parent_worldline_id: null });
    await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scope, id: storyId, start_tick: 0, start_ordinal: 0 });
    await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scope, id: recordId, story_id: storyId, status: "active", world_version: "0.0.0-local", start_tick: 0, start_ordinal: 0, linked_record_id: null });
    await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
    await clone("scenes", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: sceneId, start_tick: 0, start_ordinal: 0 });
    await clone("visibility_policies", "policy_kind='public' AND record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: policyId, policy_key: "f5b-public" });
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [workspaceId, worldId, principalId]);
  });
  const scope = { workspaceId, worldId, worldlineId, recordId };
  const draft = { title: "Deliver the original", description: "Keep the original safe", changePolicy: "evolving", visible: true,
    successConditions: ["The recipient receives the original"], failureConditions: [], settlementConditions: [] };
  const command = (key: string, command: unknown) => executeRecordGoalCommand(runtime, { scope, principalId,
    sessionProof: sessionProofFor(principalId), idempotencyKey: key, command });
  const created = await command(`f5b_create_${suffix}`, { operation: "create", recordId, expectedHead: { recordVersion: 0, ordinal: 0 }, draft });
  const revised = await command(`f5b_revise_${suffix}`, { operation: "revise", recordId, expectedHead: { recordVersion: 1, ordinal: 1 },
    goalInstanceId: created.goalInstanceId, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
    reason: "same-token", draft: { ...draft, title: "Reach the original recipient" } });
  // A real runtime writer creates committed narration evidence after revision.
  // Deliberately collide the Event token with a Goal token across typed spaces.
  const evidenceId = String(revised.goalInstanceId);
  const repo = createPostgresRuntimeRepository({ pool: runtime, workspaceId,
    mapFormalEvent: () => ({ sceneId, visibilityPolicyId: policyId, eventKind: "narration.committed", actorParticipantId: null, content: "The harbor is closed; the refuge is open" }) });
  const completed = await executeTurn({ recordId, expectedRecordVersion: 2, idempotencyKey: `f5b_evidence_${suffix}`, actorId: null, commandType: "player.utterance", payload: {} }, {
    repository: repo, planner: { async plan() { return {}; } }, drafter: { async draft() { return {}; } }, validator: { async validate() { return {}; } },
    releaseBuilder: { async build() { return { formalEvents: [{ eventId: evidenceId, kind: "narration.committed", payload: { content: "The harbor is closed; the refuge is open" } }], outbox: [] }; } },
    idFactory: () => `f5b_turn_${randomUUID()}`, clock: () => new Date().toISOString(),
  }); assert.equal(completed.state, "completed");
  const queue = createPostgresGoalAssessmentJobQueue({ pool: runtime, workspaceId, leaseOwner: `f5b_evolve_${suffix}` });
  await queue.enqueue({ ...scope, jobId: `f5b_job_${suffix}`, goalInstanceId: evidenceId, sourceEventId: evidenceId });
  const job = await queue.claimNext({ now: new Date().toISOString() }); assert.ok(job);
  const definition = await createRecordGoalDefinitionResolver(runtime)(job); assert.ok(definition);
  const previous = decodeRecordGoalDefinition(definition), context = await queue.loadContext(job, previous);
  const plan = planRecordGoalReplacement({ previous, scope, instance: context.instance, expectedDefinitionVersion: previous.definitionVersion,
    expectedInstanceRevision: context.instance.revision, nextDraft: { ...previous.draft, title: "Reach the northern refuge" },
    reason: "same-token", evidenceEventIds: [evidenceId], events: context.events, observedHead: context.head });
  // Execute the actual 0072 capability under its genuine live job lease.
  // This fixture does not pretend that hand-authored payload JSON is a SQL writer.
  await withWorkspaceTransaction(runtime, workspaceId, c => c.query("SELECT record_goal_evolve($1,$2,$3,$4,$5::jsonb,$6)",
    [workspaceId, job.jobId, job.leaseOwner, job.attemptCount, JSON.stringify(plan.definition), context.instance.revision]));
  const reader = createPostgresRealmRuntimeSaveReader(runtime), restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const load = (id = recordId, ws = workspaceId) => reader.load({ workspaceId: ws, recordId: id, principalId, purpose: "record-export" });
  const source = await load(); assert.ok(source);
  const bodies = source.record.events.filter(e => e.kind === "goal.transition.committed").map(e => body(e.payload));
  assert.equal(bodies.filter(b => b.operation === "revise").length, 1); assert.equal(bodies.filter(b => b.operation === "evolve").length, 1);
  assert.deepEqual(bodies.find(b => b.operation === "evolve")!.basisEventIds, [evidenceId]);
  return { owner, runtime, workspaceId, otherWorkspaceId, principalId, worldId, recordId, load, restorer };
}
type ObjectRow = Record<string, unknown>;
function body(payload: unknown): ObjectRow {
  const p = payload as ObjectRow, event = (p.eventPayload ?? p) as ObjectRow;
  return (event.__realmRuntimePayload ?? event) as ObjectRow;
}
function pack(a: RealmRuntimeSaveArchive) { return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)); }

test("F5b PG actual 0070/0072 writers → reader → ZIP → restore/readback, two transports and replay", async t => {
  const f = await fixture(t); let recordId = f.recordId;
  const sourceBefore = await f.load(); assert.ok(sourceBefore);
  for (let round = 0; round < 2; round++) {
    const source = await f.load(recordId); assert.ok(source); const archive = pack(source);
    const input = { workspaceId: f.workspaceId, principalId: f.principalId, targetWorldId: f.worldId,
      idempotencyKey: `f5b_restore_${round}_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId), archive };
    const result = await f.restorer.restore(input);
    const read = () => withWorkspaceTransaction(f.owner, f.workspaceId, async c => ({
      goals: (await c.query("SELECT * FROM goal_instances WHERE workspace_id=$1 AND record_id=$2", [f.workspaceId, result.recordId])).rows,
      events: (await c.query("SELECT * FROM events WHERE workspace_id=$1 AND record_id=$2 ORDER BY record_ordinal", [f.workspaceId, result.recordId])).rows,
    }));
    const target = await read(); assert.equal(target.events.length, source.record.events.length); assert.equal(target.goals.length, source.goals.instances.length);
    const goalIds = new Map(source.goals.instances.map(value => { const g = value as ObjectRow; return [String(g.id), target.goals.find(t => t.goal_key === g.goalKey)!.id]; }));
    const eventIds = new Map(source.record.events.map(e => [e.eventId, target.events.find(t => Number(t.record_ordinal) === e.ordinal)!.id]));
    for (const event of source.record.events.filter(e => e.kind === "goal.transition.committed")) {
      const old = body(event.payload), b = body(target.events.find(t => Number(t.record_ordinal) === event.ordinal)!.payload);
      for (const key of ["goalInstanceId", "successorGoalInstanceId", "predecessorGoalInstanceId"])
        if (key in old) assert.equal(b[key], goalIds.get(String(old[key])));
      if ("basisEventIds" in old) assert.deepEqual(b.basisEventIds, (old.basisEventIds as string[]).map(id => eventIds.get(id)));
      for (const key of ["goalKey", "reason", "actorPrincipalId", "operation", "from", "to", "revision", "resolutionKind", "definitionVersion"])
        if (key in old) assert.deepEqual(b[key], old[key]);
    }
    const evolution = source.record.events.map(e => body(e.payload)).find(b => b.operation === "evolve")!;
    const coincident = String(evolution.predecessorGoalInstanceId);
    if (round === 0) { assert.ok(goalIds.has(coincident) && eventIds.has(coincident)); assert.notEqual(goalIds.get(coincident), eventIds.get(coincident)); }
    assert.equal((await f.restorer.restore(input)).replayed, true); assert.deepEqual(await read(), target);
    const changed = structuredClone(archive), transition = changed.record.events.find(e => body(e.payload).operation === "evolve")!;
    body(transition.payload).reason = "changed literal";
    await assert.rejects(f.restorer.restore({ ...input, archive: changed }), { code: "RESTORE_CONFLICT" }); assert.deepEqual(await read(), target);
    recordId = result.recordId;
  }
  assert.deepEqual(await f.load(), sourceBefore, "source immutable history remains intact");
});

test("F5b PG two-workspace read/restore rejection and bad anchors produce no target rows", async t => {
  const f = await fixture(t), archive = await f.load(); assert.ok(archive); assert.equal(await f.load(f.recordId, f.otherWorkspaceId), null);
  const count = (ws: string) => withWorkspaceTransaction(f.owner, ws, async c => (await c.query(
    "SELECT (SELECT count(*) FROM worldlines WHERE workspace_id=$1)::text AS lines,(SELECT count(*) FROM events WHERE workspace_id=$1)::text AS events,(SELECT count(*) FROM goal_instances WHERE workspace_id=$1)::text AS goals", [ws])).rows);
  const foreignBefore = await count(f.otherWorkspaceId);
  await assert.rejects(f.restorer.restore({ workspaceId: f.otherWorkspaceId, principalId: f.principalId, targetWorldId: f.worldId,
    archive: pack(archive), idempotencyKey: `f5b_foreign_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId) }));
  assert.deepEqual(await count(f.otherWorkspaceId), foreignBefore);
  for (const patch of [{ successorGoalInstanceId: null }, { predecessorGoalInstanceId: "foreign" }, { basisEventIds: ["foreign"] }]) {
    const bad = structuredClone(archive), event = bad.record.events.find(e => body(e.payload).operation === "evolve")!; Object.assign(body(event.payload), patch);
    const before = await count(f.workspaceId);
    await assert.rejects(f.restorer.restore({ workspaceId: f.workspaceId, principalId: f.principalId, targetWorldId: f.worldId,
      archive: bad, idempotencyKey: `f5b_invalid_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId) }), { code: "RUNTIME_SAVE_INVALID" });
    assert.deepEqual(await count(f.workspaceId), before);
  }
});
