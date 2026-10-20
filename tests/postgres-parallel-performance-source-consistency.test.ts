/** F6a PG NOT_RUN: prepared for an explicitly authorized disposable runner only. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { executeTurn } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

import { createCommittedFactCommandService } from "../modules/application/committed-fact-command.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import { mapLocalFormalEvent } from "../modules/application/local-record-service.ts";
import { fallbackCompositeSemanticSegments } from "../modules/presentation/semantic-segments.ts";
import type { FormalEventPayload } from "../modules/application/local-record-turn-runtime.ts";

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
  const suffix = randomUUID().replaceAll("-", ""), workspaceId = `f6a_ws_${suffix}`, otherWorkspaceId = `f6a_other_${suffix}`, principalId = `principal_f6a_owner_${suffix}`;
  const required = (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort();
  const applied = (await owner.query<{ filename: string }>("SELECT filename FROM realm_schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.equal(required.length, 86); assert.deepEqual(required, EXPECTED_MIGRATIONS); assert.deepEqual(applied, required, "complete inherited migration chain, never a reduced fixture schema");
  await seedPostgresDemo(owner, { workspaceId, principalId }); await seedCapabilitySessionKey(owner, workspaceId);
  await seedPostgresDemo(owner, { workspaceId: otherWorkspaceId, principalId }); await seedCapabilitySessionKey(owner, otherWorkspaceId);
  const worldId = `f6a_world_${suffix}`, worldlineId = `f6a_line_${suffix}`, recordId = `f6a_record_${suffix}`, storyId = `f6a_story_${suffix}`, sceneId = `f6a_scene_${suffix}`, policyId = `f6a_policy_${suffix}`;
  await withWorkspaceTransaction(owner, workspaceId, async client => {
    const clone = async (table: string, predicate: string, source: string, patch: object) => {
      const r = await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), workspaceId, source]);
      assert.equal(r.rowCount, 1, `fixture ${table}`);
    };
    const scope = { world_id: worldId, worldline_id: worldlineId, record_id: recordId };
    await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: worldId, world_version: "0.0.0-local", name: "F6a isolated transport" });
    await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: worldlineId, world_id: worldId, head_tick: 0, head_ordinal: 0, parent_worldline_id: null });
    await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scope, id: storyId, start_tick: 0, start_ordinal: 0 });
    await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scope, id: recordId, story_id: storyId, status: "active", world_version: "0.0.0-local", start_tick: 0, start_ordinal: 0, linked_record_id: null });
    await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
    await clone("scenes", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: sceneId, start_tick: 0, start_ordinal: 0 });
    await clone("visibility_policies", "policy_kind='public' AND record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: policyId, policy_key: "f6a-public" });
    // Immediate participant membership FK requires the human's membership first.
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [workspaceId, worldId, principalId]);
    for (const [i, source] of [POSTGRES_DEMO_IDS.playerParticipant, POSTGRES_DEMO_IDS.scoutParticipant].entries()) {
      const definitionId = `f6a_definition_${suffix}_${i}`, continuityId = `f6a_continuity_${suffix}_${i}`, instanceId = `f6a_instance_${suffix}_${i}`;
      const oldDefinition = i ? POSTGRES_DEMO_IDS.scoutDefinition : POSTGRES_DEMO_IDS.playerDefinition;
      const oldContinuity = i ? POSTGRES_DEMO_IDS.scoutContinuity : POSTGRES_DEMO_IDS.playerContinuity;
      const oldInstance = i ? POSTGRES_DEMO_IDS.scoutInstance : POSTGRES_DEMO_IDS.playerInstance;
      await clone("character_definitions", "id", oldDefinition, { world_id: worldId, id: definitionId });
      await clone("character_continuities", "id", oldContinuity, { world_id: worldId, worldline_id: worldlineId, definition_id: definitionId, id: continuityId, continuity_key: continuityId, born_tick: 0, born_ordinal: 0 });
      await clone("character_instances", "id", oldInstance, { ...scope, id: instanceId, continuity_id: continuityId, predecessor_instance_id: null, instantiated_tick: 0, instantiated_ordinal: 0, inheritance_cutoff_tick: 0, inheritance_cutoff_ordinal: 0 });
      await clone("participants", "id", source, { ...scope, id: i ? `f6a_recipient_${suffix}` : recordId, character_instance_id: instanceId, speaking_order: i });
    }
  });
  const recipientId = `f6a_recipient_${suffix}`;
  // The actual application mapper, wrapped only to keep executeTurn's generic
  // planning fixture independent of M2 orchestration. No metadata is fabricated.
  const repo = createPostgresRuntimeRepository({ pool: runtime, workspaceId, mapFormalEvent: context => mapLocalFormalEvent(context as never) });
  const payload: FormalEventPayload = { schemaVersion: 1, role: "player", participantId: recordId, recipientId,
    speaker: recordId, content: recordId, segments: fallbackCompositeSemanticSegments(recordId, "dialogue") };
  const completed = await executeTurn({ recordId, expectedRecordVersion: 0, idempotencyKey: `f6a_write_${suffix}`, actorId: recordId,
    commandType: "player.utterance", payload: { runtimeScope: { sceneId, publicPolicyId: policyId, observerCharacterInstanceIds: [] } } }, {
    repository: repo, planner: { async plan() { return {}; } }, drafter: { async draft() { return {}; } }, validator: { async validate() { return {}; } },
    releaseBuilder: { async build() { return { formalEvents: [{ eventId: recordId, kind: "utterance.committed", payload }], outbox: [] }; } },
    idFactory: () => `f6a_turn_${randomUUID()}`, clock: () => new Date().toISOString(),
  }); assert.equal(completed.state, "completed");
  // Produce the source receipt through the real service/store, not SQL or
  // hand-written hashes. Event factors deliberately do not supply authority.
  const acceptedKey = `f6a_assessed_${suffix}`;
  const { result: accepted } = await executePerformanceAssessmentCommand(runtime, {
    ...createPerformanceCommandTrust({ workspaceId, worldId, worldlineId }, principalId),
    enablement: { schema: true, durableTransport: true },
  }, { recordId, policyVersion: "structured-factors:v1", evidenceEventIds: [recordId], idempotencyKey: acceptedKey });
  assert.equal(accepted.score, 10);
  const witness = await withWorkspaceTransaction(runtime, workspaceId, client => client.query(
    "SELECT command_id FROM performance_evidence_snapshots WHERE workspace_id=$1 AND assessment_id=$2", [workspaceId, accepted.assessmentId]));
  assert.deepEqual(witness.rows, [{ command_id: accepted.commandId }]);
  await withWorkspaceTransaction(owner, otherWorkspaceId, async client => {
    const world = (await owner.query("SELECT to_jsonb(w) AS body FROM worlds w WHERE workspace_id=$1 AND id=$2", [workspaceId, worldId])).rows[0].body;
    await client.query("INSERT INTO worlds SELECT (jsonb_populate_record(NULL::worlds,$1::jsonb)).*", [JSON.stringify({ ...world, workspace_id: otherWorkspaceId })]);
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [otherWorkspaceId, worldId, principalId]);
  });
  const consumer = { performanceWitnessesSchemaVersion: 1 as const };
  const reader = createPostgresRealmRuntimeSaveReader(runtime, consumer), restorer = createPostgresRealmRuntimeSaveRestorer(runtime, consumer);
  const load = (id = recordId, ws = workspaceId) => reader.load({ workspaceId: ws, recordId: id, principalId, purpose: "record-export" });
  return { owner, runtime, workspaceId, otherWorkspaceId, principalId, worldId, recordId, load, restorer, acceptedKey };
}
type Row = Record<string, unknown>;
const pack = (a: RealmRuntimeSaveArchive) => parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a));
const tables = ["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "committed_fact_commands", "performance_assessments", "record_goal_definitions", "goal_instances", "goal_assessments", "outbox", "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "character_assets", "member_relationship_revisions", "project_finance_command_groups", "projects", "project_milestones", "ledger_entries", "finance_accounts", "obligations", "obligation_settlements", "budget_allocations", "project_story_links", "story_node_instances", "story_unlock_ledger"];
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await f.owner.query(`SELECT count(*)::text AS n FROM ${table} WHERE workspace_id=ANY($1::text[]) AND world_id=$2`, [[f.workspaceId, f.otherWorkspaceId], f.worldId])).rows[0].n;
  return result;
}
for (const legacy of [false, true]) test(`F6a PG ${legacy ? "proven full legacy" : "modern producer"} full reader/ZIP/restore/service replay, two workspaces and three generations`, async t => {
  const f = await fixture(t), original = await f.load(); assert.ok(original);
  let archive = pack(original), workspaceId = f.otherWorkspaceId;
  if (legacy) {
    const c = archive.domain!.committedFactCommands.find(c => c.idempotencyKey === f.acceptedKey)!;
    const acceptedFingerprint = c.requestFingerprint;
    // Explicit historical archive projection only: retain the real producer's
    // persisted receipt/witness, but exercise the supported unmarked legacy body.
    delete archive.performanceWitnesses;
    delete (c.resultManifest as Row).performanceTransport;
    (c as unknown as Row).provenance = "legacy-result-v1"; (c as unknown as Row).request = null;
    // This fixture changes the outer archive body, never the accepted request fingerprint.
    archive.manifest = realmRuntimeSaveManifestFromData({ ...archive,
      engineApi: archive.manifest.engineApi, mode: archive.manifest.mode,
      world: archive.manifest.world, scope: archive.manifest.scope });
    archive = pack(archive);
    assert.equal(archive.domain!.committedFactCommands.find(c => c.idempotencyKey === f.acceptedKey)!.requestFingerprint, acceptedFingerprint);
  }
  const sourceHash = archive.domain!.committedFactCommands.find(c => c.idempotencyKey === f.acceptedKey)!.requestFingerprint;
  const sourceBefore = structuredClone(archive), sourceArchive = archive;
  for (let round = 0; round < 3; round++) {
    const input = { archive, workspaceId, principalId: f.principalId, targetWorldId: f.worldId, idempotencyKey: `f6a_restore_${round}_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId) };
    const restored = await f.restorer.restore(input), readback = await f.load(restored.recordId, workspaceId); assert.ok(readback);
    const c = readback.domain!.committedFactCommands.find(c => c.idempotencyKey === f.acceptedKey)!;
    const a = readback.domain!.performanceAssessments.find(a => a.commandId === c.id)!;
    const store = createPostgresCommittedFactCommandStore(f.runtime), scope = { workspaceId, worldId: f.worldId, worldlineId: readback.record.scope.worldlineId };
    const decoded = await store.loadCommand(scope, f.acceptedKey); assert.ok(decoded);
    assert.equal(decoded.result.commandId, c.id);
    if (legacy) { assert.equal(decoded.request, null); assert.equal(decoded.requestFingerprint, sourceHash); assert.ok(decoded.replayProof); }
    const before = await counts(f);
    const replay = await createCommittedFactCommandService({ store }).recordPerformanceAssessment({ scope, recordId: restored.recordId, policyVersion: a.policyVersion, evidenceEventIds: a.evidenceEventIds, idempotencyKey: f.acceptedKey });
    assert.equal(replay.status, "replayed"); assert.equal(replay.score, 10); assert.equal(replay.assessmentId, a.id); assert.equal(replay.evidenceSnapshotHash, a.evidenceSnapshotHash);
    assert.equal((await f.restorer.restore(input)).replayed, true); assert.deepEqual(await counts(f), before);
    const changed = structuredClone(archive); (changed.domain!.stories![0] as unknown as Row).title = "changed-body";
    await assert.rejects(f.restorer.restore({ ...input, archive: changed }), { code: "RESTORE_CONFLICT" }); assert.deepEqual(await counts(f), before);
    archive = pack(readback); workspaceId = round % 2 === 0 ? f.workspaceId : f.otherWorkspaceId;
  }
  assert.deepEqual(sourceArchive, sourceBefore);
});

test("F6a PG source inconsistencies: direct connect=0 and zero target rows", async t => {
  const f = await fixture(t), original = await f.load(); assert.ok(original);
  const mutators: [string, (a: RealmRuntimeSaveArchive) => void][] = [
    ["request fingerprint", a => { const c = a.domain!.committedFactCommands[0]; (c.request as Row).score = 11; }],
    ["result score", a => { (a.domain!.committedFactCommands[0].resultManifest as Row).score = 11; }],
    ["assessment score", a => { (a.domain!.performanceAssessments[0] as unknown as Row).score = 11; }],
    ["assessment policy", a => { (a.domain!.performanceAssessments[0] as unknown as Row).policyVersion = "unknown"; }],
    ["source hash", a => { (a.domain!.performanceAssessments[0] as unknown as Row).evidenceSnapshotHash = "0".repeat(64); }],
    ["command link", a => { const r = a.domain!.committedFactCommands[0].resultManifest as Row; r.commandId = "other"; r.assessmentId = "other:assessment"; }],
    ["missing assessment", a => { (a.domain as unknown as Row).performanceAssessments = []; }],
  ];
  const before = await counts(f);
  for (const [name, mutate] of mutators) {
    const archive = structuredClone(original); mutate(archive); let connected = 0;
    const restorer = createPostgresRealmRuntimeSaveRestorer({ async connect() { connected++; return f.runtime.connect(); } } as never, { performanceWitnessesSchemaVersion: 1 });
    await assert.rejects(restorer.restore({ archive, workspaceId: f.otherWorkspaceId, principalId: f.principalId, targetWorldId: f.worldId, idempotencyKey: `f6a_bad_${name}_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId) }), { code: "RUNTIME_SAVE_INVALID" });
    assert.equal(connected, 0, name); assert.deepEqual(await counts(f), before, name);
  }
  // No DELETE, trigger bypass or historical mutation: the disposable runner
  // owns destruction of both workspaces and the complete cluster.
});
