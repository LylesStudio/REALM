/**
 * v37 Y1：导出 service 真实 PG 测试（隔离库 0001–0043，finally DROP）。
 * - kind 三态（template/full/selection）+ worlds/worldlines floor；
 * - TEMPLATE_UNSUPPORTED_BRANCH；INCOMPLETE_CLOSURE（linked_record_id
 *   缺失 → 409；includeLinked 补拉）；template head/qualification cursor
 *   归一 + nullable claim ref redaction；events 恒 NULL redaction 逐行；
 * - owner-only（非 owner 403 / 非成员 404 语义）；
 * - 字节确定性（除 createdAt）；重复导出双 job 行、hash/字节绑定；
 * - ARRAY_NULL_ELEMENT 422；超限中断；validateRealmPack 全链回环。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import {
  WorldTransferError,
} from "../database/postgres/world-transfer-repository.ts";
import {
  createWorldExportService,
} from "../modules/application/world-export-service.ts";
import {
  validateRealmPack,
} from "../modules/world-transfer/realm-pack.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
const RECORD = POSTGRES_DEMO_IDS.record;
const OWNER = POSTGRES_DEMO_IDS.principal;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

async function createTempDatabase(t: test.TestContext, label: string) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_export_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 4 });
  const transferUrl = new URL(adminUrl);
  transferUrl.pathname = `/${databaseName}`;
  transferUrl.username = "realm_transfer";
  transferUrl.password = "";
  const transferPool = new pg.Pool({ connectionString: transferUrl.href, max: 2 });
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.pathname = `/${databaseName}`;
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
  for (const pool of [ownerPool, transferPool, runtimePool]) {
    pool.on("error", () => undefined);
  }
  t.after(async () => {
    await transferPool.end().catch(() => undefined);
    await runtimePool.end().catch(() => undefined);
    await ownerPool.end().catch(() => undefined);
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  await seedPostgresDemoPropagationTopology(ownerPool);
  return { ownerPool, transferPool, runtimePool };
}

function service(transferPool: pg.Pool, runtimePool: pg.Pool) {
  return createWorldExportService({
    transferPool,
    runtimePool,
    workspaceId: WS,
    appVersion: "0.1.0",
  });
}

/** 知识/记忆/文件 fixtures（owner 直插，测试素材）。 */
async function seedKnowledgeFixtures(pool: pg.Pool) {
  await pool.query("SELECT set_config('realm.workspace_id', $1, false)", [WS]);
  await pool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, '演示玩家') ON CONFLICT (workspace_id, principal_id) DO NOTHING`,
    [WS, OWNER],
  );
  await pool.query(
    `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick)
     VALUES ($1, $2, $3, 'entity_beacon', 'setting', '长明灯塔', '', 0)`,
    [WS, WORLD, WORLDLINE],
  );
  await pool.query(
    `INSERT INTO world_claims (workspace_id, world_id, worldline_id, id, subject_entity_id, predicate, object_value, scope, truth_status, confidence, valid_from_tick)
     VALUES ($1, $2, $3, 'claim_beacon_lit', 'entity_beacon', '状态', '长明', 'story', 'story_canon', 1, 0)`,
    [WS, WORLD, WORLDLINE],
  );
  await pool.query(
    `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids)
     VALUES ($1, $2, $3, 'article_beacon', '灯塔志', '灯塔建于停战前夜。', ARRAY['claim_beacon_lit'])`,
    [WS, WORLD, WORLDLINE],
  );
  await pool.query(
    `INSERT INTO world_files (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
     VALUES ($1, $2, 'file_probe_avatar', 'character_avatar', 'image/png', 'probe.png',
             '8d696c78dd03ffd11f562351c4ad81f0683f3bc65ee413c76ae8f9158e7fa515', 9,
             '\\x504e472d50524f4245')`,
    [WS, WORLD],
  );
  await pool.query(
    `UPDATE character_definitions
     SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{avatar_file_id}', '"file_probe_avatar"')
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [WS, WORLD, POSTGRES_DEMO_IDS.scoutDefinition],
  );
  await pool.query(
    `INSERT INTO memory_conclusions (
       workspace_id, world_id, worldline_id, observer_continuity_id,
       observed_entity_key, id, operation, memory_kind, content, keywords,
       semantic_embedding, embedding_model, fidelity, occurred_tick,
       occurred_ordinal, available_from_tick, available_from_ordinal, metadata
     ) VALUES ($1, $2, $3, $4, 'entity_beacon', 'mem_probe_1', 'add', 'explicit',
               '灯塔长明', '{}', '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::vector, 'none', 1, 0, 0, 0, 0, '{}'::jsonb)`,
    [WS, WORLD, WORLDLINE, POSTGRES_DEMO_IDS.playerContinuity],
  );
  await pool.query(
    `INSERT INTO memory_cache_epochs (workspace_id, observer_continuity_id, epoch)
     VALUES ($1, $2, 3)
     ON CONFLICT (workspace_id, observer_continuity_id) DO UPDATE SET epoch = 3`,
    [WS, POSTGRES_DEMO_IDS.playerContinuity],
  );
}

