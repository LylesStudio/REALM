import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";
import {
  createOpenAICompatibleGateway,
  ModelConfigurationError,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelGateway,
  type ModelProviderSettings,
} from "../modules/inference/public.ts";
import {
  createLocalModelSettingsStore,
  publicModelSettings,
} from "../modules/inference/local-settings.ts";
import {
  createModelDynamicDiscoveryGenerator,
  createModelPoweredM2TurnOrchestrator,
  createModelVisibilityAssessor,
  normalizeObservationDialogue,
} from "../modules/orchestration/public.ts";

const settings: ModelProviderSettings = {
  schemaVersion: 1,
  providerId: "lmstudio",
  baseUrl: "http://127.0.0.1:8823/v1",
  apiKey: "",
  selectedModel: "unsloth/gemma-4-12b-it-qat",
  thinking: "disabled",
  timeoutMs: 30_000,
  maxTokens: 2_048,
  availableModels: [],
  lastDiscoveredAt: null,
  updatedAt: "2026-08-13T10:00:00.000Z",
};

test("public settings never expose the local API key", () => {
  const publicSettings = publicModelSettings(settings);
  assert.equal("apiKey" in publicSettings, false);
  // 空 API key（本地 LM Studio 无需凭证）：公开设置不含任何密钥材料。
  assert.equal(publicSettings.apiKeyConfigured, false);
  assert.equal(publicSettings.apiKeyHint, null);
});

test("dynamic discovery generator grounds the model request in skill intent and public context", async () => {
  const prompts: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      prompts.push(request);
      return jsonResponse({
        subject: "浓雾",
        feature: "雾层旁的供水系统在无风处出现一条短暂变薄的窄带",
        nextCheck: "等待窄带再次出现并与远处雾笛对照",
      });
    },
  };
  const generator = createModelDynamicDiscoveryGenerator({
    getGateway: async () => gateway,
  });
  const discovery = await generator.generate({
    actor: {
      characterInstanceId: "character_player",
      participantId: "participant_player",
      displayName: "洛川",
    },
    call: {
      callId: "dynamic-discovery-model",
      name: "use_skill",
      arguments: {
        skillId: "any_skill",
        targetId: null,
        intent: "仔细观察浓雾",
      },
    },
    skill: {
      skillKey: "any_skill",
      title: "细致观察",
      description: "辨认当前目标的可观察变化。",
    },
    outcome: "partial",
    publicFact: "只确认了部分结果。",
    context: {
      worldName: "雾港",
      era: "停战纪元",
      summary: "港口在冷雾中维持秩序。",
      storyTitle: "无声钟的来客",
      premise: "灯塔在无风夜自行点亮。",
      location: "北防波堤",
      weather: "冷雾，无风",
      tension: "钟声已经响过三次",
      objective: "确认灯塔异常的来源",
      canon: "- 灯塔属于北岸守望会。",
      recentPublicEvents: ["雾笛在远处响过一次。"],
    },
  });
  assert.deepEqual(discovery, {
    subject: "浓雾",
    feature: "雾层旁的供水系统在无风处出现一条短暂变薄的窄带",
    nextCheck: "等待窄带再次出现并与远处雾笛对照",
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]?.messages[1]?.content ?? "", /仔细观察浓雾/);
  assert.match(prompts[0]?.messages[1]?.content ?? "", /雾笛在远处响过一次/);
});

test("internal observation wording never becomes character dialogue", () => {
  assert.equal(
    normalizeObservationDialogue("所得结果只应作为当前场景中的直接认知。"),
    null,
  );
  assert.equal(
    normalizeObservationDialogue("引擎外壳已经稳定，可以继续检查。"),
    "“引擎外壳已经稳定，可以继续检查。”",
  );
  assert.equal(
    normalizeObservationDialogue("当前没有出现足以推翻既有判断的新迹象。"),
    null,
  );
  assert.equal(
    normalizeObservationDialogue("你确认目标上有一处可复核的异常，但还不能判断它的来源。"),
    null,
  );
});

