import assert from "node:assert/strict";
import test from "node:test";
import type { ModelChatRequest, ModelGateway } from "../modules/inference/public.ts";
import {
  PRESENCE_HARD_CAP_PER_TURN,
  PRESENCE_MAX_PER_TURN,
  extractPresenceContext,
  filterPresenceCandidates,
  normalizePresenceDecision,
  normalizePresenceRelationship,
  presenceContextIsEmpty,
  presenceTriggerText,
} from "../modules/orchestration/presence.ts";
import {
  createModelPoweredM2TurnOrchestrator,
  createModelPresenceAssessor,
  type ActivatedCharacter,
  type M2TurnPlan,
  type SemanticOutputDraft,
} from "../modules/orchestration/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

function jsonResponse(body: unknown) {
  return {
    model: "fake",
    content: JSON.stringify(body),
    toolCalls: [],
    finishReason: "stop" as const,
    usage: null,
  };
}

function segments(
  parts: readonly { kind: SemanticSegment["kind"]; content: string }[],
): SemanticSegment[] {
  return parts.map((part, index) => ({
    id: `${part.kind}-${index + 1}`,
    kind: part.kind,
    content: part.content,
    speechMode: part.kind === "dialogue" ? "speaker" : "narrator",
  }));
}

function narrationDraft(): SemanticOutputDraft {
  return {
    speaker: "旁白",
    participantId: null,
    characterInstanceId: null,
    content: "冷雾贴着防波堤缓慢流动。\n是否拆开密函的决定仍悬而未决。",
    segments: segments([
      { kind: "environment", content: "冷雾贴着防波堤缓慢流动。" },
      { kind: "fact", content: "信使放下了黑色信函。" },
      { kind: "story", content: "是否拆开密函的决定仍悬而未决。" },
    ]),
  };
}

function characterDraft(): SemanticOutputDraft {
  return {
    speaker: "塞娜",
    participantId: "participant_scout",
    characterInstanceId: "char_inst_scout",
    content: "“蜡封是完好的。”",
    segments: segments([{ kind: "dialogue", content: "“蜡封是完好的。”" }]),
  };
}

const scout: ActivatedCharacter = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
};
const scholar: ActivatedCharacter = {
  characterInstanceId: "char_inst_scholar",
  participantId: "participant_scholar",
  displayName: "弥洛",
};

test("T3 Core: presence budget constants default to one and cap at two", () => {
  assert.equal(PRESENCE_MAX_PER_TURN, 1);
  assert.equal(PRESENCE_HARD_CAP_PER_TURN, 2);
});

test("T3 Core: extractPresenceContext isolates environment, peer and hook material", () => {
  const context = extractPresenceContext({
    narration: narrationDraft(),
    characterResponses: [characterDraft()],
    actionTransactions: [
      {
        transactionId: "txn-1",
        origin: "character",
        actor: scout,
        call: {
          callId: "call-1",
          name: "act",
          arguments: { intent: "观察", targetId: null, approach: null },
        },
        receipt: {
          callId: "call-1",
          callFingerprint: "fp",
          status: "resolved",
          resolution: "check",
          outcome: "success",
          summary: "塞娜确认了蜡封。",
          publicFacts: ["蜡封完好无损"],
          privateObservations: [],
          costs: [],
          effects: [],
        },
      },
    ],
    hookContent: "灯塔的光为何在无风夜自行亮起？",
  });
  // environment 只收旁白 environment/story 段，不收 fact 段。
  assert.deepEqual([...context.environment], [
    "冷雾贴着防波堤缓慢流动。",
    "是否拆开密函的决定仍悬而未决。",
  ]);
  // peer 收角色台词与行动公开事实。
  assert.deepEqual([...context.peer], [
    "塞娜：“蜡封是完好的。”",
    "塞娜的公开行动结果：蜡封完好无损",
  ]);
  assert.equal(context.hook, "灯塔的光为何在无风夜自行亮起？");
  assert.equal(presenceContextIsEmpty(context), false);
  // 触发文本按种类拼接。
  assert.equal(
    presenceTriggerText(context, "environment"),
    "冷雾贴着防波堤缓慢流动。；是否拆开密函的决定仍悬而未决。",
  );
  assert.ok(presenceTriggerText(context, "hook").includes("灯塔"));
});

test("T3 Core: empty presence context is deterministically silent", () => {
  const empty = extractPresenceContext({
    narration: null,
    characterResponses: [],
    actionTransactions: [],
    hookContent: null,
  });
  assert.equal(presenceContextIsEmpty(empty), true);
  const whitespaceHook = extractPresenceContext({ hookContent: "   " });
  assert.equal(presenceContextIsEmpty(whitespaceHook), true);
});

