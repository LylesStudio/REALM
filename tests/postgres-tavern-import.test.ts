import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRecordRuntimeScopeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { importTavernBundle } from "../modules/application/tavern-import-service.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
      "0017_account_last_opened.sql",
      "0018_account_last_opened_fk_set_null.sql",
      "0024_graph_invalidation_events.sql",
    "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
];

function buildPngWithCard(card: unknown): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const base64 = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([
      Buffer.from("chara", "latin1"),
      Buffer.from([0]),
      Buffer.from(base64, "latin1"),
    ])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "tavern import writes character + avatar + articles atomically as realm_runtime",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_tavern_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(runtimeConnectionString!);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
    t.after(async () => {
      await ownerPool.end();
      await runtimePool.end();
      await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    const png = buildPngWithCard({
      spec: "chara_card_v2",
      data: {
        name: "艾拉",
        description: "旅队里的年轻制图师。",
        character_book: {
          entries: [
            { name: "商路", content: "群山商路每逢月圆封山。", keys: ["商路"], enabled: true },
            { name: "旧约", content: "旧约条目内容。", keys: [], enabled: false },
          ],
        },
      },
    });

    // 导入主体走 owner 通道（character_definitions 不授 realm_runtime INSERT，
    // 与 library 面板既有创建路径一致）；world_files 的 realm_runtime 授权单独验证。
    const report = await importTavernBundle(
      ownerPool,
      { workspaceId: "ws_demo", worldId: "world_ember_coast" },
      png,
      "ella.png",
    );
    assert.equal(report.character?.name, "艾拉");
    assert.ok(report.character?.avatarFileId);
    assert.deepEqual(report.articlesCreated, ["商路"]);
    assert.deepEqual(report.skippedDisabled, ["旧约"]);

    const character = await ownerPool.query(
      `SELECT display_name, source_format, profile FROM character_definitions
       WHERE world_id = 'world_ember_coast' AND display_name = '艾拉'`,
    );
    assert.equal(character.rows[0].source_format, "sillytavern_character_card");
    assert.equal(character.rows[0].profile.spec, "chara_card_v2");
    assert.equal(
      character.rows[0].profile.avatar_file_id,
      report.character!.avatarFileId,
    );
    assert.equal(character.rows[0].profile.description, "旅队里的年轻制图师。");

    const file = await ownerPool.query(
      `SELECT content_type, size_bytes, sha256, octet_length(data) AS bytes
       FROM world_files WHERE id = $1`,
      [report.character!.avatarFileId],
    );
    assert.equal(file.rows[0].content_type, "image/png");
    assert.equal(file.rows[0].bytes, png.length);

    const articles = await ownerPool.query(
      `SELECT title, body FROM world_articles WHERE world_id = 'world_ember_coast'`,
    );
    assert.equal(articles.rows.length, 1);
    assert.equal(articles.rows[0].title, "商路");

    // 批次 T11-A2（W9）：导入事务直写 world_articles 合并为一个 article
    // 失效事件（reason=tavern-import）。
    const importEvents = await ownerPool.query(
      `SELECT kind, reason FROM graph_invalidation_events
       WHERE world_id = 'world_ember_coast'`,
    );
    assert.deepEqual(
      importEvents.rows.map((row) => [row.kind, row.reason]),
      [["article", "tavern-import"]],
    );

    // world_files：realm_runtime 可 INSERT/SELECT（0016 授权验证，
    // RLS 要求事务内设置 workspace 上下文）。
    const probe = Buffer.from("probe");
    const runtimeClient = await runtimePool.connect();
    try {
      await runtimeClient.query("BEGIN");
      await runtimeClient.query(
        `SELECT set_config('realm.workspace_id', 'ws_demo', true)`,
      );
      await runtimeClient.query(
        `INSERT INTO world_files (workspace_id, world_id, id, kind, content_type, sha256, size_bytes, data)
         VALUES ('ws_demo', 'world_ember_coast', 'file_runtimeprobe01', 'character_avatar', 'image/png', 'probe', 5, $1)`,
        [probe],
      );
      const runtimeRead = await runtimeClient.query(
        `SELECT id FROM world_files WHERE id = 'file_runtimeprobe01'`,
      );
      assert.equal(runtimeRead.rows.length, 1);
      await runtimeClient.query("COMMIT");
    } finally {
      runtimeClient.release();
    }

    // 坏文件：不落任何数据。
    await assert.rejects(
      importTavernBundle(
        ownerPool,
        { workspaceId: "ws_demo", worldId: "world_ember_coast" },
        Buffer.from("not a card at all"),
        "bad.json",
      ),
    );
    const after = await ownerPool.query(
      `SELECT count(*)::int AS count FROM character_definitions
       WHERE world_id = 'world_ember_coast' AND display_name = '坏卡'`,
    );
    assert.equal(after.rows[0].count, 0);
  },
);