test("local defaults fail closed for an unregistered host or API path", async () => {
  const cases = [
    "http://127.0.0.1:9999/v1",
    "http://127.0.0.1:8823/api/v1",
  ];
  for (const baseUrl of cases) {
    const directory = await mkdtemp(join(tmpdir(), "realm-model-settings-"));
    try {
      const store = createLocalModelSettingsStore({
        filePath: join(directory, "provider.json"),
        environment: {
          REALM_MODEL_PROVIDER: "lmstudio",
          REALM_MODEL_BASE_URL: baseUrl,
          REALM_MODEL_API_KEY: "",
          REALM_MODEL_ID: "unsloth/gemma-4-12b-it-qat",
        },
      });
      await assert.rejects(
        store.load(),
        (error: unknown) => error instanceof ModelConfigurationError
          && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("OpenAI-compatible gateway: LAN discovery, structured chat, no empty Authorization, max_tokens floor", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const gateway = createOpenAICompatibleGateway({
    settings,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [
            { id: "unsloth/gemma-4-12b-it-qat", object: "model", owned_by: "local" },
          ],
        });
      }
      return Response.json({
        model: "unsloth/gemma-4-12b-it-qat",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [{
              id: "call-1",
              function: { name: "act", arguments: "{\"intent\":\"观察\"}" },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    },
  });
  assert.deepEqual((await gateway.discoverModels()).map((model) => model.id), [
    "unsloth/gemma-4-12b-it-qat",
  ]);
  const response = await gateway.chat({
    messages: [{ role: "user", content: "观察" }],
    tools: [{
      type: "function",
      function: {
        name: "act",
        description: "执行行动",
        parameters: { type: "object" },
      },
    }],
    maxTokens: 50,
  });
  assert.equal(response.toolCalls[0]?.name, "act");
  assert.deepEqual(response.toolCalls[0]?.arguments, { intent: "观察" });
  assert.equal(response.usage?.totalTokens, 14);
  // OpenAI-compatible base URL 含 /v1。
  assert.equal(requests[0]?.url, "http://127.0.0.1:8823/v1/models");
  assert.equal(requests[1]?.url, "http://127.0.0.1:8823/v1/chat/completions");
  // 空 apiKey 不发送 Authorization 头（本地服务无需凭证）。
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[1]?.init?.headers).get("Authorization"), null);
  // Gemma max_tokens 安全下限：小预算被抬到 1024，reasoning 不会吞空 content。
  const chatBody = JSON.parse(String(requests[1]?.init?.body)) as {
    max_tokens: number;
    thinking?: unknown;
  };
  assert.equal(chatBody.max_tokens, 1024);
  // 不伪装转发 DeepSeek 式 thinking 字段。
  assert.equal("thinking" in chatBody, false);
});

test("LM Studio Gemma 4 uses native reasoning control and filters reasoning output", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({
      model_instance_id: "unsloth/gemma-4-12b-it-qat",
      output: [
        { type: "reasoning", content: "private reasoning" },
        { type: "message", content: ["```json", '{"ok":true}', "```"].join("\n") },
      ],
      stats: { input_tokens: 10, total_output_tokens: 4, reasoning_output_tokens: 3 },
    });
  };
  const disabled = createOpenAICompatibleGateway({ settings, fetch: fetcher });
  const response = await disabled.chat({
    messages: [
      { role: "system", content: "只输出 JSON。" },
      { role: "user", content: "完成任务。" },
    ],
    responseFormat: "json_object",
    maxTokens: 50,
  });
  assert.equal(requests[0]?.url, "http://127.0.0.1:8823/api/v1/chat");
  assert.equal(requests[0]?.body.reasoning, "off");
  assert.equal(requests[0]?.body.max_output_tokens, 1024);
  assert.equal("response_format" in (requests[0]?.body ?? {}), false);
  assert.equal(response.content, '{"ok":true}');
  assert.equal(response.usage?.completionTokens, 4);

  const enabled = createOpenAICompatibleGateway({
    settings: { ...settings, thinking: "enabled" },
    fetch: fetcher,
  });
  await enabled.chat({
    messages: [{ role: "user", content: "完成任务。" }],
  });
  assert.equal(requests[1]?.body.reasoning, "on");
});

