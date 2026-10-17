import assert from "node:assert/strict";
import test from "node:test";
import * as evolution from "../modules/goals/model-evolution.ts";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import type { ModelChatRequest, ModelGateway } from "../modules/inference/public.ts";
import type { GoalAssessmentContext, ClaimedGoalAssessmentJob } from "../modules/goals/assessment-worker.ts";

const scope = { workspaceId: "workspace", worldId: "world", worldlineId: "line", recordId: "record" };
const draft = { title: "Deliver the letter", description: "Reach the original harbor for delivery.",
  successConditions: ["The intended recipient receives the letter"], failureConditions: [], settlementConditions: [],
  changePolicy: "evolving" as const, visible: true };
const definition = createRecordGoalDefinition({ scope, goalId: "delivery", draft, activationHead: { recordVersion: 1, ordinal: 1 } });
const context: GoalAssessmentContext = { instance: { goalInstanceId: definition.goalInstanceId, recordId: scope.recordId,
  state: "active", revision: 1, progress: {}, outcome: null },
  head: { recordVersion: 2, ordinal: 2 }, events: [{ eventId: "harbor-closed", recordId: scope.recordId,
    recordVersion: 2, ordinal: 2, kind: "narration.committed", payload: { text: "The original harbor is permanently closed." } }] };
const job: ClaimedGoalAssessmentJob = { ...scope, worldVersion: "0.0.0-local", goalInstanceId: definition.goalInstanceId,
  goalKey: definition.goalKey, sourceEventId: "harbor-closed", jobId: "job", leaseOwner: "SECRET_LEASE_OWNER", attemptCount: 1,
  leaseExpiresAt: "2026-10-17T00:00:00Z" };
const nextDraft = { title: "Find another delivery route", description: "The original harbor is closed; find a route to the recipient.",
  successConditions: [...draft.successConditions], failureConditions: [], settlementConditions: [] };

test("an evolving Goal produces a bounded evidence-backed direction proposal, not a world fact or player action", async () => {
  const requests: ModelChatRequest[] = [];
  const gateway: ModelGateway = { async discoverModels() { return []; }, async chat(request) {
    requests.push(request);
    return { model: "deterministic-evolution-fixture", content: JSON.stringify({ decision: "evolve", draft: nextDraft,
      reason: "The original harbor was formally closed", basisEventIds: [job.sourceEventId] }),
      toolCalls: [], finishReason: "stop", usage: null };
  } };
  assert.equal(typeof evolution.createModelGoalEvolutionPlanner, "function");
  const planner = evolution.createModelGoalEvolutionPlanner({ getGateway: async () => gateway });
  const result = await planner.plan({ job, definition, context });
  assert.deepEqual(result, { draft: { ...nextDraft, changePolicy: "evolving", visible: true },
    reason: "The original harbor was formally closed", basisEventIds: [job.sourceEventId] });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.messages.some(row => row.role === "user" && row.content.includes("harbor-closed")));
  assert.equal(JSON.stringify(requests).includes("SECRET_LEASE_OWNER"), false);
  assert.match(requests[0]!.messages[0]!.content, /player.*(consent|commitment)/i);
  assert.match(requests[0]!.messages[0]!.content, /untrusted.*data/i);
  assert.match(requests[0]!.messages[0]!.content, /fixed/i);
  assert.equal(context.instance.state, "active");
  assert.equal(definition.definitionVersion, 1);
});

test('keep output has an exact null/empty contract and source evidence is required only for evolve',async()=>{
  const requests:ModelChatRequest[]=[];
  const planner=evolution.createModelGoalEvolutionPlanner({getGateway:async()=>({async discoverModels(){return[];},async chat(request){
    requests.push(request);return {model:'deterministic-keep-policy-fixture',content:JSON.stringify({decision:'keep',draft:null,reason:null,basisEventIds:[]}),
      toolCalls:[],finishReason:'stop',usage:null};
  }})});
  assert.equal(await planner.plan({job,definition,context}),null);
  const policy=requests[0].messages[0].content;
  assert.match(policy,/For evolve, use only supplied evidence ids, including the triggering source event/);
  assert.ok(policy.includes('{"decision":"keep","draft":null,"reason":null,"basisEventIds":[]}'));
  assert.match(policy,/Do not cite evidence or include an explanation in a keep response/);
});

test('keep with nonempty evidence remains invalid after the single bounded repair',async()=>{
  let calls=0;
  const planner=evolution.createModelGoalEvolutionPlanner({getGateway:async()=>({async discoverModels(){return[];},async chat(){
    calls++;return {model:'deterministic-invalid-keep-fixture',content:JSON.stringify({decision:'keep',draft:null,reason:null,basisEventIds:[job.sourceEventId]}),
      toolCalls:[],finishReason:'stop',usage:null};
  }})});
  await assert.rejects(planner.plan({job,definition,context}),(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='GOAL_EVOLUTION_FAILED');
  assert.equal(calls,2);
});
