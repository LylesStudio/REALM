import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository, type RuntimeRepository } from "../modules/runtime/public.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import type { RecordRuntimeScope } from "../database/postgres/public.ts";
import type { ActionAffordance, ActionTransaction } from "../modules/actions/public.ts";
import type { SelfPlaySession } from "../modules/application/self-play.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  actionTransaction?: ActionTransaction;
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

/**
 * Batch 3C：`loadConsistentEnvelope` 在 scope 解析之后，snapshot /
 * affordances / firstNight / selfPlay 四项读取并行发起（Promise.all）。
 * 本套件用 barrier/latch 证明四项读取「全部开始后才放行」，而不是
 * wall-clock 断言；同时证明 scope resolve 仍先行（fail-closed 语义不变）。
 */

function stubProjection(): RecordProjection {
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version: 3,
    world: {
      id: "world_envelope",
      name: "信封世界",
      era: "测试纪元",
      summary: "并行化测试。",
      timeCursor: "测试纪元 · 夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_envelope",
      title: "信封故事",
      status: "active",
      premise: "前提。",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "信封场景",
      status: "active",
      version: 3,
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
    },
    scene: {
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
      weather: "无风",
      tension: "平静",
      objective: "验证并行读取",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  };
}

function stubScope(): RecordRuntimeScope {
  return {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId: LOCAL_RECORD_SCOPE.principalId,
    worldId: "world_envelope",
    worldlineId: "worldline_envelope",
    storyId: "story_envelope",
    recordId: LOCAL_RECORD_SCOPE.recordId,
    sceneId: "scene_envelope",
    publicPolicyId: "policy_public",
    calendarId: "calendar_test",
    displayTime: "测试纪元 · 夜",
    style: "classical",
    worldStatus: "active",
    brief: {
      worldName: "信封世界",
      era: "测试纪元",
      summary: "并行化测试。",
      storyTitle: "信封故事",
      premise: "前提。",
      location: "测试地点",
      weather: "无风",
      tension: "平静",
      objective: "验证并行读取",
      canon: "",
      worldLore: "",
    },
    playerActor: {
      characterInstanceId: "char_inst_player",
      participantId: "participant_player",
      displayName: "测试者",
      profileSummary: "并行化测试角色。",
    },
    aiCharacters: [],
    observerCharacterInstanceIds: [],
    recentPublicEvents: [],
    recentPublicDialogue: [],
    recordKnowledge: [],
  };
}

const AFFORDANCE: ActionAffordance = {
  id: "scene.observe_surroundings",
  kind: "scene",
  actorCharacterInstanceId: "char_inst_player",
  actorName: "测试者",
  title: "观察四周",
  description: "观察四周。",
  suggestedText: "我观察四周。",
};

const SELF_PLAY_SESSION: SelfPlaySession = {
  id: "selfplay_1",
  recordId: LOCAL_RECORD_SCOPE.recordId,
  worldId: "world_envelope",
  state: "running",
  beatBudget: 3,
  beatsCompleted: 1,
  requestedBy: LOCAL_RECORD_SCOPE.principalId,
  lastError: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

type ReadName = "snapshot" | "affordances" | "firstNight" | "selfPlay";

/**
 * 并发栅栏：每个读取点 enter 时登记自己的名字，四个全部登记后才放行；
 * 若实现退回串行，第一个读取会等到超时放行（测试随后以
 * releasedByAll === false 失败），不会死锁。
 */
function createBarrier(size: number, timeoutMs = 1000) {
  const started: ReadName[] = [];
  const sequence: { name: string; order: number }[] = [];
  let order = 0;
  let releasedByAll = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, timeoutMs);
  });
  return {
    started,
    sequence,
    wasReleasedByAll: () => releasedByAll,
    mark(name: string) {
      sequence.push({ name, order: ++order });
    },
    async enter<T>(name: ReadName, value: () => T | Promise<T>): Promise<T> {
      started.push(name);
      sequence.push({ name, order: ++order });
      if (started.length === size) {
        releasedByAll = true;
        release();
      }
      await gate;
      return value();
    },
  };
}

