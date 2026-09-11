/**
 * v37 Y3：导入 service 真实 PG 测试（双隔离库 finally DROP）。
 * - preserve/copy/template/archive 回环；逐表等价（再导出 contentHash
 *   一致 = 最强回环证据）；copy 重映射双副本 + alreadyImported；
 * - WORLD_EXISTS / ID_COLLISION 预扫与 execute 重扫；冲突零残留；
 * - principal 重写矩阵（copy → imported_legacy / 'dm' 原样 /
 *   participants → importer）；
 * - archive execute 永拒（dry-run 正常 staged）；
 * - tx2 全或无（execute 时刻冲突注入 → failed + 零残留 + 可 retry）；
 * - 并发 execute 串行 + alreadyImported；cancel 矩阵；reconcile 三态；
 * - MIGRATION_REQUIRED 缺 0042/0043；jobs 列表 operator 边界。
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
  createWorldExportService,
} from "../modules/application/world-export-service.ts";
import {
  WorldImportError,
  createWorldImportService,
} from "../modules/application/world-import-service.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
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
  const databaseName = `realm_import_${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 4, idleTimeoutMillis: 0 });
  const transferUrl = new URL(adminUrl);
  transferUrl.pathname = `/${databaseName}`;
  transferUrl.username = "realm_transfer";
  transferUrl.password = "";
  const transferPool = new pg.Pool({ connectionString: transferUrl.href, max: 2, idleTimeoutMillis: 0 });
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.pathname = `/${databaseName}`;
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2, idleTimeoutMillis: 0 });
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
  return { ownerPool, transferPool, runtimePool };
}

/** 源库：demo 世界 + 知识/资格/文件 fixtures。 */
async function seedSource(t: test.TestContext, label: string) {
  const db = await createTempDatabase(t, `${label}_src`);
  await seedPostgresDemo(db.ownerPool);
  await seedPostgresDemoPropagationTopology(db.ownerPool);
  await db.ownerPool.query("SELECT set_config('realm.workspace_id', $1, false)", [WS]);
  await db.ownerPool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, '演示玩家') ON CONFLICT DO NOTHING`,
    [WS, OWNER],
  );
  await db.ownerPool.query(
    `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick)
     VALUES ($1, $2, $3, 'entity_beacon', 'setting', '长明灯塔', '', 0)`,
    [WS, WORLD, WORLDLINE],
  );
  await db.ownerPool.query(
    `INSERT INTO world_claims (workspace_id, world_id, worldline_id, id, subject_entity_id, predicate, object_value, scope, truth_status, confidence, valid_from_tick)
     VALUES ($1, $2, $3, 'claim_beacon_lit', 'entity_beacon', '状态', '长明', 'story', 'story_canon', 1, 0)`,
    [WS, WORLD, WORLDLINE],
  );
  await db.ownerPool.query(
    `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids)
     VALUES ($1, $2, $3, 'article_beacon', '灯塔志', '灯塔建于停战前夜。', ARRAY['claim_beacon_lit'])`,
    [WS, WORLD, WORLDLINE],
  );
  await db.ownerPool.query(
    `INSERT INTO article_qualifications (workspace_id, world_id, worldline_id, article_id, id, seq,
       provenance_kind, status, content_hash, attested_by, attested_at)
     VALUES ($1, $2, $3, 'article_beacon', 'aq_probe_1', 1, 'owner_attest', 'qualified_public',
             'deadbeef', $4, CURRENT_TIMESTAMP)`,
    [WS, WORLD, WORLDLINE, OWNER],
  );
  await db.ownerPool.query(
    `INSERT INTO world_files (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
     VALUES ($1, $2, 'file_probe_avatar', 'character_avatar', 'image/png', 'probe.png',
             '8d696c78dd03ffd11f562351c4ad81f0683f3bc65ee413c76ae8f9158e7fa515', 9,
             '\\x504e472d50524f4245')`,
    [WS, WORLD],
  );
  await db.ownerPool.query(
    `UPDATE character_definitions
     SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{avatar_file_id}', '"file_probe_avatar"')
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [WS, WORLD, POSTGRES_DEMO_IDS.scoutDefinition],
  );
  return db;
}

