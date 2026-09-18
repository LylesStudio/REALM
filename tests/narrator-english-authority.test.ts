import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnCandidate,
  type M2TurnPlan,
} from "../modules/orchestration/public.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

/**
 * P1-14：Narrator 英文环境/故事输出的 fail-closed 权限校验。
 * 旧 NARRATOR_HUMAN_REFERENCE 只覆盖中文人称/称谓，英文 he/she/the player
 * 等角色指代会漏过授权检查。两条校验面都必须 fail-closed：
 * model narrator（一次 repair 后仍违规则 NARRATOR_RESPONSE_INVALID）与
 * legacy narratorAuthorityIsValid（DM validate 拒绝候选）。
 * 普通英文环境词（the/light/weather/sound/turns 无主语）不得误判。
 */

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
} as const;

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

/** DM/actor/react 正常、narrator 按队列依次返回候选的 fake gateway。 */
function narratorQueueGateway(narratorBodies: readonly unknown[]) {
  const tracked = { narratorCalls: 0 };
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "回应玩家的自然询问",
          activatedCharacterInstanceIds: [SCOUT.characterInstanceId],
          narratorEnabled: true,
        });
      }
      if (request.tools) return jsonResponse({});
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error(`Unexpected chat call: ${system.slice(0, 60)}`);
    },
    async *streamChat(request) {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("independent Narrator")) {
        const body = narratorBodies[Math.min(tracked.narratorCalls, narratorBodies.length - 1)];
        tracked.narratorCalls += 1;
        yield { content: JSON.stringify(body) };
        return;
      }
      yield {
        content: JSON.stringify({
          action: "塞娜侧耳。",
          dialogue: "我在听。",
          recipientId: null,
        }),
      };
    },
  };
  return { gateway, tracked };
}

async function draftWithNarrator(bodies: readonly unknown[]) {
  const { gateway, tracked } = narratorQueueGateway(bodies);
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const input = { turnId: "turn-english-narrator", playerText: "你还醒着吗？" };
  const plan = await orchestrator.plan(input);
  const settled = await orchestrator.draft({ ...input, plan }).then(
    (candidate) => ({ kind: "ok" as const, candidate }),
    (error) => ({ kind: "error" as const, error }),
  );
  return { settled, tracked };
}

const LEGAL_NARRATION = {
  environment: "The lighthouse light turns across the harbor.",
  storyBeat: "The harbor wakes to the sound of gulls.",
};

test("model narrator: 合法英文环境词不误判，一次通过", async () => {
  const { settled, tracked } = await draftWithNarrator([LEGAL_NARRATION]);
  assert.equal(settled.kind, "ok");
  if (settled.kind !== "ok") return;
  assert.equal(tracked.narratorCalls, 1, "合法输出不得触发 repair");
  assert.ok(
    settled.candidate.narration?.content.includes("lighthouse"),
    "合法英文输出必须保留",
  );
});

test("model narrator: environment 英文人称指代 fail-closed（repair 后仍违规则终局失败）", async () => {
  const violating = { environment: "He turns toward the window.", storyBeat: "The fog thickens." };
  const { settled, tracked } = await draftWithNarrator([violating, violating]);
  assert.equal(settled.kind, "error", "两次违规必须失败，不得写入候选");
  assert.equal(tracked.narratorCalls, 2, "既有一次 repair 语义不变");
  const error = (settled as { kind: "error"; error: unknown }).error;
  assert.ok(error instanceof FatalTurnError);
  assert.equal(error.code, "NARRATOR_RESPONSE_INVALID");
});

test("model narrator: environment 英文角色指代 the player 违规；storyBeat 英文人称同样 fail-closed", async () => {
  const badEnvironment = { environment: "The player turns the letter over.", storyBeat: "The fog thickens." };
  const badStoryBeat = { environment: "The fog thickens over the pier.", storyBeat: "She says nothing." };
  const { settled, tracked } = await draftWithNarrator([badEnvironment, badStoryBeat]);
  assert.equal(settled.kind, "error");
  assert.equal(tracked.narratorCalls, 2, "environment 与 storyBeat 都必须被检查");
  const error = (settled as { kind: "error"; error: unknown }).error;
  assert.ok(error instanceof FatalTurnError);
  assert.equal(error.code, "NARRATOR_RESPONSE_INVALID");
});

test("model narrator: 一次违规经 repair 改正后正常放行", async () => {
  const violating = { environment: "She whispers to the scout.", storyBeat: "The fog thickens." };
  const { settled, tracked } = await draftWithNarrator([violating, LEGAL_NARRATION]);
  assert.equal(settled.kind, "ok", "repair 后的合法输出必须放行");
  assert.equal(tracked.narratorCalls, 2);
});

// ---- legacy authority helper（createLocalM2TurnOrchestrator validate 路径）----

const LEGACY_PLAN: M2TurnPlan = {
  goal: "Advance one coherent public scene.",
  constraints: [],
  activatedCharacters: [],
  narratorEnabled: true,
  actionBudgetPerCharacter: 1,
  visibility: { kind: "public" },
};

function narrationCandidate(environment: string, story: string): M2TurnCandidate {
  const segments = [
    { id: "environment-1", kind: "environment" as const, content: environment, speechMode: "narrator" as const },
    { id: "story-1", kind: "story" as const, content: story, speechMode: "narrator" as const },
  ];
  return {
    narration: {
      speaker: "旁白",
      participantId: null,
      characterInstanceId: null,
      content: segments.map((segment) => segment.content).join("\n"),
      segments,
    },
    characterResponses: [],
    actionTransactions: [],
  };
}

test("legacy authority: 英文人称/角色指代被 DM validate 拒绝", async () => {
  const orchestrator = createLocalM2TurnOrchestrator({ characters: [] });
  for (const candidate of [
    narrationCandidate("He turns toward the window.", "The fog thickens."),
    narrationCandidate("The fog thickens.", "She says nothing."),
    narrationCandidate("The player turns the letter over.", "The fog thickens."),
    narrationCandidate("The character looks at the sea.", "The fog thickens."),
  ]) {
    await assert.rejects(
      orchestrator.validate({ plan: LEGACY_PLAN, candidate }),
      (error: unknown) => {
        assert.ok(error instanceof FatalTurnError);
        assert.equal(error.code, "DM_OUTPUT_INCOMPLETE");
        return true;
      },
      `英文违规候选必须 fail-closed：${candidate.narration?.content}`,
    );
  }
});

test("legacy authority: 合法英文环境/故事输出放行", async () => {
  const orchestrator = createLocalM2TurnOrchestrator({ characters: [] });
  const validation = await orchestrator.validate({
    plan: LEGACY_PLAN,
    candidate: narrationCandidate(
      "The lighthouse light turns across the harbor.",
      "The harbor wakes to the sound of gulls.",
    ),
  });
  assert.equal(validation.accepted, true);
  assert.equal(validation.narratorChecked, true);
});
