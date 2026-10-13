/**
 * Slice 3：self-play 拍调度迁入统一 durable job host。
 * 覆盖：scheduleSelfPlay 入队 beat job → claimed job 执行拍（真
 * executeTurn 链）→ 计拍 → 链式入队下一拍 → 预算收 completed；
 * stale recovery（worker 崩溃 claimed 行租约过期回收重跑，CAS 不重复
 * 计拍）；幂等 complete（重放 settled）；失败收束（模型失败 → 会话
 * failed + job completed；handler 抛错 → job failed）；无效 payload
 * fail-closed；跨 record 隔离。不触真实数据库/模型——内存队列 +
 * SelfPlayStore 契约内存实现 + 既有内存 runtime 仓储。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_RECORD_SCOPE,
  demoRecordRuntimeScope,
} from "../modules/application/local-record-read-model.ts";
import {
  createLocalSelfPlayCoordinator,
  createSelfPlayBeatHandler,
} from "../modules/application/local-record-self-play.ts";
import {
  createLocalTurnDependencies,
  type ActiveTurnSignal,
  type LocalRuntimeRepository,
} from "../modules/application/local-record-turn-runtime.ts";
import {
  isSelfPlayTerminal,
  type SelfPlaySession,
  type SelfPlayStore,
} from "../modules/application/self-play.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnOrchestrator,
} from "../modules/orchestration/public.ts";
import {
  createInMemoryDurableJobQueue,
  runDurableJobCycle,
  type DurableJobHandler,
  type DurableJobHandlerRegistry,
  type DurableJobKind,
} from "../modules/application/unified-durable-job-host.ts";

const RECORD_ID = LOCAL_RECORD_SCOPE.recordId;
const CLOCK = () => new Date("2026-08-13T02:00:00.000Z");
const NOW = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-11T00:10:01.000Z";

/** SelfPlayStore 内存实现——completeBeat 支持 expectedBeat CAS。 */
function createInMemorySelfPlayStore() {
  const sessions: SelfPlaySession[] = [];
  let clockTick = 0;
  const stamp = () => new Date(1_800_000_000_000 + ++clockTick * 1000).toISOString();
  const find = (sessionId: string) => sessions.find((s) => s.id === sessionId);
  const store: SelfPlayStore = {
    async findLatest(recordId) {
      return sessions.filter((s) => s.recordId === recordId).at(-1) ?? null;
    },
    async start(input) {
      const active = sessions.find(
        (s) => s.recordId === input.recordId
          && (s.state === "running" || s.state === "stopping"),
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
    async completeBeat(sessionId, expectedBeat) {
      const session = find(sessionId);
      if (!session || (session.state !== "running" && session.state !== "stopping")) {
        return null;
      }
      // durable CAS：拍号错位（崩溃重放/重复落账）返回 null，不重复 +1。
      if (expectedBeat !== undefined && session.beatsCompleted !== expectedBeat - 1) {
        return null;
      }
      session.beatsCompleted += 1;
      session.updatedAt = stamp();
      return session;
    },
    async requestStop(recordId) {
      const session = sessions.find(
        (s) => s.recordId === recordId && s.state === "running",
      );
      if (!session) return null;
      session.state = "stopping";
      session.updatedAt = stamp();
      return session;
    },
    async finish(sessionId, state, lastError) {
      const session = find(sessionId);
      if (!session || (session.state !== "running" && session.state !== "stopping")) return;
      session.state = state;
      session.lastError = lastError ?? null;
      session.updatedAt = stamp();
    },
    async failStale() {},
  };
  return { store, sessions };
}

function characters() {
  return [
    {
      characterInstanceId: "char_inst_scout",
      participantId: "participant_scout",
      displayName: "塞娜",
    },
  ];
}

function createFixture(options: { orchestrator?: M2TurnOrchestrator } = {}) {
  let clock = NOW;
  const queue = createInMemoryDurableJobQueue({
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    leaseOwner: "test-worker",
    leaseDurationMs: 60_000,
    clock: () => clock,
  });
  const beatQueue = {
    enqueueBeat(input: {
      sessionId: string;
      recordId: string;
      beat: number;
      principalId?: string;
    }) {
      void queue.enqueue({
        jobId: `self-play-beat:${input.sessionId}:${input.beat}`,
        kind: "self-play-beat",
        recordId: input.recordId,
        payload: {
          sessionId: input.sessionId,
          beat: input.beat,
          ...(input.principalId !== undefined
            ? { principalId: input.principalId }
            : {}),
        },
        requeueTerminal: true,
      }).catch(() => undefined);
    },
  };
  const selfPlay = createInMemorySelfPlayStore();
  const turnSignals = new Map<string, ActiveTurnSignal>();
  const repositories = new Map<string, LocalRuntimeRepository>();
  const idSequences = new Map<string, number>();
  const nextId = (recordId: string) => {
    const next = (idSequences.get(recordId) ?? 0) + 1;
    idSequences.set(recordId, next);
    return `durable-${recordId}-${next}`;
  };
  const repositoryFor = (recordId: string) => {
    let repository = repositories.get(recordId);
    if (!repository) {
      repository = createInMemoryRuntimeRepository({
        recordHeads: [{ recordId, version: 1, nextOrdinal: 2 }],
      });
      repositories.set(recordId, repository);
    }
    return repository;
  };
  const memorySyncCalls: string[] = [];
  const crystallizationCalls: string[] = [];
  const dependenciesFor = (recordId: string) => {
    const repository = repositoryFor(recordId);
    return {
      store: selfPlay.store,
      beatQueue,
      turnControl: createTurnControl({}),
      turnSignals,
      runtimeDependencies: createLocalTurnDependencies(
        repository,
        CLOCK,
        () => nextId(recordId),
        options.orchestrator,
        turnSignals,
      ),
      loadSnapshot: async () => ({
        canonicalVersion: (await repository.loadRecordHead(recordId))!.version,
        projection: { world: { language: "zh-CN" } },
      }),
      memorySync: {
        schedule(scope: { recordId: string }) {
          memorySyncCalls.push(scope.recordId);
        },
      },
      scheduleSceneCrystallization(input: { recordId: string }) {
        crystallizationCalls.push(input.recordId);
      },
      resolveRuntimeScope: async () => demoRecordRuntimeScope(),
    };
  };
  const handlers: DurableJobHandlerRegistry = new Map<DurableJobKind, DurableJobHandler>();
  const coordinators = new Map<string, ReturnType<typeof createLocalSelfPlayCoordinator>>();
  const handlerFor = (recordId: string) => createSelfPlayBeatHandler(dependenciesFor(recordId));
  const coordinatorFor = (recordId: string) => {
    let coordinator = coordinators.get(recordId);
    if (!coordinator) {
      coordinator = createLocalSelfPlayCoordinator(dependenciesFor(recordId));
      coordinators.set(recordId, coordinator);
    }
    return coordinator;
  };
  // 单 handler 按 session→record 路由（真实装配是每服务实例一个 handler；
  // 测试里两个 record 共用队列，经 store.load 的 session.recordId 路由）。
  handlers.set("self-play-beat", async (job) => {
    const session = await selfPlay.store.load(
      (job.payload as { sessionId: string }).sessionId,
    );
    return handlerFor(session?.recordId ?? job.recordId)(job);
  });
  const cycle = () =>
    runDurableJobCycle({
      slot: { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, queue },
      handlers,
      now: clock,
    });
  const flush = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return {
    queue,
    selfPlay,
    beatQueue,
    handlers,
    cycle,
    flush,
    coordinatorFor,
    memorySyncCalls,
    crystallizationCalls,
    turnSignals,
    setClock(value: string) {
      clock = value;
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;

async function beginSession(
  fixture: Fixture,
  recordId: string,
  beatBudget: number,
  sessionId: string,
): Promise<SelfPlaySession> {
  const { session, created } = await fixture.selfPlay.store.start({
    sessionId,
    recordId,
    worldId: "world_ember_coast",
    beatBudget,
    requestedBy: LOCAL_RECORD_SCOPE.principalId,
  });
  assert.equal(created, true);
  fixture.coordinatorFor(recordId).scheduleSelfPlay({
    sessionId: session.id,
    recordId,
    runtimeScope: demoRecordRuntimeScope(),
  });
  await fixture.flush();
  return session;
}

async function drain(fixture: Fixture, limit = 20): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (!(await fixture.cycle())) return;
    await fixture.flush();
  }
}

test("self-play beat job：入队→claim→拍执行→计拍→链式入队→预算收 completed", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 2, "sess-chain");
  // scheduleSelfPlay 的 durable 路径只入队第一拍，不进程内起拍。
  assert.equal(fixture.queue.inspect(`self-play-beat:${session.id}:1`)?.state, "pending");
  assert.equal((await fixture.selfPlay.store.load(session.id))?.state, "running");

  await drain(fixture);
  const final = await fixture.selfPlay.store.load(session.id);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 2);
  assert.equal(fixture.queue.inspect(`self-play-beat:${session.id}:1`)?.state, "completed");
  assert.equal(fixture.queue.inspect(`self-play-beat:${session.id}:2`)?.state, "completed");
  // 拍后 memorySync/晶化各一次一拍。
  assert.equal(fixture.memorySyncCalls.length, 2);
  assert.equal(fixture.crystallizationCalls.length, 2);
  assert.equal(fixture.turnSignals.size, 0);
});

