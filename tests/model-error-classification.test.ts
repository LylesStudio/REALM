/**
 * P0-3 模型错误分类：认证/配置失败进入 Fatal 路径（保留 code、不重试）；
 * 可恢复错误（429/5xx/timeout/network）保持既有 retryable 语义。
 * 全部 fake gateway / 内存 fixture；不发真实 provider 请求、不输出凭据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FatalTurnError,
  RetryableTurnError,
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import {
  createModelPoweredM2TurnOrchestrator,
} from "../modules/orchestration/model-powered.ts";
import {
  ModelConfigurationError,
  ModelProviderError,
  type ModelGateway,
} from "../modules/inference/types.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import type { ModelChatResponse } from "../modules/inference/types.ts";

function baseProjection(events: import("../modules/application/legacy-record-projection-types.ts").ProjectionEvent[]) {
  const cast = [{
    id: "char_def_player",
    participantId: "participant_player",
    characterInstanceId: "char_inst_player",
    name: "洛川",
    role: "人类使节",
    summary: "停战议会派来的年轻调停人。",
    status: "present",
    controlledBy: "human" as const,
    isActive: true,
  }];
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version: events.length,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元17年",
      summary: "人魔停战十七年后。",
      timeCursor: "停战纪元17年 · 雾月12日 · 入夜",
      style: "classical" as const,
      language: "zh-CN" as const,
    },
    story: { id: "story_silent_bell", title: "无声钟的来客", status: "active" as const, premise: "一封密函被送上岸。" },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "第一幕 · 雾港来信",
      status: "active" as const,
      version: events.length,
      location: "灰鲸港 · 北防波堤",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    },
    scene: {
      location: "灰港",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      weather: "冷雾",
      tension: "",
      objective: "决定是否拆开密函",
    },
    cast,
    participants: cast,
    events,
    stories: [{ id: "story_silent_bell", title: "无声钟的来客", status: "active" as const }],
    records: [{
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "第一幕 · 雾港来信",
      status: "active" as const,
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    }],
  };
}

const SCOUT = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
} as const;

test("orchestrator: MODEL_AUTH_FAILED → FatalTurnError 保留 code，不重试", async () => {
  let count = 0;
  const counting: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(): Promise<ModelChatResponse> {
      count += 1;
      throw new ModelProviderError("MODEL_AUTH_FAILED", "upstream HTTP 401", 401);
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => counting,
  });
  await assert.rejects(
    orchestrator.plan({ turnId: "turn-auth", playerText: "拆开密函。" }),
    (error: unknown) => {
      assert.ok(error instanceof FatalTurnError, "必须 Fatal，不得 Retryable");
      assert.equal(error.code, "MODEL_AUTH_FAILED");
      assert.ok(!/401|upstream|http/i.test(error.safeMessage), "safeMessage 不得回显上游细节");
      return true;
    },
  );
  assert.equal(count, 1, "认证失败不得触发任何重试");
});

test("orchestrator: ModelConfigurationError → FatalTurnError 保留配置 code，不重试", async () => {
  let count = 0;
  const counting: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(): Promise<ModelChatResponse> {
      count += 1;
      throw new ModelConfigurationError("MODEL_API_KEY_MISSING", "未配置 API key。");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => counting,
  });
  await assert.rejects(
    orchestrator.plan({ turnId: "turn-config", playerText: "拆开密函。" }),
    (error: unknown) => {
      assert.ok(error instanceof FatalTurnError);
      assert.equal(error.code, "MODEL_API_KEY_MISSING");
      return true;
    },
  );
  assert.equal(count, 1);
});

test("orchestrator: MODEL_RATE_LIMITED 等瞬态错误保持 retryable 语义", async () => {
  const counting: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(): Promise<ModelChatResponse> {
      throw new ModelProviderError("MODEL_RATE_LIMITED", "HTTP 429", 429);
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => counting,
  });
  await assert.rejects(
    orchestrator.plan({ turnId: "turn-429", playerText: "拆开密函。" }),
    (error: unknown) => {
      assert.ok(error instanceof RetryableTurnError, "429 必须保持 retryable");
      assert.equal(error.code, "MODEL_PROVIDER_STEP_FAILED");
      return true;
    },
  );
});

test("service path: MODEL_AUTH_FAILED → disposition failed + 诊断 code 保留 + provider 恰一次调用", async () => {
  let count = 0;
  const counting: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(): Promise<ModelChatResponse> {
      count += 1;
      throw new ModelProviderError("MODEL_AUTH_FAILED", "upstream HTTP 401", 401);
    },
  };
  type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
  type EventPayload = {
    schemaVersion: 1;
    role: "player" | "character" | "narrator" | "system";
    speaker: string;
    participantId: string | null;
    content: string;
    segments: readonly SemanticSegment[];
  };
  const repository: RuntimeRepository<
    CommandPayload,
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    EventPayload,
    { recordId: string; eventIds: readonly string[] }
  > = createInMemoryRuntimeRepository({
    recordHeads: [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }],
  });
  const service = createLocalRecordService({
    repository,
    projection: {
      async hasViewerProjection() {
        return true;
      },
      async loadForPlayer() {
        const runtimeEvents = await repository.listCommittedEvents(
          LOCAL_RECORD_SCOPE.recordId,
        );
        return baseProjection(runtimeEvents.map((event, index) => ({
          id: event.eventId,
          ordinal: index + 2,
          type: event.kind === "narration.committed" ? "narration" as const : "utterance" as const,
          speaker: event.payload.speaker,
          speakerParticipantId: event.payload.participantId,
          role: event.payload.role,
          content: event.payload.content,
          segments: event.payload.segments,
          worldTime: "停战纪元17年 · 雾月12日 · 入夜",
          visibility: "public" as const,
          status: "committed" as const,
          createdAt: event.committedAt,
        })));
      },
      async loadDeliveryForPlayer() {
        const runtimeEvents = await repository.listCommittedEvents(
          LOCAL_RECORD_SCOPE.recordId,
        );
        return {
          record: baseProjection(runtimeEvents.map((event, index) => ({
            id: event.eventId,
            ordinal: index + 2,
            type: event.kind === "narration.committed" ? "narration" as const : "utterance" as const,
            speaker: event.payload.speaker,
            speakerParticipantId: event.payload.participantId,
            role: event.payload.role,
            content: event.payload.content,
            segments: event.payload.segments,
            worldTime: "停战纪元17年 · 雾月12日 · 入夜",
            visibility: "public" as const,
            status: "committed" as const,
            createdAt: event.committedAt,
          }))),
          viewer: {
            cursor: "viewer-local" as const,
            perspective: "omniscient" as const,
            dynamicKnowledgeVisible: true,
            characterInstanceId: null,
            membershipRole: "owner" as const,
          },
        };
      },
      async loadRecentAuthorizedEvents() {
        return [];
      },
    },
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => "opaque-test",
      clock: () => new Date("2026-09-18T00:00:00.000Z"),
    }),
    orchestrator: createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => counting,
    }),
  });
  const initial = await service.loadRecord();
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "拆开密函。",
      idempotencyKey: "auth-fail-once",
      writeToken: initial.writeToken,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      // 服务层错误码契约保持 TURN_FAILED；玩家可见诊断携带保留的
      // MODEL_AUTH_FAILED（不得坍缩成泛用重试码）。
      assert.equal(error.code, "TURN_FAILED");
      assert.equal(
        error.diagnostic?.code,
        "MODEL_AUTH_FAILED",
        "诊断 code 必须保留（不得坍缩成泛用重试码）",
      );
      assert.equal(error.diagnostic?.disposition, "failed");
      assert.ok(!/401|upstream|Authorization/i.test(error.message));
      return true;
    },
  );
  assert.equal(count, 1, "注定失败的 retryTurn 不得发生（provider 恰一次调用）");
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(events.length, 0, "失败不得写入任何事件");
});
