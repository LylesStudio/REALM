import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";
import {
  createModelDynamicDiscoveryGenerator,
  createModelPresenceAssessor,
  createModelPoweredM2TurnOrchestrator,
  createModelVisibilityAssessor,
} from "../modules/orchestration/model-powered.ts";

/**
 * Cleanup Phase 4 / Batch 2A：transport 分流 + 阶段级 policy 的 focused tests。
 * 证明：chat 是默认 transport（不访问 streamChat、不触发空 stream 重试、
 * 不产生 Preview）；只有显式 previewNlg 链走 stream；tools 永远 chat；
 * classifier/planner/previewNlg 的 maxTokens/thinking/timeoutMs 真实进入请求。
 */

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
} as const;

const PLAYER = {
  characterInstanceId: "player-instance",
  participantId: "player-participant",
  displayName: "玩家",
} as const;

test("visibility classifier: chat transport, classifier policy fields, never streams", async () => {
  let streamCalls = 0;
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({ visibility: "public", reason: "ordinary question" });
    },
    async *streamChat() {
      streamCalls += 1;
      yield { content: "x" };
    },
  };
  const assessor = createModelVisibilityAssessor({
    player: PLAYER,
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const result = await assessor.assess({ playerText: "你听到我说话吗？" });
  assert.equal(result.visibility.kind, "public");
  assert.equal(streamCalls, 0, "chat transport must not touch streamChat");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.thinking, "disabled");
  assert.equal(captured[0]!.maxTokens, 512);
  assert.equal(captured[0]!.timeoutMs, 45_000);
});

test("presence gate: chat transport, classifier policy fields, never streams", async () => {
  let streamCalls = 0;
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({ shouldSpeak: false, reason: "nothing worth answering" });
    },
    async *streamChat() {
      streamCalls += 1;
      yield { content: "x" };
    },
  };
  const assessor = createModelPresenceAssessor({ getGateway: async () => gateway });
  const decision = await assessor.assess({
    context: { environment: ["灯塔顶浓雾未散。"], peer: [], hook: null },
    candidates: [{ characterInstanceId: "scout-instance", displayName: "塞娜" }],
    budget: 1,
  });
  assert.equal(decision.kind, "silent");
  assert.equal(streamCalls, 0, "presence gate must not touch streamChat");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.thinking, "disabled");
  assert.equal(captured[0]!.maxTokens, 512);
  assert.equal(captured[0]!.timeoutMs, 45_000);
});

test("dynamic discovery: classifier policy fields (replaces the old per-site values)", async () => {
  let streamCalls = 0;
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({
        subject: "蜡封",
        feature: "边缘有新鲜撬痕",
        nextCheck: "比对库房的撬棍",
      });
    },
    async *streamChat() {
      streamCalls += 1;
      yield { content: "x" };
    },
  };
  const generator = createModelDynamicDiscoveryGenerator({
    getGateway: async () => gateway,
  });
  const draft = await generator.generate({
    actor: SCOUT,
    call: { callId: "call-1", name: "use_skill", arguments: { skillId: "careful_observation", targetId: "letter_seal", intent: "辨认蜡封" } },
    skill: { skillKey: "careful_observation", title: "仔细观察", description: "观察细节" },
    outcome: "success",
    publicFact: "塞娜辨认出蜡封边缘的撬痕。",
    context: {
      worldName: "灯塔港",
      era: "潮声纪元",
      summary: "雾中灯塔。",
      storyTitle: "序章",
      premise: "守塔人失踪。",
      location: "灯塔顶",
      weather: "浓雾",
      tension: "低",
      objective: "点亮主灯",
      canon: "",
      recentPublicEvents: [],
    },
  });
  assert.ok(draft, "discovery draft should be produced");
  assert.equal(streamCalls, 0, "discovery must not touch streamChat");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.thinking, "disabled");
  assert.equal(captured[0]!.maxTokens, 512);
  assert.equal(captured[0]!.timeoutMs, 45_000);
});