/** 目标库：空 workspace + importer 账号。 */
async function seedTarget(t: test.TestContext, label: string) {
  const db = await createTempDatabase(t, `${label}_dst`);
  await db.ownerPool.query("INSERT INTO workspaces (id, name) VALUES ($1, '目标')", [WS]);
  await db.ownerPool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, '导入员') ON CONFLICT DO NOTHING`,
    [WS, OWNER],
  );
  return db;
}

function exportSvc(db: { transferPool: pg.Pool; runtimePool: pg.Pool }) {
  return createWorldExportService({
    transferPool: db.transferPool,
    runtimePool: db.runtimePool,
    workspaceId: WS,
    appVersion: "0.1.0",
  });
}

function importSvc(db: { transferPool: pg.Pool }) {
  return createWorldImportService({ transferPool: db.transferPool, workspaceId: WS });
}

test(
  "Y3 preserve round-trip: export → dry-run → execute → re-export contentHash identical",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "rt");
    const target = await seedTarget(t, "rt");
    const pack = await exportSvc(source).exportWorld(
      { worldId: WORLD, mode: "full", includeMemberships: true },
      OWNER,
    );

    const svc = importSvc(target);
    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.ok(dry.report.worldExists === false);
    assert.equal(dry.report.copyEligible, true);
    // memberships warning（展示形态不导入）。
    assert.ok(dry.report.warnings.some((w) => w.includes("memberships")));

    const done = await svc.execute({
      bytes: pack.bytes,
      jobId: dry.jobId,
      operatorPrincipal: OWNER,
    });
    assert.equal(done.alreadyImported, false);
    assert.equal(done.worldId, WORLD);

    // 幂等：重复 execute → alreadyImported。
    const again = await svc.execute({
      bytes: pack.bytes,
      jobId: dry.jobId,
      operatorPrincipal: OWNER,
    });
    assert.equal(again.alreadyImported, true);

    // 最强回环：目标库再导出 → contentHash 一致（含 memberships flag 不影响
    // contentHash——不进 tables[]/contentHash）。
    const reexported = await exportSvc(target).exportWorld(
      { worldId: WORLD, mode: "full" },
      OWNER,
    );
    assert.equal(reexported.contentHash, pack.contentHash);

    // 导入者成为新世界 owner（bootstrap owner membership）。
    const membership = await target.ownerPool.query(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, WORLD, OWNER],
    );
    assert.equal(membership.rows[0]?.role, "owner");
    // 文件字节闭环（bin → bytea）。
    const file = await target.ownerPool.query(
      `SELECT data FROM world_files WHERE workspace_id = $1 AND id = 'file_probe_avatar'`,
      [WS],
    );
    assert.deepEqual(file.rows[0].data, Buffer.from("PNG-PROBE"));
    // job 终态读回。
    const status = await svc.getStatus(dry.jobId);
    assert.equal(status?.status, "completed");
    assert.deepEqual(
      status?.events.map((event) => event.kind),
      ["created", "validation_done", "attempt_started", "import_committed"],
    );
  },
);

test(
  "Y3 copy mode: remapped twin world, second copy with another key, alreadyImported",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "copy");
    const target = await seedTarget(t, "copy");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "full" }, OWNER);
    const svc = importSvc(target);

    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "copy",
      copyKey: "alpha",
      operatorPrincipal: OWNER,
    });
    const done = await svc.execute({
      bytes: pack.bytes,
      jobId: dry.jobId,
      operatorPrincipal: OWNER,
    });
    assert.ok(done.worldId && done.worldId !== WORLD, "copy must remap worldId");
    assert.match(done.worldId!, /^world_[0-9a-f]{18}$/);

    // 双副本：同包 + 同 copyKey → 幂等 alreadyImported（同 job）。
    const dry2 = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "copy",
      copyKey: "alpha",
      operatorPrincipal: OWNER,
    });
    assert.equal(dry2.alreadyImported, true);
    assert.equal(dry2.jobId, dry.jobId);

    // 同包 + 不同 copyKey → 第二个副本。
    const dry3 = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "copy",
      copyKey: "beta",
      operatorPrincipal: OWNER,
    });
    const done3 = await svc.execute({
      bytes: pack.bytes,
      jobId: dry3.jobId,
      operatorPrincipal: OWNER,
    });
    assert.ok(done3.worldId && done3.worldId !== done.worldId);

    // 重映射一致性：副本内全部引用指向副本 id（qualification.attested_by
    // 非 principal_ 前缀保持/系统 actor 原样；participants → importer）。
    const twin = await target.ownerPool.query(
      `SELECT id, world_id, worldline_id FROM records
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, done.worldId],
    );
    assert.ok(twin.rows.length > 0);
    for (const row of twin.rows) {
      assert.match(row.id, /^record_[0-9a-f]{18}$/);
      assert.equal(row.world_id, done.worldId);
    }
    const participants = await target.ownerPool.query(
      `SELECT principal_id FROM participants
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id IS NOT NULL`,
      [WS, done.worldId],
    );
    for (const row of participants.rows) {
      assert.equal(row.principal_id, OWNER, "participants.principal_id → importer");
    }
  },
);

