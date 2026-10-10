/**
 * Phase 2F-A：Local Record self-play coordinator（拍循环调度、record 级单飞、
 * turn signal 登记/清理、版本冲突重读重试、memorySync/晶化 fire-and-forget、
 * failed/cancelled/completed 收束）已从 facade 拆入
 * modules/application/local-record-self-play.ts。本文件是拆分边界测试：
 * ① seam——facade 真实接线到新模块（import + factory 调用），不再自带第二份
 *    runSelfPlaySession/scheduleSelfPlay/selfPlayInFlight 实现，新模块不反向
 *    import facade、不复制 PG store/runtime 状态机；
 * ② behavior——无 store fail-closed、duplicate schedule single-flight、
 *    stopping 拍边界取消、budget completion、版本冲突 fresh-snapshot 重试、
 *    failed beat 收束会话、memorySync/晶化 fire-and-forget 不阻塞调度路径、
 *    turn signal 清理，全部与拆分前逐行一致。
 *
 * 不新增 mock：编排器为既有 createLocalM2TurnOrchestrator 或内联确定性实现；
 * 会话账本为 SelfPlayStore 契约的内存实现；runtime 为既有内存仓储 +
 * createLocalTurnDependencies 真实接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as selfPlayCoordinator from "../modules/application/local-record-self-play.ts";
import {
  LOCAL_RECORD_SCOPE,
  demoRecordRuntimeScope,
} from "../modules/application/local-record-read-model.ts";
import {
  createLocalTurnDependencies,
  type ActiveTurnSignal,
  type LocalRuntimeRepository,
} from "../modules/application/local-record-turn-runtime.ts";
import {
  isSelfPlayTerminal,
  selfPlayInstruction,
  type SelfPlaySession,
  type SelfPlayStore,
} from "../modules/application/self-play.ts";
import {
  createCommandFingerprint,
  createInMemoryRuntimeRepository,
  createReleaseFingerprint,
} from "../modules/runtime/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnOrchestrator,
} from "../modules/orchestration/public.ts";
import { fallbackSemanticSegments } from "../modules/presentation/semantic-segments.ts";

const RECORD_ID = LOCAL_RECORD_SCOPE.recordId;
const CLOCK = () => new Date("2026-08-13T02:00:00.000Z");

/** SelfPlayStore 契约的内存实现（与 self-play-application 测试同语义）。 */
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
    async failStale() {},
  };
  return { store, sessions };
}

function createFixture(options: {
  orchestrator?: M2TurnOrchestrator;
  withStore?: boolean;
} = {}) {
  const repository: LocalRuntimeRepository = createInMemoryRuntimeRepository({
    recordHeads: [{ recordId: RECORD_ID, version: 1, nextOrdinal: 2 }],
  });
  const runtimeScope = demoRecordRuntimeScope();
  const turnSignals = new Map<string, ActiveTurnSignal>();
  const turnControl = createTurnControl({});
  let idSequence = 0;
  const runtimeDependencies = createLocalTurnDependencies(
    repository,
    CLOCK,
    () => `local-${++idSequence}`,
    options.orchestrator,
    turnSignals,
  );
  const selfPlay = createInMemorySelfPlayStore();
  const memorySyncCalls: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
  }[] = [];
  const crystallizationCalls: selfPlayCoordinator.SelfPlayCrystallizationRequest[] = [];
  const coordinator = selfPlayCoordinator.createLocalSelfPlayCoordinator({
    ...(options.withStore === false ? {} : { store: selfPlay.store }),
    turnControl,
    turnSignals,
    runtimeDependencies,
    loadSnapshot: async () => ({
      canonicalVersion: (await repository.loadRecordHead(RECORD_ID))!.version,
      projection: { world: { language: "zh-CN" } },
    }),
    memorySync: {
      schedule(scope) {
        memorySyncCalls.push({ ...scope });
      },
    },
    scheduleSceneCrystallization(input) {
      crystallizationCalls.push(input);
    },
  });
  return {
    repository,
    runtimeScope,
    turnSignals,
    selfPlay,
    memorySyncCalls,
    crystallizationCalls,
    coordinator,
  };
}

type Fixture = ReturnType<typeof createFixture>;

