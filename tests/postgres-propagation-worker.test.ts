/**
 * 批次 T11-B——独立传播 Worker 与队列作用域（规范 §五）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0025 全链）：
 * claimNext 返回 job 真实 world/worldline（多世界/多世界线不串作用域）；
 * completeRun 幂等重放（崩溃重跑 Exposure 不重复）；advisory lock 单例；
 * 永久错误留 failed、临时错误有限重排；stale 恢复。
 * 零开发库污染。
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
import {
  createPropagationWorker,
  type PropagationJobInput,
} from "../modules/propagation/worker.ts";
import {
  createPropagationWorkerRuntime,
  isTransientPropagationError,
  PropagationWorkerLockError,
} from "../modules/application/propagation-worker-runtime.ts";
import { PropagationTopologyError } from "../database/postgres/propagation-topology.ts";

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
      { key: "market_square", clearance: "public" },
    ],
    routes: [
      { from: "canon_origin", to: "harbor_tavern", channel: "official_bulletin", distance: 1 },
      { from: "harbor_tavern", to: "market_square", channel: "market_rumor", distance: 1 },
    ],
    topologyVersion: "pt_worker_test",
  };
}

test(
  "T11-B: worker claims with real scope, replays idempotently and stays single-instance",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11bwk_${randomUUID().replaceAll("-", "")}`;
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

    t.after(async () => {
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

    const queue = createPostgresPropagationJobQueue(ownerPool);
    const worker = createPropagationWorker({ queue });

    // 第二世界/世界线（同 workspace）：scope 隔离测试素材。
    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id)
       VALUES ($1, 'world_other', '异世界', 'truce_calendar')`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label)
       VALUES ($1, 'world_other', 'worldline_other', '异世界线')`,
      [SCOPE.workspaceId],
    );
    const otherScope = {
      workspaceId: SCOPE.workspaceId,
      worldId: "world_other",
      worldlineId: "worldline_other",
    };

    const seedCampaign = async (
      scope: { workspaceId: string; worldId: string; worldlineId: string },
      campaignId: string,
    ) => {
      await ownerPool.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, effective_tick,
           security_class, algorithm_version
         ) VALUES ($1, $2, $3, $4, 10, 'public', 'realm-propagate-v1')`,
        [scope.workspaceId, scope.worldId, scope.worldlineId, campaignId],
      );
    };

    // 作用域隔离：两个世界的 job 先后领取，返回各自真实 scope，Exposure
    // 落在各自 worldline 下，不串。
    await seedCampaign(SCOPE, "camp_home");
    await seedCampaign(otherScope, "camp_other");
    await queue.enqueue(SCOPE, {
      id: "job-home",
      campaignId: "camp_home",
      input: jobInput("camp_home", "packet_home"),
    });
    await queue.enqueue(otherScope, {
      id: "job-other",
      campaignId: "camp_other",
      input: jobInput("camp_other", "packet_other"),
    });
    const claimed: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const result = await queue.claimNext(SCOPE.workspaceId);
      assert.ok(result, "应能领取到 job");
      claimed.push(`${result!.job.id}@${result!.scope.worldId}/${result!.scope.worldlineId}`);
    }
    assert.deepEqual(claimed.sort(), [
      "job-home@world_ember_coast/worldline_origin",
      "job-other@world_other/worldline_other",
    ]);
    // 恢复这两个 running 任务并经 worker 完成；Exposure 按各自作用域落库。
    //（v37：recoverStale 只回收 started_at 超 5 分钟的 running——回拨模拟崩溃遗留。）
    await ownerPool.query(
      `UPDATE propagation_jobs
       SET started_at = CURRENT_TIMESTAMP - interval '10 minutes'
       WHERE workspace_id = $1 AND status = 'running'`,
      [SCOPE.workspaceId],
    );
    assert.equal(await worker.recoverStale(SCOPE.workspaceId), 2);
    assert.equal(await worker.runOnce(SCOPE.workspaceId), "done");
    assert.equal(await worker.runOnce(SCOPE.workspaceId), "done");
    const homeExposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures
       WHERE world_id = 'world_ember_coast' AND worldline_id = 'worldline_origin'`,
    );
    const otherExposures = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_exposures
       WHERE world_id = 'world_other' AND worldline_id = 'worldline_other'`,
    );
    assert.equal(homeExposures.rows[0].c, 3);
    assert.equal(otherExposures.rows[0].c, 3);

    // 崩溃重放幂等（v37 lease 契约）：重放必须走真实 claim 路径——
    // failed→retry→claim（新 token）→completeRun；同一批内容第二次执行零新增。
    const jobRow = await ownerPool.query(
      `SELECT input FROM propagation_jobs WHERE id = 'job-home'`,
    );
    const runInput = jobRow.rows[0].input as PropagationJobInput;
    const replayRun = {
      campaign: runInput.campaign,
      packets: [
        {
          ...runInput.roots[0]!.packet,
          id: "packet_replay",
          contentHash: "hash_packet_replay",
        },
      ],
      exposures: [
        {
          nodeKey: "canon_origin",
          packetId: "packet_replay",
          channel: "official_bulletin" as const,
          arrivalTick: 10,
          fidelity: 1,
        },
      ],
      algorithmVersion: "realm-propagate-v1",
    };
    const countsBefore = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM information_packets) AS packets,
         (SELECT count(*)::int FROM propagation_exposures) AS exposures`,
    );
    const forceRefailed = async () => {
      await ownerPool.query(
        `UPDATE propagation_jobs SET status = 'failed'
         WHERE workspace_id = $1 AND id = 'job-home'`,
        [SCOPE.workspaceId],
      );
      await queue.retry(SCOPE, "job-home");
      const claimed = await queue.claimNext(SCOPE.workspaceId);
      assert.ok(claimed, "重放路径必须能重新领取 job");
      return claimed!;
    };
    const firstReplay = await forceRefailed();
    await queue.completeRun(firstReplay.scope, firstReplay.lease, replayRun);
    const countsAfterFirst = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM information_packets) AS packets,
         (SELECT count(*)::int FROM propagation_exposures) AS exposures`,
    );
    assert.equal(countsAfterFirst.rows[0].packets - countsBefore.rows[0].packets, 1);
    assert.equal(countsAfterFirst.rows[0].exposures - countsBefore.rows[0].exposures, 1);
    const secondReplay = await forceRefailed();
    await queue.completeRun(secondReplay.scope, secondReplay.lease, replayRun);
    const countsAfterSecond = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM information_packets) AS packets,
         (SELECT count(*)::int FROM propagation_exposures) AS exposures`,
    );
    assert.equal(
      countsAfterSecond.rows[0].packets,
      countsAfterFirst.rows[0].packets,
      "重放不得重复插入 Packet",
    );
    assert.equal(
      countsAfterSecond.rows[0].exposures,
      countsAfterFirst.rows[0].exposures,
      "重放不得重复插入 Exposure",
    );

    // 永久错误留 failed 不自动重排；临时错误分类正确。
    assert.equal(
      isTransientPropagationError(
        new PropagationTopologyError("TOPOLOGY_ORIGIN_MISSING", "no origin"),
      ),
      false,
    );
    assert.equal(
      isTransientPropagationError(
        Object.assign(new Error("Connection terminated unexpectedly"), {}),
      ),
      true,
    );
    assert.equal(
      isTransientPropagationError(
        Object.assign(new Error("deadlock"), { code: "40P01" }),
      ),
      false,
    );
    assert.equal(
      isTransientPropagationError(
        Object.assign(new Error("connection issue"), { code: "08006" }),
      ),
      true,
    );

    // advisory lock 单例：第一个 runtime 持锁，第二个 start 必须失败；
    // stop 后第三个可以获取。
    const runtimeA = createPropagationWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [SCOPE.workspaceId],
      idleMinMs: 50,
      idleMaxMs: 100,
      logger: () => {},
    });
    const started = (async () => {
      try {
        await runtimeA.start();
        return null;
      } catch (error) {
        return error;
      }
    })();
    // 等 lock 获取完成（健康检查+恢复即进入主循环）。
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runtimeB = createPropagationWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [SCOPE.workspaceId],
      logger: () => {},
    });
    await assert.rejects(runtimeB.start(), PropagationWorkerLockError);
    await runtimeA.stop();
    const lockError = await started;
    assert.equal(lockError, null, "runtimeA 应正常运行至 stop");

    const runtimeC = createPropagationWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [SCOPE.workspaceId],
      idleMinMs: 50,
      idleMaxMs: 100,
      logger: () => {},
    });
    const startedC = (async () => {
      try {
        await runtimeC.start();
        return null;
      } catch (error) {
        return error;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runtimeC.stop();
    assert.equal(await startedC, null, "锁释放后新实例应能启动");
  },
);
