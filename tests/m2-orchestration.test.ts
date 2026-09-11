import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicActionResolver,
  type ActorToolCall,
} from "../modules/actions/public.ts";
import {
  createLocalM2TurnOrchestrator,
  createRuleBasedDMController,
  type CharacterRunner,
  type M2TurnCandidate,
} from "../modules/orchestration/public.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

const scout = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
} as const;

test("local orchestration uses typed Actor Tools without language-triggered mechanics", async () => {
  const orchestrator = createLocalM2TurnOrchestrator({ characters: [scout] });
  const plan = await orchestrator.plan({
    turnId: "turn-natural",
    playerText: "我掷一枚二十面骰，决定是否拆开密函。",
  });
  assert.equal(plan.actionBudgetPerCharacter, 1);
  assert.deepEqual(plan.activatedCharacters, [scout]);

  const candidate = await orchestrator.draft({
    turnId: "turn-natural",
    playerText: "我掷一枚二十面骰，决定是否拆开密函。",
    plan,
  });
  assert.equal(candidate.actionTransactions.length, 1);
  assert.equal(candidate.actionTransactions[0]?.origin, "character");
  assert.equal(candidate.actionTransactions[0]?.call.name, "act");
  assert.equal(candidate.actionTransactions[0]?.receipt.resolution, "automatic");
  assert.equal(candidate.actionTransactions[0]?.receipt.mechanic, undefined);
  assert.doesNotMatch(
    [candidate.narration?.content, candidate.characterResponses[0]?.content].join("\n"),
    /d20|骰|检定|难度/i,
  );
  assert.equal((await orchestrator.validate({ plan, candidate })).accepted, true);
});

test("a server-authorized player action is resolved separately from autonomous characters", async () => {
  const player = {
    characterInstanceId: "char_inst_player",
    participantId: "participant_player",
    displayName: "洛川",
  } as const;
  const orchestrator = createLocalM2TurnOrchestrator({ characters: [scout] });
  const input = {
    turnId: "turn-player-affordance",
    playerText: "我仔细观察蜡封边缘。",
    playerAction: {
      actor: player,
      call: {
        callId: "turn-player-affordance:player:skill",
        name: "use_skill" as const,
        arguments: {
          skillId: "careful_observation",
          targetId: "letter_seal",
          intent: "仔细观察蜡封边缘",
        },
      },
    },
  };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  assert.equal(candidate.actionTransactions.length, 2);
  assert.equal(candidate.actionTransactions[0]?.actor.characterInstanceId, player.characterInstanceId);
  assert.equal(candidate.actionTransactions[0]?.call.name, "use_skill");
  assert.equal(candidate.actionTransactions[1]?.actor.characterInstanceId, scout.characterInstanceId);
  assert.equal((await orchestrator.validate({ plan, candidate })).accepted, true);
});

test("use_skill is actor-facing while uncertainty resolution stays internal and idempotent", async () => {
  const resolver = createDeterministicActionResolver();
  const call = {
    callId: "turn-skill:scout:skill:1",
    name: "use_skill" as const,
    arguments: {
      skillId: "careful_observation",
      targetId: "letter_seal",
      intent: "辨认蜡封是否被动过",
    },
  };
  const first = await resolver.resolve({ actor: scout, call });
  assert.equal(first.call.name, "use_skill");
  assert.equal(first.receipt.resolution, "check");
  assert.equal(first.receipt.mechanic?.system, "d20");
  assert.doesNotMatch(first.receipt.summary, /d20|检定|难度|\d+\s*\+/i);

  const replay = await resolver.resolve({
    actor: scout,
    call: {
      callId: call.callId,
      name: call.name,
      arguments: {
        intent: call.arguments.intent,
        targetId: call.arguments.targetId,
        skillId: call.arguments.skillId,
      },
    },
  });
  assert.deepEqual(replay, first);
  await assert.rejects(
    resolver.resolve({
      actor: scout,
      call: {
        ...call,
        arguments: { ...call.arguments, targetId: "lighthouse" },
      },
    }),
    (error: unknown) =>
      error instanceof FatalTurnError
      && error.code === "ACTION_IDEMPOTENCY_CONFLICT",
  );

  const failedResolver = createDeterministicActionResolver({
    rulePack: {
      async decide() {
        return {
          resolution: "automatic",
          automaticOutcome: "failure",
          facts: {
            success: "可以确认。",
            partial: "只能确认一部分。",
            failure: "无法形成可靠判断。",
            impossible: "当前无法观察。",
          },
          privateObservation: "这条成功式观察不应在失败时暴露。",
        };
      },
    },
  });
  const failed = await failedResolver.resolve({ actor: scout, call: {
    ...call,
    callId: "turn-skill:scout:failure:1",
  } });
  assert.equal(failed.receipt.outcome, "failure");
  assert.deepEqual(failed.receipt.privateObservations, []);
});

