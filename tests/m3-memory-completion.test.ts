import assert from "node:assert/strict";
import test from "node:test";
import {
  createCharacterMemoryService,
  estimateMemoryTokens,
  fitMemoryLinesWithinBudget,
  type CharacterMemoryRepository,
  type MemoryRecall,
  type RelationshipState,
} from "../modules/memory/public.ts";

const SCOPE = {
  workspaceId: "ws",
  worldId: "world",
  worldlineId: "line",
  recordId: "record",
  characterInstanceId: "character",
} as const;

function recallItem(content: string, kind: MemoryRecall["memoryKind"] = "explicit"): MemoryRecall {
  return {
    id: `mem_${content.length}`,
    observerContinuityId: "continuity",
    observedEntityKey: "self",
    content,
    memoryKind: kind,
    fidelity: 1,
    occurred: { tick: 1, ordinal: 1 },
    availableFrom: { tick: 1, ordinal: 1 },
    keywords: [],
    keywordScore: 0.5,
    vectorScore: 0.5,
    score: 0.5,
  };
}

function relationshipState(content: string): RelationshipState {
  return {
    observerContinuityId: "continuity",
    targetEntityKey: "塞娜",
    relationKind: "trust",
    content,
    fidelity: 1,
    occurred: { tick: 1, ordinal: 1 },
    availableFrom: { tick: 1, ordinal: 1 },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function stubRepository(overrides: Partial<CharacterMemoryRepository> = {}) {
  const calls = {
    appended: [] as Parameters<CharacterMemoryRepository["appendAuthorized"]>[0][],
    upserted: [] as Parameters<CharacterMemoryRepository["upsertRelationshipAuthorized"]>[0][],
    snapshots: [] as Parameters<CharacterMemoryRepository["createSnapshotAuthorized"]>[0][],
  };
  const repository: CharacterMemoryRepository = {
    async recallAuthorized() {
      return [];
    },
    async extractAuthorized() {
      return { materialized: 0 };
    },
    async appendAuthorized(input) {
      calls.appended.push(input);
    },
    async upsertRelationshipAuthorized(input) {
      calls.upserted.push(input);
    },
    async relationshipsAuthorized() {
      return [];
    },
    async createSnapshotAuthorized(input) {
      calls.snapshots.push(input);
      return {
        id: input.snapshotId,
        observerContinuityId: "continuity",
        snapshotKind: input.snapshotKind,
        content: input.content,
        itemIds: input.itemIds,
        cursor: { tick: 1, ordinal: 1 },
        cacheEpoch: 0,
        tokenCount: input.tokenCount,
        createdAt: "2026-08-14T00:00:00.000Z",
      };
    },
    async deltaAuthorized() {
      return { stale: false, cacheEpoch: 0, items: [] };
    },
    async latestSummaryAuthorized() {
      return null;
    },
    ...overrides,
  };
  return { repository, calls };
}

test("recordRelationship upserts a subjective state and appends evidence", async () => {
  const { repository, calls } = stubRepository();
  const service = createCharacterMemoryService({ repository });

  await service.recordRelationship({
    ...SCOPE,
    targetKey: "塞娜",
    content: "塞娜救过我一次，值得信赖",
  });

  assert.equal(calls.upserted.length, 1);
  assert.equal(calls.upserted[0]?.relationKind, "note");
  assert.equal(calls.upserted[0]?.targetEntityKey, "塞娜");
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0]?.memoryKind, "relationship");
  assert.equal(calls.appended[0]?.observedEntityKey, "塞娜");
});

test("relationships prefers observer-scoped states with subjective phrasing", async () => {
  const { repository } = stubRepository({
    async relationshipsAuthorized() {
      return [relationshipState("塞娜救过我一次，值得信赖")];
    },
    async recallAuthorized() {
      throw new Error("recall must not run when relationship states exist");
    },
  });
  const service = createCharacterMemoryService({ repository });

  const output = await service.relationships(SCOPE);
  assert.ok(output.includes("对 塞娜"));
  assert.ok(output.includes("值得信赖"));
});