test(
  "Y3 template round-trip: head reset, no record tables, active world",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "tpl");
    const target = await seedTarget(t, "tpl");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const svc = importSvc(target);
    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    const done = await svc.execute({
      bytes: pack.bytes,
      jobId: dry.jobId,
      operatorPrincipal: OWNER,
    });
    const worldline = await target.ownerPool.query(
      `SELECT head_tick::text AS t, head_ordinal::text AS o FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, done.worldId],
    );
    assert.deepEqual(worldline.rows[0], { t: "0", o: "0" });
    const records = await target.ownerPool.query(
      `SELECT count(*)::int AS c FROM records WHERE workspace_id = $1 AND world_id = $2`,
      [WS, done.worldId],
    );
    assert.equal(records.rows[0].c, 0, "template 零 record 级内容");
  },
);

test(
  "Y3 archive pack: dry-run stages normally; execute always rejected (422)",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "arch");
    const target = await seedTarget(t, "arch");
    const pack = await exportSvc(source).exportWorld(
      { worldId: WORLD, mode: "selection", recordIds: [POSTGRES_DEMO_IDS.record] },
      OWNER,
    );
    const svc = importSvc(target);
    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.ok(dry.report.kind === "archive");
    assert.ok(dry.report.warnings.some((w) => w.includes("read-only")));
    const status = await svc.getStatus(dry.jobId);
    assert.equal(status?.status, "staged");

    await assert.rejects(
      svc.execute({
        bytes: pack.bytes,
        jobId: dry.jobId,
        operatorPrincipal: OWNER,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorldImportError);
        assert.equal(error.code, "ARCHIVE_PACK_NOT_IMPORTABLE");
        return true;
      },
    );
    // DB 兜底：job 永不到 executing/completed。
    const after = await svc.getStatus(dry.jobId);
    assert.equal(after?.status, "staged");
  },
);

test(
  "Y3 conflicts: WORLD_EXISTS at dry-run report + execute 409; ID_COLLISION pre-scan",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "conf");
    const target = await seedTarget(t, "conf");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const svc = importSvc(target);

    // 第一次导入成功。
    const first = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    await svc.execute({ bytes: pack.bytes, jobId: first.jobId, operatorPrincipal: OWNER });

    // 同包再 dry-run → alreadyImported（幂等读回，不是冲突）。
    const again = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.equal(again.alreadyImported, true);

    // 他包（不同内容）preserve → 同 worldId → WORLD_EXISTS（dry-run failed
    // 终态 + report 列出；execute 409）。
    const pack2 = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "full" }, OWNER);
    const dry2 = await svc.dryRun({
      bytes: pack2.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.equal(dry2.report.worldExists, true);
    await assert.rejects(
      svc.execute({ bytes: pack2.bytes, jobId: dry2.jobId, operatorPrincipal: OWNER }),
      (error: unknown) => {
        // validation-failed 是终态：begin_execute RAISE → JOB_STATE_CONFLICT。
        assert.ok(error instanceof WorldImportError);
        assert.equal(error.code, "JOB_STATE_CONFLICT");
        return true;
      },
    );

    // ID_COLLISION：目标库存在同 id 的 stories 行（他世界）→ 预扫命中。
    const source2 = await seedSource(t, "conf2");
    // 制造内容微差的新包：改写源库世界名再导出（不同 fixture 库/时间戳，
    // contentHash 必异）。
    await source2.ownerPool.query(
      `UPDATE worlds SET name = '异名世界' WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );
    const pack4 = await exportSvc(source2).exportWorld(
      { worldId: WORLD, mode: "template" }, OWNER,
    );
    // ID_COLLISION：独立目标库——worldId 不存在（无 WORLD_EXISTS 干扰），
    // 但 worldlines.id 在他世界名下已占用（workspace 级 id 预扫）。
    const target2 = await seedTarget(t, "conf_dst2");
    await target2.ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, 'world_other', '他世界', 'c')`,
      [WS],
    );
    await target2.ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label) VALUES ($1, 'world_other', $2, '他线')`,
      [WS, WORLDLINE],
    );
    const svc2 = importSvc(target2);
    const dry4 = await svc2.dryRun({
      bytes: pack4.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.equal(dry4.report.worldExists, false);
    assert.ok(
      dry4.report.idCollisions.some(
        (collision) => collision.table === "worldlines" && collision.id === WORLDLINE,
      ),
      `应列出 worldlines 冲突：${JSON.stringify(dry4.report.idCollisions)}`,
    );
    // 冲突包 execute → 409（JOB_STATE_CONFLICT：validation-failed 终态）。
    await assert.rejects(
      svc2.execute({ bytes: pack4.bytes, jobId: dry4.jobId, operatorPrincipal: OWNER }),
      (error: unknown) => {
        assert.ok(error instanceof WorldImportError);
        assert.equal(error.code, "JOB_STATE_CONFLICT");
        return true;
      },
    );
    // 幂等读回：同包重 dry-run → alreadyValidated + 既有 report。
    const redry4 = await svc2.dryRun({
      bytes: pack4.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.equal(redry4.alreadyValidated, true);
    assert.ok(redry4.report.idCollisions.length > 0);
  },
);

test(
  "Y3 tx2 all-or-nothing: conflict injected after dry-run → failed + zero residue + retry heals",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "atomic");
    const target = await seedTarget(t, "atomic");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const svc = importSvc(target);
    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    // dry-run 后注入冲突（world 已存在）→ execute 重扫拒绝。
    await target.ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, '抢占', 'c')`,
      [WS, WORLD],
    );
    await assert.rejects(
      svc.execute({ bytes: pack.bytes, jobId: dry.jobId, operatorPrincipal: OWNER }),
      (error: unknown) => {
        assert.ok(error instanceof WorldImportError && error.code === "WORLD_EXISTS");
        return true;
      },
    );
    // 零残留：无孤儿世界内容、job failed + 事件闭环。
    const job = await target.ownerPool.query(
      `SELECT status, error_code FROM realm_import_jobs WHERE workspace_id = $1 AND id = $2`,
      [WS, dry.jobId],
    );
    assert.equal(job.rows[0].status, "failed");
    assert.equal(job.rows[0].error_code, "WORLD_EXISTS");
    const orphans = await target.ownerPool.query(
      `SELECT count(*)::int AS c FROM realm_import_bootstrap WHERE workspace_id = $1 AND job_id = $2`,
      [WS, dry.jobId],
    );
    assert.equal(orphans.rows[0].c, 0);
    // 清除冲突后 retry 成功（failed(execute) 可 retry——事件绑定当前轮次）。
    await target.ownerPool.query(
      `DELETE FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );
    const retry = await svc.execute({
      bytes: pack.bytes,
      jobId: dry.jobId,
      operatorPrincipal: OWNER,
    });
    assert.equal(retry.alreadyImported, false);
    assert.equal(retry.worldId, WORLD);
  },
);

