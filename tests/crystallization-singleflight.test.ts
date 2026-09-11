import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository, type RuntimeRepository } from "../modules/runtime/public.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import {
  POSTGRES_DEMO_IDS,
  type RecordRuntimeScope,
} from "../database/postgres/public.ts";
import type {
  SceneExtraction,
  SceneExtractionInput,
  SceneVerdict,
} from "../modules/application/scene-crystallization.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

/**
 * Batch 3D：per-record scene crystallization single-flight + re-arm。
 * 同一 (workspaceId, recordId) 的在途晶化未结束时，后续 public schedule
 * 只挂一个 pending（最新输入覆盖），当前 run 结束后恰好 re-arm 一次；
 * re-arm 重新走 bounded loadRecentAuthorizedEvents。restricted/private
 * 在读取 recent events / 进入 flight 之前结构性跳过。
 * 全部用 barrier/latch 证明「无重叠 + 恰好一次 re-arm」，无 wall-clock 断言。
 */

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

type RecentEvent = {
  speaker: string;
  content: string;
  displayTime: string;
  speakerParticipantId?: string | null;
  recipientId?: string | null;
  policyKind?: string;
};

function publicEvent(content: string): RecentEvent {
  return {
    speaker: "旁白",
    content,
    displayTime: "测试纪元 · 夜",
    policyKind: "public",
  };
}

