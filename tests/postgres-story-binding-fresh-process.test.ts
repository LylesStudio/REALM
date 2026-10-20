import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POSTGRES_DEMO_IDS, createPostgresRealmRuntimeSaveReader, createPostgresStoryGraphRepository } from "../database/postgres/public.ts";
import { normalizeStoryDefinition, storyDefinitionHashFor, storyRecordIdFor, type StoryDefinition } from "../modules/story-graph/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { POST as restoreRoutePOST } from "../app/api/record/restore/route.ts";
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

const CHILD_SCRIPT = fileURLToPath(
  new URL("./helpers/story-binding-fresh-process-child.ts", import.meta.url),
);

function pools() {
  const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
  owner.on("error", () => {});
  runtime.on("error", () => {});
  return { owner, runtime };
}

function definitionFor(suffix: string, milestoneId: string): StoryDefinition {
  return normalizeStoryDefinition({
    storyKey: `story.freshproc.${suffix}`,
    title: "Fresh-process story",
    premise: "F1c fresh-process rehearsal.",
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

interface CommandChildResult {
  pid: number;
  failed?: boolean;
  mode?: string;
  commandStatus?: number;
  commandWorldlineId?: string | null;
  storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] | null;
}

interface SaveChildResult {
  pid: number;
  failed?: boolean;
  mode?: string;
  saveStatus?: number;
  save?: {
    definitionHash: string | null;
    sourceBinding: { workspaceId: string; storyId: string; definitionHash: string } | null;
    encoreState: string | null;
  } | null;
}

interface RestoreRouteResult {
  ok: true;
  replayed: boolean;
  worldlineId: string;
  storyId: string;
  recordId: string;
}

async function runChild<R extends { pid: number; failed?: boolean }>(
  payloadPath: string,
  operator = true,
): Promise<{ status: number | null; result: R }> {
  return await new Promise((resolve, reject) => {
    const environment={...process.env};
    if(operator)environment.REALM_OPERATOR_PRINCIPALS=PRINCIPAL;else delete environment.REALM_OPERATOR_PRINCIPALS;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", CHILD_SCRIPT, payloadPath],
      {
        // Runner env carries DATABASE_URL/REALM_RUNTIME_DATABASE_URL/
        // REALM_SESSION_SECRET; the child inherits them verbatim and they
        // are never written to the payload or the logs.
        // Test-only explicit backup policy; never supplied through the payload.
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {}); // swallowed: may carry driver detail, never asserted on
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve({ status: code, result: JSON.parse(line) as R });
      } catch {
        reject(new Error(`fresh-process child emitted no parseable status (exit ${code})`));
      }
    });
  });
}

