import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresPropagationJobQueue,
  createPostgresPropagationRepository,
  createPostgresWorldlineMergeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createWorldlineMergeService } from "../modules/worldline/merge.ts";
import { createPropagationWorker } from "../modules/propagation/worker.ts";
import type { InformationPacket } from "../modules/propagation/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const TICK = 17_121_219;

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_m5b2_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  await owner.connect();
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

  t.after(async () => {
    await ownerPool.end();
    await owner.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of [
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
    // 合并物化读取的列/表：scene 快照列、records.world_version、Goal runtime、
    // 初夜/自演运行态探测表（merge unsupported 探针 fail-closed 读取）。
    "0019_record_first_nights.sql",
    "0020_record_self_play_sessions.sql",
    "0029_record_scene_tension.sql",
    "0039_scene_weather_snapshot.sql",
    "0040_scene_display_time_snapshot.sql",
    "0054_world_version_identity.sql",
    "0055_goal_runtime.sql",
    "0057_realmworld_record_binding.sql",
  ]) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await owner.query(sql);
  }
  await seedPostgresDemo(ownerPool);
  return ownerPool;
}

/** 在分支世界线上搭建 story/record/scene/policy 并插入一个事件。 */
async function insertBranchEvent(
  pool: pg.Pool,
  input: { eventId: string; tick: number; ordinal: number; speaker: string; content: string },
) {
  await pool.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal)
     VALUES ('ws_demo', 'world_ember_coast', 'worldline_branch_m5', '分支', 'active', 'worldline_origin', $1, 0, $1, 2)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [TICK],
  );
  await pool.query(
    `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
     VALUES ('ws_demo', 'world_ember_coast', 'worldline_branch_m5', 'story_branch_m5', '分支故事', 'active', '分支', $1, 0)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [TICK],
  );
  await pool.query(
    `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal)
     VALUES ('ws_demo', 'world_ember_coast', 'worldline_branch_m5', 'story_branch_m5', 'record_branch_m5', '分支记录', 'active', $1, 0)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [TICK],
  );
  await pool.query(
    `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, location, objective, start_tick, start_ordinal)
     VALUES ('ws_demo', 'world_ember_coast', 'worldline_branch_m5', 'record_branch_m5', 'scene_branch_m5', '分支场景', 'active', '灰鲸港', '分支', $1, 0)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [TICK],
  );
  await pool.query(
    `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
     VALUES ('ws_demo', 'world_ember_coast', 'worldline_branch_m5', 'record_branch_m5', 'policy_branch_m5', 'public', 1, 'public')
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [],
  );
  await pool.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
     ) VALUES (
       'ws_demo', 'world_ember_coast', 'worldline_branch_m5', 'record_branch_m5',
       'scene_branch_m5', $1, 1, 1, 0, 'narration.committed',
       NULL, $2, $3, $4::jsonb, 'policy_branch_m5', $5, $6,
       'truce_calendar', '测试'
     )`,
    [
      input.eventId,
      input.speaker,
      input.content,
      JSON.stringify({ text: input.content }),
      input.tick,
      input.ordinal,
    ],
  );
}

test(
  "worldline merge is idempotent, audited and never rewrites sources",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(ownerPool),
      idFactory: (() => {
        let sequence = 0;
        return () => `m5b2-${++sequence}`;
      })(),
    });

    // 分支世界线：与演示开场事件同游标（同载荷 → none 去重）+ 一个不同发言者同游标事件（bridgeable）。
    await insertBranchEvent(ownerPool, {
      eventId: "event_branch_dup",
      tick: TICK,
      ordinal: 1,
      speaker: "旁白",
      content: "雾沿着石阶爬上防波堤。信使放下蜡封完好的黑色信函，远处灯塔的光随第三声钟鸣熄灭。",
    });
    // 注意：同载荷去重依赖 payload 一致；这里 payload 与开场不同，因此是同游标不同发言者？不——同发言者不同载荷即 hard。
    // 为保证用例确定性，这个事件采用不同发言者与不同游标组合：
    // （上一行插入的事件刻意与 opening 同 tick/ordinal 但不同 payload → 同发言者“旁白” → hard）
    // 先验证 dry-run 报告 hard 并拒绝：
    const dryRun = await service.merge({
      workspaceId: "ws_demo",
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_branch_m5",
      idempotencyKey: "merge-dry-1",
      operator: "tester",
      dryRun: true,
    });
    assert.equal(dryRun.status, "preview");
    assert.equal(dryRun.report.mergeable, false);
    assert.ok(dryRun.report.conflicts.some((conflict) => conflict.severity === "hard"));
    // dry-run 不写审计行。
    const dryRows = await ownerPool.query(`SELECT count(*)::int AS c FROM worldline_merges`);
    assert.equal(dryRows.rows[0].c, 0);

    // 正式合并：拒绝并保留审计与冲突清单。
    const rejected = await service.merge({
      workspaceId: "ws_demo",
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_branch_m5",
      idempotencyKey: "merge-real-1",
      operator: "tester",
    });
    assert.equal(rejected.status, "rejected");
    const auditRows = await ownerPool.query(
      `SELECT status, operator FROM worldline_merges WHERE idempotency_key = 'merge-real-1'`,
    );
    assert.equal(auditRows.rows.length, 1);
    assert.equal(auditRows.rows[0].status, "rejected");
    assert.equal(auditRows.rows[0].operator, "tester");
    // 幂等重放返回同一合并行。
    const replay = await service.merge({
      workspaceId: "ws_demo",
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_branch_m5",
      idempotencyKey: "merge-real-1",
      operator: "tester",
    });
    assert.equal(replay.status, "rejected");
    assert.equal(replay.mergeId, rejected.mergeId);
    // 审计行不可变。
    await assert.rejects(
      ownerPool.query(`DELETE FROM worldline_merges WHERE idempotency_key = 'merge-real-1'`),
    );
  },
);

test(
  "worldline merge resolves bridgeable collisions into a continuous manifest",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(ownerPool),
      idFactory: (() => {
        let sequence = 0;
        return () => `m5b2-ok-${++sequence}`;
      })(),
    });
    // 与 opening 同游标但不同发言者 → bridgeable 顺移。
    await insertBranchEvent(ownerPool, {
      eventId: "event_branch_bridge",
      tick: TICK,
      ordinal: 1,
      speaker: "塞娜",
      content: "塞娜在分支里先一步抵达。",
    });
    const merged = await service.merge({
      workspaceId: "ws_demo",
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_branch_m5",
      idempotencyKey: "merge-ok-1",
      operator: "tester",
    });
    assert.equal(merged.status, "merged");
    if (merged.status !== "merged") return;
    // manifest ordinal 连续且唯一。
    assert.deepEqual(
      merged.report.manifest.map((entry) => entry.ordinal),
      [1, 2],
    );
    assert.equal(
      merged.report.manifest.find(
        (entry) => entry.eventId === "event_branch_bridge",
      )?.resolution,
      "rescheduled",
    );
    // 新 merged worldline 与 merged record 已创建；来源行数不变。
    const worldline = await ownerPool.query(
      `SELECT label, status, head_tick::text, head_ordinal::text FROM worldlines WHERE id = $1`,
      [merged.mergedWorldlineId],
    );
    assert.equal(worldline.rows.length, 1);
    assert.equal(worldline.rows[0].status, "active");
    // 世界线 head 与 manifest 末位目标游标一致（bridgeable 顺移后）。
    assert.equal(Number(worldline.rows[0].head_tick), TICK);
    assert.equal(Number(worldline.rows[0].head_ordinal), 2);
    const mergedRecords = await ownerPool.query(
      `SELECT id, status, timeline_kind, linked_record_id FROM records WHERE worldline_id = $1`,
      [merged.mergedWorldlineId],
    );
    assert.ok(mergedRecords.rows.length >= 1);
    assert.ok(mergedRecords.rows.every((row) => row.timeline_kind === "merged"));
    // playable：目标 Record 全部 active（不再是 archived 占位）。
    assert.ok(mergedRecords.rows.every((row) => row.status === "active"));
    // 事件实际复制进目标 scope：目标事件 ID 不复用源 ID，游标与 manifest 一致。
    const targetEvents = await ownerPool.query(
      `SELECT id, record_id, world_tick::text, world_ordinal::text,
              scene_id, visibility_policy_id
       FROM events WHERE worldline_id = $1
       ORDER BY world_tick, world_ordinal`,
      [merged.mergedWorldlineId],
    );
    assert.equal(targetEvents.rows.length, merged.report.manifest.length);
    for (const entry of merged.report.manifest) {
      const copied = targetEvents.rows.find(
        (row) =>
          Number(row.world_tick) === entry.tick
          && Number(row.world_ordinal) === entry.worldOrdinal,
      );
      assert.ok(copied, "manifest entry must map to a copied target event");
      assert.equal(copied.id, entry.targetEventId);
      assert.notEqual(copied.id, entry.eventId);
      // 目标外键指向目标 scope（scene/policy 与目标 Record 同属合并世界线）。
      const scene = await ownerPool.query(
        `SELECT worldline_id, record_id FROM scenes WHERE workspace_id = 'ws_demo' AND id = $1`,
        [copied.scene_id],
      );
      assert.equal(scene.rows[0]?.worldline_id, merged.mergedWorldlineId);
      assert.equal(scene.rows[0]?.record_id, copied.record_id);
    }
    // record_heads 与 manifest 一致：每条目标 Record 有可继续提交的 head。
    const heads = await ownerPool.query(
      `SELECT record_id, record_version::text, next_record_ordinal::text,
              last_event_id, last_world_tick::text, last_world_ordinal::text
       FROM record_heads WHERE worldline_id = $1`,
      [merged.mergedWorldlineId],
    );
    assert.equal(heads.rows.length, mergedRecords.rows.length);
    for (const head of heads.rows) {
      const recordEvents = targetEvents.rows.filter(
        (row) => row.record_id === head.record_id,
      );
      if (recordEvents.length === 0) {
        assert.equal(Number(head.record_version), 0);
        assert.equal(Number(head.next_record_ordinal), 0);
        continue;
      }
      const last = recordEvents.at(-1)!;
      assert.equal(head.last_event_id, last.id);
      assert.equal(Number(head.last_world_tick), Number(last.world_tick));
      assert.equal(Number(head.last_world_ordinal), Number(last.world_ordinal));
      assert.equal(Number(head.next_record_ordinal), recordEvents.length + 1);
    }
    // 拓扑语义保留：源 Record 的参与者/场景/策略/技能/资产复制进目标 scope。
    const topologyCounts = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM participants WHERE worldline_id = $1) AS participants,
         (SELECT count(*)::int FROM scenes WHERE worldline_id = $1) AS scenes,
         (SELECT count(*)::int FROM visibility_policies WHERE worldline_id = $1) AS policies,
         (SELECT count(*)::int FROM character_instances WHERE worldline_id = $1) AS instances,
         (SELECT count(*)::int FROM character_continuities WHERE worldline_id = $1) AS continuities,
         (SELECT count(*)::int FROM character_skills WHERE worldline_id = $1) AS skills,
         (SELECT count(*)::int FROM character_assets WHERE worldline_id = $1) AS assets`,
      [merged.mergedWorldlineId],
    );
    assert.ok(topologyCounts.rows[0].participants >= 3, "origin cast copied");
    assert.ok(topologyCounts.rows[0].scenes >= 2, "both scenes copied");
    assert.ok(topologyCounts.rows[0].policies >= 2, "both public policies copied");
    assert.ok(topologyCounts.rows[0].instances >= 3, "origin instances copied");
    // 双侧同 continuity_key（player/scout/scholar）各折成一行。
    assert.ok(topologyCounts.rows[0].continuities >= 3);
    assert.ok(topologyCounts.rows[0].skills >= 3, "skill grants copied");
    assert.ok(topologyCounts.rows[0].assets >= 1, "asset grants copied");
    const sourceEvents = await ownerPool.query(
      `SELECT count(*)::int AS c FROM events WHERE worldline_id IN ('worldline_origin', 'worldline_branch_m5')`,
    );
    assert.equal(sourceEvents.rows[0].c, 2);
  },
);