/** 创建一条 running 会话并交给 coordinator 调度（返回会话行）。 */
async function beginSession(
  fixture: Fixture,
  beatBudget: number,
  sessionId = `sess-${fixture.selfPlay.sessions.length + 1}`,
): Promise<SelfPlaySession> {
  const { session, created } = await fixture.selfPlay.store.start({
    sessionId,
    recordId: RECORD_ID,
    worldId: "world_ember_coast",
    beatBudget,
    requestedBy: LOCAL_RECORD_SCOPE.principalId,
  });
  assert.equal(created, true);
  fixture.coordinator.scheduleSelfPlay({
    sessionId: session.id,
    recordId: RECORD_ID,
    runtimeScope: fixture.runtimeScope,
  });
  return session;
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

async function waitForTerminal(
  fixture: Fixture,
  sessionId: string,
): Promise<SelfPlaySession | null> {
  await waitFor(async () => {
    const session = await fixture.selfPlay.store.load(sessionId);
    return session !== null && isSelfPlayTerminal(session.state);
  });
  return fixture.selfPlay.store.load(sessionId);
}

/** 与 self-play-application 同型：确定性落一条 system.correction 推进 record 版本。 */
async function commitSystemCorrection(
  repository: LocalRuntimeRepository,
  expectedVersion: number,
): Promise<void> {
  const now = "2026-08-13T02:00:05.000Z";
  const turnId = `turn_crystal_correction_${expectedVersion}`;
  const command = {
    commandType: "scene.crystallization",
    recordId: RECORD_ID,
    expectedRecordVersion: expectedVersion,
    idempotencyKey: `crystal-during-selfplay-${expectedVersion}`,
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
        turnIntent: "场景晶化",
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
        turnIntentSatisfied: true,
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
        eventId: `event_crystal_correction_${expectedVersion}`,
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

test("seam：facade 真实接线到新模块，无第二份实现/反向 import/store 复制", () => {
  assert.equal(
    typeof selfPlayCoordinator.createLocalSelfPlayCoordinator,
    "function",
  );

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-self-play.ts"'),
    "facade 必须 import local-record-self-play.ts",
  );
  assert.ok(
    /createLocalSelfPlayCoordinator\(\{/.test(facadeSource),
    "facade 必须真实调用新模块 factory",
  );
  assert.ok(
    !/function runSelfPlaySession/.test(facadeSource),
    "facade 不得再自带 runSelfPlaySession 第二份实现",
  );
  assert.ok(
    !/function scheduleSelfPlay/.test(facadeSource),
    "facade 不得再自带 scheduleSelfPlay 第二份实现",
  );
  assert.ok(
    !/selfPlayInFlight/.test(facadeSource),
    "facade 不得再持有 selfPlayInFlight 单飞守卫",
  );

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-self-play.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "新模块不得反向 import local-record-service",
  );
  assert.ok(
    !moduleSource.includes("record_self_play_sessions"),
    "新模块不得复制 PG self-play store（SQL/表名）",
  );
  assert.ok(
    !/function (executeTurn|retryTurn|commitRelease)/.test(moduleSource),
    "新模块不得复制 runtime 状态机实现",
  );
});

test("无 store fail-closed：schedule 是 no-op，不执行任何拍、不抛错", async () => {
  const fixture = createFixture({
    withStore: false,
    orchestrator: {
      plan: async () => {
        throw new Error("orchestrator must not be called");
      },
      draft: async () => {
        throw new Error("orchestrator must not be called");
      },
      validate: async () => {
        throw new Error("orchestrator must not be called");
      },
    },
  });
  // 无账本：调度直接返回，整个拍循环结构性跳过。
  fixture.coordinator.scheduleSelfPlay({
    sessionId: "sess-none",
    recordId: RECORD_ID,
    runtimeScope: fixture.runtimeScope,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const events = await fixture.repository.listCommittedEvents(RECORD_ID);
  assert.equal(events.length, 0);
  assert.equal(fixture.turnSignals.size, 0);
});

test("budget completion：拍循环跑满预算收 completed，事件带拍号标记且无玩家事件", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, 2);

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 2);
  assert.equal(final?.lastError, null);

  const events = await fixture.repository.listCommittedEvents(RECORD_ID);
  const selfPlayEvents = events.filter(
    (event) => event.payload.selfPlay !== undefined,
  );
  assert.ok(selfPlayEvents.length >= 2, "each beat commits its events");
  assert.deepEqual(
    [...new Set(selfPlayEvents.map((event) => event.payload.selfPlay!.beat))].sort(),
    [1, 2],
  );
  assert.ok(
    events.every((event) => event.payload.role !== "player"),
    "self-play never commits a player event",
  );
  const head = await fixture.repository.loadRecordHead(RECORD_ID);
  assert.equal(head?.version, 3);
});

test("duplicate schedule single-flight：同 recordId 重复调度只跑一个拍循环", async () => {
  const fixture = createFixture();
  const { session } = await fixture.selfPlay.store.start({
    sessionId: "sess-single",
    recordId: RECORD_ID,
    worldId: "world_ember_coast",
    beatBudget: 2,
    requestedBy: LOCAL_RECORD_SCOPE.principalId,
  });
  const input = {
    sessionId: session.id,
    recordId: RECORD_ID,
    runtimeScope: fixture.runtimeScope,
  };
  fixture.coordinator.scheduleSelfPlay(input);
  fixture.coordinator.scheduleSelfPlay(input);

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 2);
  const events = await fixture.repository.listCommittedEvents(RECORD_ID);
  const narrations = events.filter(
    (event) => event.kind === "narration.committed"
      && event.payload.selfPlay !== undefined,
  );
  assert.equal(narrations.length, 2, "重复 schedule 不得催生第二个拍循环");
});

test("stopping 在拍边界取消：在途拍跑完计入，下一拍边界收 cancelled", async () => {
  const inner = createLocalM2TurnOrchestrator({
    characters: [...fixture0Characters()],
  });
  let draftCount = 0;
  let gateRelease: (() => void) | null = null;
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      draftCount += 1;
      if (draftCount === 2) {
        await new Promise<void>((resolve) => {
          gateRelease = resolve;
        });
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const fixture = createFixture({ orchestrator });
  const session = await beginSession(fixture, 2);

  assert.equal(
    await waitFor(async () =>
      (await fixture.selfPlay.store.load(session.id))?.beatsCompleted === 1
    ),
    true,
  );
  assert.equal(await waitFor(() => draftCount === 2), true);
  // 在途拍持有 selfplay- 前缀的 turn signal。
  assert.ok(
    [...fixture.turnSignals.keys()].some((key) => key.startsWith("selfplay-")),
    "in-flight beat registers a selfplay- turn signal",
  );
  const stopping = await fixture.selfPlay.store.requestStop(RECORD_ID);
  assert.equal(stopping?.state, "stopping");
  gateRelease!();

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "cancelled");
  assert.equal(final?.beatsCompleted, 2);
  assert.equal(fixture.turnSignals.size, 0, "turn signals cleaned up at exit");
});

test("version conflict fresh-snapshot retry：生成期间版本被推进，重读快照重试一次落库", async () => {
  const inner = createLocalM2TurnOrchestrator({
    characters: [...fixture0Characters()],
  });
  let drafts = 0;
  let repositoryRef: LocalRuntimeRepository | null = null;
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      drafts += 1;
      if (drafts === 1 && repositoryRef) {
        // 第一拍生成期间模拟异步落库（v1 → v2），首提交撞 RECORD_VERSION_CONFLICT。
        await commitSystemCorrection(repositoryRef, 1);
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const fixture = createFixture({ orchestrator });
  repositoryRef = fixture.repository;
  const session = await beginSession(fixture, 1);

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 1);
  assert.equal(drafts, 2, "首次撞冲突后重读快照恰好重试一次");
  const head = await fixture.repository.loadRecordHead(RECORD_ID);
  assert.equal(head?.version, 3);
});

test("failed beat settles session：拍失败落 failed + lastError，单飞守卫释放后可再起", async () => {
  const inner = createLocalM2TurnOrchestrator({
    characters: [...fixture0Characters()],
  });
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
  const fixture = createFixture({ orchestrator });
  const session = await beginSession(fixture, 2);

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "failed");
  assert.equal(final?.lastError, "TURN_STEP_FAILED");
  assert.equal(final?.beatsCompleted, 0);
  assert.equal(fixture.turnSignals.size, 0);

  // finally 释放单飞守卫：新会话可立即再调度并完成。
  const second = await beginSession(fixture, 1);
  const secondFinal = await waitForTerminal(fixture, second.id);
  assert.equal(secondFinal?.state, "completed");
  assert.equal(secondFinal?.beatsCompleted, 1);
});

