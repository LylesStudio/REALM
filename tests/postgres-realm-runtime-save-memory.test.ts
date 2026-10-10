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
  ownerPool.on("error", () => {});
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  runtimePool.on("error", () => {});

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
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
    const archive = await reader.load({
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
    for (const [index, target] of targetConclusions.entries()) {
      const source = sourceConclusions[index]!;
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