test(
  "a fresh Node process pair continues the restored Story through the real routes and preserves the original source binding",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const { owner, runtime } = pools();
    const scratchDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), `f1c-fresh-${suffix}-`));
    t.after(async () => {
      // Artifacts stay confined to the runner TMPDIR and are always cleaned.
      await rm(scratchDir, { recursive: true, force: true });
      await endSharedRuntimePools();
      await runtime.end();
      await owner.end();
    });

    const worldId = `world_fresh_${suffix}`;
    const worldlineId = `wl_fresh_${suffix}`;
    const storyId = `story_fresh_${suffix}`;
    const milestoneId = `mile_fresh_${suffix}`;
    const projectId = `proj_fresh_${suffix}`;
    await owner.query(
      `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
       VALUES ($1, $2, 'Fresh-process rehearsal', 'active', 'native_calendar', '{}'::jsonb)`,
      [WS, worldId],
    );
    await owner.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'Fresh line', 'active', 0, 0)`,
      [WS, worldId, worldlineId],
    );
    await owner.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [WS, worldId, PRINCIPAL],
    );
    await owner.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, 'Fresh-process story', 'active', 'F1c rehearsal.', 0, 0)`,
      [WS, worldId, worldlineId, storyId],
    );
    await owner.query(
      `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
       VALUES ($1, $2, $3, $4, 'production', 'active', 'funding', 'Fresh production', 'JPY', NULL, NULL, 1)`,
      [WS, worldId, worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [WS, worldId, worldlineId, `link_fresh_${suffix}`, projectId, storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'Encore gate', 'planned', NULL, NULL, NULL)`,
      [WS, worldId, worldlineId, milestoneId, projectId],
    );

    const definition = definitionFor(suffix, milestoneId);
    const sourceHash = storyDefinitionHashFor(definition);
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    await storyGraph.materialize({ workspaceId: WS, storyId, definition });
    const recordId = storyRecordIdFor(
      { workspaceId: WS, worldId, worldlineId, storyId },
      "opening",
    );
    await owner.query(
      `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $5, 'Opening scene', 'active', 0, 0)`,
      [WS, worldId, worldlineId, recordId, `scene_fresh_${suffix}`],
    );
    await owner.query(
      `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
       VALUES ($1, $2, $3, $4, $5, 'opening', 1, 'public')`,
      [WS, worldId, worldlineId, recordId, `policy_fresh_${suffix}`],
    );
    await owner.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id, participant_kind,
         character_instance_id, principal_id, controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, $6, 'human', true, 0)`,
      [WS, worldId, worldlineId, recordId, `part_fresh_${suffix}`, PRINCIPAL],
    );

    // Parent: save through the production reader, then restore through the
    // REAL authenticated restore POST handler (formal POST-handler
    // acceptance — no listening HTTP server is started). Every archive
    // entry round-trips through buildRealmRuntimeSaveArchive.
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive?.domain);
    const restoreViaRoute = async (
      candidate: RealmRuntimeSaveArchive,
      key: string,
    ): Promise<RestoreRouteResult> => {
      const response = await restoreRoutePOST(new Request("http://localhost/api/record/restore", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.realm.save+zip",
          "idempotency-key": key,
          "x-realm-target-world": worldId,
          cookie: `realm_session=${createSessionValue(PRINCIPAL)}`,
        },
        body: Buffer.from(buildRealmRuntimeSaveArchive(candidate)),
      }));
      const body = await response.json() as RestoreRouteResult & { error?: { code?: string } };
      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.ok, true);
      return body;
    };
    const restored = await restoreViaRoute(archive, `fresh-restore-${suffix}`);
    assert.equal(restored.replayed, false);

    const restoredMilestone = await owner.query<{ id: string; project_id: string }>(
      `SELECT id, project_id FROM project_milestones
       WHERE workspace_id = $1 AND worldline_id = $2 AND title = 'Encore gate'`,
      [WS, restored.worldlineId],
    );
    const restoredProject = await owner.query<{ version: string }>(
      `SELECT version::text FROM projects
       WHERE workspace_id = $1 AND worldline_id = $2 AND id = $3`,
      [WS, restored.worldlineId, restoredMilestone.rows[0]!.project_id],
    );

    // Exit every route pool in the parent before the fresh processes start.
    await endSharedRuntimePools();

    // REAL fresh Node process #1 (typed mode "command"): different PID, no
    // shared JS memory. It unlocks the milestone-gated node on the restored
    // worldline through the real command route with the persisted
    // definition only, closes its pools, and exits.
    const commandPayloadPath = join(scratchDir, "payload-command.json");
    await writeFile(commandPayloadPath, JSON.stringify({
      mode: "command",
      principalId: PRINCIPAL,
      worldId,
      worldlineId: restored.worldlineId,
      projectId: restoredMilestone.rows[0]!.project_id,
      milestoneId: restoredMilestone.rows[0]!.id,
      expectedProjectVersion: Number(restoredProject.rows[0]!.version),
      idempotencyKey: `fresh-encore-${suffix}`,
    } satisfies Record<string, unknown>));
    const commandRun = await runChild<CommandChildResult>(commandPayloadPath);
    assert.equal(commandRun.status, 0, "command child must exit cleanly (its pools close before exit)");
    assert.ok(!commandRun.result.failed, "command child reported a route failure");
    assert.equal(commandRun.result.mode, "command", "command child ran the typed command mode");
    assert.notEqual(commandRun.result.pid, process.pid, "the command ran in a genuinely different process");
    assert.ok(commandRun.result.pid > 0);
    assert.equal(commandRun.result.commandStatus, 200);
    assert.equal(commandRun.result.commandWorldlineId, restored.worldlineId);
    assert.equal(commandRun.result.storyUnlocks?.length, 1);
    assert.equal(commandRun.result.storyUnlocks?.[0]?.storyId, restored.storyId);
    assert.equal(commandRun.result.storyUnlocks?.[0]?.nodeKey, "encore");
    assert.ok(commandRun.result.storyUnlocks?.[0]?.recordId);

    // The command child has fully exited and closed its pools: the target
    // unlock is committed and visible to an independent connection BEFORE
    // the second process starts.
    const unlocked = await owner.query<{ state: string }>(
      `SELECT state FROM story_node_instances
       WHERE workspace_id = $1 AND story_id = $2 AND node_key = 'encore'`,
      [WS, restored.storyId],
    );
    assert.deepEqual(unlocked.rows, [{ state: "active" }],
      "the target unlock persisted after the command process exited");

    // REAL fresh Node process #2 (typed mode "save"): a SECOND independent
    // process carrying only { recordId } — the server derives the binding
    // from the database inside that process, with no shared definition or
    // Map from the parent or the command child.
    const savePayloadPath = join(scratchDir, "payload-save.json");
    const artifactPath = join(scratchDir, "child-archive.bin");
    await writeFile(savePayloadPath, JSON.stringify({
      mode: "save",
      principalId: PRINCIPAL,
      recordId: restored.recordId,
      artifactPath,
    } satisfies Record<string, unknown>));
    const saveRun = await runChild<SaveChildResult>(savePayloadPath);
    assert.equal(saveRun.status, 0, "save child must exit cleanly");
    assert.ok(!saveRun.result.failed, "save child reported a route failure");
    assert.equal(saveRun.result.mode, "save", "save child ran the typed save mode");
    assert.ok(saveRun.result.pid > 0);
    assert.notEqual(saveRun.result.pid, process.pid);
    assert.notEqual(saveRun.result.pid, commandRun.result.pid,
      "command and save ran as TWO truly independent sequential Node processes");

    // The save child's ordinary save (recordId only) carried the ORIGINAL
    // source binding and the unlocked node state.
    assert.equal(saveRun.result.saveStatus, 200);
    assert.deepEqual(saveRun.result.save?.sourceBinding, {
      workspaceId: WS,
      storyId,
      definitionHash: sourceHash,
    });
    assert.equal(saveRun.result.save?.encoreState, "active");

    // The parent parses the child-emitted archive artifact and restores it
    // through the REAL restore POST handler again: the ORIGINAL source
    // binding survives the two-fresh-process cycle.
    const artifactBytes = new Uint8Array(await readFile(artifactPath));
    const reparsed = parseRealmRuntimeSaveArchive(artifactBytes);
    assert.deepEqual(reparsed.domain?.storyDefinitions?.[0]?.sourceBinding, {
      workspaceId: WS,
      storyId,
      definitionHash: sourceHash,
    });
    const secondRestore = await restoreViaRoute(reparsed, `fresh-restore-${suffix}-second`);
    assert.equal(secondRestore.replayed, false);
    const origin = await owner.query<{
      source_workspace_id: string;
      source_story_id: string;
      source_definition_hash: string;
    }>(
      `SELECT source_workspace_id, source_story_id, source_definition_hash
       FROM story_definition_bindings
       WHERE workspace_id = $1 AND worldline_id = $2 AND story_id = $3`,
      [WS, secondRestore.worldlineId, secondRestore.storyId],
    );
    assert.deepEqual(origin.rows, [{
      source_workspace_id: WS,
      source_story_id: storyId,
      source_definition_hash: sourceHash,
    }], "restore of the fresh-process archive must preserve the ORIGINAL source binding");

    // The unlocked node persisted with target identities.
    const node = await owner.query<{ state: string }>(
      `SELECT state FROM story_node_instances
       WHERE workspace_id = $1 AND story_id = $2 AND node_key = 'encore'`,
      [WS, restored.storyId],
    );
    assert.deepEqual(node.rows, [{ state: "active" }]);
  },
);