function stubProjection(recordId: string): RecordProjection {
  return {
    id: recordId,
    version: 1,
    world: {
      id: "world_sf",
      name: "单飞世界",
      era: "测试纪元",
      summary: "单飞测试。",
      timeCursor: "测试纪元 · 夜",
      style: "classical",
      language: "zh-CN",
    },
    story: { id: "story_sf", title: "单飞故事", status: "active", premise: "前提。" },
    record: {
      id: recordId,
      title: "单飞场景",
      status: "active",
      version: 1,
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
    },
    scene: {
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
      weather: "无风",
      tension: "平静",
      objective: "验证单飞",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  };
}

function stubScope(recordId: string, workspaceId: string): RecordRuntimeScope {
  return {
    workspaceId,
    principalId: LOCAL_RECORD_SCOPE.principalId,
    worldId: "world_sf",
    worldlineId: "worldline_sf",
    storyId: "story_sf",
    recordId,
    sceneId: "scene_sf",
    publicPolicyId: "policy_public",
    calendarId: "calendar_test",
    displayTime: "测试纪元 · 夜",
    style: "classical",
    worldStatus: "active",
    brief: {
      worldName: "单飞世界",
      era: "测试纪元",
      summary: "单飞测试。",
      storyTitle: "单飞故事",
      premise: "前提。",
      location: "测试地点",
      weather: "无风",
      tension: "平静",
      objective: "验证单飞",
      canon: "",
      worldLore: "",
    },
    playerActor: {
      characterInstanceId: "char_inst_player",
      participantId: "participant_player",
      displayName: "测试者",
      profileSummary: "单飞测试角色。",
    },
    // 与 demo scope 一致的在场角色：默认本地编排器/DM 校验依赖它们。
    aiCharacters: [
      {
        characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
        participantId: POSTGRES_DEMO_IDS.scoutParticipant,
        displayName: "塞娜",
        profileSummary: "谨慎的斥候。",
      },
      {
        characterInstanceId: POSTGRES_DEMO_IDS.scholarInstance,
        participantId: POSTGRES_DEMO_IDS.scholarParticipant,
        displayName: "弥洛",
        profileSummary: "研究旧世界文字的学者。",
      },
    ],
    observerCharacterInstanceIds: [],
    recentPublicEvents: [],
    recentPublicDialogue: [],
    recordKnowledge: [],
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor 超时：条件未达成");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 可释放的门闩：进入即登记，release 后放行。 */
function createLatch() {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release: () => release() };
}

type Track = {
  loadRecentCalls: string[];
  extractCalls: number;
  extractInputs: SceneExtractionInput[];
  adjudicateCalls: number;
  applyDeltaCalls: { recordId: string }[];
  rejections: number;
  growthClaims: number;
  growthNotes: number;
  inflowEntities: number;
  inflowClaims: number;
  active: number;
  maxActive: number;
};

function createFixture(options: {
  recordIds?: string[];
  workspaceIds?: Map<string, string>;
  recentEvents?: Map<string, RecentEvent[]>;
  onExtract?: (call: number, input: SceneExtractionInput) => Promise<void> | void;
  onGrowth?: (call: number) => Promise<void> | void;
  onAdjudicate?: (call: number) => Promise<void> | void;
  adjudicate?: () => SceneVerdict;
  visibilityAssessor?: {
    assess(input: {
      playerText: string;
      signal?: AbortSignal;
    }): Promise<{ visibility: TurnVisibilityPlan; reason: string }>;
  };
} = {}) {
  const recordIds = options.recordIds ?? [LOCAL_RECORD_SCOPE.recordId];
  const track: Track = {
    loadRecentCalls: [],
    extractCalls: 0,
    extractInputs: [],
    adjudicateCalls: 0,
    applyDeltaCalls: [],
    rejections: 0,
    growthClaims: 0,
    growthNotes: 0,
    inflowEntities: 0,
    inflowClaims: 0,
    active: 0,
    maxActive: 0,
  };
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: recordIds.map((recordId, index) => ({
      recordId,
      version: 1,
      nextOrdinal: 2 + index,
    })),
  });
  const projection = {
    async loadRecentAuthorizedEvents(scope: { recordId: string }) {
      track.loadRecentCalls.push(scope.recordId);
      return options.recentEvents?.get(scope.recordId) ?? [publicEvent("开场。")];
    },
    async loadForPlayer(input: { recordId: string }) {
      return stubProjection(input.recordId);
    },
    async loadDeliveryForPlayer(input: { recordId: string }) {
      return {
        record: stubProjection(input.recordId),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: "char_inst_player",
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const crystallizer = {
    async extract(input: SceneExtractionInput): Promise<SceneExtraction> {
      track.extractCalls += 1;
      track.active += 1;
      track.maxActive = Math.max(track.maxActive, track.active);
      track.extractInputs.push(input);
      try {
        if (options.onExtract) await options.onExtract(track.extractCalls, input);
        return {
          delta: { weather: "雪" },
          worldClaims: [{
            entity: "北岸灯塔",
            entityKind: "geography",
            predicate: "状态",
            value: "灯亮",
          }],
          characterNotes: [{
            characterInstanceId: "char_inst_player",
            note: "保持警惕",
          }],
        };
      } finally {
        track.active -= 1;
      }
    },
    async adjudicate(): Promise<SceneVerdict> {
      track.adjudicateCalls += 1;
      if (options.onAdjudicate) await options.onAdjudicate(track.adjudicateCalls);
      return options.adjudicate?.()
        ?? { approved: true, reason: "相容", adjusted: null, model: "fake-model" };
    },
  };
  const store = {
    async applyDelta(scope: { recordId: string }) {
      track.applyDeltaCalls.push({ recordId: scope.recordId });
      return { eventId: `evt_${track.applyDeltaCalls.length}`, tick: 1, ordinal: 1 };
    },
    async recordRejection() {
      track.rejections += 1;
    },
  };
  // growth / graph inflow 写者（P0 stale suppression 的零写入断言对象）。
  const worldKnowledge = {
    async upsertEntity() {
      track.inflowEntities += 1;
    },
    async appendClaim() {},
    async appendClaims() {
      track.inflowClaims += 1;
    },
    async appendClaimsIdempotent() {},
    async appendDialogueGrowth() {
      if (options.onGrowth) await options.onGrowth(track.growthClaims);
      track.growthClaims += 1;
      return true;
    },
  };
  const characterGrowth = {
    async appendProfileNotes() {
      track.growthNotes += 1;
      return true;
    },
  };
  const multiRecord = recordIds.length > 1
    || (options.workspaceIds !== undefined && options.workspaceIds.size > 0);
  let tokenSequence = 0;
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `opaque-${++tokenSequence}`,
      clock: () => new Date("2026-09-04T01:00:00.000Z"),
    }),
    clock: () => new Date("2026-09-04T01:00:00.000Z"),
    sceneCrystallizer: crystallizer,
    sceneCrystallizationStore: store,
    worldKnowledge,
    characterGrowth,
    ...(multiRecord
      ? {
        runtimeScopeProvider: {
          async resolve({ recordId }: { recordId: string }) {
            return stubScope(
              recordId,
              options.workspaceIds?.get(recordId)
                ?? LOCAL_RECORD_SCOPE.workspaceId,
            );
          },
        },
      }
      : {}),
    ...(options.visibilityAssessor
      ? { visibilityAssessor: options.visibilityAssessor }
      : {}),
  });
  return { service, track, repository };
}

