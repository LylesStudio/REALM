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
  FatalTurnError,
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import { createRuleBasedInterjectionPolicy } from "../modules/orchestration/interjection.ts";
import {
  fallbackSemanticSegments,
  type SemanticSegment,
} from "../modules/presentation/semantic-segments.ts";
import {
  createLocalM2TurnOrchestrator,
  createLocalCharacterRunner,
  createRuleBasedDMController,
  type CharacterRunner,
  type DMController,
  type M2TurnCandidate,
  type M2TurnOrchestrator,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

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

function createFixture(options: {
  orchestrator?: M2TurnOrchestrator;
  turnControl?: ReturnType<typeof createTurnControl>;
  visibilityAssessor?: {
    assess(input: {
      playerText: string;
      signal?: AbortSignal;
    }): Promise<{ visibility: TurnVisibilityPlan; reason: string }>;
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
    async hasViewerProjection() {
      return true;
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

test("interrupting a turn commits nothing and the draft can be resubmitted", async () => {
  let blockFirst = true;
  let releaseDraft: () => void = () => {};
  const localRunner = createLocalCharacterRunner();
  const runner: CharacterRunner = {
    async propose(input) {
      if (blockFirst) {
        blockFirst = false;
        await new Promise<void>((resolve) => {
          releaseDraft = resolve;
        });
      }
      return localRunner.propose(input);
    },
    async react(input) {
      return localRunner.react(input);
    },
  };
  const orchestrator = createLocalM2TurnOrchestrator({
    characters: [...demoCharacters()],
    characterRunner: runner,
  });
  const { repository, service } = createFixture({ orchestrator });

  const initial = await service.loadRecord();
  const pending = service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我先观察四周。",
    idempotencyKey: "interrupt-me",
    writeToken: initial.writeToken,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    service.cancelMessage(LOCAL_RECORD_SCOPE.recordId, "interrupt-me"),
    true,
  );
  releaseDraft();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof LocalRecordServiceError
    && error.code === "TURN_FAILED"
    && error.message.includes("已打断")
  );

  // 未提交任何事件；历史不被打断的内容污染。
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(events.length, 0);

  // 恢复后可正常重新提交。
  const reloaded = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我先观察四周。",
    idempotencyKey: "after-interrupt",
    writeToken: reloaded.writeToken,
  });
  assert.equal(committed.disposition, "committed");
});

test("addressed-but-unactivated character interjects once, then cools down", async () => {
  const now = 0;
  const turnControl = createTurnControl({ now: () => now, cooldownMs: 60_000 });
  const { repository, service } = createFixture({ turnControl });

  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "弥洛，你怎么看这段铭文？",
    idempotencyKey: "address-milo",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  // 弥洛本轮未被激活（规则 DM 只激活塞娜），被点名后插话一次。
  const interjected = await waitForEvent(
    repository,
    (payload) => payload.speaker === "弥洛" && payload.role === "character",
  );
  assert.equal(interjected, true);

  // 冷却期内再次点名不再插话。
  // 插话提交后记录版本已推进，先重新加载获取最新写入授权。
  const reloaded = await service.loadRecord();
  const second = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "弥洛，再确认一次？",
    idempotencyKey: "address-milo-again",
    writeToken: reloaded.writeToken,
  });
  assert.equal(second.disposition, "committed");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const miloEvents = (await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId))
    .filter((event) => event.payload.speaker === "弥洛");
  assert.equal(miloEvents.length, 1);
});

test("unaddressed characters stay silent after a public turn", async () => {
  const { repository, service } = createFixture();
  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我环顾四周。",
    idempotencyKey: "quiet-turn",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  const countAfterTurn =
    (await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId)).length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(events.length, countAfterTurn);
});