test(
  "propagation worker runs the queue with recovery and lazy materialization on PostgreSQL",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const scope = {
      workspaceId: "ws_demo",
      worldId: "world_ember_coast",
      worldlineId: "worldline_origin",
    };
    const runs = createPostgresPropagationRepository(ownerPool);
    const queue = createPostgresPropagationJobQueue(ownerPool);

    const root: InformationPacket = {
      id: "packet_root_pg",
      campaignId: "camp_pg",
      parentPacketId: null,
      channel: "official_bulletin",
      claimIds: ["c1", "c2", "c3"],
      framing: "official",
      omittedClaimIds: [],
      semanticFidelityToParent: 1,
      contentHash: "root",
    };
    // Campaign 行先落库（作业外键）。
    await runs.saveRun(scope, {
      campaign: {
        id: "camp_pg",
        securityClass: "public",
        effectiveTick: 10,
        salience: 0.8,
        complexity: 0.3,
      },
      packets: [],
      exposures: [],
      algorithmVersion: "realm-propagate-v1",
    });

    const resolvedNodes = [
      { key: "herald", clearance: "public" as const },
      { key: "market", clearance: "public" as const },
      { key: "tavern", clearance: "public" as const },
    ];
    const jobInput = {
      campaign: {
        id: "camp_pg",
        securityClass: "public" as const,
        effectiveTick: 10,
        salience: 0.8,
        complexity: 0.3,
      },
      roots: [{ nodeKey: "herald", packet: root }],
      // 批次 T11-B：immutable 拓扑快照进 job input。
      nodes: resolvedNodes,
      routes: [
        { from: "herald", to: "market", channel: "official_bulletin" as const, distance: 1 },
        { from: "market", to: "tavern", channel: "market_rumor" as const, distance: 1 },
      ],
      topologyVersion: "pt_test_pg",
    };
    // 批次 T11-B：Worker 只持队列——拓扑从快照取，completeRun 单事务。
    const worker = createPropagationWorker({ queue });

    await queue.enqueue(scope, {
      id: "job-pg-1",
      campaignId: "camp_pg",
      input: jobInput,
    });
    assert.equal(await worker.runOnce(scope.workspaceId), "done");
    const stored = await runs.listExposures(scope, "camp_pg");
    assert.equal(stored.length, 3);
    // 懒物化语义：Exposure 恰覆盖可达节点（herald/market/tavern）。
    assert.deepEqual(
      [...new Set(stored.map((exposure) => exposure.nodeKey))].sort(),
      ["herald", "market", "tavern"],
    );
    const stats = await worker.stats(scope.workspaceId);
    assert.equal(stats.done, 1);

    // 恢复：遗留 running → pending → 再跑完成。
    await queue.enqueue(scope, {
      id: "job-pg-2",
      campaignId: "camp_pg",
      input: {
        ...jobInput,
        routes: [
          { from: "herald", to: "market", channel: "official_bulletin" as const, distance: 1 },
        ],
      },
    });
    await ownerPool.query(
      // v37：recoverStale 仅回收 started_at 超 5 分钟的 running job——回拨模拟崩溃遗留。
      `UPDATE propagation_jobs
       SET status = 'running', started_at = CURRENT_TIMESTAMP - interval '10 minutes'
       WHERE id = 'job-pg-2'`,
    );
    assert.equal(await worker.recoverStale(scope.workspaceId), 1);
    assert.equal(await worker.runOnce(scope.workspaceId), "done");
    const statsAfter = await worker.stats(scope.workspaceId);
    assert.equal(statsAfter.done, 2);
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_m5b2_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
