import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { installTestSessionSecret, sessionProofFor } from "./helpers/session-proof.ts";

installTestSessionSecret();

const options = { skip: !process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL, timeout: 120_000 };

test("R1 snapshot composition preserves export RO, native branch RW and caller workspace on success/failure", options, async () => {
  const pool = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const evidence: unknown[] = [];
  try {
    for (const isolation of ["read committed", "repeatable read", "serializable"] as const) {
      for (const readOnly of [false, true]) {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()} ${readOnly ? "READ ONLY" : "READ WRITE"}`);
        await client.query("SELECT set_config('realm.workspace_id', 'outer-r1', true)");
        for (const requestedReadOnly of [true, false]) {
          let entered = false;
          const run = () => withWorkspaceTransaction(client, "inner-r1", async (inner) => {
            entered = true;
            const result = await inner.query("SELECT current_setting('realm.workspace_id') AS workspace, current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, pg_backend_pid() AS backend");
            evidence.push(result.rows[0]);
            assert.equal(result.rows[0].workspace, "inner-r1");
          }, { isolationLevel: "repeatable read", readOnly: requestedReadOnly });
          if (isolation !== "read committed" && readOnly === requestedReadOnly) await run();
          else await assert.rejects(run, /provided transaction/);
          assert.equal(entered, isolation !== "read committed" && readOnly === requestedReadOnly);
          assert.equal((await client.query("SELECT current_setting('realm.workspace_id') AS workspace")).rows[0].workspace, "outer-r1");
        }
        await assert.rejects(withWorkspaceTransaction(client, "inner-r1", async () => {
          await client.query("SELECT 1 / 0");
        }), /division by zero/);
        assert.equal((await client.query("SELECT current_setting('realm.workspace_id') AS workspace")).rows[0].workspace, "outer-r1");
        await client.query("ROLLBACK");
      }
    }
    // SAVEPOINT outside a transaction fails; cleanup must preserve that error.
    await assert.rejects(withWorkspaceTransaction(client, "inner-r1", async () => assert.fail("must not enter")), /SAVEPOINT can only be used/);
  } finally {
    client.release();
  }
  try {
    for (const readOnly of [false, true]) {
      await withWorkspaceTransaction(pool, "owned-r1", async (inner) => {
        const result = await inner.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only");
        assert.deepEqual(result.rows[0], { isolation: "repeatable read", read_only: readOnly ? "on" : "off" });
        evidence.push(result.rows[0]);
      }, { isolationLevel: "repeatable read", readOnly });
    }
    await withWorkspaceTransaction(pool, "default-r1", async (inner) => {
      assert.deepEqual((await inner.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only")).rows[0], { isolation: "read committed", read_only: "off" });
    });
    console.log("R1 transaction modes", JSON.stringify(evidence));
  } finally {
    await pool.end();
  }
});

const groupBody = createHash("sha256").update("R1 detached body fixture").digest("hex");
const groupRaw = createHash("sha256").update("R1 wire fixture").digest("hex");
const workspace = POSTGRES_DEMO_IDS.workspace;
const world = POSTGRES_DEMO_IDS.world;
const principal = POSTGRES_DEMO_IDS.principal;

function groupFixture() {
  const token = randomUUID().replaceAll("-", "").slice(0, 24);
  const root = `record_restore_${token}`;
  const line = `worldline_restore_${token}`;
  const story = `story_restore_${token}`;
  const records = ["active", "archived"].map((status, index) => {
    const recordId = index ? `${root}_s0` : root;
    const definition = createRecordGoalDefinition({
      scope: { workspaceId: workspace, worldId: world, worldlineId: line, recordId },
      goalId: "r1-direction", activationHead: { recordVersion: 0, ordinal: 0 },
      draft: { title: "Preserve historical direction", description: "R1", successConditions: ["A formal outcome"], failureConditions: [], changePolicy: "fixed", visible: true },
    });
    return { sourceRecordId: `source-${index}`, recordId, storyId: story, status, definitions: [definition] };
  });
  const plan = { operation: "restore", worldlineId: line, stories: [{ sourceStoryId: "source-story", storyId: story }], records };
  return { root, line, story, plan };
}

type GroupFixture = ReturnType<typeof groupFixture>;
async function prepareGroup(client: PoolClient, fixture: GroupFixture, proof = sessionProofFor(principal)) {
  const result = await client.query<{ admitted: { actor: string; planCommitment: string } }>(
    "SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) AS admitted",
    [workspace, proof, world, fixture.root, groupRaw, groupBody, JSON.stringify(fixture.plan)],
  );
  assert.equal(result.rows[0]!.admitted.actor, principal);
  return result.rows[0]!.admitted.planCommitment;
}

async function createGroupTopology(client: PoolClient, fixture: GroupFixture, includeSibling = true) {
  await client.query("INSERT INTO worldlines(workspace_id,world_id,id,label) VALUES($1,$2,$3,'R1 group')", [workspace, world, fixture.line]);
  await client.query("INSERT INTO stories(workspace_id,world_id,worldline_id,id,title,premise,start_tick,start_ordinal) VALUES($1,$2,$3,$4,'R1 group',$5,0,0)",
    [workspace, world, fixture.line, fixture.story, `realm-save:body-v1:${groupBody}`]);
  for (const record of fixture.plan.records.slice(0, includeSibling ? 2 : 1)) {
    await client.query("INSERT INTO records(workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal) VALUES($1,$2,$3,$4,$5,'R1 history',$6,0,0)",
      [workspace, world, fixture.line, fixture.story, record.recordId, record.status]);
    await client.query("INSERT INTO record_heads(workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal) VALUES($1,$2,$3,$4,0,0)",
      [workspace, world, fixture.line, record.recordId]);
  }
}

async function materializeGroup(client: PoolClient, fixture: GroupFixture, planHash: string, body = groupBody) {
  for (const record of fixture.plan.records) {
    await client.query("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)",
      [workspace, sessionProofFor(principal), record.recordId, body, planHash, JSON.stringify(record.definitions)]);
  }
}

test("R1 grouped capability uses the runtime role and real proof, preserves archived history, and remains least privilege", options, async t => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtimePool = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  t.after(async () => { await runtimePool.end(); await owner.end(); });
  const fixture = groupFixture();
  await withWorkspaceTransaction(runtimePool, workspace, async client => {
    assert.equal((await client.query("SELECT current_user AS actor")).rows[0].actor, "realm_runtime");
    const planHash = await prepareGroup(client, fixture);
    await createGroupTopology(client, fixture);
    await materializeGroup(client, fixture, planHash);
  });
  assert.deepEqual((await owner.query("SELECT record.status,count(definition.id)::int AS definitions FROM records record JOIN record_goal_definitions definition ON definition.workspace_id=record.workspace_id AND definition.record_id=record.id WHERE record.workspace_id=$1 AND record.worldline_id=$2 GROUP BY record.status ORDER BY record.status", [workspace, fixture.line])).rows,
    [{ status: "active", definitions: 1 }, { status: "archived", definitions: 1 }]);
  for (const signature of ["record_goal_restore_group_prepare(text,text,text,text,text,text,jsonb)", "record_goal_restore_group_definitions(text,text,text,text,text,jsonb)", "record_goal_restore_branch_replay(text,text,text,text,text,text,text,bigint,bigint)"]) {
    const row = (await owner.query("SELECT p.prosecdef,owner.rolname,owner.rolcanlogin,owner.rolinherit,owner.rolbypassrls,has_function_privilege('realm_runtime',p.oid,'EXECUTE') AS runtime_execute,EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute,p.proconfig FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=$1::regprocedure", [signature])).rows[0];
    assert.deepEqual(row, { prosecdef: true, rolname: "realm_goal_authoring", rolcanlogin: false, rolinherit: false, rolbypassrls: false, runtime_execute: true, public_execute: false, proconfig: ["search_path=pg_catalog, public, pg_temp"] });
    console.log("R1 group catalog", signature, JSON.stringify(row));
  }
  for (const table of ["record_goal_definitions", "record_goal_commands", "record_goal_restore_admissions"]) {
    assert.equal((await owner.query("SELECT has_table_privilege('realm_runtime',$1,'INSERT') AS allowed", [table])).rows[0].allowed, false);
    await assert.rejects(withWorkspaceTransaction(runtimePool, workspace, client => client.query(`INSERT INTO ${table} DEFAULT VALUES`)), { code: "42501" });
  }
  await assert.rejects(withWorkspaceTransaction(runtimePool, workspace, client => prepareGroup(client, fixture)), /GOAL_RESTORE_PROOF_REQUIRED/);
});

test("R1 grouped capability rejects proof/body/plan/status/scope tampering and incomplete or late-failing groups atomically", options, async t => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtimePool = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  t.after(async () => { await runtimePool.end(); await owner.end(); });
  const negatives = ["forged-proof", "foreign-proof", "body", "plan", "status", "active-status", "missing-sibling", "missing-definitions", "cross-scope-definition", "late-failure"];
  await owner.query("INSERT INTO accounts(workspace_id,principal_id,display_name) VALUES($1,'principal_r1_nonowner','R1 nonowner') ON CONFLICT DO NOTHING", [workspace]);
  for (const negative of negatives) {
    const fixture = groupFixture();
    await assert.rejects(withWorkspaceTransaction(runtimePool, workspace, async client => {
      const planHash = await prepareGroup(client, fixture, negative === "forged-proof" ? "forged" : negative === "foreign-proof" ? sessionProofFor("principal_r1_nonowner") : sessionProofFor(principal));
      await createGroupTopology(client, fixture, negative !== "missing-sibling");
      if (negative === "active-status") await client.query("UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2", [workspace, fixture.root]);
      if (negative === "status") await client.query("UPDATE records SET status='active' WHERE workspace_id=$1 AND id=$2", [workspace, fixture.plan.records[1]!.recordId]);
      if (negative === "cross-scope-definition") fixture.plan.records[0]!.definitions[0] = createRecordGoalDefinition({ ...fixture.plan.records[0]!.definitions[0]!, scope: { workspaceId: workspace, worldId: world, worldlineId: fixture.line, recordId: fixture.plan.records[1]!.recordId } });
      if (negative !== "missing-definitions") await materializeGroup(client, fixture, negative === "plan" ? "0".repeat(64) : planHash, negative === "body" ? "0".repeat(64) : groupBody);
      if (negative === "late-failure") await client.query("SELECT 1/0");
    }), negative === "late-failure" ? /division by zero/
      : negative === "missing-definitions" ? /GOAL_DEFINITION_INVALID/
      : negative === "forged-proof" ? /CAPABILITY_/
      : negative === "foreign-proof" ? /PROPAGATION_SECURITY_UNAVAILABLE/
      : /GOAL_RESTORE_PROOF_REQUIRED/);
    const residue = (await owner.query("SELECT (SELECT count(*) FROM records WHERE workspace_id=$1 AND worldline_id=$2)::int AS records,(SELECT count(*) FROM record_goal_definitions WHERE workspace_id=$1 AND worldline_id=$2)::int AS definitions,(SELECT count(*) FROM record_goal_restore_admissions WHERE workspace_id=$1 AND worldline_id=$2)::int AS admissions,(SELECT count(*) FROM worldlines WHERE workspace_id=$1 AND id=$2)::int AS lines", [workspace, fixture.line])).rows[0];
    assert.deepEqual(residue, { records: 0, definitions: 0, admissions: 0, lines: 0 });
    console.log("R1 group rollback", negative, JSON.stringify(residue));
  }
});

async function nativeFixture(admin: pg.Pool) {
  const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `world_${randomUUID()}`,
    worldlineId: `worldline_${randomUUID()}`, recordId: `record_${randomUUID()}` };
  const storyId = `story_${randomUUID()}`;
  const sceneId = `scene_${randomUUID()}`;
  await withWorkspaceTransaction(admin, scope.workspaceId, async (client) => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      // All identifiers/predicates are test-owned literals; values stay bound.
      const inserted = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source) || $1::jsonb)).*
        FROM ${table} AS source WHERE workspace_id = $2 AND ${predicate} = $3 LIMIT 1`,
      [JSON.stringify(patch), scope.workspaceId, sourceId]);
      assert.equal(inserted.rowCount, 1, `fixture ${table}`);
    };
    await clone('worlds', 'id', POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: 'Goal command isolation' });
    const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
    await clone('worldlines', 'id', POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: 0, head_ordinal: 0 });
    await clone('stories', 'id', POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick:0,start_ordinal:0 });
    await clone('records', 'id', POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: 'active',start_tick:0,start_ordinal:0 });
    await clone('scenes', 'record_id', POSTGRES_DEMO_IDS.record, { ...scoped, id: sceneId,start_tick:0,start_ordinal:0 });
    await clone('visibility_policies', "policy_kind = 'public' AND record_id", POSTGRES_DEMO_IDS.record,
      { ...scoped, id: `policy_${randomUUID()}` });
    await client.query(`INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
      VALUES ($1,$2,$3,'owner')`, [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
    await client.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,
      participant_kind,principal_id,controller_mode) VALUES ($1,$2,$3,$4,$5,'narrator',$6,'human')`,
      [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,POSTGRES_DEMO_IDS.principal]);
    await clone('record_heads', 'record_id', POSTGRES_DEMO_IDS.record,
      { ...scoped, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
  });
  return scope;
}

test("R1 single Record memory projection and native archived sibling whole-closure restore remain distinct", options, async t => {
  const { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
  const { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } = await import("../modules/world-transfer/realm-runtime-save.ts");
  const { executeRecordGoalCommand } = await import("../modules/application/record-goal-command.ts");
  const { emptyNarrativeState, planNarrativeConsequence } = await import("../modules/application/narrative-situation.ts");
  const { loadRecordNarrativeState } = await import("../database/postgres/narrative-situation-repository.ts");
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  t.after(async () => { await (await import('../app/api/world-scope.ts')).endSharedRuntimePools(); await runtime.end(); await admin.end(); });
  const scope = await nativeFixture(admin);
  const sibling = { ...scope, recordId: `r1_sibling_${randomUUID()}` };
  const continuity = `r1_continuity_${randomUUID()}`;
  await withWorkspaceTransaction(admin, scope.workspaceId, async client => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      const result = await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), scope.workspaceId, sourceId]);
      assert.equal(result.rowCount, 1, table);
    };
    await clone("records", "id", scope.recordId, { id: sibling.recordId });
    for (const table of ["record_heads", "scenes", "visibility_policies", "participants"]) {
      await clone(table, "record_id", scope.recordId, { record_id: sibling.recordId, ...(table === "record_heads" ? {} : { id: `r1_${table}_${randomUUID()}` }) });
    }
    const definitionId = `r1_definition_${randomUUID()}`;
    await clone("character_definitions", "id", POSTGRES_DEMO_IDS.playerDefinition, { world_id: scope.worldId, id: definitionId });
    await clone("character_continuities", "id", POSTGRES_DEMO_IDS.playerContinuity, { world_id: scope.worldId, worldline_id: scope.worldlineId, id: continuity, definition_id: definitionId });
    for (const current of [scope, sibling]) {
      const instanceId = `r1_instance_${randomUUID()}`;
      await clone("character_instances", "id", POSTGRES_DEMO_IDS.playerInstance, { world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: current.recordId, id: instanceId, continuity_id: continuity, predecessor_instance_id: null });
      await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'character',$6,$7,'human')`, [scope.workspaceId,scope.worldId,scope.worldlineId,current.recordId,`r1_participant_${randomUUID()}`,instanceId,principal]);
      const observationId = `r1_observation_${current.recordId}`;
      await client.query(`INSERT INTO observations(workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,id,dedupe_key,observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,$5,$6,$6,'direct',$7,1,0,0,0,0)`, [scope.workspaceId,scope.worldId,scope.worldlineId,current.recordId,instanceId,observationId,current === scope ? "ROOT_FACT" : "PRIVATE_SIBLING_FACT"]);
      await client.query(`INSERT INTO memory_conclusions(workspace_id,world_id,worldline_id,observer_continuity_id,source_record_id,source_observation_id,id,observed_entity_key,memory_kind,content,semantic_embedding,embedding_model,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,$5,$6,$7,'r1','explicit',$8,$9::vector,'r1-test',0,0,0,0)`, [scope.workspaceId,scope.worldId,scope.worldlineId,continuity,current.recordId,observationId,`r1_memory_${current.recordId}`,current === scope ? "ROOT_FACT" : "PRIVATE_SIBLING_FACT",`[${new Array(384).fill(0).join(",")}]`]);
    }
    for (const items of [[], [`r1_memory_${scope.recordId}`, `r1_memory_${sibling.recordId}`]]) {
      await client.query(`INSERT INTO memory_snapshots(workspace_id,world_id,worldline_id,observer_continuity_id,id,snapshot_kind,content,item_ids,cursor_tick,cursor_ordinal,cache_epoch,token_count) VALUES($1,$2,$3,$4,$5,'recall','PRIVATE_SIBLING_FACT',$6,0,0,0,99)`, [scope.workspaceId,scope.worldId,scope.worldlineId,continuity,`r1_snapshot_${randomUUID()}`,items]);
    }
  });
  const goalDraft = { title: "Preserve this Record's formal direction", description: "R1", successConditions: ["Reach a formal result"], failureConditions: [], settlementConditions: [], changePolicy: "fixed", visible: true };
  for (const current of [scope, sibling]) {
    await executeRecordGoalCommand(runtime, { scope: current, principalId: principal, sessionProof: sessionProofFor(principal), idempotencyKey: "r1.native.create", command: { operation: "create", recordId: current.recordId, expectedHead: { recordVersion: 0, ordinal: 0 }, draft: goalDraft } });
    const eventId = `r1_narration_${randomUUID()}`;
    const state = planNarrativeConsequence({ scope: current, previous: emptyNarrativeState(), expectedRevision: 0, sourceEventId: eventId, observedHead: { recordVersion: 1, ordinal: 1 }, sourceRole: "narrator", turnKind: "player", committedEventIds: [], timeAdvanceAuthorized: false, proposal: { changes: [{ situationId: null, status: "active", fact: current === scope ? "Root formal situation" : "Private sibling formal situation", obstacle: null, unknowns: [], exitConditions: [], basisEventIds: [], playerActions: [] }], elapsedMinutes: 0 } });
    assert.ok(state);
    await withWorkspaceTransaction(admin, scope.workspaceId, async client => {
      const worldOrdinal = Number((await client.query("SELECT head_ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [scope.workspaceId,scope.worldlineId])).rows[0].head_ordinal) + 1;
      const event = await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).* FROM events source WHERE workspace_id=$2 AND record_id=$3 ORDER BY record_ordinal DESC LIMIT 1`, [JSON.stringify({ id: eventId, event_kind: "narration.committed", record_version: 2, record_ordinal: 2, world_ordinal: worldOrdinal, content: "Formal narrator fixture", actor_participant_id: null, payload: { __realmRuntimePayload: { role: "narrator", narrativeState: state } } }),scope.workspaceId,current.recordId]);
      assert.equal(event.rowCount, 1);
      await client.query("UPDATE record_heads SET record_version=2,next_record_ordinal=3,last_event_id=$3,last_world_ordinal=$4 WHERE workspace_id=$1 AND record_id=$2", [scope.workspaceId,current.recordId,eventId,worldOrdinal]);
      await client.query("UPDATE worldlines SET head_ordinal=$3 WHERE workspace_id=$1 AND id=$2", [scope.workspaceId,scope.worldlineId,worldOrdinal]);
    });
  }
  await admin.query("UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2", [scope.workspaceId,sibling.recordId]);
  await admin.query(`INSERT INTO relationship_states(workspace_id,world_id,worldline_id,observer_continuity_id,target_entity_key,relation_kind,content,fidelity,source_record_id,source_observation_id,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
    VALUES($1,$2,$3,$4,'c1_relationship','trust','Record-only relationship',1,$5,NULL,0,0,0,0)`,[scope.workspaceId,scope.worldId,scope.worldlineId,continuity,scope.recordId]);
  const reader = createPostgresRealmRuntimeSaveReader(runtime);
  const single = await reader.load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: principal, purpose: "record-export" });
  assert.ok(single);
  assert.equal(JSON.stringify(single).includes("PRIVATE_SIBLING_FACT"), false);
  assert.equal(single.memory?.conclusions.length, 1);
  assert.deepEqual(single.memory?.snapshots.map(row => row.content).sort(), ["ROOT_FACT"]);
  const parsedSingle = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(single));
  const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const restoreInput = { workspaceId: scope.workspaceId, targetWorldId: scope.worldId, principalId: principal, sessionProof: sessionProofFor(principal) };
  assert.equal(single.memory?.schemaVersion,2,'Record-only relationship requires the existing V2 representation');
  assert.deepEqual(single.memory?.relationshipStates.map(row=>[row.content,row.sourceRecordId,row.sourceObservationId]),[['Record-only relationship',scope.recordId,null]]);
  const projected = await restorer.restore({ ...restoreInput, archive: parsedSingle, idempotencyKey: "r1.projected.single" });
  const singleAgain=await reader.load({workspaceId:workspace,recordId:projected.recordId,principalId:principal,purpose:'record-export'});
  assert.ok(singleAgain);assert.equal(singleAgain.memory?.relationshipStates[0]?.sourceRecordId,projected.recordId);
  assert.equal(singleAgain.memory?.relationshipStates[0]?.sourceObservationId,null);
  assert.equal(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(singleAgain)).memory?.relationshipStates[0]?.content,'Record-only relationship');
  const premise=(await admin.query('SELECT premise FROM stories WHERE workspace_id=$1 AND id=(SELECT story_id FROM records WHERE workspace_id=$1 AND id=$2)',[workspace,scope.recordId])).rows[0].premise;
  const branchInput={...restoreInput,archive:parsedSingle,idempotencyKey:'c1.direct.branch',branch:{sourceRecordId:scope.recordId,sourceWorldlineId:scope.worldlineId,fork:{tick:0,ordinal:Number((parsedSingle.record.events.at(-1)!.payload as {worldOrdinal:number}).worldOrdinal)},label:'C1 direct branch',premise}};
  const first=await restorer.restore(branchInput);const exact=await restorer.restore(branchInput);
  assert.deepEqual({...exact,replayed:false},first,'direct exact replay preserves every durable result field');
  assert.equal((await admin.query("SELECT has_table_privilege('realm_runtime','record_goal_restore_admissions','SELECT') AS allowed")).rows[0].allowed,false);
  await assert.rejects(restorer.restore({...branchInput,sessionProof:'forged'}),/CAPABILITY_/);
  await assert.rejects(restorer.restore({...branchInput,branch:{...branchInput.branch,fork:{tick:0,ordinal:0}}}),/GOAL_BRANCH_PROOF_REQUIRED/);
  const changed=structuredClone(parsedSingle);changed.record.events[0]!.payload={...(changed.record.events[0]!.payload as object),content:'Changed validated body'};
  await assert.rejects(restorer.restore({...branchInput,archive:changed}),/GOAL_BRANCH_PROOF_REQUIRED/);
  const admittedBefore=(await admin.query('SELECT to_jsonb(admission) AS row FROM record_goal_restore_admissions admission WHERE workspace_id=$1 AND record_id=$2',[workspace,first.recordId])).rows;
  const otherActor=`principal_c1_${randomUUID()}`;
  await admin.query("INSERT INTO accounts(workspace_id,principal_id,display_name) VALUES($1,$2,$2)",[workspace,otherActor]);
  await admin.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",[workspace,scope.worldId,otherActor]);
  await assert.rejects(restorer.restore({...branchInput,principalId:otherActor,sessionProof:sessionProofFor(otherActor)}),/GOAL_BRANCH_PROOF_REQUIRED/);
  await assert.rejects(restorer.restore({...branchInput,principalId:otherActor}),{code:'RESTORE_CONFLICT'});
  await assert.rejects(restorer.restore({...branchInput,branch:{...branchInput.branch,sourceWorldlineId:'foreign_line'}}),{code:'RUNTIME_SAVE_INVALID'});
  await assert.rejects(restorer.restore({...branchInput,workspaceId:'c1_foreign_workspace'}),{code:'WORLD_NOT_FOUND'});
  const distinct=await restorer.restore({...branchInput,idempotencyKey:'c1.direct.branch.distinct'});
  assert.notEqual(distinct.recordId,first.recordId);assert.equal(distinct.replayed,false,'a distinct key creates its own fresh branch');
  assert.deepEqual((await admin.query('SELECT to_jsonb(admission) AS row FROM record_goal_restore_admissions admission WHERE workspace_id=$1 AND record_id=$2',[workspace,first.recordId])).rows,admittedBefore,'replay and refused inputs never change an old admission');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM record_goal_restore_admissions WHERE workspace_id=$1 AND record_id=$2',[workspace,scope.recordId])).rows[0].n,0,'source Record never receives imported authority');
  const {POST:branchPOST}=await import('../app/api/record/branch/route.ts');
  const httpBranch=await branchPOST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie:`realm_session=${sessionProofFor(principal)}`,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId,idempotencyKey:'c1.relationship.http.branch'})}));
  assert.equal(httpBranch.status,201,await httpBranch.clone().text());const httpTarget=await httpBranch.json();
  const branchHead=(await admin.query('SELECT head_tick::text,head_ordinal::text FROM worldlines WHERE workspace_id=$1 AND id=$2',[workspace,httpTarget.worldlineId])).rows[0];
  assert.deepEqual(branchHead,{head_tick:String(branchInput.branch.fork.tick),head_ordinal:String(branchInput.branch.fork.ordinal)},'projected relationship branch does not adopt a private sibling cursor');
  const branchSaved=await reader.load({workspaceId:workspace,recordId:first.recordId,principalId:principal,purpose:'record-export'});
  assert.ok(branchSaved);assert.equal(branchSaved.memory?.relationshipStates[0]?.sourceRecordId,first.recordId);
  assert.equal(branchSaved.memory?.relationshipStates[0]?.sourceObservationId,null);
  const previousOperators = process.env.REALM_OPERATOR_PRINCIPALS;
  process.env.REALM_OPERATOR_PRINCIPALS = principal;
  let whole;
  try { whole = await reader.load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: principal, purpose: "whole-closure-backup" }); }
  finally { if (previousOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previousOperators; }
  assert.ok(whole?.domain?.records);
  const archived = whole.domain.records.find(row => row.recordId === sibling.recordId);
  assert.ok(archived);
  assert.equal(archived.bundle.goals.definitions?.length, 1);
  assert.equal(whole.memory?.conclusions.length, 2);
  const sourceHistory = (await admin.query("SELECT id,definition FROM record_goal_definitions WHERE workspace_id=$1 AND worldline_id=$2 ORDER BY id", [scope.workspaceId,scope.worldlineId])).rows;
  const bytes = buildRealmRuntimeSaveArchive(whole);
  const parsed = parseRealmRuntimeSaveArchive(bytes);
  const target = await restorer.restore({ ...restoreInput, archive: parsed, idempotencyKey: "r1.native.closure" });
  const replay = await restorer.restore({ ...restoreInput, archive: parsed, idempotencyKey: "r1.native.closure" });
  assert.equal(replay.recordId, target.recordId);
  assert.equal(replay.replayed, true);
  const restored = (await admin.query("SELECT record.id,record.status,definition.definition FROM records record JOIN record_goal_definitions definition ON definition.workspace_id=record.workspace_id AND definition.record_id=record.id WHERE record.workspace_id=$1 AND record.worldline_id=$2 ORDER BY record.status", [scope.workspaceId,target.worldlineId])).rows;
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map(row => row.status), ["active", "archived"]);
  for (const row of restored) {
    assert.equal(row.definition.scope.recordId, row.id);
    assert.equal(row.definition.scope.worldlineId, target.worldlineId);
    assert.deepEqual(row.definition.draft, goalDraft);
    const state = await withWorkspaceTransaction(runtime, scope.workspaceId, client => loadRecordNarrativeState(client, { ...scope, worldlineId: target.worldlineId, recordId: row.id }));
    assert.equal(state.scope?.recordId, row.id);
    assert.equal(state.situations[0]?.fact, row.status === "active" ? "Root formal situation" : "Private sibling formal situation");
    if (row.status === "archived") await assert.rejects(executeRecordGoalCommand(runtime, { scope: { ...scope, worldlineId: target.worldlineId, recordId: row.id }, principalId: principal, sessionProof: sessionProofFor(principal), idempotencyKey: "r1.archived.denied", command: { operation: "create", recordId: row.id, expectedHead: { recordVersion: 2, ordinal: 2 }, draft: goalDraft } }), /GOAL_READ_ONLY/);
  }
  assert.deepEqual((await admin.query("SELECT id,definition FROM record_goal_definitions WHERE workspace_id=$1 AND worldline_id=$2 ORDER BY id", [scope.workspaceId,scope.worldlineId])).rows, sourceHistory);
  await admin.query(`INSERT INTO memory_conclusions(workspace_id,world_id,worldline_id,observer_continuity_id,id,observed_entity_key,memory_kind,content,semantic_embedding,embedding_model,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,$5,'r1','explicit','UNATTRIBUTED_FORMAL_FACT',$6::vector,'r1-test',0,0,0,0)`, [scope.workspaceId,scope.worldId,scope.worldlineId,continuity,`r1_unattributed_${randomUUID()}`,`[${new Array(384).fill(0).join(",")}]`]);
  await assert.rejects(reader.load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: principal, purpose: "record-export" }), /unsupported for unattributed formal state/);
  const {POST:savePOST}=await import('../app/api/record/save/route.ts');
  const refusal=await savePOST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie:`realm_session=${sessionProofFor(principal)}`,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId})}));
  assert.equal(refusal.status,422);assert.equal((await refusal.json()).error.code,'RUNTIME_SAVE_INVALID');
  console.log("R1 native closure", JSON.stringify({ archiveBytes: bytes.byteLength, sourceDefinitions: sourceHistory.length, targetRecords: restored.map(row => ({ id: row.id, status: row.status })), projectedConclusions: single.memory?.conclusions.length }));
});

test("R1 group capability cannot escape workspace, transaction, group or original narrow restore entry points", options, async t => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  t.after(async () => { await runtime.end(); await owner.end(); });
  const fixture = groupFixture();
  await assert.rejects(withWorkspaceTransaction(runtime, "r1_foreign_workspace", client => prepareGroup(client, fixture)), /GOAL_SCOPE_MISMATCH/);
  let planHash = "";
  // A committed empty-definition reservation proves the transaction boundary
  // independently of the materializer's existing-definition denial.
  for (const record of fixture.plan.records) record.definitions = [];
  await withWorkspaceTransaction(runtime, workspace, async client => {
    planHash = await prepareGroup(client, fixture);
    await createGroupTopology(client, fixture);
  });
  await assert.rejects(withWorkspaceTransaction(runtime, workspace, client => client.query("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,'[]'::jsonb)", [workspace,sessionProofFor(principal),fixture.root,groupBody,planHash])), /GOAL_RESTORE_PROOF_REQUIRED/);
  const other = groupFixture();
  await assert.rejects(withWorkspaceTransaction(runtime, workspace, async client => {
    await prepareGroup(client, other);
    await createGroupTopology(client, other);
    await materializeGroup(client, other, planHash);
  }), /GOAL_RESTORE_PROOF_REQUIRED/);
  const legacy = groupFixture();
  await assert.rejects(withWorkspaceTransaction(runtime, workspace, async client => {
    await prepareGroup(client, legacy);
    await createGroupTopology(client, legacy);
    await client.query("SELECT record_goal_restore_definitions($1,$2,$3,$4::jsonb)", [workspace,sessionProofFor(principal),legacy.root,JSON.stringify(legacy.plan.records[0]!.definitions)]);
  }), /GOAL_RESTORE_PROOF_REQUIRED/);
  for (const signature of ["record_goal_restore_group_check(text,text)", "guard_record_goal_restore_group()", "guard_record_goal_restore_member_status()"] ) {
    const row = (await owner.query("SELECT has_function_privilege('realm_runtime',$1,'EXECUTE') AS runtime_execute,EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) acl WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute", [signature])).rows[0];
    assert.deepEqual(row, { runtime_execute: false, public_execute: false });
  }
  const catalog = (await owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('record_goal_definitions'::regclass,'record_goal_commands'::regclass,'record_goal_restore_admissions'::regclass,'story_definition_bindings'::regclass) ORDER BY relname")).rows;
  assert.equal(catalog.length, 4);
  for (const row of catalog) assert.deepEqual({ rls: row.relrowsecurity, forced: row.relforcerowsecurity }, { rls: true, forced: true });
  const fk = (await owner.query("SELECT condeferrable,condeferred FROM pg_constraint WHERE conrelid='record_goal_restore_admissions'::regclass AND contype='f'")).rows;
  assert.ok(fk.some(row => row.condeferrable && row.condeferred));
  for (const candidate of [other, legacy]) {
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM worldlines WHERE workspace_id=$1 AND id=$2", [workspace,candidate.line])).rows[0].count, 0);
  }
  console.log("R1 scope/catalog", JSON.stringify({ tables: catalog, deferredForeignKeys: fk, oldTransactionRejected: true, crossGroupRejected: true, legacyEntryRejected: true }));
});

test("R1 grouped native branch rejects forged proof, stale head and altered source topology atomically", options, async t => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  t.after(async () => { await runtime.end(); await owner.end(); });
  const source = await nativeFixture(owner);
  const otherLine = `r1_other_parent_${randomUUID()}`;
  await owner.query("INSERT INTO worldlines(workspace_id,world_id,id,label) VALUES($1,$2,$3,'Other parent')", [workspace,source.worldId,otherLine]);
  for (const negative of ["proof", "head", "parent", "fork", "linked", "version", "premise", "archived"]) {
    const token = randomUUID().replaceAll("-", "").slice(0,18);
    const root = `record_branch_${token}`, line = `worldline_branch_${token}`, story = `story_branch_${token}`;
    const plan = { operation: "branch", worldlineId: line, source: { recordId: source.recordId, recordVersion: negative === "head" ? 1 : 0 }, stories: [{ sourceStoryId: "branch-source-story", storyId: story }], records: [{ sourceRecordId: source.recordId, recordId: root, storyId: story, status: "active", definitions: [] }] };
    if (negative === "archived") await owner.query("UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2", [workspace,source.recordId]);
    await assert.rejects(withWorkspaceTransaction(runtime, workspace, async client => {
      await client.query("SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb)", [workspace,negative === "proof" ? "forged" : sessionProofFor(principal),source.worldId,root,groupRaw,groupBody,JSON.stringify(plan)]);
      const origin = (await client.query("SELECT record.world_version,story.premise FROM records record JOIN stories story ON story.workspace_id=record.workspace_id AND story.id=record.story_id WHERE record.workspace_id=$1 AND record.id=$2", [workspace,source.recordId])).rows[0];
      await client.query("INSERT INTO worldlines(workspace_id,world_id,id,label,parent_worldline_id,fork_tick,fork_ordinal) VALUES($1,$2,$3,'R1 branch',$4,0,$5)", [workspace,source.worldId,line,negative === "parent" ? otherLine : source.worldlineId,negative === "fork" ? 1 : 0]);
      await client.query("INSERT INTO stories(workspace_id,world_id,worldline_id,id,title,premise,start_tick,start_ordinal) VALUES($1,$2,$3,$4,'R1 branch',$5,0,0)", [workspace,source.worldId,line,story,negative === "premise" ? "forged premise" : origin.premise]);
      await client.query("INSERT INTO records(workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,linked_record_id,world_version) VALUES($1,$2,$3,$4,$5,'R1 branch','active',0,0,'branch',$6,$7)", [workspace,source.worldId,line,story,root,negative === "linked" ? null : source.recordId,negative === "version" ? "forged-version" : origin.world_version]);
      await client.query("INSERT INTO record_heads(workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal) VALUES($1,$2,$3,$4,0,0)", [workspace,source.worldId,line,root]);
    }), negative === "proof" ? /CAPABILITY_/ : negative === "head" ? /GOAL_BRANCH_HEAD_CHANGED/ : /GOAL_BRANCH_PROOF_REQUIRED/);
    const counts = (await owner.query("SELECT (SELECT count(*)::int FROM record_goal_restore_admissions WHERE workspace_id=$1 AND record_id=$2) AS admissions,(SELECT count(*)::int FROM records WHERE workspace_id=$1 AND id=$2) AS records,(SELECT count(*)::int FROM worldlines WHERE workspace_id=$1 AND id=$3) AS lines", [workspace,root,line])).rows[0];
    assert.deepEqual(counts, { admissions: 0, records: 0, lines: 0 });
    console.log("R1 grouped branch rollback", negative, JSON.stringify(counts));
  }
});

// C1 D1: every assessment source and evidence reference is local even though
// other domain sections legitimately use shared cross-Record identity maps.
test("C1 native assessment isolation rejects every foreign Record direction before any write",options,async t=>{
  const {createPostgresRealmRuntimeSaveReader,createPostgresRealmRuntimeSaveRestorer}=await import("../database/postgres/realm-runtime-save-repository.ts");
  const {buildRealmRuntimeSaveArchive,parseRealmRuntimeSaveArchive,realmRuntimeSaveManifestFromData}=await import("../modules/world-transfer/realm-runtime-save.ts");
  const {executeRecordGoalCommand}=await import("../modules/application/record-goal-command.ts");
  const owner=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await owner.end();});const scope=await nativeFixture(owner);
  const ids=[scope.recordId,`record_c1_${randomUUID()}`,`record_c1_${randomUUID()}`];
  for(const id of ids.slice(1))for(const table of ["records","record_heads","scenes","visibility_policies","participants"]){
    const identity=table==="records"?{id}:{record_id:id,...(table==="record_heads"?{}:{id:`c1_${randomUUID()}`})};
    await owner.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${table==="records"?"id":"record_id"}=$3 LIMIT 1`,[JSON.stringify(identity),workspace,scope.recordId]);
  }
  for(const recordId of ids)await executeRecordGoalCommand(runtime,{scope:{...scope,recordId},principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:"c1.local.goal",command:{operation:"create",recordId,expectedHead:{recordVersion:0,ordinal:0},draft:{title:"Local evidence",description:"C1",successConditions:["Local outcome"],failureConditions:[],settlementConditions:[],changePolicy:"fixed",visible:true}}});
  const previous=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=principal;
  let archive;try{archive=await createPostgresRealmRuntimeSaveReader(runtime).load({workspaceId:workspace,recordId:scope.recordId,principalId:principal,purpose:"whole-closure-backup"});}
  finally{if(previous===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=previous;}
  assert.ok(archive?.domain?.records);const original=archive;
  const tables=(await owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped) ORDER BY c.relname`)).rows.map(row=>row.relname as string);
  async function image(){const rows:Record<string,unknown>={};for(const table of tables)rows[table]=(await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb) AS image FROM "${table}" row WHERE workspace_id=$1`,[workspace])).rows[0].image;return rows;}
  for(const [from,to,field] of [[0,1,"evidence"],[1,0,"evidence"],[1,2,"evidence"],[0,1,"source"]] as const){
    await t.test(`${from} to ${to} ${field}`,async()=>{
    const bad=structuredClone(original);const bundles=[bad,...bad.domain!.records!.map(row=>row.bundle)];
    const local=bundles.find(row=>row.record.scope.recordId===ids[from])!;const foreign=bundles.find(row=>row.record.scope.recordId===ids[to])!;
    const goal=local.goals.instances[0] as {id:string;policyVersion:string};
    local.goals.assessments=[{id:`c1_assessment_${from}_${to}`,goalInstanceId:goal.id,sourceEventId:field==="source"?foreign.record.events[0]!.eventId:local.record.events[0]!.eventId,source:"judge",status:"accepted",result:{},evidenceEventIds:[field==="evidence"?foreign.record.events[0]!.eventId:local.record.events[0]!.eventId],evidenceHead:{recordVersion:1,ordinal:1},evidenceSnapshotHash:"0".repeat(64),policyVersion:goal.policyVersion}];
    bad.manifest=realmRuntimeSaveManifestFromData({...bad,...bad.manifest});const parsed=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(bad));
    const before=await image();let writes=0;
    const observed=new Proxy(runtime,{get(pool,key){if(key==='connect')return async()=>{const client=await pool.connect();return new Proxy(client,{get(c,k){if(k==='query')return (...args:unknown[])=>{if(typeof args[0]==='string'&&(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/.test(args[0])||/record_goal_restore_group_prepare/.test(args[0])))writes++;return Reflect.apply(c.query,c,args);};const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v;}});};const value=Reflect.get(pool,key);return typeof value==='function'?value.bind(pool):value;}});
    await assert.rejects(createPostgresRealmRuntimeSaveRestorer(observed).restore({archive:parsed,workspaceId:workspace,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:`c1.foreign.${from}.${to}.${field}`}),{code:"RUNTIME_SAVE_INVALID"});
    assert.equal(writes,0,'foreign native assessment rejected before any topology write or admission');
    assert.deepEqual(await image(),before,'every scoped SQL row remains byte-equivalent on refusal');
    console.log("C1_NATIVE_LOCAL_REFUSAL",JSON.stringify({from,to,field,scopedTables:tables.length,zeroWrites:true}));
    });
  }
});

