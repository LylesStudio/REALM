/**
 * Slice 3：统一 durable job 队列（realm_durable_jobs，迁移 0058）的真实
 * PostgreSQL 验收。一次性库（t.after 强制拆库，全迁移链 readdir 应用）：
 * enqueue/claim/complete/fail 全链、active 去重与 terminal 重排、stale
 * recovery（租约过期回收）、幂等 complete（settled）与 lease fencing
 * （stale）、job_kind/payload 有界校验、跨 record 与跨 workspace（RLS）
 * 隔离、realm_runtime 授权真实存在。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresDurableJobQueue,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { DurableJobQueueError } from "../database/postgres/durable-job-queue.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { readPersistentGenerationStatus } from "../database/postgres/generation-status.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const WORKSPACE = POSTGRES_DEMO_IDS.workspace;
const NOW = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-11T00:10:01.000Z";

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_djob_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  ownerPool.on("error", () => undefined);
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
  runtimePool.on("error", () => undefined);

  t.after(async () => {
    await ownerPool.end().catch(() => undefined);
    await runtimePool.end().catch(() => undefined);
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  return { ownerPool, runtimePool };
}

test(
  "Slice 3: durable job queue claim/complete/fail/stale/isolation on real PG",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);

    // realm_runtime 受限角色的队列（grant 真实存在：RLS + workspace 事务）。
    const queue = createPostgresDurableJobQueue({
      pool: runtimePool,
      workspaceId: WORKSPACE,
      leaseOwner: "test-worker-1",
      leaseDurationMs: 60_000,
    });

    // ---- enqueue → claim → complete（first-night）----
    assert.equal(await queue.enqueue({
      jobId: "first-night:record_a",
      kind: "first-night",
      recordId: "record_a",
      payload: {},
      requeueTerminal: true,
      availableAt: NOW,
    }), "inserted");
    assert.deepEqual(await readPersistentGenerationStatus(runtimePool, WORKSPACE, "record_a"), {
      busy: true, activities: [{ phase: "queued" }],
    });
    assert.deepEqual(await readPersistentGenerationStatus(runtimePool, WORKSPACE, "record_b"), {
      busy: false, activities: [],
    });
    // active 去重：同 id 不重叠。
    assert.equal(await queue.enqueue({
      jobId: "first-night:record_a",
      kind: "first-night",
      recordId: "record_a",
      payload: {},
      requeueTerminal: true,
      availableAt: NOW,
    }), "existing");

    const claimed = await queue.claimNext({ now: NOW, kinds: ["first-night"] });
    assert.ok(claimed);
    assert.equal(claimed.jobId, "first-night:record_a");
    assert.equal(claimed.recordId, "record_a");
    assert.equal(claimed.kind, "first-night");
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.leaseOwner, "test-worker-1");
    assert.deepEqual(await readPersistentGenerationStatus(runtimePool, WORKSPACE, "record_a"), {
      busy: true, activities: [{ phase: "opening" }],
    });
    // 未到期 claimed 行不得重领。
    assert.equal(await queue.claimNext({ now: NOW, kinds: ["first-night"] }), null);

    // 幂等 complete：applied → settled；其他 lease owner 的完成是 stale。
    assert.equal(await queue.complete(claimed, NOW), "applied");
    assert.deepEqual(await readPersistentGenerationStatus(runtimePool, WORKSPACE, "record_a"), {
      busy: false, activities: [],
    });
    assert.equal(await queue.complete(claimed, NOW), "settled");
    assert.equal(
      await queue.complete({ ...claimed, leaseOwner: "intruder" }, NOW),
      "settled",
    );

    // terminal 重排（懒重试）：completed 行重置回 pending。
    assert.equal(await queue.enqueue({
      jobId: "first-night:record_a",
      kind: "first-night",
      recordId: "record_a",
      payload: {},
      requeueTerminal: true,
      availableAt: NOW,
    }), "requeued");

    // ---- stale recovery：claimed 租约过期回收重跑 ----
    const first = await queue.claimNext({ now: NOW, kinds: ["first-night"] });
    assert.ok(first);
    assert.equal(first.attemptCount, 2, "重排后 attempt_count 不重置");
    // worker 崩溃：不 settle。租约过期后回收。
    assert.equal(await queue.claimNext({ now: NOW, kinds: ["first-night"] }), null);
    const reclaimed = await queue.claimNext({ now: LATER, kinds: ["first-night"] });
    assert.ok(reclaimed);
    assert.equal(reclaimed.attemptCount, 3);
    // 旧 fencing 的 settle 是 stale（租约已易手）。
    assert.equal(await queue.complete(first, LATER), "stale");
    assert.equal(await queue.complete(reclaimed, LATER), "applied");

    // ---- failure settlement：fail 幂等 + last_error_code 有界 ----
    await queue.enqueue({
      jobId: "self-play-beat:sess_x:1",
      kind: "self-play-beat",
      recordId: "record_a",
      payload: { sessionId: "sess_x", beat: 1 },
      availableAt: NOW,
    });
    const beatJob = await queue.claimNext({ now: NOW, kinds: ["self-play-beat"] });
    assert.ok(beatJob);
    assert.equal(await queue.fail(beatJob, "SELFPLAY_SCOPE_UNAVAILABLE", NOW), "applied");
    assert.equal(await queue.fail(beatJob, "SELFPLAY_SCOPE_UNAVAILABLE", NOW), "settled");
    const failedRow = await ownerPool.query<{ state: string; last_error_code: string }>(
      `SELECT state, last_error_code FROM realm_durable_jobs
       WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE, "self-play-beat:sess_x:1"],
    );
    assert.equal(failedRow.rows[0]?.state, "failed");
    assert.equal(failedRow.rows[0]?.last_error_code, "SELFPLAY_SCOPE_UNAVAILABLE");

    // ---- kind 过滤 + 跨 record 隔离 ----
    await queue.enqueue({
      jobId: "memory-prefetch:i:record_b:1:char_a",
      kind: "memory-prefetch",
      recordId: "record_b",
      payload: {
        sessionId: 1,
        worldId: "world_demo",
        worldlineId: "worldline_demo",
        characterInstanceId: "char_a",
        query: "灯塔",
      },
      availableAt: NOW,
    });
    // first-night 的 claim 不取 memory-prefetch 行（kind 过滤）。
    assert.equal(await queue.claimNext({ now: NOW, kinds: ["first-night"] }), null);
    const prefetchJob = await queue.claimNext({ now: NOW, kinds: ["memory-prefetch"] });
    assert.ok(prefetchJob);
    assert.equal(prefetchJob.recordId, "record_b");
    assert.equal(await queue.complete(prefetchJob, NOW), "applied");

    // ---- 有界校验：非法 kind / 非 object / 超界 payload fail-closed ----
    await assert.rejects(
      queue.enqueue({
        jobId: "bad-kind",
        kind: "unknown-kind" as never,
        recordId: "record_a",
        payload: {},
      }),
      (error: unknown) =>
        error instanceof DurableJobQueueError
        && error.code === "DURABLE_JOB_KIND_INVALID",
    );
    await assert.rejects(
      queue.enqueue({
        jobId: "bad-payload",
        kind: "first-night",
        recordId: "record_a",
        payload: "not-an-object" as never,
      }),
      (error: unknown) =>
        error instanceof DurableJobQueueError
        && error.code === "DURABLE_JOB_PAYLOAD_INVALID",
    );
    await assert.rejects(
      queue.enqueue({
        jobId: "huge-payload",
        kind: "first-night",
        recordId: "record_a",
        payload: { blob: "x".repeat(8192) },
      }),
      (error: unknown) =>
        error instanceof DurableJobQueueError
        && error.code === "DURABLE_JOB_PAYLOAD_INVALID",
    );
    // DB CHECK 兜底：旁路应用层直接写非法 kind 被拒绝。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO realm_durable_jobs (workspace_id, id, job_kind, record_id)
         VALUES ($1, 'direct-bad-kind', 'nope', 'record_a')`,
        [WORKSPACE],
      ),
    );
    // DB CHECK 兜底：超界 payload 直接写被拒绝。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO realm_durable_jobs (workspace_id, id, job_kind, record_id, payload)
         VALUES ($1, 'direct-huge', 'first-night', 'record_a', $2::jsonb)`,
        [WORKSPACE, JSON.stringify({ blob: "x".repeat(8192) })],
      ),
    );

    // ---- 跨 workspace（RLS）隔离 ----
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_other', '其他工作区')`,
    );
    const otherQueue = createPostgresDurableJobQueue({
      pool: runtimePool,
      workspaceId: "ws_other",
      leaseOwner: "test-worker-2",
      leaseDurationMs: 60_000,
    });
    assert.equal(await otherQueue.enqueue({
      jobId: "first-night:record_a",
      kind: "first-night",
      recordId: "record_a",
      payload: {},
      availableAt: NOW,
    }), "inserted", "跨 workspace 同 id 不冲突（PK 含 workspace）");
    const otherClaim = await otherQueue.claimNext({ now: NOW, kinds: ["first-night"] });
    assert.ok(otherClaim);
    assert.equal(otherClaim.workspaceId, "ws_other");
    assert.equal(await otherQueue.complete(otherClaim, NOW), "applied");
    // 本 workspace 的 claim 看不到 ws_other 的行（RLS FORCE）。
    assert.equal(await queue.claimNext({ now: NOW, kinds: ["first-night"] }), null);
    // workspace 事务内行数各自隔离：ws_demo 3 行 / ws_other 1 行。
    const demoCount = await withWorkspaceTransaction(
      runtimePool,
      WORKSPACE,
      async (client) =>
        (await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM realm_durable_jobs",
        )).rows[0]!.n,
      { readOnly: true },
    );
    assert.equal(demoCount, 3);
    const otherCount = await withWorkspaceTransaction(
      runtimePool,
      "ws_other",
      async (client) =>
        (await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM realm_durable_jobs",
        )).rows[0]!.n,
      { readOnly: true },
    );
    assert.equal(otherCount, 1);
  },
);
