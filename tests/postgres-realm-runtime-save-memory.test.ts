import { createPostgresRealmRuntimeSaveReader as r1WholeReaderFactory } from "../database/postgres/realm-runtime-save-repository.ts";
import { parseRealmRuntimeSaveArchive as r1ParseArchive, type RealmRuntimeSaveArchive as R1NativeArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveWholeDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { RealmRuntimeSaveDomainError } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { createPostgresCharacterMemoryRepository, createPostgresWorldCommandRepository, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { normalizeRealmRuntimeSaveEventForRestore, serializeRealmRuntimeSaveMemoryV2, MEMORY_RUNTIME_FILE_BYTES, type RealmRuntimeSaveMemory } from "../modules/world-transfer/realm-runtime-save.ts";
import { buildCommandPlan } from "../modules/worldline/world-command.ts";
/**
 * `.realm` runtime-save v2 memory 运行态切片 PG 验收（disposable scratch PG；
 * 独立临时库，绝不触碰共享 realm_dev）。
 *
 * 覆盖：
 * 1. 含 memory_conclusions（add + update/supersedes 链、384 维 embedding）、
 *    memory_snapshots（item_ids + cache_epoch）、relationship_states 的
 *    Record 存档 → restore → 幂等 replay 不重复；
 * 2. 目标 Record 的 memory 内容与 source 逐字节一致（embedding 文本、
 *    keywords、occurred/available 游标、cache_epoch、token_count、fidelity、
 *    metadata），observer continuity / source record / source observation /
 *    supersedes / snapshot item_ids 全部重映射到 restore 作用域 id；
 * 3. 失败场景 fail-closed 且整体回滚零残留：observer continuity 未恢复、
 *    source observation 指向未恢复观察、跨 Record 引用、snapshot item 指向
 *    未恢复结论、schema 损坏（parse 期 fail-closed）；
 * 4. RLS/workspace boundary：observer/无 membership principal、跨 workspace
 *    restore 一律 WORLD_NOT_FOUND 且零残留。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { zipSync } from "fflate";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
  RealmRuntimeSaveRepositoryError,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  extractMemoryKeywords,
  lexicalEmbedding,
} from "../modules/memory/public.ts";
import {
  buildRealmRuntimeSaveArchive,
  computeRealmRuntimeSaveContentHash,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
  serializeRealmRuntimeSaveManifestV2,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveManifestV2,
  type RealmRuntimeSaveMemoryV1,
} from "../modules/world-transfer/realm-runtime-save.ts";

// Register before the first connect: pool.end() resolves when idle clients
// are removed, before their actual Client end events have necessarily fired.
const fixtureShutdowns = new WeakMap<pg.Pool, Promise<void>[]>();
const fixtureLiveClients = new WeakMap<pg.Pool, Set<pg.PoolClient>>();
function observeFixturePool(pool: pg.Pool): pg.Pool {
  if (!fixtureShutdowns.has(pool)) {
    const shutdowns: Promise<void>[] = [];
    fixtureShutdowns.set(pool, shutdowns);
    const clients = new Set<pg.PoolClient>();
    fixtureLiveClients.set(pool, clients);
    pool.on("connect", client => {
      clients.add(client);
      shutdowns.push(new Promise<void>(resolve => client.once("end", () => {
        clients.delete(client);
        resolve();
      })));
    });
    pool.on("error", error => { throw error; });
  }
  return pool;
}
// Shared runtime pools unref idle sockets. During shutdown only, retain each
// live socket until its observed end so a child cannot exit with unresolved TLA.
function refFixtureClients(pool: pg.Pool): void {
  for (const client of fixtureLiveClients.get(pool) ?? []) {
    (client as pg.PoolClient & { ref(): void }).ref();
  }
}
async function awaitFixtureClients(pool: pg.Pool): Promise<void> {
  await Promise.all(fixtureShutdowns.get(pool) ?? []);
}

async function awaitFixtureBackends(maintenance: pg.Client, databaseName: string): Promise<void> {
  // A client's socket end precedes the server backend's catalog disappearance.
  // Observe the exact disposable database; never terminate unrelated backends.
  const deadline = Date.now() + 2_000;
  for (;;) {
    const backends = await maintenance.query(
      "SELECT pid, state FROM pg_stat_activity WHERE datname = $1", [databaseName],
    );
    if (backends.rows.length === 0) return;
    if (Date.now() >= deadline) {
      assert.deepEqual(backends.rows, [], "fixture backends must be gone before DROP");
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL integration tests require a loopback database URL.");
  }
  return value;
}

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_save_mem_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  observeFixturePool(ownerPool);
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  observeFixturePool(runtimePool);

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await awaitFixtureClients(runtimePool);
    await awaitFixtureClients(ownerPool);
    try {
      await awaitFixtureBackends(maintenance, databaseName);
      await maintenance.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    } finally {
      await maintenance.end();
    }
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(
      await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"),
    );
  }
  await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
  return { ownerPool, runtimePool };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** restore 作用域产物计数（零残留断言；临时库内无其它 restore 行）。 */
async function restoreArtifactCounts(pool: pg.Pool) {
  const { rows } = await pool.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM worldlines WHERE id LIKE 'worldline\\_restore\\_%') AS worldlines,
      (SELECT count(*)::int FROM stories WHERE id LIKE 'story\\_restore\\_%') AS stories,
      (SELECT count(*)::int FROM records WHERE id LIKE 'record\\_restore\\_%') AS records,
      (SELECT count(*)::int FROM events WHERE id LIKE 'restore\\_event\\_%') AS events,
      (SELECT count(*)::int FROM goal_instances WHERE id LIKE 'goal\\_restore\\_%') AS goals,
      (SELECT count(*)::int FROM goal_assessments WHERE id LIKE 'assessment\\_restore\\_%') AS assessments,
      (SELECT count(*)::int FROM action_receipts WHERE id LIKE 'action\\_receipt\\_restore\\_%') AS receipts,
      (SELECT count(*)::int FROM character_effects WHERE id LIKE 'character\\_effect\\_restore\\_%') AS effects,
      (SELECT count(*)::int FROM observations WHERE id LIKE 'observation\\_restore\\_%') AS observations,
      (SELECT count(*)::int FROM participants WHERE id LIKE 'participant\\_restore\\_%') AS participants,
      (SELECT count(*)::int FROM character_instances WHERE id LIKE 'character\\_instance\\_restore\\_%') AS instances,
      (SELECT count(*)::int FROM scenes WHERE id LIKE 'scene\\_restore\\_%') AS scenes,
      (SELECT count(*)::int FROM visibility_policies WHERE id LIKE 'policy\\_restore\\_%') AS policies,
      (SELECT count(*)::int FROM memory_conclusions WHERE id LIKE 'memory\\_conclusion\\_restore\\_%') AS memory_conclusions,
      (SELECT count(*)::int FROM memory_snapshots WHERE id LIKE 'memory\\_snapshot\\_restore\\_%') AS memory_snapshots,
      (SELECT count(*)::int FROM relationship_states
        WHERE observer_continuity_id LIKE 'character\\_continuity\\_restore\\_%') AS relationship_states
  `);
  return rows[0]!;
}

interface ConclusionRow {
  id: string;
  observer_continuity_id: string;
  observed_entity_key: string;
  source_record_id: string | null;
  source_observation_id: string | null;
  supersedes_memory_id: string | null;
  operation: string;
  memory_kind: string;
  content: string;
  keywords: string[];
  semantic_embedding: string;
  embedding_model: string;
  fidelity: string;
  occurred_tick: string;
  occurred_ordinal: string;
  available_from_tick: string;
  available_from_ordinal: string;
  metadata: Record<string, unknown>;
}

interface SnapshotRow {
  id: string;
  observer_continuity_id: string;
  snapshot_kind: string;
  content: string;
  item_ids: string[];
  cursor_tick: string;
  cursor_ordinal: string;
  cache_epoch: number;
  token_count: number;
}

interface RelationshipRow {
  observer_continuity_id: string;
  target_entity_key: string;
  relation_kind: string;
  content: string;
  fidelity: string;
  source_record_id: string | null;
  source_observation_id: string | null;
  occurred_tick: string;
  occurred_ordinal: string;
  available_from_tick: string;
  available_from_ordinal: string;
}

test(
  "runtime-save v2 memory conclusions / snapshots / relationship states 全量切片",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    // ---- source memory 运行态装配 --------------------------------------
    // 两条 record 内 observation（玩家/斥候各一），作为 conclusion 与
    // relationship 的 source 引用锚点。
    await ownerPool.query(
      `INSERT INTO observations (
         workspace_id, world_id, worldline_id, record_id,
         observer_character_instance_id, source_event_id, id,
         dedupe_key, observation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal, learned_at, metadata
       ) VALUES
         ($1, $2, $3, $4, $5, NULL, 'obs_save_mem_1', 'save-mem:1', 'direct',
          '栈桥尽头的灯在雾中亮着。', 0.9, 10, 1, 10, 2,
          '2026-08-20T03:00:00.000Z', $6::jsonb),
         ($1, $2, $3, $4, $7, NULL, 'obs_save_mem_2', 'save-mem:2', 'inferred',
          '斥候注意到缆绳被重新系过。', 0.7, 10, 3, 10, 4,
          '2026-08-20T03:01:00.000Z', $6::jsonb)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        POSTGRES_DEMO_IDS.playerInstance,
        JSON.stringify({ channel: "save-memory-test" }),
        POSTGRES_DEMO_IDS.scoutInstance,
      ],
    );

    const conclusionFixtures = [
      {
        id: "mem_save_a",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "lighthouse_keeper",
        sourceRecordId: SCOPE.recordId as string | null,
        sourceObservationId: "obs_save_mem_1" as string | null,
        supersedesMemoryId: null as string | null,
        operation: "add",
        memoryKind: "explicit",
        content: "守灯人在雾里点亮了栈桥尽头的灯。",
        fidelity: 0.9,
        occurred: [10, 1],
        available: [10, 2],
        metadata: { sourceObservationKind: "direct" },
      },
      {
        id: "mem_save_b",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "self",
        sourceRecordId: null,
        sourceObservationId: null,
        supersedesMemoryId: null,
        operation: "add",
        memoryKind: "preference",
        content: "玩家偏好先观察再行动。",
        fidelity: 1.0,
        occurred: [10, 2],
        available: [10, 2],
        metadata: {},
      },
      {
        id: "mem_save_c",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "self",
        sourceRecordId: null,
        sourceObservationId: null,
        supersedesMemoryId: "mem_save_b",
        operation: "update",
        memoryKind: "preference",
        content: "修订：玩家偏好先观察再行动，但雾夜例外。",
        fidelity: 0.95,
        occurred: [10, 2],
        available: [10, 5],
        metadata: { revisionReason: "fog-night" },
      },
      {
        id: "mem_save_d",
        continuity: POSTGRES_DEMO_IDS.scoutContinuity,
        observedEntityKey: "mooring_lines",
        sourceRecordId: SCOPE.recordId,
        sourceObservationId: "obs_save_mem_2",
        supersedesMemoryId: null,
        operation: "add",
        memoryKind: "inferred",
        content: "缆绳在夜里被人重新系过。",
        fidelity: 0.7,
        occurred: [10, 3],
        available: [10, 4],
        metadata: { sourceObservationKind: "inferred" },
      },
    ];
    for (const fixture of conclusionFixtures) {
      await ownerPool.query(
        `INSERT INTO memory_conclusions (
           workspace_id, world_id, worldline_id, observer_continuity_id,
           observed_entity_key, source_record_id, source_observation_id,
           supersedes_memory_id, id, operation, memory_kind, content,
           keywords, semantic_embedding, embedding_model, fidelity,
           occurred_tick, occurred_ordinal,
           available_from_tick, available_from_ordinal, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13::text[], $14::vector, 'realm-lexical-v1', $15,
           $16, $17, $18, $19, $20::jsonb
         )`,
        [
          SCOPE.workspaceId,
          SCOPE.worldId,
          SCOPE.worldlineId,
          fixture.continuity,
          fixture.observedEntityKey,
          fixture.sourceRecordId,
          fixture.sourceObservationId,
          fixture.supersedesMemoryId,
          fixture.id,
          fixture.operation,
          fixture.memoryKind,
          fixture.content,
          [...extractMemoryKeywords(fixture.content)],
          vectorLiteral(lexicalEmbedding(fixture.content)),
          fixture.fidelity,
          fixture.occurred[0],
          fixture.occurred[1],
          fixture.available[0],
          fixture.available[1],
          JSON.stringify(fixture.metadata),
        ],
      );
    }
    await ownerPool.query(
      `INSERT INTO memory_snapshots (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         id, snapshot_kind, content, item_ids,
         cursor_tick, cursor_ordinal, cache_epoch, token_count
       ) VALUES (
         $1, $2, $3, $4, 'snap_save_a', 'recall',
         '已知：守灯人点亮了雾灯；玩家偏好先观察。', $5::text[],
         10, 5, 1, 64
       )`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        POSTGRES_DEMO_IDS.playerContinuity,
        ["mem_save_a", "mem_save_c"],
      ],
    );
    await ownerPool.query(
      `INSERT INTO relationship_states (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         target_entity_key, relation_kind, content, fidelity,
         source_record_id, source_observation_id,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES
         ($1, $2, $3, $4, 'lighthouse_keeper', 'trust',
          '守灯人值得信任，但他隐瞒了雾号的事。', 0.65,
          $5, 'obs_save_mem_1', 10, 1, 10, 2),
         ($1, $2, $3, $6, 'player', 'note',
          '斥候认为玩家观察力强。', 0.8,
          NULL, NULL, 10, 3, 10, 4)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        POSTGRES_DEMO_IDS.playerContinuity,
        SCOPE.recordId,
        POSTGRES_DEMO_IDS.scoutContinuity,
      ],
    );

    // ---- source 快照（逐字节对照基线） ----------------------------------
    const sourceConclusions = (await ownerPool.query<ConclusionRow>(
      `SELECT id, observer_continuity_id, observed_entity_key,
              source_record_id, source_observation_id, supersedes_memory_id,
              operation, memory_kind, content, keywords,
              semantic_embedding::text AS semantic_embedding,
              embedding_model, fidelity::text AS fidelity,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal, metadata
       FROM memory_conclusions
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceConclusions.length, 4);
    const sourceSnapshots = (await ownerPool.query<SnapshotRow>(
      `SELECT id, observer_continuity_id, snapshot_kind, content, item_ids,
              cursor_tick, cursor_ordinal, cache_epoch, token_count
       FROM memory_snapshots
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceSnapshots.length, 1);
    const sourceRelationships = (await ownerPool.query<RelationshipRow>(
      `SELECT observer_continuity_id, target_entity_key, relation_kind,
              content, fidelity::text AS fidelity,
              source_record_id, source_observation_id,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal
       FROM relationship_states
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY observer_continuity_id, target_entity_key, relation_kind`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceRelationships.length, 2);

    // ---- save：memory 三段进入存档 --------------------------------------
    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const archive = await reader.load({ principalId: POSTGRES_DEMO_IDS.principal, purpose: "record-export",
      workspaceId: SCOPE.workspaceId,
      recordId: SCOPE.recordId,
    });
    assert.ok(archive, "demo Record must be loadable");
    assert.equal(archive.manifest.mode, "base");
    assert.equal(archive.memory?.conclusions.length, 4);
    assert.equal(archive.memory?.snapshots.length, 1);
    assert.equal(archive.memory?.relationshipStates.length, 2);
    // embedding 以 384 维 number[] 进入存档。
    assert.equal(archive.memory!.conclusions[0]!.semanticEmbedding.length, 384);
    // 存档字节级 round-trip：parse(build(archive)) 与 reader 输出一致。
    const archiveBytes = buildRealmRuntimeSaveArchive(archive);
    const reparsed = parseRealmRuntimeSaveArchive(archiveBytes);
    assert.deepEqual(reparsed.memory, archive.memory);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
    const restoreInput = {
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: "save-mem-restore-1",
    };

    // ---- restore：memory 三段物化到目标 Record/Worldline -----------------
    const restored = await restorer.restore(restoreInput);
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedMemoryConclusionCount, 4);
    assert.equal(restored.importedMemorySnapshotCount, 1);
    assert.equal(restored.importedRelationshipStateCount, 2);

    const targetConclusions = (await ownerPool.query<ConclusionRow>(
      `SELECT id, observer_continuity_id, observed_entity_key,
              source_record_id, source_observation_id, supersedes_memory_id,
              operation, memory_kind, content, keywords,
              semantic_embedding::text AS semantic_embedding,
              embedding_model, fidelity::text AS fidelity,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal, metadata
       FROM memory_conclusions
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetConclusions.length, 4);
    const targetContinuityIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM character_continuities
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows.map((row) => row.id));
    const targetObservationIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM observations WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows.map((row) => row.id));
    const targetConclusionIds = new Set(targetConclusions.map((row) => row.id));
    // IDs are remapped independently of SQL row order. Match the immutable
    // fixture content one-to-one, then retain every byte/value assertion.
    const sourceByContent = new Map(sourceConclusions.map(source => [source.content,source]));
    assert.equal(sourceByContent.size,sourceConclusions.length);
    assert.equal(new Set(targetConclusions.map(target=>target.content)).size,sourceConclusions.length);
    for (const target of targetConclusions) {
      const source = sourceByContent.get(target.content)!;
      assert.ok(source);
      // 内容逐字节一致：embedding 文本、keywords、游标、fidelity、metadata。
      assert.equal(target.semantic_embedding, source.semantic_embedding);
      assert.deepEqual(target.keywords, source.keywords);
      assert.equal(target.content, source.content);
      assert.equal(target.operation, source.operation);
      assert.equal(target.memory_kind, source.memory_kind);
      assert.equal(target.observed_entity_key, source.observed_entity_key);
      assert.equal(target.embedding_model, source.embedding_model);
      assert.equal(target.fidelity, source.fidelity);
      assert.equal(target.occurred_tick, source.occurred_tick);
      assert.equal(target.occurred_ordinal, source.occurred_ordinal);
      assert.equal(target.available_from_tick, source.available_from_tick);
      assert.equal(target.available_from_ordinal, source.available_from_ordinal);
      assert.deepEqual(target.metadata, source.metadata);
      // 引用全部重映射到 restore 作用域 id，绝不回指 source id。
      assert.match(target.id, /^memory_conclusion_restore_/);
      assert.notEqual(target.id, source.id);
      assert.ok(targetContinuityIds.has(target.observer_continuity_id));
      assert.notEqual(target.observer_continuity_id, source.observer_continuity_id);
      if (source.source_record_id !== null) {
        assert.equal(target.source_record_id, restored.recordId);
        assert.ok(targetObservationIds.has(target.source_observation_id!));
        assert.notEqual(target.source_observation_id, source.source_observation_id);
      } else {
        assert.equal(target.source_record_id, null);
        assert.equal(target.source_observation_id, null);
      }
      if (source.supersedes_memory_id !== null) {
        assert.ok(targetConclusionIds.has(target.supersedes_memory_id!));
        assert.notEqual(target.supersedes_memory_id, source.supersedes_memory_id);
      } else {
        assert.equal(target.supersedes_memory_id, null);
      }
    }

    const targetSnapshots = (await ownerPool.query<SnapshotRow>(
      `SELECT id, observer_continuity_id, snapshot_kind, content, item_ids,
              cursor_tick, cursor_ordinal, cache_epoch, token_count
       FROM memory_snapshots
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetSnapshots.length, 1);
    const targetSnapshot = targetSnapshots[0]!;
    const sourceSnapshot = sourceSnapshots[0]!;
    assert.match(targetSnapshot.id, /^memory_snapshot_restore_/);
    assert.ok(targetContinuityIds.has(targetSnapshot.observer_continuity_id));
    assert.equal(targetSnapshot.snapshot_kind, sourceSnapshot.snapshot_kind);
    assert.equal(targetSnapshot.content, sourceSnapshot.content);
    assert.equal(targetSnapshot.cursor_tick, sourceSnapshot.cursor_tick);
    assert.equal(targetSnapshot.cursor_ordinal, sourceSnapshot.cursor_ordinal);
    assert.equal(targetSnapshot.cache_epoch, sourceSnapshot.cache_epoch);
    assert.equal(targetSnapshot.token_count, sourceSnapshot.token_count);
    // item_ids 在目标作用域内重映射，个数与顺序保持。
    assert.equal(targetSnapshot.item_ids.length, sourceSnapshot.item_ids.length);
    for (const itemId of targetSnapshot.item_ids) {
      assert.ok(targetConclusionIds.has(itemId));
      assert.match(itemId, /^memory_conclusion_restore_/);
    }

    const targetRelationships = (await ownerPool.query<RelationshipRow>(
      `SELECT observer_continuity_id, target_entity_key, relation_kind,
              content, fidelity::text AS fidelity,
              source_record_id, source_observation_id,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal
       FROM relationship_states
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY observer_continuity_id, target_entity_key, relation_kind`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetRelationships.length, 2);
    const sourceRelationshipByKey = new Map(
      sourceRelationships.map((row) => [`${row.target_entity_key} ${row.relation_kind}`, row]),
    );
    for (const target of targetRelationships) {
      const source = sourceRelationshipByKey.get(`${target.target_entity_key} ${target.relation_kind}`)!;
      assert.ok(source, "target relationship must pair with a source relationship");
      assert.equal(target.content, source.content);
      assert.equal(target.fidelity, source.fidelity);
      assert.equal(target.occurred_tick, source.occurred_tick);
      assert.equal(target.occurred_ordinal, source.occurred_ordinal);
      assert.equal(target.available_from_tick, source.available_from_tick);
      assert.equal(target.available_from_ordinal, source.available_from_ordinal);
      assert.ok(targetContinuityIds.has(target.observer_continuity_id));
      assert.notEqual(target.observer_continuity_id, source.observer_continuity_id);
      if (source.source_record_id !== null) {
        assert.equal(target.source_record_id, restored.recordId);
        assert.ok(targetObservationIds.has(target.source_observation_id!));
      } else {
        assert.equal(target.source_record_id, null);
        assert.equal(target.source_observation_id, null);
      }
    }

    // ---- 幂等 replay：同存档同键 → memory 不重复 --------------------------
    const replay = await restorer.restore(restoreInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, restored.recordId);
    assert.equal(replay.importedMemoryConclusionCount, 4);
    assert.equal(replay.importedMemorySnapshotCount, 1);
    assert.equal(replay.importedRelationshipStateCount, 2);
    const afterReplay = await ownerPool.query<{
      conclusions: number;
      snapshots: number;
      relationships: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM memory_conclusions
           WHERE workspace_id = $1 AND worldline_id = $2) AS conclusions,
         (SELECT count(*)::int FROM memory_snapshots
           WHERE workspace_id = $1 AND worldline_id = $2) AS snapshots,
         (SELECT count(*)::int FROM relationship_states
           WHERE workspace_id = $1 AND worldline_id = $2) AS relationships`,
      [SCOPE.workspaceId, restored.worldlineId],
    );
    assert.deepEqual(afterReplay.rows[0], { conclusions: 4, snapshots: 1, relationships: 2 });
    const baseline = await restoreArtifactCounts(ownerPool);

    // ---- 失败场景（全部 fail-closed + 零残留） ---------------------------
    const rebuildArchive = (memorySection: RealmRuntimeSaveMemoryV1): RealmRuntimeSaveArchive => {
      // manifest 由合法原档派生（hash 只覆盖 runtime/ 段；restorer 直接消费
      // 解析后的对象，不重演字节校验）——memory 段在返回对象中被替换为
      // 精心构造的非法引用，驱动 restorer normalize 的 fail-closed 分支；
      // 契约层（build/parse）对同类损坏的拒绝由单测与 F5 覆盖。
      const manifest = realmRuntimeSaveManifestFromData({
        engineApi: archive.manifest.engineApi,
        mode: archive.manifest.mode,
        world: archive.manifest.world,
        scope: archive.manifest.scope,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: archive.memory,
      });
      return {
        manifest,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: memorySection,
      };
    };
    const expectRestoreFailure = async (
      badArchive: RealmRuntimeSaveArchive,
      idempotencyKey: string,
      code: RealmRuntimeSaveRepositoryError["code"],
    ) => {
      await assert.rejects(
        restorer.restore({ ...restoreInput, archive: badArchive, idempotencyKey }),
        (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
          && error.code === code,
      );
      assert.deepEqual(
        await restoreArtifactCounts(ownerPool),
        baseline,
        `${code} 失败路径不得留下任何 restore 残留`,
      );
    };

    assert.ok(archive.memory?.schemaVersion === 1, "the shipped Record-only fixture retains legacy V1 memory");
    // F1：observer continuity 未被恢复（不在存档 topology 内）。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceObserverContinuityId: "continuity_never_restored" }
          : conclusion),
      }),
      "save-mem-bad-continuity",
      "RUNTIME_SAVE_INVALID",
    );

    // F2：source observation 指向未随存档恢复的观察。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceObservationId: "obs_never_restored" }
          : conclusion),
      }),
      "save-mem-bad-observation",
      "RUNTIME_SAVE_INVALID",
    );

    // F3：跨 Record 引用（conclusion 与 relationship state 各一例）。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceRecordId: "record_elsewhere" }
          : conclusion),
      }),
      "save-mem-cross-record",
      "RUNTIME_SAVE_INVALID",
    );
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        relationshipStates: archive.memory!.relationshipStates.map((state, index) => index === 0
          ? { ...state, sourceRecordId: "record_elsewhere" }
          : state),
      }),
      "save-mem-cross-record-rel",
      "RUNTIME_SAVE_INVALID",
    );

    // F4：snapshot item_ids 指向未恢复结论。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        snapshots: archive.memory!.snapshots.map((snapshot) => ({
          ...snapshot,
          sourceItemIds: [...snapshot.sourceItemIds, "mem_never_restored"],
        })),
      }),
      "save-mem-bad-snapshot-item",
      "RUNTIME_SAVE_INVALID",
    );

    // F5：schema 损坏（memory 段缺必填键，hash 正确重算）→ parse 期 fail-closed。
    const corruptedMemory = Buffer.from(JSON.stringify({
      format: "realm-runtime-memory",
      schemaVersion: 1,
      conclusions: [{ sourceMemoryId: "mem-broken" }],
      snapshots: [],
      relationshipStates: [],
    }));
    const recordEntry = Buffer.from(JSON.stringify(archive.record));
    const goalsEntry = Buffer.from(JSON.stringify(archive.goals));
    const corruptedManifest: RealmRuntimeSaveManifestV2 = {
      ...archive.manifest,
      snapshot: {
        ...archive.manifest.snapshot,
        runtimeHash: computeRealmRuntimeSaveContentHash(new Map([
          ["runtime/record.json", recordEntry],
          ["runtime/goals.json", goalsEntry],
          ["runtime/memory.json", corruptedMemory],
        ])),
      },
    };
    const corruptedBytes = zipSync({
      "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(corruptedManifest)),
      "runtime/record.json": recordEntry,
      "runtime/goals.json": goalsEntry,
      "runtime/memory.json": corruptedMemory,
    });
    assert.throws(
      () => parseRealmRuntimeSaveArchive(corruptedBytes),
      (error: unknown) => error instanceof RealmRuntimeSaveError
        && error.code === "INVALID_SAVE",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "schema 损坏的存档不得触及任何目标表",
    );

    // F6：RLS/workspace boundary——observer、无 membership principal、
    // 跨 workspace 一律 WORLD_NOT_FOUND 且零残留。
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_observer', 'observer')
       ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_save_mem_other', '其它工作台')
       ON CONFLICT (id) DO NOTHING`,
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_observer", idempotencyKey: "save-mem-observer" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_nobody", idempotencyKey: "save-mem-nobody" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, workspaceId: "ws_save_mem_other", idempotencyKey: "save-mem-ws" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "边界失败路径不得留下任何 restore 残留",
    );
  },
);

{
// This assertion only narrows the rich wire shape; authorization still goes
// through the actual reader and its explicit principal/purpose on every call.
type RealmRuntimeSaveArchive=Omit<R1NativeArchive,"domain"> & {domain?:RealmRuntimeSaveWholeDomainV1};
function r1AssertWholeArchive(archive:R1NativeArchive): RealmRuntimeSaveArchive {
  if(archive.domain)assert.ok(Array.isArray(archive.domain.records) && Array.isArray(archive.domain.stories) && Array.isArray(archive.domain.storyDefinitions));
  return archive as RealmRuntimeSaveArchive;
}
function createPostgresRealmRuntimeSaveReader(...args:Parameters<typeof r1WholeReaderFactory>) {
  const reader=r1WholeReaderFactory(...args);
  return {async load(input:Parameters<typeof reader.load>[0]) {const archive=await reader.load(input);return archive?r1AssertWholeArchive(archive):null;}};
}
function parseRealmRuntimeSaveArchive(...args:Parameters<typeof r1ParseArchive>) {return r1AssertWholeArchive(r1ParseArchive(...args));}


// Explicit operator fixture for the frozen whole-closure tests; HTTP and SQL
// still evaluate exact operator + current World owner on every request.
let wholePreviousOperators: string | undefined;
test.beforeEach(()=>{wholePreviousOperators=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;});
test.afterEach(()=>{if(wholePreviousOperators===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=wholePreviousOperators;});


const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL integration tests require a loopback database URL.");
  }
  return value;
}

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_save_mem_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  observeFixturePool(ownerPool);
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  observeFixturePool(runtimePool);

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await awaitFixtureClients(runtimePool);
    await awaitFixtureClients(ownerPool);
    try {
      await awaitFixtureBackends(maintenance, databaseName);
      await maintenance.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    } finally {
      await maintenance.end();
    }
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(
      await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"),
    );
  }
  await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
  return { ownerPool, runtimePool, runtimeUrl: runtimeUrl.href };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** restore 作用域产物计数（零残留断言；临时库内无其它 restore 行）。 */
async function restoreArtifactCounts(pool: pg.Pool) {
  const { rows } = await pool.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM worldlines WHERE id LIKE 'worldline\\_restore\\_%') AS worldlines,
      (SELECT count(*)::int FROM stories WHERE id LIKE 'story\\_restore\\_%') AS stories,
      (SELECT count(*)::int FROM records WHERE id LIKE 'record\\_restore\\_%') AS records,
      (SELECT count(*)::int FROM events WHERE id LIKE 'restore\\_event\\_%') AS events,
      (SELECT count(*)::int FROM goal_instances WHERE id LIKE 'goal\\_restore\\_%') AS goals,
      (SELECT count(*)::int FROM goal_assessments WHERE id LIKE 'assessment\\_restore\\_%') AS assessments,
      (SELECT count(*)::int FROM action_receipts WHERE id LIKE 'action\\_receipt\\_restore\\_%') AS receipts,
      (SELECT count(*)::int FROM character_effects WHERE id LIKE 'character\\_effect\\_restore\\_%') AS effects,
      (SELECT count(*)::int FROM observations WHERE id LIKE 'observation\\_restore\\_%') AS observations,
      (SELECT count(*)::int FROM participants WHERE id LIKE 'participant\\_restore\\_%') AS participants,
      (SELECT count(*)::int FROM character_instances WHERE id LIKE 'character\\_instance\\_restore\\_%') AS instances,
      (SELECT count(*)::int FROM scenes WHERE id LIKE 'scene\\_restore\\_%') AS scenes,
      (SELECT count(*)::int FROM visibility_policies WHERE id LIKE 'policy\\_restore\\_%') AS policies,
      (SELECT count(*)::int FROM memory_conclusions WHERE id LIKE 'memory\\_conclusion\\_restore\\_%') AS memory_conclusions,
      (SELECT count(*)::int FROM memory_snapshots WHERE id LIKE 'memory\\_snapshot\\_restore\\_%') AS memory_snapshots,
      (SELECT count(*)::int FROM relationship_states
        WHERE observer_continuity_id LIKE 'character\\_continuity\\_restore\\_%') AS relationship_states
  `);
  return rows[0]!;
}