test("self-play beat job：stale recovery——崩溃 claimed 行回收重跑，CAS 不重复计拍", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 2, "sess-stale");
  // worker 崩溃：claim 后不处理。
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["self-play-beat"] });
  assert.ok(claimed);
  assert.equal(claimed.attemptCount, 1);
  // 租约过期回收：重跑同一拍（拍号以账本为准，幂等键去重回合）。
  fixture.setClock(LATER);
  await drain(fixture);
  const final = await fixture.selfPlay.store.load(session.id);
  assert.equal(final?.state, "completed");
  assert.equal(final?.beatsCompleted, 2, "崩溃重跑不得重复计拍");
  assert.equal(fixture.queue.inspect(`self-play-beat:${session.id}:1`)?.attemptCount, 2);
});

test("self-play beat job：幂等 complete——重放 settled，账本不再变化", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 1, "sess-idem");
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["self-play-beat"] });
  assert.ok(claimed);
  assert.equal(await fixture.queue.complete(claimed, NOW), "applied");
  assert.equal(await fixture.queue.complete(claimed, NOW), "settled");
  assert.equal(await fixture.queue.fail(claimed, "X", NOW), "stale");
  assert.equal(fixture.queue.inspect(`self-play-beat:${session.id}:1`)?.state, "completed");
});