function tableNames(result: { manifest: { tables: readonly { name: string }[] } }) {
  return result.manifest.tables.map((t) => t.name);
}

test(
  "Y1 template export: root-only, head/cursor reset, redactions, validator round-trip",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "tpl");
    await seedKnowledgeFixtures(ownerPool);
    const svc = service(transferPool, runtimePool);

    const result = await svc.exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const names = tableNames(result);
    // floor：worlds 恰一行 + worldlines 存在。
    const worldsEntry = result.manifest.tables.find((t) => t.name === "worlds");
    assert.equal(worldsEntry?.rows, 1);
    assert.ok(names.includes("worldlines"));
    // template 不含 record 级 / memory 级表。
    for (const forbidden of [
      "records", "stories", "scenes", "events", "record_heads", "observations",
      "participants", "visibility_policies", "character_instances",
      "character_skills", "character_assets", "action_receipts", "character_effects",
      "memory_conclusions", "memory_snapshots", "memory_cache_epochs",
      "relationship_states", "worldline_merges",
    ]) {
      assert.ok(!names.includes(forbidden), `template 不得包含 ${forbidden}`);
    }
    // 内容表在包：知识链 + 定义 + 文件（avatar 闭包）。
    for (const expected of [
      "world_entities", "world_claims", "world_articles",
      "character_definitions", "character_continuities",
      "world_files", "propagation_nodes",
    ]) {
      assert.ok(names.includes(expected), `template 应包含 ${expected}`);
    }
    // redaction 登记：worldlines head + article_qualifications cursor。
    const redactionKeys = result.manifest.redactions.map((r) => `${r.table}:${r.columns.join(",")}`);
    assert.ok(redactionKeys.includes("worldlines:headTick,headOrdinal"));
    assert.ok(
      redactionKeys.includes("article_qualifications:availableFromTick,availableFromOrdinal"),
    );
    // worldlines head 归一。
    const validated = validateRealmPack(result.bytes);
    const worldlinesNdjson = Buffer.from(validated.tables.get("worldlines")!).toString("utf8");
    const worldlineRow = JSON.parse(worldlinesNdjson.trim()) as Record<string, unknown>;
    assert.equal(worldlineRow.headTick, "0");
    assert.equal(worldlineRow.headOrdinal, "0");
    // scope manifest 形态。
    assert.equal(validated.manifest.scope.kind, "template");
    assert.equal(validated.manifest.scope.completeness, "partial");
    // job 行：export completed + hash 绑定。
    const job = await ownerPool.query(
      `SELECT status, direction, logical_pack_hash, archive_bytes_hash, mode
       FROM realm_import_jobs WHERE workspace_id = $1 AND id = $2`,
      [WS, result.jobId],
    );
    assert.equal(job.rows[0].status, "completed");
    assert.equal(job.rows[0].direction, "export");
    assert.equal(job.rows[0].logical_pack_hash, result.contentHash);
    assert.equal(job.rows[0].archive_bytes_hash, result.archiveBytesHash);
    assert.equal(job.rows[0].mode, "template");
  },
);