interface ConclusionRow {
  id: string;
  observer_continuity_id: string;
  observed_entity_key: string;
  source_record_id: string | null;
  source_observation_id: string | null;
  supersedes_memory_id: string | null;
  operation: string;
  memory_kind: string;
  content: string;
  keywords: string[];
  semantic_embedding: string;
  embedding_model: string;
  fidelity: string;
  occurred_tick: string;
  occurred_ordinal: string;
  available_from_tick: string;
  available_from_ordinal: string;
  metadata: Record<string, unknown>;
}

interface SnapshotRow {
  id: string;
  observer_continuity_id: string;
  snapshot_kind: string;
  content: string;
  item_ids: string[];
  cursor_tick: string;
  cursor_ordinal: string;
  cache_epoch: number;
  token_count: number;
}

interface RelationshipRow {
  observer_continuity_id: string;
  target_entity_key: string;
  relation_kind: string;
  content: string;
  fidelity: string;
  source_record_id: string | null;
  source_observation_id: string | null;
  occurred_tick: string;
  occurred_ordinal: string;
  available_from_tick: string;
  available_from_ordinal: string;
}

test(
  "runtime-save v2 memory conclusions / snapshots / relationship states 全量切片",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    // ---- source memory 运行态装配 --------------------------------------
    // 两条 record 内 observation（玩家/斥候各一），作为 conclusion 与
    // relationship 的 source 引用锚点。
    await ownerPool.query(
      `INSERT INTO observations (
         workspace_id, world_id, worldline_id, record_id,
         observer_character_instance_id, source_event_id, id,
         dedupe_key, observation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal, learned_at, metadata
       ) VALUES
         ($1, $2, $3, $4, $5, NULL, 'obs_save_mem_1', 'save-mem:1', 'direct',
          '栈桥尽头的灯在雾中亮着。', 0.9, 10, 1, 10, 2,
          '2026-08-20T03:00:00.000Z', $6::jsonb),
         ($1, $2, $3, $4, $7, NULL, 'obs_save_mem_2', 'save-mem:2', 'inferred',
          '斥候注意到缆绳被重新系过。', 0.7, 10, 3, 10, 4,
          '2026-08-20T03:01:00.000Z', $6::jsonb)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        POSTGRES_DEMO_IDS.playerInstance,
        JSON.stringify({ channel: "save-memory-test" }),
        POSTGRES_DEMO_IDS.scoutInstance,
      ],
    );

    const conclusionFixtures = [
      {
        id: "mem_save_a",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "lighthouse_keeper",
        sourceRecordId: SCOPE.recordId as string | null,
        sourceObservationId: "obs_save_mem_1" as string | null,
        supersedesMemoryId: null as string | null,
        operation: "add",
        memoryKind: "explicit",
        content: "守灯人在雾里点亮了栈桥尽头的灯。",
        fidelity: 0.9,
        occurred: [10, 1],
        available: [10, 2],
        metadata: { sourceObservationKind: "direct" },
      },
      {
        id: "mem_save_b",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "self",
        sourceRecordId: null,
        sourceObservationId: null,
        supersedesMemoryId: null,
        operation: "add",
        memoryKind: "preference",
        content: "玩家偏好先观察再行动。",
        fidelity: 1.0,
        occurred: [10, 2],
        available: [10, 2],
        metadata: {},
      },
      {
        id: "mem_save_c",
        continuity: POSTGRES_DEMO_IDS.playerContinuity,
        observedEntityKey: "self",
        sourceRecordId: null,
        sourceObservationId: null,
        supersedesMemoryId: "mem_save_b",
        operation: "update",
        memoryKind: "preference",
        content: "修订：玩家偏好先观察再行动，但雾夜例外。",
        fidelity: 0.95,
        occurred: [10, 2],
        available: [10, 5],
        metadata: { revisionReason: "fog-night" },
      },
      {
        id: "mem_save_d",
        continuity: POSTGRES_DEMO_IDS.scoutContinuity,
        observedEntityKey: "mooring_lines",
        sourceRecordId: SCOPE.recordId,
        sourceObservationId: "obs_save_mem_2",
        supersedesMemoryId: null,
        operation: "add",
        memoryKind: "inferred",
        content: "缆绳在夜里被人重新系过。",
        fidelity: 0.7,
        occurred: [10, 3],
        available: [10, 4],
        metadata: { sourceObservationKind: "inferred" },
      },
    ];
    for (const fixture of conclusionFixtures) {
      await ownerPool.query(
        `INSERT INTO memory_conclusions (
           workspace_id, world_id, worldline_id, observer_continuity_id,
           observed_entity_key, source_record_id, source_observation_id,
           supersedes_memory_id, id, operation, memory_kind, content,
           keywords, semantic_embedding, embedding_model, fidelity,
           occurred_tick, occurred_ordinal,
           available_from_tick, available_from_ordinal, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13::text[], $14::vector, 'realm-lexical-v1', $15,
           $16, $17, $18, $19, $20::jsonb
         )`,
        [
          SCOPE.workspaceId,
          SCOPE.worldId,
          SCOPE.worldlineId,
          fixture.continuity,
          fixture.observedEntityKey,
          fixture.sourceRecordId,
          fixture.sourceObservationId,
          fixture.supersedesMemoryId,
          fixture.id,
          fixture.operation,
          fixture.memoryKind,
          fixture.content,
          [...extractMemoryKeywords(fixture.content)],
          vectorLiteral(lexicalEmbedding(fixture.content)),
          fixture.fidelity,
          fixture.occurred[0],
          fixture.occurred[1],
          fixture.available[0],
          fixture.available[1],
          JSON.stringify(fixture.metadata),
        ],
      );
    }
    await ownerPool.query(
      `INSERT INTO memory_snapshots (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         id, snapshot_kind, content, item_ids,
         cursor_tick, cursor_ordinal, cache_epoch, token_count
       ) VALUES (
         $1, $2, $3, $4, 'snap_save_a', 'recall',
         '已知：守灯人点亮了雾灯；玩家偏好先观察。', $5::text[],
         10, 5, 1, 64
       )`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        POSTGRES_DEMO_IDS.playerContinuity,
        ["mem_save_a", "mem_save_c"],
      ],
    );
    await ownerPool.query(
      `INSERT INTO relationship_states (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         target_entity_key, relation_kind, content, fidelity,
         source_record_id, source_observation_id,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES
         ($1, $2, $3, $4, 'lighthouse_keeper', 'trust',
          '守灯人值得信任，但他隐瞒了雾号的事。', 0.65,
          $5, 'obs_save_mem_1', 10, 1, 10, 2),
         ($1, $2, $3, $6, 'player', 'note',
          '斥候认为玩家观察力强。', 0.8,
          NULL, NULL, 10, 3, 10, 4)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        POSTGRES_DEMO_IDS.playerContinuity,
        SCOPE.recordId,
        POSTGRES_DEMO_IDS.scoutContinuity,
      ],
    );
    await ownerPool.query(
      `INSERT INTO memory_cache_epochs (workspace_id, observer_continuity_id, epoch)
       VALUES ($1, $2, 1), ($1, $3, 0), ($1, $4, 0)
       ON CONFLICT (workspace_id, observer_continuity_id) DO UPDATE
       SET epoch = EXCLUDED.epoch`,
      [SCOPE.workspaceId, POSTGRES_DEMO_IDS.playerContinuity, POSTGRES_DEMO_IDS.scoutContinuity, POSTGRES_DEMO_IDS.scholarContinuity],
    );

    // ---- source 快照（逐字节对照基线） ----------------------------------
    const sourceConclusions = (await ownerPool.query<ConclusionRow>(
      `SELECT id, observer_continuity_id, observed_entity_key,
              source_record_id, source_observation_id, supersedes_memory_id,
              operation, memory_kind, content, keywords,
              semantic_embedding::text AS semantic_embedding,
              embedding_model, fidelity::text AS fidelity,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal, metadata
       FROM memory_conclusions
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceConclusions.length, 4);
    const sourceSnapshots = (await ownerPool.query<SnapshotRow>(
      `SELECT id, observer_continuity_id, snapshot_kind, content, item_ids,
              cursor_tick, cursor_ordinal, cache_epoch, token_count
       FROM memory_snapshots
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceSnapshots.length, 1);
    const sourceRelationships = (await ownerPool.query<RelationshipRow>(
      `SELECT observer_continuity_id, target_entity_key, relation_kind,
              content, fidelity::text AS fidelity,
              source_record_id, source_observation_id,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal
       FROM relationship_states
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY observer_continuity_id, target_entity_key, relation_kind`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    )).rows;
    assert.equal(sourceRelationships.length, 2);

    // ---- save：memory 三段进入存档 --------------------------------------
    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const archive = await reader.load({ workspaceId: SCOPE.workspaceId, recordId: SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive, "demo Record must be loadable");
    assert.equal(archive.manifest.mode, "base");
    assert.equal(archive.memory?.conclusions.length, 4);
    assert.equal(archive.memory?.snapshots.length, 1);
    assert.equal(archive.memory?.relationshipStates.length, 2);
    // embedding 以 384 维 number[] 进入存档。
    assert.equal(archive.memory!.conclusions[0]!.semanticEmbedding.length, 384);
    // 存档字节级 round-trip：parse(build(archive)) 与 reader 输出一致。
    const archiveBytes = buildRealmRuntimeSaveArchive(archive);
    const reparsed = parseRealmRuntimeSaveArchive(archiveBytes);
    assert.deepEqual(reparsed.memory, archive.memory);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
    const restoreInput = {
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: "save-mem-restore-1",
    };

    // ---- restore：memory 三段物化到目标 Record/Worldline -----------------
    const restored = await restorer.restore(restoreInput);
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedMemoryConclusionCount, 4);
    assert.equal(restored.importedMemorySnapshotCount, 1);
    assert.equal(restored.importedRelationshipStateCount, 2);

    const targetConclusions = (await ownerPool.query<ConclusionRow>(
      `SELECT id, observer_continuity_id, observed_entity_key,
              source_record_id, source_observation_id, supersedes_memory_id,
              operation, memory_kind, content, keywords,
              semantic_embedding::text AS semantic_embedding,
              embedding_model, fidelity::text AS fidelity,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal, metadata
       FROM memory_conclusions
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetConclusions.length, 4);
    const targetContinuityIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM character_continuities
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows.map((row) => row.id));
    const targetObservationIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM observations WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows.map((row) => row.id));
    const targetConclusionIds = new Set(targetConclusions.map((row) => row.id));
    const conclusionIds = typedBijection(sourceConclusions, targetConclusions, "accepted memory conclusions");
    const sourceByTarget = new Map(sourceConclusions.map((row) => [conclusionIds.get(row.id)!, row]));
    const continuityPairs = (await ownerPool.query<{ source_id: string; target_id: string }>(
      `SELECT source.id AS source_id, target.id AS target_id FROM character_continuities source
       JOIN character_continuities target ON target.workspace_id = source.workspace_id
         AND target.world_id = source.world_id AND target.continuity_key = source.continuity_key
       WHERE source.workspace_id = $1 AND source.worldline_id = $2 AND target.worldline_id = $3`,
      [SCOPE.workspaceId, SCOPE.worldlineId, restored.worldlineId])).rows;
    const continuityIds = new Map(continuityPairs.map((row) => [row.source_id, row.target_id]));
    assert.equal(continuityIds.size, targetContinuityIds.size);
    assert.equal(new Set(continuityIds.values()).size, targetContinuityIds.size);
    const observationRows = await ownerPool.query<{ id: string; content: string; record_id: string }>(
      `SELECT id, content, record_id FROM observations WHERE workspace_id = $1 AND record_id = ANY($2::text[])`,
      [SCOPE.workspaceId, [SCOPE.recordId, restored.recordId]]);
    const observationIds = typedBijection(observationRows.rows.filter((row) => row.record_id === SCOPE.recordId),
      observationRows.rows.filter((row) => row.record_id === restored.recordId), "accepted source observations");
    for (const target of targetConclusions) {
      const source = sourceByTarget.get(target.id)!;
      assert.ok(source);
      assert.equal(target.observer_continuity_id, continuityIds.get(source.observer_continuity_id));
      assert.equal(target.source_observation_id, source.source_observation_id === null ? null : observationIds.get(source.source_observation_id));
      assert.equal(target.supersedes_memory_id, source.supersedes_memory_id === null ? null : conclusionIds.get(source.supersedes_memory_id));
      // 内容逐字节一致：embedding 文本、keywords、游标、fidelity、metadata。
      assert.equal(target.semantic_embedding, source.semantic_embedding);
      assert.deepEqual(target.keywords, source.keywords);
      assert.equal(target.content, source.content);
      assert.equal(target.operation, source.operation);
      assert.equal(target.memory_kind, source.memory_kind);
      assert.equal(target.observed_entity_key, source.observed_entity_key);
      assert.equal(target.embedding_model, source.embedding_model);
      assert.equal(target.fidelity, source.fidelity);
      assert.equal(target.occurred_tick, source.occurred_tick);
      assert.equal(target.occurred_ordinal, source.occurred_ordinal);
      assert.equal(target.available_from_tick, source.available_from_tick);
      assert.equal(target.available_from_ordinal, source.available_from_ordinal);
      assert.deepEqual(target.metadata, source.metadata);
      // 引用全部重映射到 restore 作用域 id，绝不回指 source id。
      assert.match(target.id, /^memory_conclusion_restore_/);
      assert.notEqual(target.id, source.id);
      assert.ok(targetContinuityIds.has(target.observer_continuity_id));
      assert.notEqual(target.observer_continuity_id, source.observer_continuity_id);
      if (source.source_record_id !== null) {
        assert.equal(target.source_record_id, restored.recordId);
        assert.ok(targetObservationIds.has(target.source_observation_id!));
        assert.notEqual(target.source_observation_id, source.source_observation_id);
      } else {
        assert.equal(target.source_record_id, null);
        assert.equal(target.source_observation_id, null);
      }
      if (source.supersedes_memory_id !== null) {
        assert.ok(targetConclusionIds.has(target.supersedes_memory_id!));
        assert.notEqual(target.supersedes_memory_id, source.supersedes_memory_id);
      } else {
        assert.equal(target.supersedes_memory_id, null);
      }
    }

    const targetSnapshots = (await ownerPool.query<SnapshotRow>(
      `SELECT id, observer_continuity_id, snapshot_kind, content, item_ids,
              cursor_tick, cursor_ordinal, cache_epoch, token_count
       FROM memory_snapshots
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetSnapshots.length, 1);
    const targetSnapshot = targetSnapshots[0]!;
    const sourceSnapshot = sourceSnapshots[0]!;
    assert.match(targetSnapshot.id, /^memory_snapshot_restore_/);
    assert.ok(targetContinuityIds.has(targetSnapshot.observer_continuity_id));
    assert.equal(targetSnapshot.snapshot_kind, sourceSnapshot.snapshot_kind);
    assert.equal(targetSnapshot.content, sourceSnapshot.content);
    assert.equal(targetSnapshot.cursor_tick, sourceSnapshot.cursor_tick);
    assert.equal(targetSnapshot.cursor_ordinal, sourceSnapshot.cursor_ordinal);
    assert.equal(targetSnapshot.cache_epoch, sourceSnapshot.cache_epoch);
    assert.equal(targetSnapshot.token_count, sourceSnapshot.token_count);
    // item_ids 在目标作用域内重映射，个数与顺序保持。
    assert.equal(targetSnapshot.item_ids.length, sourceSnapshot.item_ids.length);
    assert.deepEqual(targetSnapshot.item_ids, sourceSnapshot.item_ids.map((id) => conclusionIds.get(id)));
    assert.equal(targetSnapshot.observer_continuity_id, continuityIds.get(sourceSnapshot.observer_continuity_id));
    for (const itemId of targetSnapshot.item_ids) {
      assert.ok(targetConclusionIds.has(itemId));
      assert.match(itemId, /^memory_conclusion_restore_/);
    }

    const targetRelationships = (await ownerPool.query<RelationshipRow>(
      `SELECT observer_continuity_id, target_entity_key, relation_kind,
              content, fidelity::text AS fidelity,
              source_record_id, source_observation_id,
              occurred_tick, occurred_ordinal,
              available_from_tick, available_from_ordinal
       FROM relationship_states
       WHERE workspace_id = $1 AND worldline_id = $2
       ORDER BY observer_continuity_id, target_entity_key, relation_kind`,
      [SCOPE.workspaceId, restored.worldlineId],
    )).rows;
    assert.equal(targetRelationships.length, 2);
    const sourceRelationshipByKey = new Map(
      sourceRelationships.map((row) => [`${row.target_entity_key} ${row.relation_kind}`, row]),
    );
    for (const target of targetRelationships) {
      const source = sourceRelationshipByKey.get(`${target.target_entity_key} ${target.relation_kind}`)!;
      assert.ok(source, "target relationship must pair with a source relationship");
      assert.equal(target.observer_continuity_id, continuityIds.get(source.observer_continuity_id));
      assert.equal(target.source_observation_id, source.source_observation_id === null ? null : observationIds.get(source.source_observation_id));
      assert.equal(target.content, source.content);
      assert.equal(target.fidelity, source.fidelity);
      assert.equal(target.occurred_tick, source.occurred_tick);
      assert.equal(target.occurred_ordinal, source.occurred_ordinal);
      assert.equal(target.available_from_tick, source.available_from_tick);
      assert.equal(target.available_from_ordinal, source.available_from_ordinal);
      assert.ok(targetContinuityIds.has(target.observer_continuity_id));
      assert.notEqual(target.observer_continuity_id, source.observer_continuity_id);
      if (source.source_record_id !== null) {
        assert.equal(target.source_record_id, restored.recordId);
        assert.ok(targetObservationIds.has(target.source_observation_id!));
      } else {
        assert.equal(target.source_record_id, null);
        assert.equal(target.source_observation_id, null);
      }
    }

    // ---- 幂等 replay：同存档同键 → memory 不重复 --------------------------
    const replay = await restorer.restore(restoreInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, restored.recordId);
    assert.equal(replay.importedMemoryConclusionCount, 4);
    assert.equal(replay.importedMemorySnapshotCount, 1);
    assert.equal(replay.importedRelationshipStateCount, 2);
    const afterReplay = await ownerPool.query<{
      conclusions: number;
      snapshots: number;
      relationships: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM memory_conclusions
           WHERE workspace_id = $1 AND worldline_id = $2) AS conclusions,
         (SELECT count(*)::int FROM memory_snapshots
           WHERE workspace_id = $1 AND worldline_id = $2) AS snapshots,
         (SELECT count(*)::int FROM relationship_states
           WHERE workspace_id = $1 AND worldline_id = $2) AS relationships`,
      [SCOPE.workspaceId, restored.worldlineId],
    );
    assert.deepEqual(afterReplay.rows[0], { conclusions: 4, snapshots: 1, relationships: 2 });
    const baseline = await restoreArtifactCounts(ownerPool);

    // ---- 失败场景（全部 fail-closed + 零残留） ---------------------------
    const rebuildArchive = (memorySection: RealmRuntimeSaveMemory): RealmRuntimeSaveArchive => {
      // manifest 由合法原档派生（hash 只覆盖 runtime/ 段；restorer 直接消费
      // 解析后的对象，不重演字节校验）——memory 段在返回对象中被替换为
      // 精心构造的非法引用，驱动 restorer normalize 的 fail-closed 分支；
      // 契约层（build/parse）对同类损坏的拒绝由单测与 F5 覆盖。
      const manifest = realmRuntimeSaveManifestFromData({
        engineApi: archive.manifest.engineApi,
        mode: archive.manifest.mode,
        world: archive.manifest.world,
        scope: archive.manifest.scope,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: archive.memory,
      });
      return {
        manifest,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: memorySection,
      };
    };
    const expectRestoreFailure = async (
      badArchive: RealmRuntimeSaveArchive,
      idempotencyKey: string,
      code: RealmRuntimeSaveRepositoryError["code"],
    ) => {
      await assert.rejects(
        restorer.restore({ ...restoreInput, archive: badArchive, idempotencyKey }),
        (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
          && error.code === code,
      );
      assert.deepEqual(
        await restoreArtifactCounts(ownerPool),
        baseline,
        `${code} 失败路径不得留下任何 restore 残留`,
      );
    };

    // F1：observer continuity 未被恢复（不在存档 topology 内）。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceObserverContinuityId: "continuity_never_restored" }
          : conclusion),
      }),
      "save-mem-bad-continuity",
      "RUNTIME_SAVE_INVALID",
    );

    // F2：source observation 指向未随存档恢复的观察。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceObservationId: "obs_never_restored" }
          : conclusion),
      }),
      "save-mem-bad-observation",
      "RUNTIME_SAVE_INVALID",
    );

    // F3：跨 Record 引用（conclusion 与 relationship state 各一例）。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        conclusions: archive.memory!.conclusions.map((conclusion, index) => index === 0
          ? { ...conclusion, sourceRecordId: "record_elsewhere" }
          : conclusion),
      }),
      "save-mem-cross-record",
      "RUNTIME_SAVE_INVALID",
    );
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        relationshipStates: archive.memory!.relationshipStates.map((state, index) => index === 0
          ? { ...state, sourceRecordId: "record_elsewhere" }
          : state),
      }),
      "save-mem-cross-record-rel",
      "RUNTIME_SAVE_INVALID",
    );

    // F4：snapshot item_ids 指向未恢复结论。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.memory!,
        snapshots: archive.memory!.snapshots.map((snapshot) => ({
          ...snapshot,
          sourceItemIds: [...snapshot.sourceItemIds, "mem_never_restored"],
        })),
      }),
      "save-mem-bad-snapshot-item",
      "RUNTIME_SAVE_INVALID",
    );

    // F5：schema 损坏（memory 段缺必填键，hash 正确重算）→ parse 期 fail-closed。
    const corruptedMemory = Buffer.from(JSON.stringify({
      format: "realm-runtime-memory",
      schemaVersion: 1,
      conclusions: [{ sourceMemoryId: "mem-broken" }],
      snapshots: [],
      relationshipStates: [],
    }));
    const recordEntry = Buffer.from(JSON.stringify(archive.record));
    const goalsEntry = Buffer.from(JSON.stringify(archive.goals));
    const corruptedManifest: RealmRuntimeSaveManifestV2 = {
      ...archive.manifest,
      snapshot: {
        ...archive.manifest.snapshot,
        runtimeHash: computeRealmRuntimeSaveContentHash(new Map([
          ["runtime/record.json", recordEntry],
          ["runtime/goals.json", goalsEntry],
          ["runtime/memory.json", corruptedMemory],
        ])),
      },
    };
    const corruptedBytes = zipSync({
      "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(corruptedManifest)),
      "runtime/record.json": recordEntry,
      "runtime/goals.json": goalsEntry,
      "runtime/memory.json": corruptedMemory,
    });
    assert.throws(
      () => parseRealmRuntimeSaveArchive(corruptedBytes),
      (error: unknown) => error instanceof RealmRuntimeSaveError
        && error.code === "INVALID_SAVE",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "schema 损坏的存档不得触及任何目标表",
    );

    // F6：RLS/workspace boundary——observer、无 membership principal、
    // 跨 workspace 一律 WORLD_NOT_FOUND 且零残留。
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_observer', 'observer')
       ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_save_mem_other', '其它工作台')
       ON CONFLICT (id) DO NOTHING`,
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_observer", idempotencyKey: "save-mem-observer" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_nobody", idempotencyKey: "save-mem-nobody" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, workspaceId: "ws_save_mem_other", idempotencyKey: "save-mem-ws" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "边界失败路径不得留下任何 restore 残留",
    );
  },
);

// ---------------------------------------------------------------------------
// F4a2 cross-Record memory V2 runtime wiring (ported from corrected derivative)
// ---------------------------------------------------------------------------

async function exactLineImage(
  pool: pg.Pool,
  workspaceId: string,
  worldId: string,
  worldlineId: string,
): Promise<Record<string, unknown>> {
  const tables = [
    "worldlines", "stories", "records", "record_heads", "character_instances", "character_continuities",
    "participants", "scenes", "visibility_policies", "events", "observations",
    "memory_conclusions", "memory_snapshots", "relationship_states",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const keyColumn = table === "worldlines" ? "id" : "worldline_id";
    const { rows } = await pool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
       FROM ${table} t WHERE workspace_id = $1 AND world_id = $2 AND ${keyColumn} = $3`,
      [workspaceId, worldId, worldlineId],
    );
    result[table] = rows[0]!.rows;
  }
  result.character_definitions = (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb) AS rows FROM character_definitions d
     WHERE d.workspace_id = $1 AND d.world_id = $2 AND d.id IN
       (SELECT definition_id FROM character_continuities WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3)`,
    [workspaceId, worldId, worldlineId])).rows[0]!.rows;
  result.memory_cache_epochs = (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text), '[]'::jsonb) AS rows
     FROM memory_cache_epochs e
     JOIN character_continuities c ON c.workspace_id = e.workspace_id AND c.id = e.observer_continuity_id
     WHERE e.workspace_id = $1 AND c.world_id = $2 AND c.worldline_id = $3`,
    [workspaceId, worldId, worldlineId],
  )).rows[0]!.rows;
  return result;
}

async function exactWorldImage(pool: pg.Pool, workspaceId: string, worldId: string): Promise<SqlImage> {
  const tables = (await pool.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     GROUP BY c.table_name HAVING bool_or(c.column_name = 'workspace_id')
       AND (bool_or(c.column_name = 'world_id') OR c.table_name = 'worlds') ORDER BY c.table_name`)).rows;
  const image: SqlImage = {};
  for (const { table_name: table } of tables) image[table] = (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
     FROM ${quoteIdentifier(table)} t WHERE workspace_id = $1 AND ${table === "worlds" ? "id" : "world_id"} = $2`,
    [workspaceId, worldId])).rows[0]!.rows;
  image.memory_cache_epochs = (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text), '[]'::jsonb) AS rows
     FROM memory_cache_epochs e JOIN character_continuities c ON c.workspace_id = e.workspace_id AND c.id = e.observer_continuity_id
     WHERE c.workspace_id = $1 AND c.world_id = $2`, [workspaceId, worldId])).rows[0]!.rows;
  return image;
}

async function sharedAuthorityImage(
  pool: pg.Pool,
  workspaceId: string,
  worldId: string,
  definitionIds: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  result.character_definitions = (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb) AS rows FROM character_definitions d
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`, [workspaceId, worldId, definitionIds])).rows[0]!.rows;
  for (const table of ["worlds", "player_world_memberships"]) {
    const keyColumn = table === "worlds" ? "id" : "world_id";
    const { rows } = await pool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
       FROM ${table} t WHERE workspace_id = $1 AND ${keyColumn} = $2`,
      [workspaceId, worldId],
    );
    result[table] = rows[0]!.rows;
  }
  return result;
}

type SqlRow = Record<string, unknown>;
type SqlImage = Record<string, unknown>;

function imageRows(image: SqlImage, table: string): SqlRow[] {
  const value = image[table];
  assert.ok(Array.isArray(value), `SQL image includes ${table}`);
  return value as SqlRow[];
}

function onlyRow(rows: SqlRow[], predicate: (row: SqlRow) => boolean, label: string): SqlRow {
  const matches = rows.filter(predicate);
  assert.equal(matches.length, 1, `unambiguous independent SQL match: ${label}`);
  return matches[0]!;
}

function assertColumns(row: SqlRow, expected: SqlRow): void {
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, row[key]])), expected);
}

// The fixture's content keys are deliberately unique. These maps are discovered
// from ordinary SQL values/owners, never from restore's ID derivation algorithm.
function typedBijection<T extends { id: string; content: string }>(source: readonly T[], target: readonly T[], label: string) {
  assert.equal(target.length, source.length, `${label} complete set`);
  const keys = new Set(source.map((row) => row.content));
  assert.equal(keys.size, source.length, `${label} source key is unique`);
  const map = new Map<string, string>();
  for (const row of source) {
    const matches = target.filter((candidate) => candidate.content === row.content);
    assert.equal(matches.length, 1, `${label} target key is unique`);
    assert.notEqual(matches[0]!.id, row.id, `${label} fresh typed identity`);
    map.set(row.id, matches[0]!.id);
  }
  assert.equal(new Set(map.values()).size, source.length, `${label} injective`);
  return map;
}

