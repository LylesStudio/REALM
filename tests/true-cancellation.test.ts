import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatResponse,
  ModelGateway,
  ModelProviderSettings,
} from "../modules/inference/types.ts";
import { createOpenAICompatibleGateway } from "../modules/inference/openai-compatible-gateway.ts";
import { ModelProviderError } from "../modules/inference/types.ts";
import {
  FatalTurnError,
  RetryableTurnError,
  createInMemoryRuntimeRepository,
  executeTurn,
  retryTurn,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { createModelVisibilityAssessor } from "../modules/orchestration/model-powered.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";
import { createLocalPreviewHub, type LocalPreviewEvent } from "../modules/application/local-record-service.ts";

/**
 * Cleanup Phase 4 / Batch 2D：true cancellation。
 * gateway fetch abort / model-powered 停止重试与 repair / runtime 取消终态
 * 与 retryTurn gate / Preview aborted 语义。
 */

function settings(timeoutMs: number): ModelProviderSettings {
  return {
    schemaVersion: 1,
    providerId: "openrouter",
    baseUrl: "https://example.test",
    apiKey: "test-key",
    selectedModel: "test-model",
    thinking: "disabled",
    timeoutMs,
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
    usage: null,
  };
}

// ---------- A. gateway signal ----------

test("gateway: an already-aborted signal never issues a provider request", async () => {
  let fetchCalls = 0;
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    }) as typeof fetch,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    gateway.chat({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
  );
  assert.equal(fetchCalls, 0);
});