test("T3 Core: candidate filter drops activated, spoken and cooling-down characters", () => {
  let now = 0;
  const turnControl = createTurnControl({ now: () => now, cooldownMs: 60_000 });
  turnControl.recordInterjection(scholar.characterInstanceId);
  const candidates = filterPresenceCandidates({
    characters: [scout, scholar],
    excludedCharacterInstanceIds: new Set([scout.characterInstanceId]),
    turnControl,
  });
  assert.deepEqual(candidates, []);
  // 冷却结束后弥洛回到候选。
  now = 61_000;
  const afterCooldown = filterPresenceCandidates({
    characters: [scout, scholar],
    excludedCharacterInstanceIds: new Set([scout.characterInstanceId]),
    turnControl,
  });
  assert.deepEqual(afterCooldown, [scholar]);
});

test("T3 Core: normalizePresenceDecision fails closed on out-of-roster or out-of-domain output", () => {
  const roster = new Set([scholar.characterInstanceId]);
  const valid = normalizePresenceDecision(
    {
      shouldSpeak: true,
      characterInstanceId: scholar.characterInstanceId,
      triggerKind: "peer",
      reason: "塞娜的台词值得接话",
    },
    roster,
  );
  assert.deepEqual(valid, {
    kind: "speak",
    characterInstanceId: scholar.characterInstanceId,
    triggerKind: "peer",
    reason: "塞娜的台词值得接话",
  });
  assert.equal(
    normalizePresenceDecision(
      { shouldSpeak: true, characterInstanceId: "intruder", triggerKind: "peer" },
      roster,
    ).kind,
    "silent",
  );
  assert.equal(
    normalizePresenceDecision(
      { shouldSpeak: true, characterInstanceId: scholar.characterInstanceId, triggerKind: "weather" },
      roster,
    ).kind,
    "silent",
  );
  assert.equal(
    normalizePresenceDecision({ shouldSpeak: false }, roster).kind,
    "silent",
  );
});

test("T3 Core: model presence gate passes a legal pick and fails closed on garbage", async () => {
  const requests: ModelChatRequest[] = [];
  const assessor = createModelPresenceAssessor({
    getGateway: async () => ({
      async discoverModels() { return []; },
      async chat(request) {
        requests.push(request);
        return jsonResponse({
          shouldSpeak: true,
          characterInstanceId: scholar.characterInstanceId,
          triggerKind: "environment",
          reason: "雾气变化值得弥洛提醒",
        });
      },
    } satisfies ModelGateway),
  });
  const context = extractPresenceContext({ narration: narrationDraft() });
  const decision = await assessor.assess({
    context,
    candidates: [scholar],
    budget: PRESENCE_MAX_PER_TURN,
  });
  assert.equal(decision.kind, "speak");
  if (decision.kind === "speak") {
    assert.equal(decision.characterInstanceId, scholar.characterInstanceId);
    assert.equal(decision.triggerKind, "environment");
  }
  // 门禁为单次 json_object 调用，temperature 0。
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.responseFormat, "json_object");
  assert.equal(requests[0]?.temperature, 0);

  // 选人越候选：确定性沉默。
  const outOfRoster = createModelPresenceAssessor({
    getGateway: async () => ({
      async discoverModels() { return []; },
      async chat() {
        return jsonResponse({
          shouldSpeak: true,
          characterInstanceId: "char_inst_ghost",
          triggerKind: "peer",
          reason: "越权选人",
        });
      },
    } satisfies ModelGateway),
  });
  assert.equal(
    (await outOfRoster.assess({ context, candidates: [scholar], budget: 1 })).kind,
    "silent",
  );

  // 格式损坏：就地重试一次后仍损坏 → 沉默（fail-closed，不抛错）。
  let garbageCalls = 0;
  const garbageGate = createModelPresenceAssessor({
    getGateway: async () => ({
      async discoverModels() { return []; },
      async chat() {
        garbageCalls += 1;
        return { model: "fake", content: "这不是 json", toolCalls: [], finishReason: "stop", usage: null };
      },
    } satisfies ModelGateway),
  });
  const garbageDecision = await garbageGate.assess({
    context,
    candidates: [scholar],
    budget: 1,
  });
  assert.equal(garbageDecision.kind, "silent");
  assert.equal(garbageCalls, 2);

  // provider 连续失败：重试一次后沉默（fail-closed，不抛错）。
  let providerFailures = 0;
  const failingGate = createModelPresenceAssessor({
    getGateway: async () => ({
      async discoverModels() { return []; },
      async chat() {
        providerFailures += 1;
        throw new Error("provider down");
      },
    } satisfies ModelGateway),
  });
  const failingDecision = await failingGate.assess({
    context,
    candidates: [scholar],
    budget: 1,
  });
  assert.equal(failingDecision.kind, "silent");
  assert.ok(providerFailures >= 2);
});

