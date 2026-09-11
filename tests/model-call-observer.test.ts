import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";
import {
  createBoundedModelCallLedger,
  setModelCallObserver,
  type ModelCallObservation,
} from "../modules/inference/model-call-observer.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";

/**
 * Cleanup Phase 4 / Batch 2B：隐私安全的模型调用观测出口。
 * 证明：元数据完整（stage/transport/耗时/usage/finishReason/重试计数）、
 * 脱敏（无内容字段）、有界、observer 异常被隔离、计数口径不混淆、
 * 未配置时行为完全不变。
 */

const PLAYER_TEXT_SENTINEL = "玩家这句原文绝不能出现在观测里";
const SYSTEM_SENTINEL = "presence gate";

function jsonResponse(
  value: unknown,
  usage: ModelChatResponse["usage"] = { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage,
  };
}

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
} as const;

function turnGateway(options: {
  onChat?: (request: ModelChatRequest) => ModelChatResponse;
  streamScript?: string[];
}): ModelGateway {
  const streamScript = [...(options.streamScript ?? [])];
  return {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      if (options.onChat) return options.onChat(request);
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
      const next = streamScript.shift() ?? '{"action":"塞娜侧耳。","dialogue":"我在听。","recipientId":null}';
      yield { content: next };
    },
  };
}

function withObserver<T>(observer: (event: ModelCallObservation) => void, run: () => Promise<T>): Promise<T> {
  setModelCallObserver(observer);
  return run().finally(() => setModelCallObserver(null));
}

test("observer receives sanitized metadata for every stage of a turn", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 32 });
  await withObserver(ledger.observer, async () => {
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => turnGateway({}),
    });
    const input = { turnId: "turn-observe", playerText: PLAYER_TEXT_SENTINEL };
    const plan = await orchestrator.plan(input);
    const candidate = await orchestrator.draft({ ...input, plan });
    await orchestrator.validate({ plan, candidate });
  });

  const stages = ledger.entries.map((entry) => entry.stage);
  assert.ok(stages.includes("classifier"), "visibility/reviewer are classifier stages");
  assert.ok(stages.includes("planner"));
  assert.ok(stages.includes("actor"));
  assert.ok(stages.includes("previewNlg"));

  for (const entry of ledger.entries) {
    assert.ok(entry.requestId.startsWith("mc_"));
    assert.ok(entry.elapsedMs >= 0);
    assert.equal(entry.outcome, "success");
    assert.equal(entry.providerId, "unknown");
    assert.ok(entry.providerAttempts >= 1);
    assert.equal(entry.structuredRepairs, 0);
  }
  const planner = ledger.entries.find((entry) => entry.stage === "planner");
  assert.equal(planner?.transport, "chat");
  assert.deepEqual(planner?.usage, { promptTokens: 3, completionTokens: 5, totalTokens: 8 });
  assert.equal(planner?.finishReason, "stop");
  const react = ledger.entries.find((entry) => entry.stage === "previewNlg");
  assert.equal(react?.transport, "stream");

  // 脱敏：序列化事件不得包含消息内容、玩家原文、连接信息或密钥形态。
  const serialized = JSON.stringify(ledger.entries);
  assert.ok(!serialized.includes(PLAYER_TEXT_SENTINEL));
  assert.ok(!serialized.includes(SYSTEM_SENTINEL));
  for (const forbidden of ["messages", "Authorization", "apiKey", "baseUrl", "example.test", "Bearer"]) {
    assert.ok(!serialized.includes(forbidden), `serialized observation must not contain ${forbidden}`);
  }
});

test("structured repair and transport retries are counted, never merged", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 16 });
  await withObserver(ledger.observer, async () => {
    const gateway = turnGateway({
      streamScript: ["", "", ""], // 空流 ×3 → 回退 chat（providerAttempts 应为 4）
      onChat: (request) => {
        const system = request.messages[0]?.content ?? "";
        if (request.tools) return jsonResponse({});
        if (system.includes("natural exchange")) {
          return jsonResponse({ action: "塞娜侧耳。", dialogue: "我在听。", recipientId: null });
        }
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
        throw new Error("unexpected");
      },
    });
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    const input = { turnId: "turn-retry-count", playerText: "你在吗？" };
    const plan = await orchestrator.plan(input);
    await orchestrator.draft({ ...input, plan });
  });
  const react = ledger.entries.find((entry) => entry.stage === "previewNlg");
  assert.ok(react);
  assert.equal(react!.transport, "stream");
  assert.equal(react!.providerAttempts, 4, "3 empty streams + chat fallback must all be counted");
  assert.equal(react!.structuredRepairs, 0);
});

