/**
 * Worldline merge 物化 runtime-save v2 三类运行态（本切片）：
 * action receipts / character effects / observations 随合并复制进目标
 * Record——作用域引用（source event / character instance / source
 * receipt）重映射到目标 ID，receipt 载荷与游标逐字节保留，effect
 * definition 在目标 World 内按 effect_key 重解析；源世界线事件与
 * 运行态保持 immutable。
 *
 * fail-closed 面：memory/outbox/first-night/self-play/Goal 运行态仍
 * 触发 RECONCILE_UNSUPPORTED 且零目标拓扑残留；跨 Record 引用、
 * 悬空（被 none 去重）observation 引用在规划期拒绝；目标 World 缺失
 * effect definition 在写入前拒绝——三种场景整体回滚零残留。
 *
 * 真实临时 PG 库（t.after 拆库，不污染开发库）；合并写路径走
 * realm_runtime 受限角色（生产路由同一角色），验证授权面闭合。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresWorldlineMergeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import {
  createWorldlineMergeService,
  WorldlineMergeUnsupportedError,
  type MergeAuditRow,
  type MergeTopologyPlan,
} from "../modules/worldline/merge.ts";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";
installTestSessionSecret();

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
  // 合并物化经 restricted 角色写 participants/instances/continuities/
  // record_heads（0023）与 scenes/visibility_policies 全行（0056）。
  "0023_library_runtime_grants.sql",
  // branch 命令创建可玩拓扑：scene 快照列（0029/0039/0040）与
  // records.timeline_kind='branch' 枚举（0044）。
  "0029_record_scene_tension.sql",
  "0039_scene_weather_snapshot.sql",
  "0040_scene_display_time_snapshot.sql",
  "0044_record_branch_timeline_kind.sql",
  "0053_membership_capability.sql",
  // Phase 1B：library list 读模型显式 SELECT worlds.world_version。
  "0054_world_version_identity.sql",
  // Phase 3：createRecordBranchInTransaction 物化 goal_instances。
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  // Phase 4D：records.world_version（branch/genesis 写路径显式携带）。
  "0057_realmworld_record_binding.sql",
  // Slice 3 统一 durable job 队列：merge 对在途（pending/claimed）行
  // fail-closed 探针所依赖的表。
  "0058_durable_job_queue.sql",
];

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

/** 一次性库脚手架：完整迁移链 + demo seed + 会话密钥 + 受限角色池。 */
async function createMergeRuntimeDatabase(
  t: test.TestContext,
  label: string,
): Promise<{ ownerPool: pg.Pool; restrictedPool: pg.Pool }> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_mrt_${label}_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  // 合并写路径经 realm_runtime 受限角色（与生产路由同一角色）。
  const restrictedPool = new pg.Pool({
    connectionString: runtimeUrl.href,
    max: 1,
  });
  restrictedPool.on("error", () => {});

  t.after(async () => {
    await restrictedPool.end();
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
  await seedCapabilitySessionKey(ownerPool, "ws_demo");
  return { ownerPool, restrictedPool };
}

/** 经 library 受限路径建世界 + 分支（demo principal 是 owner）。 */
async function createWorldWithBranch(ownerPool: pg.Pool, name: string) {
  const library = createPostgresLibraryService(ownerPool);
  const scope = {
    workspaceId: "ws_demo",
    sessionProof: sessionProofFor("principal_demo_player"),
    principalId: "principal_demo_player",
  };
  await library.create(scope, {
    kind: "world",
    name,
    era: "并流纪元",
    summary: "两条世界线在此汇合。",
  });
  const world = (await library.list(scope)).worlds.find(
    (item) => item.name === name,
  )!;
  const starterRecord = world.stories[0]?.records[0];
  assert.ok(starterRecord, "world should have a starter record to branch from");
  await library.create(scope, {
    kind: "branch",
    worldId: world.id,
    label: "岔流",
    sourceRecordId: starterRecord.id,
  });
  const worldlines = (await library.list(scope)).worlds.find(
    (item) => item.id === world.id,
  )!.worldlines;
  assert.equal(worldlines.length, 2);
  const [origin, branch] = worldlines;
  const branchRecord = await ownerPool.query(
    `SELECT id, world_version FROM records
     WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
    [branch!.id],
  );
  assert.equal(branchRecord.rows.length, 1);
  // 本切片 record_first_nights 仍 fail-closed：世界创建为 starter Record
  // 写入 pending 状态行；运行态合并用例一律先清除，避免遮蔽目标行为。
  await ownerPool.query(
    `DELETE FROM record_first_nights
     WHERE workspace_id = 'ws_demo' AND world_id = $1`,
    [world.id],
  );
  return {
    world,
    origin: origin!,
    branch: branch!,
    originRecordId: starterRecord.id,
    branchRecordId: branchRecord.rows[0].id as string,
    branchWorldVersion: branchRecord.rows[0].world_version as string,
  };
}

/** 记录上补一条 committed 事件夹具（与真实提交同列形状）。 */
async function insertCommittedEvent(
  ownerPool: pg.Pool,
  input: {
    worldId: string;
    worldlineId: string;
    recordId: string;
    eventId: string;
    tick: number;
    ordinal: number;
    speaker: string;
    text: string;
  },
) {
  const scene = await ownerPool.query(
    `SELECT id FROM scenes
     WHERE workspace_id = 'ws_demo' AND record_id = $1
     ORDER BY start_tick DESC, start_ordinal DESC, id ASC LIMIT 1`,
    [input.recordId],
  );
  const policy = await ownerPool.query(
    `SELECT id FROM visibility_policies
     WHERE workspace_id = 'ws_demo' AND record_id = $1 AND policy_kind = 'public'
     ORDER BY policy_version ASC, id ASC LIMIT 1`,
    [input.recordId],
  );
  assert.ok(scene.rows[0] && policy.rows[0], "record must carry scene+policy");
  await ownerPool.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id,
       display_time, recorded_at
     ) VALUES (
       'ws_demo', $1, $2, $3, $4, $5, 1, 1, 0, 'narration.committed',
       NULL, $6, $7, $8::jsonb, $9, $10, $11, 'native_calendar', '',
       CURRENT_TIMESTAMP
     )`,
    [
      input.worldId,
      input.worldlineId,
      input.recordId,
      scene.rows[0].id,
      input.eventId,
      input.speaker,
      input.text,
      JSON.stringify({ text: input.text }),
      policy.rows[0].id,
      input.tick,
      input.ordinal,
    ],
  );
}

/** 记录的第一个 character instance（分支为可玩拓扑，必有一个）。 */
async function firstInstanceId(
  ownerPool: pg.Pool,
  recordId: string,
): Promise<string> {
  const rows = await ownerPool.query(
    `SELECT id FROM character_instances
     WHERE workspace_id = 'ws_demo' AND record_id = $1
     ORDER BY id ASC LIMIT 1`,
    [recordId],
  );
  assert.ok(rows.rows[0], "record must carry a character instance");
  return rows.rows[0].id as string;
}

/** 世界内合并目标拓扑残留计数（失败路径应恒为零）。 */
async function mergedTopologyResidue(ownerPool: pg.Pool, worldId: string) {
  const residue = await ownerPool.query(
    `SELECT
       (SELECT count(*)::int FROM worldlines
        WHERE workspace_id = 'ws_demo' AND world_id = $1
          AND id LIKE 'worldline\\_merge\\_%') AS worldlines,
       (SELECT count(*)::int FROM records
        WHERE workspace_id = 'ws_demo' AND world_id = $1
          AND timeline_kind = 'merged') AS records,
       (SELECT count(*)::int FROM worldline_merges
        WHERE workspace_id = 'ws_demo' AND world_id = $1
          AND status = 'merged') AS merged_audits`,
    [worldId],
  );
  return residue.rows[0] as {
    worldlines: number;
    records: number;
    merged_audits: number;
  };
}

const SKIP = { skip: !adminConnectionString || !runtimeConnectionString };

test(
  "merge materializes receipts/effects/observations remapped and byte-identical",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createMergeRuntimeDatabase(
      t,
      "happy",
    );
    const { world, origin, branch, branchRecordId } =
      await createWorldWithBranch(ownerPool, "运行态合并试验场");
    const instanceId = await firstInstanceId(ownerPool, branchRecordId);

    // World 级规则数据：stance effect definition（合并双侧同 World，
    // 目标写入按 effect_key 重解析到同一行）。
    await ownerPool.query(
      `INSERT INTO effect_definitions (
         workspace_id, world_id, id, effect_key, title, rule_pack_key,
         effect_kind
       ) VALUES (
         'ws_demo', $1, 'effect_def_stance_guard', 'stance_guard', '守势',
         'native_d20', 'stance'
       )`,
      [world.id],
    );
    // 分支 Record 的源事件（receipt/observation 的 source event）。
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: branchRecordId,
      eventId: "event_branch_action",
      tick: 1,
      ordinal: 1,
      speaker: "塞娜",
      text: "塞娜掷出匕首，药剂的苦味在舌尖炸开。",
    });
    // action receipt：d20 掷骰 + 消耗品 cost，载荷是已物化事实。
    const receiptPayload = {
      kind: "action.receipt",
      dice: { system: "d20", rolls: [17], modifier: 3, total: 20 },
      costs: [{ resourceId: "asset_def_mist_potion", amount: 1 }],
      effects: [
        { effectId: "effect_branch_stance", operation: "apply", targetId: instanceId },
      ],
      narrative: "d20=17+3，命中；雾药剂 -1。",
    };
    await ownerPool.query(
      `INSERT INTO action_receipts (
         workspace_id, world_id, worldline_id, record_id,
         actor_character_instance_id, source_event_id, id, transaction_id,
         call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
       ) VALUES (
         'ws_demo', $1, $2, $3, $4, 'event_branch_action',
         'receipt_branch_d20', 'txn_branch_d20_1', 'fp_branch_d20_1',
         $5::jsonb, 1, 1, '2026-10-09T08:00:00.000Z'::timestamptz
       )`,
      [
        world.id,
        branch.id,
        branchRecordId,
        instanceId,
        JSON.stringify(receiptPayload),
      ],
    );
    // stance effect（引用同 Record 的 receipt 与 world 级 definition）。
    await ownerPool.query(
      `INSERT INTO character_effects (
         workspace_id, world_id, worldline_id, record_id,
         character_instance_id, effect_definition_id, source_action_receipt_id,
         id, status, applied_tick, applied_ordinal, revision, metadata
       ) VALUES (
         'ws_demo', $1, $2, $3, $4, 'effect_def_stance_guard',
         'receipt_branch_d20', 'effect_branch_stance', 'active', 1, 1, 0,
         $5::jsonb
       )`,
      [
        world.id,
        branch.id,
        branchRecordId,
        instanceId,
        JSON.stringify({ note: "守势持续至下一拍。" }),
      ],
    );
    // observer observation（引用同 Record 的源事件）。
    await ownerPool.query(
      `INSERT INTO observations (
         workspace_id, world_id, worldline_id, record_id,
         observer_character_instance_id, source_event_id, id, dedupe_key,
         observation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal, learned_at, metadata
       ) VALUES (
         'ws_demo', $1, $2, $3, $4, 'event_branch_action',
         'obs_branch_witness', 'witness_branch_d20', 'direct',
         '塞娜看见守势随药剂的苦味成形。', 0.95, 1, 1, 1, 1,
         '2026-10-09T08:00:01.000Z'::timestamptz, $5::jsonb
       )`,
      [
        world.id,
        branch.id,
        branchRecordId,
        instanceId,
        JSON.stringify({ channel: "eyes" }),
      ],
    );
    // 经 realm_runtime 受限角色执行合并（生产路由同一角色）。
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    const result = await service.merge({
      workspaceId: "ws_demo",
      worldId: world.id,
      sourceA: origin.id,
      sourceB: branch.id,
      idempotencyKey: "runtime-merge-happy-1",
      operator: "tester",
    });
    assert.equal(result.status, "merged");
    if (result.status !== "merged") return;
    const targetEventId = result.report.manifest.find(
      (entry) => entry.eventId === "event_branch_action",
    )?.targetEventId;
    assert.ok(targetEventId, "branch event must be materialized");

    // 目标 Record（branch 源 Record 的合并副本）。
    const targetRecord = await ownerPool.query(
      `SELECT id FROM records
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND linked_record_id = $2`,
      [result.mergedWorldlineId, branchRecordId],
    );
    assert.equal(targetRecord.rows.length, 1);
    const targetRecordId = targetRecord.rows[0].id as string;

    // 目标 receipt：新 ID、目标 scope、引用重映射、载荷逐字节一致。
    const targetReceipts = await ownerPool.query(
      `SELECT id, record_id, actor_character_instance_id, source_event_id,
              transaction_id, call_fingerprint, receipt,
              world_tick::text, world_ordinal::text, recorded_at::text
       FROM action_receipts
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(targetReceipts.rows.length, 1);
    const targetReceipt = targetReceipts.rows[0];
    assert.notEqual(targetReceipt.id, "receipt_branch_d20");
    assert.equal(targetReceipt.record_id, targetRecordId);
    assert.equal(targetReceipt.source_event_id, targetEventId);
    assert.notEqual(targetReceipt.actor_character_instance_id, instanceId);
    assert.equal(targetReceipt.transaction_id, "txn_branch_d20_1");
    assert.equal(targetReceipt.call_fingerprint, "fp_branch_d20_1");
    assert.deepEqual(targetReceipt.receipt, receiptPayload);
    assert.equal(Number(targetReceipt.world_tick), 1);
    assert.equal(Number(targetReceipt.world_ordinal), 1);
    // jsonb 级逐字节一致（SQL 等值 + 键序无关深比较双保险）。
    const receiptIdentical = await ownerPool.query(
      `SELECT (
         (SELECT receipt FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_branch_d20')
         =
         (SELECT receipt FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = $1)
       ) AS identical`,
      [targetReceipt.id],
    );
    assert.equal(receiptIdentical.rows[0].identical, true);
    // 目标 actor instance 属于目标 Record（重映射不串 scope）。
    const targetInstance = await ownerPool.query(
      `SELECT record_id, worldline_id FROM character_instances
       WHERE workspace_id = 'ws_demo' AND id = $1`,
      [targetReceipt.actor_character_instance_id],
    );
    assert.equal(targetInstance.rows[0]?.record_id, targetRecordId);
    assert.equal(targetInstance.rows[0]?.worldline_id, result.mergedWorldlineId);

    // 目标 effect：definition 按 effect_key 解析到同一 World 级行；
    // receipt/instance 引用重映射。
    const targetEffects = await ownerPool.query(
      `SELECT id, record_id, character_instance_id, effect_definition_id,
              source_action_receipt_id, status,
              applied_tick::text, applied_ordinal::text, metadata
       FROM character_effects
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(targetEffects.rows.length, 1);
    const targetEffect = targetEffects.rows[0];
    assert.notEqual(targetEffect.id, "effect_branch_stance");
    assert.equal(targetEffect.record_id, targetRecordId);
    assert.equal(targetEffect.effect_definition_id, "effect_def_stance_guard");
    assert.equal(targetEffect.source_action_receipt_id, targetReceipt.id);
    assert.equal(
      targetEffect.character_instance_id,
      targetReceipt.actor_character_instance_id,
    );
    assert.equal(targetEffect.status, "active");
    assert.equal(Number(targetEffect.applied_tick), 1);
    assert.equal(Number(targetEffect.applied_ordinal), 1);
    assert.deepEqual(targetEffect.metadata, { note: "守势持续至下一拍。" });

    // 目标 observation：observer/源事件重映射，内容与游标原样。
    const targetObservations = await ownerPool.query(
      `SELECT id, record_id, observer_character_instance_id, source_event_id,
              dedupe_key, observation_kind, content, fidelity::text,
              occurred_tick::text, occurred_ordinal::text,
              available_from_tick::text, available_from_ordinal::text,
              learned_at::text, metadata
       FROM observations
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(targetObservations.rows.length, 1);
    const targetObservation = targetObservations.rows[0];
    assert.notEqual(targetObservation.id, "obs_branch_witness");
    assert.equal(targetObservation.record_id, targetRecordId);
    assert.equal(
      targetObservation.observer_character_instance_id,
      targetReceipt.actor_character_instance_id,
    );
    assert.equal(targetObservation.source_event_id, targetEventId);
    assert.equal(targetObservation.dedupe_key, "witness_branch_d20");
    assert.equal(targetObservation.observation_kind, "direct");
    assert.equal(
      targetObservation.content,
      "塞娜看见守势随药剂的苦味成形。",
    );
    assert.equal(Number(targetObservation.fidelity), 0.95);
    assert.equal(Number(targetObservation.occurred_tick), 1);
    assert.equal(Number(targetObservation.occurred_ordinal), 1);
    assert.deepEqual(targetObservation.metadata, { channel: "eyes" });
    // learned_at / recorded_at 原样保留（源侧历史坐标）。
    const sourceTimestamps = await ownerPool.query(
      `SELECT
         (SELECT recorded_at::text FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_branch_d20')
           AS source_recorded,
         (SELECT learned_at::text FROM observations
          WHERE workspace_id = 'ws_demo' AND id = 'obs_branch_witness')
           AS source_learned`,
    );
    assert.equal(
      targetReceipt.recorded_at,
      sourceTimestamps.rows[0].source_recorded,
    );
    assert.equal(
      targetObservation.learned_at,
      sourceTimestamps.rows[0].source_learned,
    );

    // 源世界线 immutable：事件/运行态行数与 ID 不变，内容不被改写。
    const sourceState = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM events
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS events,
         (SELECT count(*)::int FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS receipts,
         (SELECT count(*)::int FROM character_effects
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS effects,
         (SELECT count(*)::int FROM observations
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS observations,
         (SELECT receipt FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_branch_d20')
          AS receipt_payload,
         (SELECT source_event_id FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_branch_d20')
          AS receipt_event`,
      [branch.id],
    );
    assert.deepEqual(
      {
        events: sourceState.rows[0].events,
        receipts: sourceState.rows[0].receipts,
        effects: sourceState.rows[0].effects,
        observations: sourceState.rows[0].observations,
      },
      { events: 1, receipts: 1, effects: 1, observations: 1 },
    );
    assert.deepEqual(sourceState.rows[0].receipt_payload, receiptPayload);
    assert.equal(sourceState.rows[0].receipt_event, "event_branch_action");
  },
);

test(
  "merge still fails closed on memory/outbox/first-night/self-play/goal/durable-job runtime state",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createMergeRuntimeDatabase(
      t,
      "unsupported",
    );
    const { world, origin, branch, branchRecordId } =
      await createWorldWithBranch(ownerPool, "运行态拒绝试验场");
    const continuity = await ownerPool.query(
      `SELECT id FROM character_continuities
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
       ORDER BY id ASC LIMIT 1`,
      [branch.id],
    );
    assert.ok(continuity.rows[0], "branch worldline must carry a continuity");
    const continuityId = continuity.rows[0].id as string;
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });

    // 每个夹具累积注入一种本切片不支持的运行态；每次合并尝试必须
    // 以 RECONCILE_UNSUPPORTED 拒绝、落 rejected 审计且零目标拓扑残留。
    let attempt = 0;
    const expectUnsupported = async (reason: string) => {
      attempt += 1;
      const idempotencyKey = `runtime-uns-${attempt}`;
      await assert.rejects(
        service.merge({
          workspaceId: "ws_demo",
          worldId: world.id,
          sourceA: origin.id,
          sourceB: branch.id,
          idempotencyKey,
          operator: "tester",
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorldlineMergeUnsupportedError);
          assert.equal(error.code, "RECONCILE_UNSUPPORTED");
          assert.ok(
            error.records.some(
              (record) => (record.reasons as readonly string[]).includes(reason),
            ),
            `expected unsupported reason ${reason}`,
          );
          return true;
        },
      );
      const audit = await ownerPool.query(
        `SELECT status FROM worldline_merges
         WHERE workspace_id = 'ws_demo' AND idempotency_key = $1`,
        [idempotencyKey],
      );
      assert.equal(audit.rows[0]?.status, "rejected");
      assert.deepEqual(
        await mergedTopologyResidue(ownerPool, world.id),
        { worldlines: 0, records: 0, merged_audits: 0 },
        `unsupported ${reason} must leave zero target topology`,
      );
    };

    // Goal 运行态（Record 级）。
    await ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         policy_version
       ) VALUES ('ws_demo', $1, $2, $3, 'goal_fixture_1', 'goal_key_1', 'v1')`,
      [world.id, branch.id, branchRecordId],
    );
    await expectUnsupported("goal_instances");

    // 世界线级记忆运行态：结论（含 384 维向量字面）。
    const embedding = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
    await ownerPool.query(
      `INSERT INTO memory_conclusions (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         observed_entity_key, id, operation, memory_kind, content, keywords,
         semantic_embedding, embedding_model, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal, metadata
       ) VALUES (
         'ws_demo', $1, $2, $3, 'entity_x', 'mem_con_fixture_1', 'add',
         'explicit', '观察结论。', ARRAY['雾'], $4::vector, 'test-embedding',
         1.0, 0, 0, 0, 0, '{}'::jsonb
       )`,
      [world.id, branch.id, continuityId, embedding],
    );
    await expectUnsupported("memory_conclusions");

    await ownerPool.query(
      `INSERT INTO memory_snapshots (
         workspace_id, world_id, worldline_id, observer_continuity_id, id,
         snapshot_kind, content, item_ids, cursor_tick, cursor_ordinal,
         cache_epoch, token_count
       ) VALUES (
         'ws_demo', $1, $2, $3, 'mem_snap_fixture_1', 'recall', '快照。',
         ARRAY[]::text[], 0, 0, 0, 0
       )`,
      [world.id, branch.id, continuityId],
    );
    await expectUnsupported("memory_snapshots");

    await ownerPool.query(
      `INSERT INTO relationship_states (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         target_entity_key, relation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES (
         'ws_demo', $1, $2, $3, 'entity_x', 'trust', '信任。',
         1.0, 0, 0, 0, 0
       )`,
      [world.id, branch.id, continuityId],
    );
    await expectUnsupported("relationship_states");

    // 投递 outbox（Record 级）。
    await ownerPool.query(
      `INSERT INTO outbox (
         workspace_id, world_id, worldline_id, record_id, id, dedupe_key,
         topic, payload, state
       ) VALUES (
         'ws_demo', $1, $2, $3, 'outbox_fixture_1', 'outbox_dedupe_1',
         'memory.append', '{}'::jsonb, 'pending'
       )`,
      [world.id, branch.id, branchRecordId],
    );
    await expectUnsupported("outbox");

    // 终态自演会话行同样是本切片不复制的运行态。
    await ownerPool.query(
      `INSERT INTO record_self_play_sessions (
         workspace_id, id, record_id, world_id, state, beat_budget,
         requested_by
       ) VALUES (
         'ws_demo', 'selfplay_fixture_1', $1, $2, 'completed', 1, 'tester'
       )`,
      [branchRecordId, world.id],
    );
    await expectUnsupported("record_self_play_sessions");

    // 世界初夜状态行（Record 级，无 worldline 列，按 record 归属）。
    await ownerPool.query(
      `INSERT INTO record_first_nights (
         workspace_id, record_id, world_id, state, context
       ) VALUES ('ws_demo', $1, $2, 'pending', '{}'::jsonb)`,
      [branchRecordId, world.id],
    );
    await expectUnsupported("record_first_nights");

    // 统一 durable job 队列（0058）的在途行：pending job 合并后会对源
    // Record 作用域触发，不可安全重映射，必须 fail-closed。
    await ownerPool.query(
      `INSERT INTO realm_durable_jobs (
         workspace_id, id, job_kind, record_id, state
       ) VALUES ('ws_demo', 'durable_fixture_1', 'first-night', $1, 'pending')`,
      [branchRecordId],
    );
    await expectUnsupported("durable_jobs");
  },
);

test(
  "merge ignores terminal durable job rows (source operational history) and never copies them",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createMergeRuntimeDatabase(
      t,
      "durable-terminal",
    );
    const { world, origin, branch, branchRecordId } =
      await createWorldWithBranch(ownerPool, "终态作业试验场");
    // 终态 durable job（completed/failed）是源 Record 的运维历史：不阻塞
    // 合并，也绝不复制进目标 Record。
    await ownerPool.query(
      `INSERT INTO realm_durable_jobs (
         workspace_id, id, job_kind, record_id, state, attempt_count,
         completed_at
       ) VALUES
         ('ws_demo', 'durable_terminal_1', 'first-night', $1, 'completed', 1,
          CURRENT_TIMESTAMP),
         ('ws_demo', 'durable_terminal_2', 'self-play-beat', $1, 'failed', 3,
          CURRENT_TIMESTAMP)`,
      [branchRecordId],
    );
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    const result = await service.merge({
      workspaceId: "ws_demo",
      worldId: world.id,
      sourceA: origin.id,
      sourceB: branch.id,
      idempotencyKey: "runtime-durable-terminal-1",
      operator: "tester",
    });
    assert.equal(result.status, "merged");
    if (result.status !== "merged") return;

    // 源侧不可变：终态行原样保留在源 Record 上。
    const source = await ownerPool.query(
      `SELECT id, state FROM realm_durable_jobs
       WHERE workspace_id = 'ws_demo' AND record_id = $1 ORDER BY id`,
      [branchRecordId],
    );
    assert.deepEqual(
      source.rows.map((row) => `${row.id}:${row.state}`),
      ["durable_terminal_1:completed", "durable_terminal_2:failed"],
    );
    // 目标 Record 不携带任何 durable job 行。
    const copied = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM realm_durable_jobs
       WHERE workspace_id = 'ws_demo' AND record_id IN (
         SELECT id FROM records
         WHERE workspace_id = 'ws_demo' AND worldline_id = $1
       )`,
      [result.mergedWorldlineId],
    );
    assert.equal(copied.rows[0]?.n, 0);
  },
);