test("T3 Core: presence react drafts action+dialogue with optional relationship and normalized quotes", async () => {
  const prompts: ModelChatRequest[] = [];
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      prompts.push(request);
      const system = request.messages[0]?.content ?? "";
      if (system.includes("presence gate")) {
        throw new Error("presence react must not call the gate");
      }
      if (system.includes("brief spontaneous reaction")) {
        return jsonResponse({
          action: "弥洛合上手里的笔记，抬头望向雾中的灯塔。",
          dialogue: "雾散之前，灯塔的事恐怕绕不过去。",
          relationship: { target: "塞娜", note: "她对蜡封的判断比我预想的更稳。" },
        });
      }
      throw new Error("Unexpected model call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [scout, scholar],
    getGateway: async () => fakeGateway,
  });
  const plan: M2TurnPlan = {
    goal: "让弥洛对刚发生的素材作出简短反应。",
    constraints: [],
    activatedCharacters: [scholar],
    narratorEnabled: false,
    actionBudgetPerCharacter: 0,
    visibility: { kind: "public" },
    presence: {
      characterInstanceId: scholar.characterInstanceId,
      triggerKind: "environment",
      triggerText: "冷雾贴着防波堤缓慢流动。",
      memories: "- 弥洛记得上一场雾里丢过东西。",
      relationships: "- 对塞娜：谨慎的同行者。",
    },
  };
  const candidate = await orchestrator.draft({
    turnId: "turn-presence",
    playerText: "（玩家上一回合的输入）",
    plan,
  });
  assert.equal(candidate.actionTransactions.length, 0);
  assert.equal(candidate.narration, null);
  const response = candidate.characterResponses[0];
  assert.ok(response);
  assert.equal(response?.speaker, "弥洛");
  assert.deepEqual(response?.segments.map((segment) => segment.kind), [
    "action",
    "dialogue",
  ]);
  // 引号规整。
  assert.equal(
    response?.segments[1]?.content,
    "“雾散之前，灯塔的事恐怕绕不过去。”",
  );
  // relationship 有效时附带。
  assert.deepEqual(response?.relationship, {
    target: "塞娜",
    note: "她对蜡封的判断比我预想的更稳。",
  });
  // 记忆与关系视图注入提示词。
  const reactPrompt = prompts.at(-1)?.messages ?? [];
  assert.ok(reactPrompt[1]?.content.includes("上一场雾里丢过东西"));
  assert.ok(reactPrompt[1]?.content.includes("谨慎的同行者"));
  assert.ok(reactPrompt[1]?.content.includes("environment"));
});

test("T3 Core: presence react drops invalid relationship output fail-closed", async () => {
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("brief spontaneous reaction")) {
        return jsonResponse({
          action: "弥洛轻轻点头。",
          dialogue: "“我知道了。”",
          relationship: { target: "", note: "无效目标" },
        });
      }
      throw new Error("Unexpected model call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [scholar],
    getGateway: async () => fakeGateway,
  });
  const plan: M2TurnPlan = {
    goal: "在场反应。",
    constraints: [],
    activatedCharacters: [scholar],
    narratorEnabled: false,
    actionBudgetPerCharacter: 0,
    visibility: { kind: "public" },
    presence: {
      characterInstanceId: scholar.characterInstanceId,
      triggerKind: "peer",
      triggerText: "塞娜：“蜡封是完好的。”",
      memories: "",
      relationships: "",
    },
  };
  const candidate = await orchestrator.draft({
    turnId: "turn-presence-2",
    playerText: "（玩家上一回合的输入）",
    plan,
  });
  const response = candidate.characterResponses[0];
  assert.equal(response?.relationship, undefined);
  // 引号已规整的台词保持原样。
  assert.equal(response?.segments[1]?.content, "“我知道了。”");
});

test("T3 Core: normalizePresenceRelationship shape validation", () => {
  assert.deepEqual(
    normalizePresenceRelationship({ target: "塞娜", note: "更信任她了" }),
    { target: "塞娜", note: "更信任她了" },
  );
  assert.equal(normalizePresenceRelationship({ target: "", note: "空目标" }), null);
  assert.equal(normalizePresenceRelationship({ target: "塞娜", note: "x".repeat(81) }), null);
  assert.equal(normalizePresenceRelationship("塞娜"), null);
  assert.equal(normalizePresenceRelationship(null), null);
  assert.equal(normalizePresenceRelationship(["塞娜"]), null);
});