test("DM planner: chat transport with planner policy; reviewer: chat transport with classifier policy", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      chatRequests.push(request);
      const system = request.messages[0]?.content ?? "";
      if (request.tools) {
        return jsonResponse({});
      }
      if (system.includes("information visibility")) {
        return jsonResponse({ visibility: "public", reason: "ordinary question" });
      }
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "回应玩家的自然询问",
          activatedCharacterInstanceIds: ["scout-instance"],
          narratorEnabled: false,
        });
      }
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error(`Unexpected chat call: ${system.slice(0, 60)}`);
    },
    async *streamChat(request) {
      streamRequests.push(request);
      yield { content: '{"action":"塞娜侧耳。","dialogue":"我在听。","recipientId":null}' };
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const input = { turnId: "turn-stage-policy", playerText: "你还醒着吗？" };
  const plan = await orchestrator.plan(input);
  const planRequest = chatRequests.find((request) =>
    (request.messages[0]?.content ?? "").includes("DM Controller")
    && !(request.messages[0]?.content ?? "").includes("information visibility")
  );
  assert.ok(planRequest, "planner request should be captured");
  assert.equal(planRequest!.thinking, "disabled");
  assert.equal(planRequest!.maxTokens, 768);
  assert.equal(planRequest!.timeoutMs, 45_000);

  const candidate = await orchestrator.draft({ ...input, plan });
  assert.ok(streamRequests.length >= 1, "react streams for preview");
  assert.ok(
    streamRequests.every((request) => !request.tools),
    "streamed requests never carry tools",
  );
  assert.ok(
    streamRequests.every((request) => request.timeoutMs === 90_000),
    "preview NLG uses the stream policy timeout",
  );
  assert.ok(
    chatRequests.some((request) => (request.tools?.length ?? 0) >= 0 && request.toolChoice === "auto"),
    "propose tools request stays on chat",
  );
  assert.equal(candidate.actionTransactions.length, 0, "no tool call means no action");
  const reactText = candidate.characterResponses[0]?.segments.map((segment) => segment.content).join(" ") ?? "";
  assert.ok(reactText.includes("我在听"), "streamed react content is assembled");

  const validation = await orchestrator.validate({ plan, candidate });
  assert.equal(validation.accepted, true);
  const reviewRequest = chatRequests.find((request) =>
    (request.messages[0]?.content ?? "").includes("DM output reviewer")
  );
  assert.ok(reviewRequest, "reviewer request should be captured");
  assert.equal(reviewRequest!.thinking, "disabled");
  assert.equal(reviewRequest!.maxTokens, 512);
  assert.equal(reviewRequest!.timeoutMs, 45_000);
});

test("actor propose: tools request carries actor stage policy fields (chat transport)", async () => {
  let streamCalls = 0;
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      const system = request.messages[0]?.content ?? "";
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "确认密函当前可见状态",
          activatedCharacterInstanceIds: [SCOUT.characterInstanceId],
          narratorEnabled: true,
        });
      }
      if (system.includes("thinking only as the character")) {
        return {
          model: "fake-model",
          content: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      }
      if (system.includes("independent Narrator")) {
        return jsonResponse({
          environment: "冷雾沿石阶漫开。",
          storyBeat: "evidence_deepens_suspicion",
        });
      }
      if (system.includes("You speak only as the character")) {
        return jsonResponse({
          action: "塞娜退后半步。",
          dialogue: "“别碰那封蜡。”",
          recipientId: null,
        });
      }
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error("unexpected model call");
    },
    async *streamChat(request: ModelChatRequest) {
      streamCalls += 1;
      assert.ok(!request.tools, "tools 请求永不走 stream transport");
      // 分块但合起来是一个合法 JSON 对象（模拟真实流式增量；按调用方
      // 形态分发 narrator/react 输出）。
      const system = request.messages[0]?.content ?? "";
      const body = system.includes("You speak only as the character")
        ? { action: "塞娜退后半步。", dialogue: "“别碰那封蜡。”", recipientId: null }
        : { environment: "冷雾沿石阶漫开。", storyBeat: "evidence_deepens_suspicion" };
      const text = JSON.stringify(body);
      yield { content: text.slice(0, 12) };
      yield { content: text.slice(12) };
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const input = { turnId: "turn-actor-policy", playerText: "请塞娜留意蜡封。" };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  assert.ok(candidate);
  const propose = captured.find((request) =>
    (request.messages[0]?.content ?? "").includes("thinking only as the character"));
  assert.ok(propose, "actor propose 请求必须存在");
  assert.ok(propose.tools && propose.tools.length > 0, "actor 是 tools 请求");
  assert.equal(propose.thinking, "disabled", "actor 结构化链不负担推理开销");
  assert.equal(propose.maxTokens, 768, "actor maxTokens 与规划同源");
  assert.equal(propose.timeoutMs, 45_000, "actor timeoutMs 与结构化链同语义");
  assert.ok(streamCalls >= 0, "previewNlg 链按设计走 stream；tools 请求分流断言在 streamChat 内");
});