function assertTransportedArchive(archive: RealmRuntimeSaveArchive, image: SqlImage,
  target: { workspaceId: string; worldId: string; worldlineId: string; recordId: string; storyId: string }, fresh = true) {
  const maps: Record<string, Map<string, string>> = Object.fromEntries(
    ["record", "story", "event", "scene", "policy", "participant", "instance", "continuity", "definition", "observation", "conclusion", "snapshot"].map((kind) => [kind, new Map<string, string>()]));
  const bind = (kind: string, source: string, dest: unknown) => {
    assert.equal(typeof dest, "string", `${kind} SQL id`);
    const id = dest as string, map = maps[kind]!;
    if (map.has(source)) { assert.equal(map.get(source), id); return id; }
    if (fresh) assert.notEqual(source, id, `${kind} fresh identity`);
    else assert.equal(source, id, `${kind} resaved SQL identity`);
    assert.ok(![...map.values()].includes(id), `${kind} bijection`);
    map.set(source, id); return id;
  };
  const mapped = (kind: string, source: string | null): string | null => {
    if (source === null) return null;
    const dest = maps[kind]!.get(source); assert.ok(dest, `mapped ${kind}/${source}`); return dest;
  };
  const rows = (table: string) => imageRows(image, table);
  const rowById = (table: string, id: unknown) => onlyRow(rows(table), (row) => row.id === id, `${table}/${String(id)}`);
  for (const table of ["records", "stories", "events", "observations", "character_instances", "character_continuities", "scenes", "visibility_policies", "participants", "memory_conclusions", "memory_snapshots", "relationship_states"]) {
    for (const row of rows(table)) assertColumns(row, { workspace_id: target.workspaceId, world_id: target.worldId, worldline_id: target.worldlineId });
  }
  bind("record", archive.record.scope.recordId, target.recordId);
  if (archive.domain) bind("story", archive.domain.source.storyId, target.storyId);
  for (const entry of archive.domain?.stories ?? []) {
    if (maps.story!.has(entry.id)) continue;
    const row = onlyRow(rows("stories"), (row) => row.title === entry.title && row.premise === entry.premise, "Story metadata");
    bind("story", entry.id, row.id);
  }
  for (const entry of archive.domain?.records ?? []) {
    const row = onlyRow(rows("records"), (row) => row.title === entry.title && row.story_id === mapped("story", entry.storyId), "sibling Record metadata");
    bind("record", entry.recordId, row.id);
    assertColumns(row, { title: entry.title, status: entry.status, world_version: entry.worldVersion,
      start_tick: entry.startTick, start_ordinal: entry.startOrdinal, timeline_kind: entry.timelineKind });
  }
  const bundles = [{ record: archive.record, topology: archive.topology, observations: archive.observations },
    ...(archive.domain?.records ?? []).map((entry) => entry.bundle)];
  for (const bundle of bundles) {
    const recordId = mapped("record", bundle.record.scope.recordId);
    for (const participant of bundle.topology?.participants ?? []) {
      const character = participant.character;
      if (!character) continue;
      const continuity = onlyRow(rows("character_continuities"), (row) => row.continuity_key === character.continuity.continuityKey, "continuity key");
      bind("continuity", character.sourceContinuityId, continuity.id);
      bind("definition", character.sourceDefinitionId, continuity.definition_id);
      assertColumns(continuity, { status: character.continuity.status, born_tick: character.continuity.bornTick,
        born_ordinal: character.continuity.bornOrdinal, ended_tick: character.continuity.endedTick, ended_ordinal: character.continuity.endedOrdinal });
      assertColumns(rowById("character_definitions", continuity.definition_id), { display_name: character.definition.displayName,
        source_format: character.definition.sourceFormat, profile: character.definition.profile });
      const instance = onlyRow(rows("character_instances"), (row) => row.record_id === recordId && row.continuity_id === continuity.id, "Record/continuity instance");
      bind("instance", character.sourceCharacterInstanceId, instance.id);
      assertColumns(instance, { controller_mode: character.instance.controllerMode, status: character.instance.status,
        instantiated_tick: character.instance.instantiatedTick, instantiated_ordinal: character.instance.instantiatedOrdinal,
        inheritance_cutoff_tick: character.instance.inheritanceCutoffTick, inheritance_cutoff_ordinal: character.instance.inheritanceCutoffOrdinal,
        retired_tick: character.instance.retiredTick, retired_ordinal: character.instance.retiredOrdinal, state: character.instance.state });
    }
    for (const scene of bundle.topology?.scenes ?? []) {
      const row = onlyRow(rows("scenes"), (row) => row.record_id === recordId && row.title === scene.title, "scene owner/title");
      bind("scene", scene.sourceSceneId, row.id);
      assertColumns(row, { title: scene.title, status: scene.status, location: scene.location, objective: scene.objective,
        tension: scene.tension, weather: scene.weather, display_time: scene.displayTime, start_tick: scene.startTick,
        start_ordinal: scene.startOrdinal, end_tick: scene.endTick, end_ordinal: scene.endOrdinal });
    }
    for (const policy of bundle.topology?.visibilityPolicies ?? []) {
      const row = onlyRow(rows("visibility_policies"), (row) => row.record_id === recordId && row.policy_key === policy.policyKey, "policy owner/key");
      bind("policy", policy.sourceVisibilityPolicyId, row.id);
    }
    for (const participant of bundle.topology?.participants ?? []) {
      const row = onlyRow(rows("participants"), (row) => row.record_id === recordId && row.participant_kind === participant.participantKind
        && row.speaking_order === participant.speakingOrder, "participant owner/kind/order");
      bind("participant", participant.sourceParticipantId, row.id);
      assertColumns(row, { participant_kind: participant.participantKind, character_instance_id: participant.character
        ? mapped("instance", participant.character.sourceCharacterInstanceId) : null, principal_id: participant.sourcePrincipalId,
        controller_mode: participant.controllerMode, is_active: participant.isActive, speaking_order: participant.speakingOrder,
        shared_control_enabled: participant.sharedControlEnabled });
    }
    for (const event of bundle.record.events) {
      const value = normalizeRealmRuntimeSaveEventForRestore(event, 0);
      const row = onlyRow(rows("events"), (row) => row.record_id === recordId && row.record_ordinal === value.ordinal, "event owner/ordinal");
      bind("event", value.eventId, row.id);
    }
    for (const observation of bundle.observations?.observations ?? []) {
      const row = onlyRow(rows("observations"), (row) => row.record_id === recordId && row.content === observation.content, "observation owner/content");
      bind("observation", observation.sourceObservationId, row.id);
    }
  }
  // All typed maps exist before any cross-Record references are checked.
  for (const bundle of bundles) {
    const recordId = mapped("record", bundle.record.scope.recordId);
    const head = onlyRow(rows("record_heads"), (row) => row.record_id === recordId, "Record head");
    assertColumns(head, { record_version: bundle.record.head.recordVersion, next_record_ordinal: bundle.record.head.nextRecordOrdinal,
      last_event_id: mapped("event", bundle.record.events.at(-1)?.eventId ?? null) });
    for (const participant of bundle.topology?.participants ?? []) {
      if (participant.character) assertColumns(rowById("character_instances", mapped("instance", participant.character.sourceCharacterInstanceId)),
        { predecessor_instance_id: mapped("instance", participant.character.sourcePredecessorInstanceId) });
    }
    for (const policy of bundle.topology?.visibilityPolicies ?? []) assertColumns(rowById("visibility_policies", mapped("policy", policy.sourceVisibilityPolicyId)), {
      policy_key: policy.policyKey, policy_version: policy.policyVersion, policy_kind: policy.policyKind,
      scene_id: mapped("scene", policy.sourceSceneId), restricted_domain_id: policy.restrictedDomainId,
      private_character_instance_id: mapped("instance", policy.sourcePrivateCharacterInstanceId),
      audience_character_instance_ids: policy.sourceAudienceCharacterInstanceIds.map((id) => mapped("instance", id)) });
    for (const event of bundle.record.events) {
      const value = normalizeRealmRuntimeSaveEventForRestore(event, 0);
      assertColumns(rowById("events", mapped("event", value.eventId)), { record_id: recordId,
        scene_id: mapped("scene", value.sourceSceneId), visibility_policy_id: mapped("policy", value.sourceVisibilityPolicyId),
        actor_participant_id: mapped("participant", value.sourceActorParticipantId), record_version: value.recordVersion,
        record_ordinal: value.ordinal, event_kind: value.kind, speaker_name: value.speakerName, content: value.content,
        payload: value.eventPayload, world_tick: value.worldTick, world_ordinal: value.worldOrdinal,
        calendar_id: value.calendarId, display_time: value.displayTime });
    }
    for (const observation of bundle.observations?.observations ?? []) {
      const row = rowById("observations", mapped("observation", observation.sourceObservationId));
      assertColumns(row, { record_id: recordId, observer_character_instance_id: mapped("instance", observation.sourceObserverCharacterInstanceId),
        source_event_id: mapped("event", observation.sourceEventId), dedupe_key: observation.dedupeKey,
        observation_kind: observation.observationKind, content: observation.content, fidelity: observation.fidelity,
        occurred_tick: observation.occurredTick, occurred_ordinal: observation.occurredOrdinal,
        available_from_tick: observation.availableFromTick, available_from_ordinal: observation.availableFromOrdinal,
        metadata: observation.metadata });
      assert.equal(new Date(String(row.learned_at)).toISOString(), observation.learnedAt, "exact transported canonical learnedAt");
    }
  }
  for (const entry of archive.domain?.records ?? []) {
    const recordId = mapped("record", entry.recordId);
    assertColumns(rowById("records", recordId), { story_id: mapped("story", entry.storyId), linked_record_id: mapped("record", entry.linkedRecordId) });
    assertColumns(onlyRow(rows("record_heads"), (row) => row.record_id === recordId, "sibling head metadata"),
      { last_world_tick: entry.lastWorldTick, last_world_ordinal: entry.lastWorldOrdinal });
    const story = archive.domain!.stories.find((row) => row.id === entry.storyId)!;
    if (entry.storyId !== archive.domain!.source.storyId) assertColumns(rowById("stories", mapped("story", story.id)),
      { title: story.title, status: story.status, premise: story.premise });
  }
  const extraParticipants = rows("participants").filter((row) => ![...maps.participant!.values()].includes(String(row.id)));
  for (const bundle of bundles) {
    const expectedExtra = (bundle.topology?.participants ?? []).some((row) => row.participantKind === "narrator") ? 0 : 1;
    const extras = extraParticipants.filter((row) => row.record_id === mapped("record", bundle.record.scope.recordId));
    assert.equal(extras.length, expectedExtra, "only explicit narrator scaffolding may be added");
    if (extras[0]) assertColumns(extras[0], { participant_kind: "narrator", character_instance_id: null, principal_id: null,
      controller_mode: "ai", is_active: true, shared_control_enabled: false,
      speaking_order: (bundle.topology?.participants ?? []).reduce((max, row) => Math.max(max, row.speakingOrder), -1) + 1 });
  }
  const memory = archive.memory;
  assert.ok(memory && memory.schemaVersion === 2);
  for (const conclusion of memory.conclusions) bind("conclusion", conclusion.sourceMemoryId,
    onlyRow(rows("memory_conclusions"), (row) => row.content === conclusion.content, "unique conclusion content").id);
  assert.equal(rows("memory_conclusions").length, memory.conclusions.length);
  for (const conclusion of memory.conclusions) {
    const row = rowById("memory_conclusions", mapped("conclusion", conclusion.sourceMemoryId));
    assertColumns(row, { observer_continuity_id: mapped("continuity", conclusion.sourceObserverContinuityId),
      observed_entity_key: conclusion.observedEntityKey, source_record_id: mapped("record", conclusion.sourceRecordId),
      source_observation_id: mapped("observation", conclusion.sourceObservationId), supersedes_memory_id: mapped("conclusion", conclusion.sourceSupersedesMemoryId),
      operation: conclusion.operation, memory_kind: conclusion.memoryKind, content: conclusion.content, keywords: conclusion.keywords,
      embedding_model: conclusion.embeddingModel, fidelity: conclusion.fidelity, occurred_tick: conclusion.occurredTick,
      occurred_ordinal: conclusion.occurredOrdinal, available_from_tick: conclusion.availableFromTick,
      available_from_ordinal: conclusion.availableFromOrdinal, metadata: conclusion.metadata });
    assert.deepEqual(JSON.parse(String(row.semantic_embedding)), conclusion.semanticEmbedding, "exact vector values");
  }
  assert.equal(rows("memory_snapshots").length, memory.snapshots.length);
  for (const snapshot of memory.snapshots) {
    const row = onlyRow(rows("memory_snapshots"), (row) => row.snapshot_kind === snapshot.snapshotKind && row.content === snapshot.content, "snapshot kind/content");
    bind("snapshot", snapshot.sourceSnapshotId, row.id);
    assertColumns(row, { observer_continuity_id: mapped("continuity", snapshot.sourceObserverContinuityId), snapshot_kind: snapshot.snapshotKind,
      content: snapshot.content, item_ids: snapshot.sourceItemIds.map((id) => mapped("conclusion", id)), cursor_tick: snapshot.cursorTick,
      cursor_ordinal: snapshot.cursorOrdinal, cache_epoch: snapshot.cacheEpoch, token_count: snapshot.tokenCount });
  }
  assert.equal(rows("relationship_states").length, memory.relationshipStates.length);
  for (const state of memory.relationshipStates) {
    const row = onlyRow(rows("relationship_states"), (row) => row.observer_continuity_id === mapped("continuity", state.sourceObserverContinuityId)
      && row.target_entity_key === state.targetEntityKey && row.relation_kind === state.relationKind, "relationship typed key");
    assertColumns(row, { content: state.content, fidelity: state.fidelity, source_record_id: mapped("record", state.sourceRecordId),
      source_observation_id: mapped("observation", state.sourceObservationId), occurred_tick: state.occurredTick,
      occurred_ordinal: state.occurredOrdinal, available_from_tick: state.availableFromTick, available_from_ordinal: state.availableFromOrdinal });
  }
  assert.deepEqual(rows("memory_cache_epochs").map((row) => [row.observer_continuity_id, row.epoch]).sort(),
    memory.cacheEpochs.map((row) => [mapped("continuity", row.sourceObserverContinuityId), row.epoch]).sort());
  assertColumns(rowById("worldlines", target.worldlineId), { head_tick: memory.worldlineHead.tick, head_ordinal: memory.worldlineHead.ordinal });
  for (const [kind, map] of Object.entries(maps)) {
    const table = ({ record: "records", story: "stories", event: "events", scene: "scenes", policy: "visibility_policies", participant: "participants",
      instance: "character_instances", continuity: "character_continuities", definition: "character_definitions", observation: "observations", conclusion: "memory_conclusions", snapshot: "memory_snapshots" } as Record<string, string>)[kind]!;
    if (kind !== "participant") assert.equal(rows(table).length, map.size, `${kind} complete target set`);
  }
  return Object.fromEntries(Object.entries(maps).map(([kind, map]) => [kind, Object.fromEntries(map)]));
}

async function saveRuntimeEvidence(label: string, data: unknown): Promise<void> {
  const directory = process.env.REALM_R1_EVIDENCE_DIR;
  if (directory) await writeFile(join(directory, `${label}-${process.pid}-${randomUUID()}.json`), JSON.stringify(data, null, 2));
}

// TEST ONLY: malformed archives must be hash-correct so semantic gates,
// rather than incidental byte/hash failures, prove rejection.
function forgeArchive(archive: RealmRuntimeSaveArchive, extraEntries: Record<string, unknown> = {}) {
  const sections: [string, unknown][] = [["record", archive.record], ["goals", archive.goals],
    ["topology", archive.topology], ["action-receipts", archive.actionReceipts], ["character-effects", archive.characterEffects],
    ["observations", archive.observations], ["memory", archive.memory], ["outbox", archive.outbox],
    ["first-night", archive.firstNight], ["self-play", archive.selfPlay], ["domain", archive.domain]];
  const files = new Map<string, Uint8Array>(sections.filter(([, value]) => value !== undefined)
    .map(([name, value]) => [`runtime/${name}.json`, Buffer.from(JSON.stringify(value))]));
  for (const [path, value] of Object.entries(extraEntries)) files.set(path, Buffer.from(JSON.stringify(value)));
  const manifest = { ...archive.manifest, snapshot: { ...archive.manifest.snapshot, runtimeHash: computeRealmRuntimeSaveContentHash(files) } };
  return { archive: { ...archive, manifest }, bytes: zipSync({ "realm-save-manifest.json": Buffer.from(JSON.stringify(manifest)), ...Object.fromEntries(files) },
    { mtime: new Date(1980, 0, 1) }) };
}

async function assertRuntimeInvalid(owner: pg.Pool, restorer: ReturnType<typeof createPostgresRealmRuntimeSaveRestorer>,
  input: { workspaceId: string; worldId: string; principalId: string }, bad: RealmRuntimeSaveArchive, label: string, message?: string) {
  const before = await exactWorldImage(owner, input.workspaceId, input.worldId);
  const forged = forgeArchive(bad);
  const invalid = (error: unknown) => ((error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE")
    || error instanceof RealmRuntimeSaveDomainError) && (message === undefined || error.message === message);
  assert.throws(() => realmRuntimeSaveManifestFromData({ ...bad, ...bad.manifest }), invalid, `${label}: manifest`);
  assert.throws(() => buildRealmRuntimeSaveArchive(forged.archive), invalid, `${label}: builder`);
  assert.throws(() => parseRealmRuntimeSaveArchive(forged.bytes), invalid, `${label}: hash-correct parser`);
  await assert.rejects(restorer.restore({ workspaceId: input.workspaceId, principalId: input.principalId,
    targetWorldId: input.worldId, archive: forged.archive, idempotencyKey: `r1-negative-${label}` }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError && error.code === "RUNTIME_SAVE_INVALID"
      && (message === undefined || error.message === message), `${label}: direct restore`);
  const after = await exactWorldImage(owner, input.workspaceId, input.worldId);
  assert.deepEqual(after, before, `${label}: all World rows unchanged`);
  await saveRuntimeEvidence(`negative-${label}`, { before, after, message: message ?? "INVALID_SAVE", input: forged.archive });
}

async function exerciseR1Boundaries(owner: pg.Pool, runtime: pg.Pool, archive: RealmRuntimeSaveArchive,
  scope: { workspaceId: string; worldId: string; principalId: string }) {
  assert.ok(archive.memory?.schemaVersion === 2);
  const primary = archive.record.scope.recordId, peer = archive.domain!.records[0]!.recordId;
  const main = archive.memory.snapshots[0]!.sourceObserverContinuityId;
  const other = archive.memory.cacheEpochs.find((row) => row.sourceObserverContinuityId !== main)!.sourceObserverContinuityId;
  const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const cases: [string, (bad: RealmRuntimeSaveArchive) => void, string?][] = [
    ["known-epoch", (bad) => { if (bad.memory?.schemaVersion === 2) bad.memory.cacheEpochs = bad.memory.cacheEpochs.map((row) => ({ ...row, epoch: 0 })); }, "Memory cache epoch precedes a retained snapshot."],
    ["source-scope", (bad) => { if (bad.memory?.schemaVersion === 2) bad.memory.scope.worldId = "wrong-world"; }, "Memory source scope does not match the archive."],
    ["existing-wrong-record-owner", (bad) => { bad.memory!.conclusions = bad.memory!.conclusions.map((row) => ({ ...row, sourceRecordId: row.sourceRecordId === primary ? peer : primary })); }, "Memory source observation ownership does not match."],
    ["behavior-relationship-existing-wrong-record", (bad) => { bad.memory!.relationshipStates = bad.memory!.relationshipStates.map(row => row.sourceObservationId === null ? row : { ...row, sourceRecordId: row.sourceRecordId === primary ? peer : primary }); }, "Memory source observation ownership does not match."],
    ["behavior-relationship-existing-wrong-observer", (bad) => { bad.memory!.relationshipStates = bad.memory!.relationshipStates.map(row => row.sourceObservationId === null ? row : { ...row, sourceObserverContinuityId: other }); }, "Memory source observation ownership does not match."],
    ["existing-wrong-observer", (bad) => { bad.memory!.snapshots = bad.memory!.snapshots.map((row) => ({ ...row, sourceObserverContinuityId: other })); }, "Memory snapshot item observer does not match."],
    ["malformed-memory-array", (bad) => { Object.assign(bad.memory!, { conclusions: {} }); }],
    ["malformed-domain-array", (bad) => { Object.assign(bad.domain!, { records: {} }); }],
    ["unsupported-memory-version", (bad) => { Object.assign(bad.memory!, { schemaVersion: 3 }); }],
    ["unknown-memory-field", (bad) => { Object.assign(bad.memory!, { invented: [] }); }],
    ["duplicate-canonical-memory", (bad) => { bad.memory!.conclusions = [...bad.memory!.conclusions, bad.memory!.conclusions[0]!]; }],
    ["mixed-format", (bad) => { bad.domain!.records[0]!.bundle.memory = { format: "realm-runtime-memory", schemaVersion: 1, conclusions: [], snapshots: [], relationshipStates: [] }; }],
    ["pre-memory-owner", (bad) => { delete bad.memory; bad.observations!.observations = bad.observations!.observations.map((row) => ({ ...row, sourceEventId: "missing-event" })); }, "Memory observation source event is not carried."],
  ];
  for (const [label, change, message] of cases) {
    const bad = structuredClone(archive); change(bad);
    await assertRuntimeInvalid(owner, restorer, scope, bad, label, message);
  }
  for (const value of [[], { invalid: true }]) {
    const forged = forgeArchive(archive, { "runtime/siblings.json": value });
    assert.throws(() => parseRealmRuntimeSaveArchive(forged.bytes), (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE");
    const bad = { ...archive, siblings: value };
    const before = await exactWorldImage(owner, scope.workspaceId, scope.worldId);
    assert.throws(() => realmRuntimeSaveManifestFromData({ ...bad, ...bad.manifest }), { code: "INVALID_SAVE", message: "unknown save key archive.siblings" });
    assert.throws(() => buildRealmRuntimeSaveArchive(bad), { code: "INVALID_SAVE", message: "unknown save key archive.siblings" });
    await assert.rejects(restorer.restore({ workspaceId: scope.workspaceId, principalId: scope.principalId,
      targetWorldId: scope.worldId, archive: bad, idempotencyKey: "removed-root" }), { code: "RUNTIME_SAVE_INVALID", message: "unknown save key archive.siblings" });
    assert.deepEqual(await exactWorldImage(owner, scope.workspaceId, scope.worldId), before);
  }

  // Deliberate legacy boundaries: identical cross-document shared rows collapse
  // once; contradictory copies and checked max+1 exhaustion fail before writes.
  const legacy = structuredClone(archive);
  const document = { format: "realm-runtime-memory" as const, schemaVersion: 1 as const,
    conclusions: archive.memory.conclusions.map((row) => ({ ...row, sourceRecordId: null, sourceObservationId: null })),
    snapshots: structuredClone(archive.memory.snapshots), relationshipStates: [] };
  legacy.memory = document;
  legacy.domain!.records[0]!.bundle.memory = structuredClone(document);
  legacy.manifest = realmRuntimeSaveManifestFromData({ ...legacy, ...legacy.manifest });
  const legacyBytes = buildRealmRuntimeSaveArchive(legacy);
  const beforeSource = await exactLineImage(owner, scope.workspaceId, scope.worldId, archive.record.scope.worldlineId);
  const imported = await restorer.restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, archive: parseRealmRuntimeSaveArchive(legacyBytes),
    targetWorldId: scope.worldId, idempotencyKey: "r1-identical-legacy" });
  const target = await exactLineImage(owner, scope.workspaceId, scope.worldId, imported.worldlineId);
  assert.equal(imageRows(target, "memory_conclusions").length, document.conclusions.length);
  assert.equal(imageRows(target, "memory_snapshots").length, document.snapshots.length);
  const targetMain = onlyRow(imageRows(target, "character_continuities"), (row) => row.continuity_key ===
    onlyRow(imageRows(beforeSource, "character_continuities"), (row) => row.id === main, "source continuity").continuity_key, "legacy target continuity");
  assert.equal(onlyRow(imageRows(target, "memory_cache_epochs"), (row) => row.observer_continuity_id === targetMain.id, "legacy epoch").epoch, 8);
  const legacyMap = new Map(document.conclusions.map((row) => [row.sourceMemoryId,
    onlyRow(imageRows(target, "memory_conclusions"), (candidate) => candidate.content === row.content, "legacy content").id]));
  assert.deepEqual(imageRows(target, "memory_snapshots")[0]!.item_ids, document.snapshots[0]!.sourceItemIds.map((id) => legacyMap.get(id)));
  assert.deepEqual(await exactLineImage(owner, scope.workspaceId, scope.worldId, archive.record.scope.worldlineId), beforeSource);
  const contradictory = structuredClone(legacy);
  contradictory.domain!.records[0]!.bundle.memory!.conclusions = contradictory.domain!.records[0]!.bundle.memory!.conclusions.map((row, index) => index === 0 ? { ...row, content: "contradictory legacy value" } : row);
  await assertRuntimeInvalid(owner, restorer, scope, contradictory, "contradictory-legacy", "Legacy memory representations conflict.");
  const exhausted = structuredClone(legacy);
  for (const memory of [exhausted.memory!, exhausted.domain!.records[0]!.bundle.memory!]) memory.snapshots = memory.snapshots.map((row) => ({ ...row, cacheEpoch: 2147483647 }));
  await assertRuntimeInvalid(owner, restorer, scope, exhausted, "exhausted-legacy", "Legacy memory cache epoch is exhausted.");
  const wrongItem = structuredClone(legacy); delete wrongItem.domain!.records[0]!.bundle.memory;
  wrongItem.memory!.conclusions = [...wrongItem.memory!.conclusions, { ...document.conclusions[0]!, sourceMemoryId: "legacy-other-observer", sourceSupersedesMemoryId: null,
    operation: "add", sourceObserverContinuityId: other }];
  wrongItem.memory!.snapshots = wrongItem.memory!.snapshots.map((row) => ({ ...row, sourceItemIds: ["legacy-other-observer"] }));
  await assertRuntimeInvalid(owner, restorer, scope, wrongItem, "wrong-observer-legacy", "Memory snapshot item observer does not match.");
  await saveRuntimeEvidence("legacy-global", { legacy, imported, beforeSource, target, legacyMap: Object.fromEntries(legacyMap) });

  // A corrupt current source epoch also keeps the repository error surface.
  // Fixture writes lie outside the exact failed-export equality window.
  const sourceEpoch = await owner.query(`SELECT epoch FROM memory_cache_epochs WHERE workspace_id=$1 AND observer_continuity_id=$2`, [scope.workspaceId, main]);
  await owner.query(`UPDATE memory_cache_epochs SET epoch=0 WHERE workspace_id=$1 AND observer_continuity_id=$2`, [scope.workspaceId, main]);
  try {
    const corruptBefore = await exactWorldImage(owner, scope.workspaceId, scope.worldId);
    await assert.rejects(createPostgresRealmRuntimeSaveReader(runtime).load({ workspaceId: scope.workspaceId, recordId: archive.record.scope.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }),
      { code: "RUNTIME_SAVE_INVALID", message: "Memory cache epoch precedes a retained snapshot." });
    assert.deepEqual(await exactWorldImage(owner, scope.workspaceId, scope.worldId), corruptBefore);
  } finally {
    await owner.query(`UPDATE memory_cache_epochs SET epoch=$3 WHERE workspace_id=$1 AND observer_continuity_id=$2`, [scope.workspaceId, main, sourceEpoch.rows[0]!.epoch]);
  }

  // An awaited package preflight cannot reopen ownership of caller data.
  const caller = structuredClone(archive);
  caller.manifest = realmRuntimeSaveManifestFromData({ ...caller, ...caller.manifest, mode: "world-bound",
    world: { worldId: scope.worldId, worldVersion: "0.0.0-local" } });
  const validated = structuredClone(caller);
  let announce!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const detachedRestorer = createPostgresRealmRuntimeSaveRestorer(runtime, { validateWorldBinding: async () => { announce(); await barrier; } });
  const pending = detachedRestorer.restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, archive: caller,
    targetWorldId: scope.worldId, idempotencyKey: "r1-detached-await" });
  await Promise.race([entered, pending.then(() => { throw new Error("restore bypassed package barrier"); })]);
  caller.memory!.conclusions = []; caller.observations!.observations = [];
  caller.domain!.records = []; caller.manifest.scope.recordId = "mutated-caller";
  release();
  const detached = await pending;
  const detachedImage = await exactLineImage(owner, scope.workspaceId, scope.worldId, detached.worldlineId);
  const maps = assertTransportedArchive(validated, detachedImage, { ...scope, worldlineId: detached.worldlineId, recordId: detached.recordId, storyId: detached.storyId });
  await saveRuntimeEvidence("detached-preflight", { validated, detached, detachedImage, maps });
}

