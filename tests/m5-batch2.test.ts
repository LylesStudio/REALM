import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorldlineMergeService,
  planWorldlineMerge,
  type MergeEventRef,
  type WorldlineMergeRepository,
  type WorldlineMergeRow,
} from "../modules/worldline/merge.ts";
import {
  SEMANTIC_CONFLICT_PROMPT_VERSION,
  createModelSemanticConflictAssessor,
  needsSemanticReview,
  type SemanticConflictEvidence,
} from "../modules/worldline/semantic-conflict.ts";
import type { ModelGateway } from "../modules/inference/types.ts";
import {
  createPropagationWorker,
  type PropagationJob,
  type PropagationJobInput,
  type PropagationJobQueue,
  type PropagationJobStatus,
} from "../modules/propagation/worker.ts";
import type {
  InformationPacket,
} from "../modules/propagation/public.ts";

function event(overrides: Partial<MergeEventRef> = {}): MergeEventRef {
  return {
    eventId: "e1",
    recordId: "r1",
    worldlineId: "line-a",
    tick: 1,
    ordinal: 1,
    speaker: "旁白",
    payloadKey: "payload-1",
    ...overrides,
  };
}

test("merge planner dedupes identical, reschedules bridgeable, blocks hard", () => {
  const a = [
    event({ eventId: "a1", ordinal: 1, payloadKey: "p1" }),
    event({ eventId: "a2", ordinal: 2, speaker: "塞娜", payloadKey: "p2" }),
  ];
  const b = [
    // 与 a1 同游标同载荷 → none 去重
    event({ eventId: "b1", ordinal: 1, worldlineId: "line-b", payloadKey: "p1" }),
    // 与 a2 同游标不同发言者 → bridgeable 顺移
    event({ eventId: "b2", ordinal: 2, worldlineId: "line-b", speaker: "弥洛", payloadKey: "p3" }),
  ];
  const report = planWorldlineMerge({
    sourceA: "line-a",
    sourceB: "line-b",
    eventsA: a,
    eventsB: b,
  });
  assert.equal(report.mergeable, true);
  assert.deepEqual(
    report.conflicts.map((conflict) => conflict.severity),
    ["none", "bridgeable"],
  );
  // manifest ordinal 从 1 连续且唯一。
  assert.deepEqual(
    report.manifest.map((entry) => entry.ordinal),
    [1, 2, 3],
  );
  assert.equal(
    report.manifest.find((entry) => entry.eventId === "b2")?.resolution,
    "rescheduled",
  );
  assert.equal(
    report.manifest.some((entry) => entry.eventId === "b1"),
    false,
  );

  const hard = planWorldlineMerge({
    sourceA: "line-a",
    sourceB: "line-b",
    eventsA: [event({ eventId: "a1", speaker: "塞娜", payloadKey: "p1" })],
    eventsB: [event({
      eventId: "b1",
      worldlineId: "line-b",
      speaker: "塞娜",
      payloadKey: "different",
    })],
  });
  assert.equal(hard.mergeable, false);
  assert.equal(hard.conflicts[0]?.severity, "hard");
});

function stubMergeRepository(events: Map<string, MergeEventRef[]>) {
  const rows: WorldlineMergeRow[] = [];
  const repository: WorldlineMergeRepository = {
    async findMergeByIdempotencyKey(_workspaceId, key) {
      return rows.find((row) => row.idempotencyKey === key) ?? null;
    },
    async insertMerge(_scope, row) {
      rows.push({ ...row, createdAt: new Date().toISOString() });
    },
    async listWorldlineEvents(scope) {
      return events.get(scope.worldlineId) ?? [];
    },
    async listWorldlineRecordTitles() {
      return [{ id: "r1", title: "第一段" }];
    },
    async createMergedTopology() {},
    async worldlineExists() {
      return true;
    },
  };
  return { repository, rows };
}

