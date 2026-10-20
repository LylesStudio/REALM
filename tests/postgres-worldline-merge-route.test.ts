/**
 * 批次 T10-B1——/api/worldline/merge 路由作用域与审计主体修复
 * （docs/development/T10-B1-GOVERNANCE-REACHABILITY.md §四）。
 * 真实临时 PG 库（t.after 拆库，不污染开发库）：缺失 worldId 400、未知世界
 * 404、成员 dryRun/merge 走解析 scope、请求体 operator 不得冒充审计主体、
 * source 世界线不存在 404、幂等重放同 mergeId。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresRecordRuntimeScopeRepository,
  createPostgresWorldlineMergeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { POST } from "../app/api/worldline/merge/route.ts";
import { endSharedRuntimePools, getSharedRuntimePool } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";
installTestSessionSecret();

// 新门禁（0051）：runtime DB 存在即要求账户会话；路由请求统一携带。
const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;

// Observe actual Client end events: pg-pool can resolve end() after removing
// idle clients but before their graceful Terminate has completed.
const fixtureShutdowns = new WeakMap<pg.Pool, Promise<void>[]>();
function observeFixturePool(pool: pg.Pool): pg.Pool {
  if (!fixtureShutdowns.has(pool)) {
    const shutdowns: Promise<void>[] = [];
    fixtureShutdowns.set(pool, shutdowns);
    pool.on("connect", client => {
      shutdowns.push(new Promise<void>(resolve => client.once("end", resolve)));
    });
  }
  return pool;
}
function createFixturePool(options: pg.PoolConfig): pg.Pool {
  return observeFixturePool(new pg.Pool(options));
}
async function endFixturePool(pool: pg.Pool): Promise<void> {
  await pool.end();
  await Promise.all(fixtureShutdowns.get(pool) ?? []);
}
async function assertFixtureBackendsGone(maintenance: pg.Client, name: string) {
  const remaining = await maintenance.query(
    "SELECT pid, state FROM pg_stat_activity WHERE datname = $1", [name],
  );
  assert.deepEqual(remaining.rows, [], "all fixture backends must end before DROP");
}

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
  // 合并物化经 restricted 角色写 participants/instances/continuities/record_heads
  // （0023）与 scenes/visibility_policies 全行（0056）。
  "0023_library_runtime_grants.sql",
  // Production Canon readback requires campaign revision and audience security.
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  // branch 命令现在创建可玩拓扑：scene 快照列（0029/0039/0040）与
  // records.timeline_kind='branch' 枚举（0044）。
  "0029_record_scene_tension.sql",
  "0039_scene_weather_snapshot.sql",
  "0040_scene_display_time_snapshot.sql",
  "0044_record_branch_timeline_kind.sql",
  "0053_membership_capability.sql",
  // Phase 1B：library list 读模型显式 SELECT worlds.world_version（0054 列）。
  "0054_world_version_identity.sql",
  // Phase 3：createRecordBranchInTransaction 物化 goal_instances（0055 表）。
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  // Phase 4D：records.world_version（branch/genesis 写路径显式携带）。
  "0057_realmworld_record_binding.sql",
  "0058_durable_job_queue.sql",
  "0060_goal_scope_terminal_lifecycle.sql",
  // Current branch readback unconditionally queries committed performance facts.
  "0066_committed_fact_commands.sql",
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

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/worldline/merge", {
    method: "POST",
    headers: { cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "T10-B1: merge route enforces explicit world scope and authenticated operator",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b1_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = createFixturePool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;

    const routePool = observeFixturePool(getSharedRuntimePool(runtimeUrl.href));
    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    // 路由级调用走本地回落身份（principal_demo_player）；摘除门禁，用后还原。
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    delete process.env.REALM_ACCESS_TOKEN;

    t.after(async () => {
      await endSharedRuntimePools();
      await Promise.all(fixtureShutdowns.get(routePool) ?? []);
      if (previousAccessToken === undefined) {
        delete process.env.REALM_ACCESS_TOKEN;
      } else {
        process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      }
      if (previousRuntimeUrl === undefined) {
        delete process.env.REALM_RUNTIME_DATABASE_URL;
      } else {
        process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      }
      await endFixturePool(ownerPool);
      await assertFixtureBackendsGone(maintenance, databaseName);
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)}`,
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

    // F1：缺失 worldId → 400。
    const missing = await POST(postJson({
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b1-missing",
    }));
    assert.equal(missing.status, 400);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "INVALID_REQUEST",
    );

    // F2：世界不存在 → 404（不泄露存在性）。
    const unknown = await POST(postJson({
      worldId: "world_nope",
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b1-unknown",
    }));
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await unknown.json()) as { error: { code: string } }).error.code,
      "WORLD_NOT_FOUND",
    );

    // 成员世界：新建世界 + 分支世界线（demo principal 是 owner）。
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: "ws_demo",
      sessionProof: sessionProofFor("principal_demo_player"),
      principalId: "principal_demo_player",
    };
    await library.create(scope, {
      kind: "world",
      name: "合并试验场",
      era: "并流纪元",
      summary: "两条世界线在此汇合。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "合并试验场",
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

    // 本切片 record_first_nights 仍 fail-closed（RECONCILE_UNSUPPORTED）：
    // 世界创建为 starter Record 写入 pending 状态行；本用例聚焦合并路由/
    // 审计/事件物化，清除该运行态行。
    await ownerPool.query(
      `DELETE FROM record_first_nights
       WHERE workspace_id = 'ws_demo' AND world_id = $1`,
      [world.id],
    );

    // dryRun 预览：200 preview，不落审计行。
    const dryRun = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-dry",
      dryRun: true,
      operator: "forged-admin",
    }));
    assert.equal(dryRun.status, 200);
    assert.equal(
      ((await dryRun.json()) as { status: string }).status,
      "preview",
    );
    let audit = await ownerPool.query(
      `SELECT count(*)::int AS count FROM worldline_merges WHERE idempotency_key = 't10b1-dry'`,
    );
    assert.equal(audit.rows[0].count, 0, "dryRun never persists an audit row");

    // 真实合并：审计行 operator = 已解析 principal，请求体 operator 被忽略。
    const merged = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-merge",
      operator: "forged-admin",
    }));
    assert.equal(merged.status, 200);
    const mergedBody = (await merged.json()) as {
      status: string;
      mergeId: string;
      mergedWorldlineId: string;
      report: {
        manifest: {
          ordinal: number;
          tick: number;
          worldOrdinal: number;
          eventId: string;
          targetEventId?: string;
          resolution: string;
        }[];
      };
    };
    assert.equal(mergedBody.status, "merged");
    // playable 物化：目标 Worldline/Record 全部 active，不再是 archived 占位。
    const mergedWorldline = await ownerPool.query(
      `SELECT status, head_tick::text, head_ordinal::text FROM worldlines
       WHERE workspace_id = 'ws_demo' AND id = $1`,
      [mergedBody.mergedWorldlineId],
    );
    assert.equal(mergedWorldline.rows.length, 1);
    assert.equal(mergedWorldline.rows[0].status, "active");
    const mergedRecordRows = await ownerPool.query(
      `SELECT id, status, timeline_kind, linked_record_id FROM records
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [mergedBody.mergedWorldlineId],
    );
    assert.ok(mergedRecordRows.rows.length >= 2);
    for (const row of mergedRecordRows.rows) {
      assert.equal(row.status, "active");
      assert.equal(row.timeline_kind, "merged");
      assert.ok(row.linked_record_id, "merged record keeps its source link");
    }
    // 目标事件实际复制：每条 manifest 命中一个目标事件，游标/ID 一致。
    const copiedEvents = await ownerPool.query(
      `SELECT id, record_id, world_tick::text, world_ordinal::text
       FROM events WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [mergedBody.mergedWorldlineId],
    );
    assert.equal(copiedEvents.rows.length, mergedBody.report.manifest.length);
    for (const entry of mergedBody.report.manifest) {
      const copied = copiedEvents.rows.find(
        (row) =>
          Number(row.world_tick) === entry.tick
          && Number(row.world_ordinal) === entry.worldOrdinal,
      );
      assert.ok(copied, "manifest entry must map to a copied target event");
      assert.equal(copied.id, entry.targetEventId);
      assert.notEqual(copied.id, entry.eventId);
    }
    // record_heads：每条目标 Record 都有 head（含空 Record 的零 head）。
    const mergedHeads = await ownerPool.query(
      `SELECT record_id FROM record_heads
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [mergedBody.mergedWorldlineId],
    );
    assert.equal(mergedHeads.rows.length, mergedRecordRows.rows.length);
    audit = await ownerPool.query(
      `SELECT operator, world_id FROM worldline_merges WHERE idempotency_key = 't10b1-merge'`,
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(
      audit.rows[0].operator,
      "principal_demo_player",
      "audit operator must be the resolved principal, never the request body",
    );
    assert.equal(audit.rows[0].world_id, world.id, "解析 scope 的世界");

    // F5：幂等重放同 mergeId。
    const replay = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-merge",
    }));
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as {
      mergeId: string;
      mergedWorldlineId: string;
    };
    assert.equal(replayBody.mergeId, mergedBody.mergeId);
    assert.equal(replayBody.mergedWorldlineId, mergedBody.mergedWorldlineId);
    // 重放不重复拓扑/事件。
    const afterReplayEvents = await ownerPool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
      [mergedBody.mergedWorldlineId],
    );
    assert.equal(afterReplayEvents.rows[0].count, mergedBody.report.manifest.length);

    // F3：source 世界线不存在 → 404 WORLDLINE_NOT_FOUND。
    const missingSource = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: "worldline_nope",
      idempotencyKey: "t10b1-missing-source",
    }));
    assert.equal(missingSource.status, 404);
    assert.equal(
      ((await missingSource.json()) as { error: { code: string } }).error.code,
      "WORLDLINE_NOT_FOUND",
    );
  },
);

/** 合并物化 slice 的一次性库脚手架：完整迁移链 + demo seed + 会话密钥。 */
async function createMergeSliceDatabase(
  t: test.TestContext,
  label: string,
): Promise<{ ownerPool: pg.Pool; runtimeUrl: URL; registerPool: (pool: pg.Pool) => pg.Pool }> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_merge_${label}_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = createFixturePool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;

  const routePool = observeFixturePool(getSharedRuntimePool(runtimeUrl.href));
  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
  process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
  delete process.env.REALM_ACCESS_TOKEN;

  const ownedPools = [ownerPool];
  const registerPool = (pool: pg.Pool) => {
    ownedPools.push(observeFixturePool(pool));
    return pool;
  };
  t.after(async () => {
    await endSharedRuntimePools();
    await Promise.all(fixtureShutdowns.get(routePool) ?? []);
    if (previousAccessToken === undefined) {
      delete process.env.REALM_ACCESS_TOKEN;
    } else {
      process.env.REALM_ACCESS_TOKEN = previousAccessToken;
    }
    if (previousRuntimeUrl === undefined) {
      delete process.env.REALM_RUNTIME_DATABASE_URL;
    } else {
      process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
    }
    await Promise.all(ownedPools.map(endFixturePool));
    await assertFixtureBackendsGone(maintenance, databaseName);
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)}`,
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
  return { ownerPool, runtimeUrl, registerPool };
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
    `SELECT id FROM records
     WHERE workspace_id = 'ws_demo' AND worldline_id = $1`,
    [branch!.id],
  );
  assert.equal(branchRecord.rows.length, 1);
  // 本切片 record_first_nights 仍 fail-closed：世界创建为 starter Record
  // 写入 pending 状态行；复用本脚手架的合并用例一律先清除该运行态行。
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
  };
}

/** 分支记录上补一条 committed 事件夹具（与真实提交同列形状）。 */
async function insertBranchCommittedEvent(
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
  assert.ok(scene.rows[0] && policy.rows[0], "branch record must carry scene+policy");
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

test(
  "merge materialization: bridgeable reschedule copies events into a playable target",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimeUrl, registerPool } = await createMergeSliceDatabase(t, "mat");
    const restrictedPool = registerPool(createFixturePool({
      connectionString: runtimeUrl.href,
      max: 1,
    }));
    restrictedPool.on("error", () => {});
    const { world, origin, branch, originRecordId, branchRecordId } =
      await createWorldWithBranch(ownerPool, "物化试验场");

    // 双侧同游标 (0,1) 各落一条真实形状的 committed 事件：不同发言者
    // → bridgeable，B 侧顺移到 (0,2)。
    await insertBranchCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: origin.id,
      recordId: originRecordId,
      eventId: "event_origin_voice",
      tick: 0,
      ordinal: 1,
      speaker: "旁白",
      text: "雾沿着石阶爬上防波堤。",
    });
    await insertBranchCommittedEvent(ownerPool, {
      worldId: world.id,
      worldlineId: branch.id,
      recordId: branchRecordId,
      eventId: "event_branch_voice",
      tick: 0,
      ordinal: 1,
      speaker: "塞娜",
      text: "塞娜在岔流里先一步抵达。",
    });

    const response = await POST(postJson({
      worldId: world.id,
      sourceA: origin.id,
      sourceB: branch.id,
      idempotencyKey: "mat-merge-1",
    }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      mergedWorldlineId: string;
      report: {
        manifest: {
          tick: number;
          worldOrdinal: number;
          eventId: string;
          targetEventId?: string;
          resolution: string;
        }[];
      };
    };
    assert.equal(body.status, "merged");
    assert.equal(body.report.manifest.length, 2);
    const rescheduled = body.report.manifest.find(
      (entry) => entry.eventId === "event_branch_voice",
    );
    assert.equal(rescheduled?.resolution, "rescheduled");
    // manifest 目标游标与目标事件行一致（bridgeable 顺移到 (0,2)）。
    assert.equal(rescheduled?.tick, 0);
    assert.equal(rescheduled?.worldOrdinal, 2);

    const mergedWorldline = await ownerPool.query(
      `SELECT status, head_tick::text, head_ordinal::text FROM worldlines
       WHERE workspace_id = 'ws_demo' AND id = $1`,
      [body.mergedWorldlineId],
    );
    assert.equal(mergedWorldline.rows[0].status, "active");
    assert.equal(Number(mergedWorldline.rows[0].head_tick), 0);
    assert.equal(Number(mergedWorldline.rows[0].head_ordinal), 2);

    // 目标事件：新 ID、目标 scope 外键、cursor 与 manifest 一致；源事件不变。
    const targetEvents = await ownerPool.query(
      `SELECT id, record_id, scene_id, visibility_policy_id,
              world_tick::text, world_ordinal::text, content
       FROM events
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
       ORDER BY world_tick, world_ordinal`,
      [body.mergedWorldlineId],
    );
    assert.equal(targetEvents.rows.length, 2);
    for (const entry of body.report.manifest) {
      const copied = targetEvents.rows.find(
        (row) =>
          Number(row.world_tick) === entry.tick
          && Number(row.world_ordinal) === entry.worldOrdinal,
      );
      assert.ok(copied);
      assert.equal(copied.id, entry.targetEventId);
      assert.notEqual(copied.id, entry.eventId);
    }
    const rescheduledRow = targetEvents.rows[1]!;
    assert.equal(rescheduledRow.content, "塞娜在岔流里先一步抵达。");
    const rescheduledScene = await ownerPool.query(
      `SELECT worldline_id, record_id FROM scenes
       WHERE workspace_id = 'ws_demo' AND id = $1`,
      [rescheduledRow.scene_id],
    );
    assert.equal(rescheduledScene.rows[0]?.worldline_id, body.mergedWorldlineId);
    assert.equal(rescheduledScene.rows[0]?.record_id, rescheduledRow.record_id);
    const sourceEventCount = await ownerPool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE workspace_id = 'ws_demo' AND worldline_id IN ($1, $2)`,
      [origin.id, branch.id],
    );
    assert.equal(sourceEventCount.rows[0].count, 2, "source events stay immutable");

    // 目标 Record 拓扑语义保留：参与者/实例/continuity/场景/策略/技能/资产。
    const targetTopology = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM participants
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS participants,
         (SELECT count(*)::int FROM character_instances
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS instances,
         (SELECT count(*)::int FROM character_continuities
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS continuities,
         (SELECT count(*)::int FROM scenes
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS scenes,
         (SELECT count(*)::int FROM visibility_policies
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS policies,
         (SELECT count(*)::int FROM character_skills
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS skills,
         (SELECT count(*)::int FROM character_assets
          WHERE workspace_id = 'ws_demo' AND worldline_id = $1) AS assets`,
      [body.mergedWorldlineId],
    );
    assert.ok(targetTopology.rows[0].participants >= 2, "both records' casts");
    assert.ok(targetTopology.rows[0].instances >= 2);
    // 双侧 continuity_key='player' 折成一行。
    assert.equal(targetTopology.rows[0].continuities, 1);
    assert.ok(targetTopology.rows[0].scenes >= 2);
    assert.ok(targetTopology.rows[0].policies >= 2);
    assert.ok(targetTopology.rows[0].skills >= 2);
    assert.ok(targetTopology.rows[0].assets >= 1);

    // playable 读路径：合并 Record 经生产 record-scope 解析出完整回合上下文。
    const originCopy = await ownerPool.query(
      `SELECT id FROM records
       WHERE workspace_id = 'ws_demo' AND worldline_id = $1
         AND linked_record_id = $2`,
      [body.mergedWorldlineId, originRecordId],
    );
    assert.equal(originCopy.rows.length, 1);
    // Eligible Canon in the actual merged worldline must survive the real
    // restricted scope loader; an empty fail-closed fallback is insufficient.
    await ownerPool.query(
      `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name)
       VALUES ('ws_demo', $1, $2, 'c5_merge_canon_entity', 'setting', 'C5 merge beacon')`,
      [world.id, body.mergedWorldlineId],
    );
    await ownerPool.query(
      `INSERT INTO world_claims (workspace_id, world_id, worldline_id, id, subject_entity_id,
                                 predicate, object_value, scope, truth_status)
       VALUES ('ws_demo', $1, $2, 'c5_merge_canon_claim', 'c5_merge_canon_entity',
               'signals', 'C5 merge Canon positive', 'world', 'world_canon')`,
      [world.id, body.mergedWorldlineId],
    );
    const role = await restrictedPool.query("SELECT current_user AS role");
    assert.equal(role.rows[0]?.role, "realm_runtime");
    const scopeReader = createPostgresRecordRuntimeScopeRepository(restrictedPool);
    const resolved = await scopeReader.resolve({
      workspaceId: "ws_demo",
      principalId: "principal_demo_player",
      recordId: originCopy.rows[0].id,
    });
    assert.ok(resolved, "merged record must resolve through the production read path");
    assert.equal(resolved.worldlineId, body.mergedWorldlineId);
    assert.ok(resolved.sceneId);
    assert.ok(resolved.publicPolicyId);
    assert.ok(resolved.brief.canon.includes("C5 merge Canon positive"),
      "restricted production Canon loader must return the eligible claim");

    // 同一 workspace 之外不可读写（restricted 角色 + RLS）。
    const mergeRepository = createPostgresWorldlineMergeRepository(restrictedPool);
    const crossRead = await mergeRepository.loadMergeSource({
      workspaceId: "ws_other",
      worldId: world.id,
      worldlineId: origin.id,
    });
    assert.equal(crossRead.records.length, 0);
    assert.equal(crossRead.events.length, 0);
    assert.equal(
      await mergeRepository.findMergeByIdempotencyKey("ws_other", "mat-merge-1"),
      null,
    );
  },
);

test(
  "merge materialization rejects hard conflicts, unsupported runtime and rolls back on failure",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool } = await createMergeSliceDatabase(t, "rej");

    // 场景一：注入故障（revoke scenes INSERT）→ 物化中段失败，整体回滚。
    const injected = await createWorldWithBranch(ownerPool, "回滚试验场");
    await ownerPool.query(`REVOKE INSERT ON scenes FROM realm_runtime`);
    const failed = await POST(postJson({
      worldId: injected.world.id,
      sourceA: injected.origin.id,
      sourceB: injected.branch.id,
      idempotencyKey: "rej-rollback",
    }));
    assert.equal(failed.status, 500);
    assert.equal(
      ((await failed.json()) as { error: { code: string } }).error.code,
      "INTERNAL_ERROR",
    );
    // 零残留：无目标 worldline/story/record/head/scene/policy/participant/
    // event，也没有半提交的审计行。
    const residue = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM worldlines
          WHERE workspace_id = 'ws_demo' AND world_id = $1
            AND id LIKE 'worldline\\_merge\\_%') AS worldlines,
         (SELECT count(*)::int FROM stories
          WHERE workspace_id = 'ws_demo' AND world_id = $1
            AND id LIKE 'story\\_merge\\_%') AS stories,
         (SELECT count(*)::int FROM records
          WHERE workspace_id = 'ws_demo' AND world_id = $1
            AND timeline_kind = 'merged') AS records,
         (SELECT count(*)::int FROM worldline_merges
          WHERE workspace_id = 'ws_demo' AND idempotency_key = 'rej-rollback')
          AS audits`,
      [injected.world.id],
    );
    assert.deepEqual(residue.rows[0], {
      worldlines: 0,
      stories: 0,
      records: 0,
      audits: 0,
    });
    await ownerPool.query(`GRANT INSERT ON scenes TO realm_runtime`);

    // 恢复授权后同一世界可正常合并（无楔死状态）。
    const recovered = await POST(postJson({
      worldId: injected.world.id,
      sourceA: injected.origin.id,
      sourceB: injected.branch.id,
      idempotencyKey: "rej-recovered",
    }));
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { status: string }).status, "merged");

    // 场景二：hard 冲突 → rejected 审计 + 零拓扑。
    const hard = await createWorldWithBranch(ownerPool, "硬冲突试验场");
    await insertBranchCommittedEvent(ownerPool, {
      worldId: hard.world.id,
      worldlineId: hard.origin.id,
      recordId: hard.originRecordId,
      eventId: "event_hard_origin",
      tick: 0,
      ordinal: 1,
      speaker: "旁白",
      text: "旁白在原初世界线说的句子。",
    });
    await insertBranchCommittedEvent(ownerPool, {
      worldId: hard.world.id,
      worldlineId: hard.branch.id,
      recordId: hard.branchRecordId,
      eventId: "event_hard_voice",
      tick: 0,
      ordinal: 1,
      speaker: "旁白",
      text: "旁白在岔流里说出完全不同的句子。",
    });
    const hardResponse = await POST(postJson({
      worldId: hard.world.id,
      sourceA: hard.origin.id,
      sourceB: hard.branch.id,
      idempotencyKey: "rej-hard",
    }));
    assert.equal(hardResponse.status, 409);
    const hardBody = (await hardResponse.json()) as { status: string };
    assert.equal(hardBody.status, "rejected");
    const hardTopology = await ownerPool.query(
      `SELECT
         (SELECT count(*)::int FROM worldlines
          WHERE workspace_id = 'ws_demo' AND world_id = $1) AS worldlines,
         (SELECT count(*)::int FROM records
          WHERE workspace_id = 'ws_demo' AND world_id = $1
            AND timeline_kind = 'merged') AS records,
         (SELECT status FROM worldline_merges
          WHERE workspace_id = 'ws_demo' AND idempotency_key = 'rej-hard') AS status`,
      [hard.world.id],
    );
    assert.equal(hardTopology.rows[0].worldlines, 2, "no merged worldline");
    assert.equal(hardTopology.rows[0].records, 0);
    assert.equal(hardTopology.rows[0].status, "rejected");

    // 场景三：Goal runtime 运行态 → RECONCILE_UNSUPPORTED + rejected 审计 + 零拓扑。
    const goal = await createWorldWithBranch(ownerPool, "目标试验场");
    await ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         policy_version
       ) VALUES ('ws_demo', $1, $2, $3, 'goal_fixture_1', 'goal_key_1', 'v1')`,
      [goal.world.id, goal.origin.id, goal.originRecordId],
    );
    const unsupported = await POST(postJson({
      worldId: goal.world.id,
      sourceA: goal.origin.id,
      sourceB: goal.branch.id,
      idempotencyKey: "rej-unsupported",
    }));
    assert.equal(unsupported.status, 409);
    const unsupportedBody = (await unsupported.json()) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(unsupportedBody.ok, false);
    assert.equal(unsupportedBody.error.code, "RECONCILE_UNSUPPORTED");
    const unsupportedAudit = await ownerPool.query(
      `SELECT status, conflict_report FROM worldline_merges
       WHERE workspace_id = 'ws_demo' AND idempotency_key = 'rej-unsupported'`,
    );
    assert.equal(unsupportedAudit.rows.length, 1);
    assert.equal(unsupportedAudit.rows[0].status, "rejected");
    const unsupportedList = (
      unsupportedAudit.rows[0].conflict_report as {
        unsupported?: { recordId: string; reasons: string[] }[];
      }
    ).unsupported;
    assert.ok(unsupportedList);
    assert.deepEqual(unsupportedList[0]?.recordId, goal.originRecordId);
    assert.ok(unsupportedList[0]?.reasons.includes("goal_instances"));
    const unsupportedTopology = await ownerPool.query(
      `SELECT count(*)::int AS count FROM records
       WHERE workspace_id = 'ws_demo' AND world_id = $1
         AND timeline_kind = 'merged'`,
      [goal.world.id],
    );
    assert.equal(unsupportedTopology.rows[0].count, 0, "zero topology on unsupported");
    // 幂等重放返回首次的同一业务错误，不重复写审计。
    const unsupportedReplay = await POST(postJson({
      worldId: goal.world.id,
      sourceA: goal.origin.id,
      sourceB: goal.branch.id,
      idempotencyKey: "rej-unsupported",
    }));
    assert.equal(unsupportedReplay.status, 409);
    assert.equal(
      ((await unsupportedReplay.json()) as { error: { code: string } }).error.code,
      "RECONCILE_UNSUPPORTED",
    );
    const auditCount = await ownerPool.query(
      `SELECT count(*)::int AS count FROM worldline_merges
       WHERE workspace_id = 'ws_demo' AND idempotency_key = 'rej-unsupported'`,
    );
    assert.equal(auditCount.rows[0].count, 1);
  },
);

/** 批次 T10-B3：console.error 捕获（只进不出敏感材料的断言载体）。 */
function captureConsoleError() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function assertSanitizedInternalLog(line: string, route: string, stage: string) {
  assert.ok(
    line.startsWith("[realm] route internal failure "),
    `log must carry the stable prefix, got: ${line}`,
  );
  const fields = JSON.parse(
    line.slice("[realm] route internal failure ".length),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fields).sort(), ["code", "errorType", "route", "stage"]);
  assert.equal(fields.route, route);
  assert.equal(fields.stage, stage);
  // 严禁字段：连接串/库名/message/stack/请求内容。
  for (const forbidden of [
    "postgresql",
    "127.0.0.1",
    "realm_unavailable",
    "connect",
    "forged",
    "claim_",
    "sourceA",
    " at ",
  ]) {
    assert.ok(!line.includes(forbidden), `log must not contain ${forbidden}`);
  }
}

test("T10-B3: merge internal DB failure keeps 500 and logs only sanitized fields", async (t) => {
  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
  process.env.REALM_RUNTIME_DATABASE_URL =
    "postgresql://realm_runtime@127.0.0.1:1/realm_unavailable";
  delete process.env.REALM_ACCESS_TOKEN;
  t.after(async () => {
    await endSharedRuntimePools();
    if (previousAccessToken === undefined) {
      delete process.env.REALM_ACCESS_TOKEN;
    } else {
      process.env.REALM_ACCESS_TOKEN = previousAccessToken;
    }
    if (previousRuntimeUrl === undefined) {
      delete process.env.REALM_RUNTIME_DATABASE_URL;
    } else {
      process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
    }
  });

  const capture = captureConsoleError();
  try {
    const response = await POST(postJson({
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b3-merge-down",
      operator: "forged-admin",
    }));
    assert.equal(response.status, 500, "HTTP 契约不变");
    assert.deepEqual(
      ((await response.json()) as { error: { code: string } }).error.code,
      "INTERNAL_ERROR",
    );
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1, "恰一行内部诊断");
  assertSanitizedInternalLog(capture.lines[0]!, "worldline/merge", "request");
});