function createService(options: {
  barrier?: ReturnType<typeof createBarrier>;
  firstNightMarker?:
    | { state: "pending" | "ready" | "degraded"; hookContent: string; suggestions: readonly string[] }
    | null
    | Error;
  selfPlaySession?: SelfPlaySession | null | Error;
  affordanceResult?: readonly ActionAffordance[] | Error;
  scopeResult?: RecordRuntimeScope | null;
  scheduleSpy?: (recordId: string) => void;
} = {}) {
  const barrier = options.barrier;
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 3, nextOrdinal: 4 },
    ],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return stubProjection();
    },
    async loadDeliveryForPlayer() {
      const delivery = {
        record: stubProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: "char_inst_player",
          membershipRole: "owner" as const,
        },
      };
      return barrier ? barrier.enter("snapshot", () => delivery) : delivery;
    },
  };
  const actionCatalog = {
    async listAuthorized() {
      const result = options.affordanceResult ?? [AFFORDANCE];
      if (barrier) {
        return barrier.enter("affordances", () => {
          if (result instanceof Error) throw result;
          return result;
        });
      }
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const runtimeScopeProvider = {
    async resolve() {
      barrier?.mark("scope");
      return options.scopeResult === undefined ? stubScope() : options.scopeResult;
    },
  };
  const firstNight = {
    async load() {
      const marker = options.firstNightMarker === undefined
        ? { state: "ready" as const, hookContent: "开场钩。", suggestions: [" 甲 ", "", "乙"] }
        : options.firstNightMarker;
      if (barrier) {
        return barrier.enter("firstNight", () => {
          if (marker instanceof Error) throw marker;
          return marker;
        });
      }
      if (marker instanceof Error) throw marker;
      return marker;
    },
    schedule: options.scheduleSpy ?? (() => {}),
  };
  const selfPlayStore = {
    async failStale() {},
    async findLatest() {
      const session = options.selfPlaySession === undefined
        ? SELF_PLAY_SESSION
        : options.selfPlaySession;
      if (barrier) {
        return barrier.enter("selfPlay", () => {
          if (session instanceof Error) throw session;
          return session;
        });
      }
      if (session instanceof Error) throw session;
      return session;
    },
    // 本套件不走自演写路径；其余方法仅为满足 SelfPlayStore 契约。
    async start() {
      throw new Error("not used");
    },
    async load() {
      return null;
    },
    async completeBeat() {
      return null;
    },
    async requestStop() {
      return null;
    },
    async finish() {},
  };
  let tokenSequence = 0;
  const service = createLocalRecordService({
    repository,
    projection,
    actionCatalog,
    runtimeScopeProvider,
    firstNight,
    selfPlayStore,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `opaque-${++tokenSequence}`,
      clock: () => new Date("2026-09-04T01:00:00.000Z"),
    }),
    clock: () => new Date("2026-09-04T01:00:00.000Z"),
  });
  return { service };
}

test("envelope 四项读取在 scope 解析之后并发开始（barrier 证明）", async () => {
  const barrier = createBarrier(4);
  const { service } = createService({ barrier });
  const envelope = await service.loadRecord();

  // 四个读取点全部开始后才放行——串行实现会超时放行并使 releasedByAll=false。
  assert.equal(barrier.wasReleasedByAll(), true);
  assert.deepEqual([...barrier.started].sort(), [
    "affordances",
    "firstNight",
    "selfPlay",
    "snapshot",
  ]);
  // scope resolve 先于四项读取中的任何一项。
  const scopeOrder = barrier.sequence.find((entry) => entry.name === "scope")?.order;
  assert.ok(scopeOrder !== undefined, "scope resolve 应被调用");
  for (const name of ["snapshot", "affordances", "firstNight", "selfPlay"] as const) {
    const readOrder = barrier.sequence.find((entry) => entry.name === name)?.order;
    assert.ok(readOrder !== undefined && scopeOrder < readOrder, `${name} 应在 scope 之后开始`);
  }

  // 返回契约与原串行实现一致。
  assert.equal(envelope.record.id, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(envelope.record.version, 3);
  assert.equal(envelope.writeToken, "opaque-1");
  assert.equal(envelope.viewer.characterInstanceId, "char_inst_player");
  assert.deepEqual(envelope.affordances, [AFFORDANCE]);
  assert.deepEqual(envelope.suggestions, []);
  assert.deepEqual(envelope.firstNight, {
    state: "ready",
    hookContent: "开场钩。",
    openingSuggestions: ["甲", "乙"],
  });
  assert.deepEqual(envelope.selfPlay, {
    state: "running",
    beatBudget: 3,
    beatsCompleted: 1,
    lastError: null,
  });
});

test("firstNight pending 仍触发一次懒调度（副作用保持）", async () => {
  const scheduled: string[] = [];
  const { service } = createService({
    firstNightMarker: { state: "pending", hookContent: "", suggestions: [] },
    selfPlaySession: null,
    scheduleSpy: (recordId) => scheduled.push(recordId),
  });
  const envelope = await service.loadRecord();
  assert.deepEqual(scheduled, [LOCAL_RECORD_SCOPE.recordId]);
  assert.equal(envelope.firstNight?.state, "pending");
});

test("firstNight/selfPlay 读取失败仍 warn→null，envelope 正常返回", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const { service } = createService({
      firstNightMarker: new Error("first night store down"),
      selfPlaySession: new Error("self play store down"),
    });
    const envelope = await service.loadRecord();
    assert.equal(envelope.firstNight, null);
    assert.equal(envelope.selfPlay, null);
    assert.equal(envelope.record.version, 3);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((line) => line.includes("first night marker read failed")));
  assert.ok(warnings.some((line) => line.includes("self-play session read failed")));
});

test("affordances 读取失败仍按原语义传播", async () => {
  const { service } = createService({
    affordanceResult: new Error("catalog down"),
  });
  await assert.rejects(service.loadRecord(), /catalog down/);
});

test("scope 解析失败仍先行 fail-closed（四项读取不启动）", async () => {
  const barrier = createBarrier(4);
  const { service } = createService({ barrier, scopeResult: null });
  await assert.rejects(service.loadRecord(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "NOT_FOUND");
    return true;
  });
  assert.deepEqual(barrier.started, []);
});
