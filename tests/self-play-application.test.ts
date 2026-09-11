/**
 * 批次 T7 世界自演——应用层测试（docs/development/T7-OBSERVATION-VISION.md §4.2）。
 * 覆盖：start→拍循环→completed 全链落库、stop 拍间收束 cancelled、start 幂等
 * 重入单飞、版本冲突重读重试一次、拍模型失败 fail-closed 且不影响玩家回合、
 * 未装配账本时 startSelfPlay 抛 LOCAL_RUNTIME_NOT_INITIALIZED。
 * 不新增 mock：编排器为既有 createLocalM2TurnOrchestrator 或内联确定性实现；
 * 会话账本为接口的内存实现（SelfPlayStore 契约）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RecordProjection, ProjectionEvent } from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import {
  isSelfPlayTerminal,
  type SelfPlaySession,
  type SelfPlayStore,
} from "../modules/application/self-play.ts";
import {
  createCommandFingerprint,
  createInMemoryRuntimeRepository,
  createReleaseFingerprint,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import {
  fallbackSemanticSegments,
  type SemanticSegment,
} from "../modules/presentation/semantic-segments.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnCandidate,
  type M2TurnOrchestrator,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

type SelfPlayMarker = { beat: number };
type CommandPayload = {
  text: string;
  visibility: TurnVisibilityPlan;
  selfPlay?: { beat: number; instruction: string };
};
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  actionTransaction?: ActionTransaction;
  selfPlay?: SelfPlayMarker;
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

function demoCharacters() {
  return [
    {
      characterInstanceId: "char_inst_scout",
      participantId: "participant_scout",
      displayName: "塞娜",
    },
    {
      characterInstanceId: "char_inst_scholar",
      participantId: "participant_scholar",
      displayName: "弥洛",
    },
  ] as Parameters<typeof createLocalM2TurnOrchestrator>[0]["characters"] extends readonly (infer T)[]
    ? T[]
    : never;
}

/** SelfPlayStore 契约的内存实现（状态迁移守卫与 PG 实现同语义）。 */
function createInMemorySelfPlayStore() {
  const sessions: SelfPlaySession[] = [];
  let clockTick = 0;
  const stamp = () => new Date(1_800_000_000_000 + ++clockTick * 1000).toISOString();
  const find = (sessionId: string) =>
    sessions.find((session) => session.id === sessionId);
  const store: SelfPlayStore = {
    async findLatest(recordId) {
      return sessions.filter((session) => session.recordId === recordId).at(-1)
        ?? null;
    },
    async start(input) {
      const active = sessions.find(
        (session) => session.recordId === input.recordId
          && (session.state === "running" || session.state === "stopping"),
      );
      if (active) return { session: active, created: false };
      const session: SelfPlaySession = {
        id: input.sessionId,
        recordId: input.recordId,
        worldId: input.worldId,
        state: "running",
        beatBudget: Math.min(Math.max(Math.trunc(input.beatBudget), 0), 5),
        beatsCompleted: 0,
        requestedBy: input.requestedBy,
        lastError: null,
        createdAt: stamp(),
        updatedAt: stamp(),
      };
      sessions.push(session);
      return { session, created: true };
    },
    async load(sessionId) {
      return find(sessionId) ?? null;
    },
    async completeBeat(sessionId) {
      const session = find(sessionId);
      if (
        !session || (session.state !== "running" && session.state !== "stopping")
      ) return null;
      session.beatsCompleted += 1;
      session.updatedAt = stamp();
      return session;
    },
    async requestStop(recordId) {
      const session = sessions.find(
        (candidate) => candidate.recordId === recordId
          && candidate.state === "running",
      );
      if (!session) return null;
      session.state = "stopping";
      session.updatedAt = stamp();
      return session;
    },
    async finish(sessionId, state, lastError) {
      const session = find(sessionId);
      if (
        !session || (session.state !== "running" && session.state !== "stopping")
      ) return;
      session.state = state;
      session.lastError = lastError ?? null;
      session.updatedAt = stamp();
    },
    async failStale(recordId, cutoff) {
      for (const session of sessions) {
        if (
          session.recordId === recordId
          && (session.state === "running" || session.state === "stopping")
          && session.updatedAt < cutoff.toISOString()
        ) {
          session.state = "failed";
          session.lastError = "SELFPLAY_STALE";
        }
      }
    },
  };
  return { store, sessions };
}

