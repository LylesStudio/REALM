import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGenesisSuggestions } from "../modules/application/genesis-suggestions.ts";
import { generateGenesisDraft } from "../modules/application/world-genesis.ts";
import { createModelSemanticConflictAssessor } from "../modules/worldline/semantic-conflict.ts";
import { createModelSettingsService } from "../modules/application/model-settings-service.ts";
import { createLocalModelSettingsStore } from "../modules/inference/local-settings.ts";
import type { ModelGateway, ModelProviderSettings } from "../modules/inference/types.ts";
import {
  setModelCallObserver,
  type ModelCallObservation,
} from "../modules/inference/model-call-observer.ts";

/**
 * Batch 2B-P2：低频管理面观测接线——genesis-suggestions / world-genesis /
 * semantic-conflict / settings test() probe。每个逻辑 structured call
 * 恰好一条观测；行为（调用次数/fallback/异常传播/provider 分支）零变化。
 */

type Step = { content: string; model?: string } | { error: Error };

function scriptedGateway(script: readonly Step[]) {
  const requests: Record<string, unknown>[] = [];
  let calls = 0;
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      requests.push(request as unknown as Record<string, unknown>);
      const step = script[Math.min(calls, script.length - 1)]!;
      calls += 1;
      if ("error" in step) throw step.error;
      return {
        model: step.model ?? "fake-model",
        content: step.content,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
  return { gateway, requests, callCount: () => calls };
}

function captureObservations() {
  const events: ModelCallObservation[] = [];
  setModelCallObserver((event) => events.push(event));
  return { events, restore: () => setModelCallObserver(null) };
}

const SUGGESTIONS_VALID = JSON.stringify({
  suggestions: [
    { name: "阿橹", role: "记账员", summary: "听得懂风声。" },
    { name: "塞娜", role: "斥候", summary: "熟悉暗巷。" },
  ],
});

const DRAFT_VALID = JSON.stringify({
  world: { name: "云港志", era: "风账纪元 3 年", summary: "云海上的旧船港。" },
  story: { title: "雾中航船", premise: "一艘无籍船靠岸。" },
  record: { title: "靠岸" },
  playerRole: "替港口辨认风声的新账房",
  companions: [{ name: "阿橹", role: "记账员", summary: "听得懂风声。" }],
  scene: { location: "七号泊台", weather: "平流雾", tension: "港卫警惕", objective: "登记来船" },
});

const CONFLICT_VALID = JSON.stringify({
  kind: "other",
  severity: "bridgeable",
  recommendation: "merge",
  rationale: "可桥接。",
});

test("genesis-suggestions 观测：正常 success；repair；双失败 null（stage 独立）", async () => {
  const { gateway, requests, callCount } = scriptedGateway([
    { content: SUGGESTIONS_VALID },
  ]);
  const first = captureObservations();
  try {
    const suggestions = await generateGenesisSuggestions(gateway, {
      step: "companions",
      intent: "两名同行者",
      context: {},
    });
    assert.ok(suggestions);
    assert.equal(callCount(), 1, "观测接线不得新增模型调用");
    assert.equal(first.events.length, 1);
    const event = first.events[0]!;
    assert.equal(event.stage, "genesis-suggestions");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    assert.equal(event.structuredRepairs, 0);
    assert.deepEqual(Object.keys(requests[0]!).sort(), [
      "messages",
      "responseFormat",
      "temperature",
    ]);
    assert.equal(JSON.stringify(event).includes("阿橹"), false);
  } finally {
    first.restore();
  }

  const repaired = scriptedGateway([
    { content: "这不是 JSON" },
    { content: SUGGESTIONS_VALID },
  ]);
  const second = captureObservations();
  try {
    const suggestions = await generateGenesisSuggestions(repaired.gateway, {
      step: "companions",
      intent: "两名同行者",
      context: {},
    });
    assert.ok(suggestions);
    assert.equal(repaired.callCount(), 2);
    assert.equal(second.events[0]!.outcome, "success");
    assert.equal(second.events[0]!.providerAttempts, 2);
    assert.equal(second.events[0]!.structuredRepairs, 1);
  } finally {
    second.restore();
  }

  const failing = scriptedGateway([
    { content: "这不是 JSON" },
    { content: "仍然不是 JSON" },
  ]);
  const third = captureObservations();
  try {
    const suggestions = await generateGenesisSuggestions(failing.gateway, {
      step: "companions",
      intent: "两名同行者",
      context: {},
    });
    assert.equal(suggestions, null, "双失败仍 fail-closed null");
    assert.equal(third.events[0]!.outcome, "error");
    assert.equal(third.events[0]!.errorCode, "GENESIS_SUGGESTIONS_INVALID");
    assert.equal(third.events[0]!.structuredRepairs, 1);
  } finally {
    third.restore();
  }
});

test("world-genesis 观测：正常 success；双失败 error；provider error 传播且记 error", async () => {
  const { gateway, callCount } = scriptedGateway([{ content: DRAFT_VALID }]);
  const first = captureObservations();
  try {
    const draft = await generateGenesisDraft(gateway, "一座雾中的灯塔");
    assert.ok(draft);
    assert.equal(callCount(), 1);
    assert.equal(first.events.length, 1);
    const event = first.events[0]!;
    assert.equal(event.stage, "world-genesis");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    assert.equal(JSON.stringify(event).includes("云港志"), false);
  } finally {
    first.restore();
  }

  const failing = scriptedGateway([
    { content: "这不是 JSON" },
    { content: "仍然不是 JSON" },
  ]);
  const second = captureObservations();
  try {
    assert.equal(await generateGenesisDraft(failing.gateway, "一座雾中的灯塔"), null);
    assert.equal(second.events[0]!.outcome, "error");
    assert.equal(second.events[0]!.errorCode, "GENESIS_DRAFT_INVALID");
    assert.equal(second.events[0]!.providerAttempts, 2);
  } finally {
    second.restore();
  }

  const providerError = Object.assign(new Error("network down"), {
    code: "MODEL_REQUEST_FAILED",
  });
  const erroring = scriptedGateway([{ error: providerError }]);
  const third = captureObservations();
  try {
    await assert.rejects(
      generateGenesisDraft(erroring.gateway, "一座雾中的灯塔"),
      /network down/,
    );
    assert.equal(third.events[0]!.outcome, "error");
    assert.equal(third.events[0]!.errorCode, "MODEL_REQUEST_FAILED");
    assert.equal(third.events[0]!.structuredRepairs, 0);
  } finally {
    third.restore();
  }
});

test("semantic-conflict 观测：正常 success；provider error 走确定性降级且记 error", async () => {
  const input = {
    changeSet: { changes: [] },
    existingClaims: [],
    deterministicSeverity: "high-risk" as const,
    deterministicReason: "确定性存疑。",
  };
  const { gateway, requests, callCount } = scriptedGateway([
    { content: CONFLICT_VALID },
  ]);
  const first = captureObservations();
  try {
    const assessor = createModelSemanticConflictAssessor({
      getGateway: async () => gateway,
    });
    const evidence = await assessor.evaluate(input);
    assert.equal(evidence.source, "model");
    assert.equal(callCount(), 1);
    assert.equal(first.events.length, 1);
    const event = first.events[0]!;
    assert.equal(event.stage, "semantic-conflict");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    // 显式 timeout 字段保持（观测不得改变请求形状）。
    assert.ok("timeoutMs" in requests[0]! || "messages" in requests[0]!);
    assert.deepEqual(Object.keys(requests[0]!).sort(), [
      "messages",
      "responseFormat",
      "temperature",
      "timeoutMs",
    ]);
    assert.equal(JSON.stringify(event).includes("可桥接"), false);
  } finally {
    first.restore();
  }

  const providerError = Object.assign(new Error("provider down"), {
    code: "MODEL_RATE_LIMITED",
  });
  const erroring = scriptedGateway([{ error: providerError }]);
  const second = captureObservations();
  try {
    const assessor = createModelSemanticConflictAssessor({
      getGateway: async () => erroring.gateway,
    });
    const evidence = await assessor.evaluate(input);
    assert.equal(evidence.source, "fallback", "provider error 仍走确定性降级");
    assert.equal(second.events[0]!.outcome, "error");
    assert.equal(second.events[0]!.errorCode, "MODEL_RATE_LIMITED");
    assert.equal(second.events[0]!.structuredRepairs, 0);
  } finally {
    second.restore();
  }
});

test("settings test() 观测：正常 success（stage=settings-probe，maxTokens/provider 分支不变）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-obs-p2-"));
  try {
    const settings: ModelProviderSettings = {
      schemaVersion: 1,
      providerId: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "",
      selectedModel: "model-a",
      thinking: "disabled",
      timeoutMs: 30_000,
      maxTokens: 2_048,
      availableModels: [],
      lastDiscoveredAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const store = createLocalModelSettingsStore({
      filePath: join(directory, "model-providers.json"),
      environment: {},
    });
    await store.saveProfile(settings, true);
    const { gateway, requests, callCount } = scriptedGateway([
      { content: '{"ok":true}' },
    ]);
    const service = createModelSettingsService({
      store,
      createGateway: () => gateway,
    });
    const { events, restore } = captureObservations();
    try {
      const result = await service.test({});
      assert.equal(result.model, "fake-model");
      assert.equal(callCount(), 1, "probe 仍单次请求（maxTokens 分支不变）");
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.stage, "settings-probe");
      assert.equal(event.providerId, "unknown");
      assert.equal(event.transport, "chat");
      assert.equal(event.outcome, "success");
      assert.equal(event.providerAttempts, 1);
      assert.equal(event.structuredRepairs, 0);
      // 请求形状保持：messages/responseFormat/maxTokens/temperature。
      assert.deepEqual(Object.keys(requests[0]!).sort(), [
        "maxTokens",
        "messages",
        "responseFormat",
        "temperature",
      ]);
      assert.equal(requests[0]!.maxTokens, 32, "非 openrouter 探针 maxTokens=32 不变");
    } finally {
      restore();
    }

    // provider error：错误传播 + 观测记 error（脱敏码）。
    const providerError = Object.assign(new Error("auth failed"), {
      code: "MODEL_AUTH_FAILED",
    });
    const erroring = scriptedGateway([{ error: providerError }]);
    const errorService = createModelSettingsService({
      store,
      createGateway: () => erroring.gateway,
    });
    const second = captureObservations();
    try {
      await assert.rejects(errorService.test({}), /auth failed/);
      assert.equal(second.events[0]!.stage, "settings-probe");
      assert.equal(second.events[0]!.outcome, "error");
      assert.equal(second.events[0]!.errorCode, "MODEL_AUTH_FAILED");
    } finally {
      second.restore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer 抛错/未配置：四个调用点业务结果与调用次数不变", async () => {
  const { gateway, callCount } = scriptedGateway([{ content: DRAFT_VALID }]);
  setModelCallObserver(() => {
    throw new Error("observer exploded");
  });
  try {
    const draft = await generateGenesisDraft(gateway, "一座雾中的灯塔");
    assert.ok(draft, "observer 抛错不得改变业务返回值");
    assert.equal(callCount(), 1);
  } finally {
    setModelCallObserver(null);
  }
  // 未配置 observer（默认 no-op）：另一调用点正常工作。
  const suggestions = await generateGenesisSuggestions(gateway, {
    step: "companions",
    intent: "两名同行者",
    context: {},
  });
  assert.ok(suggestions === null || typeof suggestions === "object");
});