test("state-changing Actor Tools fail closed before a durable effect ledger exists", async () => {
  const resolver = createDeterministicActionResolver();
  const calls: ActorToolCall[] = [
    {
      callId: "turn-state:asset:1",
      name: "use_asset",
      arguments: {
        assetId: "silver_key",
        targetId: "sealed_door",
        intent: "尝试开门",
      },
    },
    {
      callId: "turn-state:stance:1",
      name: "take_stance",
      arguments: {
        stanceId: "guarded",
        intent: "保持警戒",
      },
    },
  ];
  for (const call of calls) {
    await assert.rejects(
      resolver.resolve({ actor: scout, call }),
      (error: unknown) =>
        error instanceof FatalTurnError
        && error.code === "STATEFUL_ACTION_NOT_AVAILABLE",
    );
  }

  const unsafeRuleResolver = createDeterministicActionResolver({
    rulePack: {
      async decide() {
        return {
          resolution: "automatic",
          automaticOutcome: "success",
          facts: {
            success: "行动成功。",
            partial: "行动只完成了一部分。",
            failure: "行动失败。",
            impossible: "行动无法执行。",
          },
          costs: [{ resourceId: "stamina", amount: 1 }],
        };
      },
    },
  });
  await assert.rejects(
    unsafeRuleResolver.resolve({
      actor: scout,
      call: {
        callId: "turn-state:unsafe-rule:1",
        name: "act",
        arguments: {
          intent: "尝试一个需要消耗的行动",
          targetId: null,
          approach: null,
        },
      },
    }),
    (error: unknown) =>
      error instanceof FatalTurnError
      && error.code === "STATEFUL_ACTION_NOT_AVAILABLE",
  );
});

test("DM rejects missing action receipts, duplicate actions and role identity leakage", async () => {
  const dm = createRuleBasedDMController();
  const plan = await dm.plan({
    turnId: "turn-invalid",
    playerText: "查看密函。",
    availableCharacters: [scout],
  });
  const invalid: M2TurnCandidate = {
    actionTransactions: [],
    narration: {
      speaker: "旁白",
      participantId: null,
      characterInstanceId: null,
      content: "“我替塞娜决定投降。”",
      segments: [{
        id: "dialogue-1",
        kind: "dialogue",
        content: "“我替塞娜决定投降。”",
        speechMode: "speaker",
      }],
    },
    characterResponses: [],
  };
  await assert.rejects(
    dm.validate({ plan, candidate: invalid }),
    isIncomplete,
  );

  const orchestrator = createLocalM2TurnOrchestrator({
    characters: [scout],
    dmController: dm,
  });
  const valid = await orchestrator.draft({
    turnId: "turn-invalid",
    playerText: "查看密函。",
    plan,
  });
  await assert.rejects(
    dm.validate({
      plan,
      candidate: {
        ...valid,
        narration: valid.narration
          ? {
              ...valid.narration,
              content: valid.narration.content.replace(
                "是否拆开密函的决定仍悬而未决。",
                "塞娜替所有人决定立刻拆开密函。",
              ),
              segments: valid.narration.segments.map((segment) =>
                segment.kind === "story"
                  ? { ...segment, content: "塞娜替所有人决定立刻拆开密函。" }
                  : segment
              ),
            }
          : null,
      },
    }),
    isIncomplete,
  );
  await assert.rejects(
    dm.validate({
      plan,
      candidate: {
        ...valid,
        narration: valid.narration
          ? {
              ...valid.narration,
              content: valid.narration.content.replace(
                "是否拆开密函的决定仍悬而未决。",
                "一位谨慎的斥候将密函递到灯下，她决定立刻拆开。",
              ),
              segments: valid.narration.segments.map((segment) =>
                segment.kind === "story"
                  ? { ...segment, content: "一位谨慎的斥候将密函递到灯下，她决定立刻拆开。" }
                  : segment
              ),
            }
          : null,
      },
    }),
    isIncomplete,
  );
  await assert.rejects(
    dm.validate({
      plan,
      candidate: {
        ...valid,
        actionTransactions: [
          ...valid.actionTransactions,
          ...valid.actionTransactions,
        ],
      },
    }),
    isIncomplete,
  );
  await assert.rejects(
    dm.validate({
      plan,
      candidate: {
        ...valid,
        characterResponses: valid.characterResponses.map((response) => ({
          ...response,
          participantId: "participant_impostor",
        })),
      },
    }),
    isIncomplete,
  );
});

test("a Character Runner can choose a skill without emitting mechanical prose", async () => {
  const characterRunner: CharacterRunner = {
    async propose({ turnId, character }) {
      return {
        character,
        requestedActions: [{
          callId: `${turnId}:${character.characterInstanceId}:skill:1`,
          name: "use_skill",
          arguments: {
            skillId: "careful_observation",
            targetId: "letter_seal",
            intent: "辨认蜡封是否被动过",
          },
        }],
      };
    },
    async react({ character, actionTransactions }) {
      const fact = actionTransactions[0]?.receipt.publicFacts[0] ?? "暂时没有结论。";
      return {
        speaker: character.displayName,
        participantId: character.participantId,
        characterInstanceId: character.characterInstanceId,
        content: `塞娜收回手：\n“${fact}”`,
        segments: [
          {
            id: "action-1",
            kind: "action",
            content: "塞娜收回手：",
            speechMode: "narrator",
          },
          {
            id: "dialogue-1",
            kind: "dialogue",
            content: `“${fact}”`,
            speechMode: "speaker",
          },
        ],
      };
    },
  };
  const orchestrator = createLocalM2TurnOrchestrator({
    characters: [scout],
    characterRunner,
  });
  const plan = await orchestrator.plan({
    turnId: "turn-skill",
    playerText: "看看蜡封。",
  });
  const candidate = await orchestrator.draft({
    turnId: "turn-skill",
    playerText: "看看蜡封。",
    plan,
  });
  assert.equal(candidate.actionTransactions[0]?.call.name, "use_skill");
  assert.equal(candidate.actionTransactions[0]?.receipt.resolution, "check");
  assert.doesNotMatch(candidate.characterResponses[0]?.content ?? "", /d20|骰|检定|难度/i);
  assert.equal((await orchestrator.validate({ plan, candidate })).accepted, true);
});

function isIncomplete(error: unknown): boolean {
  return error instanceof FatalTurnError && error.code === "DM_OUTPUT_INCOMPLETE";
}