test(
  "R1 complete memory closure across both primaries and creation orders, global references and no-write boundaries",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    for (const definitionMode of ["shared", "distinct", "identical"] as const) {
    for (const reverse of [false, true]) {
    const { ownerPool, runtimePool } = await createTempDatabase(t);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const prefix = `f4a2_cross_${definitionMode}_${reverse ? "reverse" : "forward"}_${suffix}`;
    const workspaceId = POSTGRES_DEMO_IDS.workspace;
    const principalId = POSTGRES_DEMO_IDS.principal;
    const worldId = `world_${prefix}`;
    const line = `line_${prefix}`;
    const continuity = `continuity_${prefix}`;
    const definition = `definition_${prefix}`;
    const records = {
      a: `record_${prefix}_a`,
      b: `record_${prefix}_b`,
    };

    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
       VALUES ($1, $2, 'F4a2 cross-record source', 'active', 'native_calendar', '{}'::jsonb)`,
      [workspaceId, worldId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'Cross line', 'active', 0, 10)`,
      [workspaceId, worldId, line],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [workspaceId, worldId, principalId],
    );
    await ownerPool.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
       VALUES ($1, $2, $3, 'Shared observer')`,
      [workspaceId, worldId, definition],
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal)
       VALUES ($1, $2, $3, $4, $5, $5, 0, 0)`,
      [workspaceId, worldId, line, definition, continuity],
    );

    await ownerPool.query(`UPDATE character_definitions SET source_format='sillytavern_character_card',profile=$3::jsonb
      WHERE workspace_id=$1 AND id=$2`,[workspaceId,definition,JSON.stringify({ biography:"Shared definition 港",literalId:definition,
        traits:["precise","precise"],nested:{a:1,b:true} })]);
    const story = {
      a: `story_${prefix}_a`,
      b: `story_${prefix}_b`,
    };
    const instance = {
      a: `instance_${prefix}_a`,
      b: `instance_${prefix}_b`,
    };
    const participant = {
      a: `participant_${prefix}_a`,
      b: `participant_${prefix}_b`,
    };
    const scene = {
      a: `scene_${prefix}_a`,
      b: `scene_${prefix}_b`,
    };
    const visibilityPolicy = {
      a: `visibility_${prefix}_a`,
      b: `visibility_${prefix}_b`,
    };
    const event = {
      a: `event_${prefix}_a`,
      b: `event_${prefix}_b`,
    };

    for (const [index, key] of (reverse ? ["b", "a"] as const : ["a", "b"] as const).entries()) {
      await ownerPool.query(
        `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
         VALUES ($1, $2, $3, $4, $4, 'active', 'Cross-Record memory', 0, 0)`,
        [workspaceId, worldId, line, story[key]],
      );
      await ownerPool.query(
        `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind, world_version)
         VALUES ($1, $2, $3, $4, $5, $5, 'active', 0, 0, 'primary', '0.0.0-local')`,
        [workspaceId, worldId, line, story[key], records[key]],
      );
      await ownerPool.query(
        `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
         VALUES ($1, $2, $3, $4, $5, 'Cross scene', 'active', 0, 0)`,
        [workspaceId, worldId, line, records[key], scene[key]],
      );
      await ownerPool.query(
        `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
         VALUES ($1, $2, $3, $4, $5, $5, 1, 'public')`,
        [workspaceId, worldId, line, records[key], visibilityPolicy[key]],
      );
      await ownerPool.query(
        `INSERT INTO events (workspace_id, world_id, worldline_id, record_id, scene_id, id, record_version, record_ordinal, batch_index, event_kind, actor_participant_id, speaker_name, content, visibility_policy_id, world_tick, world_ordinal, calendar_id)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed', NULL, 'Narrator', 'Cross-record anchor event.', $7, 0, $8, 'native_calendar')`,
        [workspaceId, worldId, line, records[key], scene[key], event[key], visibilityPolicy[key], index + 1],
      );
      await ownerPool.query(
        `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal)
         VALUES ($1, $2, $3, $4, 1, 2, $5, 0, 0)`,
        [workspaceId, worldId, line, records[key], event[key]],
      );
      await ownerPool.query(
        `INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, status, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'human', 'present', 0, 0, 0, 0, '{}'::jsonb)`,
        [workspaceId, worldId, line, records[key], continuity, instance[key]],
      );
      await ownerPool.query(
        `INSERT INTO participants (workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, speaking_order)
         VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, 'human', 0)`,
        [workspaceId, worldId, line, records[key], participant[key], instance[key], principalId],
      );
      await ownerPool.query(
        `INSERT INTO observations (workspace_id, world_id, worldline_id, record_id, observer_character_instance_id, source_event_id, id, dedupe_key, observation_kind, content, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, learned_at, metadata)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $6, 'direct', $7, 0.9, 0, 1, 0, 2, CURRENT_TIMESTAMP, '{}'::jsonb)`,
        [workspaceId, worldId, line, records[key], instance[key], `observation_${prefix}_${key}`, `Observation ${key}`],
      );
    }

    for (const key of ["a", "b"] as const) await ownerPool.query(
      `UPDATE observations SET source_event_id = $3 WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, `observation_${prefix}_${key}`, event[key === "a" ? "b" : "a"]]);
    // A genuine unrelated Record has sourced memory but no snapshot/link/domain
    // reason to be carried. It must not become a historical-universe root.
    const unrelatedRecord = `record_${prefix}_unrelated`;
    await ownerPool.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
      VALUES ($1,$2,$3,$4,$5,'Unrelated historical C','active',0,0,'primary','0.0.0-local')`, [workspaceId, worldId, line, story.a, unrelatedRecord]);
    await ownerPool.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
      VALUES ($1,$2,$3,$4,0,0)`, [workspaceId, worldId, line, unrelatedRecord]);
    if (definitionMode === "distinct") await ownerPool.query(`INSERT INTO character_definitions (workspace_id,world_id,id,display_name) VALUES ($1,$2,$3,'Other observer')`, [workspaceId,worldId,`${definition}_other`]);
    if (definitionMode === "identical") await ownerPool.query(`INSERT INTO character_definitions (workspace_id,world_id,id,display_name,source_format,profile)
      SELECT workspace_id,world_id,$3,display_name,source_format,profile FROM character_definitions WHERE workspace_id=$1 AND id=$2`,
      [workspaceId,definition,`${definition}_other`]);
    await ownerPool.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,born_tick,born_ordinal)
      VALUES ($1,$2,$3,$4,$5,$5,0,0)`, [workspaceId,worldId,line,definitionMode === "shared" ? definition : `${definition}_other`,`${continuity}_other`]);
    await ownerPool.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,id,controller_mode,status,
      instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,state)
      VALUES ($1,$2,$3,$4,$5,$6,'ai','present',0,0,0,0,'{}'::jsonb)`, [workspaceId,worldId,line,records.b,`${continuity}_other`,`${instance.b}_other`]);
    await ownerPool.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
      VALUES ($1,$2,$3,$4,$5,'character',$6,'ai',1)`, [workspaceId,worldId,line,records.b,`${participant.b}_other`,`${instance.b}_other`]);
    // The unrelated C also has truthful complete observation ownership, but its
    // sourced memory is not a root for this archive.
    await ownerPool.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,id,controller_mode,status,
      instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,state)
      VALUES ($1,$2,$3,$4,$5,$6,'ai','present',0,0,0,0,'{}'::jsonb)`, [workspaceId,worldId,line,unrelatedRecord,continuity,`${instance.a}_unrelated`]);
    await ownerPool.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
      VALUES ($1,$2,$3,$4,$5,'character',$6,'ai',0)`, [workspaceId,worldId,line,unrelatedRecord,`${participant.a}_unrelated`,`${instance.a}_unrelated`]);
    await ownerPool.query(`INSERT INTO observations (workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,id,dedupe_key,
      observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,learned_at,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$6,'direct','Unrelated observation',1,0,1,0,1,'2026-10-16T00:00:00.000Z','{}'::jsonb)`,
      [workspaceId,worldId,line,unrelatedRecord,`${instance.a}_unrelated`,`${instance.a}_unrelated_obs`]);
    const memory = {
      a: `memory_${prefix}_a`,
      b: `memory_${prefix}_b`,
    };
    const vector = `[${[1, ...Array(383).fill(0)].join(",")}]`;

    for (const [index, key] of (["a", "b"] as const).entries()) {
      await ownerPool.query(
        `INSERT INTO memory_conclusions (
           workspace_id, world_id, worldline_id, observer_continuity_id, observed_entity_key,
           source_record_id, source_observation_id, supersedes_memory_id, id, operation, memory_kind,
           content, keywords, semantic_embedding, embedding_model, fidelity,
           occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'explicit', $11, $12::text[], $13::vector, 'f4a-local-vector', 0.875, 0, $14, 0, $15, '{}'::jsonb)`,
        [
          workspaceId, worldId, line, continuity, "entity:harbor",
          records[key], `observation_${prefix}_${key}`,
          key === "b" ? memory.a : null,
          memory[key], key === "b" ? "update" : "add",
          `Conclusion ${key}`, ["memory", key], vector,
          3 - index, 12 + index,
        ],
      );
    }

    await ownerPool.query(`INSERT INTO observations (workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,source_event_id,id,dedupe_key,
      observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,learned_at,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'direct','Observation tail',0.9,0,1,0,2,'2026-10-16T00:00:00.000Z','{}'::jsonb)`,
      [workspaceId,worldId,line,records.a,instance.a,event.b,`observation_${prefix}_tail`]);
    await ownerPool.query(`INSERT INTO memory_conclusions
      (workspace_id,world_id,worldline_id,observer_continuity_id,observed_entity_key,source_record_id,source_observation_id,
       supersedes_memory_id,id,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
       occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
      VALUES ($1,$2,$3,$4,'entity:harbor',$5,$6,$7,$8,'retract','explicit','Conclusion tail',ARRAY['literal', $7, 'literal'],
        $9::vector,'f4a-local-vector',0.875,0,1,0,20,$10::jsonb),
        ($1,$2,$3,$4,'entity:unrelated',$11,$13,NULL,$12,'add','explicit','Excluded historical memory',ARRAY['unrelated'],
        $9::vector,'f4a-local-vector',0.875,0,1,0,1,'{}'::jsonb)`,
      [workspaceId,worldId,line,continuity,records.a,`observation_${prefix}_tail`,memory.b,`${memory.a}_tail`,vector,
        JSON.stringify({ literalId: memory.a, values: ["A", "B", "A"] }),unrelatedRecord,`${memory.a}_unrelated`,`${instance.a}_unrelated_obs`]);
    await ownerPool.query(
      `INSERT INTO memory_snapshots (workspace_id, world_id, worldline_id, observer_continuity_id, id, snapshot_kind, content, item_ids, cursor_tick, cursor_ordinal, cache_epoch, token_count)
       VALUES ($1, $2, $3, $4, $5, 'recall', 'Cross-Record complete memory', $6::text[], 0, 10, 7, 123)`,
      [workspaceId, worldId, line, continuity, `snapshot_${prefix}`, [memory.a, memory.b, memory.a]],
    );
    await ownerPool.query(
      `INSERT INTO memory_cache_epochs (workspace_id, observer_continuity_id, epoch)
       VALUES ($1, $2, 7)`,
      [workspaceId, continuity],
    );
    for (const key of ["a", "b"] as const) {
      await ownerPool.query(
        `INSERT INTO relationship_states (workspace_id, world_id, worldline_id, observer_continuity_id, target_entity_key, relation_kind, content, fidelity, source_record_id, source_observation_id, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal)
         VALUES ($1, $2, $3, $4, $5, 'trust', $6, 0.625, $7, $8, 0, 1, 0, 2)`,
        [workspaceId, worldId, line, continuity, `entity:${key}`, `Relationship ${key}`, records[key], `observation_${prefix}_${key}`],
      );
    }

    await ownerPool.query(`INSERT INTO relationship_states (workspace_id,world_id,worldline_id,observer_continuity_id,target_entity_key,relation_kind,
      content,fidelity,source_record_id,source_observation_id,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
      VALUES ($1,$2,$3,$4,'entity:anchor','trust','Null-source other observer',1,NULL,NULL,0,1,0,1)`, [workspaceId,worldId,line,`${continuity}_other`]);
    const beforeSource = await exactLineImage(ownerPool, workspaceId, worldId, line);
    const beforeShared = await sharedAuthorityImage(ownerPool, workspaceId, worldId, [definition, `${definition}_other`]);
    assert.equal((beforeSource.observations as unknown[]).length, 4);
    assert.equal((beforeSource.memory_conclusions as unknown[]).length, 4);
    assert.deepEqual((beforeSource.memory_snapshots as { item_ids: string[] }[])[0]!.item_ids, [memory.a, memory.b, memory.a]);

    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);

    for (const primary of ["a", "b"] as const) {
      const recordId = records[primary];
      const beforeExport = await exactWorldImage(ownerPool, workspaceId, worldId);
      const archive = await reader.load({ workspaceId, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
      assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), beforeExport);
      assert.ok(archive);
      assert.equal(archive.memory?.schemaVersion, 2);
      assert.equal(archive.memory?.conclusions.length, 3);
      assert.equal(archive.memory?.snapshots.length, 1);
      assert.equal(archive.memory?.relationshipStates.length, 3);

      assert.equal("siblings" in archive, false);
      assert.deepEqual(archive.domain!.records.map((row) => row.recordId), [records[primary === "a" ? "b" : "a"]]);
      assert.ok(!archive.domain!.records.some((row) => row.recordId === unrelatedRecord));
      const sibling = archive.domain!.records[0]!;
      assert.equal(sibling.storyId, story[primary === "a" ? "b" : "a"]);
      assert.equal(sibling.title, sibling.recordId);
      assert.equal(sibling.lastEventId, event[primary === "a" ? "b" : "a"]);
      assert.equal(sibling.bundle.memory, undefined);
      for (const section of ["record", "goals", "topology", "actionReceipts", "characterEffects", "observations", "outbox", "firstNight", "selfPlay"]) assert.ok(Object.hasOwn(sibling.bundle, section));
      assert.equal(archive.memory!.conclusions[0]!.sourceMemoryId, `${memory.a}_tail`, "real serialized forward declaration");
      const bytes = buildRealmRuntimeSaveArchive(archive);
      assert.equal("runtime/siblings.json" in unzipSync(bytes), false);
      let parsed = parseRealmRuntimeSaveArchive(bytes);
      if (reverse) {
        // A valid alternate wire order is a hash-correct TEST-ONLY re-encoding
        // of actual exported sections, not a second export implementation.
        const alternate = structuredClone(archive);
        alternate.memory!.conclusions = [...alternate.memory!.conclusions].reverse();
        parsed = parseRealmRuntimeSaveArchive(forgeArchive(alternate).bytes);
        assert.deepEqual(parsed.memory, archive.memory);
      }

      const restored = await restorer.restore({
        workspaceId,
        principalId,
        archive: parsed,
        targetWorldId: worldId,
        idempotencyKey: `f4a2-cross-${primary}-${suffix}`,
      });

      assert.deepEqual(
        await exactLineImage(ownerPool, workspaceId, worldId, line),
        beforeSource,
        "source worldline is unchanged after restore",
      );
      assert.deepEqual(
        await sharedAuthorityImage(ownerPool, workspaceId, worldId, [definition, `${definition}_other`]),
        beforeShared,
        "shared authority rows are unchanged after restore",
      );
      assert.notEqual(restored.worldlineId, line);

      const target = await exactLineImage(ownerPool, workspaceId, worldId, restored.worldlineId);
      assert.equal((target.worldlines as { id: string }[]).length, 1);
      assert.ok((target.records as { id: string }[]).some((r) => r.id === restored.recordId));
      assert.ok((target.observations as unknown[]).length > 0);
      assert.equal((target.memory_conclusions as unknown[]).length, 3);
      assert.equal((target.memory_snapshots as unknown[]).length, 1);
      assert.equal((target.relationship_states as unknown[]).length, 3);
      assert.ok((target.records as { worldline_id: string }[]).every((r) => r.worldline_id === restored.worldlineId));
      const expectedDefinitions = definitionMode === "shared" ? 1 : 2;
      const sourceDefinitions = imageRows(beforeSource,"character_continuities").map(row=>row.definition_id);
      const targetDefinitions = imageRows(target,"character_continuities").map(row=>row.definition_id);
      await saveRuntimeEvidence("registered-p2-definition-identity",{definitionMode,primary,reverse,
        source:beforeSource,target,sourceDefinitions,targetDefinitions});
      assert.equal(new Set(sourceDefinitions).size,expectedDefinitions,"actual source identity cardinality");
      assert.equal(new Set(targetDefinitions).size,expectedDefinitions,
        "two different source continuities sharing ONE definition must still share ONE target definition");
      assert.equal(imageRows(target,"character_definitions").length,expectedDefinitions);
      const maps = assertTransportedArchive(parsed, target, { workspaceId, worldId, worldlineId: restored.worldlineId, recordId: restored.recordId, storyId: restored.storyId });
      assert.deepEqual(imageRows(target, "memory_snapshots")[0]!.item_ids, [maps.conclusion![memory.a], maps.conclusion![memory.b], maps.conclusion![memory.a]]);
      const beforeResave = await exactWorldImage(ownerPool,workspaceId,worldId);
      const resaved = await reader.load({ workspaceId, recordId:restored.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(resaved);
      assert.deepEqual(await exactWorldImage(ownerPool,workspaceId,worldId),beforeResave);
      assertTransportedArchive(resaved,target,{workspaceId,worldId,worldlineId:restored.worldlineId,recordId:restored.recordId,storyId:restored.storyId},false);
      const second=await restorer.restore({workspaceId,principalId,archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(resaved)),
        targetWorldId:worldId,idempotencyKey:`p2-second-${primary}-${suffix}`});
      const secondTarget=await exactLineImage(ownerPool,workspaceId,worldId,second.worldlineId);
      const secondMaps=assertTransportedArchive(resaved,secondTarget,{workspaceId,worldId,worldlineId:second.worldlineId,recordId:second.recordId,storyId:second.storyId});
      assert.equal(imageRows(secondTarget,"character_definitions").length,expectedDefinitions);
      assert.equal(new Set(imageRows(secondTarget,"character_continuities").map(row=>row.definition_id)).size,expectedDefinitions);
      assert.deepEqual(await exactLineImage(ownerPool,workspaceId,worldId,line),beforeSource);
      assert.deepEqual(await sharedAuthorityImage(ownerPool,workspaceId,worldId,[definition,`${definition}_other`]),beforeShared);
      await saveRuntimeEvidence("p2-second-restore",{definitionMode,primary,reverse,archive:parsed,maps,resaved,second,secondTarget,secondMaps});
      if(definitionMode === "shared" && primary === "a" && !reverse){
        const conflictingDefinition=structuredClone(parsed);
        const participant=conflictingDefinition.domain!.records[0]!.bundle.topology!.participants.find(row=>row.character?.sourceDefinitionId===definition)!;
        participant.character!.definition={...participant.character!.definition,profile:{conflict:true}};
        await assertRuntimeInvalid(ownerPool,restorer,{workspaceId,worldId,principalId},conflictingDefinition,"conflicting-shared-definition","Memory definition representations conflict.");
      }
      const replayBefore = await exactWorldImage(ownerPool, workspaceId, worldId);
      const replay = await restorer.restore({ workspaceId, principalId, archive: parsed, targetWorldId: worldId, idempotencyKey: `f4a2-cross-${primary}-${suffix}` });
      assert.equal(replay.replayed, true);
      assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), replayBefore);
      const invalidReplay = structuredClone(parsed);
      if (invalidReplay.memory?.schemaVersion !== 2) throw new Error("V2 fixture");
      invalidReplay.memory.cacheEpochs = invalidReplay.memory.cacheEpochs.map((row) => ({ ...row, epoch: 0 }));
      await assert.rejects(restorer.restore({ workspaceId, principalId, archive: invalidReplay, targetWorldId: worldId,
        idempotencyKey: `f4a2-cross-${primary}-${suffix}` }), { code: "RUNTIME_SAVE_INVALID", message: "Memory cache epoch precedes a retained snapshot." });
      assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), replayBefore);
      const conflicting = structuredClone(parsed);
      conflicting.memory!.conclusions = conflicting.memory!.conclusions.map((row, index) => index === 0 ? { ...row, content: "conflicting semantics" } : row);
      conflicting.manifest = realmRuntimeSaveManifestFromData({ ...conflicting, ...conflicting.manifest });
      await assert.rejects(restorer.restore({ workspaceId, principalId, archive: conflicting, targetWorldId: worldId,
        idempotencyKey: `f4a2-cross-${primary}-${suffix}` }), { code: "RESTORE_CONFLICT" });
      assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), replayBefore);
      await saveRuntimeEvidence(`cross-${reverse}-${primary}`, { archive: parsed, source: beforeSource, target, maps, replayBefore,
        replayAfter: await exactWorldImage(ownerPool, workspaceId, worldId), parentSqlPid: process.pid });
      if (definitionMode === "distinct" && primary === "b" && !reverse) await exerciseR1Boundaries(ownerPool, runtimePool, parsed, { workspaceId, worldId, principalId });

    }
    }
    }
  },
);

test(
  "F4a2 absent memory_cache_epochs row defaults to epoch 0 across carried topology",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const prefix = `f4a2_epoch_${suffix}`;
    const workspaceId = POSTGRES_DEMO_IDS.workspace;
    const principalId = POSTGRES_DEMO_IDS.principal;
    const worldId = `world_${prefix}`;
    const line = `line_${prefix}`;
    const definition = `definition_${prefix}`;
    const continuity = `continuity_${prefix}`;
    const instance = `instance_${prefix}`;
    const participant = `participant_${prefix}`;
    const story = `story_${prefix}`;
    const record = `record_${prefix}`;
    const scene = `scene_${prefix}`;
    const visibilityPolicy = `visibility_${prefix}`;
    const event = `event_${prefix}`;
    const observation = `observation_${prefix}`;
    const conclusion = `conclusion_${prefix}`;
    const vector = `[${[1, ...Array(383).fill(0)].join(",")}]`;

    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
       VALUES ($1, $2, 'F4a2 epoch zero source', 'active', 'native_calendar', '{}'::jsonb)`,
      [workspaceId, worldId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'Epoch zero line', 'active', 0, 10)`,
      [workspaceId, worldId, line],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [workspaceId, worldId, principalId],
    );
    await ownerPool.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
       VALUES ($1, $2, $3, 'Epoch observer')`,
      [workspaceId, worldId, definition],
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal)
       VALUES ($1, $2, $3, $4, $5, $5, 0, 0)`,
      [workspaceId, worldId, line, definition, continuity],
    );
    await ownerPool.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $4, 'active', 'Epoch zero story', 0, 0)`,
      [workspaceId, worldId, line, story],
    );
    await ownerPool.query(
      `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind, world_version)
       VALUES ($1, $2, $3, $4, $5, $5, 'active', 0, 0, 'primary', '0.0.0-local')`,
      [workspaceId, worldId, line, story, record],
    );
    await ownerPool.query(
      `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $5, 'Epoch scene', 'active', 0, 0)`,
      [workspaceId, worldId, line, record, scene],
    );
    await ownerPool.query(
      `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
       VALUES ($1, $2, $3, $4, $5, $5, 1, 'public')`,
      [workspaceId, worldId, line, record, visibilityPolicy],
    );
    await ownerPool.query(
      `INSERT INTO events (workspace_id, world_id, worldline_id, record_id, scene_id, id, record_version, record_ordinal, batch_index, event_kind, actor_participant_id, speaker_name, content, visibility_policy_id, world_tick, world_ordinal, calendar_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed', NULL, 'Narrator', 'Epoch anchor event.', $7, 0, 1, 'native_calendar')`,
      [workspaceId, worldId, line, record, scene, event, visibilityPolicy],
    );
    await ownerPool.query(
      `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal)
       VALUES ($1, $2, $3, $4, 1, 2, $5, 0, 1)`,
      [workspaceId, worldId, line, record, event],
    );
    await ownerPool.query(
      `INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, status, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'human', 'present', 0, 0, 0, 0, '{}'::jsonb)`,
      [workspaceId, worldId, line, record, continuity, instance],
    );
    await ownerPool.query(
      `INSERT INTO participants (workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, is_active, speaking_order, shared_control_enabled)
       VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, 'human', true, 1, false)`,
      [workspaceId, worldId, line, record, participant, instance, principalId],
    );
    await ownerPool.query(
      `INSERT INTO observations (workspace_id, world_id, worldline_id, record_id, observer_character_instance_id, source_event_id, id, dedupe_key, observation_kind, content, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, learned_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'direct', 'Epoch observation.', 0.9, 0, 1, 0, 2, CURRENT_TIMESTAMP, '{}'::jsonb)`,
      [workspaceId, worldId, line, record, instance, event, observation],
    );
    await ownerPool.query(
      `INSERT INTO memory_conclusions (
         workspace_id, world_id, worldline_id, observer_continuity_id, observed_entity_key,
         source_record_id, source_observation_id, supersedes_memory_id, id, operation, memory_kind,
         content, keywords, semantic_embedding, embedding_model, fidelity,
         occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, 'add', 'explicit', $9, $10::text[], $11::vector, 'f4a-epoch-zero', 0.9, 0, 1, 0, 2, '{}'::jsonb)`,
      [workspaceId, worldId, line, continuity, "entity:epoch", record, observation, conclusion, "Epoch conclusion.", ["epoch"], vector],
    );
    // Intentionally NO memory_cache_epochs row for `continuity`; the reader
    // must synthesize epoch 0 so the V2 resolver accepts the archive.

    const beforeSource = await exactLineImage(ownerPool, workspaceId, worldId, line);
    assert.equal((beforeSource.memory_cache_epochs as unknown[]).length, 0);

    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const archive = await reader.load({ workspaceId, recordId: record, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive);
    assert.equal(archive.memory?.schemaVersion, 2);
    const memoryV2 = archive.memory as Extract<typeof archive.memory, { schemaVersion: 2 }>;
    assert.equal(memoryV2.conclusions.length, 1);
    assert.deepEqual(
      memoryV2.cacheEpochs,
      [{ sourceObserverContinuityId: continuity, epoch: 0 }],
      "reader synthesizes epoch 0 for topology continuity missing from memory_cache_epochs",
    );

    const bytes = buildRealmRuntimeSaveArchive(archive);
    const parsed = parseRealmRuntimeSaveArchive(bytes);
    const parsedMemoryV2 = parsed.memory as Extract<typeof parsed.memory, { schemaVersion: 2 }>;
    assert.deepEqual(parsedMemoryV2.cacheEpochs, memoryV2.cacheEpochs);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
    const restored = await restorer.restore({
      workspaceId,
      principalId,
      archive: parsed,
      targetWorldId: worldId,
      idempotencyKey: `f4a2-epoch-zero-${suffix}`,
    });

    assert.deepEqual(
      await exactLineImage(ownerPool, workspaceId, worldId, line),
      beforeSource,
      "source worldline is unchanged after restore",
    );
    assert.notEqual(restored.worldlineId, line);
    assert.equal(restored.importedMemoryConclusionCount, 1);

    const target = await exactLineImage(ownerPool, workspaceId, worldId, restored.worldlineId);
    assert.equal((target.memory_conclusions as unknown[]).length, 1);
    assert.equal((target.memory_cache_epochs as { epoch: number }[])[0]?.epoch, 0);
  },
);


interface SaveChildPayload {
  mode: "save";
  recordId: string;
  artifactPath: string;
  principalId: string;
}

interface RestoreChildPayload {
  mode: "restore";
  artifactPath: string;
  targetWorldId: string;
  idempotencyKey: string;
  principalId: string;
}

type ChildPayload = SaveChildPayload | RestoreChildPayload;

interface SaveChildResult {
  pid: number;
  mode: "save";
  status: number;
  artifactPath: string;
}

interface RestoreChildResult {
  pid: number;
  mode: "restore";
  status: number;
  recordId?: string;
  worldlineId?: string;
  storyId?: string;
  replayed?: boolean;
  error?: { code: string; message?: string };
}

function childProgramSource(): string {
  return `
import { readFile, writeFile } from "node:fs/promises";
import { POST as savePOST } from "${projectRoot.replaceAll("\\", "\\\\")}/app/api/record/backup/route.ts";
import { POST as restorePOST } from "${projectRoot.replaceAll("\\", "\\\\")}/app/api/record/restore/route.ts";
import { installTestSessionSecret, sessionProofFor } from "${projectRoot.replaceAll("\\", "\\\\")}/tests/helpers/session-proof.ts";
import { endSharedRuntimePools as endRoutePools, getSharedRuntimePool } from "${projectRoot.replaceAll("\\", "\\\\")}/app/api/world-scope.ts";
const fixtureShutdowns = new WeakMap();
const fixtureLiveClients = new WeakMap();
${observeFixturePool.toString()}
${awaitFixtureClients.toString()}
const routePool = observeFixturePool(getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!));
${refFixtureClients.toString()}
async function endSharedRuntimePools() {
  refFixtureClients(routePool);
  await endRoutePools();
  await awaitFixtureClients(routePool);
}

installTestSessionSecret();

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.log(JSON.stringify({ pid: process.pid, failed: true, error: "missing payload path" }));
  process.exit(1);
}

const payload = JSON.parse(await readFile(payloadPath, "utf8"));

function jsonRequest(path: string, body: unknown, principalId: string): Request {
  return new Request(\`http://localhost\${path}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": \`realm_session=\${sessionProofFor(principalId)}\`,
    },
    body: JSON.stringify(body),
  });
}

function restoreRequest(path: string, bytes: Uint8Array, principalId: string, targetWorldId: string, idempotencyKey: string): Request {
  return new Request(\`http://localhost\${path}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.realm.save+zip",
      "idempotency-key": idempotencyKey,
      "x-realm-target-world": targetWorldId,
      "Cookie": \`realm_session=\${sessionProofFor(principalId)}\`,
    },
    body: bytes,
  });
}

async function run(): Promise<void> {
  if (payload.mode === "save") {
    const req = jsonRequest("/api/record/backup", { recordId: payload.recordId }, payload.principalId);
    const response = await savePOST(req);
    if (response.status !== 200) {
      const body = await response.json().catch(() => ({}));
      console.log(JSON.stringify({ pid: process.pid, mode: "save", status: response.status, error: body.error ?? null }));
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(payload.artifactPath, bytes);
    console.log(JSON.stringify({ pid: process.pid, mode: "save", status: response.status, artifactPath: payload.artifactPath }));
  } else if (payload.mode === "restore") {
    const bytes = new Uint8Array(await readFile(payload.artifactPath));
    const response = await restorePOST(restoreRequest("/api/record/restore", bytes, payload.principalId, payload.targetWorldId, payload.idempotencyKey));
    const body = await response.json().catch(() => ({}));
    console.log(JSON.stringify({
      pid: process.pid,
      mode: "restore",
      status: response.status,
      recordId: body.recordId ?? null,
      worldlineId: body.worldlineId ?? null,
      storyId: body.storyId ?? null,
      replayed: body.replayed ?? null,
      error: body.error ?? null,
    }));
  } else {
    console.log(JSON.stringify({ pid: process.pid, failed: true, error: "unknown mode" }));
  }
}

await run();
await endSharedRuntimePools();
`;
}

