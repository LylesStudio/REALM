/**
 * Phase 2F-B：Local Record 回合 memory prefetch 生命周期（玩家回合仅非
 * replay begin、成功后按既有角色顺序 consume、提交/失败/异常 finally 一律
 * end；插话回合开始即 begin、与租约/快照/模型调用重叠、退出清理不泄漏）
 * 已从 facade 拆入 modules/application/local-record-memory-prefetch.ts。
 * 本文件是拆分边界测试：
 * ① seam——facade 真实接线到新模块（import + factory 调用），不再自带
 *    begin/consume/end 第二份编排实现，新模块不反向 import facade、不复制
 *    MemoryPrefetchHub（modules/memory/pipeline.ts）实现；
 * ② behavior——普通回合 begin/consume/end、预取内容按原 payload 结构进
 *    presence、replay 不 begin、失败 finally 清理、插话自有会话与同一
 *    record 会话替换隔离、pending/failed fail-closed（不等待、不抛错），
 *    全部与拆分前逐行一致。
 *
 * 不新增 mock：全部经真实 createLocalRecordService + 内存仓储/确定性
 * runtime seam（真实 MemoryPrefetchHub 加调用记录 spy）；编排器为既有
 * createLocalM2TurnOrchestrator 的包装；门禁/插话策略为接口的确定性实现。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RecordProjection, ProjectionEvent } from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import * as prefetchCoordinator from "../modules/application/local-record-memory-prefetch.ts";
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
import type { PresenceAssessor } from "../modules/orchestration/presence.ts";
import type { InterjectionPolicy } from "../modules/orchestration/interjection.ts";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import {
  createMemoryPrefetchHub,
  type MemoryPrefetchHandle,
} from "../modules/memory/pipeline.ts";

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

type Hub = ReturnType<typeof createMemoryPrefetchHub>;
type BeginInput = Parameters<Hub["begin"]>[0];

const PREFETCHED_LINE = "- 预取就绪的记忆。";

/** 真实 MemoryPrefetchHub + 调用记录 spy（不替换 hub 语义，只记录编排调用）。 */
function createPrefetchSpy(options: {
  recall?: (characterInstanceId: string) => Promise<string>;
} = {}) {
  const markers: string[] = [];
  const hub = createMemoryPrefetchHub({
    recall: ({ characterInstanceId }) =>
      options.recall
        ? options.recall(characterInstanceId)
        : // 即刻 resolve（microtask 就绪）：内存 seam 的回合可全程无 macrotask，
          // setTimeout 反而不可控；任一 await 后即已就绪，语义同生产异步召回。
          Promise.resolve(PREFETCHED_LINE),
  });
  const beginCalls: Array<{ input: BeginInput }> = [];
  const consumeCalls: Array<{ recordId: string; characterInstanceId: string }> = [];
  const endCalls: Array<{ handle: MemoryPrefetchHandle }> = [];
  const beginHandles: MemoryPrefetchHandle[] = [];
  return {
    hub,
    markers,
    beginCalls,
    consumeCalls,
    endCalls,
    beginHandles,
    begin(input: BeginInput): MemoryPrefetchHandle {
      beginCalls.push({ input });
      markers.push("begin");
      const handle = hub.begin(input);
      beginHandles.push(handle);
      return handle;
    },
    consume(recordId: string, characterInstanceId: string): string {
      consumeCalls.push({ recordId, characterInstanceId });
      markers.push("consume");
      return hub.consume(recordId, characterInstanceId);
    },
    end(handle: MemoryPrefetchHandle): void {
      endCalls.push({ handle });
      markers.push("end");
      hub.end(handle);
    },
  };
}

type PrefetchSpy = ReturnType<typeof createPrefetchSpy>;

type DraftObservation = {
  playerText: string;
  turnIntent: string;
  presenceMemories: string | null;
  /** draft 时同步消费（复刻生产 recallMemory 接线：消费当前会话已就绪结果）。 */
  recalledAtDraft: string | null;
};

