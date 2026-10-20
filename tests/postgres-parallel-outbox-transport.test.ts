/** NOT_RUN in F5a. Syntax/types only; future authorized disposable PG execution. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { executeTurn, type JsonValue } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

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
  const suffix = randomUUID().replaceAll("-", ""), workspaceId = `f5a_ws_${suffix}`, otherWorkspaceId = `f5a_other_${suffix}`, principalId = `f5a_owner_${suffix}`;
  const required = (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort();
  const applied = (await owner.query<{ filename: string }>("SELECT filename FROM realm_schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.equal(required.length, 86); assert.deepEqual(required, EXPECTED_MIGRATIONS); assert.deepEqual(applied, required, "complete inherited migration chain, never a reduced fixture schema");
  await seedPostgresDemo(owner, { workspaceId, principalId }); await seedCapabilitySessionKey(owner, workspaceId);
  await seedPostgresDemo(owner, { workspaceId: otherWorkspaceId, principalId }); await seedCapabilitySessionKey(owner, otherWorkspaceId);
  const worldId = `f5a_world_${suffix}`, worldlineId = `f5a_line_${suffix}`, recordId = `f5a_record_${suffix}`, storyId = `f5a_story_${suffix}`, sceneId = `f5a_scene_${suffix}`, policyId = `f5a_policy_${suffix}`;
  await withWorkspaceTransaction(owner, workspaceId, async client => {
    const clone = async (table: string, predicate: string, source: string, patch: object) => {
      const r = await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), workspaceId, source]);
      assert.equal(r.rowCount, 1, `fixture ${table}`);
    };
    const scope = { world_id: worldId, worldline_id: worldlineId, record_id: recordId };
    await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: worldId, name: "F5a isolated transport" });
    await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: worldlineId, world_id: worldId, head_tick: 0, head_ordinal: 0, parent_worldline_id: null });
    await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scope, id: storyId, start_tick: 0, start_ordinal: 0 });
    await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scope, id: recordId, story_id: storyId, status: "active", start_tick: 0, start_ordinal: 0, linked_record_id: null });
    await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
    await clone("scenes", "record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: sceneId, start_tick: 0, start_ordinal: 0 });
    await clone("visibility_policies", "policy_kind='public' AND record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: policyId, policy_key: "f5a-public" });
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [workspaceId, worldId, principalId]);
  });
  const repo = createPostgresRuntimeRepository({ pool: runtime, workspaceId,
    mapFormalEvent: () => ({ sceneId, visibilityPolicyId: policyId, eventKind: "narration.committed", actorParticipantId: null, content: recordId }) });
  const completed = await executeTurn({ recordId, expectedRecordVersion: 0, idempotencyKey: `f5a-command-${suffix}`, actorId: null, commandType: "player.utterance", payload: {} }, {
    repository: repo, planner: { async plan() { return {}; } }, drafter: { async draft() { return {}; } }, validator: { async validate() { return {}; } },
    releaseBuilder: { async build() { return { formalEvents: [{ eventId: recordId, kind: "narration.committed", payload: { content: recordId } }], outbox: [{ messageId: `f5a_message_${suffix}`, topic: "record.events.committed", dedupeKey: `f5a_dedupe_${suffix}`, payload: { recordId, eventIds: [recordId], note: recordId, metadata: { recordId, eventIds: [recordId] } } }] }; } },
    idFactory: () => `f5a_turn_${randomUUID()}`, clock: () => new Date().toISOString(),
  });
  assert.equal(completed.state, "completed");
  const source = (await withWorkspaceTransaction(owner, workspaceId, c => c.query("SELECT payload FROM outbox WHERE workspace_id=$1 AND record_id=$2", [workspaceId, recordId]))).rows[0].payload;
  assert.deepEqual(source.__realmRuntimePayload, { recordId, eventIds: [recordId], note: recordId, metadata: { recordId, eventIds: [recordId] } });
  // Add genuine persisted delivery history and outer literal metadata; keep
  // the production writer's wrapper intact through reader/ZIP/parse.
  await withWorkspaceTransaction(owner, workspaceId, c => c.query(`UPDATE outbox SET event_id=$2,state='delivering',revision=9,attempt_count=4,
    available_at='2000-01-01T00:00:00Z',lease_owner='old-worker',lease_expires_at='2030-01-01T00:00:00Z',
    last_error_code='RETRY',last_error_message='old-error',last_error_at='2000-01-01T00:00:00Z',
    payload=payload||jsonb_build_object('metadata',jsonb_build_object('recordId',$2::text)) WHERE workspace_id=$1 AND record_id=$2`, [workspaceId, recordId]));
  const reader = createPostgresRealmRuntimeSaveReader(runtime), restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const load = (id = recordId, ws = workspaceId) => reader.load({ workspaceId: ws, recordId: id, principalId, purpose: "record-export" });
  return { owner, runtime, workspaceId, otherWorkspaceId, principalId, worldId, recordId, load, restorer };
}

test("F5a PG actual writer/reader/ZIP/parse/restorer, two successive transports, replay, fresh defaults and production decoder", async t => {
  const f = await fixture(t); let sourceRecordId = f.recordId;
  for (let round = 0; round < 2; round++) {
    const archive = await f.load(sourceRecordId); assert.ok(archive);
    assert.ok(archive.outbox!.messages[0].envelope.__realmRuntimePayload);
    const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive));
    const input = { workspaceId: f.workspaceId, principalId: f.principalId, targetWorldId: f.worldId, idempotencyKey: `f5a_restore_${round}_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId), archive: parsed };
    const before = Date.now(), restored = await f.restorer.restore(input), after = Date.now();
    const query = () => withWorkspaceTransaction(f.owner, f.workspaceId, c => c.query("SELECT * FROM outbox WHERE workspace_id=$1 AND record_id=$2", [f.workspaceId, restored.recordId]));
    const rows = await query(); assert.equal(rows.rowCount, 1); const row = rows.rows[0], body = row.payload.__realmRuntimePayload;
    const events = await withWorkspaceTransaction(f.owner, f.workspaceId, c => c.query("SELECT id FROM events WHERE workspace_id=$1 AND record_id=$2", [f.workspaceId, restored.recordId]));
    assert.equal(body.recordId, restored.recordId); assert.deepEqual(body.eventIds, [events.rows[0].id]); assert.notEqual(body.recordId, body.eventIds[0]);
    assert.equal(row.event_id, events.rows[0].id); assert.equal(row.record_id, restored.recordId);
    assert.equal(body.note, f.recordId); assert.deepEqual(body.metadata, { recordId: f.recordId, eventIds: [f.recordId] }); assert.deepEqual(row.payload.metadata, { recordId: f.recordId });
    assert.equal(row.state, "pending"); assert.equal(row.revision, "0"); assert.equal(row.attempt_count, 0); assert.equal(row.turn_run_id, null);
    for (const key of ["lease_owner", "lease_expires_at", "last_error_code", "last_error_message", "last_error_at"]) assert.equal(row[key], null);
    assert.ok(new Date(row.available_at).getTime() >= before && new Date(row.available_at).getTime() <= after);
    assert.equal(new Date(row.available_at).getTime(), new Date(row.created_at).getTime());
    assert.ok(row.dedupe_key.startsWith("restore:") && row.dedupe_key.endsWith(`:${parsed.outbox!.messages[0].dedupeKey}`));
    assert.equal((await f.restorer.restore(input)).replayed, true); assert.equal((await query()).rowCount, 1);
    const changed = structuredClone(parsed); changed.outbox!.messages[0].envelope = { ...changed.outbox!.messages[0].envelope, literal: "changed" };
    await assert.rejects(f.restorer.restore({ ...input, archive: changed }), { code: "RESTORE_CONFLICT" }); assert.equal((await query()).rowCount, 1);
    const consumer = createPostgresRuntimeRepository({ pool: f.runtime, workspaceId: f.workspaceId, mapFormalEvent() { throw new Error("consumer cannot author"); } });
    // Explicitly record the frozen discovery limitation. Direct claim below
    // verifies the decoder; it is not an automatic worker discovery claim.
    assert.ok(!(await consumer.listOutboxMessages()).some(m => m.recordId === restored.recordId));
    const decoded = await consumer.claimOutbox({ messageId: row.id, expectedRevision: 0, leaseOwner: `f5a_decoder_${round}`, now: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.deepEqual(decoded.payload, body as JsonValue); sourceRecordId = restored.recordId;
  }
});
test("F5a PG two-workspace reader/restore rejection leaves foreign workspace unchanged", async t => {
  const f = await fixture(t), archive = await f.load(); assert.ok(archive);
  assert.equal(await f.load(f.recordId, f.otherWorkspaceId), null);
  const count = () => withWorkspaceTransaction(f.owner, f.otherWorkspaceId, c => c.query<{ n: string }>("SELECT count(*)::text AS n FROM worldlines WHERE workspace_id=$1", [f.otherWorkspaceId]));
  const before = (await count()).rows[0].n;
  await assert.rejects(f.restorer.restore({ workspaceId: f.otherWorkspaceId, principalId: f.principalId, targetWorldId: f.worldId, archive: parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)), idempotencyKey: `f5a_foreign_${randomUUID()}`, sessionProof: sessionProofFor(f.principalId) }));
  assert.equal((await count()).rows[0].n, before);
});