test("relationships falls back to derived clues when no states exist", async () => {
  const { repository } = stubRepository();
  const service = createCharacterMemoryService({ repository });
  const output = await service.relationships(SCOPE);
  assert.ok(output.includes("当前没有已整理的关系结论"));
});

test("summarizeDomain persists domain-tagged summaries per domain", async () => {
  const { repository, calls } = stubRepository({
    async recallAuthorized() {
      return [recallItem("玩家决定先观察灯塔")];
    },
  });
  const service = createCharacterMemoryService({ repository });

  const episodic = await service.summarizeDomain(SCOPE, "episodic");
  const decision = await service.summarizeDomain(SCOPE, "decision", "dm");

  assert.ok(episodic.startsWith("情景要点："));
  assert.ok(decision.startsWith("决策要点："));
  assert.equal(calls.appended.length, 2);
  assert.equal(calls.appended[0]?.summaryDomain, "episodic");
  assert.equal(calls.appended[0]?.memoryKind, "summary");
  assert.equal(calls.appended[1]?.summaryDomain, "decision");
  assert.equal(calls.appended[1]?.summaryScope, "dm");
});

test("summarize supersedes the previous summary instead of appending a duplicate", async () => {
  const { repository, calls } = stubRepository({
    async recallAuthorized() {
      return [recallItem("玩家决定先观察灯塔")];
    },
    async latestSummaryAuthorized() {
      return { id: "mem_previous_summary" };
    },
  });
  const service = createCharacterMemoryService({ repository });

  await service.summarize(SCOPE);
  await service.summarizeDomain(SCOPE, "episodic");

  assert.equal(calls.appended.length, 2);
  for (const call of calls.appended) {
    assert.equal(call.operation, "update");
    assert.equal(call.supersedesMemoryId, "mem_previous_summary");
  }
});

test("representation keeps long records within a fixed token budget", async () => {
  const longLines = Array.from({ length: 12 }, (_, index) =>
    recallItem(`第${index}条关于灯塔与密函的较长记忆内容，包含若干细节描述。`)
  );
  const { repository } = stubRepository({
    async recallAuthorized() {
      return longLines;
    },
  });
  const service = createCharacterMemoryService({ repository });

  const budgeted = await service.representation(SCOPE, "immersive", 40);
  assert.ok(estimateMemoryTokens(budgeted) <= 40);
  assert.ok(budgeted.includes("第0条"));

  const unbudgeted = await service.representation(SCOPE, "immersive");
  assert.ok(unbudgeted.includes("第11条"));
});

test("fitMemoryLinesWithinBudget truncates a single overlong line", () => {
  const output = fitMemoryLinesWithinBudget(["一段特别特别长的记忆内容需要被截断而不是丢弃"], 10);
  assert.ok(estimateMemoryTokens(output) <= 12);
  assert.ok(output.endsWith("…"));
  assert.equal(fitMemoryLinesWithinBudget(["任何内容"], 0), "");
});

test("token estimator treats CJK as heavier than latin", () => {
  assert.ok(estimateMemoryTokens("塞娜观察灯塔") > estimateMemoryTokens("abcdef"));
  assert.equal(estimateMemoryTokens(""), 0);
});

test("snapshot freezes recall output with token count and delta delegates", async () => {
  const { repository, calls } = stubRepository({
    async recallAuthorized() {
      return [recallItem("已知事实一"), recallItem("已知事实二")];
    },
  });
  const service = createCharacterMemoryService({ repository });

  const snapshot = await service.snapshot(SCOPE);
  assert.ok(snapshot);
  assert.equal(snapshot?.snapshotKind, "representation");
  assert.equal(snapshot?.cacheEpoch, 0);
  assert.equal(snapshot?.tokenCount, estimateMemoryTokens(snapshot?.content ?? ""));
  assert.equal(calls.snapshots[0]?.itemIds.length, 2);

  const delta = await service.delta(SCOPE, snapshot!.id);
  assert.deepEqual(delta, { stale: false, cacheEpoch: 0, items: [] });
});