test("C1 grouped plan status remains final after early constraint consumption but later lifecycle is legal",options,async t=>{
  const owner=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await owner.end();});const f=groupFixture();
  await assert.rejects(withWorkspaceTransaction(runtime,workspace,async c=>{
    const hash=await prepareGroup(c,f);await createGroupTopology(c,f);await materializeGroup(c,f,hash);
    await c.query('SET CONSTRAINTS record_goal_restore_group_complete IMMEDIATE');
    await c.query("UPDATE records SET status='active' WHERE workspace_id=$1 AND id=$2",[workspace,f.plan.records[1]!.recordId]);
  }),/GOAL_RESTORE_PROOF_REQUIRED/);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM record_goal_restore_admissions WHERE workspace_id=$1 AND group_root=$2',[workspace,f.root])).rows[0].n,0);
  await withWorkspaceTransaction(runtime,workspace,async c=>{const hash=await prepareGroup(c,f);await createGroupTopology(c,f);await materializeGroup(c,f,hash);await c.query('SET CONSTRAINTS ALL IMMEDIATE');});
  for(const status of ['active','archived'])await withWorkspaceTransaction(runtime,workspace,c=>c.query('UPDATE records SET status=$3 WHERE workspace_id=$1 AND id=$2',[workspace,f.plan.records[1]!.recordId,status]));
  assert.equal((await owner.query('SELECT status FROM records WHERE workspace_id=$1 AND id=$2',[workspace,f.plan.records[1]!.recordId])).rows[0].status,'archived');
});

