/**
 * Article qualification G3（plan v10 §5.5/§5.7/§5.9/§6.2/§7 G3）：
 * owner attestation 状态机 + 并发 + 路由权限矩阵，真实临时 PG。
 * - attest/reject/revoke/re-attest、duplicate 幂等、hash mismatch 409、
 *   unknown 404、latest-state 确定性、content hash DB-side 比对；
 * - 并发双 attest → 单事件 + 一方幂等；并发 attest+revoke → seq 1/2 连续、
 *   latest 确定（worldline 行锁串行化；UNIQUE 兜底）；
 * - realm_runtime 最小授权与 RLS 探针；
 * - 缺 0041 的库 qualify fail-closed（QUALIFICATION_SCHEMA_MISSING）；
 * - route：owner 200 / player/observer 403 / 非成员 404 / 无会话 401 /
 *   body 身份字段忽略（attested_by 只来自 session）。
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
import {
  createArticleQualificationRepository,
} from "../database/postgres/article-qualification-repository.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import {
  POST as qualifyPOST,
} from "../app/api/world-knowledge/articles/qualify/route.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
const OWNER = POSTGRES_DEMO_IDS.principal;
const PLAYER = "principal_player_two";
const OBSERVER = "principal_observer_one";
const STRANGER = "principal_stranger";

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

async function createTempDatabase(
  t: test.TestContext,
  label: string,
  { with0041 }: { with0041: boolean },
) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_aq_g3_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  t.after(async () => {
    await runtimePool.end().catch(() => undefined);
    await ownerPool.end().catch(() => undefined);
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });

  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    // 0042/0043 依赖 0041（grants/requiresMigrations）——缺 0041 的库三者同缺。
    if (!with0041 && /^004[123]_/.test(filename)) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  return { ownerPool, runtimePool, runtimeUrl };
}

async function insertArticle(
  pool: pg.Pool,
  id: string,
  title: string,
  body: string,
) {
  await pool.query(
    `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [WS, WORLD, WORLDLINE, id, title, body],
  );
}

test(
  "G3 state machine: attest/reject/re-attest/revoke, idempotent duplicate, hash mismatch, latest-state",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "sm", { with0041: true });
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_g3_main", "灯塔志", "灯塔建于停战前夜。");

    const worldlineHead = async () => {
      const row = (await ownerPool.query(
        `SELECT head_tick::text AS t, head_ordinal::text AS o
         FROM worldlines WHERE workspace_id = $1 AND id = $2`,
        [WS, WORLDLINE],
      )).rows[0];
      return { tick: Number(row.t), ordinal: Number(row.o) };
    };
    const dbSideHash = async () => (await ownerPool.query(
      `SELECT encode(digest(id || E'\\n' || title || E'\\n' || body, 'sha256'), 'hex') AS h
       FROM world_articles WHERE workspace_id = $1 AND id = 'article_g3_main'`,
      [WS],
    )).rows[0].h as string;
    const eventCount = async () => Number((await ownerPool.query(
      `SELECT count(*)::text AS c FROM article_qualifications
       WHERE workspace_id = $1 AND article_id = 'article_g3_main'`,
      [WS],
    )).rows[0].c);

    // attest → qualified_public，available_from = 当前 worldline head tuple，
    // content_hash = DB-side pgcrypto 计算值。
    const head = await worldlineHead();
    const attest = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(attest.ok);
    if (!attest.ok) return;
    assert.equal(attest.status, "qualified_public");
    assert.equal(attest.seq, 1);
    assert.equal(attest.idempotent, false);
    assert.equal(attest.availableFromTick, head.tick);
    assert.equal(attest.availableFromOrdinal, head.ordinal);

    const latest = await repo.latestState(scope, "article_g3_main");
    assert.ok(latest);
    assert.equal(latest!.status, "qualified_public");
    assert.equal(latest!.provenanceKind, "owner_attest");
    assert.equal(latest!.contentHash, await dbSideHash(), "hash 必须 DB-side 一致");
    assert.equal(latest!.attestedBy, OWNER);
    assert.ok(latest!.attestedAt, "非 pending 必须有 attested_at");

    // duplicate attest（同 decision + 同 hash + latest 同状态）→ 幂等，不追加。
    const duplicate = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(duplicate.ok && duplicate.idempotent);
    assert.equal(await eventCount(), 1, "幂等 duplicate 不得追加事件");

    // reject → rejected（seq 2，attested_by 记录）。
    const reject = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "reject",
      attestedBy: OWNER,
    });
    assert.ok(reject.ok && !reject.idempotent);
    if (!reject.ok) return;
    assert.equal(reject.status, "rejected");
    assert.equal(reject.seq, 2);

    // re-attest → 复活（seq 3，新 available_from tuple）。
    const reAttest = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(reAttest.ok && reAttest.status === "qualified_public" && reAttest.seq === 3);

    // hash mismatch：正文在 attestation 后被改（出带外修改）且当前状态
    // 仍是 qualified_public → attest fail-closed 409 语义（先 revoke 再重签）。
    await ownerPool.query(
      `UPDATE world_articles SET body = '被出带外篡改的正文。'
       WHERE workspace_id = $1 AND id = 'article_g3_main'`,
      [WS],
    );
    const mismatch = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(!mismatch.ok && mismatch.code === "HASH_MISMATCH");
    assert.equal(await eventCount(), 3, "HASH_MISMATCH 不得追加事件");
    // 恢复正文（hash 回到 seq 3 的值）后 revoke 放行。
    await ownerPool.query(
      `UPDATE world_articles SET body = '灯塔建于停战前夜。'
       WHERE workspace_id = $1 AND id = 'article_g3_main'`,
      [WS],
    );

    // revoke → revoked（seq 4），available_from 沿用前次。
    const revoke = await repo.qualify(scope, {
      articleId: "article_g3_main",
      decision: "revoke",
      attestedBy: OWNER,
    });
    assert.ok(revoke.ok && revoke.status === "revoked" && revoke.seq === 4);
    assert.equal(revoke.availableFromTick, reAttest.availableFromTick);
    assert.equal(revoke.availableFromOrdinal, reAttest.availableFromOrdinal);
    assert.equal((await repo.latestState(scope, "article_g3_main"))!.status, "revoked");

    // unknown article → ARTICLE_NOT_FOUND。
    const missing = await repo.qualify(scope, {
      articleId: "article_does_not_exist",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(!missing.ok && missing.code === "ARTICLE_NOT_FOUND");
  },
);

test(
  "G3 concurrency: worldline-lock serialization keeps seq consecutive and latest deterministic",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "cc", { with0041: true });
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };

    // 并发双 attest：恰好一个事件，一方幂等。
    await insertArticle(ownerPool, "article_g3_double", "双击志", "并发 attest 正文。");
    const repoA = createArticleQualificationRepository(runtimePool);
    const secondRuntimeUrl = new URL(runtimeConnectionString!);
    const dbName = (await ownerPool.query("SELECT current_database() AS d")).rows[0].d;
    secondRuntimeUrl.pathname = `/${dbName}`;
    const runtimePoolB = new pg.Pool({ connectionString: secondRuntimeUrl.href, max: 2 });
    // 失败路径拆库时 FORCE 终止空闲客户端的噪音不影响主错误报告。
    runtimePoolB.on("error", () => {});
    t.after(async () => {
      await runtimePoolB.end().catch(() => undefined);
    });
    const repoB = createArticleQualificationRepository(runtimePoolB);
    const [r1, r2] = await Promise.all([
      repoA.qualify(scope, { articleId: "article_g3_double", decision: "attest", attestedBy: OWNER }),
      repoB.qualify(scope, { articleId: "article_g3_double", decision: "attest", attestedBy: OWNER }),
    ]);
    assert.ok(r1.ok && r2.ok, "并发双 attest 双方成功（无唯一键冲突/死锁）");
    const idempotentCount = [r1, r2].filter((r) => r.ok && r.idempotent).length;
    assert.equal(idempotentCount, 1, "并发双 attest 恰好一方幂等");
    const events = await ownerPool.query(
      `SELECT seq::text AS seq FROM article_qualifications
       WHERE workspace_id = $1 AND article_id = 'article_g3_double' ORDER BY seq`,
      [WS],
    );
    assert.equal(events.rows.length, 1, "并发双 attest 只落一个事件");

    // 并发 attest+revoke：两个事件 seq 连续（1,2），latest = seq 2 确定。
    await insertArticle(ownerPool, "article_g3_mixed", "混合志", "并发混合正文。");
    const [ra, rr] = await Promise.all([
      repoA.qualify(scope, { articleId: "article_g3_mixed", decision: "attest", attestedBy: OWNER }),
      repoB.qualify(scope, { articleId: "article_g3_mixed", decision: "revoke", attestedBy: OWNER }),
    ]);
    assert.ok(ra.ok && rr.ok, "并发 attest+revoke 双方成功");
    const mixed = await ownerPool.query(
      `SELECT seq::text AS seq, status FROM article_qualifications
       WHERE workspace_id = $1 AND article_id = 'article_g3_mixed' ORDER BY seq`,
      [WS],
    );
    assert.deepEqual(mixed.rows.map((row) => row.seq), ["1", "2"], "seq 必须连续");
    assert.deepEqual(
      [...mixed.rows.map((row) => row.status)].sort(),
      ["qualified_public", "revoked"],
    );
    const latest = await repoA.latestState(scope, "article_g3_mixed");
    assert.equal(latest!.seq, 2, "latest 必须是 seq 最大者");
    assert.equal(latest!.status, mixed.rows[1].status);

    // RLS 探针：runtime 角色在别的 workspace 上下文看不到本 workspace 事件。
    const runtimeClient = await runtimePool.connect();
    try {
      await runtimeClient.query(
        "SELECT set_config('realm.workspace_id', 'ws_other', false)",
      );
      const invisible = await runtimeClient.query(
        "SELECT count(*)::text AS c FROM article_qualifications WHERE workspace_id = $1",
        [WS],
      );
      assert.equal(invisible.rows[0].c, "0", "RLS 必须隔离跨 workspace 读");
      await runtimeClient.query("SELECT set_config('realm.workspace_id', '', false)");
    } finally {
      runtimeClient.release();
    }
  },
);

test(
  "G3 schema-missing: qualify on a database without 0041 fails closed",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "legacy", { with0041: false });
    await insertArticle(ownerPool, "article_g3_legacy", "旧库志", "未应用 0041 的库。");
    const repo = createArticleQualificationRepository(runtimePool);
    const result = await repo.qualify(
      { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE },
      { articleId: "article_g3_legacy", decision: "attest", attestedBy: OWNER },
    );
    assert.ok(!result.ok && result.code === "QUALIFICATION_SCHEMA_MISSING");
  },
);

test(
  "G3 route: owner gate matrix, stable response, body identity fields ignored",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimeUrl } = await createTempDatabase(t, "route", { with0041: true });
    await insertArticle(ownerPool, "article_g3_route", "路由志", "路由测试正文。");
    for (const [principal, role] of [
      [PLAYER, "player"],
      [OBSERVER, "observer"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO player_world_memberships (
           workspace_id, world_id, principal_id, role,
           omniscient_player_character, can_view_dynamic_knowledge
         ) VALUES ($1, $2, $3, $4, true, true)`,
        [WS, WORLD, principal, role],
      );
    }

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_ACCESS_TOKEN = "aq-g3-gate-token";
    t.after(async () => {
      if (previousAccessToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
      else process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      if (previousRuntimeUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      await endSharedRuntimePools();
    });

    const call = (principalId: string | null, body: unknown) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (principalId) {
        headers.cookie = `realm_session=${createSessionValue(principalId)}`;
      }
      return qualifyPOST(new Request(
        "http://localhost/api/world-knowledge/articles/qualify",
        { method: "POST", headers, body: JSON.stringify(body) },
      ));
    };
    const validBody = { worldId: WORLD, articleId: "article_g3_route", decision: "attest" };

    // 无会话 → 401。
    const anonymous = await call(null, validBody);
    assert.equal(anonymous.status, 401);
    // 非成员 → 404（不泄露存在性）。
    const stranger = await call(STRANGER, validBody);
    assert.equal(stranger.status, 404);
    assert.equal((await stranger.json()).error.code, "WORLD_NOT_FOUND");
    // player/observer → 403 NOT_OWNER。
    for (const principal of [PLAYER, OBSERVER]) {
      const denied = await call(principal, validBody);
      assert.equal(denied.status, 403, `${principal} 不得 attestation`);
      assert.equal((await denied.json()).error.code, "NOT_OWNER");
    }
    // 校验：缺 worldId / 非法 decision → 400。
    assert.equal((await call(OWNER, { articleId: "x", decision: "attest" })).status, 400);
    assert.equal(
      (await call(OWNER, { worldId: WORLD, articleId: "x", decision: "publish" })).status,
      400,
    );
    // 未知 article → 404 ARTICLE_NOT_FOUND。
    const unknown = await call(OWNER, {
      worldId: WORLD, articleId: "article_nope", decision: "attest",
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "ARTICLE_NOT_FOUND");

    // owner attest → 200 稳定契约；body 内伪造身份字段必须被忽略。
    const spoofed = await call(OWNER, {
      ...validBody,
      workspaceId: "ws_evil",
      principalId: "principal_evil",
      attestedBy: "principal_evil",
    });
    assert.equal(spoofed.status, 200);
    assert.equal(spoofed.headers.get("cache-control"), "no-store");
    const payload = await spoofed.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.articleId, "article_g3_route");
    assert.equal(payload.status, "qualified_public");
    assert.equal(typeof payload.seq, "number");
    assert.equal(typeof payload.availableFromTick, "number");
    assert.equal(typeof payload.availableFromOrdinal, "number");
    const stored = await ownerPool.query(
      `SELECT attested_by FROM article_qualifications
       WHERE workspace_id = $1 AND article_id = 'article_g3_route'`,
      [WS],
    );
    assert.equal(stored.rows[0].attested_by, OWNER, "attested_by 只来自 session");

    // duplicate → 幂等响应。
    const again = await call(OWNER, validBody);
    assert.equal((await again.json()).idempotent, true);

    // revoke → 稳定响应 + readback。
    const revoked = await call(OWNER, { ...validBody, decision: "revoke" });
    const revokedPayload = await revoked.json();
    assert.equal(revokedPayload.status, "revoked");
    const repo = createArticleQualificationRepository(ownerPool);
    const latest = await repo.latestState(
      { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE },
      "article_g3_route",
    );
    assert.equal(latest!.status, "revoked");
  },
);

/**
 * Article qualification G4（plan v10 §3.2/§7 G4）：lore 资格 attested-only +
 * Record tuple cursor。全部 AND，无 OR 旁路；缺 0041 的库 fail-closed
 * （lore 空注入、canon 照常、不报错）。
 */