/**
 * Article qualification G2（plan v10 §6.1/§7 G2）：Tavern file_exact 去重。
 * 全量迁移链（含 0041）：source identity 持久化于 article_import_entries，
 * namespace=bundle sha256、identity=entry ordinal（schema CHECK 锁死）；
 * 精确同文件重复 → SAVEPOINT 撤销 candidate + DB readback 判 duplicate，
 * 无孤儿 article/qualification；不同 bundle 不碰撞；uid 仅信息列；
 * 导入文章默认 pending_review 且不进 lore。
 */
test(
  "tavern worldbook import: file_exact dedup, concurrent safety and pending qualification",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
      throw new Error("loopback only");
    }
    const databaseName = `realm_tavern_g2_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const ownerPoolB = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });
    t.after(async () => {
      await runtimePool.end();
      await ownerPoolB.end();
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const ws = POSTGRES_DEMO_IDS.workspace;
    const worldId = POSTGRES_DEMO_IDS.world;
    const scope = { workspaceId: ws, worldId };
    const book = (entries: unknown[]) =>
      Buffer.from(JSON.stringify({ entries }), "utf8");
    const countRows = async () => {
      const counts = await ownerPool.query(
        `SELECT
           (SELECT count(*)::int FROM world_articles WHERE workspace_id = $1) AS articles,
           (SELECT count(*)::int FROM article_import_entries WHERE workspace_id = $1) AS entries,
           (SELECT count(*)::int FROM article_qualifications WHERE workspace_id = $1) AS quals`,
        [ws],
      );
      return counts.rows[0] as { articles: number; entries: number; quals: number };
    };

    // ---- ① 首次导入：article + pending qualification + import entry ----
    const bundleA = book([
      { name: "商路", content: "群山商路每逢月圆封山。", keys: ["商路"], enabled: true },
      { name: "旧港", uid: 7, content: "旧港潮汐表。", enabled: true },
      { name: "废弃", content: "停用条目。", enabled: false },
    ]);
    const bundleHashA = createHash("sha256").update(bundleA).digest("hex");
    const report1 = await importTavernBundle(ownerPool, scope, bundleA, "book-a.json");
    assert.deepEqual(report1.articlesCreated, ["商路", "旧港"]);
    assert.deepEqual(report1.skippedDisabled, ["废弃"]);
    assert.deepEqual(report1.duplicates, []);
    assert.deepEqual(report1.contentChanged, []);
    assert.deepEqual(report1.conflictAnomaly, []);
    assert.deepEqual(report1.identityUnstable, ["商路"], "无 uid 的 entry 列入 identityUnstable");

    const entries1 = await ownerPool.query(
      `SELECT stable_entry_identity, source_namespace, identity_kind, entry_uid,
              entry_ordinal::text AS entry_ordinal, normalized_name,
              bundle_content_hash, entry_content_hash, article_id
       FROM article_import_entries
       WHERE workspace_id = $1 ORDER BY entry_ordinal ASC`,
      [ws],
    );
    assert.equal(entries1.rows.length, 2);
    assert.equal(entries1.rows[0].stable_entry_identity, "0");
    assert.equal(entries1.rows[1].stable_entry_identity, "1");
    assert.equal(entries1.rows[0].source_namespace, bundleHashA);
    assert.equal(entries1.rows[0].bundle_content_hash, bundleHashA);
    assert.equal(entries1.rows[0].identity_kind, "file_exact");
    assert.equal(entries1.rows[0].entry_uid, null);
    assert.equal(entries1.rows[1].entry_uid, "7", "uid 仅作信息列保留");
    assert.equal(entries1.rows[0].normalized_name, "商路");
    assert.match(entries1.rows[0].entry_content_hash, /^[0-9a-f]{64}$/);

    const quals1 = await ownerPool.query(
      `SELECT article_id, seq::text AS seq, provenance_kind, status, attested_by
       FROM article_qualifications WHERE workspace_id = $1 ORDER BY article_id`,
      [ws],
    );
    assert.equal(quals1.rows.length, 2);
    for (const row of quals1.rows) {
      assert.equal(row.seq, "1");
      assert.equal(row.provenance_kind, "tavern_import");
      assert.equal(row.status, "pending_review", "导入文章默认 pending_review");
      assert.equal(row.attested_by, null);
    }
    // 三 hash 分离：qualification hash 绑定 article.id，entry hash 不含。
    const articleRow = await ownerPool.query(
      `SELECT article.id, article.title, article.body, qual.content_hash
       FROM world_articles AS article
       JOIN article_qualifications AS qual
         ON qual.workspace_id = article.workspace_id AND qual.article_id = article.id
       WHERE article.workspace_id = $1 AND article.title = '商路'`,
      [ws],
    );
    const expectedQualHash = createHash("sha256")
      .update(`${articleRow.rows[0].id}\n商路\n群山商路每逢月圆封山。`, "utf8")
      .digest("hex");
    assert.equal(articleRow.rows[0].content_hash, expectedQualHash);
    const expectedEntryHash = createHash("sha256")
      .update("商路\n群山商路每逢月圆封山。", "utf8")
      .digest("hex");
    assert.equal(entries1.rows[0].entry_content_hash, expectedEntryHash);
    assert.notEqual(entries1.rows[0].entry_content_hash, articleRow.rows[0].content_hash);

    // ---- ② 精确同文件重复：duplicates + 零新增 ----
    const before2 = await countRows();
    const report2 = await importTavernBundle(ownerPool, scope, bundleA, "book-a-again.json");
    assert.deepEqual(report2.articlesCreated, []);
    assert.deepEqual(report2.duplicates, ["商路", "旧港"]);
    assert.deepEqual(report2.skippedDisabled, ["废弃"]);
    assert.deepEqual(await countRows(), before2, "重复导入不得新增任何行");

    // ---- ③ 不同 bundle（内容变化）→ 新 namespace 新行，不误合并 ----
    const bundleB = book([
      { name: "商路", content: "群山商路已改道。", keys: ["商路"], enabled: true },
    ]);
    const bundleHashB = createHash("sha256").update(bundleB).digest("hex");
    assert.notEqual(bundleHashB, bundleHashA);
    const report3 = await importTavernBundle(ownerPool, scope, bundleB, "book-b.json");
    assert.deepEqual(report3.articlesCreated, ["商路"]);
    assert.deepEqual(report3.duplicates, [], "file_exact 不声称跨上传 content_changed");
    const namespaces = await ownerPool.query(
      `SELECT DISTINCT source_namespace FROM article_import_entries WHERE workspace_id = $1`,
      [ws],
    );
    assert.equal(namespaces.rows.length, 2, "不同 bundle 必须不同 namespace（不碰撞）");

    // ---- ④ 同名不同位置 → 不同 identity ----
    const bundleC = book([
      { name: "同名", content: "甲条目。", enabled: true },
      { name: "同名", content: "乙条目。", enabled: true },
    ]);
    const report4 = await importTavernBundle(ownerPool, scope, bundleC, "book-c.json");
    assert.deepEqual(report4.articlesCreated, ["同名", "同名"]);
    const sameName = await ownerPool.query(
      `SELECT stable_entry_identity FROM article_import_entries
       WHERE workspace_id = $1 AND normalized_name = '同名' ORDER BY entry_ordinal`,
      [ws],
    );
    assert.deepEqual(
      sameName.rows.map((row) => row.stable_entry_identity),
      ["0", "1"],
    );

    // ---- ⑤ 并发双导入同一文件：一方创建一方 duplicate，无孤儿 candidate ----
    const bundleD = book([
      { name: "并发条目", content: "并发正文。", enabled: true },
    ]);
    const [reportA, reportB] = await Promise.all([
      importTavernBundle(ownerPool, scope, bundleD, "book-d.json"),
      importTavernBundle(ownerPoolB, scope, bundleD, "book-d.json"),
    ]);
    const created = [reportA, reportB].filter((report) => report.articlesCreated.length > 0);
    const duplicated = [reportA, reportB].filter((report) => report.duplicates.length > 0);
    assert.equal(created.length, 1, "并发双导入恰好一方创建");
    assert.equal(duplicated.length, 1, "并发双导入恰好一方 duplicate");
    const concurrentRows = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM world_articles
           WHERE workspace_id = $1 AND title = '并发条目') AS articles,
         (SELECT count(*)::int FROM article_import_entries
           WHERE workspace_id = $1 AND normalized_name = '并发条目') AS entries,
         (SELECT count(*)::int FROM article_qualifications qual
           JOIN world_articles article
             ON article.workspace_id = qual.workspace_id
            AND article.id = qual.article_id
           WHERE qual.workspace_id = $1 AND article.title = '并发条目') AS quals`,
      [ws],
    );
    assert.deepEqual(
      concurrentRows.rows[0],
      { articles: 1, entries: 1, quals: 1 },
      "并发导入必须只有一组 article/entry/qualification（无孤儿 candidate）",
    );

    // ---- ⑥ 导入文章（pending + 空 claim_ids）不进 lore ----
    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const recordScope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(recordScope);
    assert.ok(!recordScope!.brief.worldLore.includes("商路"), "pending 文章不得进 lore");

    // ---- ⑦ realm_runtime 违反 aie_identity_check 被拒（schema 锁死 identity） ----
    const runtimeClient = await runtimePool.connect();
    try {
      await runtimeClient.query("BEGIN");
      await runtimeClient.query(
        "SELECT set_config('realm.workspace_id', $1, true)",
        [ws],
      );
      await assert.rejects(
        runtimeClient.query(
          `INSERT INTO article_import_entries (
             workspace_id, world_id, worldline_id, article_id, id,
             source_kind, source_namespace, stable_entry_identity, identity_kind,
             entry_uid, entry_ordinal, normalized_name,
             bundle_content_hash, entry_content_hash
           )
           SELECT $1, $2, $3, article.id, 'aie_bad_identity',
                  'tavern_worldbook', $4, 'not-an-ordinal', 'file_exact',
                  NULL, 0, '探针', $4, $5
           FROM world_articles AS article
           WHERE article.workspace_id = $1 AND article.title = '并发条目'`,
          [
            ws,
            worldId,
            POSTGRES_DEMO_IDS.worldline,
            createHash("sha256").update(bundleD).digest("hex"),
            expectedEntryHash,
          ],
        ),
        (error: unknown) => error instanceof Error && /aie_identity_check/.test(error.message),
      );
      await runtimeClient.query("ROLLBACK");
    } finally {
      runtimeClient.release();
    }
  },
);