async function runFreshChild<R extends { pid: number }>(
  childPath: string,
  payload: ChildPayload,
  env?: Record<string, string>,
): Promise<{ status: number | null; result: R }> {
  const payloadPath = `${childPath}.payload.json`;
  await writeFile(payloadPath, JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", childPath, payloadPath],
      {
        env: { ...process.env, REALM_OPERATOR_PRINCIPALS: POSTGRES_DEMO_IDS.principal, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (stderr) {
        console.error(`[fresh-child] stderr: ${stderr}`);
      }
      if (status !== 0) {
        console.error(`[fresh-child] exited ${status}. stdout: ${stdout}`);
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const last = lines.at(-1) ?? "{}";
      try {
        resolve({ status, result: JSON.parse(last) as R });
      } catch {
        reject(new Error(`Child output is not valid JSON: stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

test(
  "F4a2 fresh handler processes preserve exact transported memory across two restores (parent SQL rereads)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimeUrl } = await createTempDatabase(t);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const prefix = `f4a2_fresh_${suffix}`;
    const workspaceId = POSTGRES_DEMO_IDS.workspace;
    const principalId = POSTGRES_DEMO_IDS.principal;
    const worldId = `world_${prefix}`;
    const line = `line_${prefix}`;
    const definition = `definition_${prefix}`;
    const continuity = `continuity_${prefix}`;
    const instance = `instance_${prefix}`;
    const participant = `participant_${prefix}`;
    const story = `story_${prefix}`;
    const record = `record_${prefix}`;
    const scene = `scene_${prefix}`;
    const visibilityPolicy = `visibility_${prefix}`;
    const event = `event_${prefix}`;
    const observation = `observation_${prefix}`;
    const conclusion = `conclusion_${prefix}`;
    const snapshot = `snapshot_${prefix}`;
    const vector = `[${[1, ...Array(383).fill(0)].join(",")}]`;

    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
       VALUES ($1, $2, 'F4a2 fresh process source', 'active', 'native_calendar', '{}'::jsonb)`,
      [workspaceId, worldId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'Fresh process line', 'active', 0, 10)`,
      [workspaceId, worldId, line],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [workspaceId, worldId, principalId],
    );
    await ownerPool.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
       VALUES ($1, $2, $3, 'Fresh observer')`,
      [workspaceId, worldId, definition],
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal)
       VALUES ($1, $2, $3, $4, $5, $5, 0, 0)`,
      [workspaceId, worldId, line, definition, continuity],
    );
    await ownerPool.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $4, 'active', 'Fresh process story', 0, 0)`,
      [workspaceId, worldId, line, story],
    );
    await ownerPool.query(
      `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind, world_version)
       VALUES ($1, $2, $3, $4, $5, $5, 'active', 0, 0, 'primary', '0.0.0-local')`,
      [workspaceId, worldId, line, story, record],
    );
    await ownerPool.query(
      `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $5, 'Fresh scene', 'active', 0, 0)`,
      [workspaceId, worldId, line, record, scene],
    );
    await ownerPool.query(
      `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
       VALUES ($1, $2, $3, $4, $5, $5, 1, 'public')`,
      [workspaceId, worldId, line, record, visibilityPolicy],
    );
    await ownerPool.query(
      `INSERT INTO events (workspace_id, world_id, worldline_id, record_id, scene_id, id, record_version, record_ordinal, batch_index, event_kind, actor_participant_id, speaker_name, content, visibility_policy_id, world_tick, world_ordinal, calendar_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed', NULL, 'Narrator', 'Fresh anchor event.', $7, 0, 1, 'native_calendar')`,
      [workspaceId, worldId, line, record, scene, event, visibilityPolicy],
    );
    await ownerPool.query(
      `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal)
       VALUES ($1, $2, $3, $4, 1, 2, $5, 0, 1)`,
      [workspaceId, worldId, line, record, event],
    );
    await ownerPool.query(
      `INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, status, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'human', 'present', 0, 0, 0, 0, '{}'::jsonb)`,
      [workspaceId, worldId, line, record, continuity, instance],
    );
    await ownerPool.query(
      `INSERT INTO participants (workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, is_active, speaking_order, shared_control_enabled)
       VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, 'human', true, 1, false)`,
      [workspaceId, worldId, line, record, participant, instance, principalId],
    );
    await ownerPool.query(
      `INSERT INTO observations (workspace_id, world_id, worldline_id, record_id, observer_character_instance_id, source_event_id, id, dedupe_key, observation_kind, content, fidelity, occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, learned_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'direct', 'Fresh observation.', 0.9, 0, 1, 0, 2, '2026-10-16T01:02:03.456Z', '{}'::jsonb)`,
      [workspaceId, worldId, line, record, instance, event, observation],
    );
    await ownerPool.query(
      `INSERT INTO memory_conclusions (
         workspace_id, world_id, worldline_id, observer_continuity_id, observed_entity_key,
         source_record_id, source_observation_id, supersedes_memory_id, id, operation, memory_kind,
         content, keywords, semantic_embedding, embedding_model, fidelity,
         occurred_tick, occurred_ordinal, available_from_tick, available_from_ordinal, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, 'add', 'explicit', $9, $10::text[], $11::vector, 'f4a-fresh', 0.9, 0, 1, 0, 2, '{}'::jsonb)`,
      [workspaceId, worldId, line, continuity, "entity:fresh", record, observation, conclusion, "Fresh conclusion.", ["fresh"], vector],
    );
    await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,observed_entity_key,
      source_record_id,source_observation_id,supersedes_memory_id,id,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
      occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
      VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,$6,'add','explicit','Fresh conclusion B.',ARRAY[$5,$5],$7::vector,'f4a-fresh',0.8,0,2,0,20,$8::jsonb)`,
      [workspaceId,worldId,line,continuity,conclusion,`${conclusion}_b`,`[${[0, 1, ...Array(382).fill(0)].join(",")}]`,JSON.stringify({ literalConclusion: conclusion })]);
    await ownerPool.query(
      `INSERT INTO memory_snapshots (workspace_id, world_id, worldline_id, observer_continuity_id, id, snapshot_kind, content, item_ids, cursor_tick, cursor_ordinal, cache_epoch, token_count)
       VALUES ($1, $2, $3, $4, $5, 'recall', 'Fresh snapshot', $6::text[], 0, 10, 5, 42)`,
      [workspaceId, worldId, line, continuity, snapshot, [conclusion, `${conclusion}_b`, conclusion]],
    );
    await ownerPool.query(
      `INSERT INTO memory_cache_epochs (workspace_id, observer_continuity_id, epoch)
       VALUES ($1, $2, 5)`,
      [workspaceId, continuity],
    );

    const beforeSource = await exactLineImage(ownerPool, workspaceId, worldId, line);
    const beforeShared = await sharedAuthorityImage(ownerPool, workspaceId, worldId, [definition]);
    const beforeExport1 = await exactWorldImage(ownerPool, workspaceId, worldId);

    const scratchDir = await mkdtemp(join(tmpdir(), "f4a2-fresh-process-"));
    t.after(async () => {
      await rm(scratchDir, { recursive: true, force: true });
    });
    const childPath = join(scratchDir, "fresh-process-child.ts");
    await writeFile(childPath, childProgramSource());

    // ---- Child #1: fresh-process save of source Record ------------------
    const sourceArtifact = join(scratchDir, "source.realm");
    const save1 = await runFreshChild<SaveChildResult>(childPath, {
      mode: "save",
      recordId: record,
      artifactPath: sourceArtifact,
      principalId,
    }, { REALM_RUNTIME_DATABASE_URL: runtimeUrl });
    assert.equal(save1.status, 0, "save child #1 exits cleanly");
    assert.equal(save1.result.mode, "save");
    if (save1.result.status !== 200) {
      console.log("save1 result:", save1.result);
    }
    assert.equal(save1.result.status, 200, "save route returns 200");
    assert.ok(save1.result.pid > 0, "save child #1 has a real PID");
    const sourceBytes = new Uint8Array(await readFile(sourceArtifact));
    assert.ok(sourceBytes.length > 0, "source artifact has bytes");

    assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), beforeExport1, "whole World unchanged by first export");

    // ---- Parent: parse source archive -----------------------------------
    const sourceArchive = parseRealmRuntimeSaveArchive(sourceBytes);
    assert.equal(sourceArchive.memory?.schemaVersion, 2);
    const sourceMemoryV2 = sourceArchive.memory as Extract<typeof sourceArchive.memory, { schemaVersion: 2 }>;
    assert.equal(sourceMemoryV2.conclusions.length, 2);
    assert.equal(sourceMemoryV2.snapshots.length, 1);
    assert.deepEqual(sourceMemoryV2.cacheEpochs, [{ sourceObserverContinuityId: continuity, epoch: 5 }]);

    // ---- Child #2: fresh-process restore --------------------------------
    const restore1 = await runFreshChild<RestoreChildResult>(childPath, {
      mode: "restore",
      artifactPath: sourceArtifact,
      targetWorldId: worldId,
      idempotencyKey: `f4a2-fresh-restore-1-${suffix}`,
      principalId,
    }, { REALM_RUNTIME_DATABASE_URL: runtimeUrl });
    assert.equal(restore1.status, 0, "restore child #2 exits cleanly");
    assert.equal(restore1.result.mode, "restore");
    assert.equal(restore1.result.status, 201, "first restore returns 201");
    assert.ok(restore1.result.pid > 0, "restore child #2 has a real PID");
    assert.ok(restore1.result.pid !== save1.result.pid, "save and restore run in distinct processes");
    assert.ok(restore1.result.recordId, "first restore returns a target record id");
    assert.ok(restore1.result.worldlineId, "first restore returns a target worldline id");
    assert.equal(restore1.result.replayed, false);

    // ---- Durable reread after first restore -----------------------------
    assert.deepEqual(
      await exactLineImage(ownerPool, workspaceId, worldId, line),
      beforeSource,
      "source worldline is unchanged after first restore",
    );
    const firstTarget = await exactLineImage(ownerPool, workspaceId, worldId, restore1.result.worldlineId!);
    assert.equal((firstTarget.memory_conclusions as unknown[]).length, 2);
    assert.equal((firstTarget.memory_snapshots as unknown[]).length, 1);
    assert.equal((firstTarget.memory_cache_epochs as { epoch: number }[])[0]?.epoch, 5);

    // ---- Child #3: fresh-process save of restored Record ----------------
    const targetArtifact = join(scratchDir, "target.realm");
    const beforeExport2 = await exactWorldImage(ownerPool, workspaceId, worldId);
    const save2 = await runFreshChild<SaveChildResult>(childPath, {
      mode: "save",
      recordId: restore1.result.recordId!,
      artifactPath: targetArtifact,
      principalId,
    }, { REALM_RUNTIME_DATABASE_URL: runtimeUrl });
    assert.equal(save2.status, 0, "save child #3 exits cleanly");
    assert.equal(save2.result.status, 200, "second save route returns 200");
    assert.ok(save2.result.pid > 0 && save2.result.pid !== restore1.result.pid, "second save runs in a fresh process");
    const targetBytes = new Uint8Array(await readFile(targetArtifact));
    assert.ok(targetBytes.length > 0, "target artifact has bytes");

    assert.deepEqual(await exactWorldImage(ownerPool, workspaceId, worldId), beforeExport2, "whole World unchanged by resave");

    // ---- Parent: parse target archive -----------------------------------
    const targetArchive = parseRealmRuntimeSaveArchive(targetBytes);
    assert.equal(targetArchive.memory?.schemaVersion, 2);
    const targetMemoryV2 = targetArchive.memory as Extract<typeof targetArchive.memory, { schemaVersion: 2 }>;
    assert.equal(targetMemoryV2.conclusions.length, 2);
    assert.equal(targetMemoryV2.snapshots.length, 1);
    const firstEpoch = (firstTarget.memory_cache_epochs as { observer_continuity_id: string; epoch: number }[])[0]!;
    assert.deepEqual(targetMemoryV2.cacheEpochs, [{ sourceObserverContinuityId: firstEpoch.observer_continuity_id, epoch: 5 }]);

    // ---- Child #4: fresh-process second restore -------------------------
    const restore2 = await runFreshChild<RestoreChildResult>(childPath, {
      mode: "restore",
      artifactPath: targetArtifact,
      targetWorldId: worldId,
      idempotencyKey: `f4a2-fresh-restore-2-${suffix}`,
      principalId,
    }, { REALM_RUNTIME_DATABASE_URL: runtimeUrl });
    assert.equal(restore2.status, 0, "restore child #4 exits cleanly");
    assert.equal(restore2.result.status, 201, "second restore returns 201");
    assert.ok(restore2.result.pid > 0 && restore2.result.pid !== save2.result.pid, "second restore runs in a fresh process");
    assert.ok(restore2.result.recordId && restore2.result.worldlineId, "second restore returns target ids");
    assert.equal(restore2.result.replayed, false);

    // ---- Durable reread after second restore ----------------------------
    const secondTarget = await exactLineImage(ownerPool, workspaceId, worldId, restore2.result.worldlineId!);
    assert.equal((secondTarget.memory_conclusions as unknown[]).length, 2);
    assert.equal((secondTarget.memory_snapshots as unknown[]).length, 1);
    assert.equal((secondTarget.memory_cache_epochs as { epoch: number }[])[0]?.epoch, 5);

    const firstScope = { workspaceId, worldId, worldlineId: restore1.result.worldlineId!, recordId: restore1.result.recordId!, storyId: restore1.result.storyId! };
    const secondScope = { workspaceId, worldId, worldlineId: restore2.result.worldlineId!, recordId: restore2.result.recordId!, storyId: restore2.result.storyId! };
    const firstMaps = assertTransportedArchive(sourceArchive, firstTarget, firstScope);
    assertTransportedArchive(targetArchive, firstTarget, firstScope, false);
    const secondMaps = assertTransportedArchive(targetArchive, secondTarget, secondScope);
    assert.deepEqual(await exactLineImage(ownerPool, workspaceId, worldId, line), beforeSource);
    assert.deepEqual(await sharedAuthorityImage(ownerPool, workspaceId, worldId, [definition]), beforeShared);
    // Outside transported equality: storage created_at/updated_at/recorded_at,
    // original primary Record title/status/start/link metadata, primary Story
    // title/premise, worldline label/fork metadata, and generated narrator.
    // learnedAt, memory fields, typed references, and complete sibling metadata
    // ARE transported and checked above. SQL rereads here run in the parent.
    await saveRuntimeEvidence("fresh-handler-transport", { handlerPids: [save1.result.pid, restore1.result.pid, save2.result.pid, restore2.result.pid],
      sqlReaderPid: process.pid, freshSqlProcess: false, sourceArchive, targetArchive,
      beforeSource, firstTarget, secondTarget, firstMaps, secondMaps });

  },
);

// Independent registered controls for Iris P1. Mutations remain semantically
// valid; stale caller hashes may not turn changed state into an exact replay.
test("R1-ID P1 commits the detached valid body independently of supplied raw hash", {
  skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000,
}, async (t) => {
  const { ownerPool, runtimePool } = await createTempDatabase(t);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const memoryId = `memory_body_${suffix}`, observationId = `observation_body_${suffix}`;
  await ownerPool.query(`INSERT INTO observations (workspace_id,world_id,worldline_id,record_id,id,
    observer_character_instance_id,source_event_id,dedupe_key,observation_kind,content,fidelity,
    occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,learned_at,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,NULL,$5,'direct','Body commitment observation',0.9,0,0,0,0,'2026-10-16T00:00:00.000Z','{}'::jsonb)`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,SCOPE.recordId,observationId,POSTGRES_DEMO_IDS.playerInstance]);
  await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,id,observer_continuity_id,observed_entity_key,
    source_record_id,source_observation_id,supersedes_memory_id,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,
    fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    VALUES ($1,$2,$3,$4,$5,'entity:body',NULL,NULL,NULL,'add','explicit','Body A',ARRAY['body','body'],$6::vector,'local-body',1,0,0,0,0,$7::jsonb)`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,memoryId,POSTGRES_DEMO_IDS.playerContinuity,
      `[${[1,...Array(383).fill(0)].join(",")}]`,JSON.stringify({ literal: memoryId })]);
  const sourceBefore = await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId);
  const reader = createPostgresRealmRuntimeSaveReader(runtimePool), restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
  const beforeExport = await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const loaded = await reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(loaded);
  const bytes = buildRealmRuntimeSaveArchive(loaded), archive = parseRealmRuntimeSaveArchive(bytes);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeExport);
  const key = `body-a-${suffix}`;
  const input = { workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,targetWorldId:SCOPE.worldId,idempotencyKey:key };
  const restored = await restorer.restore({ ...input,archive }); assert.equal(restored.replayed,false);
  const markerFor = async (storyId:string) => (await ownerPool.query<{ premise:string }>(
    `SELECT premise FROM stories WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,[SCOPE.workspaceId,SCOPE.worldId,storyId])).rows[0]!.premise;
  const originalMarker = await markerFor(restored.storyId);
  const beforeReplay = await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  assert.equal((await restorer.restore({ ...input,archive })).replayed,true);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeReplay);
  const stale = structuredClone(archive);
  stale.memory!.conclusions = stale.memory!.conclusions.map((row)=>({...row,content:"IRIS distinct valid transported memory content"}));
  const changedManifest = realmRuntimeSaveManifestFromData({ ...stale,...stale.manifest });
  assert.notEqual(changedManifest.snapshot.runtimeHash,archive.manifest.snapshot.runtimeHash);
  let refusal:unknown = null;
  try { await restorer.restore({ ...input,archive:stale }); } catch(error) { refusal=error; }
  const afterStale = await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  await saveRuntimeEvidence("registered-p1-retained-hash",{archive,stale,originalMarker,changedManifest,
    refusal:refusal instanceof Error ? {name:refusal.name,message:refusal.message,...(refusal instanceof RealmRuntimeSaveRepositoryError ? {code:refusal.code}:{})}:null,
    before:beforeReplay,after:afterStale});
  assert.ok(refusal instanceof RealmRuntimeSaveRepositoryError && ["RESTORE_CONFLICT","RUNTIME_SAVE_INVALID"].includes(refusal.code),
    "different valid transported memory content must not replay under retained supplied manifest hash");
  assert.deepEqual(afterStale,beforeReplay);
  assert.match(originalMarker,/^realm-save:body-v1:[0-9a-f]{64}$/);
  const changes:[string,(value:RealmRuntimeSaveArchive)=>void][] = [
    ["learnedAt",value=>{value.observations!.observations=value.observations!.observations.map(row=>row.sourceObservationId===observationId ? {...row,learnedAt:"2026-10-16T00:00:01.000Z"}:row);}],
    ["epoch",value=>{if(value.memory?.schemaVersion===2)value.memory.cacheEpochs=value.memory.cacheEpochs.map(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity ? {...row,epoch:row.epoch+1}:row);}],
    ["head",value=>{if(value.memory?.schemaVersion===2)value.memory.worldlineHead={tick:value.memory.worldlineHead.tick+1,ordinal:0};}],
    ["provenance",value=>{value.memory!.conclusions=value.memory!.conclusions.map(row=>({...row,sourceRecordId:SCOPE.recordId,sourceObservationId:observationId}));}],
    ["observation-owner",value=>{value.observations!.observations=value.observations!.observations.map(row=>row.sourceObservationId===observationId ? {...row,sourceObserverCharacterInstanceId:POSTGRES_DEMO_IDS.scoutInstance}:row);}],
    ["keywords",value=>{value.memory!.conclusions=value.memory!.conclusions.map(row=>({...row,keywords:[...row.keywords,"changed"]}));}],
    ["metadata",value=>{value.memory!.conclusions=value.memory!.conclusions.map(row=>({...row,metadata:{...row.metadata,extra:"changed"}}));}],
  ];
  for(const [label,change] of changes){
    const changed=structuredClone(archive);change(changed);
    const actual=realmRuntimeSaveManifestFromData({...changed,...changed.manifest});
    assert.notEqual(actual.snapshot.runtimeHash,archive.manifest.snapshot.runtimeHash,`${label} is a valid changed body`);
    await assert.rejects(restorer.restore({...input,archive:changed}),{code:"RESTORE_CONFLICT"},label);
    assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeReplay,label);
  }
  const rehashed={...stale,manifest:changedManifest};
  await assert.rejects(restorer.restore({...input,archive:rehashed}),{code:"RESTORE_CONFLICT"});
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeReplay);
  // First B may use an unverified caller hash A, but must commit B, never A.
  const firstB=await restorer.restore({...input,idempotencyKey:`body-b-${suffix}`,archive:stale});
  const bodyBImage=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,firstB.worldlineId);
  assert.equal(imageRows(bodyBImage,"memory_conclusions")[0]!.content,stale.memory!.conclusions[0]!.content);
  const bodyBMarker=await markerFor(firstB.storyId);assert.match(bodyBMarker,/^realm-save:body-v1:[0-9a-f]{64}$/);assert.notEqual(bodyBMarker,originalMarker);
  const beforeBReplay=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  assert.equal((await restorer.restore({...input,idempotencyKey:`body-b-${suffix}`,archive:stale})).replayed,true);
  await assert.rejects(restorer.restore({...input,idempotencyKey:`body-b-${suffix}`,archive}),{code:"RESTORE_CONFLICT"});
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeBReplay);
  // Reordering every JSON object's keys changes raw bytes but not accepted state.
  const reverseKeys=(value:unknown):unknown=>Array.isArray(value)?value.map(reverseKeys):value!==null&&typeof value==="object"
    ?Object.fromEntries(Object.entries(value).reverse().map(([key,child])=>[key,reverseKeys(child)])):value;
  const alternative:RealmRuntimeSaveArchive=JSON.parse(JSON.stringify(reverseKeys(archive)));
  const alternateWire=forgeArchive(alternative),parsedAlternate=parseRealmRuntimeSaveArchive(alternateWire.bytes);
  assert.notEqual(parsedAlternate.manifest.snapshot.runtimeHash,archive.manifest.snapshot.runtimeHash);
  assert.equal((await restorer.restore({...input,archive:parsedAlternate})).replayed,true);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeBReplay);
  const corrupted=unzipSync(bytes);corrupted["runtime/memory.json"]=Buffer.from(JSON.stringify(stale.memory));
  assert.throws(()=>parseRealmRuntimeSaveArchive(zipSync(corrupted,{mtime:new Date(1980,0,1)})),{code:"RUNTIME_HASH_MISMATCH"});
  // Pre-change markers have no actual-body proof. Never promote them on replay.
  for(const oldMarker of [`realm-save:${archive.manifest.snapshot.runtimeHash}`,`realm-save:body-v999:${"0".repeat(64)}`]){
    await ownerPool.query(`UPDATE stories SET premise=$3 WHERE workspace_id=$1 AND id=$2`,[SCOPE.workspaceId,restored.storyId,oldMarker]);
    const oldBefore=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
    await assert.rejects(restorer.restore({...input,archive}),{code:"RESTORE_CONFLICT",message:"Existing restore lacks a supported validated-body commitment; use a new idempotency key."});
    assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),oldBefore);
    assert.equal(await markerFor(restored.storyId),oldMarker,"no backfill on refusal");
  }
  await ownerPool.query(`UPDATE stories SET premise=$3 WHERE workspace_id=$1 AND id=$2`,[SCOPE.workspaceId,restored.storyId,originalMarker]);
  assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sourceBefore);
  await saveRuntimeEvidence("p1-commitment-readback",{archive,originalMarker,bodyBMarker,bodyBImage,sourceBefore,
    sourceAfter:await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),alternateRawHash:parsedAlternate.manifest.snapshot.runtimeHash,
    finalWorld:await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId)});
});

// F4a2-B: additive real-runtime coverage. Owner SQL below is explicitly fixture
// seeding, never an ordinary writer or a no-write comparison window.
const BEHAVIOR_VECTOR = [1, ...Array<number>(383).fill(0)];
type BehaviorConsumerScope = {workspaceId:string;worldId:string;worldlineId:string;recordId:string;characterInstanceId:string};

async function appendBehavior(repository: ReturnType<typeof createPostgresCharacterMemoryRepository>,
  scope: BehaviorConsumerScope, content: string, operation: "add" | "update" | "retract" = "add", supersedesMemoryId?: string) {
  await repository.appendAuthorized({ ...scope, observedEntityKey: "entity:behavior", content, operation,
    ...(supersedesMemoryId ? { supersedesMemoryId } : {}), memoryKind: "explicit", fidelity: 0.875,
    keywords: ["behavior", "behavior"], embedding: BEHAVIOR_VECTOR, embeddingModel: "behavior-local" });
}

async function seedBehavior(t: test.TestContext, legacy = false) {
  const db = await createTempDatabase(t);
  const { ownerPool, runtimePool } = db;
  const repository = createPostgresCharacterMemoryRepository(runtimePool);
  const sourceHead = (await ownerPool.query<{ head_tick: number; head_ordinal: number }>(
    `SELECT head_tick::int,head_ordinal::int FROM worldlines WHERE workspace_id=$1 AND id=$2`,
    [SCOPE.workspaceId, SCOPE.worldlineId])).rows[0]!;
  const observers = [
    { name: "player", instance: POSTGRES_DEMO_IDS.playerInstance, continuity: POSTGRES_DEMO_IDS.playerContinuity, epoch: 3 },
    { name: "scout", instance: POSTGRES_DEMO_IDS.scoutInstance, continuity: POSTGRES_DEMO_IDS.scoutContinuity, epoch: 7 },
  ];
  for (const observer of observers) {
    const scope = { ...SCOPE, characterInstanceId: observer.instance };
    await appendBehavior(repository, scope, `behavior ${observer.name} visible`);
    const visible = (await ownerPool.query<{ id: string }>(`SELECT id FROM memory_conclusions
      WHERE workspace_id=$1 AND observer_continuity_id=$2 AND content=$3`,
    [SCOPE.workspaceId, observer.continuity, `behavior ${observer.name} visible`])).rows[0]!.id;
    // Explicit delayed-availability fixture, one legitimate cursor after head.
    await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,
      id,observed_entity_key,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
      occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
      VALUES ($1,$2,$3,$4,$5,'entity:behavior','add','explicit',$6,ARRAY['behavior','behavior'],$7::vector,'behavior-local',0.75,$8,$9,$8,$10,$11::jsonb)`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,observer.continuity,`behavior_memory_${observer.name}_delayed`,
      `behavior ${observer.name} delayed`,vectorLiteral(BEHAVIOR_VECTOR),sourceHead.head_tick,sourceHead.head_ordinal,
      sourceHead.head_ordinal+1,JSON.stringify({literalId:visible,repeated:["A","B","A"]})]);
    await ownerPool.query(`INSERT INTO memory_cache_epochs (workspace_id,observer_continuity_id,epoch)
      VALUES ($1,$2,$3) ON CONFLICT (workspace_id,observer_continuity_id) DO UPDATE SET epoch=EXCLUDED.epoch`,
    [SCOPE.workspaceId, observer.continuity, observer.epoch]);
    const delayed = (await ownerPool.query<{ id: string }>(`SELECT id FROM memory_conclusions
      WHERE workspace_id=$1 AND observer_continuity_id=$2 AND content=$3`,
    [SCOPE.workspaceId, observer.continuity, `behavior ${observer.name} delayed`])).rows[0]!.id;
    const fresh = await repository.createSnapshotAuthorized({ ...scope, snapshotId: `behavior_${observer.name}_fresh`,
      snapshotKind: "recall", content: `behavior ${observer.name} fresh snapshot`, itemIds: [visible, delayed, visible], tokenCount: 37 });
    assert.ok(fresh); assert.equal(fresh.cacheEpoch, observer.epoch);
    await ownerPool.query(`INSERT INTO memory_snapshots (workspace_id,world_id,worldline_id,observer_continuity_id,id,
      snapshot_kind,content,item_ids,cursor_tick,cursor_ordinal,cache_epoch,token_count)
      VALUES ($1,$2,$3,$4,$5,'representation',$6,$7::text[],0,0,$8,19)`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,observer.continuity,`behavior_${observer.name}_stale`,
      `behavior ${observer.name} stale snapshot`,[visible,visible],observer.epoch-2]);
    await ownerPool.query(`INSERT INTO observations (workspace_id,world_id,worldline_id,record_id,id,
      observer_character_instance_id,dedupe_key,observation_kind,content,fidelity,occurred_tick,occurred_ordinal,
      available_from_tick,available_from_ordinal,learned_at,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$5,'direct',$7,0.75,$8,$9,$8,$9,'2026-10-17T00:01:02.345Z',$10::jsonb)`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,SCOPE.recordId,`behavior_obs_${observer.name}`,observer.instance,
      `behavior ${observer.name} observation`,sourceHead.head_tick,sourceHead.head_ordinal,JSON.stringify({ literalId: visible })]);
    if (!legacy) {
      // Actual writer's legitimate Record/non-observation provenance.
      await repository.upsertRelationshipAuthorized({ ...scope, targetEntityKey: `behavior:${observer.name}:writer`,
        relationKind: "trust", content: `behavior ${observer.name} writer relationship`, fidelity: 0.625 });
      const row = (await ownerPool.query(`SELECT source_record_id,source_observation_id FROM relationship_states
        WHERE workspace_id=$1 AND observer_continuity_id=$2 AND target_entity_key=$3`,
      [SCOPE.workspaceId,observer.continuity,`behavior:${observer.name}:writer`])).rows[0]!;
      assert.deepEqual(row,{ source_record_id:SCOPE.recordId,source_observation_id:null });
      // Writer has no observation/null-source input. Seed those supported wire
      // forms honestly, including a delayed paired row for each real observer.
      await ownerPool.query(`INSERT INTO relationship_states (workspace_id,world_id,worldline_id,observer_continuity_id,
        target_entity_key,relation_kind,content,fidelity,source_record_id,source_observation_id,
        occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
        VALUES ($1,$2,$3,$4,$5,'note',$6,0.5,$7,$8,$9,$10,$9,$11),
          ($1,$2,$3,$4,$12,'note',$13,0.375,NULL,NULL,$9,$10,$9,$10)`,
      [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,observer.continuity,`behavior:${observer.name}:paired`,
        `behavior ${observer.name} paired delayed`,SCOPE.recordId,`behavior_obs_${observer.name}`,
        sourceHead.head_tick,sourceHead.head_ordinal,sourceHead.head_ordinal+1,`behavior:${observer.name}:null`,
        `behavior ${observer.name} null relationship`]);
    }
  }
  if (!legacy) {
    const empty = await repository.createSnapshotAuthorized({ ...SCOPE, characterInstanceId:POSTGRES_DEMO_IDS.scholarInstance,
      snapshotId:"behavior_empty_snapshot",snapshotKind:"recall",content:"",itemIds:[],tokenCount:0 });
    assert.ok(empty); assert.equal(empty.content, ""); assert.deepEqual(empty.itemIds, []); assert.equal(empty.tokenCount, 0);
    // Explicit coherent missing-counter/zero-snapshot source-state control.
    await ownerPool.query(`DELETE FROM memory_cache_epochs WHERE workspace_id=$1 AND observer_continuity_id=$2`,
      [SCOPE.workspaceId, POSTGRES_DEMO_IDS.scholarContinuity]);
  }
  return { ...db, repository, sourceHead, observers };
}

/** Genuine SQL discovery plus actual restricted consumers; also embedded below
 * in new Node processes. Only Record ID and workspace are supplied, no maps. */
