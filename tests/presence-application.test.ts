/**
 * 批次 T3 角色在场——应用层测试（docs/development/T3-CHARACTER-PRESENCE.md §4.2）。
 * 覆盖：触发时机（未点名回合自主发声）、预算恰 1/回合、插话优先、
 * restricted/replay 跳过、fail-closed（门禁抛错/在场回合失败）、无素材确定性沉默。
 * 不新增 mock：门禁为内联确定性实现（PresenceAssessor 接口实例）。
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
  createCommandFingerprint,
  createInMemoryRuntimeRepository,
  createReleaseFingerprint,
  FatalTurnError,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
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
import type {
  PresenceAssessor,
  PresenceDecision,
} from "../modules/orchestration/presence.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

type PresenceMarker = {
  characterInstanceId: string;
  triggerKind: "environment" | "peer" | "hook";
};
type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  actionTransaction?: ActionTransaction;
  presence?: PresenceMarker;
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

const MILO_ID = "char_inst_scholar";

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
  const cast: RecordProjection["cast"] = [{
    id: "char_def_player",
    participantId: "participant_player",
    characterInstanceId: "char_inst_player",
    name: "洛川",
    role: "人类使节",
    summary: "停战议会派来的年轻调停人。",
    status: "present",
    controlledBy: "human",
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

/** 内联确定性门禁 spy：记录调用并按固定策略裁决。 */
function createGateSpy(options: {
  decision?: (candidates: readonly { characterInstanceId: string }[]) => PresenceDecision;
  error?: Error;
} = {}) {
  const calls: { budget: number; candidateIds: string[] }[] = [];
  const assessor: PresenceAssessor = {
    async assess({ candidates, budget }) {
      calls.push({
        budget,
        candidateIds: candidates.map((character) => character.characterInstanceId),
      });
      if (options.error) throw options.error;
      if (options.decision) return options.decision(candidates);
      const milo = candidates.find(
        (candidate) => candidate.characterInstanceId === MILO_ID,
      );
      return milo
        ? {
            kind: "speak",
            characterInstanceId: MILO_ID,
            triggerKind: "peer",
            reason: "同侪发言值得接话。",
          }
        : { kind: "silent", reason: "无候选。" };
    },
  };
  return { assessor, calls };
}