function createFixture(options: {
  orchestratorFactory?: (scope: never) => M2TurnOrchestrator;
  memoryPrefetch?: PrefetchSpy;
  interjectionPolicy?: InterjectionPolicy;
  presenceAssessor?: PresenceAssessor;
  onDraft?: (observation: DraftObservation) => void;
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
  const orchestratorFactory = options.orchestratorFactory
    ?? (() => {
      const base = createLocalM2TurnOrchestrator({
        characters: [
          {
            characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
            participantId: POSTGRES_DEMO_IDS.scoutParticipant,
            displayName: "塞娜",
          },
          {
            characterInstanceId: POSTGRES_DEMO_IDS.scholarInstance,
            participantId: POSTGRES_DEMO_IDS.scholarParticipant,
            displayName: "弥洛",
          },
        ],
        actionResolver: createDeterministicActionResolver({
          allowStatefulReceipts: true,
        }),
      });
      const onDraft = options.onDraft;
      const spy = options.memoryPrefetch;
      if (!onDraft && !spy) return base;
      return {
        ...base,
        async draft(input: Parameters<M2TurnOrchestrator["draft"]>[0]) {
          onDraft?.({
            playerText: input.playerText,
            turnIntent: input.plan.turnIntent,
            presenceMemories: input.plan.presence?.memories ?? null,
            recalledAtDraft: spy && input.plan.activatedCharacters.length > 0
              ? // 复刻生产 recallMemory 接线：直接消费 hub（与 facade 依赖
                // spy 的编排调用记录分开，不污染 consumeCalls 断言）。
                spy.hub.consume(
                  LOCAL_RECORD_SCOPE.recordId,
                  input.plan.activatedCharacters[0]!.characterInstanceId,
                )
              : null,
          });
          return base.draft(input);
        },
      } satisfies M2TurnOrchestrator;
    });
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `prefetch-token-${++tokenSequence}`,
      clock: () => new Date("2026-08-20T02:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-20T02:00:00.000Z"),
    idFactory: () => `prefetch-${++idSequence}`,
    orchestratorFactory: orchestratorFactory as never,
    ...(options.memoryPrefetch ? { memoryPrefetch: options.memoryPrefetch } : {}),
    ...(options.interjectionPolicy
      ? { interjectionPolicy: options.interjectionPolicy }
      : {}),
    ...(options.presenceAssessor
      ? { presenceAssessor: options.presenceAssessor }
      : {}),
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

/** 确定性在场门禁：恒裁决弥洛（未激活候选）发声。 */
function createSpeakingGate(): PresenceAssessor {
  return {
    async assess({ candidates }) {
      const milo = candidates.find(
        (candidate) =>
          candidate.characterInstanceId === POSTGRES_DEMO_IDS.scholarInstance,
      );
      return milo
        ? {
            kind: "speak",
            characterInstanceId: milo.characterInstanceId,
            triggerKind: "peer",
            reason: "同侪发言值得接话。",
          }
        : { kind: "silent", reason: "无候选。" };
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("seam：facade 真实接线到新模块，无第二份实现/反向 import/hub 复制", () => {
  assert.equal(
    typeof prefetchCoordinator.createLocalMemoryPrefetchCoordinator,
    "function",
  );

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-memory-prefetch.ts"'),
    "facade 必须 import local-record-memory-prefetch.ts",
  );
  assert.ok(
    /createLocalMemoryPrefetchCoordinator\(\{/.test(facadeSource),
    "facade 必须真实调用新模块 factory",
  );
  assert.ok(
    !/dependencies\.memoryPrefetch\??\.(begin|consume|end)\(/.test(facadeSource),
    "facade 不得再直接调用 memoryPrefetch.begin/consume/end（第二份编排实现）",
  );

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-memory-prefetch.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "新模块不得反向 import local-record-service",
  );
  assert.ok(
    !/createMemoryPrefetchHub\(|nextSessionId/.test(moduleSource),
    "新模块不得复制 MemoryPrefetchHub 实现（pipeline 既有公开契约）",
  );
});

test("普通回合：begin 先于编排、按既有角色顺序 consume、end 收尾同一会话，预取内容原样进 presence 载荷", async () => {
  const spy = createPrefetchSpy();
  const drafts: DraftObservation[] = [];
  const { service } = createFixture({
    memoryPrefetch: spy,
    presenceAssessor: createSpeakingGate(),
    onDraft: (observation) => drafts.push(observation),
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "prefetch-turn-normal",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // begin 必须先于首个编排调用；回合退出恰好 end 一次且清理同一会话。
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);
  const begin = spy.beginCalls[0]!;
  assert.equal(begin.input.recordId, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(begin.input.playerText, "我环顾四周。");
  assert.deepEqual(
    begin.input.characters.map((character) => character.characterInstanceId),
    [POSTGRES_DEMO_IDS.scoutInstance, POSTGRES_DEMO_IDS.scholarInstance],
  );
  assert.ok(spy.markers.indexOf("begin") < spy.markers.indexOf("consume"));
  assert.ok(spy.markers.indexOf("consume") < spy.markers.indexOf("end"));
  assert.equal(spy.endCalls[0]!.handle.sessionId, spy.beginHandles[0]!.sessionId);

  // consume 按既有 aiCharacters 顺序同步发起（fail-closed，不等待）。
  assert.deepEqual(
    spy.consumeCalls.map((call) => call.characterInstanceId),
    [POSTGRES_DEMO_IDS.scoutInstance, POSTGRES_DEMO_IDS.scholarInstance],
  );
  assert.ok(
    spy.consumeCalls.every((call) => call.recordId === LOCAL_RECORD_SCOPE.recordId),
  );

  // presence 继续接收同样的 ReadonlyMap 载荷：在场回合 plan 携带该角色
  // 预取内容（payload 结构/调用顺序/fire-and-forget 语义不变）。
  await waitFor(() => drafts.some((draft) => draft.presenceMemories !== null));
  const presenceDraft = drafts.find((draft) => draft.presenceMemories !== null)!;
  assert.equal(presenceDraft.presenceMemories, PREFETCHED_LINE);
});

test("replay 回合不发起预取（无模型调用）", async () => {
  const spy = createPrefetchSpy();
  const { service } = createFixture({ memoryPrefetch: spy });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "先不要拆信。",
    idempotencyKey: "prefetch-replay",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);

  const replay = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "先不要拆信。",
    idempotencyKey: "prefetch-replay",
    writeToken: initial.writeToken,
  });
  assert.equal(replay.disposition, "duplicate");
  assert.equal(spy.beginCalls.length, 1, "replay 不得再次 begin");
  assert.equal(spy.endCalls.length, 1, "replay 不产生新的 end");
});

test("回合失败/异常：finally 一律 end 清理预取会话", async () => {
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
      idempotencyKey: "prefetch-turn-failure",
      writeToken: initial.writeToken,
    }),
  );
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1, "失败路径也必须 end 清理会话");
  assert.equal(spy.endCalls[0]!.handle.sessionId, spy.beginHandles[0]!.sessionId);
});

test("插话回合：开始即 begin 自有会话、按 record/角色语义消费、退出清理；玩家回合迟到的 end 不杀插话会话（同一 record 会话替换隔离）", async () => {
  const spy = createPrefetchSpy();
  const drafts: DraftObservation[] = [];
  // 强制插话：验证插话回合走自己的 begin/consume/end 生命周期。
  const interjectionPolicy: InterjectionPolicy = {
    evaluate({ availableCharacters }) {
      const character = availableCharacters[0];
      if (!character) return { kind: "silent" as const, reason: "测试无可插话角色。" };
      return { kind: "interject" as const, character, reason: "测试强制插话。" };
    },
  };
  const { service } = createFixture({
    memoryPrefetch: spy,
    interjectionPolicy,
    onDraft: (observation) => drafts.push(observation),
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "塞娜，你怎么看这封信？",
    idempotencyKey: "prefetch-interjection",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // 玩家回合 begin 一次；插话在玩家回合退出前同步发起自己的会话（替换
  // 同一 record 的旧会话），玩家回合 finally 的迟到 end 必须被会话标识
  // 隔离——插话会话存活并可供消费。
  await waitFor(() => spy.beginCalls.length >= 2 && spy.endCalls.length >= 2);
  assert.equal(spy.beginCalls.length, 2, "插话回合必须发起自己的预取会话");
  assert.equal(spy.endCalls.length, 2, "两个回合各自清理自己的预取会话");
  assert.notEqual(
    spy.beginHandles[0]!.sessionId,
    spy.beginHandles[1]!.sessionId,
    "玩家回合与插话回合会话标识必须不同",
  );
  // 第一个 end 是玩家回合的迟到清理，目标是被替换的旧会话。
  assert.equal(spy.endCalls[0]!.handle.sessionId, spy.beginHandles[0]!.sessionId);
  // 插话 begin 与玩家回合 end 的相对顺序：插话 begin 先于玩家 end 落地
  // （fire-and-forget 同步发起），替换隔离因此生效。
  const secondBeginIndex = spy.markers.lastIndexOf("begin");
  const firstEndIndex = spy.markers.indexOf("end");
  assert.ok(secondBeginIndex < firstEndIndex);

  // 插话 draft 消费到的是自己会话的预取内容（未被玩家回合 end 清掉）。
  const interjectionDraft = drafts.find((draft) => draft.turnIntent.includes("插话"));
  assert.ok(interjectionDraft, "插话回合必须执行 draft");
  assert.equal(interjectionDraft!.recalledAtDraft, PREFETCHED_LINE);
});

test("fail-closed：recall 永久 pending 时 consume 返回空串——回合照常提交、presence 载荷为空、不等待不抛错", async () => {
  const spy = createPrefetchSpy({
    recall: () => new Promise<string>(() => undefined), // 永不就绪
  });
  const drafts: DraftObservation[] = [];
  const { service } = createFixture({
    memoryPrefetch: spy,
    presenceAssessor: createSpeakingGate(),
    onDraft: (observation) => drafts.push(observation),
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "prefetch-pending",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);
  assert.equal(spy.consumeCalls.length, 2, "pending 也同步 consume（不等待）");

  await waitFor(() => drafts.some((draft) => draft.presenceMemories !== null));
  const presenceDraft = drafts.find((draft) => draft.presenceMemories !== null)!;
  assert.equal(presenceDraft.presenceMemories, "", "pending fail-closed 为空串");
});

test("fail-closed：recall 拒绝时 consume 返回空串——回合照常提交、不抛错", async () => {
  const spy = createPrefetchSpy({
    recall: () => Promise.reject(new Error("recall backend down")),
  });
  const drafts: DraftObservation[] = [];
  const { service } = createFixture({
    memoryPrefetch: spy,
    presenceAssessor: createSpeakingGate(),
    onDraft: (observation) => drafts.push(observation),
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "prefetch-recall-failed",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed", "召回失败绝不影响回合提交");
  assert.equal(spy.beginCalls.length, 1);
  assert.equal(spy.endCalls.length, 1);

  await waitFor(() => drafts.some((draft) => draft.presenceMemories !== null));
  const presenceDraft = drafts.find((draft) => draft.presenceMemories !== null)!;
  assert.equal(presenceDraft.presenceMemories, "", "failed fail-closed 为空串");
});
