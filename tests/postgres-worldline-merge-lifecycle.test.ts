/**
 * Worldline branch/fork → run → merge 完整生命周期验收（Slice E）。
 *
 * 在真实 fork 之后，分别在原初世界线和分支世界线上提交包含
 * action receipts / character effects / observations 的确定性格子，
 * 再执行合并。验证：
 * - 合并成功并生成 merged 世界线；
 * - 原初与分支的运行态都被重映射进对应的目标 Record；
 * - receipt payload、effect definition、observation 内容与游标逐字节保留；
 * - 源世界线事件与运行态 immutable；
 * - 幂等重放返回同一 merged 世界线且不重复物化；
 * - 分支携带 memory_conclusions 时整体 fail-closed（RECONCILE_UNSUPPORTED）、
 *   零目标拓扑残留。
 *
 * 真实临时 PG 库（t.after 拆库），合并写路径经 realm_runtime 受限角色。
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
  "0023_library_runtime_grants.sql",
  "0029_record_scene_tension.sql",
  "0039_scene_weather_snapshot.sql",
  "0040_scene_display_time_snapshot.sql",
  "0044_record_branch_timeline_kind.sql",
  "0053_membership_capability.sql",
  "0054_world_version_identity.sql",
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  "0057_realmworld_record_binding.sql",
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

async function createLifecycleDatabase(
  t: test.TestContext,
  label: string,
): Promise<{ ownerPool: pg.Pool; restrictedPool: pg.Pool }> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_lfc_${label}_${randomUUID().replaceAll("-", "")}`;
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

  // 本切片 record_first_nights 仍 fail-closed：清除 starter Record 的 pending
  // 状态行，避免遮蔽运行态生命周期行为。
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

async function insertRuntimeState(
  ownerPool: pg.Pool,
  input: {
    worldId: string;
    worldlineId: string;
    recordId: string;
    instanceId: string;
    eventId: string;
    receiptId: string;
    effectId: string;
    observationId: string;
    effectDefinitionId: string;
    tick: number;
    ordinal: number;
    receiptPayload: unknown;
    observationText: string;
  },
) {
  await ownerPool.query(
    `INSERT INTO action_receipts (
       workspace_id, world_id, worldline_id, record_id,
       actor_character_instance_id, source_event_id, id, transaction_id,
       call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
     ) VALUES (
       'ws_demo', $1, $2, $3, $4, $5,
       $6, 'txn_' || $6, 'fp_' || $6,
       $7::jsonb, $8, $9, '2026-10-09T08:00:00.000Z'::timestamptz
     )`,
    [
      input.worldId,
      input.worldlineId,
      input.recordId,
      input.instanceId,
      input.eventId,
      input.receiptId,
      JSON.stringify(input.receiptPayload),
      input.tick,
      input.ordinal,
    ],
  );
  await ownerPool.query(
    `INSERT INTO character_effects (
       workspace_id, world_id, worldline_id, record_id,
       character_instance_id, effect_definition_id, source_action_receipt_id,
       id, status, applied_tick, applied_ordinal, revision, metadata
     ) VALUES (
       'ws_demo', $1, $2, $3, $4, $5, $6,
       $7, 'active', $8, $9, 0, $10::jsonb
     )`,
    [
      input.worldId,
      input.worldlineId,
      input.recordId,
      input.instanceId,
      input.effectDefinitionId,
      input.receiptId,
      input.effectId,
      input.tick,
      input.ordinal,
      JSON.stringify({ note: `effect ${input.effectId}` }),
    ],
  );
  await ownerPool.query(
    `INSERT INTO observations (
       workspace_id, world_id, worldline_id, record_id,
       observer_character_instance_id, source_event_id, id, dedupe_key,
       observation_kind, content, fidelity,
       occurred_tick, occurred_ordinal,
       available_from_tick, available_from_ordinal, learned_at, metadata
     ) VALUES (
       'ws_demo', $1, $2, $3, $4, $5, $6,
       'dedupe_' || $6, 'direct', $7, 0.95,
       $8, $9, $8, $9,
       '2026-10-09T08:00:01.000Z'::timestamptz, $10::jsonb
     )`,
    [
      input.worldId,
      input.worldlineId,
      input.recordId,
      input.instanceId,
      input.eventId,
      input.observationId,
      input.observationText,
      input.tick,
      input.ordinal,
      JSON.stringify({ channel: "eyes" }),
    ],
  );
}

const SKIP = { skip: !adminConnectionString || !runtimeConnectionString };

test(
  "full branch/fork → run on origin → run on branch → merge lifecycle",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createLifecycleDatabase(
      t,
      "happy",
    );
    const {
      world,
      origin,
      branch,
      originRecordId,
      branchRecordId,
    } = await createWorldWithBranch(ownerPool, "生命周期试验场");

    const originInstanceId = await firstInstanceId(ownerPool, originRecordId);
    const branchInstanceId = await firstInstanceId(ownerPool, branchRecordId);

    // World 级 stance effect definition（双侧同 World，目标按 effect_key 解析）。
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

    // 1. 原初世界线跑一回合。
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: origin.id,
      recordId: originRecordId,
      eventId: "event_origin_action",
      tick: 1,
      ordinal: 1,
      speaker: "洛川",
      text: "洛川架起盾，礁石般的守势在脚下铺开。",
    });
    const originReceiptPayload = {
      kind: "action.receipt",
      dice: { system: "d20", rolls: [14], modifier: 2, total: 16 },
      costs: [{ resourceId: "asset_def_mist_potion", amount: 1 }],
      effects: [
        { effectId: "effect_origin_stance", operation: "apply", targetId: originInstanceId },
      ],
      narrative: "d20=14+2，架起守势；雾药剂 -1。",
    };
    await insertRuntimeState(ownerPool, {
      worldId: world.id,
      worldlineId: origin.id,
      recordId: originRecordId,
      instanceId: originInstanceId,
      eventId: "event_origin_action",
      receiptId: "receipt_origin_d20",
      effectId: "effect_origin_stance",
      observationId: "obs_origin_witness",
      effectDefinitionId: "effect_def_stance_guard",
      tick: 1,
      ordinal: 1,
      receiptPayload: originReceiptPayload,
      observationText: "洛川看见守势如礁石铺开。",
    });

    // 2. 分支世界线跑另一回合。
    await insertCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: branchRecordId,
      eventId: "event_branch_action",
      tick: 2,
      ordinal: 1,
      speaker: "塞娜",
      text: "塞娜掷出匕首，药剂的苦味在舌尖炸开。",
    });
    const branchReceiptPayload = {
      kind: "action.receipt",
      dice: { system: "d20", rolls: [17], modifier: 3, total: 20 },
      costs: [{ resourceId: "asset_def_mist_potion", amount: 1 }],
      effects: [
        { effectId: "effect_branch_stance", operation: "apply", targetId: branchInstanceId },
      ],
      narrative: "d20=17+3，命中；雾药剂 -1。",
    };
    await insertRuntimeState(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: branchRecordId,
      instanceId: branchInstanceId,
      eventId: "event_branch_action",
      receiptId: "receipt_branch_d20",
      effectId: "effect_branch_stance",
      observationId: "obs_branch_witness",
      effectDefinitionId: "effect_def_stance_guard",
      tick: 2,
      ordinal: 1,
      receiptPayload: branchReceiptPayload,
      observationText: "塞娜看见守势随药剂的苦味成形。",
    });

    // 3. 合并分支回原初。
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    const result = await service.merge({
      workspaceId: "ws_demo",
      worldId: world.id,
      sourceA: origin.id,
      sourceB: branch.id,
      idempotencyKey: "lifecycle-merge-happy-1",
      operator: "tester",
    });
    assert.equal(result.status, "merged");
    if (result.status !== "merged") return;

    // 4. 查找两个目标 Record。
    const targetRecords = await ownerPool.query(
      `SELECT id, linked_record_id FROM records
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND timeline_kind = 'merged'
       ORDER BY linked_record_id`,
      [result.mergedWorldlineId],
    );
    assert.equal(targetRecords.rows.length, 2);
    const originTarget = targetRecords.rows.find(
      (row) => row.linked_record_id === originRecordId,
    )!;
    const branchTarget = targetRecords.rows.find(
      (row) => row.linked_record_id === branchRecordId,
    )!;
    assert.ok(originTarget && branchTarget, "both source records must have merged copies");

    const eventMap = new Map(
      result.report.manifest
        .filter((entry) => entry.targetEventId !== undefined)
        .map((entry) => [entry.eventId, entry.targetEventId!]),
    );
    const originTargetEventId = eventMap.get("event_origin_action");
    const branchTargetEventId = eventMap.get("event_branch_action");
    assert.ok(originTargetEventId, "origin event must be materialized");
    assert.ok(branchTargetEventId, "branch event must be materialized");

    // 5. 验证原初目标运行态。
    const originTargetReceipts = await ownerPool.query(
      `SELECT id, record_id, actor_character_instance_id, source_event_id,
              transaction_id, call_fingerprint, receipt
       FROM action_receipts
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, originTarget.id],
    );
    assert.equal(originTargetReceipts.rows.length, 1);
    const originTR = originTargetReceipts.rows[0];
    assert.notEqual(originTR.id, "receipt_origin_d20");
    assert.equal(originTR.record_id, originTarget.id);
    assert.equal(originTR.source_event_id, originTargetEventId);
    assert.equal(originTR.transaction_id, "txn_receipt_origin_d20");
    assert.equal(originTR.call_fingerprint, "fp_receipt_origin_d20");
    assert.deepEqual(originTR.receipt, originReceiptPayload);

    const originTargetEffects = await ownerPool.query(
      `SELECT id, record_id, character_instance_id, effect_definition_id,
              source_action_receipt_id, status, metadata
       FROM character_effects
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, originTarget.id],
    );
    assert.equal(originTargetEffects.rows.length, 1);
    const originTE = originTargetEffects.rows[0];
    assert.equal(originTE.record_id, originTarget.id);
    assert.equal(originTE.effect_definition_id, "effect_def_stance_guard");
    assert.equal(originTE.source_action_receipt_id, originTR.id);
    assert.equal(originTE.character_instance_id, originTR.actor_character_instance_id);

    const originTargetObservations = await ownerPool.query(
      `SELECT id, record_id, observer_character_instance_id, source_event_id,
              content, metadata
       FROM observations
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, originTarget.id],
    );
    assert.equal(originTargetObservations.rows.length, 1);
    const originTO = originTargetObservations.rows[0];
    assert.equal(originTO.record_id, originTarget.id);
    assert.equal(originTO.source_event_id, originTargetEventId);
    assert.equal(originTO.observer_character_instance_id, originTR.actor_character_instance_id);
    assert.equal(originTO.content, "洛川看见守势如礁石铺开。");

    // 6. 验证分支目标运行态。
    const branchTargetReceipts = await ownerPool.query(
      `SELECT id, record_id, actor_character_instance_id, source_event_id,
              transaction_id, call_fingerprint, receipt
       FROM action_receipts
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, branchTarget.id],
    );
    assert.equal(branchTargetReceipts.rows.length, 1);
    const branchTR = branchTargetReceipts.rows[0];
    assert.notEqual(branchTR.id, "receipt_branch_d20");
    assert.equal(branchTR.record_id, branchTarget.id);
    assert.equal(branchTR.source_event_id, branchTargetEventId);
    assert.equal(branchTR.transaction_id, "txn_receipt_branch_d20");
    assert.equal(branchTR.call_fingerprint, "fp_receipt_branch_d20");
    assert.deepEqual(branchTR.receipt, branchReceiptPayload);

    const branchTargetEffects = await ownerPool.query(
      `SELECT id, record_id, character_instance_id, effect_definition_id,
              source_action_receipt_id, status
       FROM character_effects
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, branchTarget.id],
    );
    assert.equal(branchTargetEffects.rows.length, 1);
    const branchTE = branchTargetEffects.rows[0];
    assert.equal(branchTE.effect_definition_id, "effect_def_stance_guard");
    assert.equal(branchTE.source_action_receipt_id, branchTR.id);

    const branchTargetObservations = await ownerPool.query(
      `SELECT id, record_id, observer_character_instance_id, source_event_id,
              content
       FROM observations
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND record_id = $2`,
      [result.mergedWorldlineId, branchTarget.id],
    );
    assert.equal(branchTargetObservations.rows.length, 1);
    const branchTO = branchTargetObservations.rows[0];
    assert.equal(branchTO.source_event_id, branchTargetEventId);
    assert.equal(branchTO.observer_character_instance_id, branchTR.actor_character_instance_id);
    assert.equal(branchTO.content, "塞娜看见守势随药剂的苦味成形。");

    // 7. 目标 actor instance 都属于对应目标 Record / merged worldline。
    const targetInstances = await ownerPool.query(
      `SELECT id, record_id, worldline_id FROM character_instances
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(targetInstances.rows.length, 2);
    for (const row of targetInstances.rows) {
      assert.equal(row.worldline_id, result.mergedWorldlineId);
      assert.ok(
        row.record_id === originTarget.id || row.record_id === branchTarget.id,
      );
    }

    // 8. 源世界线 immutable：行数、ID、内容均不变。
    const sourceState = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM events
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS origin_events,
         (SELECT count(*)::int FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS origin_receipts,
         (SELECT receipt FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_origin_d20') AS origin_receipt_payload,
         (SELECT count(*)::int FROM events
          WHERE workspace_id = 'ws_demo' AND worldline_id = $2) AS branch_events,
         (SELECT count(*)::int FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND worldline_id = $2) AS branch_receipts,
         (SELECT receipt FROM action_receipts
          WHERE workspace_id = 'ws_demo' AND id = 'receipt_branch_d20') AS branch_receipt_payload`,
      [origin.id, branch.id],
    );
    assert.equal(sourceState.rows[0].origin_events, 1);
    assert.equal(sourceState.rows[0].origin_receipts, 1);
    assert.deepEqual(sourceState.rows[0].origin_receipt_payload, originReceiptPayload);
    assert.equal(sourceState.rows[0].branch_events, 1);
    assert.equal(sourceState.rows[0].branch_receipts, 1);
    assert.deepEqual(sourceState.rows[0].branch_receipt_payload, branchReceiptPayload);

    // 9. 幂等重放：同一幂等键返回同一 merged 世界线，不新增物化行。
    const replay = await service.merge({
      workspaceId: "ws_demo",
      worldId: world.id,
      sourceA: origin.id,
      sourceB: branch.id,
      idempotencyKey: "lifecycle-merge-happy-1",
      operator: "tester",
    });
    assert.equal(replay.status, "merged");
    if (replay.status !== "merged") return;
    assert.equal(replay.mergedWorldlineId, result.mergedWorldlineId);

    const mergedRecordsAfterReplay = await ownerPool.query(
      `SELECT count(*)::int AS count FROM records
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(mergedRecordsAfterReplay.rows[0].count, 2);
    const mergedReceiptsAfterReplay = await ownerPool.query(
      `SELECT count(*)::int AS count FROM action_receipts
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [result.mergedWorldlineId],
    );
    assert.equal(mergedReceiptsAfterReplay.rows[0].count, 2);
  },
);

test(
  "lifecycle merge rejects memory runtime state on branch with zero residue",
  SKIP,
  async (t) => {
    const { ownerPool, restrictedPool } = await createLifecycleDatabase(
      t,
      "unsupported",
    );
    const { world, origin, branch, branchRecordId } =
      await createWorldWithBranch(ownerPool, "生命周期拒绝试验场");
    const continuity = await ownerPool.query(
      `SELECT id FROM character_continuities
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
       ORDER BY id ASC LIMIT 1`,
      [branch.id],
    );
    assert.ok(continuity.rows[0], "branch worldline must carry a continuity");
    const continuityId = continuity.rows[0].id as string;

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

    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(restrictedPool),
    });
    await assert.rejects(
      service.merge({
        workspaceId: "ws_demo",
        worldId: world.id,
        sourceA: origin.id,
        sourceB: branch.id,
        idempotencyKey: "lifecycle-unsupported-1",
        operator: "tester",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorldlineMergeUnsupportedError);
        assert.equal(error.code, "RECONCILE_UNSUPPORTED");
        const flagged = error.records.find(
          (record) => record.recordId === branchRecordId,
        );
        assert.ok(flagged, "branch record must be flagged");
        assert.ok(flagged.reasons.includes("memory_conclusions"));
        return true;
      },
    );

    const audit = await ownerPool.query(
      `SELECT status FROM worldline_merges
       WHERE workspace_id = 'ws_demo' AND idempotency_key = $1`,
      ["lifecycle-unsupported-1"],
    );
    assert.equal(audit.rows[0]?.status, "rejected");
    assert.deepEqual(
      await mergedTopologyResidue(ownerPool, world.id),
      { worldlines: 0, records: 0, merged_audits: 0 },
      "unsupported lifecycle branch must leave zero target topology",
    );
  },
);