function createFixture(options: {
  orchestrator?: M2TurnOrchestrator;
  turnControl?: ReturnType<typeof createTurnControl>;
  presenceAssessor?: PresenceAssessor;
  visibilityAssessor?: {
    assess(input: { playerText: string }): Promise<{
      visibility: TurnVisibilityPlan;
      reason: string;
    }>;
  };
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
    const deliveryEvents = runtimeEvents.filter(
      (event) => event.kind !== "action.transaction.committed",
    );
    const events: ProjectionEvent[] = [openingEvent()].concat(
      deliveryEvents.map((event, index) => ({
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
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const tokens = createMemoryWriteTokenRegistry({
    randomToken: () => `opaque-${++tokenSequence}`,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
  });
  const service = createLocalRecordService({
    repository,
    projection,
    tokens,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => `local-${++idSequence}`,
    ...(options.orchestrator ? { orchestrator: options.orchestrator } : {}),
    ...(options.turnControl ? { turnControl: options.turnControl } : {}),
    ...(options.presenceAssessor
      ? { presenceAssessor: options.presenceAssessor }
      : {}),
    ...(options.visibilityAssessor
      ? { visibilityAssessor: options.visibilityAssessor }
      : {}),
  });
  return { repository, service };
}

async function waitForEvent(
  repository: Repository,
  predicate: (payload: EventPayload) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
    if (events.some((event) => predicate(event.payload))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function settle(ms = 200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("T3 触发：未点名回合后，候选角色自主发声并携带 presence 标记", async () => {
  const gate = createGateSpy();
  const { repository, service } = createFixture({ presenceAssessor: gate.assessor });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "presence-trigger",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // 未点名 → 规则 DM 只激活塞娜；弥洛经门禁裁决后自主发声。
  const spoken = await waitForEvent(
    repository,
    (payload) =>
      payload.speaker === "弥洛"
      && payload.role === "character"
      && payload.presence !== undefined,
  );
  assert.equal(spoken, true);

  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  const presenceEvents = events.filter(
    (event) => event.payload.presence !== undefined,
  );
  assert.equal(presenceEvents.length, 1);
  const marker = presenceEvents[0].payload.presence!;
  assert.equal(marker.characterInstanceId, MILO_ID);
  assert.ok(
    marker.triggerKind === "environment"
      || marker.triggerKind === "peer"
      || marker.triggerKind === "hook",
  );
  // 在场事件是 utterance.committed 角色事件，不是玩家事件。
  assert.equal(presenceEvents[0].payload.role, "character");
  assert.notEqual(presenceEvents[0].payload.speaker, "洛川");
  // 门禁只被调用一次，且候选不含本回合已激活/发声的塞娜。
  assert.equal(gate.calls.length, 1);
  assert.ok(!gate.calls[0].candidateIds.includes("char_inst_scout"));
  assert.ok(gate.calls[0].candidateIds.includes(MILO_ID));
});

test("T3 预算：连续多回合各至多 1 次在场发声（预算=1/回合）", async () => {
  const gate = createGateSpy();
  // cooldownMs:0 → 弥洛发声后立刻重新可候选，预算仍须按回合限 1。
  const turnControl = createTurnControl({ cooldownMs: 0 });
  const { repository, service } = createFixture({
    presenceAssessor: gate.assessor,
    turnControl,
  });

  const first = await service.loadRecord();
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我沿着防波堤慢慢走。",
    idempotencyKey: "budget-turn-1",
    writeToken: first.writeToken,
  });
  await waitForEvent(
    repository,
    (payload) => payload.presence !== undefined,
  );

  const reloaded = await service.loadRecord();
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我停下来听潮声。",
    idempotencyKey: "budget-turn-2",
    writeToken: reloaded.writeToken,
  });
  await waitForEvent(
    repository,
    (payload) => payload.presence !== undefined,
    3000,
  );
  await settle();

  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  const presenceEvents = events.filter(
    (event) => event.payload.presence !== undefined,
  );
  // 两回合各恰 1 次：不刷屏，也不跨回合合并。
  assert.equal(presenceEvents.length, 2);
  assert.equal(gate.calls.length, 2);
  for (const call of gate.calls) {
    assert.equal(call.budget, 1);
  }
});

test("T3 插话优先：点名回合走插话，不触发在场评估", async () => {
  const gate = createGateSpy();
  const { repository, service } = createFixture({ presenceAssessor: gate.assessor });

  const initial = await service.loadRecord();
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "弥洛，你怎么看这段铭文？",
    idempotencyKey: "interject-priority",
    writeToken: initial.writeToken,
  });

  // 弥洛发声走插话路径：有角色事件，但无 presence 标记。
  const spoken = await waitForEvent(
    repository,
    (payload) => payload.speaker === "弥洛" && payload.role === "character",
  );
  assert.equal(spoken, true);
  await settle();
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
  assert.equal(gate.calls.length, 0);
});

test("T3 分流：restricted 回合与 replay 均不触发在场", async () => {
  const gate = createGateSpy();
  const { repository, service } = createFixture({
    presenceAssessor: gate.assessor,
    visibilityAssessor: {
      async assess({ playerText }) {
        // 仅「压低声音」判为密谈；其余 public（用于 replay 分支）。
        if (playerText.includes("压低声音")) {
          return {
            visibility: {
              kind: "restricted" as const,
              domainId: "domain_secret",
              audienceCharacterInstanceIds: ["char_inst_scout"],
            },
            reason: "密谈。",
          };
        }
        return { visibility: { kind: "public" as const }, reason: "公开。" };
      },
    },
  });

  const initial = await service.loadRecord();
  // 第一步：可见性门禁给出 restricted 提案，要求玩家确认（真实 UI 流程）。
  let proposalId = "";
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我压低声音说话。",
      idempotencyKey: "restricted-turn",
      writeToken: initial.writeToken,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "VISIBILITY_CONFIRMATION_REQUIRED");
      assert.ok(error.visibilityProposal);
      proposalId = error.visibilityProposal.proposalId;
      return true;
    },
  );
  // 第二步：确认 restricted 后回合才真正提交；非 public → 不评估在场。
  const restricted = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我压低声音说话。",
    idempotencyKey: "restricted-turn",
    writeToken: initial.writeToken,
    visibilityConfirmation: { proposalId, decision: "restricted" },
  });
  assert.equal(restricted.disposition, "committed");
  await settle();
  let events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
  assert.equal(gate.calls.length, 0);

  // replay：public 回合首次提交触发一次在场；同 key 重放只回 duplicate，
  // 不重跑在场评估（门禁计数与在场事件数都不变）。
  const reloaded = await service.loadRecord();
  const publicInput = {
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我望向海面。",
    idempotencyKey: "public-for-replay",
    writeToken: reloaded.writeToken,
  };
  const firstPublic = await service.submitMessage(publicInput);
  assert.equal(firstPublic.disposition, "committed");
  await waitForEvent(repository, (payload) => payload.presence !== undefined);
  const presenceAfterFirst = (
    await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId)
  ).filter((event) => event.payload.presence !== undefined).length;
  assert.equal(presenceAfterFirst, 1);
  assert.equal(gate.calls.length, 1);

  const replayed = await service.submitMessage(publicInput);
  assert.equal(replayed.disposition, "duplicate");
  await settle();
  events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    1,
  );
  assert.equal(gate.calls.length, 1);
});