async function readBehaviorState(pool: pg.Pool, workspaceId: string, recordId: string) {
  const durable = await withWorkspaceTransaction(pool, workspaceId, async (client) => {
    const scope = (await client.query<{ world_id: string; worldline_id: string; story_id: string }>(
      `SELECT world_id,worldline_id,story_id FROM records WHERE workspace_id=$1 AND id=$2`, [workspaceId,recordId])).rows[0];
    assert.ok(scope);
    const role = (await client.query<{ current_user:string; rolsuper:boolean; rolbypassrls:boolean }>(
      `SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]!;
    assert.equal(role.current_user,"realm_runtime");assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
    const image = await exactLineImage(client as unknown as pg.Pool, workspaceId, scope.world_id, scope.worldline_id);
    const instances = (await client.query<{ id:string; continuity_key:string; continuity_id:string }>(
      `SELECT i.id,c.continuity_key,i.continuity_id FROM character_instances i JOIN character_continuities c
        ON c.workspace_id=i.workspace_id AND c.id=i.continuity_id
       WHERE i.workspace_id=$1 AND i.record_id=$2 ORDER BY c.continuity_key`,[workspaceId,recordId])).rows;
    return {scope:{ workspaceId,worldId:scope.world_id,worldlineId:scope.worldline_id,recordId,storyId:scope.story_id },role,image,instances};
  }, {readOnly:true,isolationLevel:"repeatable read"});
  const repository = createPostgresCharacterMemoryRepository(pool);
  const consumers = [];
  for (const instance of durable.instances) {
    const scope={...durable.scope,characterInstanceId:instance.id};
    const snapshots=imageRows(durable.image,"memory_snapshots").filter(row=>row.observer_continuity_id===instance.continuity_id);
    const deltas=[];
    for(const snapshot of snapshots) deltas.push({snapshotId:String(snapshot.id),content:String(snapshot.content),
      result:await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)})});
    const recall=await repository.recallAuthorized({...scope,query:"behavior",keywords:["behavior"],embedding:[1,...Array(383).fill(0)],embeddingModel:"behavior-local",limit:20});
    const relationships=await repository.relationshipsAuthorized({...scope,limit:20});
    consumers.push({continuityKey:instance.continuity_key,continuityId:instance.continuity_id,characterInstanceId:instance.id,deltas,recall,relationships});
  }
  return {pid:process.pid,...durable,consumers};
}
type BehaviorState = Awaited<ReturnType<typeof readBehaviorState>>;

function assertBehaviorEquivalent(source: BehaviorState, target: BehaviorState, maps: ReturnType<typeof assertTransportedArchive>) {
  const inverse=(kind:string,value:string)=>{
    const found=Object.entries(maps[kind]!).find(([,id])=>id===value);assert.ok(found,`consumer ${kind} mapped`);return found[0];
  };
  const normalize=(state:BehaviorState,remap:boolean)=>state.consumers.map(consumer=>({
    continuityKey:consumer.continuityKey,
    continuityId:remap?inverse("continuity",consumer.continuityId):consumer.continuityId,
    characterInstanceId:remap?inverse("instance",consumer.characterInstanceId):consumer.characterInstanceId,
    deltas:consumer.deltas.map(delta=>({snapshotId:remap?inverse("snapshot",delta.snapshotId):delta.snapshotId,content:delta.content,
      result:delta.result===null?null:{...delta.result,items:delta.result.items.map(item=>({...item,
        id:remap?inverse("conclusion",item.id):item.id,observerContinuityId:remap?inverse("continuity",item.observerContinuityId):item.observerContinuityId}))}}))
      .sort((a,b)=>a.content.localeCompare(b.content)),
    recall:consumer.recall.map(item=>({...item,id:remap?inverse("conclusion",item.id):item.id,
      observerContinuityId:remap?inverse("continuity",item.observerContinuityId):item.observerContinuityId})),
    // These storage audit times are not transported. Compare the entire
    // semantic relationship set; SQL's audit-time ordering is not identity.
    relationships:consumer.relationships.map(({createdAt,updatedAt,...item})=>{
      assert.ok(createdAt&&updatedAt);return {...item,observerContinuityId:remap?inverse("continuity",item.observerContinuityId):item.observerContinuityId};
    }).sort((a,b)=>`${a.targetEntityKey}/${a.relationKind}`.localeCompare(`${b.targetEntityKey}/${b.relationKind}`)),
  }));
  assert.deepEqual(normalize(target,true),normalize(source,false));
}

function behaviorSqlChildSource() {
  return `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "${projectRoot}/node_modules/pg/lib/index.js";
import { withWorkspaceTransaction,createPostgresCharacterMemoryRepository } from "${projectRoot}/database/postgres/public.ts";
const exactLineImage=${exactLineImage.toString()};
const imageRows=${imageRows.toString()};
const readBehaviorState=${readBehaviorState.toString()};
const payload=JSON.parse(await readFile(process.argv[2],"utf8"));
const pool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:2});
const fixtureShutdowns = new WeakMap();
const fixtureLiveClients = new WeakMap();
${observeFixturePool.toString()}
${awaitFixtureClients.toString()}
observeFixturePool(pool);
try { console.log(JSON.stringify(await readBehaviorState(pool,payload.workspaceId,payload.recordId))); }
catch(error) {console.log(JSON.stringify({pid:process.pid,failed:true,code:typeof error?.code==="string"&&/^[A-Z0-9_]+$/.test(error.code)?error.code:"CHILD_FAILED"}));process.exitCode=1;}
finally {await pool.end();await awaitFixtureClients(pool);}
`;
}

async function runBehaviorChild<R extends {pid:number}>(childPath:string,payload:object,runtimeUrl:string):Promise<R> {
  // No credential, cookie or session value may enter payload/argv/evidence.
  assert.doesNotMatch(JSON.stringify(payload),/postgres(?:ql)?:\/\/|realm_session=/);
  const payloadPath=`${childPath}.${randomUUID()}.payload.json`;
  await writeFile(payloadPath,JSON.stringify(payload));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--experimental-strip-types",childPath,payloadPath],{
      env:{...process.env,REALM_RUNTIME_DATABASE_URL:runtimeUrl,REALM_OPERATOR_PRINCIPALS:POSTGRES_DEMO_IDS.principal},stdio:["ignore","pipe","pipe"]});
    let stdout="",stderrBytes=0;
    child.stdout.on("data",(chunk:Buffer)=>{stdout+=chunk.toString("utf8");});
    child.stderr.on("data",(chunk:Buffer)=>{stderrBytes+=chunk.length;});
    child.on("error",()=>reject(new Error("Behavior child could not start.")));
    child.on("close",status=>{
      // Never dump a child request, URI, stderr or arbitrary exception text.
      if(status!==0){reject(new Error(`Behavior child exited ${status}; stderr bytes ${stderrBytes}.`));return;}
      try {const result=JSON.parse(stdout.trim().split("\n").at(-1)??"{}");assert.ok(result.pid>0);assert.notEqual(result.failed,true);resolve(result as R);}
      catch {reject(new Error("Behavior child returned invalid redacted output."));}
    });
  });
}

async function behaviorFreshCycle(t:test.TestContext,db:Awaited<ReturnType<typeof seedBehavior>>) {
  const {ownerPool,runtimePool,runtimeUrl}=db;
  const scratch=await mkdtemp(join(tmpdir(),"f4a2-behavior-child-"));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const handler=join(scratch,"handler.ts"),sqlChild=join(scratch,"sql-consumer.ts");
  // Attributed additive wrapper of inherited handler program; errors expose
  // only a stable code, and both success/error paths close the handler pools.
  await writeFile(handler,childProgramSource().replace("await run();\nawait endSharedRuntimePools();",
    'try {await run();} catch {console.log(JSON.stringify({pid:process.pid,failed:true,code:"HANDLER_FAILED"}));process.exitCode=1;} finally {await endSharedRuntimePools();}'));
  await writeFile(sqlChild,behaviorSqlChildSource());
  const sourceBefore=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId);
  const sharedBefore=await sharedAuthorityImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,imageRows(sourceBefore,"character_definitions").map(row=>String(row.id)));
  const source=await readBehaviorState(runtimePool,SCOPE.workspaceId,SCOPE.recordId);
  const sourcePath=join(scratch,"source.realm"),targetPath=join(scratch,"target.realm");
  const beforeSave=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const save=await runBehaviorChild<SaveChildResult>(handler,{mode:"save",recordId:SCOPE.recordId,artifactPath:sourcePath,principalId:POSTGRES_DEMO_IDS.principal},runtimeUrl);
  assert.equal(save.status,200);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeSave);
  const archive=parseRealmRuntimeSaveArchive(new Uint8Array(await readFile(sourcePath)));
  const first=await runBehaviorChild<RestoreChildResult>(handler,{mode:"restore",artifactPath:sourcePath,targetWorldId:SCOPE.worldId,
    idempotencyKey:"behavior-fresh-first",principalId:POSTGRES_DEMO_IDS.principal},runtimeUrl);
  assert.equal(first.status,201);assert.equal(first.replayed,false);assert.ok(first.recordId);
  const firstSql=await runBehaviorChild<BehaviorState>(sqlChild,{workspaceId:SCOPE.workspaceId,recordId:first.recordId},runtimeUrl);
  const firstMaps=assertTransportedArchive(archive,firstSql.image,firstSql.scope);
  assertBehaviorEquivalent(source,firstSql,firstMaps);
  assert.deepEqual(firstSql.image,await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,firstSql.scope.worldlineId));
  const beforeResave=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const resave=await runBehaviorChild<SaveChildResult>(handler,{mode:"save",recordId:firstSql.scope.recordId,artifactPath:targetPath,principalId:POSTGRES_DEMO_IDS.principal},runtimeUrl);
  assert.equal(resave.status,200);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeResave);
  const resaved=parseRealmRuntimeSaveArchive(new Uint8Array(await readFile(targetPath)));
  assertTransportedArchive(resaved,firstSql.image,firstSql.scope,false);
  const second=await runBehaviorChild<RestoreChildResult>(handler,{mode:"restore",artifactPath:targetPath,targetWorldId:SCOPE.worldId,
    idempotencyKey:"behavior-fresh-second",principalId:POSTGRES_DEMO_IDS.principal},runtimeUrl);
  assert.equal(second.status,201);assert.equal(second.replayed,false);assert.ok(second.recordId);
  const secondSql=await runBehaviorChild<BehaviorState>(sqlChild,{workspaceId:SCOPE.workspaceId,recordId:second.recordId},runtimeUrl);
  const secondMaps=assertTransportedArchive(resaved,secondSql.image,secondSql.scope);
  assertBehaviorEquivalent(firstSql,secondSql,secondMaps);
  assert.deepEqual(secondSql.image,await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,secondSql.scope.worldlineId));
  const pids=[save.pid,first.pid,firstSql.pid,resave.pid,second.pid,secondSql.pid];
  assert.equal(new Set(pids).size,6);assert.ok(pids.every(pid=>pid!==process.pid));
  assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sourceBefore);
  assert.deepEqual(await sharedAuthorityImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,imageRows(sourceBefore,"character_definitions").map(row=>String(row.id))),sharedBefore);
  await saveRuntimeEvidence("behavior-B1-B2-B4-cycle",{archive,resaved,source,firstSql,secondSql,firstMaps,secondMaps,pids,sourceBefore,sharedBefore,
    sourceAfter:await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sqlChildren:true,credentials:"environment only"});
  return {archive,source,firstSql,secondSql,firstMaps,secondMaps};
}

test("F4a2-B B1 B2 B4 coherent observers, real relationship/snapshot writers and fresh SQL consumer cycle",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const db=await seedBehavior(t);
  const {ownerPool,runtimePool,sourceHead}=db;
  const cycle=await behaviorFreshCycle(t,db);
  assert.equal(cycle.archive.memory?.schemaVersion,2);
  if(cycle.archive.memory?.schemaVersion!==2)throw new Error("Behavior fixture requires MemoryV2.");
  const epochs=new Map(cycle.archive.memory.cacheEpochs.map(row=>[row.sourceObserverContinuityId,row.epoch]));
  assert.equal(epochs.get(POSTGRES_DEMO_IDS.playerContinuity),3);assert.equal(epochs.get(POSTGRES_DEMO_IDS.scoutContinuity),7);
  assert.equal(epochs.get(POSTGRES_DEMO_IDS.scholarContinuity),0);
  for(const state of [cycle.source,cycle.firstSql,cycle.secondSql]){
    const head=imageRows(state.image,"worldlines")[0]!;
    assertColumns(head,{head_tick:sourceHead.head_tick,head_ordinal:sourceHead.head_ordinal});
    for(const consumer of state.consumers){
      assert.ok(consumer.recall.every(row=>!row.content.includes("delayed")));
      assert.ok(consumer.relationships.every(row=>!row.content.includes("delayed")));
      for(const delta of consumer.deltas){
        assert.ok(delta.result);assert.ok(delta.result.items.every(row=>!row.content.includes("delayed")));
        assert.equal(delta.result.stale,delta.content.includes("stale"));
      }
    }
    const empty=onlyRow(imageRows(state.image,"memory_snapshots"),row=>row.content==="","real empty snapshot row");
    assertColumns(empty,{item_ids:[],token_count:0,cache_epoch:0});
  }
  const restorer=createPostgresRealmRuntimeSaveRestorer(runtimePool);
  const negativeScope={...SCOPE,principalId:POSTGRES_DEMO_IDS.principal};
  for(const [label,mutate] of [
    ["future-snapshot",(bad:RealmRuntimeSaveArchive)=>{bad.memory!.snapshots=bad.memory!.snapshots.map(row=>({...row,cacheEpoch:99}));}],
    ["missing-counter-nonzero",(bad:RealmRuntimeSaveArchive)=>{if(bad.memory?.schemaVersion===2)bad.memory.cacheEpochs=bad.memory.cacheEpochs.map(row=>({...row,epoch:0}));}],
    ["wrong-epoch-observer",(bad:RealmRuntimeSaveArchive)=>{if(bad.memory?.schemaVersion===2)bad.memory.cacheEpochs[0]!.sourceObserverContinuityId="missing-observer";}],
    ["relationship-observation-only",(bad:RealmRuntimeSaveArchive)=>{const row=bad.memory!.relationshipStates.find(row=>row.sourceObservationId!==null)!;row.sourceRecordId=null;}],
    ["relationship-wrong-record",(bad:RealmRuntimeSaveArchive)=>{bad.memory!.relationshipStates.find(row=>row.sourceObservationId!==null)!.sourceRecordId="not-carried-record";}],
    ["relationship-wrong-observer",(bad:RealmRuntimeSaveArchive)=>{bad.memory!.relationshipStates.find(row=>row.sourceObservationId!==null)!.sourceObserverContinuityId=POSTGRES_DEMO_IDS.scholarContinuity;}],
  ] as const){const bad=structuredClone(cycle.archive);mutate(bad);await assertRuntimeInvalid(ownerPool,restorer,negativeScope,bad,`behavior-${label}`);}

  // Actual missing SQL counter with retained nonzero snapshots. Fixture edits
  // are outside the read-only rejection window, and restore exact seed bytes.
  const savedEpoch=(await ownerPool.query<{epoch:number;updated_at:string}>(`SELECT epoch,updated_at::text FROM memory_cache_epochs
    WHERE workspace_id=$1 AND observer_continuity_id=$2`,[SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity])).rows[0]!;
  await ownerPool.query(`DELETE FROM memory_cache_epochs WHERE workspace_id=$1 AND observer_continuity_id=$2`,[SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity]);
  try {
    const before=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
    await assert.rejects(createPostgresRealmRuntimeSaveReader(runtimePool).load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }),
      {code:"RUNTIME_SAVE_INVALID",message:"Memory cache epoch precedes a retained snapshot."});
    const after=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);assert.deepEqual(after,before);
    await saveRuntimeEvidence("behavior-B1-missing-source-counter",{before,after,expectedCode:"RUNTIME_SAVE_INVALID"});
  } finally {
    await ownerPool.query(`INSERT INTO memory_cache_epochs (workspace_id,observer_continuity_id,epoch,updated_at) VALUES ($1,$2,$3,$4::timestamptz)`,
      [SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity,savedEpoch.epoch,savedEpoch.updated_at]);
  }
  assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),cycle.source.image);

  // Actual committed runtime continuation, with scoped IDs discovered in SQL.
  // No SQL clock advance is used to reveal delayed rows.
  const progress=[];
  for(const before of [cycle.source,cycle.firstSql]){
    const scope=before.scope;
    const head=onlyRow(imageRows(before.image,"record_heads"),row=>row.record_id===scope.recordId,"continuation Record head");
    const scene=onlyRow(imageRows(before.image,"scenes"),row=>row.record_id===scope.recordId&&row.status==="active","continuation scene");
    const policy=onlyRow(imageRows(before.image,"visibility_policies"),row=>row.record_id===scope.recordId&&row.policy_kind==="public","continuation policy");
    const world=createPostgresWorldCommandRepository({pool:runtimePool,workspaceId:scope.workspaceId});
    const cursor=await world.readWorldlineCursor(scope.worldlineId);assert.ok(cursor);
    const key=`behavior-progress-${randomUUID()}`;
    const plan=buildCommandPlan({request:{scope,primaryRecordId:scope.recordId,touchedRecords:[{recordId:scope.recordId,expectedRecordVersion:Number(head.record_version)}],
      idempotencyKey:key,payload:{intent:"continue restored memory"}},expectedWorldCursor:cursor,
      effects:[{recordId:scope.recordId,events:[{eventId:`event_${key}`,kind:"narration.committed",sceneId:String(scene.id),visibilityPolicyId:String(policy.id),
        content:"behavior normal runtime progression",payload:{}}]}]});
    const committed=await world.commitWorldCommand(plan,"2026-10-17T00:02:00.000Z");assert.equal(committed.state,"committed");
    const after=await readBehaviorState(runtimePool,scope.workspaceId,scope.recordId);
    assertColumns(imageRows(after.image,"worldlines")[0]!,{head_tick:cursor.tick,head_ordinal:cursor.ordinal+1});
    for(const consumer of after.consumers.filter(row=>row.recall.length>0)){
      assert.equal(consumer.recall.filter(row=>row.content.includes("delayed")).length,1);
      assert.equal(consumer.relationships.filter(row=>row.content.includes("paired delayed")).length,1);
      const fresh=consumer.deltas.find(row=>row.content.includes("fresh"))!;assert.ok(fresh.result);assert.equal(fresh.result.stale,false);
      assert.equal(fresh.result.items.length,1);assert.ok(fresh.result.items[0]!.content.includes("delayed"));
      assert.ok(consumer.deltas.find(row=>row.content.includes("stale"))!.result!.stale);
    }
    progress.push({before,committed,after});
  }
  assertBehaviorEquivalent(progress[0]!.after,progress[1]!.after,cycle.firstMaps);
  // Actual add/update/retract in the restored scope; discover each new ID by
  // its unique semantic content, never by the writer's deterministic formula.
  const state=progress[1]!.after,consumer=state.consumers.find(row=>row.continuityId===cycle.firstMaps.continuity![POSTGRES_DEMO_IDS.playerContinuity])!;
  const scope={...state.scope,characterInstanceId:consumer.characterInstanceId};
  const repository=createPostgresCharacterMemoryRepository(runtimePool), revisions=[];
  let parent:string|undefined;
  for(const operation of ["add","update","retract"] as const){
    const before=await exactLineImage(ownerPool,scope.workspaceId,scope.worldId,scope.worldlineId);
    const content=`behavior restored ${operation}`;await appendBehavior(repository,scope,content,operation,parent);
    const after=await exactLineImage(ownerPool,scope.workspaceId,scope.worldId,scope.worldlineId);
    const row=onlyRow(imageRows(after,"memory_conclusions"),row=>row.content===content,"ordinary writer result");
    assertColumns(row,{operation,supersedes_memory_id:parent??null,observer_continuity_id:consumer.continuityId});parent=String(row.id);
    const oldEpoch=onlyRow(imageRows(before,"memory_cache_epochs"),row=>row.observer_continuity_id===consumer.continuityId,"old epoch").epoch as number;
    const newEpoch=onlyRow(imageRows(after,"memory_cache_epochs"),row=>row.observer_continuity_id===consumer.continuityId,"new epoch").epoch;
    assert.equal(newEpoch,oldEpoch+(operation==="add"?0:1));
    const snapshot=onlyRow(imageRows(after,"memory_snapshots"),row=>row.content==="behavior player fresh snapshot","delta snapshot");
    const delta=await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)});assert.ok(delta);
    assert.equal(delta.stale,operation!=="add");assert.equal(delta.cacheEpoch,newEpoch);
    if(operation==="add")assert.ok(delta.items.some(item=>item.id===row.id));
    const recall=await repository.recallAuthorized({...scope,query:"behavior",keywords:["behavior"],embedding:BEHAVIOR_VECTOR,embeddingModel:"behavior-local",limit:20});
    if(operation==="retract")assert.ok(recall.every(item=>!item.content.startsWith("behavior restored")));
    else assert.ok(recall.some(item=>item.id===row.id));
    revisions.push({operation,before,after,delta,recall});
  }
  await saveRuntimeEvidence("behavior-B1-B2-continuation",{progress,revisions,clockControl:"real commitWorldCommand; no direct clock edits"});
});

// Delegating instrumentation: every statement and result still comes from real
// PostgreSQL. The callback can inspect a reached phase or issue a real SQL
// failure; no fake rows, production failpoints or writer modifications.
function behaviorInstrumentPool(pool:pg.Pool, around:(client:pg.PoolClient,sql:string,values:unknown[]|undefined,
  execute:()=>Promise<pg.QueryResult>)=>Promise<pg.QueryResult>):pg.Pool {
  return new Proxy(pool,{get(target,key){
    if(key!=="connect"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
    return async()=>{
      const client=await target.connect();
      return new Proxy(client,{get(connection,property){
        if(property==="query")return (sql:string,values?:unknown[])=>around(connection,sql,values,()=>connection.query(sql,values));
        const value=Reflect.get(connection,property);return typeof value==="function"?value.bind(connection):value;
      }});
    };
  }});
}

function behaviorTargetScope(archive:RealmRuntimeSaveArchive,image:SqlImage,sourceContinuityId:string,recordId:string):BehaviorConsumerScope {
  const participant=archive.topology!.participants.find(row=>row.character?.sourceContinuityId===sourceContinuityId)!;
  assert.ok(participant?.character);
  const continuity=onlyRow(imageRows(image,"character_continuities"),row=>row.continuity_key===participant.character!.continuity.continuityKey,"actual target continuity");
  const instance=onlyRow(imageRows(image,"character_instances"),row=>row.continuity_id===continuity.id&&row.record_id===recordId,"actual target instance");
  return {workspaceId:String(instance.workspace_id),worldId:String(instance.world_id),worldlineId:String(instance.worldline_id),recordId,characterInstanceId:String(instance.id)};
}

test("F4a2-B B3 authored legacy maxima stay stale through real revisions and int32 overflow rolls back",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const {ownerPool,runtimePool}=await seedBehavior(t,true);
  const reader=createPostgresRealmRuntimeSaveReader(runtimePool),restorer=createPostgresRealmRuntimeSaveRestorer(runtimePool);
  const exportBefore=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const original=await reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(original);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),exportBefore);
  assert.ok(original.memory?.schemaVersion===2);
  const sourceBefore=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId);
  // Explicitly authored honest V1 archive, not a claim that the V2 reader
  // emitted V1 or recovered an unknowable legacy current epoch/head.
  const legacy=structuredClone(original);
  const maxima=[{observer:POSTGRES_DEMO_IDS.playerContinuity,epochs:[0,2,5]},
    {observer:POSTGRES_DEMO_IDS.scoutContinuity,epochs:[1,4]}];
  const snapshots=maxima.flatMap(({observer,epochs})=>{
    const basis=original.memory!.snapshots.find(row=>row.sourceObserverContinuityId===observer)!;
    return epochs.map(epoch=>({...basis,sourceSnapshotId:`legacy_${observer}_${epoch}`,content:`legacy ${observer} epoch ${epoch}`,cacheEpoch:epoch}));
  });
  legacy.memory={format:"realm-runtime-memory",schemaVersion:1,conclusions:structuredClone(original.memory.conclusions),snapshots,relationshipStates:[]};
  legacy.manifest=realmRuntimeSaveManifestFromData({...legacy,...legacy.manifest});
  const bytes=buildRealmRuntimeSaveArchive(legacy),frozenBytes=bytes.slice();
  const parsed=parseRealmRuntimeSaveArchive(bytes);assert.equal(parsed.memory?.schemaVersion,1);
  const imported=await restorer.restore({workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,
    targetWorldId:SCOPE.worldId,archive:parsed,idempotencyKey:"behavior-legacy-revisions"});
  const initial=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,imported.worldlineId);
  const retained=imageRows(initial,"memory_snapshots");assert.equal(retained.length,5);
  const revisions=[];
  for(const {observer,epochs} of maxima){
    const scope=behaviorTargetScope(parsed,initial,observer,imported.recordId);
    const continuity=onlyRow(imageRows(initial,"character_instances"),row=>row.id===scope.characterInstanceId,"legacy consumer instance").continuity_id;
    const start=Math.max(...epochs)+1;
    assert.equal(onlyRow(imageRows(initial,"memory_cache_epochs"),row=>row.observer_continuity_id===continuity,"legacy max+1").epoch,start);
    const sourceName=observer===POSTGRES_DEMO_IDS.playerContinuity?"player":"scout";
    const sourceToTarget=new Map(parsed.memory!.conclusions.map(row=>[row.sourceMemoryId,
      onlyRow(imageRows(initial,"memory_conclusions"),target=>target.content===row.content,"legacy conclusion typed map").id]));
    for(const snapshot of snapshots.filter(row=>row.sourceObserverContinuityId===observer)){
      const row=onlyRow(retained,row=>row.content===snapshot.content,"legacy snapshot");
      assertColumns(row,{observer_continuity_id:continuity,cache_epoch:snapshot.cacheEpoch,cursor_tick:snapshot.cursorTick,
        cursor_ordinal:snapshot.cursorOrdinal,item_ids:snapshot.sourceItemIds.map(id=>sourceToTarget.get(id)),token_count:snapshot.tokenCount});
    }
    const repository=createPostgresCharacterMemoryRepository(runtimePool);
    for(const snapshot of retained.filter(row=>row.observer_continuity_id===continuity))assert.deepEqual(
      await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)}),{stale:true,cacheEpoch:start,items:[]});
    let parent=String(onlyRow(imageRows(initial,"memory_conclusions"),row=>row.content===`behavior ${sourceName} visible`,"legacy revision parent").id);
    for(let revision=1;revision<=4;revision++){
      const operation=revision%2===1?"update":"retract";
      const before=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
      const content=`behavior legacy ${sourceName} revision ${revision}`;
      await appendBehavior(repository,scope,content,operation,parent);
      const after=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,imported.worldlineId);
      const row=onlyRow(imageRows(after,"memory_conclusions"),row=>row.content===content,"distinct successful revision");
      assertColumns(row,{operation,supersedes_memory_id:parent,observer_continuity_id:continuity});assert.notEqual(row.id,parent);parent=String(row.id);
      assert.equal(onlyRow(imageRows(after,"memory_cache_epochs"),row=>row.observer_continuity_id===continuity,"monotonic epoch").epoch,start+revision);
      assert.deepEqual(imageRows(after,"memory_snapshots"),retained,"no dropped/rewritten snapshot, cursor or item");
      const deltas=[];
      for(const snapshot of retained.filter(row=>row.observer_continuity_id===continuity)){
        const delta=await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)});
        assert.deepEqual(delta,{stale:true,cacheEpoch:start+revision,items:[]});deltas.push({snapshotId:snapshot.id,delta});
      }
      assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sourceBefore);
      revisions.push({observer,revision,operation,before,after,deltas,sourceToTarget:Object.fromEntries(sourceToTarget)});
    }
  }
  const scholarScope=behaviorTargetScope(parsed,initial,POSTGRES_DEMO_IDS.scholarContinuity,imported.recordId);
  const scholarContinuity=onlyRow(imageRows(initial,"character_instances"),row=>row.id===scholarScope.characterInstanceId,"legacy no-snapshot instance").continuity_id;
  assert.equal(onlyRow(imageRows(initial,"memory_cache_epochs"),row=>row.observer_continuity_id===scholarContinuity,"legacy no snapshots gives zero").epoch,0);
  assert.deepEqual(bytes,frozenBytes);assert.equal(parseRealmRuntimeSaveArchive(bytes).manifest.snapshot.runtimeHash,parsed.manifest.snapshot.runtimeHash);
  const exhausted=structuredClone(parsed);exhausted.memory!.snapshots[0]!.cacheEpoch=2147483647;
  await assertRuntimeInvalid(ownerPool,restorer,{...SCOPE,principalId:POSTGRES_DEMO_IDS.principal},exhausted,"behavior-legacy-MAX","Legacy memory cache epoch is exhausted.");

  const overflow=[];
  for(const mode of ["legacy-MAX-1","V2-MAX","V2-MAX-1"] as const){
    const archive=structuredClone(mode==="legacy-MAX-1"?parsed:original);
    const initialEpoch=mode==="V2-MAX-1"?2147483646:2147483647;
    if(mode==="legacy-MAX-1")archive.memory!.snapshots=archive.memory!.snapshots.map(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity?{...row,cacheEpoch:2147483646}:row);
    else if(archive.memory?.schemaVersion===2){
      archive.memory.cacheEpochs=archive.memory.cacheEpochs.map(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity?{...row,epoch:initialEpoch}:row);
      archive.memory.snapshots=archive.memory.snapshots.map(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity?{...row,cacheEpoch:initialEpoch}:row);
    }
    archive.manifest=realmRuntimeSaveManifestFromData({...archive,...archive.manifest});
    const result=await restorer.restore({workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,targetWorldId:SCOPE.worldId,
      archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)),idempotencyKey:`behavior-overflow-${mode}`});
    const target=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,result.worldlineId);
    const scope=behaviorTargetScope(archive,target,POSTGRES_DEMO_IDS.playerContinuity,result.recordId);
    const continuity=onlyRow(imageRows(target,"character_instances"),row=>row.id===scope.characterInstanceId,"overflow consumer").continuity_id;
    assert.equal(onlyRow(imageRows(target,"memory_cache_epochs"),row=>row.observer_continuity_id===continuity,"overflow initial epoch").epoch,initialEpoch);
    const repository=createPostgresCharacterMemoryRepository(runtimePool);
    const retainedSnapshots=imageRows(target,"memory_snapshots");
    // Ordinary add is legal even at MAX and does not invalidate the counter.
    await appendBehavior(repository,scope,`behavior ${mode} legal add`);
    let afterAdd=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,result.worldlineId);
    let parent=String(onlyRow(imageRows(afterAdd,"memory_conclusions"),row=>row.content===`behavior ${mode} legal add`,"MAX add inserted").id);
    assert.equal(onlyRow(imageRows(afterAdd,"memory_cache_epochs"),row=>row.observer_continuity_id===continuity,"add preserves epoch").epoch,initialEpoch);
    const equality=[];
    if(mode!=="legacy-MAX-1")for(const snapshot of retainedSnapshots.filter(row=>row.observer_continuity_id===continuity)){
      const delta=await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)});assert.ok(delta);assert.equal(delta.stale,false);assert.equal(delta.cacheEpoch,initialEpoch);equality.push(delta);
    }
    if(mode==="V2-MAX-1"){
      await appendBehavior(repository,scope,`behavior ${mode} last revision`,"update",parent);
      afterAdd=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,result.worldlineId);
      parent=String(onlyRow(imageRows(afterAdd,"memory_conclusions"),row=>row.content===`behavior ${mode} last revision`,"last increment inserted").id);
      assert.equal(onlyRow(imageRows(afterAdd,"memory_cache_epochs"),row=>row.observer_continuity_id===continuity,"last increment reaches MAX").epoch,2147483647);
    }
    const before=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),transcript:object[]=[];
    let reachedConclusion=false,code:string|undefined;
    const watched=behaviorInstrumentPool(runtimePool,async(client,sql,values,execute)=>{
      if(/INSERT INTO memory_cache_epochs/.test(sql)){
        const inserted=(await client.query(`SELECT id,operation FROM memory_conclusions WHERE workspace_id=$1 AND observer_continuity_id=$2 AND content=$3`,
          [scope.workspaceId,continuity,`behavior ${mode} overflow revision`])).rows;
        assert.equal(inserted.length,1);assert.equal(inserted[0]!.operation,"retract");reachedConclusion=true;
        transcript.push({phase:"before real overflowing epoch increment",uncommittedConclusion:inserted});
      }
      try {const answer=await execute();if(/INSERT INTO memory_conclusions/.test(sql))transcript.push({phase:"real conclusion INSERT",rowCount:answer.rowCount});return answer;}
      catch(error){transcript.push({phase:"SQL failure",code:(error as {code?:string}).code});throw error;}
    });
    try {await appendBehavior(createPostgresCharacterMemoryRepository(watched),scope,`behavior ${mode} overflow revision`,"retract",parent);}
    catch(error){code=(error as {code?:string}).code;}
    const after=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
    await saveRuntimeEvidence("behavior-B3-overflow",{mode,archive,result,target,scope,initialEpoch,equality,before,after,code,reachedConclusion,transcript});
    assert.equal(code,"22003");assert.equal(reachedConclusion,true);assert.deepEqual(after,before,"overflow rolls back conclusion/counter/timestamps and every World row");
    const afterFailure=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,result.worldlineId);
    assert.deepEqual(imageRows(afterFailure,"memory_snapshots"),retainedSnapshots);
    for(const snapshot of retainedSnapshots.filter(row=>row.observer_continuity_id===continuity)){
      const delta=await repository.deltaAuthorized({...scope,snapshotId:String(snapshot.id)});assert.ok(delta);
      assert.equal(delta.cacheEpoch,2147483647);assert.equal(delta.stale,mode!=="V2-MAX");
    }
    assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sourceBefore);
    overflow.push({mode,result,code,reachedConclusion});
  }
  assert.deepEqual(bytes,frozenBytes);
  await saveRuntimeEvidence("behavior-B3-legacy",{legacyArchive:parsed,legacyBytes:Array.from(bytes),runtimeHash:parsed.manifest.snapshot.runtimeHash,
    authoredLegacy:true,sourceBefore,sourceAfter:await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),initial,revisions,overflow});
});

test("F4a2-B B5 real late SQL failures roll back all restore phases then same-key retry and replay",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const {ownerPool,runtimePool}=await seedBehavior(t);
  const seeded=await readBehaviorState(runtimePool,SCOPE.workspaceId,SCOPE.recordId);
  const scene=onlyRow(imageRows(seeded.image,"scenes"),row=>row.record_id===SCOPE.recordId&&row.status==="active","late failure scene");
  const policy=onlyRow(imageRows(seeded.image,"visibility_policies"),row=>row.record_id===SCOPE.recordId&&row.policy_kind==="public","late failure policy");
  const head=onlyRow(imageRows(seeded.image,"record_heads"),row=>row.record_id===SCOPE.recordId,"late failure head");
  const world=createPostgresWorldCommandRepository({pool:runtimePool,workspaceId:SCOPE.workspaceId});
  const cursor=await world.readWorldlineCursor(SCOPE.worldlineId);assert.ok(cursor);
  const key="behavior-seed-committed-event";
  const plan=buildCommandPlan({request:{scope:SCOPE,primaryRecordId:SCOPE.recordId,touchedRecords:[{recordId:SCOPE.recordId,expectedRecordVersion:Number(head.record_version)}],
    idempotencyKey:key,payload:{intent:"late rollback fixture event"}},expectedWorldCursor:cursor,effects:[{recordId:SCOPE.recordId,
    events:[{eventId:"behavior_late_event",kind:"narration.committed",sceneId:String(scene.id),visibilityPolicyId:String(policy.id),content:"behavior late failure anchor",payload:{}}],
    outbox:[{messageId:"behavior_late_outbox",dedupeKey:"behavior-late-outbox",topic:"record.event.committed",payload:{proof:"behavior late rollback"}}]}]});
  assert.equal((await world.commitWorldCommand(plan,"2026-10-17T00:03:00.000Z")).state,"committed");
  const reader=createPostgresRealmRuntimeSaveReader(runtimePool);
  const beforeExport=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const loaded=await reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(loaded);
  assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeExport);
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded));
  const sourceBefore=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId);
  for(const phase of ["after-conclusions","after-all-memory"] as const){
    const before=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),transcript:object[]=[];
    let reached=false,epochs=0;
    const phaseCounts:Record<string,number>={};
    const expectedEpochs=archive.memory?.schemaVersion===2?archive.memory.cacheEpochs.length:0;assert.ok(expectedEpochs>1);
    const existingLines=new Set(imageRows(before,"worldlines").map(row=>row.id));
    const fault=async(client:pg.PoolClient)=>{
      const currentLines=(await client.query<{id:string}>(`SELECT id FROM worldlines WHERE workspace_id=$1 AND world_id=$2`,[SCOPE.workspaceId,SCOPE.worldId])).rows.filter(row=>!existingLines.has(row.id));
      assert.equal(currentLines.length,1);const targetLine=currentLines[0]!.id;
      for(const table of ["records","character_definitions","character_continuities","character_instances","events","observations","memory_conclusions","memory_snapshots","relationship_states","memory_cache_epochs","outbox"]){
        const condition=table==="memory_cache_epochs"?"observer_continuity_id IN (SELECT id FROM character_continuities WHERE workspace_id=$1 AND worldline_id=$2)"
          :table==="character_definitions"?"id IN (SELECT definition_id FROM character_continuities WHERE workspace_id=$1 AND worldline_id=$2)":"worldline_id=$2";
        phaseCounts[table]=Number((await client.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1 AND ${condition}`,
          [SCOPE.workspaceId,targetLine])).rows[0]!.n);
      }
      assert.ok(phaseCounts.records!>0&&phaseCounts.character_instances!>0&&phaseCounts.events!>0&&phaseCounts.observations!>0&&phaseCounts.memory_conclusions!>0&&phaseCounts.outbox!>0);
      transcript.push({phase,phaseCounts});reached=true;
      await client.query("SELECT 1 / 0 AS deterministic_late_restore_failure");
    };
    const watched=behaviorInstrumentPool(runtimePool,async(client,sql,values,execute)=>{
      if(phase==="after-conclusions"&&/INSERT INTO memory_snapshots/.test(sql))await fault(client);
      const result=await execute();
      const table=/INSERT INTO (\w+)/.exec(sql)?.[1];if(table)transcript.push({phase:"real INSERT completed",table,rowCount:result.rowCount});
      if(phase==="after-all-memory"&&table==="memory_cache_epochs"&&++epochs===expectedEpochs)await fault(client);
      return result;
    });
    const input={workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,targetWorldId:SCOPE.worldId,archive,idempotencyKey:`behavior-late-${phase}`};
    let code:string|undefined;
    try {await createPostgresRealmRuntimeSaveRestorer(watched).restore(input);}catch(error){code=(error as {code?:string}).code;}
    const after=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
    await saveRuntimeEvidence("behavior-B5-late-failure",{phase,before,after,code,reached,phaseCounts,transcript});
    assert.equal(code,"22012");assert.equal(reached,true);assert.deepEqual(after,before);
    if(phase==="after-all-memory"){
      assert.equal(phaseCounts.memory_snapshots,archive.memory!.snapshots.length);
      assert.equal(phaseCounts.relationship_states,archive.memory!.relationshipStates.length);
      assert.equal(phaseCounts.memory_cache_epochs,expectedEpochs);
    }
    const restorer=createPostgresRealmRuntimeSaveRestorer(runtimePool),retry=await restorer.restore(input);assert.equal(retry.replayed,false);
    const target=await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,retry.worldlineId);
    const maps=assertTransportedArchive(archive,target,{workspaceId:SCOPE.workspaceId,worldId:SCOPE.worldId,worldlineId:retry.worldlineId,recordId:retry.recordId,storyId:retry.storyId});
    const beforeReplay=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
    assert.equal((await restorer.restore(input)).replayed,true);
    assert.deepEqual(await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId),beforeReplay);
    const conflict=structuredClone(archive);conflict.memory!.conclusions[0]!.content="behavior valid changed late-retry body";
    conflict.manifest=realmRuntimeSaveManifestFromData({...conflict,...conflict.manifest});
    await assert.rejects(restorer.restore({...input,archive:conflict}),{code:"RESTORE_CONFLICT"});
    const afterReplay=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);assert.deepEqual(afterReplay,beforeReplay);
    assert.deepEqual(await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId),sourceBefore);
    await saveRuntimeEvidence("behavior-B5-retry",{phase,archive,retry,target,maps,beforeReplay,afterReplay,sourceBefore,
      sourceAfter:await exactLineImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId)});
  }
});

