/**
 * 批次 T7 世界自演——PostgreSQL 集成测试
 * （public documentation §4.3）。
 * 覆盖：迁移 0020 应用与授权（realm_runtime 真实角色）、会话账本状态机
 * （start 幂等/拍记账/stop/finish/failStale/部分唯一索引/RLS 隔离）、
 * 自演拍经真实 PG 运行时落库（metadata.selfPlay 标记、头指针连续、无玩家事件）、
 * delivery 投影透出 selfPlay、观察者 membership 同权可见、restricted 过滤不受
 * 自演影响。编排器为既有 createLocalM2TurnOrchestrator，不依赖真实模型。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresActionAffordanceCatalog,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresSelfPlayStore } from "../database/postgres/self-play-store.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";

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

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_t7_test_${randomUUID().replaceAll("-", "")}`;
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
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });

  t.after(async () => {
    await ownerPool.end();
    await runtimePool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  return { ownerPool, runtimePool };
}

test(
  "T7 PG: self-play beats commit through the real runtime with markers, ledger and observer visibility",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    // 全部账本写入走受限 realm_runtime 角色，验证 0020 授权真实存在。
    const store = createPostgresSelfPlayStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);

    let sequence = 0;
    const repository = createPostgresRuntimeRepository<
      { text: string; visibility: TurnVisibilityPlan },
      M2TurnPlan,
      M2TurnCandidate,
      M2TurnValidation,
      {
        schemaVersion: 1;
        role: "player" | "character" | "narrator" | "system";
        speaker: string;
        participantId: string | null;
        content: string;
        segments: readonly SemanticSegment[];
        actionTransaction?: ActionTransaction;
        selfPlay?: { beat: number };
      },
      { recordId: string; eventIds: readonly string[] }
    >({
      pool: ownerPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      mapFormalEvent: mapLocalFormalEvent,
      allocateWorldCursors({ previous, eventCount }) {
        return Array.from({ length: eventCount }, (_, index) => ({
          tick: previous.tick,
          ordinal: previous.ordinal + index + 1,
          calendarId: previous.calendarId,
          display: "测试时间",
        }));
      },
    });
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
      selfPlayStore: store,
      selfPlayBeatBudget: 2,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `t7-token-${++sequence}`,
        clock: () => new Date("2026-08-21T00:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-21T00:00:00.000Z"),
      idFactory: () => `t7-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    // ---- start → 拍循环 → completed（幂等重入顺带验证）----
    const session = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
    assert.equal(session.state, "running");
    assert.equal(session.beatBudget, 2);
    const reentry = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
    assert.equal(reentry.id, session.id, "start 幂等重入返回活动会话");

    let final = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      final = await store.load(session.id);
      if (final && ["completed", "failed", "cancelled"].includes(final.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(final?.state, "completed");
    assert.equal(final?.beatsCompleted, 2);
    assert.equal(final?.lastError, null);

    // ---- 落库核验：metadata.selfPlay 标记 + 头指针连续 + 无玩家事件 ----
    const eventRows = await ownerPool.query(
      `SELECT id, event_kind, speaker_name, payload
       FROM events WHERE record_id = $1 ORDER BY record_ordinal ASC`,
      [LOCAL_RECORD_SCOPE.recordId],
    );
    const selfPlayRows = eventRows.rows.filter(
      (row) => (row.payload as { selfPlay?: unknown }).selfPlay !== undefined,
    );
    assert.ok(selfPlayRows.length >= 2, "self-play events must persist");
    const beats = [...new Set(selfPlayRows.map((row) =>
      (row.payload as { selfPlay: { beat: number } }).selfPlay.beat)
    )].sort();
    assert.deepEqual(beats, [1, 2]);
    assert.ok(
      selfPlayRows.some((row) => row.event_kind === "narration.committed"),
      "each beat carries narration",
    );
    const playerRows = await ownerPool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE record_id = $1 AND event_kind = 'utterance.committed'
         AND payload->'selfPlay' IS NULL`,
      [LOCAL_RECORD_SCOPE.recordId],
    );
    assert.equal(playerRows.rows[0].count, 0, "self-play never commits player events");

    const head = await ownerPool.query(
      `SELECT record_version, next_record_ordinal, last_world_ordinal
       FROM record_heads WHERE record_id = $1`,
      [LOCAL_RECORD_SCOPE.recordId],
    );
    assert.equal(
      Number(head.rows[0].last_world_ordinal),
      eventRows.rows.length,
      "world ordinals stay dense",
    );
    // 种子 v1 + 两拍各一版。
    assert.equal(Number(head.rows[0].record_version), 3);

    // observations 随自演事件落库（记忆管线可消费）。
    const observationCount = await ownerPool.query(
      `SELECT count(*)::int AS count FROM observations
       WHERE record_id = $1 AND source_event_id = $2`,
      [LOCAL_RECORD_SCOPE.recordId, selfPlayRows[0].id],
    );
    assert.ok(observationCount.rows[0].count >= 1);

    // ---- delivery 投影透出 selfPlay + 观察者 membership 同权可见 ----
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, "principal_observer", "旁观者"],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, principal_id, world_id, role,
         omniscient_player_character, can_view_dynamic_knowledge
       ) VALUES ($1, $2, $3, 'observer', true, true)
       ON CONFLICT DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, "principal_observer", "world_ember_coast"],
    );
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const observerView = await projection.loadForPlayer({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
      principalId: "principal_observer",
    });
    assert.ok(observerView, "observer membership resolves a projection");
    const observerSelfPlayEvents = observerView!.events.filter(
      (event) => event.selfPlay !== undefined,
    );
    assert.ok(
      observerSelfPlayEvents.length >= 2,
      "observer sees self-play events (omniscient member flag, same SQL path)",
    );
    assert.deepEqual(
      [...new Set(observerSelfPlayEvents.map((event) => event.selfPlay!.beat))]
        .sort(),
      [1, 2],
    );

    // ---- 对照：非 omniscient 视角不因为是自演而放大可见性 ----
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, "principal_plain", "普通成员"],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, principal_id, world_id, role,
         omniscient_player_character, can_view_dynamic_knowledge
       ) VALUES ($1, $2, $3, 'player', false, false)
       ON CONFLICT DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, "principal_plain", "world_ember_coast"],
    );
    const plainView = await projection.loadForPlayer({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
      principalId: "principal_plain",
    });
    assert.ok(plainView, "plain member resolves a projection");
    // 自演事件是 public：普通成员可见（自演不制造秘密，也不放大可见性）。
    assert.ok(
      plainView!.events.some((event) => event.selfPlay !== undefined),
    );
    assert.ok(
      plainView!.events.every((event) => event.visibility === "public"),
      "no non-public event leaks to a non-omniscient viewer",
    );
  },
);

test(
  "T7 PG: session ledger guards — idempotent start, single active row, stop/finish/stale transitions, RLS isolation",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const store = createPostgresSelfPlayStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);

    // start → running；重复 start 幂等返回同行。
    const { session, created } = await store.start({
      sessionId: "selfplay_t7_guard",
      recordId: LOCAL_RECORD_SCOPE.recordId,
      worldId: "world_ember_coast",
      beatBudget: 3,
      requestedBy: LOCAL_RECORD_SCOPE.principalId,
    });
    assert.equal(created, true);
    assert.equal(session.state, "running");
    const again = await store.start({
      sessionId: "selfplay_t7_guard_2",
      recordId: LOCAL_RECORD_SCOPE.recordId,
      worldId: "world_ember_coast",
      beatBudget: 3,
      requestedBy: LOCAL_RECORD_SCOPE.principalId,
    });
    assert.equal(again.created, false);
    assert.equal(again.session.id, session.id);

    // 部分唯一索引：并发直接 INSERT 第二条活动行被拒绝。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO record_self_play_sessions (
           workspace_id, id, record_id, world_id, state, beat_budget, requested_by
         ) VALUES ($1, $2, $3, $4, 'running', 1, $5)`,
        [
          LOCAL_RECORD_SCOPE.workspaceId,
          "selfplay_t7_illegal",
          LOCAL_RECORD_SCOPE.recordId,
          "world_ember_coast",
          LOCAL_RECORD_SCOPE.principalId,
        ],
      ),
      /duplicate key|unique/i,
    );

    // 拍记账 → stop → 拍边界收束（stopping 下 completeBeat 仍记账）。
    const counted = await store.completeBeat(session.id);
    assert.equal(counted?.beatsCompleted, 1);
    const stopping = await store.requestStop(LOCAL_RECORD_SCOPE.recordId);
    assert.equal(stopping?.state, "stopping");
    const countedUnderStopping = await store.completeBeat(session.id);
    assert.equal(countedUnderStopping?.beatsCompleted, 2);
    await store.finish(session.id, "cancelled");
    const cancelled = await store.load(session.id);
    assert.equal(cancelled?.state, "cancelled");
    assert.equal(cancelled?.beatsCompleted, 2);

    // 终态守卫：finish 对已终态行零影响；终态后可开新会话。
    await store.finish(session.id, "completed");
    assert.equal((await store.load(session.id))?.state, "cancelled");
    const next = await store.start({
      sessionId: "selfplay_t7_next",
      recordId: LOCAL_RECORD_SCOPE.recordId,
      worldId: "world_ember_coast",
      beatBudget: 99,
      requestedBy: LOCAL_RECORD_SCOPE.principalId,
    });
    assert.equal(next.created, true);
    assert.equal(next.session.beatBudget, 5, "预算钳制到硬上限");
    await store.finish(next.session.id, "failed", "DM_OUTPUT_REJECTED");
    const failed = await store.load(next.session.id);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.lastError, "DM_OUTPUT_REJECTED");

    // failStale 懒恢复：活动行心跳老化 → failed(SELFPLAY_STALE)。
    const stale = await store.start({
      sessionId: "selfplay_t7_stale",
      recordId: LOCAL_RECORD_SCOPE.recordId,
      worldId: "world_ember_coast",
      beatBudget: 3,
      requestedBy: LOCAL_RECORD_SCOPE.principalId,
    });
    assert.equal(stale.created, true);
    await ownerPool.query(
      `UPDATE record_self_play_sessions
       SET updated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
       WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, stale.session.id],
    );
    await store.failStale(
      LOCAL_RECORD_SCOPE.recordId,
      new Date(Date.now() - 5 * 60 * 1000),
    );
    const staleAfter = await store.load(stale.session.id);
    assert.equal(staleAfter?.state, "failed");
    assert.equal(staleAfter?.lastError, "SELFPLAY_STALE");

    // RLS 隔离：另一个 workspace 视角读不到本会话行（受限角色实测）。
    const foreign = createPostgresSelfPlayStore(runtimePool, "workspace_foreign");
    assert.equal(await foreign.findLatest(LOCAL_RECORD_SCOPE.recordId), null);
    assert.equal(await foreign.load(session.id), null);
  },
);
