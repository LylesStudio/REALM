/** Prepared only: F5d does not authorize PostgreSQL connections or execution. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo, withWorkspaceTransaction, createPostgresOutboxDeliveryRepository } from "../database/postgres/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { executeTurn } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";
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
  const suffix = randomUUID().replaceAll("-", ""), workspaceId = `f5d_ws_${suffix}`, otherWorkspaceId = `f5d_other_${suffix}`, principalId = `f5d_owner_${suffix}`;
  const required = (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort();
  const applied = (await owner.query<{ filename: string }>("SELECT filename FROM realm_schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.equal(required.length, 86); assert.deepEqual(required, EXPECTED_MIGRATIONS); assert.deepEqual(applied, required, "complete inherited migration chain, never a reduced fixture schema");
  await seedPostgresDemo(owner, { workspaceId, principalId }); await seedCapabilitySessionKey(owner, workspaceId);
  await seedPostgresDemo(owner, { workspaceId: otherWorkspaceId, principalId }); await seedCapabilitySessionKey(owner, otherWorkspaceId);
  const worldId = `f5d_world_${suffix}`, worldlineId = `f5d_line_${suffix}`, recordId = `f5d_record_${suffix}`, storyId = `f5d_story_${suffix}`, sceneId = `f5d_scene_${suffix}`, policyId = `f5d_policy_${suffix}`;
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
    await clone("visibility_policies", "policy_kind='public' AND record_id", POSTGRES_DEMO_IDS.record, { ...scope, id: policyId, policy_key: "f5d-public" });
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [workspaceId, worldId, principalId]);
  });
  const repo = createPostgresRuntimeRepository({ pool: runtime, workspaceId,
    mapFormalEvent: () => ({ sceneId, visibilityPolicyId: policyId, eventKind: "narration.committed", actorParticipantId: null, content: recordId }) });
  const completed = await executeTurn({ recordId, expectedRecordVersion: 0, idempotencyKey: `f5d-command-${suffix}`, actorId: null, commandType: "player.utterance", payload: {} }, {
    repository: repo, planner: { async plan() { return {}; } }, drafter: { async draft() { return {}; } }, validator: { async validate() { return {}; } },
    releaseBuilder: { async build() { return { formalEvents: [{ eventId: recordId, kind: "narration.committed", payload: { content: recordId } }], outbox: [{ messageId: `f5d_message_${suffix}`, topic: "record.events.committed", dedupeKey: `f5d_dedupe_${suffix}`, payload: { recordId, eventIds: [recordId], note: recordId, metadata: { recordId, eventIds: [recordId] } } }] }; } },
    idFactory: () => `f5d_turn_${randomUUID()}`, clock: () => new Date().toISOString(),
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


async function restored(t: test.TestContext) {
  const f = await fixture(t), archive = await f.load(); assert.ok(archive);
  const input = {workspaceId:f.workspaceId, principalId:f.principalId, targetWorldId:f.worldId,
    idempotencyKey:`f5d_restore_${randomUUID()}`,sessionProof:sessionProofFor(f.principalId),
    archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive))};
  const result=await f.restorer.restore(input);
  const stored=async()=>withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query("SELECT * FROM outbox WHERE workspace_id=$1 AND record_id=$2",[f.workspaceId,result.recordId]));
  const row=(await stored()).rows[0];assert.equal(row.restore_delivery_kind,"record-events-v1");
  const makeRepo=(mode:"disabled"|"record-events-v2"="record-events-v2",ws=f.workspaceId)=>createPostgresOutboxDeliveryRepository({pool:f.runtime,workspaceId:ws,topics:["record.events.committed"],restoreDelivery:mode,batchLimit:25});
  return {...f,input,result,row,stored,makeRepo};
}

test("F5d PG full chain restore classification, native exclusion, v2 delivery, stable fences and archive wire",async t=>{
  const f=await restored(t),now=new Date().toISOString(),leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  assert.equal(f.row.turn_run_id,null);assert.equal(f.row.revision,"0");assert.equal(f.row.attempt_count,0);
  assert.ok(!(await f.makeRepo("disabled").listOutboxMessages({now,limit:25})).some(m=>m.messageId===f.row.id));
  const repo=f.makeRepo();const candidates=await repo.listOutboxMessages({now,limit:25});const candidate=candidates.find(m=>m.messageId===f.row.id);assert.ok(candidate);assert.equal(candidate.origin,"record-events-restore-v1");
  // Inspect archive shape before delivery removes the row from export eligibility.
  const wire=await f.load(f.result.recordId);assert.ok(wire);assert.ok(!Object.hasOwn(wire.outbox!.messages[0],"restoreDeliveryKind"));assert.ok(!Object.hasOwn(wire.outbox!.messages[0],"restore_delivery_kind"));
  const c=await repo.claimOutbox({messageId:f.row.id,expectedRevision:0,leaseOwner:"f5d",now,leaseExpiresAt});assert.equal(c.turnId,null);assert.equal(c.attempts,1);
  await assert.rejects(repo.claimOutbox({messageId:f.row.id,expectedRevision:0,leaseOwner:"other",now,leaseExpiresAt}),{code:"TURN_REVISION_CONFLICT"});
  await assert.rejects(repo.settleOutbox({messageId:f.row.id,expectedRevision:1,leaseOwner:"other",now,outcome:"delivered"}),{code:"TURN_REVISION_CONFLICT"});
  const settled=await repo.settleOutbox({messageId:f.row.id,expectedRevision:1,leaseOwner:"f5d",now,outcome:"delivered"});assert.equal(settled.revision,2);assert.equal(settled.dedupeKey,f.row.dedupe_key);
  assert.equal((await f.restorer.restore(f.input)).replayed,true);assert.equal((await f.stored()).rowCount,1);
  const deliveredWire=await f.load(f.result.recordId);assert.ok(deliveredWire);assert.equal(deliveredWire.outbox?.messages.length ?? 0,0);
  const changed=structuredClone(f.input.archive);changed.outbox!.messages[0].envelope={...changed.outbox!.messages[0].envelope,literal:"different"};
  await assert.rejects(f.restorer.restore({...f.input,archive:changed}),{code:"RESTORE_CONFLICT"});
});

test("F5d PG runtime column privileges, FORCE RLS and outbox-only row lock use the existing role",async t=>{
  const f=await restored(t);
  const rights=await f.runtime.query<{role:string; insert_marker:boolean; delete_rows:boolean}>("SELECT current_user AS role, has_column_privilege(current_user,'public.outbox','restore_delivery_kind','INSERT') AS insert_marker, has_table_privilege(current_user,'public.outbox','DELETE') AS delete_rows");
  assert.equal(rights.rows[0].role,"realm_runtime");assert.equal(rights.rows[0].insert_marker,true);assert.equal(rights.rows[0].delete_rows,false);
  for(const column of ["state","revision","attempt_count","available_at","lease_owner","lease_expires_at","published_at","last_error_code","last_error_message","last_error_at","updated_at"]){
    const r=await f.runtime.query("SELECT has_column_privilege(current_user,'public.outbox',$1,'UPDATE') AS allowed",[column]);assert.equal(r.rows[0].allowed,true,column);
  }
  for(const column of ["restore_delivery_kind","payload","topic","turn_run_id","record_id","id","dedupe_key","workspace_id","world_id","worldline_id","event_id","command_group_id"]){
    const r=await f.runtime.query("SELECT has_column_privilege(current_user,'public.outbox',$1,'UPDATE') AS allowed",[column]);assert.equal(r.rows[0].allowed,false,column);
  }
  const rls=await f.owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.outbox'::regclass");assert.equal(rls.rows[0].relrowsecurity,true);assert.equal(rls.rows[0].relforcerowsecurity,true);
  await withWorkspaceTransaction(f.runtime,f.workspaceId,async c=>{
    const locked=await c.query("SELECT o.id FROM outbox AS o WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o",[f.workspaceId,f.row.id]);assert.equal(locked.rowCount,1);
  });
  assert.deepEqual(await f.makeRepo("record-events-v2",f.otherWorkspaceId).listOutboxMessages({now:new Date().toISOString(),limit:25}),[]);
  await assert.rejects(f.makeRepo("record-events-v2",f.otherWorkspaceId).claimOutbox({messageId:f.row.id,expectedRevision:0,leaseOwner:"foreign",now:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),{code:"OUTBOX_NOT_FOUND"});
});

test("F5d PG combined CHECK and composite FK reject invalid marker/turn/topic/scope",async t=>{
  const f=await restored(t);
  for(const [clause,value,code] of [["restore_delivery_kind","forged","23514"],["topic","custom","23514"],["turn_run_id","fake-turn","23514"],["worldline_id","foreign-line","23503"],["event_id","foreign-event","23503"]]){
    await assert.rejects(withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query(`UPDATE outbox SET ${clause}=$3 WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,f.row.id,value])),{code});
  }
  await assert.rejects(withWorkspaceTransaction(f.runtime,f.workspaceId,c=>c.query("UPDATE outbox SET restore_delivery_kind=NULL WHERE workspace_id=$1 AND id=$2",[f.workspaceId,f.row.id])),{code:"42501"});
  assert.equal((await f.stored()).rows[0].restore_delivery_kind,"record-events-v1");
});

test("F5d PG unmarked historical row stays dormant on same-key replay; custom remains literal",async t=>{
  const f=await restored(t);
  await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query("UPDATE outbox SET restore_delivery_kind=NULL WHERE workspace_id=$1 AND id=$2",[f.workspaceId,f.row.id]));
  assert.equal((await f.restorer.restore(f.input)).replayed,true);assert.equal((await f.stored()).rows[0].restore_delivery_kind,null);
  await assert.rejects(f.makeRepo().claimOutbox({messageId:f.row.id,expectedRevision:0,leaseOwner:"worker",now:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),{code:"OUTBOX_NOT_FOUND"});
  const archive=structuredClone(f.input.archive),body={origin:"record-events-restore-v1",restore_delivery_kind:"record-events-v1",recordId:"literal",__realmRuntimePayload:{eventIds:["literal"]}};
  archive.outbox!.messages[0].topic="custom";archive.outbox!.messages[0].envelope=body;
  const custom=await f.restorer.restore({...f.input,idempotencyKey:`custom_${randomUUID()}`,archive});
  const rows=await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query("SELECT payload,restore_delivery_kind FROM outbox WHERE workspace_id=$1 AND record_id=$2",[f.workspaceId,custom.recordId]));assert.deepEqual(rows.rows[0].payload,body);assert.equal(rows.rows[0].restore_delivery_kind,null);
});

test("F5d PG row lock contention, rollback and lease expiry retain stable identity across repository recreation",async t=>{
  const f=await restored(t),locker=await f.runtime.connect();
  // Release the checked-out client before fixture pool finalizers execute.
  try {
  await locker.query("BEGIN");await locker.query("SELECT set_config('realm.workspace_id',$1,true)",[f.workspaceId]);
  await locker.query("SELECT o.id FROM outbox AS o WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o",[f.workspaceId,f.row.id]);
  const contender=await f.runtime.connect();
  try{
    await contender.query("BEGIN");await contender.query("SELECT set_config('realm.workspace_id',$1,true)",[f.workspaceId]);await contender.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(contender.query("SELECT o.id FROM outbox AS o WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o",[f.workspaceId,f.row.id]),{code:"55P03"});
  }finally{await contender.query("ROLLBACK");contender.release();await locker.query("ROLLBACK");}
  const now=new Date().toISOString(),expired=new Date(Date.now()-1000).toISOString();
  await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query("UPDATE outbox SET state='delivering',revision=4,attempt_count=3,lease_owner='dead',lease_expires_at=$3 WHERE workspace_id=$1 AND id=$2",[f.workspaceId,f.row.id,expired]));
  const c=await f.makeRepo().claimOutbox({messageId:f.row.id,expectedRevision:4,leaseOwner:"restarted",now,leaseExpiresAt:new Date(Date.now()+60000).toISOString()});assert.equal(c.revision,5);assert.equal(c.attempts,4);assert.equal(c.dedupeKey,f.row.dedupe_key);
  await assert.rejects(f.makeRepo().settleOutbox({messageId:f.row.id,expectedRevision:4,leaseOwner:"dead",now,outcome:"delivered"}),{code:"TURN_REVISION_CONFLICT"});
  const s=await f.makeRepo().settleOutbox({messageId:f.row.id,expectedRevision:5,leaseOwner:"restarted",now,outcome:"delivered"});assert.equal(s.state,"delivered");
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
  }
});
