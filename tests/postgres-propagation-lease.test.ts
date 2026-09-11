/**
 * v37 X1：propagation lease 贯穿契约测试（plan v37 §D.0 状态图）。
 * lease = { jobId, attempts } 双分量：
 * - claimNext 铸新 token（attempts+1，RETURNING lease）；claim 时发现归档 →
 *   failed('WORLD_ARCHIVED')（控制面，幂等）；
 * - completeRun(lease)：worlds(KEY SHARE, active) → jobs FOR UPDATE 双分量
 *   断言 → 内容写 → done；stale lease → STALE_LEASE 不写内容；archived →
 *   WORLD_ARCHIVED 拒绝（worker 随后 markFailed，幂等）；
 * - markFailed(lease)：stale → stale_ignored（新 attempt 不受影响）；
 * - retry：failed→pending 状态条件（running 0 行 no-op）；retry 后旧 token
 *   全失效；
 * - recoverStale：started_at 超 5min 才回收；completeRun 持 job 行锁期间
 *   recoverStale 串行无穿插。
 * 隔离库 finally DROP。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresPropagationJobQueue,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import type { PropagationJobInput } from "../modules/propagation/worker.ts";

const adminConnectionString = process.env.DATABASE_URL;

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
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
];

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
};

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

function jobInput(campaignId: string, packetId: string): PropagationJobInput {
  return {
    campaign: {
      id: campaignId,
      securityClass: "public",
      effectiveTick: 10,
      salience: 0.5,
      complexity: 0.5,
    },
    roots: [
      {
        nodeKey: "canon_origin",
        packet: {
          id: packetId,
          campaignId,
          parentPacketId: null,
          channel: "official_bulletin",
          claimIds: ["c1"],
          framing: "neutral",
          omittedClaimIds: [],
          semanticFidelityToParent: 1,
          contentHash: `hash_${packetId}`,
        },
      },
    ],
    nodes: [
      { key: "canon_origin", clearance: "public" },
      { key: "harbor_tavern", clearance: "public" },
    ],
    routes: [
      { from: "canon_origin", to: "harbor_tavern", channel: "official_bulletin", distance: 1 },
    ],
    topologyVersion: "pt_lease_test",
  };
}

function runFor(campaignId: string, packetId: string) {
  const input = jobInput(campaignId, packetId);
  return {
    campaign: input.campaign,
    packets: [input.roots[0]!.packet],
    exposures: [
      {
        nodeKey: "canon_origin",
        packetId,
        channel: "official_bulletin" as const,
        arrivalTick: 10,
        fidelity: 1,
      },
    ],
    algorithmVersion: "realm-propagate-v1",
  };
}

async function createTempDatabase(t: test.TestContext, label: string) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_lease_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 6 });
  ownerPool.on("error", () => undefined);
  t.after(async () => {
    await ownerPool.end().catch(() => undefined);
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await maintenance.end();
  });
  for (const filename of MIGRATIONS) {
    await ownerPool.query(
      await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"),
    );
  }
  await seedPostgresDemo(ownerPool);
  await seedPostgresDemoPropagationTopology(ownerPool);
  return { ownerPool };
}

async function enqueueJob(
  pool: pg.Pool,
  queue: ReturnType<typeof createPostgresPropagationJobQueue>,
  jobId: string,
) {
  await pool.query(
    `INSERT INTO information_campaigns (
       workspace_id, world_id, worldline_id, id, effective_tick,
       security_class, algorithm_version
     ) VALUES ($1, $2, $3, $4, 10, 'public', 'realm-propagate-v1')`,
    [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, `camp_${jobId}`],
  );
  await queue.enqueue(SCOPE, {
    id: jobId,
    campaignId: `camp_${jobId}`,
    input: jobInput(`camp_${jobId}`, `packet_${jobId}`),
  });
}

async function jobState(pool: pg.Pool, jobId: string) {
  const row = (await pool.query(
    `SELECT status, attempts::text AS attempts, last_error
     FROM propagation_jobs WHERE workspace_id = $1 AND id = $2`,
    [SCOPE.workspaceId, jobId],
  )).rows[0];
  return row
    ? { status: row.status as string, attempts: Number(row.attempts), lastError: row.last_error as string | null }
    : null;
}

test(
  "lease: claim mints token; completeRun(lease) writes content and finishes done",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "mint");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_mint");

    const claimed = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(claimed, "job must be claimable");
    assert.deepEqual(claimed!.lease, { jobId: "job_mint", attempts: 1 });
    assert.equal(claimed!.job.attempts, 1);

    await queue.completeRun(
      claimed!.scope,
      claimed!.lease,
      runFor(`camp_job_mint`, "packet_job_mint"),
    );
    assert.equal((await jobState(ownerPool, "job_mint"))?.status, "done");
    const exposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures
       WHERE workspace_id = $1 AND campaign_id = 'camp_job_mint'`,
      [SCOPE.workspaceId],
    );
    assert.equal(exposures.rows[0].c, 1);
  },
);

test(
  "lease: stale completeRun raises STALE_LEASE without writing content",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "stale");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_stale");
    const claimed = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(claimed);

    const staleLease = { jobId: "job_stale", attempts: claimed!.lease.attempts + 1 };
    await assert.rejects(
      queue.completeRun(claimed!.scope, staleLease, runFor("camp_job_stale", "packet_job_stale")),
      (error: unknown) => (error as { code?: string }).code === "STALE_LEASE",
    );
    const state = await jobState(ownerPool, "job_stale");
    assert.equal(state?.status, "running");
    const exposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures WHERE workspace_id = $1`,
      [SCOPE.workspaceId],
    );
    assert.equal(exposures.rows[0].c, 0, "stale lease must not write content");
  },
);

test(
  "lease: markFailed with stale lease is stale_ignored; valid lease fails the job",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "markfailed");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_mf");
    const claimed = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(claimed);

    const stale = await queue.markFailed(
      claimed!.scope,
      { jobId: "job_mf", attempts: claimed!.lease.attempts + 1 },
      "stale worker failure",
    );
    assert.deepEqual(stale, { staleIgnored: true });
    assert.equal((await jobState(ownerPool, "job_mf"))?.status, "running");

    const failed = await queue.markFailed(claimed!.scope, claimed!.lease, "real failure");
    assert.deepEqual(failed, { staleIgnored: false });
    const state = await jobState(ownerPool, "job_mf");
    assert.equal(state?.status, "failed");
    assert.equal(state?.lastError, "real failure");
  },
);

test(
  "lease: retry invalidates old token; retry on a reclaimed job is a no-op",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "retry");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_retry");
    const first = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(first);
    await queue.markFailed(first!.scope, first!.lease, "transient");
    await queue.retry(SCOPE, "job_retry");
    assert.equal((await jobState(ownerPool, "job_retry"))?.status, "pending");

    const second = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(second);
    assert.equal(second!.lease.attempts, 2, "new claim mints a new token");

    // 旧 token 全失效（stale success 不写内容）。
    await assert.rejects(
      queue.completeRun(first!.scope, first!.lease, runFor("camp_job_retry", "packet_job_retry")),
      (error: unknown) => (error as { code?: string }).code === "STALE_LEASE",
    );

    // onFailed→retry 竞态：job 已被新 claim（running）→ retry 状态条件 0 行 no-op。
    await queue.retry(SCOPE, "job_retry");
    assert.equal((await jobState(ownerPool, "job_retry"))?.status, "running");

    // 新 token 正常完成。
    await queue.completeRun(second!.scope, second!.lease, runFor("camp_job_retry", "packet_job_retry"));
    assert.equal((await jobState(ownerPool, "job_retry"))?.status, "done");
  },
);

test(
  "lease: recoverStale only reaps jobs stale beyond 5 minutes and serializes with completeRun",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "recover");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_fresh");
    await enqueueJob(ownerPool, queue, "job_old");

    const first = await queue.claimNext(SCOPE.workspaceId);
    const second = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(first && second);

    // 新 running job（<5min）不被回收。
    assert.equal(await queue.recoverStale(SCOPE.workspaceId), 0);
    assert.equal((await jobState(ownerPool, first!.lease.jobId))?.status, "running");

    // started_at 超 5min → 回收为 pending；旧 token 失效。
    await ownerPool.query(
      `UPDATE propagation_jobs
       SET started_at = CURRENT_TIMESTAMP - interval '10 minutes'
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, first!.lease.jobId],
    );

    // completeRun 持 job 行锁期间 recoverStale 串行（无 running→pending 穿插）：
    // 外部持 FOR UPDATE 行锁时 recoverStale 带 lock_timeout 必须 55P03。
    const holder = await ownerPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('realm.workspace_id', $1, true)", [SCOPE.workspaceId]);
      await holder.query(
        `SELECT id FROM propagation_jobs
         WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [SCOPE.workspaceId, first!.lease.jobId],
      );
      const contender = await ownerPool.connect();
      try {
        await contender.query("BEGIN");
        await contender.query("SELECT set_config('realm.workspace_id', $1, true)", [SCOPE.workspaceId]);
        await contender.query("SET LOCAL lock_timeout = '1s'");
        await assert.rejects(
          contender.query(
            `UPDATE propagation_jobs
             SET status = 'pending', started_at = NULL
             WHERE workspace_id = $1 AND status = 'running'
               AND started_at < CURRENT_TIMESTAMP - interval '5 minutes'`,
            [SCOPE.workspaceId],
          ),
          (error: unknown) => (error as { code?: string }).code === "55P03",
        );
      } finally {
        await contender.query("ROLLBACK").catch(() => undefined);
        contender.release();
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    assert.equal(await queue.recoverStale(SCOPE.workspaceId), 1);
    assert.equal((await jobState(ownerPool, first!.lease.jobId))?.status, "pending");
    // 回收后旧 token 失效，新 claim 铸新 token。
    await assert.rejects(
      queue.completeRun(first!.scope, first!.lease, runFor(`camp_${first!.lease.jobId}`, `packet_${first!.lease.jobId}`)),
      (error: unknown) => (error as { code?: string }).code === "STALE_LEASE",
    );
  },
);

test(
  "lease: claim on archived world marks the job failed(WORLD_ARCHIVED) idempotently",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "claimarch");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_arch");
    await ownerPool.query(
      `UPDATE worlds SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );

    assert.equal(await queue.claimNext(SCOPE.workspaceId), null);
    const state = await jobState(ownerPool, "job_arch");
    assert.equal(state?.status, "failed");
    assert.equal(state?.lastError, "WORLD_ARCHIVED");
    // 幂等：再次 claim 无副作用。
    assert.equal(await queue.claimNext(SCOPE.workspaceId), null);
    assert.equal((await jobState(ownerPool, "job_arch"))?.status, "failed");
  },
);

test(
  "lease: archived after claim → completeRun rejects, markFailed settles idempotently",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "afterclaim");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_ac");
    const claimed = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(claimed);

    await ownerPool.query(
      `UPDATE worlds SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await assert.rejects(
      queue.completeRun(claimed!.scope, claimed!.lease, runFor("camp_job_ac", "packet_job_ac")),
      (error: unknown) => (error as { code?: string }).code === "WORLD_ARCHIVED",
    );
    const exposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures WHERE workspace_id = $1`,
      [SCOPE.workspaceId],
    );
    assert.equal(exposures.rows[0].c, 0, "archived world must not accept content");

    const failed = await queue.markFailed(claimed!.scope, claimed!.lease, "WORLD_ARCHIVED");
    assert.deepEqual(failed, { staleIgnored: false });
    assert.equal((await jobState(ownerPool, "job_ac"))?.status, "failed");
    // 幂等收尾：重复 markFailed 同 lease 不再命中（job 已 failed）。
    const again = await queue.markFailed(claimed!.scope, claimed!.lease, "WORLD_ARCHIVED");
    assert.deepEqual(again, { staleIgnored: true });
  },
);

test(
  "lease: crash replay through the real claim path keeps content idempotent",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "replay");
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await enqueueJob(ownerPool, queue, "job_replay");
    const first = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(first);
    // 崩溃：job 停在 running（无内容写入）。
    await ownerPool.query(
      `UPDATE propagation_jobs
       SET started_at = CURRENT_TIMESTAMP - interval '10 minutes'
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, first!.lease.jobId],
    );
    assert.equal(await queue.recoverStale(SCOPE.workspaceId), 1);
    const second = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(second && second!.lease.attempts === 2);
    await queue.completeRun(second!.scope, second!.lease, runFor("camp_job_replay", "packet_job_replay"));
    assert.equal((await jobState(ownerPool, "job_replay"))?.status, "done");

    // 重放同一 run 内容（新 token 场景模拟：failed→retry→claim→completeRun）。
    await ownerPool.query(
      `UPDATE propagation_jobs SET status = 'failed' WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, "job_replay"],
    );
    await queue.retry(SCOPE, "job_replay");
    const third = await queue.claimNext(SCOPE.workspaceId);
    assert.ok(third && third!.lease.attempts === 3);
    await queue.completeRun(third!.scope, third!.lease, runFor("camp_job_replay", "packet_job_replay"));
    const exposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures
       WHERE workspace_id = $1 AND campaign_id = 'camp_job_replay'`,
      [SCOPE.workspaceId],
    );
    assert.equal(exposures.rows[0].c, 1, "replay must not duplicate exposures");
  },
);
