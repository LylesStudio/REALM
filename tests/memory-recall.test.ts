import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  createCharacterMemoryService,
  extractMemoryKeywords,
  lexicalEmbedding,
  type CharacterMemoryRepository,
} from "../modules/memory/public.ts";

test("local lexical embeddings are deterministic, normalized and CJK aware", () => {
  const first = lexicalEmbedding("塞娜观察灯塔潮痕");
  const replay = lexicalEmbedding("塞娜观察灯塔潮痕");
  assert.equal(first.length, MEMORY_EMBEDDING_DIMENSIONS);
  assert.deepEqual(first, replay);
  const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 0.00001);
  assert.deepEqual(
    extractMemoryKeywords("塞娜观察灯塔"),
    ["塞", "娜", "观", "察", "灯", "塔", "塞娜", "娜观", "观察", "察灯", "灯塔"],
  );
});

test("memory service sends only normalized hybrid query material to the authorized repository", async () => {
  const calls: Parameters<CharacterMemoryRepository["recallAuthorized"]>[0][] = [];
  const repository: CharacterMemoryRepository = {
    async recallAuthorized(input) {
      calls.push(input);
      return [];
    },
    async extractAuthorized() {
      return { materialized: 0 };
    },
    async appendAuthorized() {},
    async upsertRelationshipAuthorized() {},
    async relationshipsAuthorized() {
      return [];
    },
    async createSnapshotAuthorized() {
      return null;
    },
    async deltaAuthorized() {
      return null;
    },
    async latestSummaryAuthorized() {
      return null;
    },
  };
  const service = createCharacterMemoryService({ repository });
  const result = await service.recall({
    workspaceId: "ws",
    worldId: "world",
    worldlineId: "line",
    recordId: "record",
    characterInstanceId: "character",
    query: "  密函的蜡封是否动过？  ",
    limit: 99,
  });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.limit, 20);
  assert.equal(calls[0]?.embedding.length, MEMORY_EMBEDDING_DIMENSIONS);
  assert.ok(calls[0]?.keywords.includes("密函"));
  assert.equal(calls[0]?.embeddingModel, "realm-lexical-v1");
});