test("T3 fail-closed：门禁抛错不影响玩家回合，且无在场事件", async () => {
  const gate = createGateSpy({ error: new Error("gate exploded") });
  const { repository, service } = createFixture({ presenceAssessor: gate.assessor });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "gate-error",
    writeToken: initial.writeToken,
  });
  // 玩家回合完整提交；门禁失败只留日志。
  assert.equal(committed.disposition, "committed");
  await settle();
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.ok(events.some((event) => event.payload.role === "player"));
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
  assert.equal(gate.calls.length, 1);
});

test("T3 fail-closed：在场回合生成失败不影响玩家回合", async () => {
  const gate = createGateSpy();
  const inner = createLocalM2TurnOrchestrator({ characters: [...demoCharacters()] });
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      if (input.plan.presence) {
        // 模拟 presence react 分支的确定性失败。
        throw new FatalTurnError("PRESENCE_REACT_FAILED", "react blew up");
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const { repository, service } = createFixture({
    orchestrator,
    presenceAssessor: gate.assessor,
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "presence-turn-error",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  await settle();
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.ok(events.some((event) => event.payload.role === "player"));
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
});

/**
 * 模拟场景晶化式异步落库：直接走 repository 回合管线推进记录版本
 * （与生产 scene-crystallization 的 system.correction.committed 同形态）。
 */
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
    idempotencyKey: "crystal-during-presence",
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
          segments: fallbackSemanticSegments("场景定格 — 场景移至北防波堤。", "environment"),
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

test("T3 版本冲突重试：生成期间异步落库推进版本，在场重读快照重试一次落库", async () => {
  const gate = createGateSpy();
  const inner = createLocalM2TurnOrchestrator({ characters: [...demoCharacters()] });
  let presenceDrafts = 0;
  let repositoryRef: Repository | null = null;
  const orchestrator: M2TurnOrchestrator = {
    plan: (input) => inner.plan(input),
    async draft(input) {
      if (input.plan.presence) {
        presenceDrafts += 1;
        if (presenceDrafts === 1 && repositoryRef) {
          // 第一次在场生成期间：模拟场景晶化异步落库（v2 → v3），
          // 使首次在场提交撞 RECORD_VERSION_CONFLICT。
          await commitSystemCorrection(repositoryRef, 2);
        }
      }
      return inner.draft(input);
    },
    validate: (input) => inner.validate(input),
  };
  const fixture = createFixture({
    orchestrator,
    presenceAssessor: gate.assessor,
  });
  repositoryRef = fixture.repository;
  const { repository, service } = fixture;

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我沿着防波堤慢慢走。",
    idempotencyKey: "presence-conflict-retry",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // 冲突重试后在场事件仍然落库（而非 fail-closed 沉默）。
  const spoken = await waitForEvent(
    repository,
    (payload) =>
      payload.speaker === "弥洛"
      && payload.role === "character"
      && payload.presence !== undefined,
  );
  assert.equal(spoken, true);

  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  // 异步晶化事件确实在玩家回合之后、在场事件之前落库。
  assert.ok(
    events.some((event) => event.kind === "system.correction.committed"),
  );
  const presenceEvents = events.filter(
    (event) => event.payload.presence !== undefined,
  );
  assert.equal(presenceEvents.length, 1);
  // 重试证据：在场草稿生成两次（首次撞冲突 + 重读快照重试一次），
  // 但门禁只裁决一次（不重新过闸），预算仍为 1。
  assert.equal(presenceDrafts, 2);
  assert.equal(gate.calls.length, 1);
  // 版本序列：玩家回合 v2 → 晶化 v3 → 在场重试 v4。
  const head = await repository.loadRecordHead(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(head?.version, 4);
});

test("T3 无素材确定性沉默：空旁白空回应不调用门禁", async () => {
  const gate = createGateSpy();
  const silentOrchestrator: M2TurnOrchestrator = {
    async plan(input) {
      return {
        goal: "安静的一轮",
        constraints: [],
        activatedCharacters: [],
        narratorEnabled: false,
        actionBudgetPerCharacter: 0,
        visibility: input.visibility ?? { kind: "public" },
      };
    },
    async draft() {
      return { narration: null, characterResponses: [], actionTransactions: [] };
    },
    async validate() {
      return {
        accepted: true,
        goalSatisfied: true,
        worldCompatible: true,
        actionTransactionsComplete: true,
        narratorChecked: true,
        activatedCharacterCount: 0,
      };
    },
  };
  const { repository, service } = createFixture({
    orchestrator: silentOrchestrator,
    presenceAssessor: gate.assessor,
  });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我静静站着。",
    idempotencyKey: "silent-material",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  await settle();
  // 三类素材全空 → 确定性沉默：门禁未被调用，无在场事件。
  assert.equal(gate.calls.length, 0);
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
});

test("T3 未装配门禁：在场整体禁用，既有行为零变化", async () => {
  const { repository, service } = createFixture();
  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "no-assessor",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  await settle();
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(
    events.filter((event) => event.payload.presence !== undefined).length,
    0,
  );
});

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
