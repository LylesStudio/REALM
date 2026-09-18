import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatibleGateway } from "../modules/inference/openai-compatible-gateway.ts";
import { createLocalModelSettingsStore } from "../modules/inference/local-settings.ts";
import { createModelSettingsService } from "../modules/application/model-settings-service.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";
import { createSceneCrystallizer } from "../modules/application/scene-crystallization.ts";
import { generateGenesisChatReply } from "../modules/application/genesis-chat.ts";
import {
  createBoundedModelCallLedger,
  setModelCallObserver,
} from "../modules/inference/model-call-observer.ts";
import type {
  ModelChatResponse,
  ModelGateway,
  ModelProviderSettings,
} from "../modules/inference/types.ts";

/**
 * provider/profile 观测身份线程化（方案 A）：gateway 构造时盖章 catalog
 * 枚举 providerId；各 observation 点读取；未盖章 fake 回退 unknown；
 * 事件不含 baseUrl/apiKey/settings 对象。
 */

function settings(providerId: "lmstudio" | "openrouter", model: string): ModelProviderSettings {
  return {
    schemaVersion: 1,
    providerId,
    baseUrl: providerId === "lmstudio"
      ? "http://127.0.0.1:1234/v1"
      : "https://openrouter.ai/api/v1",
    apiKey: providerId === "openrouter" ? "test-key" : "",
    selectedModel: model,
    thinking: "disabled",
    timeoutMs: 30_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
  };
}

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
} as const;

function stampedTurnGateway(providerId: "lmstudio" | "openrouter"): ModelGateway {
  return {
    providerId,
    async discoverModels() {
      return [];
    },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (request.tools) return jsonResponse({});
      if (system.includes("information visibility")) {
        return jsonResponse({ visibility: "public", reason: "ordinary" });
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
    async *streamChat() {
      yield { content: '{"action":"塞娜侧耳。","dialogue":"我在听。","recipientId":null}' };
    },
  };
}

test("createOpenAICompatibleGateway 构造时盖章 catalog providerId（不暴露 settings）", () => {
  const lmstudio = createOpenAICompatibleGateway({
    settings: settings("lmstudio", "model-a"),
  });
  assert.equal(lmstudio.providerId, "lmstudio");
  const openrouter = createOpenAICompatibleGateway({
    settings: settings("openrouter", "model-b"),
  });
  assert.equal(openrouter.providerId, "openrouter");
  // gateway 对象不得携带 baseUrl/apiKey/settings 对象。
  for (const gateway of [lmstudio, openrouter]) {
    const keys = Object.keys(gateway);
    assert.ok(!keys.includes("apiKey") && !keys.includes("baseUrl") && !keys.includes("settings"));
    const serialized = JSON.stringify(gateway);
    assert.ok(!serialized.includes("test-key"));
    assert.ok(!serialized.includes("127.0.0.1"), "事件不得携带端点地址");
    assert.ok(!serialized.includes("openrouter.ai"));
  }
});

test("model-powered 整回合各 stage 观测流过盖章 providerId；未盖章回退 unknown", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 32 });
  setModelCallObserver(ledger.observer);
  try {
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => stampedTurnGateway("lmstudio"),
    });
    const input = { turnId: "turn-identity", playerText: "你在吗？" };
    const plan = await orchestrator.plan(input);
    const candidate = await orchestrator.draft({ ...input, plan });
    await orchestrator.validate({ plan, candidate });
  } finally {
    setModelCallObserver(null);
  }
  const stages = new Set(ledger.entries.map((entry) => entry.stage));
  for (const stage of ["classifier", "planner", "actor", "previewNlg"]) {
    assert.ok(stages.has(stage), `缺少 ${stage} 观测`);
  }
  for (const entry of ledger.entries) {
    assert.equal(entry.providerId, "lmstudio", `${entry.stage} 必须流过盖章 providerId`);
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("apiKey"));
    assert.ok(!serialized.includes("baseUrl"));
    assert.ok(!serialized.includes("127.0.0.1"), "事件不得携带端点地址");
  }
});

