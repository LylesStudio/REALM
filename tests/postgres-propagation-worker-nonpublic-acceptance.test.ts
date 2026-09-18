/**
 * 批次 T11-H——restricted/secret 真实 Worker 子进程 acceptance（T11-H §四）。
 * 隔离临时库（迁移 0001–0027 全链，t.after 强制拆库）+ 真实 spawn
 * scripts/propagation-worker.mjs（不触碰 realm_test 与已装 systemd 服务）：
 * restricted（有效 audience + restricted-clearance 拓扑）→ 真实 done 与
 * 产物计数；secret/private_letter（唯一 recipient 映射）→ done 且目标
 * 节点 Exposure 闭环；secret/market_rumor → 永久 failed、零错误渠道产物。
 * SIGTERM 干净 exit 0；无孤儿子进程。零开发库污染。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_DEMO_IDS,
  createPostgresPropagationJobQueue,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import { createHash } from "node:crypto";
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
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
  "0028_propagation_node_audiences_owner_append.sql",
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audienceDigestOf(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex")
    .slice(0, 24);
}

function makeJobInput(options: {
  campaignId: string;
  securityClass: "restricted" | "secret";
  packetId: string;
  routes: PropagationJobInput["routes"];
  revisionId: string;
  audience: readonly string[];
}): PropagationJobInput {
  return {
    campaign: {
      id: options.campaignId,
      securityClass: options.securityClass,
      effectiveTick: 10,
      salience: 0.5,
      complexity: 0.5,
    },
    roots: [
      {
        nodeKey: "canon_origin",
        packet: {
          id: options.packetId,
          campaignId: options.campaignId,
          parentPacketId: null,
          // secret 第一阶段 root packet 同样只允许 private_letter。
          channel: options.securityClass === "secret"
            ? "private_letter"
            : "official_bulletin",
          claimIds: ["c1"],
          framing: "neutral",
          omittedClaimIds: [],
          semanticFidelityToParent: 1,
          contentHash: `hash_${options.packetId}`,
        },
      },
    ],
    nodes: [
      { key: "canon_origin", clearance: options.securityClass },
      { key: "harbor_tavern", clearance: options.securityClass },
      { key: "market_square", clearance: options.securityClass },
    ],
    routes: options.routes,
    topologyVersion: "pt_t11h_acceptance",
    canonRevisionId: options.revisionId,
    audienceContinuityIds: options.audience,
    audienceDigest: audienceDigestOf(options.audience),
  };
}

test(
  "T11-H: real worker process completes restricted and secret/private_letter jobs, permanently fails secret rumor",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 240_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11h_rt_${randomUUID().replaceAll("-", "")}`;
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

    const workerScript = fileURLToPath(
      new URL("../scripts/propagation-worker.mjs", import.meta.url),
    );
    const childEnv = {
      REALM_RUNTIME_DATABASE_URL: runtimeUrl.href,
      REALM_PROPAGATION_WORKSPACES: SCOPE.workspaceId,
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
    let child: ChildProcess | null = null;
    let stdoutText = "";
    let stderrText = "";

    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), sleep(5_000)]);
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
    // restricted/secret 级拓扑：升级种子节点 clearance（临时库），并为
    // private_letter recipient 建唯一 node→continuity 映射。
    await ownerPool.query(
      `UPDATE propagation_nodes SET clearance = 'restricted'`,
    );
    await ownerPool.query(
      `INSERT INTO propagation_routes (
         workspace_id, world_id, worldline_id, id,
         from_node, to_node, channel, distance, recipient
       ) VALUES ($1, $2, $3, 'route_t11h_letter',
         'canon_origin', 'harbor_tavern', 'private_letter', 1, 'harbor_tavern')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );
    await ownerPool.query(
      `INSERT INTO propagation_node_audiences (
         workspace_id, world_id, worldline_id, node_key, continuity_id
       ) VALUES ($1, $2, $3, 'harbor_tavern', 'continuity_scout')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );

    const queue = createPostgresPropagationJobQueue(ownerPool);
    const seedCampaign = async (campaignId: string, securityClass: string) => {
      await ownerPool.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, effective_tick,
           security_class, algorithm_version
         ) VALUES ($1, $2, $3, $4, 10, $5, 'realm-propagate-v1')`,
        [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, campaignId, securityClass],
      );
    };

    // 三个真实 Job：restricted 合法、secret/private_letter 合法、
    // secret/market_rumor 永久失败。
    await seedCampaign("campaign_t11h_restricted", "restricted");
    await queue.enqueue(SCOPE, {
      id: "job_t11h_restricted",
      campaignId: "campaign_t11h_restricted",
      input: makeJobInput({
        campaignId: "campaign_t11h_restricted",
        securityClass: "restricted",
        packetId: "packet_t11h_restricted",
        routes: [
          { from: "canon_origin", to: "harbor_tavern", channel: "official_bulletin", distance: 1 },
          { from: "harbor_tavern", to: "market_square", channel: "market_rumor", distance: 1 },
        ],
        revisionId: "revision_t11h_restricted",
        audience: ["continuity_player"],
      }),
    });
    await seedCampaign("campaign_t11h_secret", "secret");
    await queue.enqueue(SCOPE, {
      id: "job_t11h_secret",
      campaignId: "campaign_t11h_secret",
      input: makeJobInput({
        campaignId: "campaign_t11h_secret",
        securityClass: "secret",
        packetId: "packet_t11h_secret",
        routes: [
          { from: "canon_origin", to: "harbor_tavern", channel: "private_letter", distance: 1, recipient: "harbor_tavern" },
        ],
        revisionId: "revision_t11h_secret",
        audience: ["continuity_scout"],
      }),
    });
    await seedCampaign("campaign_t11h_bad", "secret");
    await queue.enqueue(SCOPE, {
      id: "job_t11h_bad",
      campaignId: "campaign_t11h_bad",
      input: makeJobInput({
        campaignId: "campaign_t11h_bad",
        securityClass: "secret",
        packetId: "packet_t11h_bad",
        routes: [
          { from: "canon_origin", to: "market_square", channel: "market_rumor", distance: 1 },
        ],
        revisionId: "revision_t11h_bad",
        audience: ["continuity_scout"],
      }),
    });

    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", workerScript],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
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

    const readStates = async () => {
      const result = await ownerPool.query(
        `SELECT id, status, last_error FROM propagation_jobs ORDER BY id`,
      );
      return new Map(
        result.rows.map((row) => [
          row.id as string,
          { status: row.status as string, lastError: row.last_error as string | null },
        ]),
      );
    };
    const sanitize = (value: string) =>
      [runtimeUrl.href, ownerUrl.href, adminUrl.href].reduce(
        (text, secret) => text.split(secret).join("[redacted]"),
        value,
      );

    // 完成信号轮询（非固定 sleep）：两个 done + 一个 failed 终态。
    const deadline = Date.now() + 120_000;
    let states = await readStates();
    for (;;) {
      const restricted = states.get("job_t11h_restricted");
      const secret = states.get("job_t11h_secret");
      const bad = states.get("job_t11h_bad");
      if (
        restricted?.status === "done"
        && secret?.status === "done"
        && bad?.status === "failed"
        && stdoutText.includes("advisory lock acquired")
      ) {
        break;
      }
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(
          `worker exited early: code=${worker.exitCode} signal=${worker.signalCode}\nstates=${JSON.stringify([...states.entries()])}\nstderr=${sanitize(stderrText).slice(-800)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for worker terminal states\nstates=${JSON.stringify([...states.entries()])}`,
        );
      }
      await sleep(300);
      states = await readStates();
    }

    // restricted：产物计数（3 节点 Exposure）与状态。
    const restrictedFact = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM information_packets WHERE campaign_id = 'campaign_t11h_restricted') AS packets,
         (SELECT count(*)::int FROM propagation_exposures WHERE campaign_id = 'campaign_t11h_restricted') AS exposures`,
    );
    assert.ok(restrictedFact.rows[0].packets >= 1);
    assert.equal(restrictedFact.rows[0].exposures, 3);

    // secret/private_letter：目标节点 Exposure 闭环（canon_origin +
    // harbor_tavern；rumor 渠道节点不出现）。
    const secretExposures = await ownerPool.query(
      `SELECT node_key, channel FROM propagation_exposures
       WHERE campaign_id = 'campaign_t11h_secret' ORDER BY node_key`,
    );
    assert.deepEqual(
      secretExposures.rows.map((row) => [row.node_key, row.channel]),
      [
        ["canon_origin", "private_letter"],
        ["harbor_tavern", "private_letter"],
      ],
    );

    // secret/market_rumor：永久 failed、零 Packet/Exposure 产物。
    const badState = states.get("job_t11h_bad");
    assert.equal(badState?.status, "failed");
    assert.match(
      badState?.lastError ?? "",
      /non-private-letter channel/,
    );
    const badFact = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM information_packets WHERE campaign_id = 'campaign_t11h_bad') AS packets,
         (SELECT count(*)::int FROM propagation_exposures WHERE campaign_id = 'campaign_t11h_bad') AS exposures`,
    );
    assert.equal(badFact.rows[0].packets, 0, "永久失败不得产生 Packet");
    assert.equal(badFact.rows[0].exposures, 0, "永久失败不得产生 Exposure");

    // SIGTERM 干净退出。
    worker.kill("SIGTERM");
    const exited = await Promise.race([
      childExitPromise,
      sleep(10_000).then(() => null),
    ]);
    if (exited === null) {
      worker.kill("SIGKILL");
      await Promise.race([childExitPromise, sleep(5_000)]);
      throw new Error("worker ignored SIGTERM");
    }
    const [exitCode, exitSignal] = exited;
    assert.equal(exitCode, 0, `worker must exit 0 on SIGTERM, signal=${exitSignal}`);
    assert.equal(exitSignal, null);
    for (const line of stdoutText.split("\n")) {
      if (line.startsWith("[propagation-worker]")) t.diagnostic(line);
    }
  },
);