test("memorySync/晶化 fire-and-forget：调度同步返回不阻塞，拍后各触发一次", async () => {
  const fixture = createFixture();
  const { session } = await fixture.selfPlay.store.start({
    sessionId: "sess-fire",
    recordId: RECORD_ID,
    worldId: "world_ember_coast",
    beatBudget: 1,
    requestedBy: LOCAL_RECORD_SCOPE.principalId,
  });
  // fire-and-forget：scheduleSelfPlay 同步返回时拍循环尚未完成。
  fixture.coordinator.scheduleSelfPlay({
    sessionId: session.id,
    recordId: RECORD_ID,
    runtimeScope: fixture.runtimeScope,
  });
  const immediate = await fixture.selfPlay.store.load(session.id);
  assert.equal(immediate?.state, "running", "调度不 await 拍循环");

  const final = await waitForTerminal(fixture, session.id);
  assert.equal(final?.state, "completed");

  assert.equal(fixture.memorySyncCalls.length, 1);
  assert.equal(fixture.memorySyncCalls[0]!.recordId, RECORD_ID);
  assert.equal(
    fixture.memorySyncCalls[0]!.workspaceId,
    fixture.runtimeScope.workspaceId,
  );
  assert.equal(fixture.crystallizationCalls.length, 1);
  const crystallization = fixture.crystallizationCalls[0]!;
  assert.equal(crystallization.recordId, RECORD_ID);
  assert.deepEqual(crystallization.visibility, { kind: "public" });
  assert.equal(
    crystallization.playerText,
    selfPlayInstruction("zh-CN"),
  );
  assert.equal(typeof crystallization.sourceEventId, "string");
  assert.equal(fixture.turnSignals.size, 0);
});

function fixture0Characters() {
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