test(
  "merge fails closed on a cross-record observation reference with zero residue",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createMergeRuntimeDatabase(
      t,
      "crossref",
    );
    const {
      world,
      origin,
      branch,
      branchRecordId,
      branchWorldVersion,
    } = await createWorldWithBranch(ownerPool, "跨引用试验场");

    // 分支世界线内第二个 Record（世界线级 FK 允许 observation 跨 Record
    // 引用事件；本切片物化按 Record 作用域重映射，跨 Record 一律拒绝）。
    const story = await ownerPool.query(
      `SELECT id FROM stories
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
       ORDER BY created_at, id LIMIT 1`,
      [branch.id],
    );
    await ownerPool.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title, status,
         start_tick, start_ordinal, timeline_kind, world_version
       ) VALUES (
         'ws_demo', $1, $2, $3, 'record_branch_side', '侧线记录', 'active',
         0, 0, 'branch', $4
       )`,
      [world.id, branch.id, story.rows[0].id, branchWorldVersion],
    );
    await ownerPool.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, start_tick, start_ordinal
       ) VALUES (
         'ws_demo', $1, $2, 'record_branch_side', 'scene_branch_side',
         '侧线场景', 'active', '灰鲸港', '', 0, 0
       )`,
      [world.id, branch.id],
    );
    await ownerPool.query(
      `INSERT INTO visibility_policies (
         workspace_id, world_id, worldline_id, record_id, id, policy_key,
         policy_version, policy_kind
       ) VALUES (
         'ws_demo', $1, $2, 'record_branch_side', 'policy_branch_side',
         'public', 1, 'public'
       )`,
      [world.id, branch.id],
    );
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: "record_branch_side",
      eventId: "event_side_lore",
      tick: 2,
      ordinal: 1,
      speaker: "旁白",
      text: "侧线记录里的一句话。",
    });
    // 分支 Record 的 observation 引用另一侧线 Record 的事件（跨 Record）。
    const instanceId = await firstInstanceId(ownerPool, branchRecordId);
    await ownerPool.query(
      `INSERT INTO observations (
         workspace_id, world_id, worldline_id, record_id,
         observer_character_instance_id, source_event_id, id, dedupe_key,
         observation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES (
         'ws_demo', $1, $2, $3, $4, 'event_side_lore', 'obs_cross_record',
         'cross_record_dedupe', 'rumor', '道听途说。', 0.5, 2, 1, 2, 1
       )`,
      [world.id, branch.id, branchRecordId, instanceId],
    );

    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    await assert.rejects(
      service.merge({
        workspaceId: "ws_demo",
        worldId: world.id,
        sourceA: origin.id,
        sourceB: branch.id,
        idempotencyKey: "runtime-cross-record-1",
        operator: "tester",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorldlineMergeUnsupportedError);
        assert.equal(error.code, "RECONCILE_UNSUPPORTED");
        const flagged = error.records.find(
          (record) => record.recordId === branchRecordId,
        );
        assert.ok(flagged, "branch record must be flagged");
        assert.ok(flagged.reasons.includes("unmappable_event_reference"));
        return true;
      },
    );
    assert.deepEqual(
      await mergedTopologyResidue(ownerPool, world.id),
      { worldlines: 0, records: 0, merged_audits: 0 },
      "cross-record reference must roll back with zero residue",
    );
  },
);

