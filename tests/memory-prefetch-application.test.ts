import assert from "node:assert/strict";
import test from "node:test";
import type { RecordProjection, ProjectionEvent } from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import {
  fallbackSemanticSegments,
  type SemanticSegment,
} from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnOrchestrator,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import {
  createMemoryPrefetchHub,
  type MemoryPrefetchHandle,
} from "../modules/memory/pipeline.ts";
import type { InterjectionPolicy } from "../modules/orchestration/interjection.ts";

type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
};
type OutboxPayload = { recordId: string; eventIds: readonly string[] };
type Repository = RuntimeRepository<
  CommandPayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  EventPayload,
  OutboxPayload
>;

interface PrefetchSpy {
  beginCalls: Array<{ input: Parameters<ReturnType<typeof createMemoryPrefetchHub>["begin"]>[0]; at: number }>;
  endCalls: Array<{ handle: MemoryPrefetchHandle; at: number }>;
  hub: ReturnType<typeof createMemoryPrefetchHub>;
  markers: string[];
  beginHandles: MemoryPrefetchHandle[];
  begin(input: Parameters<ReturnType<typeof createMemoryPrefetchHub>["begin"]>[0]): MemoryPrefetchHandle;
  consume(recordId: string, characterInstanceId: string): string;
  end(handle: MemoryPrefetchHandle): void;
}

function createPrefetchSpy(recallDelayMs = 0): PrefetchSpy {
  const markers: string[] = [];
  let order = 0;
  const hub = createMemoryPrefetchHub({
    recall: () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("- 预取就绪的记忆。"), recallDelayMs);
      }),
  });
  const beginCalls: PrefetchSpy["beginCalls"] = [];
  const endCalls: PrefetchSpy["endCalls"] = [];
  const beginHandles: MemoryPrefetchHandle[] = [];
  const spy: PrefetchSpy = {
    beginCalls,
    endCalls,
    beginHandles,
    hub,
    markers,
    begin(input) {
      beginCalls.push({ input, at: ++order });
      markers.push("begin");
      const handle = hub.begin(input);
      beginHandles.push(handle);
      return handle;
    },
    consume: hub.consume.bind(hub),
    end(handle: MemoryPrefetchHandle) {
      endCalls.push({ handle, at: ++order });
      markers.push("end");
      hub.end(handle);
    },
  };
  return spy;
}

function createFixture(options: {
  orchestratorFactory: (scope: never) => M2TurnOrchestrator;
  memoryPrefetch?: Parameters<typeof createLocalRecordService>[0]["memoryPrefetch"];
  interjectionPolicy?: InterjectionPolicy;
}) {
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  let tokenSequence = 0;
  let idSequence = 0;
  const events: ProjectionEvent[] = [
    {
      id: "event_opening",
      ordinal: 1,
      type: "narration",
      speaker: "旁白",
      speakerParticipantId: null,
      role: "narrator",
      content: "雾沿着石阶爬上防波堤。",
      segments: fallbackSemanticSegments("雾沿着石阶爬上防波堤。", "environment"),
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      visibility: "public",
      status: "committed",
      createdAt: "2026-08-20T01:00:00.000Z",
    },
  ];
  const projection = {
    async loadForPlayer(): Promise<RecordProjection> {
      return baseProjection(events);
    },
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async hasViewerProjection() {
      return true;
    },
    async loadDeliveryForPlayer() {
      return {
        record: baseProjection(events),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: null,
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `prefetch-token-${++tokenSequence}`,
      clock: () => new Date("2026-08-20T02:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-20T02:00:00.000Z"),
    idFactory: () => `prefetch-${++idSequence}`,
    orchestratorFactory: options.orchestratorFactory as never,
    memoryPrefetch: options.memoryPrefetch,
    interjectionPolicy: options.interjectionPolicy,
  });
  return { service, events };
}

function baseProjection(events: ProjectionEvent[]): RecordProjection {
  const cast: RecordProjection["cast"] = [
    {
      id: "char_def_player",
      participantId: "participant_player",
      characterInstanceId: "char_inst_player",
      name: "洛川",
      role: "人类使节",
      summary: "停战议会派来的年轻调停人。",
      status: "present",
      controlledBy: "human",
      isActive: true,
    },
  ];
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version: events.length,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元17年",
      summary: "人魔停战十七年后。",
      timeCursor: "停战纪元17年 · 雾月12日 · 入夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_silent_bell",
      title: "无声钟的来客",
      status: "active",
      premise: "一封密函被送上岸。",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "第一幕 · 雾港来信",
      status: "active",
      version: events.length,
      location: "灰鲸港 · 北防波堤",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    },
    scene: {
      location: "灰鲸港 · 北防波堤",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      weather: "冷雾，无风",
      tension: "钟声已经响过三次",
      objective: "决定是否拆开密函",
    },
    cast,
    participants: cast,
    events,
    stories: [
      { id: "story_silent_bell", title: "无声钟的来客", status: "active" },
    ],
    records: [
      {
        id: LOCAL_RECORD_SCOPE.recordId,
        title: "第一幕 · 雾港来信",
        status: "active",
        worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      },
    ],
  };
}