test("merge service replays idempotently and keeps audit on rejection", async () => {
  const { repository, rows } = stubMergeRepository(new Map([
    ["line-a", [event({ eventId: "a1" })]],
    ["line-b", [event({ eventId: "b1", worldlineId: "line-b", ordinal: 2 })]],
  ]));
  let sequence = 0;
  const service = createWorldlineMergeService({
    repository,
    idFactory: () => `id-${++sequence}`,
  });
  const input = {
    workspaceId: "ws",
    worldId: "world",
    sourceA: "line-a",
    sourceB: "line-b",
    idempotencyKey: "merge-key-1",
    operator: "user",
  };
  const first = await service.merge(input);
  assert.equal(first.status, "merged");
  const second = await service.merge(input);
  assert.equal(second.status, "merged");
  assert.equal(
    second.status === "merged" && first.status === "merged"
      ? second.mergeId === first.mergeId
      : false,
    true,
  );
  // 只产生一行审计。
  assert.equal(rows.length, 1);

  // dry-run 不落库。
  const preview = await service.merge({ ...input, idempotencyKey: "dry", dryRun: true });
  assert.equal(preview.status, "preview");
  assert.equal(rows.length, 1);

  // hard 冲突拒绝合并但保留审计。
  const { repository: hardRepo, rows: hardRows } = stubMergeRepository(new Map([
    ["line-a", [event({ eventId: "a1", speaker: "塞娜", payloadKey: "x" })]],
    ["line-b", [event({ eventId: "b1", worldlineId: "line-b", speaker: "塞娜", payloadKey: "y" })]],
  ]));
  const hardService = createWorldlineMergeService({ repository: hardRepo });
  const rejected = await hardService.merge({ ...input, idempotencyKey: "hard-1" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.report.conflicts[0]?.severity, "hard");
  assert.equal(hardRows.length, 1);
  assert.equal(hardRows[0]?.status, "rejected");
});

function fakeGateway(content: string | Error): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat() {
      if (content instanceof Error) throw content;
      return {
        model: "fake-model",
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

test("semantic assessor unifies severity and records model evidence", async () => {
  const evidence: SemanticConflictEvidence[] = [];
  const assessor = createModelSemanticConflictAssessor({
    getGateway: async () => fakeGateway(JSON.stringify({
      kind: "worldview",
      severity: "high-risk",
      recommendation: "branch",
      rationale: "过去变更与世界观不符。",
    })),
    evidenceStore: { append: async (entry) => void evidence.push(entry) },
  });
  const result = await assessor.evaluate({
    changeSet: { changes: [] },
    existingClaims: [],
    deterministicSeverity: "high-risk",
    deterministicReason: "无锚点",
  });
  assert.equal(result.source, "model");
  assert.equal(result.result.severity, "high-risk");
  assert.equal(result.result.recommendation, "branch");
  assert.equal(result.promptVersion, SEMANTIC_CONFLICT_PROMPT_VERSION);
  assert.equal(evidence.length, 1);

  // 无效输出 → 降级。
  const fallbackAssessor = createModelSemanticConflictAssessor({
    getGateway: async () => fakeGateway("不是 json"),
    evidenceStore: { append: async (entry) => void evidence.push(entry) },
  });
  const degraded = await fallbackAssessor.evaluate({
    changeSet: { changes: [] },
    existingClaims: [],
    deterministicSeverity: "high-risk",
    deterministicReason: "无锚点",
  });
  assert.equal(degraded.source, "fallback");
  assert.equal(degraded.result.severity, "high-risk");

  // 网关异常 → 降级且不抛出。
  const brokenAssessor = createModelSemanticConflictAssessor({
    getGateway: async () => fakeGateway(new Error("network down")),
  });
  const degraded2 = await brokenAssessor.evaluate({
    changeSet: { changes: [] },
    existingClaims: [],
    deterministicSeverity: "bridgeable",
    deterministicReason: "依赖冲突",
  });
  assert.equal(degraded2.source, "fallback");
  assert.equal(degraded2.result.severity, "bridgeable");

  // 只有 high-risk 需要语义复审。
  assert.equal(needsSemanticReview("high-risk"), true);
  assert.equal(needsSemanticReview("hard"), false);
  assert.equal(needsSemanticReview("none"), false);
});

function createMemoryQueue() {
  const jobs: PropagationJob[] = [];
  const savedRuns: { jobId: string; run: unknown }[] = [];
  const queue: PropagationJobQueue = {
    async enqueue(_scope, job) {
      jobs.push({
        id: job.id,
        campaignId: job.campaignId,
        input: job.input,
        status: "pending",
        attempts: 0,
        lastError: null,
      });
    },
    async claimNext() {
      const next = jobs.find((job) => job.status === "pending");
      if (!next) return null;
      next.status = "running";
      next.attempts += 1;
      return { scope: SCOPE, job: next, lease: { jobId: next.id, attempts: next.attempts } };
    },
    async completeRun(_scope, lease, run) {
      savedRuns.push({ jobId: lease.jobId, run });
      const job = jobs.find((entry) => entry.id === lease.jobId);
      if (job) job.status = "done";
    },
    async markFailed(_scope, lease, error) {
      const job = jobs.find((entry) => entry.id === lease.jobId);
      if (job) {
        job.status = "failed";
        job.lastError = error;
      }
      return { staleIgnored: false };
    },
    async recoverStale() {
      let count = 0;
      for (const job of jobs) {
        if (job.status === "running") {
          job.status = "pending";
          count += 1;
        }
      }
      return count;
    },
    async retry(_scope, jobId) {
      const job = jobs.find((entry) => entry.id === jobId);
      if (job?.status === "failed") job.status = "pending";
    },
    async stats() {
      const counts: Record<PropagationJobStatus, number> = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
      };
      for (const job of jobs) counts[job.status] += 1;
      return counts;
    },
  };
  return { queue, jobs, savedRuns };
}

const SCOPE = { workspaceId: "ws", worldId: "world", worldlineId: "line" };

function rootPacket(): InformationPacket {
  return {
    id: "packet_root",
    campaignId: "camp_1",
    parentPacketId: null,
    channel: "official_bulletin",
    claimIds: ["c1", "c2", "c3"],
    framing: "official",
    omittedClaimIds: [],
    semanticFidelityToParent: 1,
    contentHash: "root",
  };
}

function jobInput(): PropagationJobInput {
  return {
    campaign: {
      id: "camp_1",
      securityClass: "public",
      effectiveTick: 10,
      salience: 0.8,
      complexity: 0.3,
    },
    roots: [{ nodeKey: "herald", packet: rootPacket() }],
    // 批次 T11-B：拓扑为入队时物化的 immutable 快照（含不可达节点）。
    nodes: [
      { key: "herald", clearance: "public" },
      { key: "market", clearance: "public" },
      { key: "tavern", clearance: "public" },
      { key: "isolated", clearance: "public" },
    ],
    routes: [
      { from: "herald", to: "market", channel: "official_bulletin", distance: 1 },
      { from: "market", to: "tavern", channel: "market_rumor", distance: 1 },
    ],
    topologyVersion: "pt_test",
  };
}

test("worker materializes only reachable nodes and replays deterministically", async () => {
  const { queue, savedRuns } = createMemoryQueue();
  const worker = createPropagationWorker({ queue });

  await queue.enqueue(SCOPE, { id: "job-1", campaignId: "camp_1", input: jobInput() });
  assert.equal(await worker.runOnce(SCOPE.workspaceId), "done");
  assert.equal(await worker.runOnce(SCOPE.workspaceId), "idle");

  // 懒物化语义：不可达的 isolated 不产生任何 Exposure。
  const firstRun = savedRuns[0]?.run as { exposures: { nodeKey: string }[] };
  assert.deepEqual(
    firstRun.exposures.map((exposure) => exposure.nodeKey).sort(),
    ["herald", "market", "tavern"],
  );

  const stats = await worker.stats(SCOPE.workspaceId);
  assert.deepEqual(stats, { pending: 0, running: 0, done: 1, failed: 0 });

  // 确定性重放：同一输入再跑一遍，结果逐字节一致。
  await queue.enqueue(SCOPE, { id: "job-2", campaignId: "camp_1", input: jobInput() });
  assert.equal(await worker.runOnce(SCOPE.workspaceId), "done");
  assert.deepEqual(savedRuns[0]?.run, savedRuns[1]?.run);
});

test("worker recovers stale jobs and retries failed ones", async () => {
  const { queue, jobs } = createMemoryQueue();
  let failures = 1;
  const failingQueue: PropagationJobQueue = {
    ...queue,
    async completeRun(scope, lease, run) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("boom");
      }
      return queue.completeRun(scope, lease, run);
    },
  };
  const worker = createPropagationWorker({ queue: failingQueue });
  await queue.enqueue(SCOPE, { id: "job-1", campaignId: "camp_1", input: jobInput() });

  // 第一次执行失败 → failed。
  assert.equal(await worker.runOnce(SCOPE.workspaceId), "failed");
  assert.equal(jobs[0]?.status, "failed");

  // 重试入队 → 完成。
  await worker.retry(SCOPE, "job-1");
  assert.equal(jobs[0]?.status, "pending");
  assert.equal(await worker.runOnce(SCOPE.workspaceId), "done");

  // 遗留 running 恢复为 pending。
  jobs.push({
    id: "job-stale",
    campaignId: "camp_1",
    input: jobInput(),
    status: "running",
    attempts: 1,
    lastError: null,
  });
  assert.equal(await worker.recoverStale(SCOPE.workspaceId), 1);
  assert.equal(jobs.find((job) => job.id === "job-stale")?.status, "pending");
});