test(
  "G4 lore gating: tuple cursor (old/current/future/same-tick ordinal), revoke, claim_ids exclusion",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "lore", { with0041: true });
    const repo = createArticleQualificationRepository(runtimePool);
    const scopeRepo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };

    // canon 对照：一条当前有效的 story_canon claim（canon 读出不因 lore 改动受影响）。
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_g4_beacon', 'setting', 'G4 灯塔', '', 0, NULL)`,
      [WS, WORLD, WORLDLINE],
    );
    await ownerPool.query(
      `INSERT INTO world_claims (workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick, source_record_id, source_event_id, supersedes_claim_id)
       VALUES ($1, $2, $3, 'claim_g4_canon', 'entity_g4_beacon', '状态', '长明', 'story',
         'story_canon', 1, 0, NULL, NULL, NULL, NULL)`,
      [WS, WORLD, WORLDLINE],
    );

    // worldline head 固定 (100, 5)：attestation 的 available_from 来源。
    await ownerPool.query(
      `UPDATE worldlines SET head_tick = 100, head_ordinal = 5
       WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLDLINE],
    );
    const setRecordHead = async (tick: number, ordinal: number) => {
      await ownerPool.query(
        `UPDATE record_heads SET last_world_tick = $3, last_world_ordinal = $4
         WHERE workspace_id = $1 AND record_id = $2`,
        [WS, POSTGRES_DEMO_IDS.record, tick, ordinal],
      );
    };
    const resolveBrief = async () => {
      const resolved = await scopeRepo.resolve({
        workspaceId: WS,
        principalId: OWNER,
        recordId: POSTGRES_DEMO_IDS.record,
      });
      assert.ok(resolved);
      return resolved!.brief;
    };

    await insertArticle(ownerPool, "article_g4_lore", "灯塔遗事", "停战前夜的守灯人名录。");
    // 无资格行 = pending_review（fail-closed）：任何 cursor 不注入。
    await setRecordHead(200, 0);
    let brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("灯塔遗事"), "无资格行文章不得注入");

    // attest → available_from = (100, 5)。
    const attest = await repo.qualify(scope, {
      articleId: "article_g4_lore",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(attest.ok);
    if (attest.ok) {
      assert.equal(attest.availableFromTick, 100);
      assert.equal(attest.availableFromOrdinal, 5);
    }

    // old Record（tuple 早于 available_from）不可见——不 retroactive。
    await setRecordHead(99, 999);
    brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("灯塔遗事"), "old Record 不得看到后授权文章");
    // same tick、ordinal 不足 → 不可见。
    await setRecordHead(100, 4);
    brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("灯塔遗事"), "same-tick ordinal 不足不得注入");
    // same tick、ordinal 相等（inclusive）→ 可见。
    await setRecordHead(100, 5);
    brief = await resolveBrief();
    assert.ok(brief.worldLore.includes("灯塔遗事"), "tuple 到达 available_from 必须可见");
    assert.ok(brief.worldLore.includes("停战前夜的守灯人名录"), "excerpt 正文保留");
    // future Record（head 推进）→ 仍可见。
    await setRecordHead(150, 0);
    brief = await resolveBrief();
    assert.ok(brief.worldLore.includes("灯塔遗事"), "future Record 继续可见");
    // canon 对照不受影响。
    assert.ok(brief.canon.includes("长明"), "canon 读出不因 lore 资格改动受影响");

    // revoke → 任何 cursor 立即全隐藏。
    const revoke = await repo.qualify(scope, {
      articleId: "article_g4_lore",
      decision: "revoke",
      attestedBy: OWNER,
    });
    assert.ok(revoke.ok);
    brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("灯塔遗事"), "revoke 后立即全隐藏");

    // 非空 claim_ids 的 attested 文章：结构性排除（D3，query 级）。
    await insertArticle(ownerPool, "article_g4_linked", "链接志", "带 claim 链接的文章。");
    await ownerPool.query(
      `UPDATE world_articles SET claim_ids = ARRAY['claim_g4_canon']
       WHERE workspace_id = $1 AND id = 'article_g4_linked'`,
      [WS],
    );
    const linkedAttest = await repo.qualify(scope, {
      articleId: "article_g4_linked",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(linkedAttest.ok);
    brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("链接志"), "attested 但 claim_ids 非空必须排除");

    // 正文 attestation 后被改（hash mismatch）→ read-time DB-side 比对失败，隐藏。
    const reAttest = await repo.qualify(scope, {
      articleId: "article_g4_lore",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(reAttest.ok);
    brief = await resolveBrief();
    assert.ok(brief.worldLore.includes("灯塔遗事"), "re-attest 复活可见");
    await ownerPool.query(
      `UPDATE world_articles SET body = '篡改后的名录。'
       WHERE workspace_id = $1 AND id = 'article_g4_lore'`,
      [WS],
    );
    brief = await resolveBrief();
    assert.ok(!brief.worldLore.includes("篡改后的名录"), "hash mismatch 必须 read-time 隐藏");
    assert.ok(!brief.worldLore.includes("灯塔遗事"), "hash mismatch 后原标题也不得注入");
  },
);

test(
  "G4 schema-missing: lore fails closed empty while canon keeps flowing without 0041",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "lorelegacy", { with0041: false });
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary, valid_from_tick, valid_to_tick)
       VALUES ($1, $2, $3, 'entity_g4_legacy', 'setting', '旧库灯塔', '', 0, NULL)`,
      [WS, WORLD, WORLDLINE],
    );
    await ownerPool.query(
      `INSERT INTO world_claims (workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick, source_record_id, source_event_id, supersedes_claim_id)
       VALUES ($1, $2, $3, 'claim_g4_legacy', 'entity_g4_legacy', '状态', '旧库长明', 'story',
         'story_canon', 1, 0, NULL, NULL, NULL, NULL)`,
      [WS, WORLD, WORLDLINE],
    );
    await insertArticle(ownerPool, "article_g4_legacy", "旧库遗事", "无资格 schema 的文章。");

    const scopeRepo = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const resolved = await scopeRepo.resolve({
      workspaceId: WS,
      principalId: OWNER,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(resolved, "缺 0041 不得让 resolve 报错");
    assert.equal(resolved!.brief.worldLore, "", "缺 0041 lore 必须 fail-closed 空注入");
    assert.ok(resolved!.brief.canon.includes("旧库长明"), "缺 0041 时 canon 照常读出");
  },
);

