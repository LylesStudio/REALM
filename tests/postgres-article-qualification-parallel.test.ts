/**
 * v37 X1：qualification 并行化与 gateWorldWrite 协议测试（plan v37 §E.1/§D.0）。
 * - archived 世界 qualify 拒绝（WORLD_ARCHIVED，route 409）；
 * - 跨 article 真并行：worlds/worldlines FOR KEY SHARE 兼容性 DB 级证明 +
 *   per-article advisory 锁互不阻塞证明；
 * - 同 article 并发串行化保持：seq 连续无洞；
 * - 55P03/23505 → 重试一次 → QUALIFICATION_CONCURRENT；40P01 不静默重试；
 * - 世界归档 FOR UPDATE 与 qualification KEY SHARE 双向 barrier：
 *   归档等待持锁写者；写者读 archived 拒绝。
 * 隔离库 finally DROP。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
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

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

async function createTempDatabase(t: test.TestContext, label: string) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_aq_x1_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 8 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 8 });
  ownerPool.on("error", () => undefined);
  runtimePool.on("error", () => undefined);
  t.after(async () => {
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
  return { ownerPool, runtimePool, runtimeUrl };
}

async function insertArticle(pool: pg.Pool, id: string) {
  await pool.query(
    `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [WS, WORLD, WORLDLINE, id, `Title ${id}`, `Body ${id}`],
  );
}

const advisoryKey = (articleId: string) => `${WS}|${WORLD}|${WORLDLINE}|${articleId}`;

test(
  "X1 archived world: qualify rejected WORLD_ARCHIVED (repository + route)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool, runtimeUrl } = await createTempDatabase(t, "arch");
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_x1_arch");
    await ownerPool.query(
      `UPDATE worlds SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );

    const outcome = await repo.qualify(scope, {
      articleId: "article_x1_arch",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(!outcome.ok && outcome.code === "WORLD_ARCHIVED");

    // route 层映射：archived → 409 WORLD_ARCHIVED。
    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_ACCESS_TOKEN = "aq-x1-gate-token";
    t.after(async () => {
      if (previousAccessToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
      else process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      if (previousRuntimeUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      await endSharedRuntimePools();
    });
    const response = await qualifyPOST(new Request("http://local.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `realm_session=${createSessionValue(OWNER)}`,
      },
      body: JSON.stringify({
        worldId: WORLD,
        articleId: "article_x1_arch",
        decision: "attest",
      }),
    }));
    assert.equal(response.status, 409);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, "WORLD_ARCHIVED");

    // 恢复 active 后放行（gate 每事务锁内重读，不依赖调用方早先检查）。
    await ownerPool.query(
      `UPDATE worlds SET status = 'active' WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );
    const restored = await repo.qualify(scope, {
      articleId: "article_x1_arch",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(restored.ok && restored.seq === 1);
  },
);

test(
  "X1 cross-article locks are mutually compatible (KEY SHARE + per-article advisory)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "compat");
    await insertArticle(ownerPool, "article_x1_a");
    await insertArticle(ownerPool, "article_x1_b");

    const clientA = await runtimePool.connect();
    const clientB = await runtimePool.connect();
    try {
      // txA 持有新协议的同形锁（worlds KS → advisory(article A) → worldlines KS）。
      await clientA.query("BEGIN");
      await clientA.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
      await clientA.query(
        "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
        [WS, WORLD],
      );
      await clientA.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        advisoryKey("article_x1_a"),
      ]);
      await clientA.query(
        "SELECT head_tick FROM worldlines WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
        [WS, WORLDLINE],
      );

      // txB 对另一 article 走同一协议且带紧 lock_timeout：必须立刻成功
      // （KEY SHARE 互相兼容 + 不同 advisory key 不互斥）。
      await clientB.query("BEGIN");
      await clientB.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
      await clientB.query("SET LOCAL lock_timeout = '1s'");
      await clientB.query(
        "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
        [WS, WORLD],
      );
      await clientB.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        advisoryKey("article_x1_b"),
      ]);
      await clientB.query(
        "SELECT head_tick FROM worldlines WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
        [WS, WORLDLINE],
      );
      await clientB.query("COMMIT");
    } finally {
      await clientA.query("ROLLBACK").catch(() => undefined);
      await clientB.query("ROLLBACK").catch(() => undefined);
      clientA.release();
      clientB.release();
    }

    // 同 article 的 advisory key 互斥（串行化保持）证明：txC 持锁期间
    // txD 同 key 带 1s lock_timeout 必须 55P03。
    const clientC = await runtimePool.connect();
    const clientD = await runtimePool.connect();
    try {
      await clientC.query("BEGIN");
      await clientC.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        advisoryKey("article_x1_a"),
      ]);
      await clientD.query("BEGIN");
      await clientD.query("SET LOCAL lock_timeout = '1s'");
      await assert.rejects(
        clientD.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          advisoryKey("article_x1_a"),
        ]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
    } finally {
      await clientC.query("ROLLBACK").catch(() => undefined);
      await clientD.query("ROLLBACK").catch(() => undefined);
      clientC.release();
      clientD.release();
    }
  },
);

test(
  "X1 qualify contention maps to QUALIFICATION_CONCURRENT after one retry (55P03)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "concurrent");
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_x1_lock");

    // 外部 session 级 advisory 锁持有同一 key（模拟并发 qualification 在途）。
    const holder = await ownerPool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        advisoryKey("article_x1_lock"),
      ]);
      const started = Date.now();
      const outcome = await repo.qualify(scope, {
        articleId: "article_x1_lock",
        decision: "attest",
        attestedBy: OWNER,
      });
      const elapsed = Date.now() - started;
      assert.ok(!outcome.ok && outcome.code === "QUALIFICATION_CONCURRENT");
      // 2s lock_timeout ×（首次 + 一次重试）≈ 4s+ 才返回——证明真的撞锁且只重试一次。
      assert.ok(elapsed >= 3800, `expected lock-bound retry path, got ${elapsed}ms`);
      assert.ok(elapsed < 8000, `must not retry indefinitely, got ${elapsed}ms`);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
    }
  },
);

test(
  "X1 same-article concurrent qualifies serialize with continuous seq",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "seq");
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_x1_seq");

    const decisions = ["attest", "revoke"] as const;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.qualify(scope, {
          articleId: "article_x1_seq",
          decision: decisions[i % 2]!,
          attestedBy: OWNER,
        })),
    );
    for (const result of results) {
      assert.ok(result.ok, "concurrent qualify must not fail");
    }
    const seqs = (await ownerPool.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM article_qualifications
       WHERE workspace_id = $1 AND article_id = 'article_x1_seq'
       ORDER BY seq`,
      [WS],
    )).rows.map((row) => Number(row.seq));
    // seq 连续无洞（advisory 串行化 + MAX+1 + UNIQUE 兜底）。
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  },
);

test(
  "X1 archive command waits for in-flight qualification; writer sees archived after",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t, "barrier");
    const repo = createArticleQualificationRepository(runtimePool);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    await insertArticle(ownerPool, "article_x1_barrier");

    // 写者持 worlds FOR KEY SHARE（qualify gate 同形）；归档（FOR UPDATE）必须等待。
    const writer = await runtimePool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
      await writer.query(
        "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
        [WS, WORLD],
      );
      const archiver = await ownerPool.connect();
      try {
        await archiver.query("BEGIN");
        await archiver.query("SET LOCAL lock_timeout = '1s'");
        await assert.rejects(
          archiver.query(
            "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
            [WS, WORLD],
          ),
          (error: unknown) => (error as { code?: string }).code === "55P03",
          "archive FOR UPDATE must block behind writer KEY SHARE",
        );
      } finally {
        await archiver.query("ROLLBACK").catch(() => undefined);
        archiver.release();
      }
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }

    // 归档提交后新写者读 archived 拒绝（gate 锁内重读）。
    await ownerPool.query(
      `UPDATE worlds SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );
    const outcome = await repo.qualify(scope, {
      articleId: "article_x1_barrier",
      decision: "attest",
      attestedBy: OWNER,
    });
    assert.ok(!outcome.ok && outcome.code === "WORLD_ARCHIVED");
  },
);