test("Gemma 4 tool requests keep the LM Studio compatibility contract", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const gateway = createOpenAICompatibleGateway({
    settings,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: settings.selectedModel,
        choices: [{ message: { content: "{}", tool_calls: [] }, finish_reason: "stop" }],
      });
    },
  });
  await gateway.chat({
    messages: [{ role: "user", content: "输出 JSON。" }],
    tools: [{
      type: "function",
      function: {
        name: "noop",
        description: "测试工具",
        parameters: { type: "object" },
      },
    }],
    responseFormat: "json_object",
  });
  assert.equal(requestUrl, "http://127.0.0.1:8823/v1/chat/completions");
  assert.deepEqual(requestBody.response_format, {
    type: "json_schema",
    json_schema: { name: "realm_structured_output", schema: { type: "object" } },
  });
});

test("OpenAI-compatible gateway exposes sentence-level stream chunks for M4 previews", async () => {
  const gateway = createOpenAICompatibleGateway({
    settings: { ...settings, selectedModel: "local/instruct" },
    async fetch() {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"第一句。"}}]}\n\n',
          ));
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"第二句！"}}]}\n\n',
          ));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const chunks = [];
  for await (const chunk of gateway.streamChat!({
    messages: [{ role: "user", content: "请输出两句。" }],
  })) {
    chunks.push(chunk.content);
  }
  assert.deepEqual(chunks, ["第一句。", "第二句！"]);
});

test("model-powered orchestration preserves DM, Character, Rule and Narrator authority", async () => {
  const prompts: ModelChatRequest[] = [];
  let narratorAttempts = 0;
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      prompts.push(request);
      const system = request.messages[0]?.content ?? "";
      if (request.tools) {
        return response({
          toolCalls: [{
            id: "provider-call-1",
            name: "use_skill",
            arguments: {
              skillId: "careful_observation",
              targetId: "letter_seal",
              intent: "辨认蜡封是否被动过",
            },
          }],
          finishReason: "tool_calls",
        });
      }
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "确认密函当前可见状态",
          activatedCharacterInstanceIds: ["scout-instance"],
          narratorEnabled: true,
        });
      }
      if (system.includes("independent Narrator")) {
        narratorAttempts += 1;
        return jsonResponse({
          environment: narratorAttempts === 1
            ? "谨慎的斥候将密函递向灯光。"
            : "冷雾沿石阶向上漫开。",
          storyBeat: "evidence_deepens_suspicion",
        });
      }
      if (system.includes("You speak only as the character")) {
        return jsonResponse({ action: "塞娜收回触碰蜡封的手。" });
      }
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error("Unexpected model call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
    recallMemory: async () => "- 塞娜此前见过完好的蜡封。",
    // 批次 T4：use_skill 提示词与校验按角色实际持有技能数据驱动。
    characterSkillProvider: {
      async listSkills(characterInstanceId) {
        return characterInstanceId === "scout-instance"
          ? [{
              skillKey: "careful_observation",
              title: "细致观察",
              description: "在不破坏目标的前提下辨认细微痕迹。",
            }]
          : [];
      },
    },
    actionResolver: createDeterministicActionResolver({
      randomInt: () => 19,
      allowStatefulReceipts: true,
      dynamicDiscoveryGenerator: {
        async generate(input) {
          assert.equal(input.call.arguments.intent, "辨认蜡封是否被动过");
          return {
            subject: "蜡封边缘的一处细痕",
            feature: "细痕横切原本连续的压纹，边缘比自然磨损更整齐",
            nextCheck: "沿压痕检查封蜡内侧和信纸折痕",
          };
        },
      },
    }),
  });
  const input = { turnId: "turn-model", playerText: "请塞娜看看蜡封。" };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  assert.equal(candidate.actionTransactions[0]?.origin, "character");
  assert.equal(candidate.actionTransactions[0]?.call.name, "use_skill");
  assert.equal(candidate.actionTransactions[0]?.receipt.resolution, "check");
  assert.equal(validation.accepted, true);
  assert.equal(narratorAttempts, 2);
  assert.deepEqual(candidate.narration?.segments.map((segment) => segment.kind), [
    "environment", "fact", "story",
  ]);
  assert.deepEqual(candidate.characterResponses[0]?.segments.map((segment) => segment.kind), [
    "action", "dialogue",
  ]);
  assert.equal(
    candidate.characterResponses[0]?.segments[1]?.content,
    "“蜡封边缘的一处细痕不对。细痕横切原本连续的压纹，边缘比自然磨损更整齐。沿着这条线索，沿压痕检查封蜡内侧和信纸折痕。”",
  );
  assert.doesNotMatch(
    JSON.stringify({ narration: candidate.narration, characters: candidate.characterResponses }),
    /d20|骰|检定|难度/i,
  );
  const characterProposal = prompts.find((prompt) => prompt.tools)?.messages ?? [];
  // Prompt System v2：角色身份来自调用时数据，进 user 的 [Character] 块；
  // system 只含静态 English 策略，不含动态角色名。
  assert.ok(characterProposal[1]?.content.includes("[Character]"));
  assert.ok(characterProposal[1]?.content.includes("塞娜"));
  assert.ok(!/[一-鿿]/.test(characterProposal[0]?.content ?? ""));
  assert.ok(characterProposal[1]?.content.includes("此前见过完好的蜡封"));
  assert.equal(characterProposal[0]?.content.includes("此前见过完好的蜡封"), false);
});