// C3: queued status checks must bind the actual row scope after early checks.
for(const timing of ['deferred','early-immediate','immediate-then-deferred','all-immediate'] as const) {
  for(const finalScope of ['unchanged','cleared','foreign','restored'] as const) {
    test(`C3 D7 final status ${timing} / ${finalScope}`,options,async t=>{
      const owner=new pg.Pool({connectionString:process.env.DATABASE_URL});
      const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
      t.after(async()=>{await runtime.end();await owner.end();});
      for(const mismatch of [false,true]) {
        const f=groupFixture();
        const run=()=>withWorkspaceTransaction(runtime,workspace,async c=>{
          assert.equal((await c.query('SELECT current_user AS role')).rows[0].role,'realm_runtime');
          const hash=await prepareGroup(c,f);await createGroupTopology(c,f);await materializeGroup(c,f,hash);
          if(timing!=='deferred')await c.query('SET CONSTRAINTS record_goal_restore_group_complete IMMEDIATE');
          if(timing==='all-immediate')await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          if(timing==='immediate-then-deferred')await c.query('SET CONSTRAINTS ALL DEFERRED');
          await c.query('UPDATE records SET status=$3 WHERE workspace_id=$1 AND id=$2',[workspace,f.plan.records[1]!.recordId,mismatch?'active':'archived']);
          if(finalScope!=='unchanged')await c.query("SELECT set_config('realm.workspace_id',$1,true)",[finalScope==='cleared'?'':'c3_unrelated_workspace']);
          if(finalScope==='restored')await c.query("SELECT set_config('realm.workspace_id',$1,true)",[workspace]);
          // Explicit firing also proves the trigger SET frame restores caller scope.
          if(!mismatch && timing==='all-immediate')assert.equal((await c.query("SELECT current_setting('realm.workspace_id') AS scope")).rows[0].scope,finalScope==='cleared'?'':finalScope==='foreign'?'c3_unrelated_workspace':workspace);
        });
        // Unconsumed admission events still require the original caller scope.
        const scopeRejected=!mismatch && timing==='deferred' && ['cleared','foreign'].includes(finalScope);
        if(mismatch||scopeRejected)await assert.rejects(run,/GOAL_RESTORE_PROOF_REQUIRED|GOAL_SCOPE_MISMATCH/);else await run();
        const counts=(await owner.query(`SELECT
          (SELECT count(*)::int FROM records WHERE workspace_id=$1 AND worldline_id=$2) AS records,
          (SELECT count(*)::int FROM worldlines WHERE workspace_id=$1 AND id=$2) AS lines,
          (SELECT count(*)::int FROM record_goal_definitions WHERE workspace_id=$1 AND worldline_id=$2) AS definitions,
          (SELECT count(*)::int FROM record_goal_restore_admissions WHERE workspace_id=$1 AND group_root=$3) AS admissions`,[workspace,f.line,f.root])).rows[0];
        assert.deepEqual(counts,mismatch||scopeRejected?{records:0,lines:0,definitions:0,admissions:0}:{records:2,lines:1,definitions:2,admissions:2});
        if(!mismatch&&!scopeRejected){
          const rows=(await owner.query(`SELECT r.id,r.status,a.target_status,a.group_plan->'records' AS plan
            FROM records r JOIN record_goal_restore_admissions a ON a.workspace_id=r.workspace_id AND a.record_id=r.id
            WHERE r.workspace_id=$1 AND a.group_root=$2 ORDER BY r.id`,[workspace,f.root])).rows;
          assert.equal(rows.length,2);for(const row of rows){assert.equal(row.status,row.target_status);assert.deepEqual(row.plan,f.plan.records);}
          await withWorkspaceTransaction(runtime,workspace,c=>c.query("UPDATE records SET status='active' WHERE workspace_id=$1 AND id=$2",[workspace,f.plan.records[1]!.recordId]));
          assert.equal((await owner.query('SELECT status FROM records WHERE workspace_id=$1 AND id=$2',[workspace,f.plan.records[1]!.recordId])).rows[0].status,'active');
        }
        console.log('C3_D7_FINAL',JSON.stringify({timing,finalScope,mismatch,counts}));
      }
    });
  }
}
