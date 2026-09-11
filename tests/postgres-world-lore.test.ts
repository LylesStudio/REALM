/**
 * Shared World Memory 下一阶段（G4）：attested-only article excerpt 读取。
 * 资格：当前 worldline + latest qualification = qualified_public/owner_attest
 * + DB-side hash match + Record head tuple >= available_from + claim_ids 为空
 * + 预算；claim 链接本身不再授予资格（链接合格 ≠ 正文安全）；无资格行 =
 * pending_review fail-closed。计划：/tmp/realm-swm-next-plan-v10.md §3.2。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRecordRuntimeScopeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

test(
  "world lore excerpts: only worldline-scoped articles linked to eligible canon claims",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
      throw new Error("loopback only");
    }
    const databaseName = `realm_worldlore_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await runtimePool.end();
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
    const worldlineId = POSTGRES_DEMO_IDS.worldline;
    const head = (await ownerPool.query(
      `SELECT head_tick::text AS t FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [ws, worldlineId],
    )).rows[0];
    const headTick = Number(head.t);

    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_lore_beacon', 'setting', '长明灯塔', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    async function insertClaim(id: string, truth: string, vf: number, vt: number | null, supersedes: string | null) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_lore_beacon', '状态', $5, 'story', $6, 1, $7, $8, NULL, NULL, $9)`,
        [ws, worldId, worldlineId, id, `值-${id}`, truth, vf, vt, supersedes],
      );
    }
    async function insertArticle(id: string, title: string, body: string, claimIds: string[], worldline: string = worldlineId) {
      await ownerPool.query(
        `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], ARRAY[]::text[])`,
        [ws, worldId, worldline, id, title, body, claimIds],
      );
    }

    // 合格：链接到当前有效 story_canon 的文章——G4 起链接本身不再授予资格
    // （claim_ids 非空结构性排除），必须不注入。
    await insertClaim("claim_lore_ok", "story_canon", Math.max(0, headTick - 1), null, null);
    await insertArticle("article_lore_ok", "灯塔志", "灯塔建于停战前夜，守灯人世代更替。", ["claim_lore_ok"]);
    // 唯一合格路径：claim_ids 为空 + owner attestation（available_from (0,0)）。
    await insertArticle("article_lore_attested", "守灯名录", "停战前夜的守灯人名录与轮值表。", []);
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_attest_lore', 1, 'owner_attest', 'qualified_public',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_lore_attested'`,
      [ws],
    );
    // rejected 资格：不注入。
    await insertArticle("article_lore_rejected", "拒稿志", "被 owner 拒绝的长文。", []);
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_reject_lore', 1, 'owner_attest', 'rejected',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_lore_rejected'`,
      [ws],
    );
    // 不合格：Tavern 式空链接且无资格行（pending_review 默认排除）。
    await insertArticle("article_lore_tavern", "酒馆轶闻", "看似公共的导入长文。", []);
    // 不合格：链接未来 claim。
    await insertClaim("claim_lore_future", "story_canon", headTick + 100, null, null);
    await insertArticle("article_lore_future", "未来志", "尚未生效的记载。", ["claim_lore_future"]);
    // 不合格：链接已失效 claim。
    await insertClaim("claim_lore_expired", "story_canon", 0, Math.max(0, headTick - 1), null);
    await insertArticle("article_lore_expired", "旧日志", "已经失效的记载。", ["claim_lore_expired"]);
    // 不合格：链接已被 supersede 的 claim（即使它本身曾有效）。
    await insertClaim("claim_lore_old", "story_canon", 0, null, null);
    await insertClaim("claim_lore_new", "story_canon", 0, null, "claim_lore_old");
    await insertArticle("article_lore_superseded", "被替代志", "只链接被替代 claim 的记载。", ["claim_lore_old"]);
    // 不合格：restricted revision 关联的 claim 链接。
    await insertClaim("claim_lore_restricted", "story_canon", 0, null, null);
    await insertArticle("article_lore_restricted", "密卷", "受限正史支撑的长文。", ["claim_lore_restricted"]);
    await ownerPool.query(
      `INSERT INTO canon_proposals (workspace_id, world_id, worldline_id, id, target_level, article_id, claim_ids, status, decided_by, decided_at)
       VALUES ($1, $2, $3, 'proposal_lore_restricted', 'story', NULL, ARRAY['claim_lore_restricted'], 'merged', 'principal_demo_player', CURRENT_TIMESTAMP)`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query("BEGIN");
    await ownerPool.query(
      `INSERT INTO canon_revisions (workspace_id, world_id, worldline_id, id, parent_revision_id, effective_tick, effective_ordinal, accepted_proposal_id, content_hash, security_class)
       VALUES ($1, $2, $3, 'revision_lore_restricted', NULL, $4, 0, 'proposal_lore_restricted', 'lorehash', 'secret')`,
      [ws, worldId, worldlineId, headTick],
    );
    await ownerPool.query(
      `INSERT INTO canon_revision_audiences (workspace_id, world_id, worldline_id, revision_id, continuity_id)
       VALUES ($1, $2, $3, 'revision_lore_restricted', $4)`,
      [ws, worldId, worldlineId, POSTGRES_DEMO_IDS.scoutContinuity],
    );
    await ownerPool.query("COMMIT");
    await ownerPool.query(
      `INSERT INTO information_campaigns (workspace_id, world_id, worldline_id, id, root_claim_ids, effective_tick, salience, complexity, security_class, algorithm_version, canon_revision_id)
       VALUES ($1, $2, $3, 'campaign_lore_restricted', ARRAY['claim_lore_restricted'], $4, 0.5, 0.5, 'secret', 'realm-propagate-v1', 'revision_lore_restricted')`,
      [ws, worldId, worldlineId, headTick],
    );
    // 不合格：跨 worldline 文章。
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, 'worldline_origin_other', '别线', 'active', 0, 0)`,
      [ws, worldId],
    );
    await insertArticle("article_lore_other_line", "别线志", "其他世界线的记载。", ["claim_lore_ok"], "worldline_origin_other");

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    const lore = scope!.brief.worldLore;
    assert.ok(lore.includes("守灯名录"), "attested 空链接文章必须注入");
    assert.ok(lore.includes("停战前夜的守灯人名录"), "excerpt 正文必须保留");
    assert.ok(!lore.includes("《灯塔志》"), "claim 链接本身不再授予资格（非空 claim_ids 结构性排除）");
    assert.ok(!lore.includes("酒馆轶闻"), "无资格行（pending_review）默认排除");
    assert.ok(!lore.includes("拒稿志"), "rejected 资格排除");
    assert.ok(!lore.includes("未来志"), "future claim 链接文章排除");
    assert.ok(!lore.includes("旧日志"), "expired claim 链接文章排除");
    assert.ok(!lore.includes("被替代志"), "superseded claim 链接文章排除");
    assert.ok(!lore.includes("密卷"), "restricted 关联 claim 链接文章排除（security）");
    assert.ok(!lore.includes("别线志"), "跨 worldline 排除");

    // 空 lore 结构性缺席：未播种文章的全新 Record 不得有 lore。
    const canonOnly = scope!.brief.canon;
    assert.ok(canonOnly.includes("值-claim_lore_ok"), "canon 行不受影响");
  },
);

test(
  "lore qualification runs in SQL: canon display stays <=12 and no qualification rows reach the app",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_worldlore_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await runtimePool.end();
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
    const worldlineId = POSTGRES_DEMO_IDS.worldline;
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_bulk_beacon', 'setting', '批量灯塔', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    // 30 条合格 canon claim；第 25 条（按排序在展示 12 条之外）被文章链接。
    for (let index = 0; index < 30; index += 1) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_bulk_beacon', '状态', $5, 'story', 'story_canon', 1, 0, NULL, NULL, NULL, NULL)`,
        [ws, worldId, worldlineId, `claim_bulk_${String(index).padStart(2, "0")}`, `批量值-${index}`],
      );
    }
    // 排序键：truth_status DESC, valid_from ASC, created_at ASC, id ASC——
    // claim_bulk_25 在展示截断（12 条）之外。
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_bulk', '被链接志', '只有 SQL 内完整资格集合能找到这篇。', ARRAY['claim_bulk_25'], ARRAY[]::text[])`,
      [ws, worldId, worldlineId],
    );
    // attested 空链接文章：资格与 canon 集合完全解耦——即使零合格 canon
    // claim 也应注入（claim 链接不再是资格来源）。
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_bulk_attested', '授权志', '与任何 claim 无关的授权长文。', ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_attest_bulk', 1, 'owner_attest', 'qualified_public',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_bulk_attested'`,
      [ws],
    );

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    // ① canon 展示仍最多 12 条。
    const canonLines = scope!.brief.canon.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(canonLines.length <= 12, `canon 展示必须 ≤12 条，实际 ${canonLines.length}`);
    // ② claim 链接（含截断外 claim）不再授予 lore 资格。
    assert.ok(
      !scope!.brief.worldLore.includes("被链接志"),
      "claim 链接（含截断外 claim）不得驱动 lore",
    );
    // ③ attested 空链接文章注入——资格判定在 SQL 内完成（DISTINCT ON
    //    latest-state + DB-side hash + tuple cursor），不物化到应用。
    assert.ok(scope!.brief.worldLore.includes("授权志"), "attested 空链接文章必须注入");

    // ④ 静态围栏：资格必须由 SQL 表达（latest-state CTE + DB-side hash），
    //    不得把全量资格/claim rows 物化为应用侧数组。
    const source = await readFile(
      new URL("../database/postgres/record-scope.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /article_qualifications/, "资格必须来自 qualification 账本");
    assert.match(source, /owner_attest/, "资格必须限定 owner_attest provenance");
    assert.match(source, /digest\(/, "hash 比对必须 DB-side（pgcrypto）");
    assert.ok(
      !source.includes("eligibleIds = rows.map"),
      "不得在应用侧物化全量 claim id 集合",
    );
  },
);

test(
  "mixed-claim articles fail closed: any ineligible reference excludes the whole article",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_worldlore_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await runtimePool.end();
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
    const worldlineId = POSTGRES_DEMO_IDS.worldline;
    const head = (await ownerPool.query(
      `SELECT last_world_tick::text AS t FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [ws, POSTGRES_DEMO_IDS.record],
    )).rows[0];
    const recordTick = Number(head.t);

    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_mix_setting', 'setting', '混合实体', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    async function insertClaim(id: string, truth: string, vf: number, vt: number | null, supersedes: string | null) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_mix_setting', '状态', $5, 'story', $6, 1, $7, $8, NULL, NULL, $9)`,
        [ws, worldId, worldlineId, id, `mix-${id}`, truth, vf, vt, supersedes],
      );
    }
    async function insertArticle(id: string, title: string, claimIds: string[]) {
      await ownerPool.query(
        `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], ARRAY[]::text[])`,
        [ws, worldId, worldlineId, id, title, `正文-${title}`, claimIds],
      );
    }

    // 合格 public claim。
    await insertClaim("claim_mix_ok", "story_canon", Math.max(0, recordTick - 1), null, null);
    // restricted 关联 claim。
    await insertClaim("claim_mix_restricted", "story_canon", Math.max(0, recordTick - 1), null, null);
    await ownerPool.query(
      `INSERT INTO canon_proposals (workspace_id, world_id, worldline_id, id, target_level, article_id, claim_ids, status, decided_by, decided_at)
       VALUES ($1, $2, $3, 'proposal_mix', 'story', NULL, ARRAY['claim_mix_restricted'], 'merged', 'principal_demo_player', CURRENT_TIMESTAMP)`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query("BEGIN");
    await ownerPool.query(
      `INSERT INTO canon_revisions (workspace_id, world_id, worldline_id, id, parent_revision_id, effective_tick, effective_ordinal, accepted_proposal_id, content_hash, security_class)
       VALUES ($1, $2, $3, 'revision_mix', NULL, $4, 0, 'proposal_mix', 'mixhash', 'restricted')`,
      [ws, worldId, worldlineId, recordTick],
    );
    await ownerPool.query(
      `INSERT INTO canon_revision_audiences (workspace_id, world_id, worldline_id, revision_id, continuity_id)
       VALUES ($1, $2, $3, 'revision_mix', $4)`,
      [ws, worldId, worldlineId, POSTGRES_DEMO_IDS.scoutContinuity],
    );
    await ownerPool.query("COMMIT");
    await ownerPool.query(
      `INSERT INTO information_campaigns (workspace_id, world_id, worldline_id, id, root_claim_ids, effective_tick, salience, complexity, security_class, algorithm_version, canon_revision_id)
       VALUES ($1, $2, $3, 'campaign_mix', ARRAY['claim_mix_restricted'], $4, 0.5, 0.5, 'restricted', 'realm-propagate-v1', 'revision_mix')`,
      [ws, worldId, worldlineId, recordTick],
    );
    // future / superseded / unknown 引用。
    await insertClaim("claim_mix_future", "story_canon", recordTick + 100, null, null);
    await insertClaim("claim_mix_old", "story_canon", 0, null, null);
    await insertClaim("claim_mix_new", "story_canon", 0, null, "claim_mix_old");

    // 全部合格链接：G4 起链接本身也不再授予资格（非空 claim_ids 结构性排除）。
    await insertArticle("article_mix_pure", "纯净志", ["claim_mix_ok", "claim_mix_new"]);
    // 混合 restricted：排除。
    await insertArticle("article_mix_restricted", "混密志", ["claim_mix_ok", "claim_mix_restricted"]);
    // 混合 future：排除。
    await insertArticle("article_mix_future", "混未来志", ["claim_mix_ok", "claim_mix_future"]);
    // 混合 superseded：排除。
    await insertArticle("article_mix_old", "混旧志", ["claim_mix_ok", "claim_mix_old"]);
    // 混合未知引用：排除。
    await insertArticle("article_mix_unknown", "混未知志", ["claim_mix_ok", "claim_does_not_exist"]);
    // 空 claim_ids 且无资格行：pending_review 排除。
    await insertArticle("article_mix_empty", "空链志", []);
    // 唯一注入路径：空 claim_ids + owner attestation。
    await insertArticle("article_mix_attested", "授权纯志", []);
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_attest_mix', 1, 'owner_attest', 'qualified_public',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_mix_attested'`,
      [ws],
    );

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    const lore = scope!.brief.worldLore;
    assert.ok(lore.includes("授权纯志"), "attested 空链接文章必须注入");
    assert.ok(!lore.includes("纯净志"), "纯 public 链接也不再授予资格（结构性排除）");
    assert.ok(!lore.includes("混密志"), "public+restricted 混合必须 fail-closed 排除");
    assert.ok(!lore.includes("混未来志"), "public+future 混合必须排除");
    assert.ok(!lore.includes("混旧志"), "public+superseded 混合必须排除");
    assert.ok(!lore.includes("混未知志"), "public+未知引用混合必须排除");
    assert.ok(!lore.includes("空链志"), "空 claim_ids 且无资格行必须排除");
    assert.ok(scope!.brief.canon.includes("mix-claim_mix_ok"), "canon 行不受影响");
  },
);

test(
  "lore input budget: article titles are capped and the rendered lore block never exceeds 1200 chars",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_worldlore_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await runtimePool.end();
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
    const worldlineId = POSTGRES_DEMO_IDS.worldline;
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_budget_beacon', 'setting', '预算灯塔', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query(
      `INSERT INTO world_claims (
         workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick,
         source_record_id, source_event_id, supersedes_claim_id
       ) VALUES ($1, $2, $3, 'claim_budget_ok', 'entity_budget_beacon', '状态', '长明', 'story', 'story_canon', 1, 0, NULL, NULL, NULL, NULL)`,
      [ws, worldId, worldlineId],
    );
    const longTitle = "超长标题".repeat(80); // 320 字符
    const longBody = "长".repeat(900); // 正文 900，截 600
    // G4：预算文章的注入资格 = 空 claim_ids + owner attestation（与 claim 无关）。
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_budget_long_title', $4, $5, ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, worldId, worldlineId, longTitle, longBody],
    );
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_budget_second', '第二志', $4, ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, worldId, worldlineId, "第二篇正文。".repeat(150)],
    );
    // 纯空白正文：渲染后无效行，必须排除。
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_budget_blank', '空白志', '\u3000', ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, worldId, worldlineId],
    );
    for (const [articleId, qualId] of [
      ["article_budget_long_title", "aq_attest_budget_1"],
      ["article_budget_second", "aq_attest_budget_2"],
      ["article_budget_blank", "aq_attest_budget_3"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO article_qualifications (
           workspace_id, world_id, worldline_id, article_id, id, seq,
           provenance_kind, status, content_hash, attested_by, attested_at,
           available_from_tick, available_from_ordinal
         )
         SELECT article.workspace_id, article.world_id, article.worldline_id,
                article.id, $2, 1, 'owner_attest', 'qualified_public',
                encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
                'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
         FROM world_articles AS article
         WHERE article.workspace_id = $1 AND article.id = $3`,
        [ws, qualId, articleId],
      );
    }

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    const lore = scope!.brief.worldLore;

    // ① 标题上限：80 字符——完整 320 字符标题不得原样进入。
    assert.ok(!lore.includes(longTitle), "超长标题不得无截断进入 prompt");
    assert.ok(lore.length <= 1200, `lore 段总长度必须 ≤1200 字符，实际 ${lore.length}`);
    // ② 渲染行结构保持：截断后的标题标签仍在（来源保留）。
    assert.ok(lore.includes("《"), "标题来源标签必须保留（截断后）");
    // ③ 空白正文行被排除。
    assert.ok(!lore.includes("空白志"), "纯截断/空行必须排除");
    // ④ 行数仍 ≤2（最长占用下也不超条数）。
    const lines = lore.split("\n").filter((line) => line.startsWith("- 《"));
    assert.ok(lines.length <= 2, `lore 条数必须 ≤2，实际 ${lines.length}`);
  },
);