test("an explicit player action can complete under narration without forcing an AI interruption", async () => {
  const prompts: ModelChatRequest[] = [];
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      prompts.push(request);
      const system = request.messages[0]?.content ?? "";
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "呈现玩家观察密函的公开结果",
          activatedCharacterInstanceIds: [],
          narratorEnabled: true,
        });
      }
      if (system.includes("independent Narrator")) {
        return jsonResponse({
          environment: "冷雾沿石阶缓慢漫开。",
          storyBeat: "evidence_deepens_suspicion",
        });
      }
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error("Unexpected model call");
    },
  };
  const actor = {
    characterInstanceId: "player-instance",
    participantId: "player-participant",
    displayName: "洛川",
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
  const input = {
    turnId: "turn-player-action",
    playerText: "我先看看蜡封有没有被动过。",
    playerAction: {
      actor,
      call: {
        callId: "turn-player-action:player-instance:use-skill:1",
        name: "use_skill" as const,
        arguments: {
          skillId: "careful_observation",
          targetId: "letter_seal",
          intent: "辨认蜡封是否被动过",
        },
      },
    },
  };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  const validation = await orchestrator.validate({ plan, candidate });

  assert.equal(plan.activatedCharacters.length, 0);
  assert.equal(candidate.characterResponses.length, 0);
  assert.equal(candidate.actionTransactions.length, 1);
  assert.equal(candidate.actionTransactions[0]?.actor.characterInstanceId, "player-instance");
  assert.equal(validation.accepted, true);
  const dmPrompt = prompts.find((prompt) =>
    prompt.messages[0]?.content.includes("DM Controller")
  );
  assert.ok(dmPrompt?.messages[1]?.content.includes("[Player's authorized action]"));
  assert.equal(prompts.some((prompt) => prompt.tools !== undefined), false);
});

