/**
 * Shared World Memory v2 · Task 0 闸门（no-go precondition）：
 * 现有通用 Canon 注入（record-scope resolve → brief.canon）必须
 * ① 排除 restricted/secret revision 晋升的 claim（security）；
 * ② 绑定 Record 当前 effective world cursor，排除 future/expired claim（temporal）。
 * 计划：public documentation §6 Task 0。
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
  "canon injection must exclude restricted/secret promoted claims and future/expired claims",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(adminConnectionString!);
    if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
      throw new Error("loopback only");
    }
    const databaseName = `realm_loregate_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
      `SELECT head_tick::text AS tick, head_ordinal::text AS ordinal
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [ws, worldlineId],
    )).rows[0];
    const headTick = Number(head.tick);

    // 实体：一个公共 setting 实体承载全部测试 claim。
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_gate_setting', 'setting', '闸门实体', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    async function insertClaim(id: string, value: string, validFrom: number, validTo: number | null) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_gate_setting', '状态', $5, 'story', 'story_canon', 1, $6, $7, NULL, NULL, NULL)`,
        [ws, worldId, worldlineId, id, value, validFrom, validTo],
      );
    }

    // ① 公共、当前有效的 claim（应注入）。
    await insertClaim("claim_gate_public", "公共有效", Math.max(0, headTick - 1), null);
    // ② restricted revision 晋升的 claim（security：不得注入）。
    await insertClaim("claim_gate_restricted", "受限正史", Math.max(0, headTick - 1), null);
    await ownerPool.query(
      `INSERT INTO canon_proposals (workspace_id, world_id, worldline_id, id, target_level, article_id, claim_ids, status, decided_by, decided_at)
       VALUES ($1, $2, $3, 'proposal_gate_restricted', 'story', NULL, ARRAY['claim_gate_restricted'], 'merged', 'principal_demo_player', CURRENT_TIMESTAMP)`,
      [ws, worldId, worldlineId],
    );
    // 0026 deferred trigger：non-public revision 必须有至少一条受众——
    // revision + audience 必须同事务（trigger 在 COMMIT 时检查）。
    await ownerPool.query("BEGIN");
    await ownerPool.query(
      `INSERT INTO canon_revisions (workspace_id, world_id, worldline_id, id, parent_revision_id, effective_tick, effective_ordinal, accepted_proposal_id, content_hash, security_class)
       VALUES ($1, $2, $3, 'revision_gate_restricted', NULL, $4, 0, 'proposal_gate_restricted', 'gatehash', 'restricted')`,
      [ws, worldId, worldlineId, headTick],
    );
    await ownerPool.query(
      `INSERT INTO canon_revision_audiences (workspace_id, world_id, worldline_id, revision_id, continuity_id)
       VALUES ($1, $2, $3, 'revision_gate_restricted', $4)`,
      [ws, worldId, worldlineId, POSTGRES_DEMO_IDS.scoutContinuity],
    );
    await ownerPool.query("COMMIT");
    await ownerPool.query(
      `INSERT INTO information_campaigns (workspace_id, world_id, worldline_id, id, root_claim_ids, effective_tick, salience, complexity, security_class, algorithm_version, canon_revision_id)
       VALUES ($1, $2, $3, 'campaign_gate_restricted', ARRAY['claim_gate_restricted'], $4, 0.5, 0.5, 'restricted', 'realm-propagate-v1', 'revision_gate_restricted')`,
      [ws, worldId, worldlineId, headTick],
    );
    // ③ future claim（valid_from > cursor，不得注入）。
    await insertClaim("claim_gate_future", "未来正史", headTick + 100, null);
    // ④ expired claim（valid_to <= cursor，不得注入）。
    await insertClaim("claim_gate_expired", "失效正史", 0, Math.max(0, headTick - 1));
    // ⑤ same-tick 边界：valid_from = cursor（inclusive，应注入）。
    await insertClaim("claim_gate_same_from", "同 tick 生效", headTick, null);
    // ⑥ same-tick 边界：valid_to = cursor（exclusive，不得注入）。
    await insertClaim("claim_gate_same_to", "同 tick 失效", 0, headTick);

    // ⑦ 真实 promoted 形态（验收修正③）：old(record_confirmed) →
    //    promoted new id（story_canon, supersedes_claim_id=old），
    //    restricted revision campaign root 用 promoted NEW id。
    await insertClaim("claim_gate_old", "旧结论", Math.max(0, headTick - 1), null);
    await ownerPool.query(
      `UPDATE world_claims SET truth_status = 'record_confirmed'
       WHERE workspace_id = $1 AND id = 'claim_gate_old'`,
      [ws],
    ).catch(() => {});
    await ownerPool.query(
      `INSERT INTO world_claims (
         workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick,
         source_record_id, source_event_id, supersedes_claim_id
       ) VALUES ($1, $2, $3, 'claim_gate_promoted_restricted', 'entity_gate_setting', '状态', '受限晋升正史', 'story', 'story_canon', 1, $4, NULL, NULL, NULL, 'claim_gate_old')`,
      [ws, worldId, worldlineId, Math.max(0, headTick - 1)],
    );
    await ownerPool.query(
      `INSERT INTO canon_proposals (workspace_id, world_id, worldline_id, id, target_level, article_id, claim_ids, status, decided_by, decided_at)
       VALUES ($1, $2, $3, 'proposal_gate_promoted', 'story', NULL, ARRAY['claim_gate_old'], 'merged', 'principal_demo_player', CURRENT_TIMESTAMP)`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query("BEGIN");
    await ownerPool.query(
      `INSERT INTO canon_revisions (workspace_id, world_id, worldline_id, id, parent_revision_id, effective_tick, effective_ordinal, accepted_proposal_id, content_hash, security_class)
       VALUES ($1, $2, $3, 'revision_gate_promoted', NULL, $4, 0, 'proposal_gate_promoted', 'promotedhash', 'secret')`,
      [ws, worldId, worldlineId, headTick],
    );
    await ownerPool.query(
      `INSERT INTO canon_revision_audiences (workspace_id, world_id, worldline_id, revision_id, continuity_id)
       VALUES ($1, $2, $3, 'revision_gate_promoted', $4)`,
      [ws, worldId, worldlineId, POSTGRES_DEMO_IDS.scoutContinuity],
    );
    await ownerPool.query("COMMIT");
    await ownerPool.query(
      `INSERT INTO information_campaigns (workspace_id, world_id, worldline_id, id, root_claim_ids, effective_tick, salience, complexity, security_class, algorithm_version, canon_revision_id)
       VALUES ($1, $2, $3, 'campaign_gate_promoted', ARRAY['claim_gate_promoted_restricted'], $4, 0.5, 0.5, 'secret', 'realm-propagate-v1', 'revision_gate_promoted')`,
      [ws, worldId, worldlineId, headTick],
    );
    // public promoted（新 id、supersedes、无 campaign 链接——public merge 常态）。
    await insertClaim("claim_gate_old_public", "公共旧结论", Math.max(0, headTick - 1), null);
    await ownerPool.query(
      `INSERT INTO world_claims (
         workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick,
         source_record_id, source_event_id, supersedes_claim_id
       ) VALUES ($1, $2, $3, 'claim_gate_promoted_public', 'entity_gate_setting', '状态', '公共晋升正史', 'story', 'story_canon', 1, $4, NULL, NULL, NULL, 'claim_gate_old_public')`,
      [ws, worldId, worldlineId, Math.max(0, headTick - 1)],
    );

    const scopeRepository = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await scopeRepository.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope, "demo record scope 必须可解析");
    const canon = scope!.brief.canon;

    assert.ok(canon.includes("公共有效"), "公共有效 claim 必须注入");
    assert.ok(canon.includes("同 tick 生效"), "valid_from = cursor 为 inclusive，必须注入");
    assert.ok(!canon.includes("受限正史"), "restricted revision 晋升 claim 不得注入（security gate）");
    assert.ok(!canon.includes("未来正史"), "future claim 不得注入（temporal gate）");
    assert.ok(!canon.includes("失效正史"), "expired claim 不得注入（temporal gate）");
    assert.ok(!canon.includes("同 tick 失效"), "valid_to = cursor 为 exclusive，不得注入");
    // 真实 promoted 形态：restricted/secret promoted 新 id 必须排除；
    // 其 superseded old 也被 supersede 链排除；public promoted 新 id 正常进入。
    assert.ok(!canon.includes("受限晋升正史"), "restricted promoted 新 ID 不得注入（真实 merge 形态）");
    assert.ok(!canon.includes("旧结论"), "被 supersede 的旧 claim 不得注入");
    assert.ok(canon.includes("公共晋升正史"), "public promoted 新 ID 必须正常注入");
  },
);

test(
  "canon/lore cursor must follow the record head, not the worldline global head",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    // 验收修正②：worldline head > record head 时，介于两者之间的 claim
    // 对该 Record 是 future，不得注入；record head 边界仍 valid_from
    // inclusive / valid_to exclusive。
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_loregate_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
    const recordHead = (await ownerPool.query(
      `SELECT last_world_tick::text AS t FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [ws, POSTGRES_DEMO_IDS.record],
    )).rows[0];
    const recordTick = Number(recordHead.t);
    // worldline 全局 head 被其他 Record 推进到 record head + 50。
    await ownerPool.query(
      `UPDATE worldlines SET head_tick = $3
       WHERE workspace_id = $1 AND id = $2`,
      [ws, worldlineId, recordTick + 50],
    );

    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_cursor_setting', 'setting', '游标实体', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    async function insertClaim(id: string, value: string, vf: number, vt: number | null) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_cursor_setting', '状态', $5, 'story', 'story_canon', 1, $6, $7, NULL, NULL, NULL)`,
        [ws, worldId, worldlineId, id, value, vf, vt],
      );
    }
    // record head 之前有效（应注入）。
    await insertClaim("claim_cursor_before", "游标前有效", Math.max(0, recordTick - 1), null);
    // record head = valid_from（inclusive，应注入）。
    await insertClaim("claim_cursor_same", "游标同刻生效", recordTick, null);
    // record head 与 worldline head 之间（对该 Record 是 future，不得注入）。
    await insertClaim("claim_cursor_between", "线内未来", recordTick + 10, null);
    // valid_to = record head（exclusive，不得注入）。
    await insertClaim("claim_cursor_expired", "游标同刻失效", 0, recordTick);

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = await repo.resolve({
      workspaceId: ws,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    const canon = scope!.brief.canon;
    assert.ok(canon.includes("游标前有效"));
    assert.ok(canon.includes("游标同刻生效"), "valid_from = record head 为 inclusive");
    assert.ok(!canon.includes("线内未来"), "worldline head > record head 时，介于两者间的 claim 不得注入");
    assert.ok(!canon.includes("游标同刻失效"), "valid_to = record head 为 exclusive");
  },
);

test(
  "future or expired superseder must not hide a currently valid claim early",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    // 时序安全 supersede：只有 newer 自身在当前 effective cursor 有效时，
    // old 才被隐藏；future superseder 不提前生效，expired superseder 不回头遮蔽。
    const adminUrl = new URL(adminConnectionString!);
    const databaseName = `realm_loregate_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
    const recordHead = (await ownerPool.query(
      `SELECT last_world_tick::text AS t FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [ws, POSTGRES_DEMO_IDS.record],
    )).rows[0];
    const recordTick = Number(recordHead.t);

    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_sup_setting', 'setting', '替代实体', '', 0, NULL)`,
      [ws, worldId, worldlineId],
    );
    async function insertClaim(id: string, value: string, vf: number, vt: number | null, supersedes: string | null) {
      await ownerPool.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick,
           source_record_id, source_event_id, supersedes_claim_id
         ) VALUES ($1, $2, $3, $4, 'entity_sup_setting', '状态', $5, 'story', 'story_canon', 1, $6, $7, NULL, NULL, $8)`,
        [ws, worldId, worldlineId, id, value, vf, vt, supersedes],
      );
    }
    // old 当前有效；future superseder（valid_from > record head）。
    await insertClaim("claim_sup_old", "当前旧结论", Math.max(0, recordTick - 2), null, null);
    await insertClaim("claim_sup_future", "未来新结论", recordTick + 10, null, "claim_sup_old");
    // expired superseder 的另一组：newer valid_to <= cursor，old 仍应可见。
    await insertClaim("claim_sup_old2", "旧结论二", Math.max(0, recordTick - 2), null, null);
    await insertClaim("claim_sup_dead", "已失效替代", 0, Math.max(0, recordTick - 1), "claim_sup_old2");
    // G4：lore 不再由 claim 链接授予资格；改为 attested 文章 +
    // available_from tuple 语义——授权发生在 (recordTick+20, 0)，
    // 旧 Record（head 早于该 tuple）不得看到（不 retroactive）。
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_sup_old', '旧志', '链接当前旧结论的长文。', ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, worldId, worldlineId],
    );
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_attest_sup', 1, 'owner_attest', 'qualified_public',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, $2, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_sup_old'`,
      [ws, recordTick + 20],
    );

    const repo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    async function currentCanon(recordId: string) {
      const scope = await repo.resolve({
        workspaceId: ws,
        principalId: POSTGRES_DEMO_IDS.principal,
        recordId,
      });
      return scope!.brief;
    }

    // 1. 当前 record head：future superseder 不得提前隐藏 old；attested 文章
    //    的 available_from=(recordTick+20, 0) 未到达，旧 Record 看不到。
    let brief = await currentCanon(POSTGRES_DEMO_IDS.record);
    assert.ok(brief.canon.includes("当前旧结论"), "future superseder 不得提前隐藏当前有效旧 claim");
    assert.ok(!brief.canon.includes("未来新结论"), "future superseder 自身也不得注入（temporal）");
    assert.ok(!brief.worldLore.includes("旧志"), "available_from 未到达，旧 Record 不得看到 attested 文章");
    assert.ok(brief.canon.includes("旧结论二"), "expired superseder 不得回头遮蔽旧 claim");
    assert.ok(!brief.canon.includes("已失效替代"), "expired superseder 自身不得注入");

    // 2. 推进 record head 到 future claim 的 valid_from 之后：new 返回、old 被 supersede；
    //    attested 文章的 available_from tuple 到达，转为可见。
    await ownerPool.query(
      `UPDATE record_heads SET last_world_tick = $3
       WHERE workspace_id = $1 AND record_id = $2`,
      [ws, POSTGRES_DEMO_IDS.record, recordTick + 20],
    );
    brief = await currentCanon(POSTGRES_DEMO_IDS.record);
    assert.ok(brief.canon.includes("未来新结论"), "cursor 推进后 new 必须注入");
    assert.ok(!brief.canon.includes("当前旧结论"), "cursor 推进后 old 被有效 superseder 隐藏");
    assert.ok(brief.worldLore.includes("旧志"), "tuple 到达 available_from 后文章可见");

    // 3. valid_to = cursor 边界 exclusive：把 head 调到 future claim 的 valid_from；
    //    available_from=(recordTick+20) 未到达，文章仍不可见。
    await ownerPool.query(
      `UPDATE record_heads SET last_world_tick = $3
       WHERE workspace_id = $1 AND record_id = $2`,
      [ws, POSTGRES_DEMO_IDS.record, recordTick + 10],
    );
    brief = await currentCanon(POSTGRES_DEMO_IDS.record);
    assert.ok(brief.canon.includes("未来新结论"), "valid_from = cursor 为 inclusive");
    assert.ok(!brief.canon.includes("当前旧结论"));
    assert.ok(!brief.worldLore.includes("旧志"), "available_from 未到达仍不可见");
  },
);