test("self-play beat job：completeBeat CAS——重复落账返回 null，不重复 +1", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 2, "sess-cas");
  const first = await fixture.selfPlay.store.completeBeat(session.id, 1);
  assert.equal(first?.beatsCompleted, 1);
  const replay = await fixture.selfPlay.store.completeBeat(session.id, 1);
  assert.equal(replay, null, "同一拍号重复落账被 CAS 拒绝");
  const second = await fixture.selfPlay.store.completeBeat(session.id, 2);
  assert.equal(second?.beatsCompleted, 2);
});

test("self-play beat job：拍模型失败——会话收 failed，job 正常收 completed", async () => {
  const inner = createLocalM2TurnOrchestrator({ characters: characters() });
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
  const session = await beginSession(fixture, RECORD_ID, 2, "sess-fail");
  await drain(fixture);
  const final = await fixture.selfPlay.store.load(session.id);
  assert.equal(final?.state, "failed");
  assert.equal(final?.lastError, "TURN_STEP_FAILED");
  assert.equal(final?.beatsCompleted, 0);
  assert.equal(
    fixture.queue.inspect(`self-play-beat:${session.id}:1`)?.state,
    "completed",
    "业务失败收束进会话账本；job 本身已完成其工作",
  );
  assert.equal(fixture.turnSignals.size, 0);
});

test("self-play beat job：handler 抛错——job 落 failed 且有界 code", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 1, "sess-broken");
  fixture.handlers.set("self-play-beat", async () => {
    throw Object.assign(new Error("scope exploded"), { code: "SELFPLAY_SCOPE_UNAVAILABLE" });
  });
  await fixture.cycle();
  const row = fixture.queue.inspect(`self-play-beat:${session.id}:1`);
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastErrorCode, "SELFPLAY_SCOPE_UNAVAILABLE");
  assert.equal((await fixture.selfPlay.store.load(session.id))?.state, "running");
});

test("self-play beat job：无效 payload fail-closed——job 落 failed，账本不动", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 1, "sess-invalid");
  await fixture.queue.enqueue({
    jobId: `self-play-beat:${session.id}:9`,
    kind: "self-play-beat",
    recordId: RECORD_ID,
    payload: { sessionId: session.id, beat: "nine" },
  });
  // beat 1 的合法 job 先被认领（id 排序在前）；第二个 cycle 才轮到无效行。
  await fixture.cycle();
  await fixture.flush();
  await fixture.cycle();
  const row = fixture.queue.inspect(`self-play-beat:${session.id}:9`);
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastErrorCode, "JOB_PAYLOAD_INVALID");
  // 无效行不进入 handler：账本只含合法拍（beat 1），不多不少。
  assert.equal((await fixture.selfPlay.store.load(session.id))?.beatsCompleted, 1);
});

test("self-play beat job：跨 record 隔离——两会话独立成链互不影响", async () => {
  const fixture = createFixture();
  const recordB = "record_other";
  const a = await beginSession(fixture, RECORD_ID, 1, "sess-a");
  const b = await beginSession(fixture, recordB, 2, "sess-b");
  await drain(fixture);
  const finalA = await fixture.selfPlay.store.load(a.id);
  const finalB = await fixture.selfPlay.store.load(b.id);
  assert.equal(finalA?.state, "completed");
  assert.equal(finalA?.beatsCompleted, 1);
  assert.equal(finalB?.state, "completed");
  assert.equal(finalB?.beatsCompleted, 2);
  assert.deepEqual(
    fixture.crystallizationCalls.filter((id) => id === RECORD_ID).length,
    1,
  );
  assert.deepEqual(
    fixture.crystallizationCalls.filter((id) => id === recordB).length,
    2,
  );
});

test("self-play beat job：stopping 拍边界收 cancelled（durable 路径）", async () => {
  const fixture = createFixture();
  const session = await beginSession(fixture, RECORD_ID, 3, "sess-stop");
  // 跑一拍后请求停止；下一拍 handler 在拍边界收 cancelled。
  await fixture.cycle();
  await fixture.flush();
  assert.equal((await fixture.selfPlay.store.load(session.id))?.beatsCompleted, 1);
  await fixture.selfPlay.store.requestStop(RECORD_ID);
  await drain(fixture);
  const final = await fixture.selfPlay.store.load(session.id);
  assert.equal(final?.state, "cancelled");
  assert.equal(final?.beatsCompleted, 1);
  assert.ok(isSelfPlayTerminal(final!.state));
});