/**
 * Article qualification G5（plan v10 §6.3）：world-knowledge GET 权限矩阵。
 * pending/rejected 正文仅 owner；qualified_public 全 member 可读；revoked
 * 全员仅 metadata；非 member 404；缺 0041 的库 fail-closed 不 500。
 */
import {
  GET as worldKnowledgeGET,
} from "../app/api/world-knowledge/route.ts";

interface GetArticleView {
  id: string;
  title: string;
  body: string;
  qualificationStatus?: string;
  availableFromTick?: number;
  availableFromOrdinal?: number;
}

async function callGet(principalId: string | null) {
  const headers: Record<string, string> = {};
  if (principalId) {
    headers.cookie = `realm_session=${createSessionValue(principalId)}`;
  }
  const response = await worldKnowledgeGET(new Request(
    `http://localhost/api/world-knowledge?worldId=${WORLD}`,
    { headers },
  ));
  const payload = await response.json();
  return { status: response.status, payload };
}

test(
  "G5 GET matrix: owner/player/observer/stranger × pending/qualified/rejected/revoked",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool, runtimeUrl } = await createTempDatabase(t, "get", { with0041: true });
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_g5_pending", "待审志", "待审正文-secret");
    await insertArticle(ownerPool, "article_g5_qualified", "授权志", "授权正文-public");
    await insertArticle(ownerPool, "article_g5_rejected", "拒绝志", "拒绝正文-secret");
    await insertArticle(ownerPool, "article_g5_revoked", "撤销志", "撤销正文-secret");
    await repo.qualify(scope, { articleId: "article_g5_qualified", decision: "attest", attestedBy: OWNER });
    await repo.qualify(scope, { articleId: "article_g5_rejected", decision: "reject", attestedBy: OWNER });
    await repo.qualify(scope, { articleId: "article_g5_revoked", decision: "attest", attestedBy: OWNER });
    await repo.qualify(scope, { articleId: "article_g5_revoked", decision: "revoke", attestedBy: OWNER });
    for (const [principal, role] of [
      [PLAYER, "player"],
      [OBSERVER, "observer"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO player_world_memberships (
           workspace_id, world_id, principal_id, role,
           omniscient_player_character, can_view_dynamic_knowledge
         ) VALUES ($1, $2, $3, $4, true, true)`,
        [WS, WORLD, principal, role],
      );
    }

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_ACCESS_TOKEN = "aq-g5-gate-token";
    t.after(async () => {
      if (previousAccessToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
      else process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      if (previousRuntimeUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      await endSharedRuntimePools();
    });

    const articlesOf = (payload: unknown) =>
      new Map(
        ((payload as { articles: GetArticleView[] }).articles)
          .map((article) => [article.id, article]),
      );

    // 非 member → 404（不泄露存在性）；无会话 → 401。
    assert.equal((await callGet(STRANGER)).status, 404);
    assert.equal((await callGet(null)).status, 401);

    // owner：pending/rejected 全文；qualified 全文；revoked 仅 metadata。
    const owner = await callGet(OWNER);
    assert.equal(owner.status, 200);
    const ownerArticles = articlesOf(owner.payload);
    assert.equal(ownerArticles.get("article_g5_pending")?.body, "待审正文-secret");
    assert.equal(ownerArticles.get("article_g5_pending")?.qualificationStatus, "pending_review");
    assert.equal(ownerArticles.get("article_g5_qualified")?.body, "授权正文-public");
    assert.equal(ownerArticles.get("article_g5_qualified")?.qualificationStatus, "qualified_public");
    // tuple 分量齐全（不丢 ordinal）。
    assert.equal(typeof ownerArticles.get("article_g5_qualified")?.availableFromTick, "number");
    assert.equal(typeof ownerArticles.get("article_g5_qualified")?.availableFromOrdinal, "number");
    assert.equal(ownerArticles.get("article_g5_rejected")?.body, "拒绝正文-secret");
    assert.equal(ownerArticles.get("article_g5_revoked")?.body, "", "revoked 对 owner 也仅 metadata");
    assert.equal(ownerArticles.get("article_g5_revoked")?.qualificationStatus, "revoked");

    // player / observer：仅 qualified_public 全文，其余 metadata（body 空串）。
    for (const principal of [PLAYER, OBSERVER]) {
      const member = await callGet(principal);
      assert.equal(member.status, 200, `${principal} 是 member，200`);
      const articles = articlesOf(member.payload);
      assert.equal(articles.get("article_g5_qualified")?.body, "授权正文-public");
      assert.equal(articles.get("article_g5_pending")?.body, "", "pending 正文非 owner 不可读");
      assert.equal(articles.get("article_g5_pending")?.qualificationStatus, "pending_review");
      assert.equal(articles.get("article_g5_rejected")?.body, "");
      assert.equal(articles.get("article_g5_revoked")?.body, "");
      assert.equal(articles.get("article_g5_pending")?.title, "待审志", "metadata 仍可见");
    }
  },
);

test(
  "G5 GET on a database without 0041: fail-closed metadata gating, no 500",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimeUrl } = await createTempDatabase(t, "getlegacy", { with0041: false });
    await insertArticle(ownerPool, "article_g5_legacy", "旧库志", "旧库正文-secret");
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, world_id, principal_id, role,
         omniscient_player_character, can_view_dynamic_knowledge
       ) VALUES ($1, $2, $3, 'player', true, true)`,
      [WS, WORLD, PLAYER],
    );

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_ACCESS_TOKEN = "aq-g5-legacy-gate-token";
    t.after(async () => {
      if (previousAccessToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
      else process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      if (previousRuntimeUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      await endSharedRuntimePools();
    });

    // owner：无资格 schema = 全部 pending_review，owner 控制面仍可读正文。
    const owner = await callGet(OWNER);
    assert.equal(owner.status, 200);
    const ownerArticle = (owner.payload.articles as GetArticleView[])
      .find((article) => article.id === "article_g5_legacy");
    assert.equal(ownerArticle?.qualificationStatus, "pending_review");
    assert.equal(ownerArticle?.body, "旧库正文-secret");

    // 非 owner member：metadata-only（body 空串），不 500。
    const player = await callGet(PLAYER);
    assert.equal(player.status, 200);
    const playerArticle = (player.payload.articles as GetArticleView[])
      .find((article) => article.id === "article_g5_legacy");
    assert.equal(playerArticle?.qualificationStatus, "pending_review");
    assert.equal(playerArticle?.body, "", "缺 0041 时非 owner 不得读正文");
  },
);
