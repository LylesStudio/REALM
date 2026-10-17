/**
 * Record Goal A 批 · A2：同轮裁定承接（turn consequence handoff）。
 *
 * 生产链路证据测试：createModelPoweredM2TurnOrchestrator 真实编排
 * plan → propose → narrate → react，gateway 是记录全部请求的 fake
 * （fixture 为明确测试数据，不冒充真实模型结果）。
 *
 * 契约：同一回合内 Narrator 已裁定并表达的事实（如「灯光离去」）必须进入
 * 随后角色 react 的实际 model request，并明确标注为「同轮裁定、尚未提交」，
 * 不得伪装成已提交历史；restricted 回合只注入 audience 内角色。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildRecordGoalNarrativeContext } from "../modules/goals/narrative-context.ts";
import { demoRecordRuntimeScope } from "../modules/application/local-record-read-model.ts";
import { emptyNarrativeState, planNarrativeConsequence } from "../modules/application/narrative-situation.ts";
import {
  createModelPoweredM2TurnOrchestrator,
} from "../modules/orchestration/model-powered.ts";
import {
  sameTurnNarrationForCharacter,
  type ActivatedCharacter,
  type SemanticOutputDraft,
} from "../modules/orchestration/public.ts";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/public.ts";

const SCHOLAR: ActivatedCharacter = {
  characterInstanceId: "char_inst_scholar",
  participantId: "participant_scholar",
  displayName: "弥洛",
};

const SCOUT: ActivatedCharacter = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
};

const NARRATION_FACT = "灯塔的光在潮声里熄灭了。";
const NARRATION_BEAT = "浓雾无声漫上防波堤。";

function fakeGateway(narrativeConsequence?: unknown): {
  gateway: ModelGateway;
  requests: ModelChatRequest[];
} {
  const requests: ModelChatRequest[] = [];
  return {
    requests,
    gateway: {
      async discoverModels() {
        return [];
      },
      async chat(request) {
        requests.push(request);
        const system = String(request.messages[0]?.content ?? "");
        let content: string;
        if (system.includes("DM Controller")) {
          content = JSON.stringify({
            turnIntent: "让学者回应灯光的变化。",
            activatedCharacterInstanceIds: [SCHOLAR.characterInstanceId],
            narratorEnabled: true,
          });
        } else if (system.includes("independent Narrator")) {
          content = JSON.stringify({
            environment: NARRATION_FACT,
            storyBeat: NARRATION_BEAT,
            suggestions: ["我去看看灯塔。", "我先站在原地。"],
            ...(narrativeConsequence === undefined ? {} : { narrativeConsequence }),
          });
        } else if (system.includes("thinking only as the character")) {
          // Actor propose：本回合不调用工具（无状态变更动作）。
          const response: ModelChatResponse = {
            model: "fake",
            content: "",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
          return response;
        } else {
          // 角色 react（非 presence、无自身行动事务分支）。
          content = JSON.stringify({
            action: "抬头望向熄灭的方向",
            dialogue: "光……灭了。",
            recipientId: null,
          });
        }
        return {
          model: "fake",
          content,
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        } satisfies ModelChatResponse;
      },
    },
  };
}

function reactRequestOf(requests: readonly ModelChatRequest[]): ModelChatRequest {
  const found = requests.find((request) =>
    String(request.messages[0]?.content ?? "").includes("natural exchange"));
  assert.ok(found, "应存在角色 react 的实际 model request");
  return found;
}

test("D3：DM、Narrator 和角色实际请求共享公开 Goal 进度，但目标文字不会升级成 system 指令", async () => {
  const marker = "UNTRUSTED_GOAL_TEXT_IGNORE_ENGINE_POLICY";
  const recordGoals = buildRecordGoalNarrativeContext({ headOrdinal: 4, goals: [{
    goalKey: "delivery-progress", scopeKind: "record", attempt: 1, supersedesInstanceId: null,
    state: "settled", resolutionKind: "withdrawn", progress: { summary: "The letter is still sealed." }, outcome: null,
    title: "Deliver the letter", description: marker, changePolicy: "fixed",
  }] });
  const { gateway, requests } = fakeGateway();
  const orchestrator = createModelPoweredM2TurnOrchestrator({ characters: [SCHOLAR], getGateway: async () => gateway,
    brief: { ...demoRecordRuntimeScope().brief, recordGoals } });
  const plan = await orchestrator.plan({ turnId: "turn-d3-context", playerText: "我查看信件。" });
  await orchestrator.draft({ turnId: "turn-d3-context", playerText: "我查看信件。", plan });
  for (const stage of ["DM Controller", "independent Narrator", "natural exchange"]) {
    const request = requests.find(row => String(row.messages[0]?.content).includes(stage));
    assert.ok(request, `Actual ${stage} request must exist`);
    assert.ok(request.messages.some(row => row.role === "user" && row.content.includes(marker)), `${stage} must consume the projected Goal`);
    assert.equal(request.messages.filter(row => row.role === "system").some(row => row.content.includes(marker)), false);
    assert.match(String(request.messages[0]?.content), /withdrawn.*not.*success/i);
    assert.match(String(request.messages[0]?.content), /fixed.*definition/i);
    assert.match(String(request.messages[0]?.content), /player.*commitment/i);
  }
});

test("D2：模型提出的 bounded 世界后果保留在候选中，不冒充已提交事实", async () => {
  const proposal = { changes: [{ situationId: null, status: "resolved", fact: NARRATION_FACT,
    obstacle: null, unknowns: [], exitConditions: [], basisEventIds: [], playerActions: [] }], elapsedMinutes: 0 };
  const { gateway } = fakeGateway(proposal);
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCHOLAR], getGateway: async () => gateway,
  });
  const plan = await orchestrator.plan({ turnId: "turn-d2-proposal", playerText: "我查看灯塔。" });
  const candidate = await orchestrator.draft({ turnId: "turn-d2-proposal", playerText: "我查看灯塔。", plan });
  assert.deepEqual((candidate.narration as unknown as Record<string, unknown>).narrativeConsequence, proposal);
  assert.equal((candidate.narration as unknown as Record<string, unknown>).narrativeState, undefined,
    "正式状态只能由 release 的受权 scope/head 和最终 event ID 生成");
});

test("D2：实际 Narrator 请求读取已结束局势，并收到结构化后果契约", async () => {
  const state = planNarrativeConsequence({ scope: demoRecordRuntimeScope(), previous: emptyNarrativeState(),
    expectedRevision: 0, sourceEventId: "fixture:resolved", observedHead: {recordVersion: 0, ordinal: 0},
    sourceRole: "narrator", turnKind: "player", committedEventIds: [], timeAdvanceAuthorized: false,
    proposal: {changes: [{situationId: null, status: "resolved", fact: NARRATION_FACT, obstacle: null,
      unknowns: [], exitConditions: [], basisEventIds: [], playerActions: []}], elapsedMinutes: 0} })!;
  const { gateway, requests } = fakeGateway();
  const orchestrator = createModelPoweredM2TurnOrchestrator({characters: [SCHOLAR], getGateway: async () => gateway,
    brief: {...demoRecordRuntimeScope().brief, narrativeState: JSON.stringify(state)}});
  const plan = await orchestrator.plan({turnId: "turn-d2-context", playerText: "我看看前方。"});
  await orchestrator.draft({turnId: "turn-d2-context", playerText: "我看看前方。", plan});
  const request = requests.find(row => String(row.messages[0]?.content).includes("independent Narrator"))!;
  assert.ok(String(request.messages.at(-1)?.content).includes(state.fingerprint));
  assert.ok(String(request.messages[0]?.content).includes("narrativeConsequence"));
  assert.match(String(request.messages[0]?.content), /resolved.*(reactivate|active)|retired.*(revive|active)/i);
});

test("D2：被动拍不接受世界后果，不能把候选包装成受权玩家回合", async () => {
  const proposal = {changes: [{situationId: null, status: "active", fact: "A gate closes.", obstacle: "Gate",
    unknowns: [], exitConditions: ["Gate opens"], basisEventIds: [], playerActions: []}], elapsedMinutes: 0};
  const {gateway} = fakeGateway(proposal);
  const orchestrator = createModelPoweredM2TurnOrchestrator({characters: [SCHOLAR], getGateway: async () => gateway});
  const plan = {...await orchestrator.plan({turnId: "passive-d2", playerText: ""}), narrativeMode: "passive" as const};
  await assert.rejects(orchestrator.draft({turnId: "passive-d2", playerText: "", plan}),
    (error: unknown) => (error as {code?: string}).code === "NARRATOR_RESPONSE_INVALID");
});

test("A2：同轮 narrator 裁定进入随后角色 react 的实际 model request（标注为未提交）", async () => {
  const { gateway, requests } = fakeGateway();
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCHOLAR],
    getGateway: async () => gateway,
  });
  const plan = await orchestrator.plan({
    turnId: "turn-a2-1",
    playerText: "我抬头看向灯塔。",
  });
  const candidate = await orchestrator.draft({
    turnId: "turn-a2-1",
    playerText: "我抬头看向灯塔。",
    plan,
  });
  // 编排 sanity：旁白确实裁定并表达了「灯光离去」。
  assert.ok(candidate.narration?.content.includes(NARRATION_FACT));

  const react = reactRequestOf(requests);
  const userContent = String(react.messages.at(-1)?.content ?? "");
  assert.ok(
    userContent.includes(NARRATION_FACT),
    "同轮旁白裁定（灯光离去）必须进入角色 react 的实际 request",
  );
  assert.ok(
    userContent.includes(NARRATION_BEAT),
    "同轮 storyBeat 一并承接",
  );
  // 明确标注：同轮裁定、尚未提交——不得伪装成 committed 历史。
  assert.match(userContent, /[Ss]ame-turn|not (yet )?committed/i);
  // 玩家原始输入仍在（不丢旧输入）。
  assert.ok(userContent.includes("我抬头看向灯塔。"));
});

test("A2 可见性门：restricted 回合的同轮裁定只注入 audience 内角色", () => {
  const narration = {
    speaker: "旁白",
    participantId: null,
    characterInstanceId: null,
    content: NARRATION_FACT,
    segments: [],
  } as unknown as SemanticOutputDraft;
  const publicPlan = { visibility: { kind: "public" as const } };
  const restrictedPlan = {
    visibility: {
      kind: "restricted" as const,
      domainId: "domain_secret",
      audienceCharacterInstanceIds: [SCHOLAR.characterInstanceId],
    },
  };
  assert.equal(
    sameTurnNarrationForCharacter(publicPlan, narration, SCHOLAR),
    narration,
  );
  assert.equal(
    sameTurnNarrationForCharacter(restrictedPlan, narration, SCHOLAR),
    narration,
  );
  // audience 外角色看不到同轮 restricted 裁定。
  assert.equal(
    sameTurnNarrationForCharacter(restrictedPlan, narration, SCOUT),
    null,
  );
  // 无旁白时恒 null。
  assert.equal(sameTurnNarrationForCharacter(publicPlan, null, SCHOLAR), null);
});