function openingEvent(): ProjectionEvent {
  return {
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
    createdAt: "2026-08-13T01:00:00.000Z",
  };
}

function baseProjection(events: ProjectionEvent[]): RecordProjection {
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
    cast: [],
    participants: [],
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
  } as RecordProjection;
}

function createFixture(options: {
  orchestrator?: M2TurnOrchestrator;
  beatBudget?: number;
  withStore?: boolean;
} = {}) {
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  let tokenSequence = 0;
  let idSequence = 0;
  async function loadProjection() {
    const runtimeEvents = await repository.listCommittedEvents(
      LOCAL_RECORD_SCOPE.recordId,
    );
    const events: ProjectionEvent[] = [openingEvent()].concat(
      runtimeEvents.map((event, index) => ({
        id: event.eventId,
        ordinal: index + 2,
        type: event.kind === "narration.committed" ? "narration" : "utterance",
        speaker: event.payload.speaker,
        speakerParticipantId: event.payload.participantId,
        role: event.payload.role,
        content: event.payload.content,
        segments: event.payload.segments,
        worldTime: "停战纪元17年 · 雾月12日 · 入夜",
        visibility: "public",
        status: "committed" as const,
        createdAt: event.committedAt,
        ...(event.payload.selfPlay ? { selfPlay: event.payload.selfPlay } : {}),
      })),
    );
    return baseProjection(events);
  }
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return loadProjection();
    },
    async loadDeliveryForPlayer() {
      return {
        record: await loadProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: null,
          membershipRole: "observer" as const,
        },
      };
    },
  };
  const tokens = createMemoryWriteTokenRegistry({
    randomToken: () => `opaque-${++tokenSequence}`,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
  });
  const selfPlay = createInMemorySelfPlayStore();
  const service = createLocalRecordService({
    repository,
    projection,
    tokens,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => `local-${++idSequence}`,
    ...(options.orchestrator ? { orchestrator: options.orchestrator } : {}),
    ...(options.withStore === false
      ? {}
      : { selfPlayStore: selfPlay.store }),
    ...(options.beatBudget === undefined
      ? {}
      : { selfPlayBeatBudget: options.beatBudget }),
  });
  return { repository, service, selfPlay };
}

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function waitForSessionState(
  store: SelfPlayStore,
  recordId: string,
): Promise<SelfPlaySession | null> {
  await waitFor(async () => {
    const session = await store.findLatest(recordId);
    return session !== null && isSelfPlayTerminal(session.state);
  });
  return store.findLatest(recordId);
}

test("T7 start→拍循环→completed：自演事件落时间线（无玩家事件，带拍号标记），账本收束", async () => {
  const { repository, service, selfPlay } = createFixture({ beatBudget: 2 });

  const session = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(session.state, "running");
  assert.equal(session.beatBudget, 2);

  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 2);

  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  // 每拍 = 旁白 + 角色事件；本地编排不产行动事务/玩家事件。
  const selfPlayEvents = events.filter(
    (event) => event.payload.selfPlay !== undefined,
  );
  assert.ok(selfPlayEvents.length >= 2, "self-play events must be committed");
  assert.deepEqual(
    [...new Set(selfPlayEvents.map((event) => event.payload.selfPlay!.beat))].sort(),
    [1, 2],
  );
  assert.ok(
    selfPlayEvents.some((event) => event.kind === "narration.committed"),
    "each beat carries narration",
  );
  assert.ok(
    events.every((event) => event.payload.role !== "player"),
    "self-play never commits a player event",
  );
  // 头指针连续：初始 v1 + 两拍各推进一版。
  const head = await repository.loadRecordHead(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(head?.version, 3);

  // 信封投影透出终态。
  const envelope = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(envelope.selfPlay?.state, "completed");
  assert.equal(envelope.selfPlay?.beatsCompleted, 2);
  assert.equal(envelope.selfPlay?.beatBudget, 2);
});

