/** NOT_RUN in this batch. Only through the authorized disposable full-migration PG runner. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POSTGRES_DEMO_IDS, seedPostgresDemo, withWorkspaceTransaction } from '../database/postgres/public.ts';
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from '../database/postgres/realm-runtime-save-repository.ts';
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from '../modules/world-transfer/realm-runtime-save.ts';
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from './helpers/session-proof.ts';

function requireScratch(){assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith('realm'),'disposable runner required before any pool');assert.ok(process.env.DATABASE_URL&&process.env.REALM_RUNTIME_DATABASE_URL);}
async function fixture(t:test.TestContext,nonRoot=2,missingAnchor=false){
 requireScratch();installTestSessionSecret();
 const owner=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});t.after(()=>owner.end());
 const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:2});t.after(()=>runtime.end());
 // All fallible setup follows both registered pool finalizers. History is
 // retained for the disposable cluster's teardown; no application DELETE.
 const suffix=randomUUID().replaceAll('-',''),workspaceId=`f4c_ws_${suffix}`,otherWorkspaceId=`f4c_other_${suffix}`,principalId=`f4c_owner_${suffix}`;
 await seedPostgresDemo(owner,{workspaceId,principalId});await seedPostgresDemo(owner,{workspaceId:otherWorkspaceId,principalId});
 await seedCapabilitySessionKey(owner,workspaceId);await seedCapabilitySessionKey(owner,otherWorkspaceId);
 const migrationNames=(await owner.query<{filename:string}>('SELECT filename FROM realm_schema_migrations ORDER BY filename')).rows.map(r=>r.filename);
 assert.ok(migrationNames.includes('0078_bridge_command_write_authorization.sql'),'full inherited migration chain');
 const fk=(await owner.query<{condeferrable:boolean;condeferred:boolean}>("SELECT condeferrable,condeferred FROM pg_constraint WHERE conname='character_instances_predecessor_fk'")).rows;
 assert.ok(fk.length>0&&fk.every(r=>!r.condeferrable&&!r.condeferred),'real immediate predecessor FK');
 const worldId=`f4c_world_${suffix}`,worldlineId=`f4c_line_${suffix}`,storyId=`f4c_story_${suffix}`,definitionId=`f4c_def_${suffix}`,continuityId=`f4c_cont_${suffix}`;
 const recordId=(n:number)=>`f4c_record_${suffix}_${String(n).padStart(3,'0')}`,characterId=(n:number)=>`f4c_character_${suffix}_${String(n).padStart(3,'0')}`;
 await withWorkspaceTransaction(owner,workspaceId,async client=>{
  const clone=async(table:string,predicate:string,sourceId:string,patch:object)=>{
   const result=await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,[JSON.stringify(patch),workspaceId,sourceId]);assert.equal(result.rowCount,1,table);
  };
  await clone('worlds','id',POSTGRES_DEMO_IDS.world,{id:worldId,name:'F4c private fixture'});
  await clone('worldlines','id',POSTGRES_DEMO_IDS.worldline,{id:worldlineId,world_id:worldId,head_tick:0,head_ordinal:0});
  await clone('stories','id',POSTGRES_DEMO_IDS.story,{id:storyId,world_id:worldId,worldline_id:worldlineId,start_tick:0,start_ordinal:0});
  await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",[workspaceId,worldId,principalId]);
  for(let n=0;n<=nonRoot;n++){
   const scoped={world_id:worldId,worldline_id:worldlineId,record_id:recordId(n)};
   await clone('records','id',POSTGRES_DEMO_IDS.record,{...scoped,id:recordId(n),story_id:storyId,status:'active',start_tick:0,start_ordinal:0,linked_record_id:null});
   await clone('record_heads','record_id',POSTGRES_DEMO_IDS.record,{...scoped,record_version:0,next_record_ordinal:0,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
   await clone('scenes','record_id',POSTGRES_DEMO_IDS.record,{...scoped,id:`f4c_scene_${suffix}_${n}`,start_tick:0,start_ordinal:0});
   await clone('visibility_policies',"policy_kind='public' AND record_id",POSTGRES_DEMO_IDS.record,{...scoped,id:`f4c_policy_${suffix}_${n}`,policy_key:`f4c_public_${n}`});
  }
  await client.query("INSERT INTO character_definitions(workspace_id,world_id,id,display_name,source_format,profile) VALUES($1,$2,$3,'F4c','native','{}'::jsonb)",[workspaceId,worldId,definitionId]);
  await client.query("INSERT INTO character_continuities(workspace_id,world_id,worldline_id,definition_id,id,continuity_key,status,born_tick,born_ordinal) VALUES($1,$2,$3,$4,$5,$5,'active',0,0)",[workspaceId,worldId,worldlineId,definitionId,continuityId]);
  // The actual immediate FK requires parent-first INSERT in fixture setup;
  // saved Record order will still be child -> middle -> parent.
  for(let n=nonRoot;n>=0;n--){
   const parent=n===nonRoot?null:characterId(n+1);
   await client.query(`INSERT INTO character_instances(workspace_id,world_id,worldline_id,record_id,continuity_id,predecessor_instance_id,id,controller_mode,status,instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ai','present',0,0,0,0,$8::jsonb)`,[workspaceId,worldId,worldlineId,recordId(n),continuityId,parent,characterId(n),JSON.stringify({literalParent:parent})]);
   if(!(missingAnchor&&n===1))await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode,is_active,speaking_order)
    VALUES($1,$2,$3,$4,$5,'character',$6,NULL,'ai',true,0)`,[workspaceId,worldId,worldlineId,recordId(n),`f4c_part_${suffix}_${n}`,characterId(n)]);
  }
 });
 const old=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=principalId;t.after(()=>{if(old===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=old;});
 const reader=createPostgresRealmRuntimeSaveReader(runtime),restorer=createPostgresRealmRuntimeSaveRestorer(runtime);
 const load=(id=recordId(0),ws=workspaceId)=>reader.load({workspaceId:ws,recordId:id,principalId,purpose:'whole-closure-backup'});
 return {owner,runtime,workspaceId,otherWorkspaceId,worldId,worldlineId,principalId,recordId,characterId,load,restorer};
}
async function consumeFile(payloadPath:string){
 requireScratch();installTestSessionSecret();
 const payload=JSON.parse(await readFile(payloadPath,'utf8')) as {path:string;workspaceId:string;worldId:string;principalId:string};
 const pool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:1});
 try{
  const archive=parseRealmRuntimeSaveArchive(new Uint8Array(await readFile(payload.path)));
  const restored=await createPostgresRealmRuntimeSaveRestorer(pool).restore({workspaceId:payload.workspaceId,principalId:payload.principalId,targetWorldId:payload.worldId,archive,idempotencyKey:`f4c_child_${randomUUID()}`,sessionProof:sessionProofFor(payload.principalId)});
  process.stdout.write(JSON.stringify({pid:process.pid,recordId:restored.recordId,worldlineId:restored.worldlineId,carried:restored.importedDomainRecordCount})+'\n');
 }finally{await pool.end();}
}
function child(payloadPath:string):Promise<{pid:number;carried:number}>{return new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,['--experimental-strip-types',fileURLToPath(import.meta.url),'--character-consumer',payloadPath],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';
 p.stdout.on('data',data=>{out+=String(data);});p.stderr.on('data',data=>{err+=String(data);});p.on('error',reject);
 p.on('exit',code=>{if(code!==0){reject(new Error(`F4c consumer exited ${code}; stderr bytes=${Buffer.byteLength(err)}`));return;}try{resolve(JSON.parse(out.trim()));}catch(e){reject(e);}});
});}
if(process.argv.includes('--character-consumer')){
 await consumeFile(process.argv.at(-1)!);
}else{
 test('F4c PG whole reader/true ZIP/immediate-FK restore twice and fresh-process consumer',async t=>{
  const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'realm-character-closure-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let source=f.recordId(0),lastPath='';
  for(let run=0;run<2;run++){
   const a=await f.load(source);assert.ok(a);const bytes=buildRealmRuntimeSaveArchive(a);assert.equal(parseRealmRuntimeSaveArchive(bytes).domain!.records!.length,2);
   lastPath=join(directory,`round-${run}.realm`);await writeFile(lastPath,bytes);
   const restored=await f.restorer.restore({workspaceId:f.workspaceId,principalId:f.principalId,targetWorldId:f.worldId,archive:parseRealmRuntimeSaveArchive(bytes),idempotencyKey:`f4c_round_${run}_${randomUUID()}`,sessionProof:sessionProofFor(f.principalId)});
   const rows=await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query<{id:string;predecessor_instance_id:string|null;continuity_id:string}>('SELECT id,predecessor_instance_id,continuity_id FROM character_instances WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3',[f.workspaceId,f.worldId,restored.worldlineId]));
   assert.equal(rows.rows.length,3);assert.equal(rows.rows.filter(r=>r.predecessor_instance_id===null).length,1);
   for(const r of rows.rows)if(r.predecessor_instance_id!==null)assert.ok(rows.rows.some(p=>p.id===r.predecessor_instance_id&&p.continuity_id===r.continuity_id));
   source=restored.recordId;
  }
  const payload=join(directory,'consume.json');await writeFile(payload,JSON.stringify({path:lastPath,workspaceId:f.workspaceId,worldId:f.worldId,principalId:f.principalId}));
  const consumed=await child(payload);assert.notEqual(consumed.pid,process.pid);assert.equal(consumed.carried,2);
 });
 test('F4c PG single-Record ordinary/native refuse cross-Record predecessor and two-workspace reader refuses foreign source',async t=>{
  const f=await fixture(t);for(const purpose of ['record-export','native-record-branch'] as const)await assert.rejects(createPostgresRealmRuntimeSaveReader(f.runtime).load({workspaceId:f.workspaceId,recordId:f.recordId(0),principalId:f.principalId,purpose,...(purpose==='native-record-branch'?{sessionProof:sessionProofFor(f.principalId)}:{})}),{code:'RUNTIME_SAVE_INVALID'});
  assert.equal(await f.load(f.recordId(0),f.otherWorkspaceId),null);
  const a=await f.load();assert.ok(a);await assert.rejects(createPostgresRealmRuntimeSaveRestorer(f.runtime).restore({workspaceId:f.otherWorkspaceId,principalId:f.principalId,targetWorldId:f.worldId,archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)),idempotencyKey:`foreign_${randomUUID()}`,sessionProof:sessionProofFor(f.principalId)}));
 });
 test('F4c PG missing parent participant anchor is rejected before successful archive',async t=>{const f=await fixture(t,2,true);await assert.rejects(f.load(),{code:'RUNTIME_SAVE_INVALID'});});
 for(const count of [64,65])test(`F4c PG ${count} non-root capacity and immutable history teardown`,async t=>{
  const f=await fixture(t,count);if(count===65)await assert.rejects(f.load(),{code:'RUNTIME_SAVE_INVALID'});else{const a=await f.load();assert.ok(a);assert.equal(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)).domain!.records!.length,64);}
 });
 test('F4c PG broken archive rejects with zero new worldlines and immediate source FK refuses missing parent',async t=>{
  const f=await fixture(t),a=await f.load();assert.ok(a);
  const before=await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query<{n:string}>('SELECT count(*)::text AS n FROM worldlines WHERE workspace_id=$1 AND world_id=$2',[f.workspaceId,f.worldId]));
  const parsed=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)),p=parsed.topology!.participants[0]!;
  const broken={...parsed,topology:{...parsed.topology!,participants:[{...p,character:{...p.character!,sourcePredecessorInstanceId:'absent-parent'}}]}};
  await assert.rejects(f.restorer.restore({workspaceId:f.workspaceId,principalId:f.principalId,targetWorldId:f.worldId,archive:broken,idempotencyKey:`broken_${randomUUID()}`,sessionProof:sessionProofFor(f.principalId)}),{code:'RUNTIME_SAVE_INVALID'});
  const after=await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query<{n:string}>('SELECT count(*)::text AS n FROM worldlines WHERE workspace_id=$1 AND world_id=$2',[f.workspaceId,f.worldId]));assert.equal(after.rows[0]!.n,before.rows[0]!.n);
  await assert.rejects(withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query('UPDATE character_instances SET predecessor_instance_id=$3 WHERE workspace_id=$1 AND id=$2',[f.workspaceId,f.characterId(0),'absent-parent'])),(e:unknown)=>e instanceof Error&&'code' in e&&e.code==='23503');
 });
 test('F4c PG actual owner/operator permission controls are not bypassed by proof',async t=>{
  const f=await fixture(t);delete process.env.REALM_OPERATOR_PRINCIPALS;await assert.rejects(f.load(),{code:'BACKUP_FORBIDDEN'});
  process.env.REALM_OPERATOR_PRINCIPALS=f.principalId;
  await withWorkspaceTransaction(f.owner,f.workspaceId,c=>c.query("UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",[f.workspaceId,f.worldId,f.principalId]));
  assert.equal(await f.load(),null);
 });
}