test("one stochastic DM disagreement triggers an independent confirmation instead of data loss", async () => {
  let reviewAttempts = 0;
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (request.tools) {
        return response({
          toolCalls: [{
            id: "provider-call-1",
            name: "act",
            arguments: { intent: "确认雾中的变化", targetId: "scene_surroundings", approach: "cautious" },
          }],
          finishReason: "tool_calls",
        });
      }
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "回应玩家的低声询问",
          activatedCharacterInstanceIds: ["scout-instance"],
          narratorEnabled: true,
        });
      }
      if (system.includes("independent Narrator")) {
        return jsonResponse({
          environment: "冷雾贴着防波堤缓慢流动。",
          storyBeat: "防波堤上的悬念尚未解除。",
        });
      }
      if (system.includes("You speak only as the character")) {
        return jsonResponse({ action: "塞娜侧耳听向雾中的灯塔。" });
      }
      if (system.includes("DM output reviewer")) {
        reviewAttempts += 1;
        return jsonResponse(reviewAttempts === 1
          ? { accepted: false, goalSatisfied: false, worldCompatible: false }
          : { accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error("Unexpected model call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
  const input = {
    turnId: "turn-advisory-review",
    playerText: "（我看向塞娜，压低声音）“你听见钟声了吗？”",
  };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  assert.equal(validation.accepted, true);
  assert.equal(validation.worldCompatible, true);
  assert.equal(reviewAttempts, 2);
  // 批次 T10-A：正常复核放行的审计标记（mode=model）。
  assert.deepEqual(validation.review, { mode: "model", vetoes: 1, reason: "accepted" });
});

/**
 * 批次 T10-A：三连否决降级。共享编排器搭架——fake gateway 的复核器行为
 * 由 reviewBehavior 注入；结构校验由真实 createRuleBasedDMController 执行。
 */
function createReviewProbeOrchestrator(
  reviewBehavior: "triple-veto" | "unavailable" | "invalid-json",
  calls?: { reviews: number },
) {
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (request.tools) {
        return response({
          toolCalls: [{
            id: "provider-call-1",
            name: "act",
            arguments: { intent: "确认雾中的变化", targetId: "scene_surroundings", approach: "cautious" },
          }],
          finishReason: "tool_calls",
        });
      }
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "回应玩家的低声询问",
          activatedCharacterInstanceIds: ["scout-instance"],
          narratorEnabled: true,
        });
      }
      if (system.includes("independent Narrator")) {
        return jsonResponse({
          environment: "冷雾贴着防波堤缓慢流动。",
          storyBeat: "防波堤上的悬念尚未解除。",
        });
      }
      if (system.includes("You speak only as the character")) {
        return jsonResponse({ action: "塞娜侧耳听向雾中的灯塔。" });
      }
      if (system.includes("DM output reviewer")) {
        if (calls) calls.reviews += 1;
        if (reviewBehavior === "unavailable") {
          throw new Error("model service offline");
        }
        if (reviewBehavior === "invalid-json") {
          return response({ content: "not-json-at-all", finishReason: "stop" });
        }
        return jsonResponse({
          accepted: false,
          goalSatisfied: false,
          worldCompatible: false,
        });
      }
      throw new Error("Unexpected model call");
    },
  };
  return createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
}

const reviewProbeInput = {
  turnId: "turn-review-degraded",
  playerText: "（我看向塞娜，压低声音）“你听见钟声了吗？”",
};