test("T7 stop 于拍间：在途拍跑完计入账目，拍边界收束 cancelled，事件保留", async () => {
  const inner = createLocalM2TurnOrchestrator({ characters: [...demoCharacters()] });
  let draftCount = 0;
  let gateRelease: (() => void) | null = null;
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      draftCount += 1;
      if (draftCount === 2) {
        // 第二拍生成挂起，直到测试在拍间发起 stop。
        await new Promise<void>((resolve) => {
          gateRelease = resolve;
        });
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const { service, selfPlay } = createFixture({ orchestrator, beatBudget: 2 });

  const session = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  // 等第一拍落账、第二拍进入生成。
  assert.equal(
    await waitFor(async () =>
      (await selfPlay.store.load(session.id))?.beatsCompleted === 1
    ),
    true,
  );
  assert.equal(
    await waitFor(() => draftCount === 2),
    true,
  );
  const stopping = await service.stopSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(stopping?.state, "stopping");
  gateRelease!();

  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "cancelled");
  // 在途拍跑完且如实计入（stopping 下 completeBeat 仍记账）。
  assert.equal(final?.beatsCompleted, 2);
});

test("T7 start 幂等重入：活动会话在→同一会话不重复起拍（单飞）", async () => {
  const { repository, service, selfPlay } = createFixture({ beatBudget: 2 });

  const first = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  const second = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(second.id, first.id, "re-entry returns the active session");
  assert.equal(selfPlay.sessions.length, 1);

  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "completed");
  // 单飞：旁白事件恰为预算拍数（重复 start 没有催生出第二个拍循环）。
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  const narrations = events.filter(
    (event) => event.kind === "narration.committed"
      && event.payload.selfPlay !== undefined,
  );
  assert.equal(narrations.length, 2);
});

test("T7 版本冲突重读重试一次：生成期间异步落库推进版本，自演拍重试落库", async () => {
  const inner = createLocalM2TurnOrchestrator({ characters: [...demoCharacters()] });
  let drafts = 0;
  let repositoryRef: Repository | null = null;
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      drafts += 1;
      if (drafts === 1 && repositoryRef) {
        // 第一拍生成期间：模拟场景晶化异步落库（v1 → v2），
        // 使首次提交撞 RECORD_VERSION_CONFLICT。
        await commitSystemCorrection(repositoryRef, 1);
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const fixture = createFixture({ orchestrator, beatBudget: 1 });
  repositoryRef = fixture.repository;
  const { service, selfPlay } = fixture;

  await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 1);
  // 重试证据：首次生成撞冲突 + 重读快照重试一次（draft 恰好两次）。
  assert.equal(drafts, 2);
  // 版本序列：初始 v1 → 晶化 v2 → 自演拍重试 v3。
  const head = await fixture.repository.loadRecordHead(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(head?.version, 3);
});

/** 与 presence-application 同型：确定性落一条 system.correction（推进 record 版本）。 */
async function commitSystemCorrection(
  repository: Repository,
  expectedVersion: number,
): Promise<void> {
  const now = "2026-08-13T02:00:05.000Z";
  const turnId = "turn_crystal_correction";
  const command = {
    commandType: "scene.crystallization",
    recordId: LOCAL_RECORD_SCOPE.recordId,
    expectedRecordVersion: expectedVersion,
    idempotencyKey: "crystal-during-selfplay",
    actorId: null,
    payload: { text: "", visibility: { kind: "public" as const } },
  };
  let run = (await repository.acceptCommand({
    turnId,
    command,
    commandFingerprint: createCommandFingerprint(command),
    now,
  })).run;
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "accepted",
    nextState: "planning",
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "planning",
    nextState: "drafting",
    plan: {
      planId: "plan_crystal",
      body: {
        goal: "场景晶化",
        constraints: [],
        activatedCharacters: [],
        narratorEnabled: false,
        actionBudgetPerCharacter: 0,
        visibility: { kind: "public" as const },
      },
      createdAt: now,
    },
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "drafting",
    nextState: "validating",
    candidate: {
      candidateId: "candidate_crystal",
      body: { narration: null, characterResponses: [], actionTransactions: [] },
      createdAt: now,
      draftingAttempt: 1,
    },
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "validating",
    nextState: "releasing",
    validation: {
      validationId: "validation_crystal",
      body: {
        accepted: true,
        goalSatisfied: true,
        worldCompatible: true,
        actionTransactionsComplete: true,
        narratorChecked: true,
        activatedCharacterCount: 0,
      },
      createdAt: now,
    },
    now,
  });
  const bundle = {
    formalEvents: [
      {
        eventId: "event_crystal_correction",
        kind: "system.correction.committed",
        payload: {
          schemaVersion: 1 as const,
          role: "system" as const,
          speaker: "界核",
          participantId: null,
          content: "场景定格 — 场景移至北防波堤。",
          segments: fallbackSemanticSegments(
            "场景定格 — 场景移至北防波堤。",
            "environment",
          ),
        },
      },
    ],
    outbox: [],
  };
  await repository.commitRelease({
    turnId,
    expectedRevision: run.revision,
    bundle,
    releaseFingerprint: createReleaseFingerprint(bundle),
    now,
  });
}