test("直连调用点（抽样 crystallizer）观测流过盖章 providerId", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 8 });
  setModelCallObserver(ledger.observer);
  try {
    const gateway: ModelGateway = {
      providerId: "openrouter",
      async discoverModels() {
        return [];
      },
      async chat() {
        return jsonResponse({ location: "灯塔值房" });
      },
    };
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => gateway,
    });
    const extraction = await crystallizer.extract({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: {
        worldName: "烬海诸国",
        era: "停战纪元 17 年",
        displayTime: "入夜",
        location: "防波堤",
        weather: "冷雾",
        tension: "钟声三响",
        objective: "拆信",
      },
    });
    assert.ok(extraction?.delta);
  } finally {
    setModelCallObserver(null);
  }
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0]!.stage, "crystallization-extract");
  assert.equal(ledger.entries[0]!.providerId, "openrouter");
});

test("genesis fallback ladder：providerId 恒定、model 可变、attempts 不变", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 8 });
  setModelCallObserver(ledger.observer);
  try {
    let calls = 0;
    const script = ["   ", "", JSON.stringify({
      reply: "雾从何来？",
      phase: "exploring",
      draftPatch: null,
    })];
    const gateway: ModelGateway = {
      providerId: "openrouter",
      async discoverModels() {
        return [];
      },
      async chat() {
        const content = script[Math.min(calls, script.length - 1)]!;
        calls += 1;
        return {
          model: calls >= 3 ? "deepseek-v4-pro" : "fake-model",
          content,
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };
    const outcome = await generateGenesisChatReply(gateway, {
      message: "一座雾港",
      transcript: [],
      draft: null,
      fallbackModel: "deepseek-v4-pro",
    });
    assert.ok(outcome);
    assert.equal(calls, 3, "阶梯调用次数不变");
  } finally {
    setModelCallObserver(null);
  }
  assert.equal(ledger.entries.length, 1);
  const event = ledger.entries[0]!;
  assert.equal(event.providerId, "openrouter", "fallback 只换 model，provider 恒定");
  assert.equal(event.model, "deepseek-v4-pro");
  assert.equal(event.providerAttempts, 3, "attempts 计数口径不变");
});

test("settings probe 归因候选 provider；cache 重建后 active 身份跟随新 snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-provider-id-"));
  try {
    const store = createLocalModelSettingsStore({
      filePath: join(directory, "model-providers.json"),
      environment: {},
    });
    await store.saveProfile(settings("lmstudio", "model-a"), true);
    await store.saveProfile(settings("openrouter", "model-b"), false);

    // 真实工厂：构造不触网，盖章来自 settings。
    const service = createModelSettingsService({ store });
    const active = await service.gateway();
    assert.equal(active.providerId, "lmstudio");

    // probe 候选 openrouter（active 是 lmstudio）：观测归因候选。
    const probeLedger = createBoundedModelCallLedger({ capacity: 8 });
    const probeGateway: ModelGateway = {
      providerId: "openrouter",
      async discoverModels() {
        return [];
      },
      async chat() {
        return jsonResponse({ ok: true });
      },
    };
    const probeService = createModelSettingsService({
      store,
      createGateway: () => probeGateway,
    });
    setModelCallObserver(probeLedger.observer);
    try {
      await probeService.test({ providerId: "openrouter" });
    } finally {
      setModelCallObserver(null);
    }
    assert.equal(probeLedger.entries.length, 1);
    assert.equal(probeLedger.entries[0]!.stage, "settings-probe");
    assert.equal(
      probeLedger.entries[0]!.providerId,
      "openrouter",
      "probe 必须归因候选 provider，而非 active",
    );

    // activate 切换后：新 gateway 身份跟随；旧实例不被重标记。
    await store.activate("openrouter");
    const switched = await service.gateway();
    assert.equal(switched.providerId, "openrouter", "activate 后 cache 重建，身份跟随新 snapshot");
    assert.equal(active.providerId, "lmstudio", "旧实例保持原身份，不被错误重标记");
    assert.notEqual(active, switched);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