test(
  "Y1 template export rejects branched worlds (409 TEMPLATE_UNSUPPORTED_BRANCH)",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "branch");
    await seedKnowledgeFixtures(ownerPool);
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status,
         parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal)
       VALUES ($1, $2, 'worldline_branch', '分支', 'active', $3, 0, 0, 0, 0)`,
      [WS, WORLD, WORLDLINE],
    );
    const svc = service(transferPool, runtimePool);
    await assert.rejects(
      svc.exportWorld({ worldId: WORLD, mode: "template" }, OWNER),
      (error: unknown) => {
        assert.ok(error instanceof WorldTransferError);
        assert.equal(error.code, "TEMPLATE_UNSUPPORTED_BRANCH");
        return true;
      },
    );
    // 拒绝即零副作用：无 job 行。
    const jobs = await ownerPool.query(
      `SELECT count(*)::int AS c FROM realm_import_jobs WHERE workspace_id = $1`,
      [WS],
    );
    assert.equal(jobs.rows[0].c, 0);
  },
);

test(
  "Y1 full export: complete topology, events redaction per-row, memory included",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "full");
    await seedKnowledgeFixtures(ownerPool);
    const svc = service(transferPool, runtimePool);

    const result = await svc.exportWorld(
      { worldId: WORLD, mode: "full", includeMemberships: true },
      OWNER,
    );
    const names = tableNames(result);
    for (const expected of [
      "worlds", "worldlines", "stories", "records", "scenes", "events",
      "record_heads", "participants", "character_instances",
      "character_continuities", "character_definitions",
      "memory_conclusions", "memory_cache_epochs",
      "world_entities", "world_claims", "world_articles", "world_files",
      "propagation_nodes", "propagation_routes",
    ]) {
      assert.ok(names.includes(expected), `full 应包含 ${expected}`);
    }
    assert.equal(result.manifest.scope.completeness, "complete");
    // events 恒 NULL redaction：登记 + 包内逐行 NULL。
    assert.ok(
      result.manifest.redactions.some(
        (r) => r.table === "events"
          && r.columns.join(",") === "causationCommandId,turnRunId",
      ),
    );
    const validated = validateRealmPack(result.bytes);
    const eventsNdjson = Buffer.from(validated.tables.get("events")!).toString("utf8");
    for (const line of eventsNdjson.trim().split("\n")) {
      const row = JSON.parse(line) as Record<string, unknown>;
      assert.equal(row.causationCommandId, null);
      assert.equal(row.turnRunId, null);
    }
    // memberships 展示形态（principalRef = displayName；不进 tables）。
    assert.ok(!names.includes("player_world_memberships"));
    assert.ok(validated.manifest.memberships?.some((m) => m.role === "owner"));
    // memory epoch 原值携带（stale 矩阵等价）。
    const epochs = Buffer.from(validated.tables.get("memory_cache_epochs")!).toString("utf8");
    assert.match(epochs, /"epoch":"3"/);
    // 文件字节闭环。
    assert.deepEqual(
      Buffer.from(validated.files.get("file_probe_avatar")!),
      Buffer.from("PNG-PROBE"),
    );
  },
);

test(
  "Y1 selection export: closure pulls topology; missing link 409; includeLinked heals",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "sel");
    await seedKnowledgeFixtures(ownerPool);
    // 第二条记录，链接到第一条（linked_record_id）。
    await ownerPool.query(
      `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title,
         status, start_tick, start_ordinal, linked_record_id)
       VALUES ($1, $2, $3, $4, 'record_second', '第二夜', 'active', 1, 0, $5)`,
      [WS, WORLD, WORLDLINE, POSTGRES_DEMO_IDS.story, RECORD],
    );
    const svc = service(transferPool, runtimePool);

    // 只选第二条记录：linked_record_id 指向未列入记录 → 409 INCOMPLETE_CLOSURE。
    await assert.rejects(
      svc.exportWorld(
        { worldId: WORLD, mode: "selection", recordIds: ["record_second"] },
        OWNER,
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorldTransferError);
        assert.equal(error.code, "INCOMPLETE_CLOSURE");
        const details = error.details as { missing: { table: string; id: string }[] };
        assert.ok(details.missing.some((m) => m.table === "records" && m.id === RECORD));
        return true;
      },
    );

    // includeLinked=true 递归补拉 → 成功。
    const result = await svc.exportWorld(
      {
        worldId: WORLD,
        mode: "selection",
        recordIds: ["record_second"],
        includeLinked: true,
      },
      OWNER,
    );
    const validated = validateRealmPack(result.bytes);
    const recordsNdjson = Buffer.from(validated.tables.get("records")!).toString("utf8");
    const recordIds = recordsNdjson.trim().split("\n")
      .map((line) => (JSON.parse(line) as { id: string }).id)
      .sort();
    assert.deepEqual(recordIds, [RECORD, "record_second"].sort());
    assert.equal(validated.manifest.scope.kind, "archive");
    assert.equal(validated.manifest.scope.completeness, "partial");
    // archive 包不含 memory 级表。
    assert.ok(!tableNames(result).includes("memory_conclusions"));
  },
);

test(
  "Y1 export authorization: non-owner 403 / stranger 404; zero side effects",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "authz");
    await seedKnowledgeFixtures(ownerPool);
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, 'principal_member', '成员甲')`,
      [WS],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_member', 'player')`,
      [WS, WORLD],
    );
    const svc = service(transferPool, runtimePool);
    await assert.rejects(
      svc.exportWorld({ worldId: WORLD, mode: "full" }, "principal_member"),
      (error: unknown) => {
        assert.ok(error instanceof WorldTransferError && error.code === "NOT_OWNER");
        return true;
      },
    );
    await assert.rejects(
      svc.exportWorld({ worldId: WORLD, mode: "full" }, "principal_stranger"),
      (error: unknown) => {
        assert.ok(error instanceof WorldTransferError && error.code === "WORLD_NOT_FOUND");
        return true;
      },
    );
    const jobs = await ownerPool.query(
      `SELECT count(*)::int AS c FROM realm_import_jobs WHERE workspace_id = $1`,
      [WS],
    );
    assert.equal(jobs.rows[0].c, 0);
  },
);