test(
  "Y3 cancel matrix + reconcile stale three-state + jobs operator boundary",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "cancel");
    const target = await seedTarget(t, "cancel");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "template" }, OWNER);
    const svc = importSvc(target);

    // staged → cancel → 幂等读回 → 同包可重 dry-run（cancelled 不占槽）。
    const dry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    const cancelled = await svc.cancel({ jobId: dry.jobId });
    assert.deepEqual(cancelled, { status: "cancelled", idempotent: false });
    const cancelledAgain = await svc.cancel({ jobId: dry.jobId });
    assert.deepEqual(cancelledAgain, { status: "cancelled", idempotent: true });
    const redry = await svc.dryRun({
      bytes: pack.bytes,
      importMode: "preserve",
      operatorPrincipal: OWNER,
    });
    assert.notEqual(redry.jobId, dry.jobId);

    // reconcile：stale executing → failed + crash_recovered(attemptNo)；
    // stale pending → cancelled（无 error 列）。stale 状态经受控函数链到达
    // （直 INSERT 被 insert guard 拒绝——一并覆盖）。
    const transferClient = await target.transferPool.connect();
    t.after(() => {
      try { transferClient.release(); } catch { /* released */ }
    });
    await transferClient.query("SELECT set_config('realm.workspace_id', $1, false)", [WS]);
    const staleEntries = JSON.stringify([
      { name: "worldlines", rows: 1, sha256: "6".repeat(64), wireDigest: "f".repeat(64) },
      { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64) },
    ]);
    const staleHash = (await import("node:crypto")).createHash("sha256").update(
      "worldlines\n1\n" + "6".repeat(64) + "\n" + "f".repeat(64) + "\n"
      + "worlds\n1\n" + "4".repeat(64) + "\n" + "a".repeat(64) + "\n",
    ).digest("hex");
    // pending（永不到 executing）。
    await transferClient.query(
      `SELECT realm_import_job_create($1, 'job_stale_pending', 'import', $2, $3, $4, '', 'template', 'world_x', $5, $6)`,
      [WS, "a1".padEnd(64, "a"), "b1".padEnd(64, "b"), "c1".padEnd(64, "c"), OWNER, staleHash],
    );
    // executing（create → begin_validation → register → staged → begin_execute）。
    await transferClient.query(
      `SELECT realm_import_job_create($1, 'job_stale_executing', 'import', $2, $3, $4, '', 'template', 'world_x', $5, $6)`,
      [WS, "a2".padEnd(64, "a"), "b2".padEnd(64, "b"), "c2".padEnd(64, "c"), OWNER, staleHash],
    );
    await transferClient.query(
      "SELECT realm_import_job_begin_validation($1, 'job_stale_executing')", [WS]);
    await transferClient.query(
      "SELECT realm_import_register_pack_tables($1, 'job_stale_executing', $2::jsonb)",
      [WS, staleEntries]);
    await transferClient.query(
      "SELECT realm_import_job_finish_validation($1, 'job_stale_executing', 'staged', NULL, NULL, '{}'::jsonb)",
      [WS]);
    await transferClient.query(
      "SELECT realm_import_job_begin_execute($1, 'job_stale_executing')", [WS]);
    // 回拨 updated_at 越过 30min 阈值（updated_at 不在不可变列清单）。
    await target.ownerPool.query(
      `UPDATE realm_import_jobs SET updated_at = CURRENT_TIMESTAMP - interval '1 hour'
       WHERE workspace_id = $1 AND id IN ('job_stale_pending', 'job_stale_executing')`,
      [WS],
    );
    // 专用连接使命结束即归还（transfer 池 max=2，service 调用需要空闲位）。
    transferClient.release();
    const recovered = await svc.reconcile();
    assert.equal(recovered, 2);
    const staleRows = await target.ownerPool.query(
      `SELECT id, status, error_code FROM realm_import_jobs
       WHERE workspace_id = $1 AND id LIKE 'job_stale_%' ORDER BY id`,
      [WS],
    );
    assert.deepEqual(
      staleRows.rows.map((row) => [row.id, row.status, row.error_code]),
      [
        ["job_stale_executing", "failed", "PROCESS_CRASH"],
        ["job_stale_pending", "cancelled", null],
      ],
    );

    // jobs 列表：仅 operator 本人。
    const jobs = await svc.listJobs({ operatorPrincipal: OWNER, limit: 20, offset: 0 });
    assert.ok(jobs.length >= 3);
    const nobody = await svc.listJobs({ operatorPrincipal: "principal_nobody", limit: 20, offset: 0 });
    assert.equal(nobody.length, 0);
    // limit/offset 边界。
    const page = await svc.listJobs({ operatorPrincipal: OWNER, limit: 1, offset: 999 });
    assert.equal(page.length, 0);
  },
);