test("F4a3-M actual memory roots use bounded production-sized keyset pages", {
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const {ownerPool,runtimePool}=await createTempDatabase(t);
  await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,
    id,observed_entity_key,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
    occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    SELECT $1,$2,$3,$4,'resource_'||lpad(n::text,6,'0'),'entity:resource','add','explicit',
      'Resource row '||n,ARRAY['resource'],$5::vector,'resource-local',0.875,0,0,0,0,'{}'::jsonb
    FROM generate_series(1,2001) n`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,
      POSTGRES_DEMO_IDS.playerContinuity,vectorLiteral(BEHAVIOR_VECTOR)]);
  const transcript:object[]=[],scans:{sql:string;rows:number}[]=[];
  const pool=behaviorInstrumentPool(runtimePool,async(client,sql,values,execute)=>{
    const answer=await execute();
    if(/FROM memory_conclusions/.test(sql)){
      scans.push({sql,rows:answer.rows.length});
      transcript.push({sql,parameterCount:values?.length??0,rows:answer.rows.length,
        resultBytes:Buffer.byteLength(JSON.stringify(answer.rows)),backend:(await client.query("SELECT pg_backend_pid() pid,pg_current_snapshot()::text snapshot,pg_current_xact_id_if_assigned()::text xid,current_setting('transaction_read_only') read_only")).rows[0]});
    }
    return answer;
  });
  const before=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);
  const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const archive=await createPostgresRealmRuntimeSaveReader(pool).load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
  assert.ok(archive);assert.equal(archive.memory!.conclusions.length,2001);
  const after=await exactWorldImage(ownerPool,SCOPE.workspaceId,SCOPE.worldId);assert.deepEqual(after,before);
  await saveRuntimeEvidence("resources-production-pages",{transcript,beforeDigest:digest(before),afterDigest:digest(after),conclusions:archive.memory!.conclusions.length});
  assert.ok(scans.length>1&&scans.every(row=>/\bLIMIT\b/.test(row.sql)&&row.rows<=1000),
    "actual memory root scan must page before transferring all payload rows");
});

// Resource evidence keeps hashes/lengths/query summaries, never giant row images.
async function compactResourceState(pool:pg.Pool,line?:string):Promise<Record<string,string>>{
  const tables=(await pool.query<{table_name:string;has_line:boolean}>(`SELECT c.table_name,bool_or(c.column_name='worldline_id') has_line
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND t.table_type='BASE TABLE' GROUP BY c.table_name
    HAVING bool_or(c.column_name='workspace_id') AND (bool_or(c.column_name='world_id') OR c.table_name='worlds') ORDER BY c.table_name`)).rows;
  const result:Record<string,string>={};
  for(const {table_name:table,has_line} of tables){
    let predicate=`workspace_id=$1 AND ${table==='worlds'?'id':'world_id'}=$2`;const params:string[]=[SCOPE.workspaceId,SCOPE.worldId];
    if(line&&has_line){predicate+=' AND worldline_id=$3';params.push(line);}
    else if(line&&table==='worldlines'){predicate+=' AND id=$3';params.push(line);}
    else if(line&&table==='character_definitions'){predicate+=` AND id IN (SELECT definition_id FROM character_continuities WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3)`;params.push(line);}
    result[table]=(await pool.query(`SELECT md5(COALESCE(string_agg(digest,',' ORDER BY digest),'')) value
      FROM (SELECT md5(to_jsonb(t)::text) digest FROM ${quoteIdentifier(table)} t WHERE ${predicate}) hashed`,params)).rows[0]!.value as string;
  }
  result.memory_cache_epochs=(await pool.query(`SELECT md5(COALESCE(string_agg(digest,',' ORDER BY digest),'')) value FROM
    (SELECT md5(to_jsonb(e)::text) digest FROM memory_cache_epochs e JOIN character_continuities c
     ON c.workspace_id=e.workspace_id AND c.id=e.observer_continuity_id WHERE c.workspace_id=$1 AND c.world_id=$2
       ${line?'AND c.worldline_id=$3':''}) hashed`,line?[SCOPE.workspaceId,SCOPE.worldId,line]:[SCOPE.workspaceId,SCOPE.worldId])).rows[0]!.value as string;
  return result;
}

const resourceMetadataSql=`jsonb_build_object('unicode','港😀\\\\\\"', 'literal','capacity_memory',
  'a',('1.'||repeat('0',16383))::numeric,'b',('1.'||repeat('0',16383))::numeric,
  'c',('1.'||repeat('0',16383))::numeric,'d',('1.'||repeat('0',16383))::numeric,
  'e',('1.'||repeat('0',16383))::numeric,'f',('1.'||repeat('0',16383))::numeric,
  'tiny',('0.'||repeat('0',16382)||'1')::numeric,'unsafe',9007199254740993::numeric,
  'round',1.00000000000000011102230246251565404236316680908203126::numeric,
  'negativezero','-0'::numeric,'subnormal','4.9406564584124654e-324'::numeric)`;

async function seedCapacityMemory(owner:pg.Pool,chars:number,mode:'content'|'array'|'json'='content'){
  await owner.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,id,
    observed_entity_key,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
    occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    VALUES ($1,$2,$3,$4,'capacity_memory','entity:capacity','add','explicit',
      ${mode==='content'?"repeat('a',$6)":"'capacity memory'"},
      ${mode==='array'?"array_fill(repeat('k',256),ARRAY[$6::integer])":"ARRAY['literal','literal']"},$5::vector,'resource-local',0.875,0,0,0,0,
      ${mode==='json'?"jsonb_build_object('oversized',repeat('j',$6))":resourceMetadataSql})`,
    [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,vectorLiteral(BEHAVIOR_VECTOR),chars]);
}

function capacityHandlerSource(){
  // Test-only delegation observes original SQL responses. It neither rewrites
  // statements nor supplies fake rows, and puts no credentials in payload/logs.
  return `
import pg from "${projectRoot}/node_modules/pg/lib/index.js";
const stats={queries:0,headerQueries:0,contentQueries:0,metadataQueries:0,maxResultBytes:0,contentBytes:0,backends:[]};
const identities=new Set();
const originalConnect=pg.Pool.prototype.connect;
function wrapResourceClient(client){
 const query=client.query.bind(client);
 return new Proxy(client,{get(target,key){if(key!=="query"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
  return async function(sql,values){const answer=await query(sql,values);
   if(typeof sql==="string"&&sql.includes("memory resource")){
    stats.queries++;stats.maxResultBytes=Math.max(stats.maxResultBytes,Buffer.byteLength(JSON.stringify(answer.rows)));
    if(sql.includes("resource header"))stats.headerQueries++;
    if(sql.includes("substring(content")){stats.contentQueries++;for(const row of answer.rows)stats.contentBytes+=Buffer.byteLength(row.value??"");}
    if(sql.includes("resource hydrate")&&sql.includes("jsonb_path_query"))stats.metadataQueries++;
    const identity=(await query("SELECT pg_backend_pid() pid,pg_current_snapshot()::text snapshot,pg_current_xact_id_if_assigned()::text xid,current_setting('transaction_read_only') read_only")).rows[0];
    const key=JSON.stringify(identity);if(!identities.has(key)){identities.add(key);stats.backends.push(identity);}
   }return answer;};}});
}
pg.Pool.prototype.connect=function(callback){
 if(typeof callback==="function")return originalConnect.call(this,(error,client,release)=>callback(error,client?wrapResourceClient(client):client,release));
 return originalConnect.call(this).then(wrapResourceClient);
};
${childProgramSource().replace('await run();\nawait endSharedRuntimePools();',
 'try {await run();} catch {console.log(JSON.stringify({pid:process.pid,failed:true,code:"CAPACITY_HANDLER_FAILED"}));process.exitCode=1;} finally {await endSharedRuntimePools();await writeFile(payload.summaryPath,JSON.stringify(stats));}')}
`;
}

test("F4a3-M real PG exact64MiB authorized save/parse/restore and one-byte-over pretransfer refusal",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const measure=await createTempDatabase(t);await seedCapacityMemory(measure.ownerPool,1);
  const measured=await createPostgresRealmRuntimeSaveReader(measure.runtimePool).load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(measured?.memory?.schemaVersion===2);
  const overhead=Buffer.byteLength(serializeRealmRuntimeSaveMemoryV2(measured.memory))-1;
  const filler=MEMORY_RUNTIME_FILE_BYTES-overhead;assert.ok(filler>64*1024*1024-20000);
  const positive=await createTempDatabase(t);await seedCapacityMemory(positive.ownerPool,filler);
  const before=await compactResourceState(positive.ownerPool),sourceBefore=await compactResourceState(positive.ownerPool,SCOPE.worldlineId);
  const sqlSummary=(await positive.ownerPool.query(`SELECT octet_length(content) content_bytes,md5(content) content_md5,
    octet_length(metadata::text) metadata_sql_bytes FROM memory_conclusions WHERE workspace_id=$1 AND id='capacity_memory'`,[SCOPE.workspaceId])).rows[0]!;
  assert.equal(Number(sqlSummary.content_bytes),filler);assert.ok(Number(sqlSummary.metadata_sql_bytes)>65536);
  const scratch=await mkdtemp(join(tmpdir(),'memory-capacity-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  const childPath=join(scratch,'capacity-handler.ts'),artifactPath=join(process.env.REALM_R1_EVIDENCE_DIR??scratch,`capacity-${process.pid}-${randomUUID()}.realm`);
  const summaryPath=join(scratch,'query-summary.json');await writeFile(childPath,capacityHandlerSource());
  const saved=await runBehaviorChild<SaveChildResult>(childPath,{mode:'save',recordId:SCOPE.recordId,artifactPath,summaryPath,
    principalId:POSTGRES_DEMO_IDS.principal},positive.runtimeUrl);assert.equal(saved.status,200);
  const querySummary=JSON.parse(await readFile(summaryPath,'utf8')) as {contentBytes:number;contentQueries:number;metadataQueries:number;maxResultBytes:number;backends:unknown[]};
  assert.deepEqual(await compactResourceState(positive.ownerPool),before,'authorized export writes nothing');
  assert.equal(querySummary.contentBytes,filler);assert.ok(querySummary.contentQueries>100);assert.ok(querySummary.metadataQueries>1);
  assert.ok(querySummary.maxResultBytes<300000);assert.equal(querySummary.backends.length,1);
  const bytes=new Uint8Array(await readFile(artifactPath)),archive=parseRealmRuntimeSaveArchive(bytes);assert.ok(archive.memory?.schemaVersion===2);
  const wire=serializeRealmRuntimeSaveMemoryV2(archive.memory);assert.equal(Buffer.byteLength(wire),MEMORY_RUNTIME_FILE_BYTES);
  const wireSha256=createHash('sha256').update(wire).digest('hex');
  const row=archive.memory.conclusions[0]!;assert.equal(row.content.length,filler);
  assert.equal(createHash('md5').update(row.content).digest('hex'),sqlSummary.content_md5);
  assert.deepEqual(row.keywords,['literal','literal']);assert.equal(row.metadata.unsafe,9007199254740992);
  assert.equal(row.metadata.round,JSON.parse('1.00000000000000011102230246251565404236316680908203126'));
  assert.equal(row.metadata.tiny,0);assert.equal(row.metadata.subnormal,Number.MIN_VALUE);
  const restored=await createPostgresRealmRuntimeSaveRestorer(positive.runtimePool).restore({workspaceId:SCOPE.workspaceId,
    principalId:POSTGRES_DEMO_IDS.principal,targetWorldId:SCOPE.worldId,archive,idempotencyKey:'capacity-exact-limit'});
  const target=(await positive.ownerPool.query(`SELECT id,observer_continuity_id,source_record_id,source_observation_id,content_md5,content_bytes,keywords,metadata
    FROM (SELECT id,observer_continuity_id,source_record_id,source_observation_id,md5(content) content_md5,octet_length(content) content_bytes,keywords,metadata
      FROM memory_conclusions WHERE workspace_id=$1 AND worldline_id=$2) target`,[SCOPE.workspaceId,restored.worldlineId])).rows;
  assert.equal(target.length,1);assert.equal(Number(target[0]!.content_bytes),filler);assert.equal(target[0]!.content_md5,sqlSummary.content_md5);
  assert.notEqual(target[0]!.id,'capacity_memory');assert.notEqual(target[0]!.observer_continuity_id,POSTGRES_DEMO_IDS.playerContinuity);
  assert.equal(target[0]!.source_record_id,null);assert.equal(target[0]!.source_observation_id,null);assert.deepEqual(target[0]!.metadata,row.metadata);
  const ownerMap=(await positive.ownerPool.query<{source_id:string;target_id:string}>(`SELECT source.id source_id,target.id target_id
    FROM character_continuities source JOIN character_continuities target ON target.workspace_id=source.workspace_id AND target.world_id=source.world_id
      AND target.continuity_key=source.continuity_key WHERE source.workspace_id=$1 AND source.worldline_id=$2 AND target.worldline_id=$3`,
    [SCOPE.workspaceId,SCOPE.worldlineId,restored.worldlineId])).rows;
  assert.equal(ownerMap.length,3);assert.equal(new Set(ownerMap.map(row=>row.target_id)).size,3);
  assert.equal(target[0]!.observer_continuity_id,ownerMap.find(row=>row.source_id===POSTGRES_DEMO_IDS.playerContinuity)!.target_id);
  const durable=(await positive.ownerPool.query(`SELECT semantic_embedding::text vector,embedding_model,fidelity::text,occurred_tick,occurred_ordinal,
    available_from_tick,available_from_ordinal FROM memory_conclusions WHERE workspace_id=$1 AND worldline_id=$2`,[SCOPE.workspaceId,restored.worldlineId])).rows[0]!;
  assert.deepEqual(JSON.parse(durable.vector as string),BEHAVIOR_VECTOR);assert.equal(durable.embedding_model,'resource-local');
  assert.equal(Number(durable.fidelity),0.875);assert.equal(Number(durable.occurred_tick),0);assert.equal(Number(durable.available_from_tick),0);
  const epochRows=(await positive.ownerPool.query(`SELECT e.observer_continuity_id,e.epoch FROM memory_cache_epochs e JOIN character_continuities c
    ON c.workspace_id=e.workspace_id AND c.id=e.observer_continuity_id WHERE c.workspace_id=$1 AND c.world_id=$2 AND c.worldline_id=$3 ORDER BY c.id`,
    [SCOPE.workspaceId,SCOPE.worldId,restored.worldlineId])).rows;
  assert.equal(epochRows.length,3);assert.ok(epochRows.every(row=>Number(row.epoch)===0));
  assert.deepEqual(await compactResourceState(positive.ownerPool,SCOPE.worldlineId),sourceBefore);

  const negative=await createTempDatabase(t);await seedCapacityMemory(negative.ownerPool,filler+1);
  const oldOperators=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;
  t.after(()=>{if(oldOperators===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=oldOperators;});
  const negativeBefore=await compactResourceState(negative.ownerPool);let contentQueries=0,maxResultBytes=0;const transcript:object[]=[];
  const watched=behaviorInstrumentPool(negative.runtimePool,async(client,sql,values,execute)=>{
    const answer=await execute();if(sql.includes('memory resource')){
      const resultBytes=Buffer.byteLength(JSON.stringify(answer.rows));maxResultBytes=Math.max(maxResultBytes,resultBytes);
      if(sql.includes('substring(content'))contentQueries++;
      transcript.push({kind:sql.includes('resource header')?'header':'bounded hydrate',sql,parameterBytes:Buffer.byteLength(JSON.stringify(values)),resultBytes,rows:answer.rows.length});
    }return answer;
  });
  await assert.rejects(createPostgresRealmRuntimeSaveReader(watched).load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }),
    {code:'RUNTIME_SAVE_INVALID',message:'MemoryV2 exceeds the runtime file byte limit.'});
  assert.equal(contentQueries,0,'exact one-byte-over content refused before any content transfer');assert.ok(maxResultBytes<300000);
  const negativeAfter=await compactResourceState(negative.ownerPool);assert.deepEqual(negativeAfter,negativeBefore);
  await saveRuntimeEvidence('resources-real-capacity',{actualPg:true,limit:MEMORY_RUNTIME_FILE_BYTES,overBytes:MEMORY_RUNTIME_FILE_BYTES+1,
    measuredFormatterOverhead:overhead,filler,wireSha256,artifactPath,archiveBytes:bytes.length,archiveSha256:createHash('sha256').update(bytes).digest('hex'),
    sqlSummary,querySummary,handlerPid:saved.pid,restored,target,ownerMap,durable,epochRows,before,sourceBefore,sourceAfter:await compactResourceState(positive.ownerPool,SCOPE.worldlineId),
    negative:{before:negativeBefore,after:negativeAfter,contentQueries,maxResultBytes,transcript}});
});

test("F4a3-M all memory root/dependency/composite pages share the authorized snapshot across a committed writer",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const {ownerPool,runtimePool}=await createTempDatabase(t);
  const peer='resource_peer_record',peerInstance='resource_peer_instance';
  await ownerPool.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
    SELECT workspace_id,world_id,worldline_id,story_id,$2,'Resource peer','active',0,0,'primary',world_version FROM records WHERE workspace_id=$1 AND id=$3`,[SCOPE.workspaceId,peer,SCOPE.recordId]);
  await ownerPool.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
    VALUES ($1,$2,$3,$4,0,0)`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,peer]);
  await ownerPool.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,id,controller_mode,status,
    instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,state)
    VALUES ($1,$2,$3,$4,$5,$6,'ai','present',0,0,0,0,'{}')`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,peer,POSTGRES_DEMO_IDS.playerContinuity,peerInstance]);
  await ownerPool.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
    VALUES ($1,$2,$3,$4,'resource_peer_participant','character',$5,'ai',0)`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,peer,peerInstance]);
  await ownerPool.query(`INSERT INTO observations (workspace_id,world_id,worldline_id,record_id,id,observer_character_instance_id,dedupe_key,
    observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,learned_at,metadata)
    SELECT $1,$2,$3,$4,'dependency_obs_'||lpad(n::text,6,'0'),$5,'resource:'||n,'direct','Resource dependency '||n,0.875,0,0,0,0,
      '2026-10-17T01:02:03.456Z','{}' FROM generate_series(1,2001) n`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,peer,peerInstance]);
  for(const kind of ['root','dependency'] as const)await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,
    observer_continuity_id,id,observed_entity_key,source_record_id,source_observation_id,operation,memory_kind,content,keywords,
    semantic_embedding,embedding_model,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    SELECT $1,$2,$3,$4,$5||'_'||lpad(n::text,6,'0'),'entity:港😀',$6,
      CASE WHEN $6::text IS NULL THEN NULL ELSE 'dependency_obs_'||lpad(n::text,6,'0') END,
      'add','explicit',$5||' memory '||n,ARRAY['literal','literal'],$7::vector,'resource-local',0.875,0,0,0,0,jsonb_build_object('literal','root_000001','array',jsonb_build_array('A','B','A'))
    FROM generate_series(1,2001) n`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,kind,kind==='root'?null:peer,vectorLiteral(BEHAVIOR_VECTOR)]);
  await ownerPool.query(`INSERT INTO memory_snapshots (workspace_id,world_id,worldline_id,observer_continuity_id,id,snapshot_kind,content,item_ids,
    cursor_tick,cursor_ordinal,cache_epoch,token_count)
    SELECT $1,$2,$3,$4,'resource_snapshot_'||lpad(n::text,6,'0'),'recall','Resource snapshot '||n,
      ARRAY['root_'||lpad(n::text,6,'0'),'dependency_'||lpad(n::text,6,'0'),'root_'||lpad(n::text,6,'0')],0,0,0,3
    FROM generate_series(1,2001) n`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity]);
  for(const kind of ['null','record'] as const)await ownerPool.query(`INSERT INTO relationship_states (workspace_id,world_id,worldline_id,
    observer_continuity_id,target_entity_key,relation_kind,content,fidelity,source_record_id,source_observation_id,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
    SELECT $1,$2,$3,$4,$5||':港😀\\"'||lpad(n::text,6,'0'),CASE WHEN n%2=0 THEN 'trust' ELSE 'note' END,'Resource relationship '||$5||n,0.75,$6,
      CASE WHEN $6::text IS NULL THEN NULL ELSE 'dependency_obs_'||lpad(n::text,6,'0') END,0,0,0,0
    FROM generate_series(1,2001) n`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,kind,kind==='null'?null:peer]);
  // Genuine same-line orphan counter: not an epoch/root for carried topology.
  await ownerPool.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,born_tick,born_ordinal)
    SELECT workspace_id,world_id,worldline_id,definition_id,'resource_orphan','resource_orphan',0,0 FROM character_continuities WHERE workspace_id=$1 AND id=$2`,[SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity]);
  await ownerPool.query(`INSERT INTO memory_cache_epochs (workspace_id,observer_continuity_id,epoch) VALUES ($1,'resource_orphan',123)`,[SCOPE.workspaceId]);
  // Unrelated parallel-worldline null-source roots must remain excluded.
  await ownerPool.query(`INSERT INTO worldlines (workspace_id,world_id,id,label,status,head_tick,head_ordinal) VALUES ($1,$2,'resource_other_line','Other','active',0,0)`,[SCOPE.workspaceId,SCOPE.worldId]);
  await ownerPool.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,born_tick,born_ordinal)
    SELECT workspace_id,world_id,'resource_other_line',definition_id,'resource_other_observer','resource_other_observer',0,0 FROM character_continuities WHERE workspace_id=$1 AND id=$2`,[SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity]);
  await ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,id,observed_entity_key,operation,memory_kind,content,keywords,
    semantic_embedding,embedding_model,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    VALUES ($1,$2,'resource_other_line','resource_other_observer','resource_outside','outside','add','explicit','Excluded other line',ARRAY['outside'],$3::vector,'resource-local',1,0,0,0,0,'{}')`,
    [SCOPE.workspaceId,SCOPE.worldId,vectorLiteral(BEHAVIOR_VECTOR)]);
  const head=(await ownerPool.query(`SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2`,[SCOPE.workspaceId,SCOPE.worldlineId])).rows[0]!;
  const backendPhases=[new Set<string>(),new Set<string>()];
  const backends=backendPhases[0]!,headers:{group:string;keys:string[][];sql:string;rows:number}[]=[],counts=new Map<string,number>();
  const phaseCounts=[{queries:0,maxResultBytes:0,maxParameterBytes:0},{queries:0,maxResultBytes:0,maxParameterBytes:0}];
  let phase=0,committed=false,postWriter:Record<string,string>|undefined;
  const watched=behaviorInstrumentPool(runtimePool,async(client,sql,values,execute)=>{
    const answer=await execute();
    if(sql.includes('memory resource')){
      assert.equal(values?.[0],SCOPE.workspaceId);assert.equal(values?.[1],SCOPE.worldId);assert.equal(values?.[2],SCOPE.worldlineId);
      for(const value of values??[])if(Array.isArray(value))assert.ok(value.length<=1000);
      const info=phaseCounts[phase]!;info.queries++;info.maxResultBytes=Math.max(info.maxResultBytes,Buffer.byteLength(JSON.stringify(answer.rows)));
      info.maxParameterBytes=Math.max(info.maxParameterBytes,Buffer.byteLength(JSON.stringify(values)));
      const identity=(await client.query(`SELECT pg_backend_pid() pid,pg_current_snapshot()::text snapshot,pg_current_xact_id_if_assigned()::text xid,current_setting('transaction_read_only') read_only`)).rows[0]!;
      assert.equal(identity.read_only,'on');backendPhases[phase]!.add(JSON.stringify(identity));
      if(phase===0&&sql.includes('resource header')){
        const collection=/resource header (\w+)/.exec(sql)![1]!;
        const group=collection+':'+(sql.includes('source_record_id IS NULL')?'null':sql.includes('id=ANY')?'dependency':collection==='snapshots'?'all':String(values?.[3]));
        headers.push({group,keys:answer.rows.map(row=>row.keys as string[]),sql,rows:answer.rows.length});
        assert.ok(/LIMIT 1000/.test(sql)&&/COLLATE "C"/.test(sql));
      }
      if(phase===0&&sql.includes('semantic_embedding::text value')){
        const key='conclusion:'+String(values?.[3]);counts.set(key,(counts.get(key)??0)+1);
      }
      if(phase===0&&sql.includes('resource hydrate')&&sql.includes('cardinality(item_ids)')){
        const key='snapshot:'+String(values?.[3]);counts.set(key,(counts.get(key)??0)+1);
      }
      if(phase===0&&sql.includes('substring(content')&&sql.includes('FROM relationship_states')){
        const key='relationship:'+JSON.stringify(values?.slice(3,6));counts.set(key,(counts.get(key)??0)+1);
      }
      if(!committed&&sql.includes('resource header')&&answer.rows.length===1000){
        committed=true;
        const writer=await ownerPool.connect();
        try{
          await writer.query('BEGIN');
          await writer.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,id,observed_entity_key,operation,memory_kind,content,keywords,
            semantic_embedding,embedding_model,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
            VALUES ($1,$2,$3,$4,'resource_concurrent','entity:writer','add','explicit','Committed between pages',ARRAY['writer'],$5::vector,'resource-local',1,$6,$7,$6,$7,'{}')`,
            [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,vectorLiteral(BEHAVIOR_VECTOR),Number(head.head_tick),Number(head.head_ordinal)+1]);
          await writer.query(`INSERT INTO memory_cache_epochs (workspace_id,observer_continuity_id,epoch) VALUES ($1,$2,1)
            ON CONFLICT (workspace_id,observer_continuity_id) DO UPDATE SET epoch=memory_cache_epochs.epoch+1`,[SCOPE.workspaceId,POSTGRES_DEMO_IDS.playerContinuity]);
          await writer.query(`UPDATE worldlines SET head_ordinal=head_ordinal+1 WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId]);
          await writer.query('COMMIT');
        }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
        postWriter=await compactResourceState(ownerPool);
      }
    }
    return answer;
  });
  const previous=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;
  try{
    const reader=createPostgresRealmRuntimeSaveReader(watched),input={ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const };
    const first=await reader.load(input);assert.ok(first?.memory?.schemaVersion===2);assert.equal(committed,true);assert.equal(backends.size,1);
    assert.deepEqual(await compactResourceState(ownerPool),postWriter,'only the independently committed writer changed source rows');
    assert.equal(first.memory.conclusions.length,4002);assert.equal(first.memory.snapshots.length,2001);assert.equal(first.memory.relationshipStates.length,4002);
    assert.deepEqual(first.memory.worldlineHead,{tick:Number(head.head_tick),ordinal:Number(head.head_ordinal)});
    assert.equal(first.memory.cacheEpochs.find(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity)!.epoch,0);
    assert.ok(!first.memory.conclusions.some(row=>row.sourceMemoryId==='resource_concurrent'||row.sourceMemoryId==='resource_outside'));
    assert.ok(!first.memory.cacheEpochs.some(row=>row.sourceObserverContinuityId==='resource_orphan'));
    assert.deepEqual(first.domain!.records.map(row=>row.recordId),[peer]);
    for(const group of ['snapshots:all','conclusions:null',`conclusions:${peer}`,'relationships:null',`relationships:${peer}`]){
      const pages=headers.filter(row=>row.group===group);assert.deepEqual(pages.map(row=>row.rows),[1000,1000,1],group);
      const keys=pages.flatMap(row=>row.keys);assert.equal(new Set(keys.map(row=>JSON.stringify(row))).size,2001);
      for(let i=1;i<keys.length;i++){
        let compared=0;for(let part=0;part<keys[i]!.length&&!compared;part++)compared=Buffer.compare(Buffer.from(keys[i-1]![part]!),Buffer.from(keys[i]![part]!));
        assert.ok(compared<0,`${group} stable unique C key order`);
      }
    }
    assert.equal(counts.size,4002+2001+4002);assert.ok([...counts.values()].every(value=>value===1),'every selected payload charged/hydrated once');
    const rebuilt=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(first));assert.deepEqual(rebuilt.memory,first.memory);
    const wireBytes=Buffer.byteLength(serializeRealmRuntimeSaveMemoryV2(first.memory));
    phase=1;const second=await reader.load(input);assert.ok(second?.memory?.schemaVersion===2);
    assert.equal(second.memory.conclusions.length,4003);assert.equal(second.memory.worldlineHead.ordinal,Number(head.head_ordinal)+1);
    assert.equal(second.memory.cacheEpochs.find(row=>row.sourceObserverContinuityId===POSTGRES_DEMO_IDS.playerContinuity)!.epoch,1);
    assert.equal(backendPhases[1]!.size,1);assert.notEqual(JSON.parse([...backendPhases[0]!][0]!).snapshot,JSON.parse([...backendPhases[1]!][0]!).snapshot);
    assert.deepEqual(await compactResourceState(ownerPool),postWriter);
    const privateBefore=phaseCounts[1]!.queries;
    await assert.rejects(reader.load({ ...input, principalId: 'not_an_operator', purpose: "whole-closure-backup" as const }),{code:'BACKUP_FORBIDDEN'});
    await assert.rejects(reader.load({ ...input, principalId: (null as unknown as {principalId:string}) as unknown as string, purpose: "whole-closure-backup" as const }),{code:'BACKUP_FORBIDDEN'});
    assert.equal(phaseCounts[1]!.queries,privateBefore,'malformed/unauthorized capability before any memory access');
    await saveRuntimeEvidence('resources-all-pages-snapshot',{defaultPageRows:1000,sourceCounts:{conclusions:4002,snapshots:2001,relationships:4002},laterConclusions:4003,
      scopedEpochs:first.memory.cacheEpochs,headBefore:first.memory.worldlineHead,headAfter:second.memory.worldlineHead,backends:[...backends].map(value=>JSON.parse(value)),
      headers,backendPhases:backendPhases.map(set=>[...set].map(value=>JSON.parse(value))),phaseCounts,uniqueHydratedRows:counts.size,chargedExactlyOnce:[...counts.values()].every(value=>value===1),wireBytes,
      firstMemorySha256:createHash('sha256').update(serializeRealmRuntimeSaveMemoryV2(first.memory)).digest('hex'),postWriter,after:await compactResourceState(ownerPool)});
  }finally{if(previous===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=previous;}
});

