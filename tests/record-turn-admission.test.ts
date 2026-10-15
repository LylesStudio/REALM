import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptTurn,
  createInMemoryRuntimeRepository,
  resumeTurn,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import {
  createLocalM2TurnOrchestrator,
  type ActivatedCharacter,
  type CharacterIntent,
  type DraftProgress,
  type M2TurnPlan,
} from "../modules/orchestration/public.ts";

const PLAYER = {
  participantId: "participant_player",
  characterInstanceId: "char_player",
  displayName: "旅人",
} as const;

function character(id: string): ActivatedCharacter {
  return {
    participantId: `participant_${id}`,
    characterInstanceId: id,
    displayName: id,
  } as ActivatedCharacter;
}

test("acceptTurn records the command and does not call the planner", async () => {
  let plans = 0;
  const repository = createInMemoryRuntimeRepository();
  const dependencies = {
    repository,
    planner: {
      async plan() {
        plans += 1;
        return { ok: true };
      },
    },
    drafter: { async draft() { return { ok: true }; } },
    validator: { async validate() { return { ok: true }; } },
    releaseBuilder: { async build() { return { formalEvents: [], outbox: [] }; } },
    clock: () => "2026-10-15T00:00:00.000Z",
    idFactory: () => "turn_admit_1",
  } as TurnRuntimeDependencies;
  const accepted = await acceptTurn({
    commandType: "player.utterance",
    recordId: "record_1",
    expectedRecordVersion: 1,
    idempotencyKey: "msg_1",
    actorId: "participant_player",
    payload: { text: "看看雾。" },
  }, dependencies);
  assert.equal(plans, 0);
  assert.equal(accepted.created, true);
  assert.equal(accepted.run.state, "accepted");
  const again = await acceptTurn({
    commandType: "player.utterance",
    recordId: "record_1",
    expectedRecordVersion: 1,
    idempotencyKey: "msg_1",
    actorId: "participant_player",
    payload: { text: "看看雾。" },
  }, dependencies);
  assert.equal(again.created, false);
  assert.equal(again.run.turnId, accepted.run.turnId);
  assert.equal(plans, 0);
  await assert.rejects(() => acceptTurn({
    commandType: "player.utterance",
    recordId: "record_1",
    expectedRecordVersion: 1,
    idempotencyKey: "msg_1",
    actorId: "participant_player",
    payload: { text: "另一句。" },
  }, dependencies));
});

test("resumeTurn continues from the accepted checkpoint", async () => {
  let plans = 0;
  const repository = createInMemoryRuntimeRepository();
  const dependencies = {
    repository,
    planner: {
      async plan() {
        plans += 1;
        throw new Error("stop after planning is observed");
      },
    },
    drafter: { async draft() { return { ok: true }; } },
    validator: { async validate() { return { ok: true }; } },
    releaseBuilder: { async build() { return { formalEvents: [], outbox: [] }; } },
    clock: () => "2026-10-15T00:00:00.000Z",
    idFactory: () => "turn_resume_1",
  } as TurnRuntimeDependencies;
  const accepted = await acceptTurn({
    commandType: "player.utterance",
    recordId: "record_1",
    expectedRecordVersion: 1,
    idempotencyKey: "msg_resume",
    actorId: PLAYER.participantId,
    payload: { text: "看看雾。" },
  }, dependencies);
  const resumed = await resumeTurn(accepted.run.turnId, dependencies);
  assert.equal(plans, 1);
  assert.notEqual(resumed.state, "accepted");
});

test("draft progress skips a character response that already finished", async () => {
  const a = character("char_a");
  const b = character("char_b");
  const calls: string[] = [];
  let failB = true;
  const orchestrator = createLocalM2TurnOrchestrator({
    characters: [a, b],
    characterRunner: {
      async propose({ character: actor }) {
        calls.push(`propose:${actor.characterInstanceId}`);
        return { character: actor, requestedActions: [] } satisfies CharacterIntent;
      },
      async react({ character: actor }) {
        calls.push(`react:${actor.characterInstanceId}`);
        if (actor.characterInstanceId === "char_b" && failB) {
          failB = false;
          throw new Error("b failed");
        }
        return {
          speaker: actor.displayName,
          participantId: actor.participantId,
          characterInstanceId: actor.characterInstanceId,
          content: "回应",
          segments: [],
        };
      },
    },
  });
  const plan: M2TurnPlan = {
    turnIntent: "both",
    constraints: [],
    activatedCharacters: [a, b],
    narratorEnabled: false,
    actionBudgetPerCharacter: 0,
    visibility: { kind: "public" },
  };
  let progress: DraftProgress | undefined;
  await assert.rejects(() => orchestrator.draft({
    turnId: "turn_draft",
    playerText: "问一句",
    plan,
    onProgress: async (next) => {
      progress = next;
    },
  }));
  assert.ok(progress?.characterResponses?.some((item) => item.characterInstanceId === "char_a"));
  calls.length = 0;
  const completed = await orchestrator.draft({
    turnId: "turn_draft",
    playerText: "问一句",
    plan,
    progress,
  });
  assert.equal(calls.includes("propose:char_a"), false);
  assert.equal(calls.includes("react:char_a"), false);
  assert.equal(calls.includes("react:char_b"), true);
  assert.equal(completed.characterResponses.length, plan.activatedCharacters.length);
});