function deterministicOrchestratorFactory() {
  return () => createLocalM2TurnOrchestrator({
    characters: [{
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      participantId: POSTGRES_DEMO_IDS.scoutParticipant,
      displayName: "塞娜",
    }],
    actionResolver: createDeterministicActionResolver({
      allowStatefulReceipts: true,
    }),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("prefetch begins before orchestration and ends once per committed turn", async () => {
  const spy = createPrefetchSpy();
  let planCalls = 0;
  const orchestratorFactory = () => {
    const inner = deterministicOrchestratorFactory()();
    return {
      ...inner,
      async plan(input: Parameters<M2TurnOrchestrator["plan"]>[0]) {
        planCalls += 1;
        spy.markers.push("plan");
        return inner.plan(input);
      },
    } satisfies M2TurnOrchestrator;
  };
  const { service } = createFixture({
    orchestratorFactory,
    memoryPrefetch: spy,
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "先不要拆信，检查信使离开的方向。",
    idempotencyKey: "prefetch-turn-1",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);
  const begin = spy.beginCalls[0]!;
  assert.equal(begin.input.recordId, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(begin.input.playerText, "先不要拆信，检查信使离开的方向。");
  assert.deepEqual(
    begin.input.characters.map((character) => character.characterInstanceId),
    [POSTGRES_DEMO_IDS.scoutInstance, POSTGRES_DEMO_IDS.scholarInstance],
  );
  // begin 必须先于首个编排调用，end 收尾：begin → plan → end。
  assert.ok(spy.markers.indexOf("begin") < spy.markers.indexOf("plan"));
  assert.ok(spy.markers.indexOf("plan") < spy.markers.indexOf("end"));
  // end 必须清理 begin 创建的同一会话（会话标识隔离）。
  assert.equal(spy.endCalls[0]!.handle.recordId, begin.input.recordId);
  assert.equal(spy.endCalls[0]!.handle.sessionId, spy.beginHandles[0]!.sessionId);
  assert.equal(planCalls, 1);

  // replay 回合不重新预取。
  const replay = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "先不要拆信，检查信使离开的方向。",
    idempotencyKey: "prefetch-turn-1",
    writeToken: initial.writeToken,
  });
  assert.equal(replay.disposition, "duplicate");
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);
});

test("prefetch session is cleaned up even when the turn fails", async () => {
  const spy = createPrefetchSpy();
  const orchestratorFactory = () => ({
    async plan(): Promise<M2TurnPlan> {
      throw new Error("orchestrator offline");
    },
    async draft(): Promise<M2TurnCandidate> {
      throw new Error("unreachable");
    },
    async validate(): Promise<M2TurnValidation> {
      throw new Error("unreachable");
    },
  });
  const { service } = createFixture({
    orchestratorFactory,
    memoryPrefetch: spy,
  });

  const initial = await service.loadRecord();
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "这回合注定失败。",
      idempotencyKey: "prefetch-failure",
      writeToken: initial.writeToken,
    }),
  );
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1, "失败路径也必须 end 清理会话");
});

test("interjection turns begin and end their own prefetch sessions", async () => {
  const spy = createPrefetchSpy();
  // 强制插话：验证插话回合也走 begin/end。
  const interjectionPolicy: InterjectionPolicy = {
    evaluate({ availableCharacters }) {
      const character = availableCharacters[0];
      if (!character) return { kind: "silent" as const, reason: "测试无可插话角色。" };
      return { kind: "interject" as const, character, reason: "测试强制插话。" };
    },
  };
  const { service } = createFixture({
    orchestratorFactory: deterministicOrchestratorFactory(),
    memoryPrefetch: spy,
    interjectionPolicy,
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "塞娜，你怎么看这封信？",
    idempotencyKey: "prefetch-interjection",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // 玩家回合 begin 一次；插话由 scheduleInterjection 在首个 await 前同步发起
  // 自己的会话，因此 committed 返回时已有两次 begin。轮询等待两次 end 收尾。
  await waitFor(() => spy.beginCalls.length >= 2 && spy.endCalls.length >= 2);
  assert.equal(spy.beginCalls.length, 2, "插话回合必须发起自己的预取会话");
  assert.equal(spy.endCalls.length, 2, "插话回合必须清理自己的预取会话");
  // 两次 begin 各自拿到独立会话标识（玩家回合与插话回合互不串用）。
  assert.notEqual(spy.beginHandles[0]!.sessionId, spy.beginHandles[1]!.sessionId);
});