test("F4a3-M oversized content/array/JSONB and giant keys refuse before payload transfer",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:300_000,
},async t=>{
  const summaries=[];
  for(const mode of ['content','array','json','id','entity','nonfinite-metadata','array-lower-bounds'] as const){
    const db=await createTempDatabase(t);
    if(mode==='id'||mode==='entity')await db.ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,id,
      observed_entity_key,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
      VALUES ($1,$2,$3,$4,${mode==='id'?"repeat('i',2000)":"'giant_entity'"},${mode==='entity'?"repeat('e',$6)":"'entity:giant'"},
        'add','explicit','Guard before transfer',ARRAY['guard'],$5::vector,'resource-local',1,0,0,0,0,'{}')`,
      [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,vectorLiteral(BEHAVIOR_VECTOR),...(mode==='entity'?[2000]:[])]);
    else if(mode==='nonfinite-metadata'||mode==='array-lower-bounds')await db.ownerPool.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,id,
      observed_entity_key,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
      VALUES ($1,$2,$3,$4,'numeric_policy','entity:numeric','add','explicit','Numeric policy',
        ${mode==='array-lower-bounds'?"'[-2:0]={left,right,left}'::text[]":"ARRAY['numeric']"},$5::vector,'resource-local',1,0,0,0,0,
        ${mode==='nonfinite-metadata'?"jsonb_build_object('outside_binary64','1e131071'::numeric)":"'{}'::jsonb"})`,[SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity,vectorLiteral(BEHAVIOR_VECTOR)]);
    else await seedCapacityMemory(db.ownerPool,mode==='array'?Math.ceil((MEMORY_RUNTIME_FILE_BYTES+1)/259)+10:MEMORY_RUNTIME_FILE_BYTES+1,mode);
    if(mode==='array-lower-bounds')await db.ownerPool.query(`INSERT INTO memory_snapshots
      (workspace_id,world_id,worldline_id,observer_continuity_id,id,snapshot_kind,content,item_ids,cursor_tick,cursor_ordinal,cache_epoch,token_count)
      VALUES ($1,$2,$3,$4,'array_bounds_snapshot','recall','','[0:2]={numeric_policy,numeric_policy,numeric_policy}'::text[],0,0,0,3)`,
      [SCOPE.workspaceId,SCOPE.worldId,SCOPE.worldlineId,POSTGRES_DEMO_IDS.playerContinuity]);
    const before=await compactResourceState(db.ownerPool);let queries=0,maxResultBytes=0,headerBytes=0;const transcript:object[]=[];
    const watched=behaviorInstrumentPool(db.runtimePool,async(client,sql,values,execute)=>{
      const answer=await execute();if(sql.includes('memory resource')){
        const bytes=Buffer.byteLength(JSON.stringify(answer.rows));maxResultBytes=Math.max(maxResultBytes,bytes);
        if(sql.includes('resource hydrate'))queries++;
        if(sql.includes('resource header'))headerBytes+=bytes;
        transcript.push({sql,parameterBytes:Buffer.byteLength(JSON.stringify(values)),resultBytes:bytes,rows:answer.rows.length,
          oversize:answer.rows.some(row=>row.oversize===true),headSuppressed:answer.rows.some(row=>row.head===null),invalid:answer.rows.some(row=>row.invalid===true),keysSuppressed:answer.rows.some(row=>row.keys===null)});
      }return answer;
    });
    const reader=createPostgresRealmRuntimeSaveReader(watched);
    if(mode==='array-lower-bounds'){
      const archive=await reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(archive);
      assert.deepEqual(archive.memory!.conclusions[0]!.keywords,['left','right','left']);
      assert.deepEqual(archive.memory!.snapshots[0]!.sourceItemIds,['numeric_policy','numeric_policy','numeric_policy']);
      assert.deepEqual(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)).memory,archive.memory);
      assert.equal((await db.ownerPool.query(`SELECT array_lower(keywords,1) lo FROM memory_conclusions WHERE workspace_id=$1 AND id='numeric_policy'`,[SCOPE.workspaceId])).rows[0]!.lo,-2);
    }else if(mode==='nonfinite-metadata'){
      const archive=await reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });assert.ok(archive);
      assert.deepEqual(archive.memory!.conclusions[0]!.metadata,{},'existing SQL jsonObject finite policy unchanged');
      const numericLength=Number((await db.ownerPool.query(`SELECT octet_length(metadata::text) n FROM memory_conclusions WHERE workspace_id=$1 AND id='numeric_policy'`,[SCOPE.workspaceId])).rows[0]!.n);assert.ok(numericLength>131072);
      await assert.rejects(db.ownerPool.query(`SELECT '1e131072'::numeric`),{code:'22003'});
      assert.ok(maxResultBytes<10000,'131072-digit numeric never transferred as a complete raw metadata value');
    }else{
      await assert.rejects(reader.load({ workspaceId:SCOPE.workspaceId, recordId:SCOPE.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }),{code:'RUNTIME_SAVE_INVALID'});
      assert.equal(queries,0,'giant candidate refused by header before hydration');assert.ok(maxResultBytes<10000);
      if(mode==='id'||mode==='entity')assert.ok(transcript.some(row=>(row as {keysSuppressed?:boolean}).keysSuppressed));
      else assert.ok(transcript.some(row=>(row as {oversize?:boolean;headSuppressed?:boolean}).oversize&&(row as {headSuppressed?:boolean}).headSuppressed));
    }
    const after=await compactResourceState(db.ownerPool);assert.deepEqual(after,before);
    summaries.push({mode,queries,maxResultBytes,headerBytes,transcript,before,after});
  }
  await saveRuntimeEvidence('resources-giant-pretransfer',{summaries});
});

}

// C3 retained real-PG projection regressions, derived from the immutable Iris probe.
{
const workspace=POSTGRES_DEMO_IDS.workspace,principal=POSTGRES_DEMO_IDS.principal;
const options={skip:!adminConnectionString||!runtimeConnectionString,timeout:120_000};
const {installTestSessionSecret,sessionProofFor}=await import('./helpers/session-proof.ts');installTestSessionSecret();
const {executeRecordGoalCommand}=await import('../modules/application/record-goal-command.ts');
const {POST:savePOST}=await import('../app/api/record/save/route.ts');
const {POST:branchPOST}=await import('../app/api/record/branch/route.ts');
const {endSharedRuntimePools,getSharedRuntimePool}=await import('../app/api/world-scope.ts');
async function nativeFixture(admin: pg.Pool) {
  const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `world_${randomUUID()}`,
    worldlineId: `worldline_${randomUUID()}`, recordId: `record_${randomUUID()}` };
  const storyId = `story_${randomUUID()}`;
  const sceneId = `scene_${randomUUID()}`;
  await withWorkspaceTransaction(admin, scope.workspaceId, async (client) => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      // All identifiers/predicates are test-owned literals; values stay bound.
      const inserted = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source) || $1::jsonb)).*
        FROM ${table} AS source WHERE workspace_id = $2 AND ${predicate} = $3 LIMIT 1`,
      [JSON.stringify(patch), scope.workspaceId, sourceId]);
      assert.equal(inserted.rowCount, 1, `fixture ${table}`);
    };
    await clone('worlds', 'id', POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: 'Goal command isolation' });
    const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
    await clone('worldlines', 'id', POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: 0, head_ordinal: 0 });
    await clone('stories', 'id', POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick:0,start_ordinal:0 });
    await clone('records', 'id', POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: 'active',start_tick:0,start_ordinal:0 });
    await clone('scenes', 'record_id', POSTGRES_DEMO_IDS.record, { ...scoped, id: sceneId,start_tick:0,start_ordinal:0 });
    await clone('visibility_policies', "policy_kind = 'public' AND record_id", POSTGRES_DEMO_IDS.record,
      { ...scoped, id: `policy_${randomUUID()}` });
    await client.query(`INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
      VALUES ($1,$2,$3,'owner')`, [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
    await client.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,
      participant_kind,principal_id,controller_mode) VALUES ($1,$2,$3,$4,$5,'narrator',$6,'human')`,
      [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,POSTGRES_DEMO_IDS.principal]);
    await clone('record_heads', 'record_id', POSTGRES_DEMO_IDS.record,
      { ...scoped, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
  });
  return scope;
}

function probePools(t: { after: (work: () => Promise<void>) => void }) {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL });
  const routePool = observeFixturePool(getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!));
  const ended: Promise<void>[] = [];
  for (const pool of [owner, runtime]) pool.on("connect", client => ended.push(new Promise(resolve => client.once("end", resolve))));
  t.after(async () => { refFixtureClients(routePool); await endSharedRuntimePools(); await runtime.end(); await owner.end(); await Promise.all(ended); await awaitFixtureClients(routePool); });
  return { owner, runtime };
}
function request(path: string, input: object) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `realm_session=${sessionProofFor(principal)}` }, body: JSON.stringify(input) });
}
async function saveSource(recordId: string) {
  const response = await savePOST(request("/api/record/save", { recordId }));
  if (response.status !== 200) return { status: response.status, errorCode: (await response.json()).error?.code as string | undefined, archive: undefined };
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, errorCode: undefined, archive: parseRealmRuntimeSaveArchive(bytes) };
}
async function authorityImage(owner: pg.Pool, worldId: string) {
  const result: Record<string, unknown> = {};
  for (const table of ["worldlines", "stories", "records", "record_heads", "events", "record_goal_definitions", "record_goal_restore_admissions", "story_definition_bindings"]) {
    result[table] = (await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb) AS image FROM ${table} row WHERE workspace_id=$1 AND world_id=$2`, [workspace, worldId])).rows[0].image;
  }
  return result;
}
async function localGoal(runtime: pg.Pool, scope: Awaited<ReturnType<typeof nativeFixture>>) {
  await executeRecordGoalCommand(runtime, { scope, principalId: principal, sessionProof: sessionProofFor(principal), idempotencyKey: `iris.native.${scope.recordId}`, command: { operation: "create", recordId: scope.recordId, expectedHead: { recordVersion: 0, ordinal: 0 }, draft: { title: "Preserve local evidence", description: "Iris independent probe", successConditions: ["A local formal result"], failureConditions: [], settlementConditions: [], changePolicy: "fixed", visible: true } } });
}
async function cloneRow(owner: pg.Pool, table: string, predicate: string, source: string, patch: object) {
  const result = await owner.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), workspace, source]);
  assert.equal(result.rowCount, 1, `probe fixture ${table}`);
}
async function addCharacter(owner: pg.Pool, scope: Awaited<ReturnType<typeof nativeFixture>>, continuityKey?: string) {
  const definitionId = `definition_${randomUUID()}`, continuity = `continuity_${randomUUID()}`, instanceId = `instance_${randomUUID()}`;
  await cloneRow(owner, "character_definitions", "id", POSTGRES_DEMO_IDS.playerDefinition, { world_id: scope.worldId, id: definitionId });
  await cloneRow(owner, "character_continuities", "id", POSTGRES_DEMO_IDS.playerContinuity, { world_id: scope.worldId, worldline_id: scope.worldlineId, id: continuity, definition_id: definitionId, ...(continuityKey ? { continuity_key: continuityKey } : {}) });
  await cloneRow(owner, "character_instances", "id", POSTGRES_DEMO_IDS.playerInstance, { world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId, id: instanceId, continuity_id: continuity, predecessor_instance_id: null });
  await owner.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'character',$6,$7,'human')`, [workspace,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,instanceId,principal]);
  return { continuity, instanceId };
}
async function recordCursor(owner: pg.Pool, recordId: string) {
  const row = (await owner.query("SELECT world_tick::text AS tick,world_ordinal::text AS ordinal FROM events WHERE workspace_id=$1 AND record_id=$2 ORDER BY world_tick DESC,world_ordinal DESC LIMIT 1",[workspace,recordId])).rows[0];
  return row ? { tick:Number(row.tick),ordinal:Number(row.ordinal) } : { tick:0,ordinal:0 };
}
async function worldlineCursor(owner: pg.Pool, worldlineId: string) {
  const row = (await owner.query("SELECT head_tick::text AS tick,head_ordinal::text AS ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2",[workspace,worldlineId])).rows[0];
  return { tick:Number(row.tick),ordinal:Number(row.ordinal) };
}

for (const mode of ["current", "future-availability", "sibling-snapshot"] as const) {
  test(`C3 D4 ordinary relationship projection ${mode} never invents progress`, options, async t => {
    const {owner,runtime}=probePools(t); const scope=await nativeFixture(owner);const character=await addCharacter(owner,scope);
    await owner.query("INSERT INTO memory_cache_epochs(workspace_id,observer_continuity_id,epoch) VALUES($1,$2,7)",[workspace,character.continuity]);
    await localGoal(runtime,scope);
    const sourceHead=await recordCursor(owner,scope.recordId);
    const futureTick=mode==="future-availability"?777:0;
    await owner.query(`INSERT INTO relationship_states(workspace_id,world_id,worldline_id,observer_continuity_id,target_entity_key,relation_kind,content,fidelity,source_record_id,source_observation_id,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,'iris_target','trust','Record-only relationship',1,$5,NULL,0,0,$6,0)`,[workspace,scope.worldId,scope.worldlineId,character.continuity,scope.recordId,futureTick]);
    let siblingHead: {tick:number;ordinal:number}|undefined;
    if(mode==="sibling-snapshot") {
      const sibling={...scope,recordId:`sibling_${randomUUID()}`};
      await cloneRow(owner,"records","id",scope.recordId,{id:sibling.recordId});
      await cloneRow(owner,"record_heads","record_id",scope.recordId,{record_id:sibling.recordId,record_version:0,next_record_ordinal:1,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
      for(const table of ["scenes","visibility_policies","participants"]) await cloneRow(owner,table,table==="participants"?"participant_kind='narrator' AND record_id":"record_id",scope.recordId,{id:`iris_${randomUUID()}`,record_id:sibling.recordId});
      await localGoal(runtime,sibling);siblingHead=await recordCursor(owner,sibling.recordId);
      assert.ok(siblingHead.tick>sourceHead.tick||siblingHead.ordinal>sourceHead.ordinal,"control must have a real higher sibling event cursor");
      const observation=`observation_${randomUUID()}`,memory=`memory_${randomUUID()}`;
      await owner.query(`INSERT INTO observations(workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,id,dedupe_key,observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,$5,$6,$6,'direct','ROOT_ONLY_FACT',1,0,0,0,0)`,[workspace,scope.worldId,scope.worldlineId,scope.recordId,character.instanceId,observation]);
      await owner.query(`INSERT INTO memory_conclusions(workspace_id,world_id,worldline_id,observer_continuity_id,source_record_id,source_observation_id,id,observed_entity_key,memory_kind,content,semantic_embedding,embedding_model,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal) VALUES($1,$2,$3,$4,$5,$6,$7,'iris_root','explicit','ROOT_ONLY_FACT',$8::vector,'iris-test',0,0,0,0)`,[workspace,scope.worldId,scope.worldlineId,character.continuity,scope.recordId,observation,memory,`[${new Array(384).fill(0).join(",")}]`]);
      await owner.query(`INSERT INTO memory_snapshots(workspace_id,world_id,worldline_id,observer_continuity_id,id,snapshot_kind,content,item_ids,cursor_tick,cursor_ordinal,cache_epoch,token_count) VALUES($1,$2,$3,$4,$5,'recall','ROOT_ONLY_FACT',$6,$7,$8,7,10)`,[workspace,scope.worldId,scope.worldlineId,character.continuity,`snapshot_${randomUUID()}`,[memory],siblingHead.tick,siblingHead.ordinal]);
    }
    const before=await authorityImage(owner,scope.worldId); const saved=await saveSource(scope.recordId);
    assert.equal(saved.status,200,`legal ordinary save expected, code=${saved.errorCode}`);assert.ok(saved.archive);assert.equal(saved.archive.memory?.schemaVersion,2);
    assert.deepEqual(await authorityImage(owner,scope.worldId),before,"ordinary export itself must not write authority");
    const target=await createPostgresRealmRuntimeSaveRestorer(runtime).restore({archive:saved.archive,workspaceId:workspace,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:`iris.relationship.${mode}`});
    const targetHead=await worldlineCursor(owner,target.worldlineId);
    const again=await createPostgresRealmRuntimeSaveReader(runtime).load({workspaceId:workspace,recordId:target.recordId,principalId:principal,purpose:"record-export"});assert.ok(again);
    const resaved=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(again));
    const branch=await branchPOST(request("/api/record/branch",{recordId:scope.recordId,idempotencyKey:`iris.branch.${mode}`}));
    const branchBody=await branch.json(); const branchEvidence=branch.status===201?{status:201,targetHead:await worldlineCursor(owner,branchBody.worldlineId),fork:branchBody.fork}:{status:branch.status,errorCode:branchBody.error?.code};
    await writeFile(join(process.env.REALM_R1_EVIDENCE_DIR!,`c3-d4-${mode}-${process.pid}.json`),JSON.stringify({sourceHead,siblingHead,sourceAvailableFromTick:futureTick,archiveHead:saved.archive.memory.worldlineHead,targetHead,resavedHead:resaved.memory?.schemaVersion===2?resaved.memory.worldlineHead:null,targetRelationship:resaved.memory?.relationshipStates.map(row=>({sourceRecordId:row.sourceRecordId,sourceObservationId:row.sourceObservationId,availableFromTick:row.availableFromTick})),branch:branchEvidence}),{flag:"wx"});
    assert.deepEqual(saved.archive.memory.worldlineHead,sourceHead,"projected current head excludes future availability and sibling-derived cache cursor");
    assert.deepEqual(targetHead,sourceHead,"restore must not turn a future availability/cache position into committed world progress");
    assert.equal(resaved.memory?.relationshipStates[0]?.availableFromTick,futureTick,"availability survives without advancing current head");
    assert.equal(resaved.memory?.relationshipStates[0]?.sourceRecordId,target.recordId);
    assert.equal(resaved.memory?.relationshipStates[0]?.sourceObservationId,null);
    assert.equal(branch.status,201,"native branch of this legal source must remain supported");
    assert.deepEqual(resaved.memory?.schemaVersion===2?resaved.memory.worldlineHead:null,sourceHead);
    assert.equal(resaved.memory?.schemaVersion===2?resaved.memory.cacheEpochs[0]?.epoch:null,7);
    if(mode==='future-availability'){
      for(const [tick,ordinal,visible] of [[sourceHead.tick,sourceHead.ordinal,0],[777,0,1]]){
        const rows=await owner.query('SELECT count(*)::int AS n FROM relationship_states WHERE workspace_id=$1 AND worldline_id=$2 AND source_record_id=$3 AND (available_from_tick,available_from_ordinal)<=($4::bigint,$5::bigint)',[workspace,target.worldlineId,target.recordId,tick,ordinal]);
        assert.equal(rows.rows[0].n,visible,'delayed visibility is preserved independently of committed progress');
      }
    }

    assert.deepEqual(branchEvidence,{status:201,targetHead:sourceHead,fork:sourceHead});
    const replay=await branchPOST(request("/api/record/branch",{recordId:scope.recordId,idempotencyKey:`iris.branch.${mode}`}));
    assert.equal(replay.status,200);const replayBody=await replay.json();assert.equal(replayBody.replayed,true);
    assert.equal(replayBody.worldlineId,branchBody.worldlineId);
    const restoreReplay=await createPostgresRealmRuntimeSaveRestorer(runtime).restore({archive:saved.archive,workspaceId:workspace,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:`iris.relationship.${mode}`});
    assert.equal(restoreReplay.replayed,true);assert.equal(restoreReplay.recordId,target.recordId);
    assert.deepEqual(resaved.memory?.snapshots.map(row=>({content:row.content,items:row.sourceItemIds.length,cursor:[row.cursorTick,row.cursorOrdinal],epoch:row.cacheEpoch,tokens:row.tokenCount})),
      mode==="sibling-snapshot"?[{content:"ROOT_ONLY_FACT",items:1,cursor:[sourceHead.tick,sourceHead.ordinal],epoch:7,tokens:saved.archive.memory.snapshots[0]!.tokenCount}]:[]);
    const whole=await createPostgresRealmRuntimeSaveReader(runtime).load({workspaceId:workspace,recordId:scope.recordId,principalId:principal,purpose:"whole-closure-backup"});assert.ok(whole);
    assert.deepEqual(whole.memory?.schemaVersion===2?whole.memory.worldlineHead:null,siblingHead??sourceHead);
    assert.equal(whole.memory?.relationshipStates[0]?.availableFromTick,futureTick);
    const wholeTarget=await createPostgresRealmRuntimeSaveRestorer(runtime).restore({archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(whole)),workspaceId:workspace,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:`c3.whole.${mode}`});
    assert.deepEqual(await worldlineCursor(owner,wholeTarget.worldlineId),siblingHead??sourceHead);

  });
}

for (const mode of ["current", "future", "mixed", "empty", "pre-stale", "max-minus-one", "exhausted"] as const) {
  test(`C4 narrow V2 cache eligibility ${mode}: real consumers, branch, resave and replay`, options, async t => {
    const {owner,runtime} = probePools(t);
    const scope = await nativeFixture(owner);
    const affected = await addCharacter(owner,scope), control = await addCharacter(owner,scope,"c4_control");
    await localGoal(runtime,scope);
    const head = await recordCursor(owner,scope.recordId);
    const sibling = {...scope,recordId:`c4_sibling_${randomUUID()}`};
    await cloneRow(owner,"records","id",scope.recordId,{id:sibling.recordId});
    await cloneRow(owner,"record_heads","record_id",scope.recordId,{record_id:sibling.recordId,record_version:0,next_record_ordinal:1,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
    for (const table of ["scenes","visibility_policies","participants"]) await cloneRow(owner,table,table === "participants" ? "participant_kind='narrator' AND record_id" : "record_id",scope.recordId,{id:`c4_${randomUUID()}`,record_id:sibling.recordId});
    await localGoal(runtime,sibling);
    const sharedHead = await worldlineCursor(owner,scope.worldlineId);
    assert.ok(sharedHead.tick > head.tick || sharedHead.ordinal > head.ordinal);
    const repository = createPostgresCharacterMemoryRepository(runtime);
    const sourceEpoch = mode === "exhausted" ? 2147483647 : mode === "max-minus-one" ? 2147483646 : 7;
    const hasFuture = !["current","empty"].includes(mode);
    const sourceItems: {id:string;content:string;available:{tick:number;ordinal:number};observer:string}[] = [];
    for (const [index,character] of [affected,control].entries()) {
      await owner.query("INSERT INTO memory_cache_epochs(workspace_id,observer_continuity_id,epoch) VALUES($1,$2,$3)",[workspace,character.continuity,index === 0 ? sourceEpoch : 7]);
      await owner.query(`INSERT INTO relationship_states(workspace_id,world_id,worldline_id,observer_continuity_id,target_entity_key,relation_kind,content,fidelity,source_record_id,source_observation_id,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
        VALUES($1,$2,$3,$4,'c4_target','trust','C4 V2 selection',1,$5,NULL,0,0,0,0)`,[workspace,scope.worldId,scope.worldlineId,character.continuity,scope.recordId]);
      for (const future of [false,true]) {
        const observation = `c4_observation_${randomUUID()}`, id = `c4_memory_${randomUUID()}`;
        const content = `C4_${mode}_${index}_${future ? "FUTURE" : "CURRENT"}`;
        const available = future ? sharedHead : head;
        await owner.query(`INSERT INTO observations(workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,id,dedupe_key,observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
          VALUES($1,$2,$3,$4,$5,$6,$6,'direct',$7,1,0,0,$8,$9)`,[workspace,scope.worldId,scope.worldlineId,scope.recordId,character.instanceId,observation,content,available.tick,available.ordinal]);
        await owner.query(`INSERT INTO memory_conclusions(workspace_id,world_id,worldline_id,observer_continuity_id,source_record_id,source_observation_id,id,observed_entity_key,memory_kind,content,semantic_embedding,embedding_model,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal)
          VALUES($1,$2,$3,$4,$5,$6,$7,'c4_fact','explicit',$8,$9::vector,'c4-test',0,0,$10,$11)`,[workspace,scope.worldId,scope.worldlineId,character.continuity,scope.recordId,observation,id,content,`[${new Array(384).fill(0).join(",")}]`,available.tick,available.ordinal]);
        sourceItems.push({id,content,available,observer:character.continuity});
      }
      const items = sourceItems.filter(item => item.observer === character.continuity);
      const selected = index === 0 && hasFuture ? mode === "mixed" ? items : [items[1]!] : [items[0]!];
      for (const ids of [selected.map(item=>item.id), [], [items[0]!.id]]) {
        const actualIds = mode === "empty" && index === 0 ? [] : ids;
        const content = actualIds.map(id=>sourceItems.find(item=>item.id === id)!.content).join("\n");
        const created = await repository.createSnapshotAuthorized({...scope,characterInstanceId:character.instanceId,snapshotId:`c4_snapshot_${randomUUID()}`,snapshotKind:"recall",content,itemIds:actualIds,tokenCount:actualIds.length * 10});
        assert.ok(created); assert.deepEqual(created.cursor,sharedHead);
        assert.equal((await repository.deltaAuthorized({...scope,characterInstanceId:character.instanceId,snapshotId:created.id}))?.stale,false);
      }
    }
    if (mode === "pre-stale") await owner.query("UPDATE memory_cache_epochs SET epoch=8 WHERE workspace_id=$1 AND observer_continuity_id=$2",[workspace,affected.continuity]);
    const memoryImage = async () => {
      const image: Record<string,unknown> = await authorityImage(owner,scope.worldId);
      for (const table of ["observations","memory_conclusions","memory_snapshots","relationship_states"]) image[table] = (await owner.query(`SELECT jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text) image FROM ${table} row WHERE workspace_id=$1 AND world_id=$2`,[workspace,scope.worldId])).rows[0].image;
      image.epochs = (await owner.query(`SELECT jsonb_agg(to_jsonb(e) ORDER BY e.observer_continuity_id) image FROM memory_cache_epochs e JOIN character_continuities c ON c.workspace_id=e.workspace_id AND c.id=e.observer_continuity_id WHERE c.workspace_id=$1 AND c.world_id=$2`,[workspace,scope.worldId])).rows[0].image;
      return image;
    };
    const before = await memoryImage();
    const saved = await saveSource(scope.recordId);
    assert.deepEqual(await memoryImage(),before,"export leaves source formal and derived authority byte-exact");
    if (mode === "exhausted") {
      assert.equal(saved.status,422); assert.equal(saved.errorCode,"RUNTIME_SAVE_INVALID");
      const failedBranch = await branchPOST(request("/api/record/branch",{recordId:scope.recordId,idempotencyKey:`c4.exhausted.${scope.recordId}`}));
      assert.equal(failedBranch.status,422);
      assert.deepEqual(await memoryImage(),before,"checked exhaustion precedes all branch target writes");
      return;
    }
    assert.equal(saved.status,200); assert.ok(saved.archive); assert.equal(saved.archive.memory?.schemaVersion,2);
    const memory = saved.archive.memory;
    assert.ok(memory?.schemaVersion === 2);
    const expectedEpoch = hasFuture ? mode === "pre-stale" ? 8 : sourceEpoch + 1 : sourceEpoch;
    assert.equal(memory.cacheEpochs.find(row=>row.sourceObserverContinuityId === affected.continuity)?.epoch,expectedEpoch);
    assert.equal(memory.cacheEpochs.find(row=>row.sourceObserverContinuityId === control.continuity)?.epoch,7,"unaffected observer remains valid");
    assert.equal(memory.snapshots.length,6,"empty V2 derived snapshots survive mixed-Record projection");
    assert.equal(memory.conclusions.length,4);
    for (const item of sourceItems) {
      const formal = memory.conclusions.find(row=>row.sourceMemoryId === item.id)!;
      assert.equal(formal.content,item.content);
      assert.deepEqual([formal.availableFromTick,formal.availableFromOrdinal],[item.available.tick,item.available.ordinal]);
    }
    assert.deepEqual(memory.worldlineHead,head);
    const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved.archive));
    assert.deepEqual(parsed.memory,memory);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
    const restoreInput = {archive:parsed,workspaceId:workspace,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:`c4.cache.${scope.recordId}`};
    const target = await restorer.restore(restoreInput);
    const targetImage = await memoryImage();
    assert.equal((await restorer.restore(restoreInput)).replayed,true);
    assert.deepEqual(await memoryImage(),targetImage,"restore replay performs no writes");
    const verifyTarget = async (identity: {worldlineId:string;recordId:string}) => {
      assert.deepEqual(await worldlineCursor(owner,identity.worldlineId),head);
      const instances = (await owner.query<{id:string;continuity_id:string}>("SELECT id,continuity_id FROM character_instances WHERE workspace_id=$1 AND worldline_id=$2",[workspace,identity.worldlineId])).rows;
      assert.equal(instances.length,2);
      const rows = (await owner.query<{id:string;observer_continuity_id:string;observed_entity_key:string;content:string;available_from_tick:string;available_from_ordinal:string}>("SELECT id,observer_continuity_id,observed_entity_key,content,available_from_tick::text,available_from_ordinal::text FROM memory_conclusions WHERE workspace_id=$1 AND worldline_id=$2",[workspace,identity.worldlineId])).rows;
      for (const [index] of [affected,control].entries()) {
        const current: (typeof rows)[number] = rows.find(row=>row.content === `C4_${mode}_${index}_CURRENT`)!;
        const instance: (typeof instances)[number] = instances.find(row=>row.continuity_id === current.observer_continuity_id)!;
        const consumer = {workspaceId:workspace,worldId:scope.worldId,...identity,characterInstanceId:instance.id};
        const snapshots: {id:string;content:string;item_ids:string[];cache_epoch:number}[] = (await owner.query<{id:string;content:string;item_ids:string[];cache_epoch:number}>("SELECT id,content,item_ids,cache_epoch FROM memory_snapshots WHERE workspace_id=$1 AND worldline_id=$2 AND observer_continuity_id=$3",[workspace,identity.worldlineId,instance.continuity_id])).rows;
        assert.equal(snapshots.length,3);
        for (const snapshot of snapshots) {
          const delta = await repository.deltaAuthorized({...consumer,snapshotId:snapshot.id}); assert.ok(delta);
          assert.equal(delta.stale,index === 0 && hasFuture);
          assert.equal(delta.cacheEpoch,index === 0 ? expectedEpoch : 7);
          assert.equal(snapshot.cache_epoch,index === 0 ? sourceEpoch : 7);
          assert.equal(snapshot.content,snapshot.item_ids.map((id:string)=>rows.find(row=>row.id === id)!.content).join("\n"));
        }
        const recall = await repository.recallAuthorized({...consumer,query:"C4",keywords:["c4_fact"],embedding:new Array(384).fill(0),embeddingModel:"c4-test",limit:20});
        assert.ok(recall.some(row=>row.content === current.content));
        assert.ok(!recall.some(row=>row.content.endsWith("FUTURE")));
      }
      return {instances,rows};
    };
    const targetRows = await verifyTarget(target);
    const resaved = await saveSource(target.recordId); assert.equal(resaved.status,200); assert.ok(resaved.archive?.memory?.schemaVersion === 2);
    assert.deepEqual(resaved.archive.memory.cacheEpochs.map(row=>row.epoch).sort((a,b)=>a-b),[7,expectedEpoch].sort((a,b)=>a-b));
    assert.equal(resaved.archive.memory.snapshots.length,6);
    const second = await restorer.restore({...restoreInput,archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(resaved.archive)),idempotencyKey:`c4.second.${scope.recordId}`});
    await verifyTarget(second);
    const branchInput = {recordId:scope.recordId,idempotencyKey:`c4.branch.${scope.recordId}`};
    const branch = await branchPOST(request("/api/record/branch",branchInput)); assert.equal(branch.status,201);
    const branched = await branch.json(); await verifyTarget(branched);
    const replay = await branchPOST(request("/api/record/branch",branchInput)); assert.equal(replay.status,200);
    const replayBody = await replay.json(); assert.equal(replayBody.replayed,true); assert.equal(replayBody.worldlineId,branched.worldlineId);
    const current = targetRows.rows.find(row=>row.content === `C4_${mode}_0_CURRENT`)!;
    const instance = targetRows.instances.find(row=>row.continuity_id === current.observer_continuity_id)!;
    const consumer = {workspaceId:workspace,worldId:scope.worldId,worldlineId:target.worldlineId,recordId:target.recordId,characterInstanceId:instance.id};
    const fresh = await repository.createSnapshotAuthorized({...consumer,snapshotId:`c4_fresh_${randomUUID()}`,snapshotKind:"recall",content:current.content,itemIds:[current.id],tokenCount:10}); assert.ok(fresh);
    assert.equal(fresh.cacheEpoch,expectedEpoch);
    assert.equal((await repository.deltaAuthorized({...consumer,snapshotId:fresh.id}))?.stale,false,"actual post-restore snapshot writer uses the new counter");
    const revision = {...consumer,observedEntityKey:current.observed_entity_key,content:"C4 actual revision",memoryKind:"explicit" as const,fidelity:1,keywords:["c4_fact"],embedding:new Array(384).fill(0),embeddingModel:"c4-test",operation:"update" as const,supersedesMemoryId:current.id};
    if (expectedEpoch === 2147483647) {
      const beforeOverflow = await memoryImage();
      await assert.rejects(repository.appendAuthorized(revision),{code:"22003"});
      assert.deepEqual(await memoryImage(),beforeOverflow,"actual writer exhaustion rolls back formal writes");
    } else {
      await repository.appendAuthorized(revision);
      const delta = await repository.deltaAuthorized({...consumer,snapshotId:fresh.id}); assert.ok(delta);
      assert.equal(delta.stale,true); assert.equal(delta.cacheEpoch,expectedEpoch + 1);
      const old = (await owner.query("SELECT id FROM memory_snapshots WHERE workspace_id=$1 AND worldline_id=$2 AND observer_continuity_id=$3 AND id<>$4",[workspace,target.worldlineId,instance.continuity_id,fresh.id])).rows;
      for (const snapshot of old) assert.equal((await repository.deltaAuthorized({...consumer,snapshotId:snapshot.id}))?.stale,true,"real revision cannot revive an older cache epoch");
    }
    await writeFile(join(process.env.REALM_R1_EVIDENCE_DIR!,`c4-cache-${mode}-${process.pid}.json`),JSON.stringify({mode,sourceEpoch,expectedEpoch,head,sharedHead,snapshots:memory.snapshots,epochs:memory.cacheEpochs,target,second,branched,actualConsumer:true,actualRevisionWriter:true}),{flag:"wx"});
  });
}

}