test("C1 ordinary bound Story restores and branches into fresh-process command continuation without definitions or operator",{
  skip:!adminConnectionString||!runtimeConnectionString?skipReason:false,timeout:120_000,
},async t=>{
  const owner=new pg.Pool({connectionString:adminConnectionString});const runtime=new pg.Pool({connectionString:runtimeConnectionString});
  t.after(async()=>{await endSharedRuntimePools();await runtime.end();await owner.end();});
  const {sessionProofFor}=await import('./helpers/session-proof.ts');
  const {executeRecordGoalCommand}=await import('../modules/application/record-goal-command.ts');
  const {POST:branchPOST}=await import('../app/api/record/branch/route.ts');
  const {commandAuthoritySnapshot}=await import('./helpers/native-legacy-replay.ts');
  const scope={workspaceId:WS,worldId:`world_${randomUUID()}`,worldlineId:`worldline_${randomUUID()}`};const storyId=`story_${randomUUID()}`;
  async function clone(table:string,predicate:string,source:string,patch:object){const result=await owner.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,[JSON.stringify(patch),WS,source]);assert.equal(result.rowCount,1,table);}
  await clone('worlds','id',POSTGRES_DEMO_IDS.world,{id:scope.worldId});
  await clone('worldlines','id',POSTGRES_DEMO_IDS.worldline,{id:scope.worldlineId,world_id:scope.worldId,head_tick:0,head_ordinal:0});
  await clone('stories','id',POSTGRES_DEMO_IDS.story,{id:storyId,world_id:scope.worldId,worldline_id:scope.worldlineId,start_tick:0,start_ordinal:0});
  await owner.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')`,[WS,scope.worldId,PRINCIPAL]);
  const definition=normalizeStoryDefinition({storyKey:`c1.ordinary.${randomUUID()}`,title:'Persisted ordinary Story',premise:'Native bound opening',policyVersion:'story-graph-v1',nodes:[{kind:'record',nodeKey:'opening',recordKey:'opening',title:'Opening',sequence:1,initial:true}]});
  await createPostgresStoryGraphRepository(runtime).materialize({workspaceId:WS,storyId,definition});
  const recordId=storyRecordIdFor({...scope,storyId},'opening');
  const scoped={workspace_id:WS,world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:recordId};
  for(const table of ['scenes','visibility_policies'])await clone(table,'record_id',POSTGRES_DEMO_IDS.record,{...scoped,id:`c1_${randomUUID()}`});
  await owner.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'narrator',$6,'human')`,[WS,scope.worldId,scope.worldlineId,recordId,`narrator_${randomUUID()}`,PRINCIPAL]);
  const definitionId=`character_${randomUUID()}`,continuityId=`continuity_${randomUUID()}`,instanceId=`instance_${randomUUID()}`,assetId=`asset_${randomUUID()}`;
  await clone('character_definitions','id',POSTGRES_DEMO_IDS.playerDefinition,{world_id:scope.worldId,id:definitionId});
  await clone('character_continuities','id',POSTGRES_DEMO_IDS.playerContinuity,{world_id:scope.worldId,worldline_id:scope.worldlineId,id:continuityId,definition_id:definitionId});
  await clone('character_instances','id',POSTGRES_DEMO_IDS.playerInstance,{...scoped,id:instanceId,continuity_id:continuityId,predecessor_instance_id:null});
  await clone('asset_definitions','id',POSTGRES_DEMO_IDS.signalLanternAsset,{world_id:scope.worldId,id:assetId});
  await owner.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'character',$6,$7,'human')`,[WS,scope.worldId,scope.worldlineId,recordId,`participant_${randomUUID()}`,instanceId,PRINCIPAL]);
  await executeRecordGoalCommand(runtime,{scope:{...scope,recordId},principalId:PRINCIPAL,sessionProof:sessionProofFor(PRINCIPAL),idempotencyKey:'c1.story.goal',command:{operation:'create',recordId,expectedHead:{recordVersion:0,ordinal:0},draft:{title:'Continue bound Story',description:'C1',successConditions:['Local continuation'],failureConditions:[],settlementConditions:[],changePolicy:'fixed',visible:true}}});
  const before=await commandAuthoritySnapshot(owner,scope);
  const bindingsBefore=(await owner.query('SELECT to_jsonb(binding) AS row FROM story_definition_bindings binding WHERE workspace_id=$1 AND story_id=$2',[WS,storyId])).rows;
  const scratch=await mkdtemp(join(process.env.REALM_R1_EVIDENCE_DIR??process.env.TMPDIR??tmpdir(),'c1-ordinary-story-'));
  if(!process.env.REALM_R1_EVIDENCE_DIR)t.after(()=>rm(scratch,{recursive:true,force:true}));
  let serial=0;const pids:number[]=[];
  async function child<R extends {pid:number;failed?:boolean}>(payload:object){const file=join(scratch,`payload-${serial++}.json`);await writeFile(file,JSON.stringify(payload));const run=await runChild<R>(file,false);assert.equal(run.status,0);assert.equal(run.result.failed,undefined);assert.notEqual(run.result.pid,process.pid);pids.push(run.result.pid);return run.result;}
  const sourcePath=join(scratch,'source.realm');
  const sourceSaved=await child<{pid:number;saveStatus:number}>({mode:'ordinary-save',principalId:PRINCIPAL,recordId,artifactPath:sourcePath});assert.equal(sourceSaved.saveStatus,200);
  const sourceArchive=parseRealmRuntimeSaveArchive(await readFile(sourcePath));assert.equal(sourceArchive.domain?.records?.length,0);assert.equal(sourceArchive.domain?.storyDefinitions?.length,1);
  const imported=await child<{pid:number;restoreStatus:number;target:{worldlineId:string;storyId:string;recordId:string}}>({mode:'ordinary-restore',principalId:PRINCIPAL,worldId:scope.worldId,artifactPath:sourcePath,idempotencyKey:'c1.story.restore'});assert.equal(imported.restoreStatus,201);
  const branchResponse=await branchPOST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{'content-type':'application/json',cookie:`realm_session=${sessionProofFor(PRINCIPAL)}`},body:JSON.stringify({recordId,idempotencyKey:'c1.story.branch'})}));assert.equal(branchResponse.status,201,await branchResponse.clone().text());
  const branch=await branchResponse.json();
  for(const target of [imported.target,branch]){
    const actor=(await owner.query(`SELECT participant.character_instance_id FROM participants participant WHERE workspace_id=$1 AND record_id=$2 AND participant_kind='character'`,[WS,target.recordId])).rows[0].character_instance_id;
    const event=(await owner.query('SELECT id FROM events WHERE workspace_id=$1 AND record_id=$2 ORDER BY record_ordinal LIMIT 1',[WS,target.recordId])).rows[0].id;
    const continued=await child<{pid:number;commandStatus:number;command:{data:{status:string};meta:{storyContinuation?:unknown}}}>({mode:'ordinary-continue',principalId:PRINCIPAL,worldId:scope.worldId,worldlineId:target.worldlineId,recordId:target.recordId,characterInstanceId:actor,assetDefinitionId:assetId,sourceEventId:event,idempotencyKey:'c1.story.new.fact'});
    assert.equal(continued.commandStatus,200);assert.equal(continued.command.data.status,'committed');
    const path=join(scratch,`${target.recordId}.realm`);const saved=await child<{pid:number;saveStatus:number;save:{sourceBinding:unknown}}>({mode:'ordinary-save',principalId:PRINCIPAL,recordId:target.recordId,artifactPath:path});assert.equal(saved.saveStatus,200);
    assert.deepEqual(saved.save.sourceBinding,{workspaceId:WS,storyId,definitionHash:storyDefinitionHashFor(definition)});
    const resaved=parseRealmRuntimeSaveArchive(await readFile(path));assert.equal(resaved.domain?.storyNodes[0]?.recordId,target.recordId);assert.equal(resaved.domain?.committedFactCommands.length,1);assert.equal(resaved.domain?.records?.length,0);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM story_definition_bindings WHERE workspace_id=$1 AND story_id=$2',[WS,target.storyId])).rows[0].n,1);
  }
  assert.equal(new Set(pids).size,pids.length,'each handler stage executes in a distinct fresh Node process');
  assert.deepEqual(await commandAuthoritySnapshot(owner,scope),before);assert.deepEqual((await owner.query('SELECT to_jsonb(binding) AS row FROM story_definition_bindings binding WHERE workspace_id=$1 AND story_id=$2',[WS,storyId])).rows,bindingsBefore);
  console.log('C1_ORDINARY_STORY_FRESH',JSON.stringify({pids,sourceRecord:recordId,restored:imported.target.recordId,branched:branch.recordId,definitionsInjected:false,operator:false}));
});

}