test("structured repair count and failure kinds are reported without content", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 16 });
  let calls = 0;
  await withObserver(ledger.observer, async () => {
    const gateway = turnGateway({
      onChat: () => {
        calls += 1;
        if (calls === 1) {
          return {
            model: "fake-model",
            content: "not json at all",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
        }
        return jsonResponse({ visibility: "public", reason: "ordinary" });
      },
    });
    const { createModelVisibilityAssessor } = await import("../modules/orchestration/model-powered.ts");
    const assessor = createModelVisibilityAssessor({
      player: {
        characterInstanceId: "player-instance",
        participantId: "player-participant",
        displayName: "玩家",
      },
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    const result = await assessor.assess({ playerText: "测试" });
    assert.equal(result.visibility.kind, "public");
  });
  assert.equal(ledger.entries.length, 1);
  const event = ledger.entries[0]!;
  assert.equal(event.structuredRepairs, 1);
  assert.equal(event.providerAttempts, 2);
  assert.deepEqual([...event.structuredFailureKinds], ["unparseable"]);
  assert.equal(event.outcome, "success");
});

test("bounded ledger drops the oldest entries and observer failures are isolated", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 3 });
  for (let index = 0; index < 7; index += 1) {
    ledger.observer({
      requestId: `mc_${index}`,
      stage: "classifier",
      providerId: "unknown",
      model: null,
      transport: "chat",
      elapsedMs: 1,
      usage: null,
      finishReason: null,
      providerAttempts: 1,
      structuredRepairs: 0,
      structuredFailureKinds: [],
      outcome: "success",
    });
  }
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.entries[0]!.requestId, "mc_4");

  await withObserver(
    () => {
      throw new Error("observer boom");
    },
    async () => {
      const gateway = turnGateway({});
      const { createModelVisibilityAssessor } = await import("../modules/orchestration/model-powered.ts");
      const assessor = createModelVisibilityAssessor({
        player: {
          characterInstanceId: "player-instance",
          participantId: "player-participant",
          displayName: "玩家",
        },
        characters: [SCOUT],
        getGateway: async () => gateway,
      });
      const result = await assessor.assess({ playerText: "测试" });
      assert.equal(result.visibility.kind, "public", "observer failure must not change the result");
    },
  );
});

test("default no-op observer keeps behavior unchanged", async () => {
  setModelCallObserver(null);
  const gateway = turnGateway({});
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const input = { turnId: "turn-noop", playerText: "你在吗？" };
  const plan = await orchestrator.plan(input);
  const candidate = await orchestrator.draft({ ...input, plan });
  assert.ok(candidate.characterResponses.length > 0);
});

test("follow-up: two consecutive structured failures record error terminal and one repair", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 16 });
  await withObserver(ledger.observer, async () => {
    const gateway = turnGateway({
      onChat: () => ({
        model: "fake-model",
        content: "still not json",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      }),
    });
    const { createModelVisibilityAssessor } = await import("../modules/orchestration/model-powered.ts");
    const assessor = createModelVisibilityAssessor({
      player: {
        characterInstanceId: "player-instance",
        participantId: "player-participant",
        displayName: "玩家",
      },
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    await assert.rejects(
      assessor.assess({ playerText: PLAYER_TEXT_SENTINEL }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "DM_VISIBILITY_INVALID",
    );
  });
  assert.equal(ledger.entries.length, 1);
  const event = ledger.entries[0]!;
  assert.equal(event.outcome, "error", "a null structured result is not a success");
  assert.equal(event.errorCode, "DM_VISIBILITY_INVALID");
  assert.equal(event.structuredRepairs, 1, "the failed second attempt is exactly one repair");
  assert.deepEqual([...event.structuredFailureKinds], ["unparseable", "unparseable"]);
  assert.equal(event.providerAttempts, 2, "both real gateway requests are counted");
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    PLAYER_TEXT_SENTINEL,
    "messages",
    "Authorization",
    "apiKey",
    "baseUrl",
    "example.test",
    "Bearer",
    "still not json",
  ]) {
    assert.ok(!serialized.includes(forbidden), `observation must not contain ${forbidden}`);
  }
});

test("follow-up: provider error during repair counts one repair and stays error", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 16 });
  let calls = 0;
  await withObserver(ledger.observer, async () => {
    const gateway = turnGateway({
      onChat: () => {
        calls += 1;
        if (calls === 1) {
          return {
            model: "fake-model",
            content: "not json at all",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
        }
        throw new Error("provider unavailable");
      },
    });
    const { createModelVisibilityAssessor } = await import("../modules/orchestration/model-powered.ts");
    const assessor = createModelVisibilityAssessor({
      player: {
        characterInstanceId: "player-instance",
        participantId: "player-participant",
        displayName: "玩家",
      },
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    await assert.rejects(assessor.assess({ playerText: "测试" }));
  });
  assert.equal(ledger.entries.length, 1);
  const event = ledger.entries[0]!;
  assert.equal(event.outcome, "error");
  assert.equal(event.errorCode, "MODEL_PROVIDER_STEP_FAILED");
  assert.equal(event.structuredRepairs, 1, "the repair request happened even though it errored");
  assert.deepEqual([...event.structuredFailureKinds], ["unparseable"]);
  assert.equal(event.providerAttempts, 2);
});

test("follow-up: initial failure then successful repair stays success with one repair", async () => {
  const ledger = createBoundedModelCallLedger({ capacity: 16 });
  let calls = 0;
  await withObserver(ledger.observer, async () => {
    const gateway = turnGateway({
      onChat: () => {
        calls += 1;
        if (calls === 1) {
          return {
            model: "fake-model",
            content: "not json at all",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          };
        }
        return jsonResponse({ visibility: "public", reason: "ordinary" });
      },
    });
    const { createModelVisibilityAssessor } = await import("../modules/orchestration/model-powered.ts");
    const assessor = createModelVisibilityAssessor({
      player: {
        characterInstanceId: "player-instance",
        participantId: "player-participant",
        displayName: "玩家",
      },
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    const result = await assessor.assess({ playerText: "测试" });
    assert.equal(result.visibility.kind, "public");
  });
  assert.equal(ledger.entries.length, 1);
  const event = ledger.entries[0]!;
  assert.equal(event.outcome, "success");
  assert.equal(event.structuredRepairs, 1);
  assert.deepEqual([...event.structuredFailureKinds], ["unparseable"]);
  assert.equal(event.providerAttempts, 2);
});