async function submit(
  service: ReturnType<typeof createFixture>["service"],
  recordId: string,
  content: string,
  idempotencyKey: string,
  visibilityConfirmation?: { proposalId: string; decision: "restricted" | "public" },
): Promise<void> {
  const envelope = await service.loadRecord(recordId);
  await service.submitMessage({
    recordId,
    content,
    idempotencyKey,
    writeToken: envelope.writeToken,
    ...(visibilityConfirmation ? { visibilityConfirmation } : {}),
  });
}

test("同一 Record 连发两个 public schedule：无重叠，当前 run 不被改写，恰好一次 re-arm 且重读 recent events", async () => {
  const gate = createLatch();
  const recent = new Map<string, RecentEvent[]>([
    [LOCAL_RECORD_SCOPE.recordId, [publicEvent("开场。")]],
  ]);
  const { service, track } = createFixture({
    recentEvents: recent,
    onExtract: async (call) => {
      if (call === 1) await gate.entered; // 第一次提取阻塞，制造在途窗口
    },
  });

  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-k1");
  await waitFor(() => track.extractCalls === 1); // A 在途且阻塞
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-k2");
  recent.get(LOCAL_RECORD_SCOPE.recordId)!.push(publicEvent("第二句 已提交"));

  // B 只挂 pending：extract 没有并发进入第二次。
  assert.equal(track.extractCalls, 1);
  assert.equal(track.maxActive, 1);
  // 当前 run 的 input 不被第二个 schedule 改写。
  assert.equal(track.extractInputs[0]!.playerText, "第一句");

  gate.release();
  // P0：A 可完成 extract，但已 stale——growth/adjudicate/applyDelta/
  // rejection/graph inflow 全部零写入；恰好一次 re-arm 只写最新 B。
  await waitFor(() => track.applyDeltaCalls.length === 1);
  assert.equal(track.extractCalls, 2, "A 完成 extract + B re-arm extract");
  assert.equal(track.adjudicateCalls, 1, "stale A 不得进入 adjudicate");
  assert.equal(track.growthClaims, 1, "stale A 不得写 world growth");
  assert.equal(track.growthNotes, 1, "stale A 不得写 profile notes");
  assert.equal(track.rejections, 0);
  assert.equal(track.inflowEntities, 1, "stale A 不得扩大 graph inflow 写面");
  assert.equal(track.maxActive, 1);
  assert.deepEqual(
    track.applyDeltaCalls.map((call) => call.recordId),
    [LOCAL_RECORD_SCOPE.recordId],
  );
  // re-arm 重新读取 bounded recent events（不复用旧 run 的上下文）。
  assert.equal(track.loadRecentCalls.length, 2);
  assert.equal(track.extractInputs[1]!.playerText, "第二句");
  assert.ok(
    track.extractInputs[1]!.recentDialogue?.some(
      (line) => line.text === "第二句 已提交",
    ),
    "re-arm 必须看到最新上下文",
  );
});

test("stale 发生在 growth 之后/adjudicate 之前：adjudicate 与 applyDelta 零调用（growth 不回滚）", async () => {
  const gate = createLatch();
  const { service, track } = createFixture({
    onGrowth: async (call) => {
      if (call === 0) await gate.entered; // A 的 growth 写入阻塞
    },
  });
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-g1");
  await waitFor(() => track.extractCalls === 1);
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-g2");
  gate.release();
  await waitFor(() => track.applyDeltaCalls.length === 1);
  // A 的 growth 在 stale 之前已完成（不回滚、不重复）；adjudicate 起全部跳过。
  assert.equal(track.growthClaims, 2, "A/B 的 growth 各写一次（A 在 stale 前）");
  assert.equal(track.adjudicateCalls, 1, "stale A 不得进入 adjudicate");
  assert.equal(track.applyDeltaCalls.length, 1, "只有最新 B 写 correction");
});

