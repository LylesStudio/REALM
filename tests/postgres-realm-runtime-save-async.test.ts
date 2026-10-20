/**
 * `.realm` runtime-save v2 异步运行态切片 PG 验收（disposable scratch PG；
 * 独立临时库，绝不触碰共享 realm_dev）。
 *
 * 覆盖：
 * 1. 含非终态 outbox（pending/delivering/retryable/failed）、first-night
 *    pending、self-play completed/failed/running 的 Record 存档 → restore
 *    → 幂等 replay 不重复；
 * 2. 目标 Record outbox 消息全部落 fresh pending（lease/fencing token、
 *    attempt_count、失败细节不复制），idempotency key（dedupe_key）以
 *    restore 前缀命名空间化并保留原键后缀，delivered 终态消息不恢复；
 * 3. first-night 状态经目标 Record 投影（FirstNightStore.find）读回一致；
 * 4. self-play 会话 ledger 与拍数在目标 Record 读回一致，在途
 *    running/stopping 收束为终态 cancelled；
 * 5. 失败场景 fail-closed 且整体回滚零残留：outbox 跨 Record/存档外 Event
 *    引用、损坏 lease 元数据、schema 损坏（delivered 混入 / 非法枚举 /
 *    超预算拍数）；
 * 6. RLS/workspace boundary：observer/无 membership principal、跨
 *    workspace restore 一律 WORLD_NOT_FOUND 且零残留。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { zipSync } from "fflate";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
  RealmRuntimeSaveRepositoryError,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresFirstNightStore } from "../database/postgres/first-night-store.ts";
import {
  buildRealmRuntimeSaveArchive,
  computeRealmRuntimeSaveContentHash,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
  serializeRealmRuntimeSaveManifestV2,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveManifestV2,
  type RealmRuntimeSaveOutboxV1,
} from "../modules/world-transfer/realm-runtime-save.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL integration tests require a loopback database URL.");
  }
  return value;
}

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_save_async_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  ownerPool.on("error", () => {});
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  runtimePool.on("error", () => {});

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(
      await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"),
    );
  }
  await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
  return { ownerPool, runtimePool };
}

/** restore 作用域产物计数（零残留断言；临时库内无其它 restore 行）。 */
async function restoreArtifactCounts(pool: pg.Pool) {
  const { rows } = await pool.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM worldlines WHERE id LIKE 'worldline\\_restore\\_%') AS worldlines,
      (SELECT count(*)::int FROM stories WHERE id LIKE 'story\\_restore\\_%') AS stories,
      (SELECT count(*)::int FROM records WHERE id LIKE 'record\\_restore\\_%') AS records,
      (SELECT count(*)::int FROM events WHERE id LIKE 'restore\\_event\\_%') AS events,
      (SELECT count(*)::int FROM goal_instances WHERE id LIKE 'goal\\_restore\\_%') AS goals,
      (SELECT count(*)::int FROM goal_assessments WHERE id LIKE 'assessment\\_restore\\_%') AS assessments,
      (SELECT count(*)::int FROM action_receipts WHERE id LIKE 'action\\_receipt\\_restore\\_%') AS receipts,
      (SELECT count(*)::int FROM character_effects WHERE id LIKE 'character\\_effect\\_restore\\_%') AS effects,
      (SELECT count(*)::int FROM observations WHERE id LIKE 'observation\\_restore\\_%') AS observations,
      (SELECT count(*)::int FROM participants WHERE id LIKE 'participant\\_restore\\_%') AS participants,
      (SELECT count(*)::int FROM character_instances WHERE id LIKE 'character\\_instance\\_restore\\_%') AS instances,
      (SELECT count(*)::int FROM scenes WHERE id LIKE 'scene\\_restore\\_%') AS scenes,
      (SELECT count(*)::int FROM visibility_policies WHERE id LIKE 'policy\\_restore\\_%') AS policies,
      (SELECT count(*)::int FROM memory_conclusions WHERE id LIKE 'memory\\_conclusion\\_restore\\_%') AS memory_conclusions,
      (SELECT count(*)::int FROM memory_snapshots WHERE id LIKE 'memory\\_snapshot\\_restore\\_%') AS memory_snapshots,
      (SELECT count(*)::int FROM relationship_states
        WHERE observer_continuity_id LIKE 'character\\_continuity\\_restore\\_%') AS relationship_states,
      (SELECT count(*)::int FROM outbox WHERE id LIKE 'outbox\\_restore\\_%') AS outbox,
      (SELECT count(*)::int FROM record_first_nights
        WHERE record_id LIKE 'record\\_restore\\_%') AS first_nights,
      (SELECT count(*)::int FROM record_self_play_sessions
        WHERE id LIKE 'self\\_play\\_restore\\_%') AS self_play_sessions
  `);
  return rows[0]!;
}

interface OutboxTargetRow {
  id: string;
  record_id: string;
  event_id: string | null;
  turn_run_id: string | null;
  dedupe_key: string;
  topic: string;
  payload: Record<string, unknown>;
  state: string;
  revision: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  published_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
}

interface SelfPlayTargetRow {
  id: string;
  record_id: string;
  world_id: string;
  state: string;
  beat_budget: number;
  beats_completed: number;
  requested_by: string;
  last_error: string | null;
}

test(
  "runtime-save v2 outbox / first-night / self-play 异步运行态全量切片",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    // ---- source 异步运行态装配 ------------------------------------------
    // outbox：pending / delivering（带 lease）/ retryable（带失败细节）/
    // failed 各一进入存档；delivered 终态消息绝不进存档。
    const outboxFixtures = [
      {
        id: "ob_save_pending",
        dedupeKey: "save-async:pending",
        topic: "record.event.available",
        payload: { kind: "record.event.available", note: "pending" },
        state: "pending",
        attemptCount: 0,
        revision: 0,
        availableAt: "2026-08-20T04:00:00.000Z",
        eventId: POSTGRES_DEMO_IDS.openingEvent as string | null,
        leaseOwner: null as string | null,
        leaseExpiresAt: null as string | null,
        error: null as { code: string; message: string; at: string } | null,
      },
      {
        id: "ob_save_delivering",
        dedupeKey: "save-async:delivering",
        topic: "record.first-night.ready",
        payload: { kind: "record.first-night.ready", note: "delivering" },
        state: "delivering",
        attemptCount: 1,
        revision: 2,
        availableAt: "2026-08-20T04:01:00.000Z",
        eventId: null,
        leaseOwner: "worker-async-1",
        leaseExpiresAt: "2026-08-20T05:00:00.000Z",
        error: null,
      },
      {
        id: "ob_save_retryable",
        dedupeKey: "save-async:retryable",
        topic: "record.self-play.beat",
        payload: { kind: "record.self-play.beat", note: "retryable" },
        state: "retryable",
        attemptCount: 3,
        revision: 3,
        availableAt: "2026-08-20T04:30:00.000Z",
        eventId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: { code: "SINK_TIMEOUT", message: "delivery sink timed out", at: "2026-08-20T04:05:00.000Z" },
      },
      {
        id: "ob_save_failed",
        dedupeKey: "save-async:failed",
        topic: "record.event.available",
        payload: { kind: "record.event.available", note: "failed" },
        state: "failed",
        attemptCount: 5,
        revision: 5,
        availableAt: "2026-08-20T04:10:00.000Z",
        eventId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: { code: "SINK_REJECTED", message: "delivery sink rejected the envelope", at: "2026-08-20T04:12:00.000Z" },
      },
      {
        id: "ob_save_delivered",
        dedupeKey: "save-async:delivered",
        topic: "record.event.available",
        payload: { kind: "record.event.available", note: "delivered" },
        state: "delivered",
        attemptCount: 1,
        revision: 1,
        availableAt: "2026-08-20T03:00:00.000Z",
        eventId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
      },
    ];
    for (const fixture of outboxFixtures) {
      await ownerPool.query(
        `INSERT INTO outbox (
           workspace_id, world_id, worldline_id, record_id,
           event_id, turn_run_id, id, dedupe_key, topic, payload,
           state, revision, attempt_count, available_at,
           lease_owner, lease_expires_at, published_at,
           last_error_code, last_error_message, last_error_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9::jsonb,
           $10, $11, $12, $13::timestamptz,
           $14, $15::timestamptz,
           CASE WHEN $10 = 'delivered' THEN $13::timestamptz ELSE NULL END,
           $16, $17, $18::timestamptz,
           '2026-08-20T03:55:00.000Z', '2026-08-20T03:55:00.000Z'
         )`,
        [
          SCOPE.workspaceId,
          SCOPE.worldId,
          SCOPE.worldlineId,
          SCOPE.recordId,
          fixture.eventId,
          fixture.id,
          fixture.dedupeKey,
          fixture.topic,
          JSON.stringify(fixture.payload),
          fixture.state,
          fixture.revision,
          fixture.attemptCount,
          fixture.availableAt,
          fixture.leaseOwner,
          fixture.leaseExpiresAt,
          fixture.error?.code ?? null,
          fixture.error?.message ?? null,
          fixture.error?.at ?? null,
        ],
      );
    }

    // first-night：pending 状态行（含创世上下文快照）。
    const firstNightContext = {
      world: { name: "雾港", era: "蒸汽纪", summary: "雾与海的小镇。" },
      style: "modern",
      language: "zh-CN",
      story: { title: "寂静钟声", premise: "钟声停了。" },
      playerRole: "守灯人",
      playerName: "玩家",
      playerStance: "player",
      companions: [{ name: "斥候", role: "向导", summary: "熟悉栈桥。" }],
      scene: { location: "栈桥", weather: "大雾", tension: "低语", objective: "点灯" },
      opening: "雾夜栈桥。",
    };
    await ownerPool.query(
      `INSERT INTO record_first_nights (
         workspace_id, record_id, world_id, state, attempts,
         hook_content, suggestions, context
       ) VALUES ($1, $2, $3, 'pending', 1, '', '{}', $4::jsonb)`,
      [SCOPE.workspaceId, SCOPE.recordId, SCOPE.worldId, JSON.stringify(firstNightContext)],
    );

    // self-play：completed / failed / running 各一（running restore 后收束
    // 为 cancelled；部分唯一索引保证至多一条活动会话）。
    const selfPlayFixtures = [
      {
        id: "sp_save_completed",
        state: "completed",
        beatBudget: 3,
        beatsCompleted: 3,
        lastError: null as string | null,
        createdAt: "2026-08-20T02:00:00.000Z",
      },
      {
        id: "sp_save_failed",
        state: "failed",
        beatBudget: 5,
        beatsCompleted: 2,
        lastError: "scheduler heartbeat lost",
        createdAt: "2026-08-20T02:30:00.000Z",
      },
      {
        id: "sp_save_running",
        state: "running",
        beatBudget: 8,
        beatsCompleted: 1,
        lastError: null,
        createdAt: "2026-08-20T03:00:00.000Z",
      },
    ];
    for (const fixture of selfPlayFixtures) {
      await ownerPool.query(
        `INSERT INTO record_self_play_sessions (
           workspace_id, id, record_id, world_id, state,
           beat_budget, beats_completed, requested_by, last_error,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)`,
        [
          SCOPE.workspaceId,
          fixture.id,
          SCOPE.recordId,
          SCOPE.worldId,
          fixture.state,
          fixture.beatBudget,
          fixture.beatsCompleted,
          POSTGRES_DEMO_IDS.principal,
          fixture.lastError,
          fixture.createdAt,
        ],
      );
    }

    // ---- save：三段异步运行态进入存档 ------------------------------------
    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const archive = await reader.load({ principalId: POSTGRES_DEMO_IDS.principal, purpose: "record-export",
      workspaceId: SCOPE.workspaceId,
      recordId: SCOPE.recordId,
    });
    assert.ok(archive, "demo Record must be loadable");
    assert.equal(archive.manifest.mode, "base");
    // delivered 终态消息不进存档。
    assert.equal(archive.outbox?.messages.length, 4);
    assert.ok(
      archive.outbox!.messages.every((message) => message.dedupeKey !== "save-async:delivered"),
    );
    const archivedByDedupe = new Map(
      archive.outbox!.messages.map((message) => [message.dedupeKey, message]),
    );
    assert.equal(archivedByDedupe.get("save-async:pending")?.state, "pending");
    assert.equal(archivedByDedupe.get("save-async:pending")?.sourceEventId, POSTGRES_DEMO_IDS.openingEvent);
    assert.equal(archivedByDedupe.get("save-async:delivering")?.state, "delivering");
    assert.equal(archivedByDedupe.get("save-async:delivering")?.leaseOwner, "worker-async-1");
    assert.equal(archivedByDedupe.get("save-async:retryable")?.state, "retryable");
    assert.equal(archivedByDedupe.get("save-async:retryable")?.lastErrorCode, "SINK_TIMEOUT");
    assert.equal(archivedByDedupe.get("save-async:retryable")?.deliveryAttempts, 3);
    assert.equal(archivedByDedupe.get("save-async:failed")?.state, "failed");
    assert.equal(archivedByDedupe.get("save-async:failed")?.lastErrorCode, "SINK_REJECTED");
    assert.equal(archive.firstNight?.entry?.state, "pending");
    assert.equal(archive.firstNight?.entry?.attempts, 1);
    assert.deepEqual(archive.firstNight?.entry?.context, firstNightContext);
    assert.equal(archive.selfPlay?.sessions.length, 3);
    // 存档字节级 round-trip：parse(build(archive)) 与 reader 输出一致。
    const archiveBytes = buildRealmRuntimeSaveArchive(archive);
    const reparsed = parseRealmRuntimeSaveArchive(archiveBytes);
    assert.deepEqual(reparsed.outbox, archive.outbox);
    assert.deepEqual(reparsed.firstNight, archive.firstNight);
    assert.deepEqual(reparsed.selfPlay, archive.selfPlay);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
    const restoreInput = {
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: "save-async-restore-1",
    };

    // ---- restore：三段物化到目标 Record ----------------------------------
    const restored = await restorer.restore(restoreInput);
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedOutboxMessageCount, 4);
    assert.equal(restored.importedFirstNightCount, 1);
    assert.equal(restored.importedSelfPlaySessionCount, 3);

    // outbox：fresh pending、lease/fencing token 不复制、idempotency key
    // 保留为命名空间化后缀、event 引用重映射、delivered 不恢复。
    const targetOutbox = (await ownerPool.query<OutboxTargetRow>(
      `SELECT id, record_id, event_id, turn_run_id, dedupe_key, topic, payload,
              state, revision::text AS revision, attempt_count,
              lease_owner, lease_expires_at::text AS lease_expires_at,
              published_at::text AS published_at,
              last_error_code, last_error_message, last_error_at::text AS last_error_at
       FROM outbox
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY id ASC`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows;
    assert.equal(targetOutbox.length, 4);
    const targetEventIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows.map((row) => row.id));
    const sourceByDedupeSuffix = new Map(
      outboxFixtures.map((fixture) => [fixture.dedupeKey, fixture]),
    );
    for (const target of targetOutbox) {
      assert.match(target.id, /^outbox_restore_/);
      assert.match(target.dedupe_key, /^restore:[0-9a-f]{24}:save-async:/);
      const sourceDedupeKey = target.dedupe_key.slice(target.dedupe_key.indexOf(":save-async:") + 1);
      const source = sourceByDedupeSuffix.get(sourceDedupeKey);
      assert.ok(source, `target message ${target.id} must pair with a source message`);
      assert.notEqual(source.state, "delivered");
      assert.equal(target.topic, source.topic);
      assert.deepEqual(target.payload, source.payload);
      // fresh pending：lease/失败细节/published/尝试数/fencing revision 全部复位。
      assert.equal(target.state, "pending");
      assert.equal(target.attempt_count, 0);
      assert.equal(target.revision, "0");
      assert.equal(target.lease_owner, null);
      assert.equal(target.lease_expires_at, null);
      assert.equal(target.published_at, null);
      assert.equal(target.last_error_code, null);
      assert.equal(target.last_error_message, null);
      assert.equal(target.last_error_at, null);
      assert.equal(target.turn_run_id, null);
      if (source.eventId !== null) {
        assert.ok(targetEventIds.has(target.event_id!));
        assert.notEqual(target.event_id, source.eventId);
      } else {
        assert.equal(target.event_id, null);
      }
    }

    // first-night：目标 Record 投影（FirstNightStore.find）读回一致。
    const firstNightStore = createPostgresFirstNightStore(runtimePool, SCOPE.workspaceId);
    const targetFirstNight = await firstNightStore.find(restored.recordId);
    assert.ok(targetFirstNight, "target Record must carry a first-night marker");
    assert.equal(targetFirstNight.state, "pending");
    assert.equal(targetFirstNight.attempts, 1);
    assert.equal(targetFirstNight.hookContent, "");
    assert.deepEqual(targetFirstNight.suggestions, []);
    assert.equal(targetFirstNight.worldId, SCOPE.worldId);
    assert.equal(targetFirstNight.context?.world.name, "雾港");
    assert.equal(targetFirstNight.context?.opening, "雾夜栈桥。");
    assert.equal(targetFirstNight.context?.companions[0]?.name, "斥候");
    // context 原始 jsonb 逐字节一致（投影层之上再做一次 SQL 级对照）。
    const targetFirstNightRaw = (await ownerPool.query<{ context: unknown }>(
      `SELECT context FROM record_first_nights
       WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows[0];
    assert.deepEqual(targetFirstNightRaw?.context, firstNightContext);

    // self-play：ledger 与拍数读回一致；running 收束为 cancelled。
    const targetSessions = (await ownerPool.query<SelfPlayTargetRow>(
      `SELECT id, record_id, world_id, state, beat_budget, beats_completed,
              requested_by, last_error
       FROM record_self_play_sessions
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY created_at ASC, id ASC`,
      [SCOPE.workspaceId, restored.recordId],
    )).rows;
    assert.equal(targetSessions.length, 3);
    const targetByBudget = new Map(targetSessions.map((row) => [row.beat_budget, row]));
    const completed = targetByBudget.get(3)!;
    assert.match(completed.id, /^self_play_restore_/);
    assert.equal(completed.state, "completed");
    assert.equal(completed.beats_completed, 3);
    assert.equal(completed.requested_by, POSTGRES_DEMO_IDS.principal);
    assert.equal(completed.last_error, null);
    const failed = targetByBudget.get(5)!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.beats_completed, 2);
    assert.equal(failed.last_error, "scheduler heartbeat lost");
    const cancelled = targetByBudget.get(8)!;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.beats_completed, 1);
    assert.equal(cancelled.last_error, null);
    for (const row of targetSessions) {
      assert.equal(row.world_id, SCOPE.worldId);
    }

    // ---- 幂等 replay：同存档同键 → 三段不重复 ------------------------------
    const replay = await restorer.restore(restoreInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, restored.recordId);
    assert.equal(replay.importedOutboxMessageCount, 4);
    assert.equal(replay.importedFirstNightCount, 1);
    assert.equal(replay.importedSelfPlaySessionCount, 3);
    const afterReplay = await ownerPool.query<{
      outbox: number;
      first_nights: number;
      self_play: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM outbox
           WHERE workspace_id = $1 AND record_id = $2) AS outbox,
         (SELECT count(*)::int FROM record_first_nights
           WHERE workspace_id = $1 AND record_id = $2) AS first_nights,
         (SELECT count(*)::int FROM record_self_play_sessions
           WHERE workspace_id = $1 AND record_id = $2) AS self_play`,
      [SCOPE.workspaceId, restored.recordId],
    );
    assert.deepEqual(afterReplay.rows[0], { outbox: 4, first_nights: 1, self_play: 3 });
    const baseline = await restoreArtifactCounts(ownerPool);

    // ---- 失败场景（全部 fail-closed + 零残留） ---------------------------
    const rebuildArchive = (outboxSection: RealmRuntimeSaveOutboxV1): RealmRuntimeSaveArchive => {
      // manifest 由合法原档派生（restorer 直接消费解析后的对象，不重演字节
      // 校验）——outbox 段在返回对象中被替换为精心构造的非法引用，驱动
      // restorer normalize 的 fail-closed 分支；契约层（build/parse）对同类
      // 损坏的拒绝由下方的字节级用例覆盖。
      const manifest = realmRuntimeSaveManifestFromData({
        engineApi: archive.manifest.engineApi,
        mode: archive.manifest.mode,
        world: archive.manifest.world,
        scope: archive.manifest.scope,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: archive.memory,
        outbox: archive.outbox,
        firstNight: archive.firstNight,
        selfPlay: archive.selfPlay,
      });
      return {
        manifest,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: archive.memory,
        outbox: outboxSection,
        firstNight: archive.firstNight,
        selfPlay: archive.selfPlay,
      };
    };
    const expectRestoreFailure = async (
      badArchive: RealmRuntimeSaveArchive,
      idempotencyKey: string,
      code: RealmRuntimeSaveRepositoryError["code"],
    ) => {
      await assert.rejects(
        restorer.restore({ ...restoreInput, archive: badArchive, idempotencyKey }),
        (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
          && error.code === code,
      );
      assert.deepEqual(
        await restoreArtifactCounts(ownerPool),
        baseline,
        `${code} 失败路径不得留下任何 restore 残留`,
      );
    };

    // F1：outbox 消息引用存档外 Event（跨 Record 引用等效形态）。
    await expectRestoreFailure(
      rebuildArchive({
        ...archive.outbox!,
        messages: archive.outbox!.messages.map((message, index) => index === 0
          ? { ...message, sourceEventId: "event_from_another_record" }
          : message),
      }),
      "save-async-bad-event-ref",
      "RUNTIME_SAVE_INVALID",
    );

    // 字节级损坏构造：替换 runtime/ 段并按损坏后内容重算 hash。
    const corruptedArchiveBytes = (
      entry: string,
      corrupted: Buffer,
    ): Uint8Array => {
      const recordEntry = Buffer.from(JSON.stringify(archive.record));
      const goalsEntry = Buffer.from(JSON.stringify(archive.goals));
      const runtimeFiles = new Map<string, Uint8Array>([
        ["runtime/record.json", recordEntry],
        ["runtime/goals.json", goalsEntry],
        [entry, corrupted],
      ]);
      const corruptedManifest: RealmRuntimeSaveManifestV2 = {
        ...archive.manifest,
        snapshot: {
          ...archive.manifest.snapshot,
          runtimeHash: computeRealmRuntimeSaveContentHash(runtimeFiles),
        },
      };
      return zipSync({
        "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(corruptedManifest)),
        "runtime/record.json": recordEntry,
        "runtime/goals.json": goalsEntry,
        [entry]: corrupted,
      });
    };
    const expectParseFailure = (bytes: Uint8Array, label: string) => {
      assert.throws(
        () => parseRealmRuntimeSaveArchive(bytes),
        (error: unknown) => error instanceof RealmRuntimeSaveError
          && error.code === "INVALID_SAVE",
        label,
      );
    };

    // F2：损坏 lease 元数据（delivering 消息缺 lease / lease 时间戳非法）。
    const deliveringIndex = archive.outbox!.messages.findIndex(
      (message) => message.state === "delivering",
    );
    assert.ok(deliveringIndex >= 0);
    const corruptedLease = archive.outbox!.messages.map((message, index) => index === deliveringIndex
      ? { ...message, leaseOwner: null, leaseExpiresAt: null }
      : message);
    expectParseFailure(
      corruptedArchiveBytes("runtime/outbox.json", Buffer.from(JSON.stringify({
        format: "realm-runtime-outbox",
        schemaVersion: 1,
        messages: corruptedLease,
      }))),
      "delivering 消息缺 lease 必须 fail-closed",
    );
    const corruptedLeaseTimestamp = archive.outbox!.messages.map((message, index) => index === deliveringIndex
      ? { ...message, leaseExpiresAt: "not-a-timestamp" }
      : message);
    expectParseFailure(
      corruptedArchiveBytes("runtime/outbox.json", Buffer.from(JSON.stringify({
        format: "realm-runtime-outbox",
        schemaVersion: 1,
        messages: corruptedLeaseTimestamp,
      }))),
      "lease 时间戳损坏必须 fail-closed",
    );

    // F3：delivered 终态消息混入存档段。
    expectParseFailure(
      corruptedArchiveBytes("runtime/outbox.json", Buffer.from(JSON.stringify({
        format: "realm-runtime-outbox",
        schemaVersion: 1,
        messages: [{
          ...archive.outbox!.messages[0]!,
          sourceMessageId: "ob_corrupt_delivered",
          dedupeKey: "save-async:corrupt-delivered",
          state: "delivered",
        }],
      }))),
      "delivered 终态消息不得进入存档",
    );

    // F4：first-night schema 损坏（非法状态枚举）。
    expectParseFailure(
      corruptedArchiveBytes("runtime/first-night.json", Buffer.from(JSON.stringify({
        format: "realm-runtime-first-night",
        schemaVersion: 1,
        entry: {
          state: "corrupted",
          attempts: 0,
          hookContent: "",
          suggestions: [],
          context: {},
        },
      }))),
      "first-night 非法状态枚举必须 fail-closed",
    );

    // F5：self-play schema 损坏（已拍数超过拍预算）。
    expectParseFailure(
      corruptedArchiveBytes("runtime/self-play.json", Buffer.from(JSON.stringify({
        format: "realm-runtime-self-play",
        schemaVersion: 1,
        sessions: [{
          sourceSessionId: "sp_corrupt",
          state: "completed",
          beatBudget: 3,
          beatsCompleted: 4,
          requestedBy: POSTGRES_DEMO_IDS.principal,
          lastError: null,
        }],
      }))),
      "self-play 超预算拍数必须 fail-closed",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "schema 损坏的存档不得触及任何目标表",
    );

    // F6：RLS/workspace boundary——observer、无 membership principal、
    // 跨 workspace 一律 WORLD_NOT_FOUND 且零残留。
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_observer', 'observer')
       ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_save_async_other', '其它工作台')
       ON CONFLICT (id) DO NOTHING`,
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_observer", idempotencyKey: "save-async-observer" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_nobody", idempotencyKey: "save-async-nobody" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, workspaceId: "ws_save_async_other", idempotencyKey: "save-async-ws" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "边界失败路径不得留下任何 restore 残留",
    );
  },
);