test(
  "Y3 MIGRATION_REQUIRED: target without 0042/0043 reports missing filenames",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const source = await seedSource(t, "mig_src");
    const pack = await exportSvc(source).exportWorld({ worldId: WORLD, mode: "template" }, OWNER);

    // 目标库只到 0041。
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_import_mig_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2, idleTimeoutMillis: 0 });
    const transferUrl = new URL(adminUrl);
    transferUrl.pathname = `/${databaseName}`;
    transferUrl.username = "realm_transfer";
    transferUrl.password = "";
    const transferPool = new pg.Pool({ connectionString: transferUrl.href, max: 2, idleTimeoutMillis: 0 });
    ownerPool.on("error", () => undefined);
    transferPool.on("error", () => undefined);
    t.after(async () => {
      await transferPool.end().catch(() => undefined);
      await ownerPool.end().catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql") || /^004[23]_/.test(filename)) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await ownerPool.query("INSERT INTO workspaces (id, name) VALUES ($1, '目标')", [WS]);
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES ($1, $2, '导入员')`,
      [WS, OWNER],
    );

    const svc = createWorldImportService({ transferPool, workspaceId: WS });
    await assert.rejects(
      svc.dryRun({ bytes: pack.bytes, importMode: "preserve", operatorPrincipal: OWNER }),
      (error: unknown) => {
        assert.ok(error instanceof WorldImportError);
        assert.equal(error.code, "MIGRATION_REQUIRED");
        assert.deepEqual(
          (error.details as { missing: string[] }).missing,
          [
            "0042_realm_transfer_and_import_jobs.sql",
            "0043_propagation_node_audience_archived_guard.sql",
          ],
        );
        return true;
      },
    );
  },
);
