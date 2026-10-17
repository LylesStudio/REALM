import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGenesisDraft, sanitizeUntrustedGenesisDraft, settledGenesisView } from '../modules/application/world-genesis-contract.ts';
import { genesisDraftFingerprint } from '../modules/application/world-genesis.ts';
import { normalizeGenesisChatResponse, mergeDraftPatch, diffEditedGenesisFields, applyGenesisFieldEdits } from '../modules/application/genesis-chat-contract.ts';

const goal = { title: 'Reach the northern refuge', description: 'Find a safe route through the hills.',
  successConditions: ['Arrive at the northern refuge'], failureConditions: [], settlementConditions: [],
  changePolicy: 'evolving' as const, visible: true };
const input = { world: { name: 'Open roads' }, scene: { objective: 'Inspect the gate' }, recordGoals: [goal] };

test('genesis preserves authored Goals separately from scene intent and engine-owned packaged declarations', () => {
  const normalized = normalizeGenesisDraft(input)!;
  assert.deepEqual(normalized.recordGoals, [goal]);
  assert.equal(normalized.scene.objective, 'Inspect the gate');
  assert.equal(normalized.goals, undefined);
  const empty = normalizeGenesisDraft({ world: { name: 'Unbounded' } })!;
  assert.equal(empty.recordGoals, undefined, 'No Goal is a valid creation choice');
  assert.equal(normalizeGenesisDraft({ ...input, recordGoals: [] })!.recordGoals, undefined);
});

test('invalid policy, authority fields, excessive Goals and incomplete criteria reject the complete draft', () => {
  for (const recordGoals of [[{ ...goal, state: 'completed' }], [{ ...goal, goalInstanceId: 'forged' }],
    [{ ...goal, changePolicy: 'anything' }], [{ ...goal, successConditions: [] }], [{ ...goal, visible: null }],
    Array.from({ length: 9 }, () => goal), null, {}]) {
    assert.equal(normalizeGenesisDraft({ ...input, recordGoals }), null);
  }
});

test('settled and untrusted creation contexts retain valid authored criteria but not engine identities', () => {
  const raw = { ...input, goals: [{ goalKey: 'forged-content', policyVersion: 'forged' }], worldIdentity: { worldId: 'forged', worldVersion: '1.0.0' } };
  const sanitized = sanitizeUntrustedGenesisDraft(raw);
  assert.deepEqual(sanitized.recordGoals, [goal]);
  assert.deepEqual(settledGenesisView(raw)!.recordGoals, [goal]);
  assert.equal(sanitized.goals, undefined);
  assert.equal(sanitized.worldIdentity, undefined);
});

test('AI creation patches preserve authored criteria, support explicit clearing and reject forged Goal authority', () => {
  const base = normalizeGenesisDraft(input)!;
  const changed = { ...goal, changePolicy:'fixed' as const };
  for (const phase of ['exploring','proposing','ready'] as const) {
    const result = normalizeGenesisChatResponse({reply:'A different direction is available.',phase,draftPatch:{recordGoals:[changed]}},base);
    assert.deepEqual(result?.draftPatch?.recordGoals,[changed]);
    assert.deepEqual(mergeDraftPatch(base,result!.draftPatch)!.recordGoals,[changed]);
    assert.equal(normalizeGenesisChatResponse({reply:'Invalid state.',phase,draftPatch:{recordGoals:[{...goal,state:'completed'}]}},base),null);
  }
  const cleared = normalizeGenesisChatResponse({reply:'No initial Goal.',phase:'ready',draftPatch:{recordGoals:[]}},base)!;
  assert.deepEqual(cleared.draftPatch?.recordGoals,[]);
  assert.equal(mergeDraftPatch(base,cleared.draftPatch)!.recordGoals,undefined);
});

test('a delayed AI creation proposal cannot overwrite a manually changed or cleared Goal list', () => {
  const sent = normalizeGenesisDraft(input)!;
  const current = normalizeGenesisDraft({...input,recordGoals:[{...goal,changePolicy:'fixed'}]})!;
  const model = mergeDraftPatch(sent,{world:{era:'A changed era'},recordGoals:[{...goal,title:'A model direction'}]})!;
  const edited = diffEditedGenesisFields(sent,current);
  assert.ok(edited.includes('recordGoals'));
  assert.deepEqual(applyGenesisFieldEdits(model,current,edited).recordGoals,current.recordGoals);
  assert.equal(applyGenesisFieldEdits(model,current,edited).world.era,'A changed era');
  const cleared = normalizeGenesisDraft({...input,recordGoals:[]})!;
  assert.equal(applyGenesisFieldEdits(model,cleared,diffEditedGenesisFields(sent,cleared)).recordGoals,undefined);
  assert.equal(diffEditedGenesisFields(sent,normalizeGenesisDraft({...input})!).includes('recordGoals'),false);
});

test('creation identity includes Goal policy and criteria; absent and empty lists have the same identity', () => {
  const original = normalizeGenesisDraft(input)!;
  for (const patch of [{ changePolicy: 'fixed' }, { visible: false }, { successConditions: ['Receive a formal safe passage'] }, { description: 'Travel by another route' }]) {
    const changed = normalizeGenesisDraft({ ...input, recordGoals: [{ ...goal, ...patch }] })!;
    assert.notEqual(genesisDraftFingerprint(original), genesisDraftFingerprint(changed));
  }
  assert.equal(genesisDraftFingerprint(normalizeGenesisDraft({ world: { name: 'No Goal' } })!),
    genesisDraftFingerprint(normalizeGenesisDraft({ world: { name: 'No Goal' }, recordGoals: [] })!));
});