test(
  "merge fails closed on an observation whose source event is deduped away",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createMergeRuntimeDatabase(
      t,
      "dangling",
    );
    const { world, origin, branch, originRecordId, branchRecordId } =
      await createWorldWithBranch(ownerPool, "悬空引用试验场");

    // 双侧同游标同载荷 → none 去重：B 侧事件被丢弃不复制，引用它的
    // observation 在目标 Record 内悬空，规划期 fail-closed。
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: origin.id,
      recordId: originRecordId,
      eventId: "event_origin_dup",
      tick: 3,
      ordinal: 1,
      speaker: "旁白",
      text: "同一句雾。",
    });
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: branchRecordId,
      eventId: "event_branch_dup",
      tick: 3,
      ordinal: 1,
      speaker: "旁白",
      text: "同一句雾。",
    });
    const instanceId = await firstInstanceId(ownerPool, branchRecordId);
    await ownerPool.query(
      `INSERT INTO observations (
         workspace_id, world_id, worldline_id, record_id,
         observer_character_instance_id, source_event_id, id, dedupe_key,
         observation_kind, content, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES (
         'ws_demo', $1, $2, $3, $4, 'event_branch_dup', 'obs_dangling',
         'dangling_dedupe', 'direct', '目击者记得那句雾。', 1.0,
         3, 1, 3, 1
       )`,
      [world.id, branch.id, branchRecordId, instanceId],
    );

    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    await assert.rejects(
      service.merge({
        workspaceId: "ws_demo",
        worldId: world.id,
        sourceA: origin.id,
        sourceB: branch.id,
        idempotencyKey: "runtime-dangling-1",
        operator: "tester",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorldlineMergeUnsupportedError);
        const flagged = error.records.find(
          (record) => record.recordId === branchRecordId,
        );
        assert.ok(flagged, "branch record must be flagged");
        assert.ok(flagged.reasons.includes("unmappable_event_reference"));
        return true;
      },
    );
    assert.deepEqual(
      await mergedTopologyResidue(ownerPool, world.id),
      { worldlines: 0, records: 0, merged_audits: 0 },
      "dangling observation reference must roll back with zero residue",
    );
    // 源双侧事件均保持 immutable（含被去重的 B 侧事件）。
    const sourceEvents = await ownerPool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE workspace_id = 'ws_demo' AND worldline_id IN ($1, $2)`,
      [origin.id, branch.id],
    );
    assert.equal(sourceEvents.rows[0].count, 2);
  },
);

test(
  "merge write path fails closed before any target write when the target World lacks an effect definition",
  SKIP,
  async (t) => {
    const { ownerPool } = await createMergeRuntimeDatabase(t, "nodef");
    const { world } = await createWorldWithBranch(ownerPool, "缺定义试验场");

    // 仓库级直接驱动：计划携带目标 World 内不存在的 effect_key。
    // effect definition 解析发生在任何目标写入之前——缺失即整体回滚。
    const repository = createPostgresWorldlineMergeRepository(ownerPool);
    const plan: MergeTopologyPlan = {
      worldlineId: "worldline_merge_nodef",
      label: "缺定义合并",
      storyId: "story_merge_nodef",
      storyTitle: "缺定义合并",
      headTick: 0,
      headOrdinal: 0,
      continuities: [],
      records: [{
        id: "record_merge_nodef",
        title: "缺定义记录",
        sourceRecordId: "record_src_nodef",
        worldVersion: "0.0.0-local",
        scenes: [],
        instances: [],
        participants: [],
        visibilityPolicies: [],
        skills: [],
        assets: [],
        actionReceipts: [],
        characterEffects: [{
          id: "character_effect_merge_nodef",
          characterInstanceId: "inst_nodef",
          effectKey: "effect_key_absent_from_world",
          sourceActionReceiptId: "receipt_nodef",
          status: "active",
          appliedTick: 0,
          appliedOrdinal: 0,
          endedTick: null,
          endedOrdinal: null,
          revision: 0,
          metadata: {},
        }],
        observations: [],
        events: [],
        head: {
          recordVersion: 0,
          nextRecordOrdinal: 0,
          lastEventId: null,
          lastWorldTick: null,
          lastWorldOrdinal: null,
        },
      }],
      sourceFingerprints: [],
    };
    const auditRow: MergeAuditRow = {
      id: "merge_nodef",
      idempotencyKey: "runtime-nodef-1",
      sourceWorldlineA: "worldline_src_a",
      sourceWorldlineB: "worldline_src_b",
      mergedWorldlineId: "worldline_merge_nodef",
      operator: "tester",
      status: "merged",
      conflictReport: {},
      manifest: [],
    };
    // 缺失定义的错误先于任何目标写入；若解析被移除，后续写入只会以
    // FK 违规失败（错误信息不同），本断言因此对退化实现非空转。
    await assert.rejects(
      repository.createMergedTopologyAndAudit(
        { workspaceId: "ws_demo", worldId: world.id },
        plan,
        auditRow,
      ),
      /effect definition/,
    );
    const residue = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM worldlines
          WHERE workspace_id = 'ws_demo' AND id = 'worldline_merge_nodef')
          AS worldlines,
         (SELECT count(*)::int FROM records
          WHERE workspace_id = 'ws_demo' AND id = 'record_merge_nodef')
          AS records,
         (SELECT count(*)::int FROM worldline_merges
          WHERE workspace_id = 'ws_demo' AND id = 'merge_nodef') AS audits`,
    );
    assert.deepEqual(residue.rows[0], { worldlines: 0, records: 0, audits: 0 });
  },
);
