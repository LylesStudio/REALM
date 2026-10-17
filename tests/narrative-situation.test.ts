import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyNarrativeState, planNarrativeConsequence, decodeNarrativeState } from '../modules/application/narrative-situation.ts';

const scope={workspaceId:'ws',worldId:'world',worldlineId:'line',recordId:'record'};
const head={recordVersion:2,ordinal:2};
const proposal={changes:[{situationId:null,status:'active',fact:'The patrol blocks the exit.',obstacle:'Searchlight',
  unknowns:['Whether the patrol identified the boat'],exitConditions:['The patrol leaves'],basisEventIds:['opening'],
  playerActions:[]}],elapsedMinutes:0};
function plan(overrides:Record<string,unknown>={}) {
  return planNarrativeConsequence({scope,previous:emptyNarrativeState(),expectedRevision:0,sourceEventId:'narration-1',
    observedHead:head,sourceRole:'narrator',turnKind:'player',committedEventIds:['opening'],
    timeAdvanceAuthorized:false,proposal,...overrides} as Parameters<typeof planNarrativeConsequence>[0]);
}
test('narrative consequences work with no Goal and are canonically decodable',()=>{
  const next=plan()!;
  assert.equal(next.revision,1);
  assert.equal(next.situations.length,1);
  assert.equal(next.situations[0]!.status,'active');
  assert.deepEqual(decodeNarrativeState(JSON.parse(JSON.stringify(next))),next);
  assert.deepEqual(next.scope,scope);
});
test('resolving a situation keeps its identity/history and cannot revive the retired threat',()=>{
  const initial=plan()!;
  const situation=initial.situations[0]!;
  const resolved=plan({previous:initial,expectedRevision:1,sourceEventId:'narration-2',proposal:{changes:[{...proposal.changes[0],
    situationId:situation.id,status:'resolved',fact:'The patrol leaves beyond the breakwater.',obstacle:null,
    unknowns:[],basisEventIds:['opening']}],elapsedMinutes:0}})!;
  assert.equal(resolved.situations[0]!.id,situation.id);
  assert.equal(resolved.situations[0]!.originEventId,'narration-1');
  assert.equal(resolved.situations[0]!.lastEventId,'narration-2');
  assert.equal(resolved.situations[0]!.status,'resolved');
  assert.throws(()=>plan({previous:resolved,expectedRevision:2,sourceEventId:'narration-3',proposal:{...proposal,
    changes:[{...proposal.changes[0],situationId:situation.id}]}}),/NARRATIVE_SITUATION_RETIRED/);
});
test('NPC beliefs, presence and unselected player actions cannot change world facts',()=>{
  assert.throws(()=>plan({sourceRole:'character'}),/NARRATIVE_AUTHORITY_REQUIRED/);
  assert.throws(()=>plan({sourceRole:'player'}),/NARRATIVE_AUTHORITY_REQUIRED/);
  assert.throws(()=>plan({turnKind:'presence'}),/NARRATIVE_AUTHORITY_REQUIRED/);
  assert.throws(()=>plan({proposal:{...proposal,changes:[{...proposal.changes[0],playerActions:['Accept the offered mission']}]}}),/NARRATIVE_PLAYER_AGENCY/);
});
test('clock changes require an authorized player wait, never UI refresh or idle presence',()=>{
  const waiting={changes:[],elapsedMinutes:5};
  assert.throws(()=>plan({proposal:waiting}),/NARRATIVE_TIME_NOT_AUTHORIZED/);
  const result=plan({proposal:waiting,timeAdvanceAuthorized:true})!;
  assert.equal(result.elapsedMinutes,5);
  assert.throws(()=>plan({proposal:waiting,timeAdvanceAuthorized:true,turnKind:'presence'}),/NARRATIVE_AUTHORITY_REQUIRED/);
});
test('stale revisions, cross-scope snapshots and invented evidence fail closed',()=>{
  assert.throws(()=>plan({observedHead:{recordVersion:0,ordinal:-1}}),/NARRATIVE_PROPOSAL_INVALID/);
  const initial=plan()!;
  assert.throws(()=>plan({previous:initial,expectedRevision:0}),/NARRATIVE_WRITE_CONFLICT/);
  assert.throws(()=>plan({previous:initial,expectedRevision:1,scope:{...scope,recordId:'other'}}),/NARRATIVE_SCOPE_MISMATCH/);
  assert.throws(()=>plan({proposal:{...proposal,changes:[{...proposal.changes[0],basisEventIds:['invented']}]}}),/NARRATIVE_EVIDENCE_INVALID/);
  assert.throws(()=>plan({proposal:{...proposal,changes:[{...proposal.changes[0],balance:1000}]}}),/NARRATIVE_PROPOSAL_INVALID/);
});
test('an empty result is a no-op; repeating the same committed event is idempotent',()=>{
  assert.equal(plan({proposal:{changes:[],elapsedMinutes:0}}),null);
  const initial=plan()!;
  assert.deepEqual(plan({previous:initial,expectedRevision:1}),initial);
  assert.throws(()=>decodeNarrativeState({...initial,scope:{...scope,recordId:'different'}}),/NARRATIVE_STATE_INVALID/);
});