test("M4 scenario regression: one-to-one, one-to-many, many-to-one, many-to-many", async () => {
  const [sena, milo] = demoCharacters();

  // 一对一：单角色回合产出恰好一条回应。
  const oneToOne = createLocalM2TurnOrchestrator({ characters: [sena] });
  const plan1 = await oneToOne.plan({
    turnId: "t-1v1",
    playerText: "我点头。",
  });
  const draft1 = await oneToOne.draft({
    turnId: "t-1v1",
    playerText: "我点头。",
    plan: plan1,
  });
  assert.equal(draft1.characterResponses.length, 1);
  await oneToOne.validate({ plan: plan1, candidate: draft1 });

  // 一对多：DM 激活两名角色，回合产出两条回应且通过校验。
  const baseDM = createRuleBasedDMController();
  const twoCharacterDM: DMController = {
    async plan(input) {
      return {
        goal: "两名角色都被点名",
        constraints: [],
        activatedCharacters: input.availableCharacters.slice(0, 2),
        narratorEnabled: true,
        actionBudgetPerCharacter: 1,
        visibility: { kind: "public" },
      };
    },
    approveActions: (input) => baseDM.approveActions(input),
    validate: (input) => baseDM.validate(input),
  };
  const oneToMany = createLocalM2TurnOrchestrator({
    characters: [sena, milo],
    dmController: twoCharacterDM,
  });
  const plan2 = await oneToMany.plan({
    turnId: "t-1vN",
    playerText: "塞娜、弥洛，一起看这段铭文。",
  });
  const draft2 = await oneToMany.draft({
    turnId: "t-1vN",
    playerText: "塞娜、弥洛，一起看这段铭文。",
    plan: plan2,
  });
  assert.equal(draft2.characterResponses.length, 2);
  await oneToMany.validate({ plan: plan2, candidate: draft2 });

  // 多对一：同一角色被反复点名，冷却保证最多插话一次。
  const control = createTurnControl({ cooldownMs: 60_000 });
  const policy = createRuleBasedInterjectionPolicy({ turnControl: control });
  const first = policy.evaluate({
    recordId: "r",
    playerText: "弥洛，看一下。",
    activatedCharacters: [sena],
    availableCharacters: [sena, milo],
  });
  assert.equal(first.kind, "interject");
  if (first.kind === "interject") {
    control.recordInterjection(first.character.characterInstanceId);
  }
  const second = policy.evaluate({
    recordId: "r",
    playerText: "弥洛，再看一下。",
    activatedCharacters: [sena],
    availableCharacters: [sena, milo],
  });
  assert.equal(second.kind, "silent");

  // 多对多：不同 Record 的发言权互不影响；同一 Record 内按 FIFO 串行。
  const controlMany = createTurnControl({ cooldownMs: 60_000 });
  const leaseA = await controlMany.acquire("record-a", "player");
  const leaseB = await controlMany.acquire("record-b", "player");
  assert.equal(controlMany.currentHolder("record-a"), "player");
  assert.equal(controlMany.currentHolder("record-b"), "player");
  const order: string[] = [];
  const queuedA1 = controlMany.acquire("record-a", "塞娜")
    .then((lease) => {
      order.push("a:塞娜");
      lease.release();
    });
  const queuedA2 = controlMany.acquire("record-a", "弥洛")
    .then((lease) => {
      order.push("a:弥洛");
      lease.release();
    });
  leaseA.release();
  await Promise.all([queuedA1, queuedA2]);
  assert.deepEqual(order, ["a:塞娜", "a:弥洛"]);
  leaseB.release();
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

test("cancelling during visibility assessment aborts the whole main chain", async () => {
  let releaseAssess: () => void = () => {};
  const assessor = {
    assess: async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        releaseAssess = resolve;
      });
      if (input.signal?.aborted) {
        throw new FatalTurnError(
          "TURN_CANCELLED",
          "已打断本次生成，内容没有写入记录。",
        );
      }
      return { visibility: { kind: "public" as const }, reason: "" };
    },
  };
  const { repository, service } = createFixture({ visibilityAssessor: assessor });

  const initial = await service.loadRecord();
  const pending = service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我先观察四周。",
    idempotencyKey: "cancel-at-visibility",
    writeToken: initial.writeToken,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    service.cancelMessage(LOCAL_RECORD_SCOPE.recordId, "cancel-at-visibility"),
    true,
    "controller registration must cover the visibility phase",
  );
  releaseAssess();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof LocalRecordServiceError
    && error.code === "TURN_FAILED"
    && error.message.includes("已打断")
  );
  assert.deepEqual(await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId), []);
  assert.deepEqual(await repository.listOutboxMessages(), []);
});

test("cancelling during DM planning cancels before drafting", async () => {
  let releasePlan: () => void = () => {};
  const localOrchestrator = createLocalM2TurnOrchestrator({
    characters: [...demoCharacters()],
  });
  const orchestrator: M2TurnOrchestrator = {
    plan: async (input) => {
      await new Promise<void>((resolve) => {
        releasePlan = resolve;
      });
      return localOrchestrator.plan(input);
    },
    draft: (input) => localOrchestrator.draft(input),
    validate: (input) => localOrchestrator.validate(input),
  };
  const { repository, service } = createFixture({ orchestrator });

  const initial = await service.loadRecord();
  const pending = service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我先观察四周。",
    idempotencyKey: "cancel-at-planning",
    writeToken: initial.writeToken,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    service.cancelMessage(LOCAL_RECORD_SCOPE.recordId, "cancel-at-planning"),
    true,
  );
  releasePlan();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof LocalRecordServiceError
    && error.code === "TURN_FAILED"
    && error.message.includes("已打断")
  );
  assert.deepEqual(await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId), []);
  assert.deepEqual(await repository.listOutboxMessages(), []);
});