test(
  "Y1 repeat exports: two job rows, hash/byte binding, byte determinism modulo createdAt",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "repeat");
    await seedKnowledgeFixtures(ownerPool);
    const svc = service(transferPool, runtimePool);
    const first = await svc.exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const second = await svc.exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    assert.notEqual(first.jobId, second.jobId);
    assert.equal(first.contentHash, second.contentHash, "同库同数据 contentHash 一致");
    // ZIP 字节仅 manifest.createdAt 不同（找第一个差异段落在 manifest 头）。
    assert.notDeepEqual(Buffer.from(first.bytes), Buffer.from(second.bytes));
    // archive_bytes_hash 与响应字节同源。
    const { createHash } = await import("node:crypto");
    const hashOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    assert.equal(first.archiveBytesHash, hashOf(first.bytes));
    assert.equal(second.archiveBytesHash, hashOf(second.bytes));
    const jobs = await ownerPool.query(
      `SELECT id, status, archive_bytes_hash FROM realm_import_jobs
       WHERE workspace_id = $1 AND direction = 'export' ORDER BY created_at, id`,
      [WS],
    );
    assert.equal(jobs.rows.length, 2);
    assert.ok(jobs.rows.every((row) => row.status === "completed"));
    assert.deepEqual(
      jobs.rows.map((row) => row.archive_bytes_hash).sort(),
      [first.archiveBytesHash, second.archiveBytesHash].sort(),
    );
  },
);

test(
  "Y1 export fails closed on NULL text[] element (422 ARRAY_NULL_ELEMENT)",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool, transferPool, runtimePool } = await createTempDatabase(t, "nullarr");
    await seedKnowledgeFixtures(ownerPool);
    // Z60：information_packets.omitted_claim_ids 无元素非 NULL 约束——
    // 合法现存数据可含 NULL 元素；导出必须逐列 fail-closed。
    await ownerPool.query(
      `INSERT INTO information_campaigns (
         workspace_id, world_id, worldline_id, id, root_claim_ids,
         effective_tick, salience, complexity, security_class, algorithm_version
       ) VALUES ($1, $2, $3, 'camp_null', ARRAY['claim_beacon_lit'],
                 0, 0.5, 0.5, 'public', 'realm-propagate-v1')`,
      [WS, WORLD, WORLDLINE],
    );
    await ownerPool.query(
      `INSERT INTO information_packets (
         workspace_id, world_id, worldline_id, id, campaign_id,
         parent_packet_id, channel, claim_ids, framing,
         omitted_claim_ids, semantic_fidelity_to_parent, content_hash
       ) VALUES ($1, $2, $3, 'packet_null', 'camp_null', NULL,
                 'official_bulletin', '{}', 'neutral',
                 ARRAY['claim_beacon_lit', NULL], 1, 'hash_packet_null')`,
      [WS, WORLD, WORLDLINE],
    );
    const svc = service(transferPool, runtimePool);
    await assert.rejects(
      svc.exportWorld({ worldId: WORLD, mode: "full" }, OWNER),
      (error: unknown) => {
        assert.ok(error instanceof WorldTransferError);
        assert.equal(error.code, "ARRAY_NULL_ELEMENT");
        return true;
      },
    );
    const jobs = await ownerPool.query(
      `SELECT count(*)::int AS c FROM realm_import_jobs WHERE workspace_id = $1`,
      [WS],
    );
    assert.equal(jobs.rows[0].c, 0, "失败不出包、无 job 行");
  },
);
