/**
 * 批次 T11-E——public propagation 真实运行验收 harness
 *（规范 public documentation）。
 * 与 T11-B 的 runOnce 单测不同：本测试 spawn 当前仓库真实独立进程入口
 * `node --experimental-strip-types scripts/propagation-worker.mjs`，
 * 在隔离临时库 realm_t11e_rt_<uuid>（迁移 0001–0025 全链 + demo seed +
 * public topology + 一条合法 public Job）中证明真实进程完成
 * advisory lock → 领取 → Campaign/Packet/Exposure 持久化 → job done →
 * SIGTERM 干净 exit 0。不用固定 sleep 判断完成：轮询临时库 Job 状态与
 * 无凭据 stdout 状态行。子进程 env 只注入临时库 runtime URL 与显式
 * workspace 清单，不继承任何 token/连接串；失败/超时同样 SIGKILL 回收、
 * t.after 强制 DROP DATABASE，零开发库污染、无孤儿子进程。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresPropagationJobQueue,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import type { PropagationJobInput } from "../modules/propagation/worker.ts";

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

const CAMPAIGN_ID = "camp_t11e_rt";
const JOB_ID = "job_t11e_rt";
/** demo topology（canon_origin → harbor_tavern → market_square）的引擎产物数。 */
const EXPECTED_PACKETS = 3;
const EXPECTED_EXPOSURES = 3;
const COMPLETION_DEADLINE_MS = 90_000;
const EXIT_DEADLINE_MS = 15_000;
const COMPETITOR_EXIT_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 250;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 失败输出只允许无凭据状态：worker 状态行 + 脱敏 stderr/连接串。 */
function sanitize(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "<redacted>");
  }
  return result.replace(
    /postgres(?:ql)?:\/\/[^\s"')]+/gi,
    "<redacted-url>",
  );
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
      { key: "market_square", clearance: "public" },
    ],
    routes: [
      { from: "canon_origin", to: "harbor_tavern", channel: "official_bulletin", distance: 1 },
      { from: "harbor_tavern", to: "market_square", channel: "market_rumor", distance: 1 },
    ],
    topologyVersion: "pt_t11e_runtime_acceptance",
  };
}

async function readJobFact(ownerPool: pg.Pool): Promise<{
  state: string;
  campaigns: number;
  packets: number;
  exposures: number;
}> {
  const result = await ownerPool.query<{
    state: string;
    campaigns: number;
    packets: number;
    exposures: number;
  }>(
    `SELECT
       (SELECT status FROM propagation_jobs WHERE id = '${JOB_ID}') AS state,
       (SELECT count(*)::int FROM information_campaigns) AS campaigns,
       (SELECT count(*)::int FROM information_packets) AS packets,
       (SELECT count(*)::int FROM propagation_exposures) AS exposures`,
  );
  return result.rows[0]!;
}