test("T10-A: three consistent model vetoes degrade deterministically instead of hanging the turn", async () => {
  const calls = { reviews: 0 };
  const orchestrator = createReviewProbeOrchestrator("triple-veto", calls);
  const plan = await orchestrator.plan(reviewProbeInput);
  const candidate = await orchestrator.draft({ ...reviewProbeInput, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  // 不抛 DM_OUTPUT_REJECTED；确定性降级接受 + 审计标记（不伪装成复核成功）。
  assert.equal(validation.accepted, true);
  assert.deepEqual(validation.review, {
    mode: "degraded",
    vetoes: 3,
    reason: "triple-veto",
  });
  // 降级有界：仍恰 3 次复核，无额外重试。
  assert.equal(calls.reviews, 3);
});

test("T10-A: review gateway unavailable degrades with a distinct auditable reason", async () => {
  const orchestrator = createReviewProbeOrchestrator("unavailable");
  const plan = await orchestrator.plan(reviewProbeInput);
  const candidate = await orchestrator.draft({ ...reviewProbeInput, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  assert.equal(validation.accepted, true);
  assert.deepEqual(validation.review, {
    mode: "degraded",
    vetoes: 0,
    reason: "review-unavailable",
  });
});

test("T10-A: persistently malformed review JSON degrades with invalid-json reason", async () => {
  const calls = { reviews: 0 };
  const orchestrator = createReviewProbeOrchestrator("invalid-json", calls);
  const plan = await orchestrator.plan(reviewProbeInput);
  const candidate = await orchestrator.draft({ ...reviewProbeInput, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  assert.equal(validation.accepted, true);
  assert.deepEqual(validation.review, {
    mode: "degraded",
    vetoes: 0,
    reason: "invalid-json",
  });
  // Prompt System v2：每轮复核内部带恰好一次格式 repair——
  // 两轮复核 ×（初次 + repair）= 恰 4 次复核调用，持续损坏即降级。
  assert.equal(calls.reviews, 4);
});

test("T10-A: structural validation failure stays fail-closed and never reaches review", async () => {
  const calls = { reviews: 0 };
  const orchestrator = createReviewProbeOrchestrator("triple-veto", calls);
  const plan = await orchestrator.plan(reviewProbeInput);
  const candidate = await orchestrator.draft({ ...reviewProbeInput, plan });
  // 破坏候选结构：删掉被激活角色的回应——结构硬门必须先于复核拒绝。
  const broken = { ...candidate, characterResponses: [] };
  await assert.rejects(
    orchestrator.validate({ plan, candidate: broken }),
    (error: unknown) =>
      error instanceof Error
      && (error as { code?: string }).code === "DM_OUTPUT_INCOMPLETE",
  );
  assert.equal(calls.reviews, 0, "review is never consulted on structural failure");
});

test("plain dialogue activates a character without inventing an Actor Tool requirement", async () => {
  const calls: ModelChatRequest[] = [];
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      calls.push(request);
      const system = request.messages[0]?.content ?? "";
      if (system.includes("DM Controller")) {
        return jsonResponse({
          goal: "回应玩家的自然询问",
          activatedCharacterInstanceIds: [],
          narratorEnabled: false,
        });
      }
      if (request.tools) return jsonResponse({ respondOnly: true });
      if (system.includes("natural exchange")) {
        return jsonResponse({
          action: "塞娜将目光转向洛川。",
          dialogue: "我能听见。",
        });
      }
      if (system.includes("DM output reviewer")) {
        return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
      }
      throw new Error("Unexpected model call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
  const input = {
    turnId: "turn-plain-dialogue",
    playerText: "你能听到我说话吗？",
  };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  const validation = await orchestrator.validate({ plan, candidate });
  assert.deepEqual(plan.activatedCharacters.map((character) => character.displayName), ["塞娜"]);
  assert.equal(plan.actionBudgetPerCharacter, 0);
  assert.equal(candidate.actionTransactions.length, 0);
  assert.equal(candidate.narration, null);
  assert.deepEqual(candidate.characterResponses[0]?.segments.map((segment) => segment.kind), [
    "action", "dialogue",
  ]);
  assert.equal(candidate.characterResponses[0]?.segments[1]?.content, "“我能听见。”");
  assert.equal(validation.accepted, true);
  assert.equal(calls.some((request) => request.tools !== undefined), false);
});

test("DM visibility assessment keeps an explicit secret within the named audience", async () => {
  const requests: ModelChatRequest[] = [];
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat(request) {
      requests.push(request);
      return jsonResponse({
        visibility: "restricted",
        audienceCharacterInstanceIds: ["scout-instance"],
        reason: "玩家明确要求不要让其他人听到。",
      });
    },
  };
  const assessor = createModelVisibilityAssessor({
    player: {
      characterInstanceId: "player-instance",
      participantId: "player-participant",
      displayName: "洛川",
    },
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
  const assessment = await assessor.assess({
    playerText: "我悄悄跟她说：不要让其他人听到",
  });
  assert.deepEqual(assessment.visibility, {
    kind: "restricted",
    domainId: "secret:player-instance:scout-instance",
    audienceCharacterInstanceIds: ["player-instance", "scout-instance"],
  });
  assert.match(assessment.reason, /其他/);
  assert.equal(requests.length, 1);
});

test("ambiguous restricted output stays private to the player instead of hard-failing", async () => {
  const fakeGateway: ModelGateway = {
    async discoverModels() { return []; },
    async chat() {
      return jsonResponse({
        visibility: "restricted",
        audienceCharacterInstanceIds: [],
        reason: "玩家说想私下确认，但没有点名听者。",
      });
    },
  };
  const assessor = createModelVisibilityAssessor({
    player: {
      characterInstanceId: "player-instance",
      participantId: "player-participant",
      displayName: "洛川",
    },
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => fakeGateway,
  });
  const assessment = await assessor.assess({ playerText: "我想私下确认一件事" });
  assert.deepEqual(assessment.visibility, {
    kind: "restricted",
    domainId: "secret:player-instance",
    audienceCharacterInstanceIds: ["player-instance"],
  });
  assert.match(assessment.reason, /仅玩家可见/);
});

function response(overrides: Partial<ModelChatResponse>): ModelChatResponse {
  return {
    model: "deepseek-v4-flash",
    content: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    ...overrides,
  };
}

function jsonResponse(value: unknown): ModelChatResponse {
  return response({ content: JSON.stringify(value) });
}