test("T7 拍模型失败 fail-closed：会话 failed + lastError，玩家回合主路径不受影响", async () => {
  const inner = createLocalM2TurnOrchestrator({ characters: [...demoCharacters()] });
  let plans = 0;
  const orchestrator: M2TurnOrchestrator = {
    async plan(input) {
      plans += 1;
      if (plans === 1) throw new Error("model offline");
      return inner.plan(input);
    },
    draft: (input) => inner.draft(input),
    validate: (input) => inner.validate(input),
  };
  const { service, selfPlay } = createFixture({ orchestrator, beatBudget: 2 });

  await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "failed");
  // 模型规划抛错经 Turn 状态机落成步骤失败码，原样入账本。
  assert.equal(final?.lastError, "TURN_STEP_FAILED");
  assert.equal(final?.beatsCompleted, 0);

  // 主路径：玩家回合照常提交。
  const initial = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我沿着防波堤慢慢走。",
    idempotencyKey: "after-selfplay-failure",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
});

test("T7 未装配会话账本：startSelfPlay/stopSelfPlay 抛 LOCAL_RUNTIME_NOT_INITIALIZED", async () => {
  const { service } = createFixture({ withStore: false });
  await assert.rejects(
    () => service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId),
    (error: unknown) =>
      error instanceof LocalRecordServiceError
      && error.code === "LOCAL_RUNTIME_NOT_INITIALIZED",
  );
  await assert.rejects(
    () => service.stopSelfPlay(LOCAL_RECORD_SCOPE.recordId),
    (error: unknown) =>
      error instanceof LocalRecordServiceError
      && error.code === "LOCAL_RUNTIME_NOT_INITIALIZED",
  );
});

test("T7 预算钳制：注入预算超硬上限时按硬上限收（可降不可升）", async () => {
  const { service, selfPlay } = createFixture({ beatBudget: 99 });
  const session = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(session.beatBudget, 5);
  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 5);
});

/**
 * 批次 T10-A：self-play 拍与玩家回合共用 model-powered validate 路径
 * （调用图：payload.selfPlay → createLocalTurnDependencies validator →
 * orchestrator.validate → reviewCandidateWithModel）。复核三连否决时
 * 拍不裸挂——确定性降级接受，会话照常 completed。
 */
test("T10-A self-play 共享复核路径：三连否决降级接受，拍落库会话完成", async () => {
  const reviewProbeGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request: { messages: readonly { role: string; content: string }[] }) {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("DM Controller")) {
        return {
          model: "fake",
          content: JSON.stringify({
            goal: "世界自演一拍",
            activatedCharacterInstanceIds: ["char_inst_scout"],
            narratorEnabled: true,
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      }
      if (system.includes("DM output reviewer")) {
        return {
          model: "fake",
          content: JSON.stringify({
            accepted: false,
            goalSatisfied: false,
            worldCompatible: false,
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      }
      // 旁白/角色生成：输出最小合法结构。
      if (system.includes("independent Narrator")) {
        return {
          model: "fake",
          content: JSON.stringify({
            environment: "雾气在谷地里缓慢流动。",
            storyBeat: "山谷保持安静。",
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      }
      return {
        model: "fake",
        content: JSON.stringify({
          action: "塞娜留意着山谷的动静。",
          dialogue: "“这里很安静。”",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  const { createModelPoweredM2TurnOrchestrator } = await import(
    "../modules/orchestration/public.ts"
  );
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [...demoCharacters()],
    getGateway: async () => reviewProbeGateway,
  });
  const { repository, service, selfPlay } = createFixture({
    orchestrator,
    beatBudget: 1,
  });

  await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
  const final = await waitForSessionState(selfPlay.store, LOCAL_RECORD_SCOPE.recordId);
  // 降级接受：拍不裸挂（修复前此处必 failed/DM_OUTPUT_REJECTED）。
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 1);
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.ok(
    events.some((event) => event.payload.selfPlay !== undefined),
    "degraded beat still commits its events",
  );
});