test(
  "T11-E: real propagation-worker.mjs process consumes a public job in an isolated database",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 180_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11e_rt_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;

    // 真实独立进程入口（当前仓库 scripts/propagation-worker.mjs）。
    const workerScript = fileURLToPath(
      new URL("../scripts/propagation-worker.mjs", import.meta.url),
    );
    // 子进程 env 不整体继承：只注入临时库 runtime URL 与显式 workspace
    // 清单；PATH/HOME 为无凭据运行必需项，token/连接串一律不进子进程。
    const childEnv = {
      REALM_RUNTIME_DATABASE_URL: runtimeUrl.href,
      REALM_PROPAGATION_WORKSPACES: SCOPE.workspaceId,
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };

    let child: ChildProcess | null = null;
    let competitor: ChildProcess | null = null;
    let stdoutText = "";
    let stderrText = "";
    let competitorStdoutText = "";
    let competitorStderrText = "";

    const secrets = [runtimeUrl.href, ownerUrl.href, adminUrl.href];

    t.after(async () => {
      // 先确保两个真实子进程都没有残留，再回收连接并强制拆库。
      for (const process of [competitor, child]) {
        if (process && process.exitCode === null && process.signalCode === null) {
          process.kill("SIGKILL");
          await Promise.race([once(process, "exit"), sleep(5_000)]);
        }
      }
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
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
    await seedPostgresDemoPropagationTopology(ownerPool);

    // owner 通道写入唯一一条合法 public Job（campaign + pending job）；
    // 临时库隔离——realm_test 与已安装 systemd Worker（持 realm_test 的锁）
    // 均接触不到本 Job。
    await ownerPool.query(
      `INSERT INTO information_campaigns (
         workspace_id, world_id, worldline_id, id, effective_tick,
         security_class, algorithm_version
       ) VALUES ($1, $2, $3, $4, 10, 'public', 'realm-propagate-v1')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, CAMPAIGN_ID],
    );
    const queue = createPostgresPropagationJobQueue(ownerPool);
    await queue.enqueue(SCOPE, {
      id: JOB_ID,
      campaignId: CAMPAIGN_ID,
      input: jobInput(CAMPAIGN_ID, "packet_t11e_rt"),
    });
    // 模拟上次 Worker 崩溃留下的 running 任务；真实入口启动时必须
    // 恢复为 pending，再由同一进程领取并完成。
    await ownerPool.query(
      `UPDATE propagation_jobs
       SET status = 'running', started_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, JOB_ID],
    );

    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", workerScript],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        // vinext 类型把 ProcessEnv.NODE_ENV 增强为必填（与 Node 真实运行时
        // 不符）；此处 env 是刻意最小化的字符串字典，经 unknown 断言。
        env: childEnv as unknown as NodeJS.ProcessEnv,
      },
    );
    child = worker;
    worker.stdout?.setEncoding("utf8");
    worker.stderr?.setEncoding("utf8");
    worker.stdout?.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    worker.stderr?.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    const childExitPromise = once(worker, "exit");

    // 先确认第一个真实进程已经持锁，再启动第二个真实进程。
    // 这样竞争断言不会依赖固定 sleep，也不会把两个进程都误判成 winner。
    const lockDeadline = Date.now() + 30_000;
    while (!stdoutText.includes("advisory lock acquired")) {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(
          `worker exited before acquiring lock: code=${worker.exitCode} signal=${worker.signalCode}\n`
          + sanitize(stderrText, secrets),
        );
      }
      if (Date.now() >= lockDeadline) {
        throw new Error("timed out waiting for first worker advisory lock");
      }
      await sleep(100);
    }

    const competitorWorker = spawn(
      process.execPath,
      ["--experimental-strip-types", workerScript],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: childEnv as unknown as NodeJS.ProcessEnv,
      },
    );
    competitor = competitorWorker;
    competitorWorker.stdout?.setEncoding("utf8");
    competitorWorker.stderr?.setEncoding("utf8");
    competitorWorker.stdout?.on("data", (chunk: string) => {
      competitorStdoutText += chunk;
    });
    competitorWorker.stderr?.on("data", (chunk: string) => {
      competitorStderrText += chunk;
    });
    const competitorExit = await Promise.race([
      once(competitorWorker, "exit"),
      sleep(COMPETITOR_EXIT_DEADLINE_MS).then(() => null),
    ]);
    assert.notEqual(
      competitorExit,
      null,
      "第二个真实 Worker 必须在有限时间内因 advisory lock 退出",
    );
    const [competitorCode, competitorSignal] = competitorExit as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(competitorCode, 1, sanitize(competitorStderrText, secrets));
    assert.equal(competitorSignal, null);
    assert.match(
      sanitize(`${competitorStdoutText}\n${competitorStderrText}`, secrets),
      /another propagation worker instance holds the advisory lock/,
    );

    const safeDiagnostics = (fact: {
      state: string;
      campaigns: number;
      packets: number;
      exposures: number;
    }): string => {
      const workerLines = stdoutText
        .split("\n")
        .filter((line) => line.startsWith("[propagation-worker]"))
        .join("\n");
      return [
        `job state=${fact.state} campaigns=${fact.campaigns} packets=${fact.packets} exposures=${fact.exposures}`,
        `worker stdout:\n${workerLines || "(none)"}`,
        `worker stderr (sanitized):\n${sanitize(stderrText, secrets).slice(-1000) || "(none)"}`,
      ].join("\n");
    };

    // 完成信号轮询（非固定 sleep）：Job done + demo topology 产物数 +
    // stdout 同时出现 advisory lock 与 job done 状态行。
    const deadline = Date.now() + COMPLETION_DEADLINE_MS;
    let fact = await readJobFact(ownerPool);
    for (;;) {
      const lockLogged = stdoutText.includes("advisory lock acquired");
      const doneLogged = stdoutText.includes(
        `job done for ${SCOPE.workspaceId}`,
      );
      if (
        fact.state === "done"
        && fact.campaigns === 1
        && fact.packets === EXPECTED_PACKETS
        && fact.exposures === EXPECTED_EXPOSURES
        && lockLogged
        && stdoutText.includes("recovered 1 stale job(s)")
        && doneLogged
      ) {
        break;
      }
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(
          `worker process exited before completing the job: `
          + `code=${worker.exitCode} signal=${worker.signalCode}\n${safeDiagnostics(fact)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for the real worker process to finish the job\n${safeDiagnostics(fact)}`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
      fact = await readJobFact(ownerPool);
    }

    assert.equal(fact.state, "done");
    assert.equal(fact.campaigns, 1);
    assert.equal(fact.packets, EXPECTED_PACKETS);
    assert.equal(fact.exposures, EXPECTED_EXPOSURES);
    const exposureRows = await ownerPool.query(
      `SELECT node_key FROM propagation_exposures
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       ORDER BY node_key`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );
    assert.deepEqual(
      exposureRows.rows.map((row: { node_key: string }) => row.node_key),
      ["canon_origin", "harbor_tavern", "market_square"],
    );

    // SIGTERM 干净退出：等待真实 exit 0（非 signal 终止）。
    worker.kill("SIGTERM");
    const exited = await Promise.race([
      childExitPromise,
      sleep(EXIT_DEADLINE_MS).then(() => null),
    ]);
    if (exited === null) {
      worker.kill("SIGKILL");
      await Promise.race([childExitPromise, sleep(5_000)]);
      throw new Error(
        `worker process ignored SIGTERM for ${EXIT_DEADLINE_MS}ms\n${safeDiagnostics(fact)}`,
      );
    }
    const [exitCode, exitSignal] = exited;
    assert.equal(
      exitCode,
      0,
      `worker must exit 0 on SIGTERM, got signal=${exitSignal}\n${safeDiagnostics(fact)}`,
    );
    assert.equal(exitSignal, null);

    // 安全证据：仅 [propagation-worker] 前缀的无凭据状态行。
    for (const line of stdoutText.split("\n")) {
      if (line.startsWith("[propagation-worker]")) t.diagnostic(line);
    }
    t.diagnostic(`worker exit code=${exitCode} signal=${exitSignal}`);
  },
);
