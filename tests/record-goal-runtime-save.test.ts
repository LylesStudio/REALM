import assert from 'node:assert/strict';
import test from 'node:test';
import * as authoring from '../modules/goals/record-authoring.ts';
import {createRecordGoalDefinition,planRecordGoalRevision} from '../modules/goals/record-authoring.ts';
import {serializeRealmRuntimeSaveGoalsV1,buildRealmRuntimeSaveArchive,parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData} from '../modules/world-transfer/realm-runtime-save.ts';
import type {RealmRuntimeSaveGoalsV1} from '../modules/world-transfer/realm-runtime-save.ts';

const scope={kind:'record' as const,workspaceId:'ws_save',worldId:'world_save',worldlineId:'line_save',recordId:'record_save'};
const definition=createRecordGoalDefinition({scope,goalId:'save.goal',activationHead:{recordVersion:0,ordinal:0},draft:{
  title:'Keep the original letter',description:'Deliver the original without replacing it.',changePolicy:'fixed',
  visible:true,successConditions:['The recipient receives the original letter.'],failureConditions:[],settlementConditions:[],
}});
const instance={id:definition.goalInstanceId,goalKey:definition.goalKey,policyVersion:definition.policyVersion,
  state:'active',revision:1,progress:{},outcome:null,definitionSource:'record',definitionId:definition.definitionId,
  resolutionKind:'natural',evidenceStartVersion:0,evidenceStartOrdinal:0};
const legacy={format:'realm-runtime-goals',schemaVersion:1,instances:[],assessments:[]} as const;
const native={...legacy,instances:[instance],definitions:[definition]};
const serialize=(value:unknown)=>serializeRealmRuntimeSaveGoalsV1(value as RealmRuntimeSaveGoalsV1);
function archive(value:unknown,recordId=scope.recordId) {
  const goals=value as RealmRuntimeSaveGoalsV1;
  const record={format:'realm-runtime-record' as const,schemaVersion:1 as const,
    scope:{worldId:scope.worldId,worldlineId:scope.worldlineId,recordId},
    head:{recordVersion:0,nextRecordOrdinal:0},events:[]};
  const manifest=realmRuntimeSaveManifestFromData({engineApi:'1.x',mode:'base',world:null,
    scope:{workspaceId:scope.workspaceId,worldlineId:scope.worldlineId,recordId},record,goals});
  return buildRealmRuntimeSaveArchive({manifest,record,goals});
}

test('authored Goal definitions survive the real ZIP archive and reject another Record scope',()=>{
  assert.deepEqual(parseRealmRuntimeSaveArchive(archive(native)).goals,native);
  assert.throws(()=>archive(native,'another_record'),/scope|binding/i);
});

test('rebasing Goal history changes scope identities and policy hashes without editing criteria, reasons or versions',()=>{
  const initial=createRecordGoalDefinition({scope,goalId:'evolving.save',activationHead:{recordVersion:0,ordinal:0},draft:{...definition.draft,changePolicy:'evolving'}});
  const next=planRecordGoalRevision({previous:initial,scope,instance:{goalInstanceId:initial.goalInstanceId,recordId:scope.recordId,state:'active',revision:1,progress:{},outcome:null},
    expectedDefinitionVersion:1,expectedInstanceRevision:1,nextDraft:{...initial.draft,title:'Find the recipient'},reason:'A preserved revision reason',
    evidenceEventIds:[],events:[],observedHead:{recordVersion:1,ordinal:1}}).definition;
  const target={...scope,worldlineId:'restored_line',recordId:'restored_record'};
  const fn=(authoring as unknown as {rebaseRecordGoalDefinitions:(input:{definitions:unknown[],scope:typeof target,eventIds:Map<string,string>})=>typeof initial[]}).rebaseRecordGoalDefinitions;
  const copied=fn({definitions:[next,initial],scope:target,eventIds:new Map()});
  assert.equal(copied.length,2);assert.equal(copied[1].supersedesDefinitionId,copied[0].definitionId);
  for(const [index,source] of [initial,next].entries()) {
    assert.notEqual(copied[index].definitionId,source.definitionId);assert.notEqual(copied[index].goalInstanceId,source.goalInstanceId);
    assert.notEqual(copied[index].policyVersion,source.policyVersion);assert.equal(copied[index].definitionVersion,source.definitionVersion);
    assert.deepEqual(copied[index].draft,source.draft);assert.equal(copied[index].changeReason,source.changeReason);
    assert.deepEqual(copied[index].activationHead,source.activationHead);
    assert.deepEqual(authoring.decodeRecordGoalDefinition(copied[index]),copied[index]);
  }
});

test('authored Goal save section preserves the immutable definition and native instance binding',()=>{
  assert.deepEqual(JSON.parse(serialize(native)),native);
});
test('legacy Goal save section stays byte-contract compatible without an invented definitions field',()=>{
  assert.deepEqual(JSON.parse(serialize(legacy)),legacy);
});
test('authored Goal save rejects missing definitions and terminal provenance downgrade',()=>{
  assert.throws(()=>serialize({...legacy,instances:[instance]}),/INVALID|definition|binding/i);
  assert.throws(()=>serialize({...native,instances:[{...instance,state:'active',resolutionKind:'withdrawn'}]}),/INVALID|resolution|binding/i);
});
test('authored Goal save rejects mismatched policy, activation and duplicate definitions',()=>{
  for(const patch of [{policyVersion:'wrong-policy'},{definitionId:'missing-definition'},{evidenceStartVersion:1}])
    assert.throws(()=>serialize({...native,instances:[{...instance,...patch}]}),/INVALID|definition|binding/i);
  assert.throws(()=>serialize({...native,definitions:[definition,definition]}),/INVALID|duplicate|definition/i);
});