test("stale 发生在 applyDelta 前（approved）与 recordRejection 前（rejected）", async () => {
  // approved 分支：A 在 adjudicate 内阻塞，B 使其 stale → applyDelta 零调用。
  const approvedGate = createLatch();
  const approved = createFixture({
    onAdjudicate: async (call) => {
      if (call === 1) await approvedGate.entered;
    },
  });
  await submit(approved.service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-a1");
  await waitFor(() => approved.track.adjudicateCalls === 1);
  await submit(approved.service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-a2");
  approvedGate.release();
  await waitFor(() => approved.track.applyDeltaCalls.length === 1);
  assert.equal(approved.track.adjudicateCalls, 2);
  assert.equal(approved.track.applyDeltaCalls.length, 1, "stale A 不得 applyDelta");
  assert.equal(approved.track.inflowEntities, 1, "stale A 不得 graph inflow");

  // rejected 分支：A 的 recordRejection 被 stale 抑制，只有 B 记账一次。
  const rejectedGate = createLatch();
  const rejected = createFixture({
    adjudicate: () => ({
      approved: false,
      reason: "时间倒退",
      adjusted: null,
      model: "fake-model",
    }),
    onAdjudicate: async (call) => {
      if (call === 1) await rejectedGate.entered;
    },
  });
  await submit(rejected.service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-r1");
  await waitFor(() => rejected.track.adjudicateCalls === 1);
  await submit(rejected.service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-r2");
  rejectedGate.release();
  await waitFor(() => rejected.track.rejections === 1);
  assert.equal(rejected.track.adjudicateCalls, 2);
  assert.equal(rejected.track.rejections, 1, "stale A 不得 recordRejection");
  assert.equal(rejected.track.applyDeltaCalls.length, 0);
});

test("A 在途、B/C 排队：pending 只保留最新，A stale 后只跑 C 一次", async () => {
  const gate = createLatch();
  const { service, track } = createFixture({
    onExtract: async (call) => {
      if (call === 1) await gate.entered;
    },
  });
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-p1");
  await waitFor(() => track.extractCalls === 1);
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-p2");
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第三句", "sf-p3");
  gate.release();
  await waitFor(() => track.applyDeltaCalls.length === 1);
  // B 被 C 覆盖从未运行；A stale 零写入；C 唯一写入。
  assert.equal(track.extractCalls, 2);
  assert.equal(track.extractInputs[1]!.playerText, "第三句");
  assert.equal(track.adjudicateCalls, 1);
  assert.equal(track.growthClaims, 1);
  assert.equal(track.applyDeltaCalls.length, 1);
  assert.equal(track.maxActive, 1);
});

test("首个 run 提取抛错：pending 仍恰好 re-arm 一次，map 不卡死，失败只 warn 不到玩家路径", async () => {
  const gate = createLatch();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const { service, track } = createFixture({
      onExtract: async (call) => {
        if (call === 1) {
          await gate.entered;
          throw new Error("extract boom");
        }
      },
    });
    // 玩家提交路径本身不抛错。
    await submit(service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-f1");
    await waitFor(() => track.extractCalls === 1);
    await submit(service, LOCAL_RECORD_SCOPE.recordId, "第二句", "sf-f2");
    assert.equal(track.extractCalls, 1);
    gate.release();
    // A 失败 → finally 清理 + pending re-arm → B 完整跑通。
    await waitFor(() => track.applyDeltaCalls.length === 1);
    assert.equal(track.extractCalls, 2);
    assert.equal(track.maxActive, 1);
    assert.equal(track.loadRecentCalls.length, 2);
    // map 不卡死：第三次 schedule 可立即新 run（不等 pending）。
    await submit(service, LOCAL_RECORD_SCOPE.recordId, "第三句", "sf-f3");
    await waitFor(() => track.applyDeltaCalls.length === 2);
    assert.equal(track.extractCalls, 3);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((line) =>
      line.includes("scene crystallization skipped") && line.includes("extract boom")
    ),
  );
});

test("不同 workspace/Record 各自 single-flight：互不阻塞、互不覆盖", async () => {
  const recA = "record_sf_a";
  const recB = "record_sf_b";
  const gateA = createLatch();
  const gateB = createLatch();
  const { service, track } = createFixture({
    recordIds: [recA, recB],
    workspaceIds: new Map([[recB, "workspace_other"]]),
    onExtract: async (_call, input) => {
      // 按 playerText 区分两个 Record 的首次提取，各自阻塞。
      if (input.playerText === "A-1") await gateA.entered;
      if (input.playerText === "B-1") await gateB.entered;
    },
  });

  await submit(service, recA, "A-1", "sf-a1");
  await submit(service, recB, "B-1", "sf-b1");
  // 两个不同 key 的在途 run 并发存在（无全局队列）。
  await waitFor(() => track.extractCalls === 2);
  assert.equal(track.maxActive, 2);
  // recA 的第二回合只挂自己的 pending，不影响 recB。
  await submit(service, recA, "A-2", "sf-a2");
  assert.equal(track.extractCalls, 2);

  gateB.release();
  await waitFor(() =>
    track.applyDeltaCalls.some((call) => call.recordId === recB)
  );
  // recB 完成时 recA 仍阻塞，且没有误 re-arm。
  assert.equal(track.extractCalls, 2);

  gateA.release();
  await waitFor(() =>
    track.applyDeltaCalls.filter((call) => call.recordId === recA).length === 1
  );
  assert.equal(track.extractCalls, 3);
  // recA 的 re-arm 用的是最新 pending 输入；recA 首个 run stale 零写入
  //（recB 的写入不受 recA generation 影响，各 Record 互不取消）。
  assert.equal(
    track.applyDeltaCalls.filter((call) => call.recordId === recA).length,
    1,
    "recA stale run 不写入，只有 re-arm 写一次",
  );
  assert.equal(
    track.applyDeltaCalls.filter((call) => call.recordId === recB).length,
    1,
    "recB 不受 recA 的 generation 失效影响",
  );
  assert.equal(track.extractInputs[2]!.playerText, "A-2");
  assert.ok(track.loadRecentCalls.includes(recA));
  assert.ok(track.loadRecentCalls.includes(recB));
});

test("restricted/private schedule：不读 projection、不调 crystallizer、不留 pending", async () => {
  const assessor = {
    async assess({ playerText }: { playerText: string }) {
      if (playerText.includes("密谈")) {
        return {
          visibility: {
            kind: "restricted" as const,
            domainId: "domain_secret",
            audienceCharacterInstanceIds: [POSTGRES_DEMO_IDS.scoutInstance],
          },
          reason: "密谈。",
        };
      }
      return { visibility: { kind: "public" as const }, reason: "公开。" };
    },
  };
  const { service, track } = createFixture({ visibilityAssessor: assessor });

  // 真实确认流程：restricted 提案先要求玩家确认，确认后回合才提交。
  const initial = await service.loadRecord();
  let proposalId = "";
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "压低声音密谈",
      idempotencyKey: "sf-r1",
      writeToken: initial.writeToken,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VISIBILITY_CONFIRMATION_REQUIRED");
      proposalId = (error as { visibilityProposal?: { proposalId: string } })
        .visibilityProposal!.proposalId;
      return true;
    },
  );
  await submit(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    "压低声音密谈",
    "sf-r1",
    { proposalId, decision: "restricted" },
  );
  // 给 fire-and-forget 一个事件循环机会：restricted 必须结构性零接触。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(track.loadRecentCalls.length, 0);
  assert.equal(track.extractCalls, 0);
  assert.equal(track.applyDeltaCalls.length, 0);

  // 随后的 public 回合立即进入新 run——证明 restricted 没有留下 pending
  // 占用 single-flight（否则会先跑一次 restricted 的 re-arm）。
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "公开说一句", "sf-r2");
  await waitFor(() => track.applyDeltaCalls.length === 1);
  assert.equal(track.extractCalls, 1);
  assert.equal(track.extractInputs[0]!.playerText, "公开说一句");
});

test("裁决拒绝仍走 recordRejection 且不 re-arm（既有语义不变）", async () => {
  const { service, track } = createFixture({
    adjudicate: () => ({
      approved: false,
      reason: "时间倒退",
      adjusted: null,
      model: "fake-model",
    }),
  });
  await submit(service, LOCAL_RECORD_SCOPE.recordId, "第一句", "sf-j1");
  await waitFor(() => track.rejections === 1);
  assert.equal(track.applyDeltaCalls.length, 0);
  assert.equal(track.extractCalls, 1);
});