test("gateway: an external abort interrupts the underlying chat fetch", async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: (async (_url: string, init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        observed.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = gateway.chat({
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
  );
  assert.equal(observed.signal?.aborted, true, "the per-call controller aborted the real fetch");
});

test("gateway: an external abort ends an in-flight SSE read promptly", async () => {
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: (async (_url: string, init?: RequestInit) => {
      // 模拟真实 fetch：signal abort 会让 SSE body reader 立即失败。
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          signal?.addEventListener("abort", () => {
            streamController.error(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const started = Date.now();
  const iterate = (async () => {
    for await (const chunk of gateway.streamChat!({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })) {
      void chunk;
    }
  })();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(iterate);
  assert.ok(Date.now() - started < 2_000, "SSE read must end on external abort");
});

test("gateway: the local signal never enters the provider request body", async () => {
  let body = "";
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: (async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return Response.json({
        choices: [{
          message: { content: "ok" },
          finish_reason: "stop",
        }],
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  await gateway.chat({
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal("signal" in parsed, false, "signal must not be serialized into the wire body");
});

// ---------- B. model-powered cancellation ----------

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

test("model-powered: a pre-aborted signal cancels before any provider call", async () => {
  let chatCalls = 0;
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      chatCalls += 1;
      throw new Error("must not be called");
    },
  };
  const assessor = createModelVisibilityAssessor({
    player: PLAYER,
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    assessor.assess({ playerText: "测试", signal: controller.signal }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "TURN_CANCELLED",
  );
  assert.equal(chatCalls, 0);
});

test("model-powered: abort before repair stops the repair attempt (exactly one call)", async () => {
  let chatCalls = 0;
  const controller = new AbortController();
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      chatCalls += 1;
      controller.abort(); // 初次结构化失败返回后立即取消
      return {
        model: "fake-model",
        content: "not json",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  const assessor = createModelVisibilityAssessor({
    player: PLAYER,
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  await assert.rejects(
    assessor.assess({ playerText: "测试", signal: controller.signal }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "TURN_CANCELLED",
  );
  assert.equal(chatCalls, 1, "the repair request must not happen after abort");
});

test("model-powered: abort during stream empty-retry stops without chat fallback", async () => {
  let streamAttempts = 0;
  let reactChatCalls = 0;
  const controller = new AbortController();
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (request.tools) return jsonResponse({});
      if (system.includes("natural exchange")) {
        reactChatCalls += 1;
        return jsonResponse({ action: "塞娜侧耳。", dialogue: "我在听。" });
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
      throw new Error(`unexpected chat: ${system.slice(0, 40)}`);
    },
    async *streamChat() {
      streamAttempts += 1;
      controller.abort(); // 首个空流尝试后立即取消
      yield { content: "" };
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
  });
  const input = {
    turnId: "turn-cancel-stream",
    playerText: "你在吗？",
    signal: controller.signal,
  };
  const plan = await orchestrator.plan(input);
  await assert.rejects(
    orchestrator.draft({ ...input, plan }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "TURN_CANCELLED",
  );
  assert.equal(streamAttempts, 1, "no further stream attempts after abort");
  assert.equal(reactChatCalls, 0, "no chat fallback after abort");
});

// ---------- C. runtime cancellation ----------

type CommandPayload = { text: string };
type PlanBody = { objective: string };
type CandidateBody = { speaker: string; text: string };
type ValidationBody = { accepted: boolean };
type EventPayload = { speaker: string; content: string };
type OutboxPayload = { recordId: string; eventId: string };

type TestRepository = RuntimeRepository<
  CommandPayload,
  PlanBody,
  CandidateBody,
  ValidationBody,
  EventPayload,
  OutboxPayload
>;

function createCommand(): RuntimeCommand<CommandPayload> {
  return {
    commandType: "player.utterance",
    recordId: "record-1",
    expectedRecordVersion: 0,
    idempotencyKey: "command-cancel",
    actorId: "participant-player",
    payload: { text: "检查蜡封。" },
  };
}

function createDependencies(
  repository: TestRepository,
  overrides: {
    draftError?: () => Error;
  } = {},
) {
  const calls = { planning: 0, drafting: 0, validating: 0, releasing: 0 };
  const dependencies: TurnRuntimeDependencies<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  > = {
    repository,
    planner: {
      async plan() {
        calls.planning += 1;
        return { objective: "回应" };
      },
    },
    drafter: {
      async draft() {
        calls.drafting += 1;
        if (overrides.draftError) throw overrides.draftError();
        return { speaker: "塞娜", text: "候选" };
      },
    },
    validator: {
      async validate() {
        calls.validating += 1;
        return { accepted: true };
      },
    },
    releaseBuilder: {
      async build(context) {
        calls.releasing += 1;
        return {
          formalEvents: [
            {
              eventId: `${context.turnId}-event`,
              kind: "utterance.committed",
              payload: { speaker: "塞娜", content: "候选" },
            },
          ],
          outbox: [
            {
              messageId: `${context.turnId}-outbox`,
              topic: "record.event.committed",
              dedupeKey: `${context.turnId}:projection`,
              payload: { recordId: "record-1", eventId: `${context.turnId}-event` },
            },
          ],
        };
      },
    },
  };
  return { calls, dependencies };
}

test("runtime: aborted before planning cancels without planner or release", async () => {
  const repository = createInMemoryRuntimeRepository<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  >({ recordHeads: [{ recordId: "record-1", version: 0, nextOrdinal: 7 }] });
  const { calls, dependencies } = createDependencies(repository);
  const controller = new AbortController();
  controller.abort();
  const run = await executeTurn(createCommand(), {
    ...dependencies,
    signal: controller.signal,
  });
  assert.equal(calls.planning, 0, "planner must not be called after abort");
  assert.equal(calls.releasing, 0);
  assert.equal(run.currentFailure?.code, "TURN_CANCELLED");
  assert.deepEqual(await repository.listCommittedEvents("record-1"), []);
  assert.deepEqual(await repository.listOutboxMessages(), []);
});

test("runtime: abort between planning and drafting cancels before the drafter", async () => {
  const repository = createInMemoryRuntimeRepository<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  >({ recordHeads: [{ recordId: "record-1", version: 0, nextOrdinal: 7 }] });
  const controller = new AbortController();
  const { calls, dependencies } = createDependencies(repository);
  const wrapped: typeof dependencies = {
    ...dependencies,
    planner: {
      async plan() {
        controller.abort(); // planning 完成后立即取消
        calls.planning += 1;
        return { objective: "回应" };
      },
    },
  };
  const run = await executeTurn(createCommand(), {
    ...wrapped,
    signal: controller.signal,
  });
  assert.equal(calls.planning, 1);
  assert.equal(calls.drafting, 0, "drafter must not run after abort");
  assert.equal(run.currentFailure?.code, "TURN_CANCELLED");
  assert.deepEqual(await repository.listCommittedEvents("record-1"), []);
});

test("runtime: retryTurn refuses to restart a retryable turn once aborted", async () => {
  const repository = createInMemoryRuntimeRepository<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  >({ recordHeads: [{ recordId: "record-1", version: 0, nextOrdinal: 7 }] });
  const { calls, dependencies } = createDependencies(repository, {
    draftError: () => new RetryableTurnError("MODEL_PROVIDER_STEP_FAILED", "可以安全重试。"),
  });
  const controller = new AbortController();
  const run = await executeTurn(createCommand(), {
    ...dependencies,
    signal: controller.signal,
  });
  assert.equal(run.state, "retryable");
  assert.equal(calls.drafting, 1);
  controller.abort();
  await assert.rejects(
    retryTurn(run.turnId, { ...dependencies, signal: controller.signal }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "TURN_CANCELLED",
  );
  assert.equal(calls.drafting, 1, "no further drafter call after abort");
});

// ---------- D. preview aborted semantics ----------

test("preview: an aborted session drops chunks and never ends committed", () => {
  const hub = createLocalPreviewHub();
  const events: LocalPreviewEvent[] = [];
  hub.subscribe("record-1", (event) => events.push(event));
  const controller = new AbortController();
  hub.begin("record-1", "preview-1", controller.signal);
  controller.abort();
  hub.publishChunk("record-1", "narrator", "迟到的一句");
  hub.end("record-1", "committed");
  assert.equal(
    events.filter((event) => event.kind === "chunk").length,
    0,
    "late chunks are dropped after abort",
  );
  const end = events.find((event) => event.kind === "end");
  assert.equal(end?.kind, "end");
  assert.equal(
    (end as { outcome?: string } | undefined)?.outcome,
    "aborted",
    "a late committed cleanup must degrade to an aborted end",
  );
});

test("gateway: external abort interrupts a hanging JSON body read", async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: (async (_url: string, init?: RequestInit) => {
      // fake fetch 立即返回 HTTP 200，但 body 永不结束；内部 signal abort 时
      // body 以 AbortError 失败（模拟真实 fetch 的 body 取消语义）。
      observed.signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          observed.signal?.addEventListener("abort", () => {
            streamController.error(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = gateway.chat({
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
  );
  assert.ok(Date.now() - started < 2_000, "body read must end promptly after abort");
  assert.equal(
    observed.signal?.aborted,
    true,
    "the per-call controller must abort the in-flight body read",
  );
});
