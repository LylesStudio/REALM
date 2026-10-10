/**
 * 分支管理（BRANCH-TREE-RESEARCH P0+P1）PostgreSQL 集成测试。
 *
 * 真实临时 PG 库（t.after 拆库，不污染开发库；scratch harness 提供
 * DATABASE_URL / REALM_RUNTIME_DATABASE_URL）：
 * - 树投影：骨架/谱系/当前标记/非成员 fail-closed/归档 tombstone；
 * - 可玩分支：head 分叉、事件边界分叉、fork 校验负例（未来/越界/空洞/
 *   他 record 事件/归档源/无权限）、原子拓扑、幂等重放、并发串行；
 * - 隔离：父 record 后续推进不写进子线；events 不复制；
 * - 回归：duplicate/retrospection 语义不变；kind:"branch" 幽灵路径已废弃。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  enqueueGoalAssessmentJobsForCommittedEvents,
} from "../database/postgres/goal-runtime-materialization.ts";
import { loadBranchTree } from "../modules/application/branch-tree.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  goalAssessmentJobIdFor,
  goalInstanceIdFor,
} from "../modules/goals/public.ts";
import {
  executeTurn,
  type JsonValue,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { POST as branchPOST } from "../app/api/record/branch/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";
installTestSessionSecret();

// 新门禁（0051）：runtime DB 存在即要求账户会话；路由请求统一携带。
const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const WS = "ws_demo";
const OWNER = "principal_demo_player";
const STRANGER = "principal_stranger_branch";

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

interface Fixture {
  ownerPool: pg.Pool;
  runtimePool: pg.Pool;
  worldId: string;
  worldlineId: string;
  storyId: string;
  recordId: string;
  sceneId: string;
  policyId: string;
  calendarId: string;
}

async function createFixtureDatabase(t: test.TestContext): Promise<Fixture> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_branch_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 4 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });

  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
  // 路由级调用走本地回落身份；摘除门禁，用后还原。
  process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
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
    await ownerPool.end();
    await runtimePool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  // 全链迁移（0001–0044，按文件名排序，与本仓 runner 同序）。
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
    await seedCapabilitySessionKey(ownerPool, WS);

  // 隔离世界 + 起始记录（owner = OWNER）。
  const library = createPostgresLibraryService(ownerPool);
  const scope = { workspaceId: WS, principalId: OWNER, sessionProof: sessionProofFor(OWNER) };
  await library.create(scope, {
    kind: "world",
    name: "分支试验场",
    era: "并流纪元",
    summary: "分支树集成测试隔离世界。",
  });
  const snapshot = await library.list(scope);
  const world = snapshot.worlds.find((item) => item.name === "分支试验场")!;
  const story = world.stories[0]!;
  const record = story.records[0]!;
  const worldlineId = world.worldlines[0]!.id;
  const ids = await ownerPool.query<{
    scene_id: string;
    policy_id: string;
    calendar_id: string;
  }>(
    `SELECT scene.id AS scene_id, policy.id AS policy_id, world.calendar_id
     FROM worlds AS world
     JOIN LATERAL (
       SELECT id FROM scenes
       WHERE workspace_id = world.workspace_id AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC LIMIT 1
     ) AS scene ON true
     JOIN LATERAL (
       SELECT id FROM visibility_policies
       WHERE workspace_id = world.workspace_id AND record_id = $2
       LIMIT 1
     ) AS policy ON true
     WHERE world.workspace_id = $1 AND world.id = $3`,
    [WS, record.id, world.id],
  );
  const row = ids.rows[0]!;
  return {
    ownerPool,
    runtimePool,
    worldId: world.id,
    worldlineId,
    storyId: story.id,
    recordId: record.id,
    sceneId: row.scene_id,
    policyId: row.policy_id,
    calendarId: row.calendar_id,
  };
}

/** 向源 record 追加一条已提交事件并推进 record/worldline 游标。 */
async function commitSyntheticEvent(
  pool: pg.Pool,
  fixture: Fixture,
  input: { tick: number; ordinal: number; recordOrdinal: number; content: string },
) {
  const eventId = `event_branch_test_${input.recordOrdinal}`;
  await pool.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, 0, 'narration.committed',
       NULL, '旁白', $9, '{}'::jsonb, $10, $11, $12, $13, '测试时间'
     )`,
    [
      WS,
      fixture.worldId,
      fixture.worldlineId,
      fixture.recordId,
      fixture.sceneId,
      eventId,
      input.recordOrdinal,
      input.recordOrdinal,
      input.content,
      fixture.policyId,
      input.tick,
      input.ordinal,
      fixture.calendarId,
    ],
  );
  await pool.query(
    `UPDATE record_heads
     SET record_version = $3, next_record_ordinal = $4,
         last_event_id = $5, last_world_tick = $6, last_world_ordinal = $7
     WHERE workspace_id = $1 AND record_id = $2`,
    [
      WS,
      fixture.recordId,
      input.recordOrdinal,
      input.recordOrdinal + 1,
      eventId,
      input.tick,
      input.ordinal,
    ],
  );
  await pool.query(
    `UPDATE worldlines SET head_tick = $3, head_ordinal = $4
     WHERE workspace_id = $1 AND id = $2`,
    [WS, fixture.worldlineId, input.tick, input.ordinal],
  );
  return eventId;
}

const SCOPE = { workspaceId: WS, principalId: OWNER, sessionProof: sessionProofFor(OWNER) };

test(
  "branch tree projection: lineage, current marker, tombstones, membership fail-closed",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const fixture = await createFixtureDatabase(t);
    const eventId1 = await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 10, ordinal: 1, recordOrdinal: 1, content: "第一段。",
    });
    await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 10, ordinal: 2, recordOrdinal: 2, content: "第二段。",
    });

    // 基线：只有原初世界线，含起始 story/record，head 已推进。
    const before = await loadBranchTree(fixture.ownerPool, {
      ...SCOPE,
      worldId: fixture.worldId,
      currentRecordId: fixture.recordId,
    });
    assert.ok(before);
    assert.equal(before.world.name, "分支试验场");
    assert.equal(before.worldlines.length, 1);
    assert.equal(before.worldlines[0]!.parentWorldlineId, null);
    assert.deepEqual(before.worldlines[0]!.head, { tick: 10, ordinal: 2 });
    assert.equal(before.currentRecordId, fixture.recordId);
    assert.equal(before.currentWorldlineId, fixture.worldlineId);
    assert.equal(before.worldlines[0]!.records[0]!.timelineKind, "primary");
    assert.deepEqual(before.worldlines[0]!.records[0]!.head, { tick: 10, ordinal: 2 });

    // 事件边界分叉 → 树上出现子节点（parent/fork 正确）。
    const library = createPostgresLibraryService(fixture.ownerPool);
    const branched = await library.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      fork: { eventId: eventId1 },
      label: "支流甲",
      recordTitle: "支流甲记录",
      idempotencyKey: "tree-projection-1",
    });
    assert.equal(branched.replayed, false);
    assert.deepEqual(branched.fork, { tick: 10, ordinal: 1 });

    const after = await loadBranchTree(fixture.ownerPool, {
      ...SCOPE,
      worldId: fixture.worldId,
      currentRecordId: branched.recordId,
    });
    assert.ok(after);
    assert.equal(after.worldlines.length, 2);
    const child = after.worldlines.find((line) => line.id === branched.worldlineId)!;
    assert.equal(child.parentWorldlineId, fixture.worldlineId);
    assert.deepEqual(child.fork, { tick: 10, ordinal: 1 });
    assert.deepEqual(child.head, { tick: 10, ordinal: 1 });
    assert.equal(child.label, "支流甲");
    const childRecord = child.records[0]!;
    assert.equal(childRecord.timelineKind, "branch");
    assert.equal(childRecord.linkedRecordId, fixture.recordId);
    assert.equal(childRecord.title, "支流甲记录");
    assert.deepEqual(childRecord.start, { tick: 10, ordinal: 1 });
    assert.equal(after.currentWorldlineId, branched.worldlineId);

    // 归档 record 以 tombstone 保留（树不因归档丢谱系）。
    await library.create(SCOPE, {
      kind: "delete-record",
      worldId: fixture.worldId,
      recordId: branched.recordId,
    });
    const withTombstone = await loadBranchTree(fixture.ownerPool, {
      ...SCOPE,
      worldId: fixture.worldId,
    });
    const archivedRecord = withTombstone!.worldlines
      .find((line) => line.id === branched.worldlineId)!
      .records.find((record) => record.id === branched.recordId)!;
    assert.equal(archivedRecord.status, "archived");

    // 非成员 fail-closed（不泄露存在性）；recordId 不属于本世界 → 不回显。
    const stranger = await loadBranchTree(fixture.ownerPool, {
      workspaceId: WS,
      principalId: STRANGER,
      worldId: fixture.worldId,
    });
    assert.equal(stranger, null);
    const foreignRecord = await loadBranchTree(fixture.ownerPool, {
      ...SCOPE,
      worldId: fixture.worldId,
      currentRecordId: "record_first_watch", // demo 世界的 record，不属于本世界
    });
    assert.equal(foreignRecord!.currentRecordId, null);
    assert.equal(foreignRecord!.currentWorldlineId, null);
  },
);

test(
  "branch creation: fork validation, atomic topology, idempotency, concurrency, isolation",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const fixture = await createFixtureDatabase(t);
    await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 20, ordinal: 1, recordOrdinal: 1, content: "起点之后。",
    });
    const eventId2 = await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 20, ordinal: 2, recordOrdinal: 2, content: "中段。",
    });
    await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 20, ordinal: 3, recordOrdinal: 3, content: "当前进度。",
    });
    // runtime 池服务：证明 realm_runtime 角色即可完成全部分支写（与生产
    // /api/record/branch 同池），owner 池只作读回对照。
    const runtimeLibrary = createPostgresLibraryService(fixture.runtimePool);
    const ownerLibrary = createPostgresLibraryService(fixture.ownerPool);

    // ---- head 分叉（缺省 fork）----
    const headBranch = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      idempotencyKey: "head-branch-1",
    });
    assert.deepEqual(headBranch.fork, { tick: 20, ordinal: 3 });

    // 原子拓扑读回：worldline/story/record/record_heads/scene 一致。
    const topology = await fixture.ownerPool.query<{
      worldline_parent: string | null;
      fork_tick: string;
      head_tick: string;
      story_count: string;
      record_kind: string;
      linked: string | null;
      head_last_tick: string | null;
      event_count: string;
      scene_count: string;
    }>(
      `SELECT line.parent_worldline_id AS worldline_parent,
              line.fork_tick::text, line.head_tick::text,
              (SELECT count(*) FROM stories
               WHERE workspace_id = line.workspace_id AND worldline_id = line.id) AS story_count,
              record.timeline_kind AS record_kind,
              record.linked_record_id AS linked,
              head.last_world_tick::text AS head_last_tick,
              (SELECT count(*) FROM events
               WHERE workspace_id = record.workspace_id AND record_id = record.id) AS event_count,
              (SELECT count(*) FROM scenes
               WHERE workspace_id = record.workspace_id AND record_id = record.id) AS scene_count
       FROM worldlines AS line
       JOIN records AS record
         ON record.workspace_id = line.workspace_id AND record.worldline_id = line.id
       LEFT JOIN record_heads AS head
         ON head.workspace_id = record.workspace_id AND head.record_id = record.id
       WHERE line.workspace_id = $1 AND line.id = $2`,
      [WS, headBranch.worldlineId],
    );
    const topo = topology.rows[0]!;
    assert.equal(topo.worldline_parent, fixture.worldlineId);
    assert.equal(topo.fork_tick, "20");
    assert.equal(topo.head_tick, "20");
    assert.equal(topo.story_count, "1");
    assert.equal(topo.record_kind, "branch");
    assert.equal(topo.linked, fixture.recordId);
    assert.equal(topo.head_last_tick, "20");
    // events 不复制：新 record 从 0 条自身事件起步；scene 快照已装配。
    assert.equal(topo.event_count, "0");
    assert.equal(topo.scene_count, "1");

    // ---- 事件边界分叉 ----
    const midBranch = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      fork: { eventId: eventId2 },
      idempotencyKey: "mid-branch-1",
    });
    assert.deepEqual(midBranch.fork, { tick: 20, ordinal: 2 });
    assert.notEqual(midBranch.recordId, headBranch.recordId);
    // 显式游标形式（命中已提交事件）等价。
    const explicit = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      fork: { worldTick: 20, worldOrdinal: 1 },
      idempotencyKey: "explicit-branch-1",
    });
    assert.deepEqual(explicit.fork, { tick: 20, ordinal: 1 });
    // record start（=0:0）允许（duplicate 语义子集）。
    const startBranch = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      fork: { worldTick: 0, worldOrdinal: 0 },
      idempotencyKey: "start-branch-1",
    });
    assert.deepEqual(startBranch.fork, { tick: 0, ordinal: 0 });

    // ---- fork 负例 ----
    const invalidForks: Array<{
      name: string;
      fork: { eventId: string } | { worldTick: number; worldOrdinal: number };
    }> = [
      { name: "future", fork: { worldTick: 20, worldOrdinal: 99 } },
      { name: "gap", fork: { worldTick: 20, worldOrdinal: 0 } }, // 游标空洞（无此事件）
      { name: "other record event", fork: { eventId: "event_not_of_source" } },
      { name: "negative", fork: { worldTick: -1, worldOrdinal: 0 } },
    ];
    for (const invalid of invalidForks) {
      await assert.rejects(
        runtimeLibrary.branchRecord(SCOPE, {
          sourceRecordId: fixture.recordId,
          fork: invalid.fork,
          idempotencyKey: `invalid-${invalid.name}`,
        }),
        (error: unknown) =>
          error instanceof LibraryServiceError && error.code === "INVALID_FORK",
        `fork ${invalid.name} must be rejected`,
      );
    }
    // 原子性：负例不得留下任何幽灵拓扑（worldline 数不变）。
    const lineCountAfterInvalid = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, fixture.worldId],
    );
    assert.equal(lineCountAfterInvalid.rows[0]!.count, "5"); // origin + 4 成功分支

    // 不存在的源 record / 非成员 principal。
    await assert.rejects(
      runtimeLibrary.branchRecord(SCOPE, {
        sourceRecordId: "record_nope",
        idempotencyKey: "missing-source",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "RECORD_NOT_FOUND",
    );
    await assert.rejects(
      runtimeLibrary.branchRecord(
        { workspaceId: WS, principalId: STRANGER },
        { sourceRecordId: fixture.recordId, idempotencyKey: "stranger-branch" },
      ),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );

    // ---- 幂等：同键重放返回首次拓扑，不写新行 ----
    const replay = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      fork: { eventId: eventId2 },
      idempotencyKey: "mid-branch-1",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, midBranch.recordId);
    assert.equal(replay.worldlineId, midBranch.worldlineId);
    const countAfterReplay = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, fixture.worldId],
    );
    assert.equal(countAfterReplay.rows[0]!.count, "5", "幂等重放不得新增 worldline");

    // ---- 并发：同键并发只产生一套拓扑 ----
    const [concurrentA, concurrentB] = await Promise.all([
      runtimeLibrary.branchRecord(SCOPE, {
        sourceRecordId: fixture.recordId,
        idempotencyKey: "concurrent-1",
      }),
      runtimeLibrary.branchRecord(SCOPE, {
        sourceRecordId: fixture.recordId,
        idempotencyKey: "concurrent-1",
      }),
    ]);
    assert.equal(concurrentA.recordId, concurrentB.recordId);
    assert.equal(concurrentA.worldlineId, concurrentB.worldlineId);
    assert.notEqual(
      concurrentA.replayed === concurrentB.replayed,
      true,
      "并发下同键恰有一个真实创建、一个重放",
    );

    // ---- 归档源拒绝 ----
    await ownerLibrary.create(SCOPE, {
      kind: "delete-record",
      worldId: fixture.worldId,
      recordId: midBranch.recordId,
    });
    await assert.rejects(
      runtimeLibrary.branchRecord(SCOPE, {
        sourceRecordId: midBranch.recordId,
        idempotencyKey: "archived-source",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "RECORD_ARCHIVED",
    );

    // ---- 隔离：父 record 推进后，子线游标/事件不变 ----
    await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 20, ordinal: 4, recordOrdinal: 4, content: "父线继续前进。",
    });
    const childState = await fixture.ownerPool.query<{
      line_head: string;
      record_events: string;
      head_tick: string | null;
    }>(
      `SELECT line.head_tick::text AS line_head,
              (SELECT count(*) FROM events
               WHERE workspace_id = record.workspace_id AND record_id = record.id) AS record_events,
              head.last_world_tick::text AS head_tick
       FROM worldlines AS line
       JOIN records AS record
         ON record.workspace_id = line.workspace_id AND record.worldline_id = line.id
       LEFT JOIN record_heads AS head
         ON head.workspace_id = record.workspace_id AND head.record_id = record.id
       WHERE line.workspace_id = $1 AND line.id = $2`,
      [WS, headBranch.worldlineId],
    );
    assert.equal(childState.rows[0]!.line_head, "20");
    assert.equal(childState.rows[0]!.record_events, "0");
    assert.equal(childState.rows[0]!.head_tick, "20");

    // 默认 head 发生变化后，同一幂等 key 仍必须重放第一次拓扑，不能
    // 因为重新解析到新 head 而创建第二条分支。
    const replayAfterHeadAdvance = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      idempotencyKey: "head-branch-1",
    });
    assert.equal(replayAfterHeadAdvance.replayed, true);
    assert.equal(replayAfterHeadAdvance.recordId, headBranch.recordId);
    assert.deepEqual(replayAfterHeadAdvance.fork, headBranch.fork);

    // ---- 回归：duplicate 语义不变（fork=源 record 起点，retrospection）----
    const duplicate = await runtimeLibrary.duplicateRecord(SCOPE, fixture.recordId);
    const duplicateRow = await fixture.ownerPool.query<{
      kind: string;
      start_tick: string;
      linked: string | null;
    }>(
      `SELECT timeline_kind AS kind, start_tick::text, linked_record_id AS linked
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, duplicate.recordId],
    );
    assert.equal(duplicateRow.rows[0]!.kind, "retrospection");
    assert.equal(duplicateRow.rows[0]!.start_tick, "0");
    assert.equal(duplicateRow.rows[0]!.linked, fixture.recordId);

    // ---- 幽灵路径回归：kind:"branch" 缺 sourceRecordId 拒绝；带 source 可玩 ----
    await assert.rejects(
      ownerLibrary.create(SCOPE, {
        kind: "branch",
        worldId: fixture.worldId,
        label: "幽灵",
      } as unknown as Parameters<typeof ownerLibrary.create>[1]),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "INVALID_COMMAND",
    );
    await ownerLibrary.create(SCOPE, {
      kind: "branch",
      worldId: fixture.worldId,
      label: "命令分支",
      sourceRecordId: fixture.recordId,
    });
    const commandBranchLine = await fixture.ownerPool.query<{
      story_count: string;
      record_kind: string;
    }>(
      `SELECT (SELECT count(*) FROM stories
               WHERE workspace_id = line.workspace_id AND worldline_id = line.id) AS story_count,
              (SELECT timeline_kind FROM records
               WHERE workspace_id = line.workspace_id AND worldline_id = line.id) AS record_kind
       FROM worldlines AS line
       WHERE line.workspace_id = $1 AND line.world_id = $2 AND line.label = '命令分支'`,
      [WS, fixture.worldId],
    );
    assert.equal(commandBranchLine.rows[0]!.story_count, "1", "命令分支必须可玩（带 story）");
    assert.equal(commandBranchLine.rows[0]!.record_kind, "branch");
  },
);

test(
  "branch route: status mapping and idempotent replay over HTTP",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const fixture = await createFixtureDatabase(t);
    const eventId = await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 30, ordinal: 1, recordOrdinal: 1, content: "路由测试事件。",
    });
    const postJson = (body: unknown) =>
      new Request("http://localhost/api/record/branch", {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 400：缺 recordId / idempotencyKey。
    const missing = await branchPOST(postJson({ recordId: fixture.recordId }));
    assert.equal(missing.status, 400);
    // 400：fork 形状非法。
    const badFork = await branchPOST(postJson({
      recordId: fixture.recordId,
      fork: { ordinal: 1 },
      idempotencyKey: "route-bad-fork",
    }));
    assert.equal(badFork.status, 400);
    // 404：源 record 不存在。
    const notFound = await branchPOST(postJson({
      recordId: "record_nope",
      idempotencyKey: "route-missing",
    }));
    assert.equal(notFound.status, 404);
    // 409：未来游标。
    const future = await branchPOST(postJson({
      recordId: fixture.recordId,
      fork: { worldTick: 30, worldOrdinal: 99 },
      idempotencyKey: "route-future",
    }));
    assert.equal(future.status, 409);
    assert.equal(
      ((await future.json()) as { error: { code: string } }).error.code,
      "INVALID_FORK",
    );
    // 201：事件边界分叉成功。
    const created = await branchPOST(postJson({
      recordId: fixture.recordId,
      fork: { eventId },
      label: "路由分支",
      idempotencyKey: "route-branch-1",
    }));
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      recordId: string;
      worldlineId: string;
      replayed: boolean;
    };
    assert.equal(createdBody.replayed, false);
    // 200：同键重放。
    const replayed = await branchPOST(postJson({
      recordId: fixture.recordId,
      fork: { eventId },
      label: "路由分支",
      idempotencyKey: "route-branch-1",
    }));
    assert.equal(replayed.status, 200);
    const replayedBody = (await replayed.json()) as {
      recordId: string;
      replayed: boolean;
    };
    assert.equal(replayedBody.replayed, true);
    assert.equal(replayedBody.recordId, createdBody.recordId);
  },
);

test(
  "branch Goal runtime: current-head clone, commit enqueue, historical fail-closed, atomic rollback",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const fixture = await createFixtureDatabase(t);
    const runtimeLibrary = createPostgresLibraryService(fixture.runtimePool);
    const ownerLibrary = createPostgresLibraryService(fixture.ownerPool);

    const eventId1 = await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 40, ordinal: 1, recordOrdinal: 1, content: "潮起。",
    });
    const eventId2 = await commitSyntheticEvent(fixture.ownerPool, fixture, {
      tick: 40, ordinal: 2, recordOrdinal: 2, content: "潮落。",
    });

    // ---- Goal fixture：active × 2（deterministic/semantic）+ terminal × 1，
    // 附源 record 的 durable job 与不可变 assessment 台账各一行。----
    const sourceGoalScope = {
      workspaceId: WS,
      worldId: fixture.worldId,
      worldlineId: fixture.worldlineId,
      recordId: fixture.recordId,
    };
    const activeGoalId = goalInstanceIdFor(sourceGoalScope, "ack-tide");
    const semanticGoalId = goalInstanceIdFor(sourceGoalScope, "harbor-omen");
    const settledGoalId = goalInstanceIdFor(sourceGoalScope, "settled-past");
    await fixture.ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, revision, progress, outcome, policy_version, completed_at
       ) VALUES
         ($1, $2, $3, $4, $5, 'ack-tide', 'active', 2,
          '{"narrations":1}'::jsonb, NULL, 'v1', NULL),
         ($1, $2, $3, $4, $6, 'harbor-omen', 'active', 0,
          '{}'::jsonb, NULL, 'v2', NULL),
         ($1, $2, $3, $4, $7, 'settled-past', 'completed', 1,
          '{"narrations":2}'::jsonb, '{"result":"done"}'::jsonb, 'v1',
          '2026-08-13T06:30:00.000Z')`,
      [
        WS, fixture.worldId, fixture.worldlineId, fixture.recordId,
        activeGoalId, semanticGoalId, settledGoalId,
      ],
    );
    const sourceJobId = goalAssessmentJobIdFor(WS, settledGoalId, eventId2);
    await fixture.ownerPool.query(
      `INSERT INTO goal_assessment_jobs (
         workspace_id, world_id, worldline_id, record_id, id,
         goal_instance_id, source_event_id, input, state, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'completed',
                 CURRENT_TIMESTAMP)`,
      [
        WS, fixture.worldId, fixture.worldlineId, fixture.recordId,
        sourceJobId, settledGoalId, eventId2,
      ],
    );
    await fixture.ownerPool.query(
      `INSERT INTO goal_assessments (
         workspace_id, world_id, worldline_id, record_id, id,
         goal_instance_id, assessment_job_id, source_event_id,
         source, status, result, evidence_event_ids,
         evidence_head_version, evidence_head_ordinal,
         evidence_snapshot_hash, policy_version
       ) VALUES ($1, $2, $3, $4, 'assessment_settled_1', $5, $6, $7,
                 'deterministic', 'accepted', '{}'::jsonb, ARRAY[$7]::text[],
                 2, 2, 'hash-settled-past', 'v1')`,
      [
        WS, fixture.worldId, fixture.worldlineId, fixture.recordId,
        settledGoalId, sourceJobId, eventId2,
      ],
    );

    const countTopology = async () => (await fixture.ownerPool.query<{
      worldlines: string;
      stories: string;
      records: string;
      goals: string;
      jobs: string;
      assessments: string;
    }>(
      `SELECT
         (SELECT count(*) FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2)::text AS worldlines,
         (SELECT count(*) FROM stories
           WHERE workspace_id = $1 AND world_id = $2)::text AS stories,
         (SELECT count(*) FROM records
           WHERE workspace_id = $1 AND world_id = $2)::text AS records,
         (SELECT count(*) FROM goal_instances
           WHERE workspace_id = $1 AND world_id = $2)::text AS goals,
         (SELECT count(*) FROM goal_assessment_jobs
           WHERE workspace_id = $1 AND world_id = $2)::text AS jobs,
         (SELECT count(*) FROM goal_assessments
           WHERE workspace_id = $1 AND world_id = $2)::text AS assessments`,
      [WS, fixture.worldId],
    )).rows[0]!;

    // ---- 当前 head 分支（runtime/restricted 角色路径）：Goal 全量克隆 ----
    const headBranch = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      idempotencyKey: "goal-head-branch",
    });
    assert.equal(headBranch.replayed, false);
    assert.deepEqual(headBranch.fork, { tick: 40, ordinal: 2 });

    const branchGoalScope = {
      workspaceId: WS,
      worldId: fixture.worldId,
      worldlineId: headBranch.worldlineId,
      recordId: headBranch.recordId,
    };
    const clonedGoals = await fixture.ownerPool.query<{
      id: string;
      world_id: string;
      worldline_id: string;
      record_id: string;
      goal_key: string;
      state: string;
      revision: string;
      progress: Record<string, unknown>;
      outcome: Record<string, unknown> | null;
      policy_version: string;
      completed_at: string | null;
    }>(
      `SELECT id, world_id, worldline_id, record_id, goal_key, state,
              revision::text AS revision, progress, outcome, policy_version,
              completed_at::text AS completed_at
       FROM goal_instances
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY goal_key`,
      [WS, headBranch.recordId],
    );
    assert.equal(clonedGoals.rows.length, 3, "active + terminal Goal 必须全量克隆");
    for (const row of clonedGoals.rows) {
      assert.equal(row.world_id, fixture.worldId);
      assert.equal(row.worldline_id, headBranch.worldlineId);
      assert.equal(row.record_id, headBranch.recordId);
      assert.equal(
        row.id,
        goalInstanceIdFor(branchGoalScope, row.goal_key),
        "克隆 instance id 必须由目标 Record scope 确定性派生",
      );
      assert.notEqual(
        row.id,
        goalInstanceIdFor(sourceGoalScope, row.goal_key),
        "克隆 instance 不得复用源 id（Record-scoped identity）",
      );
    }
    const clonedByKey = new Map(clonedGoals.rows.map((row) => [row.goal_key, row]));
    assert.deepEqual(
      {
        state: clonedByKey.get("ack-tide")!.state,
        revision: clonedByKey.get("ack-tide")!.revision,
        progress: clonedByKey.get("ack-tide")!.progress,
        outcome: clonedByKey.get("ack-tide")!.outcome,
        policy: clonedByKey.get("ack-tide")!.policy_version,
        completedAt: clonedByKey.get("ack-tide")!.completed_at,
      },
      {
        state: "active",
        revision: "2",
        progress: { narrations: 1 },
        outcome: null,
        policy: "v1",
        completedAt: null,
      },
    );
    assert.deepEqual(
      {
        state: clonedByKey.get("harbor-omen")!.state,
        revision: clonedByKey.get("harbor-omen")!.revision,
        policy: clonedByKey.get("harbor-omen")!.policy_version,
      },
      { state: "active", revision: "0", policy: "v2" },
    );
    // terminal 语义逐字节保留：state/revision/progress/outcome/completed_at。
    const settledClone = clonedByKey.get("settled-past")!;
    assert.equal(settledClone.state, "completed");
    assert.equal(settledClone.revision, "1");
    assert.deepEqual(settledClone.progress, { narrations: 2 });
    assert.deepEqual(settledClone.outcome, { result: "done" });
    assert.equal(settledClone.policy_version, "v1");
    assert.ok(settledClone.completed_at, "terminal Goal 的 completed_at 必须保留");
    const settledSource = await fixture.ownerPool.query<{ completed_at: string }>(
      `SELECT completed_at::text AS completed_at
       FROM goal_instances
       WHERE workspace_id = $1 AND id = $2`,
      [WS, settledGoalId],
    );
    assert.equal(settledClone.completed_at, settledSource.rows[0]!.completed_at);

    // 不克隆 assessment 队列/台账：分支从零起步；源 record 行原样保留。
    const branchLedger = await fixture.ownerPool.query<{ jobs: string; assessments: string }>(
      `SELECT
         (SELECT count(*) FROM goal_assessment_jobs
           WHERE workspace_id = $1 AND record_id = $2)::text AS jobs,
         (SELECT count(*) FROM goal_assessments
           WHERE workspace_id = $1 AND record_id = $2)::text AS assessments`,
      [WS, headBranch.recordId],
    );
    assert.deepEqual(branchLedger.rows[0], { jobs: "0", assessments: "0" });
    const sourceLedger = await fixture.ownerPool.query<{ jobs: string; assessments: string }>(
      `SELECT
         (SELECT count(*) FROM goal_assessment_jobs
           WHERE workspace_id = $1 AND record_id = $2)::text AS jobs,
         (SELECT count(*) FROM goal_assessments
           WHERE workspace_id = $1 AND record_id = $2)::text AS assessments`,
      [WS, fixture.recordId],
    );
    assert.deepEqual(sourceLedger.rows[0], { jobs: "1", assessments: "1" });

    // 幂等重放：同键返回首次拓扑，不重复克隆 Goal、不补写 job/台账。
    const goalReplay = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: fixture.recordId,
      idempotencyKey: "goal-head-branch",
    });
    assert.equal(goalReplay.replayed, true);
    assert.equal(goalReplay.recordId, headBranch.recordId);
    const goalsAfterReplay = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM goal_instances
       WHERE workspace_id = $1 AND record_id = $2`,
      [WS, headBranch.recordId],
    );
    assert.equal(goalsAfterReplay.rows[0]!.count, "3", "重放不得重复克隆 Goal");

    // ---- 分支上的下一条正式事件：commitRelease hook 只为克隆的 active
    // Goal enqueue durable job（terminal 不 enqueue）。----
    const branchAssets = await fixture.ownerPool.query<{
      scene_id: string;
      policy_id: string;
    }>(
      `SELECT scene.id AS scene_id, policy.id AS policy_id
       FROM records AS record
       JOIN LATERAL (
         SELECT id FROM scenes
         WHERE workspace_id = record.workspace_id AND record_id = record.id
         ORDER BY start_tick ASC, start_ordinal ASC LIMIT 1
       ) AS scene ON true
       JOIN LATERAL (
         SELECT id FROM visibility_policies
         WHERE workspace_id = record.workspace_id AND record_id = record.id
         LIMIT 1
       ) AS policy ON true
       WHERE record.workspace_id = $1 AND record.id = $2`,
      [WS, headBranch.recordId],
    );
    const branchSceneId = branchAssets.rows[0]!.scene_id;
    const branchPolicyId = branchAssets.rows[0]!.policy_id;
    type CommandPayload = readonly JsonValue[];
    type PlanBody = { objective: string };
    type CandidateBody = { text: string };
    type ValidationBody = { accepted: boolean };
    type EventPayload = { content: string };
    type OutboxPayload = { eventId: string };
    let sequence = 0;
    const dependencies: TurnRuntimeDependencies<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    > = {
      repository: createPostgresRuntimeRepository<
        CommandPayload,
        PlanBody,
        CandidateBody,
        ValidationBody,
        EventPayload,
        OutboxPayload
      >({
        pool: fixture.runtimePool,
        workspaceId: WS,
        mapFormalEvent({ draft }) {
          return {
            sceneId: branchSceneId,
            visibilityPolicyId: branchPolicyId,
            eventKind: "narration.committed",
            speakerName: "旁白",
            content: draft.payload.content,
          };
        },
        onFormalEventsCommitted: async (client, committed) => {
          await enqueueGoalAssessmentJobsForCommittedEvents(client, committed);
        },
      }),
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft() { return { text: "支流第一夜。" }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context) {
          return {
            formalEvents: [{
              eventId: `${context.turnId}-event-a`,
              kind: "narration.committed",
              payload: { content: context.candidate.body.text },
            }],
            outbox: [],
          };
        },
      },
      idFactory: () => `goal-branch-${++sequence}`,
      clock: tickingClock(),
    };
    const command: RuntimeCommand<CommandPayload> = {
      commandType: "player.utterance",
      recordId: headBranch.recordId,
      expectedRecordVersion: 0,
      idempotencyKey: "goal-branch-turn",
      actorId: null,
      payload: ["点亮塔灯"],
    };
    const completed = await executeTurn(command, dependencies);
    assert.equal(completed.state, "completed");
    const committedEventIds = completed.release?.eventIds ?? [];
    assert.equal(committedEventIds.length, 1);

    const branchJobs = await fixture.ownerPool.query<{
      id: string;
      world_id: string;
      worldline_id: string;
      record_id: string;
      goal_instance_id: string;
      source_event_id: string;
      state: string;
    }>(
      `SELECT id, world_id, worldline_id, record_id,
              goal_instance_id, source_event_id, state
       FROM goal_assessment_jobs
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY goal_instance_id`,
      [WS, headBranch.recordId],
    );
    // 1 条正式事件 × 2 个克隆的 active Goal；terminal 克隆无 job。
    assert.equal(branchJobs.rows.length, 2);
    for (const jobRow of branchJobs.rows) {
      assert.equal(jobRow.world_id, fixture.worldId);
      assert.equal(jobRow.worldline_id, headBranch.worldlineId);
      assert.equal(jobRow.record_id, headBranch.recordId);
      assert.equal(jobRow.source_event_id, committedEventIds[0]);
      assert.equal(jobRow.state, "pending");
      assert.ok(
        [
          goalInstanceIdFor(branchGoalScope, "ack-tide"),
          goalInstanceIdFor(branchGoalScope, "harbor-omen"),
        ].includes(jobRow.goal_instance_id),
        "terminal Goal 不得获得 assessment job",
      );
      assert.equal(
        jobRow.id,
        goalAssessmentJobIdFor(WS, jobRow.goal_instance_id, jobRow.source_event_id),
        "job id 必须是确定性派生",
      );
    }

    // ---- 历史分叉 fail-closed：有 Goal 的源 record 只允许 head 分叉 ----
    const beforeRejected = await countTopology();
    const historicalForks: Array<
      { eventId: string } | { worldTick: number; worldOrdinal: number }
    > = [
      { eventId: eventId1 },
      { worldTick: 40, worldOrdinal: 1 },
      { worldTick: 0, worldOrdinal: 0 }, // record start 同样是历史分叉
    ];
    for (const [index, fork] of historicalForks.entries()) {
      await assert.rejects(
        runtimeLibrary.branchRecord(SCOPE, {
          sourceRecordId: fixture.recordId,
          fork,
          idempotencyKey: `goal-historical-${index}`,
        }),
        (error: unknown) =>
          error instanceof LibraryServiceError
            && error.code === "BRANCH_GOAL_STATE_UNAVAILABLE"
            && error.message
              === "Records with Goal runtime state can only be branched at the current head.",
        "历史分叉 + Goal 运行态必须 fail-closed（稳定静态 code/message）",
      );
    }
    assert.deepEqual(
      await countTopology(),
      beforeRejected,
      "拒绝前不得写入任何 worldline/story/record/goal/job/assessment 行",
    );

    // ---- 克隆写入失败（identity/约束不符的故障注入）即整体回滚 ----
    await fixture.ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, revision, progress, outcome, policy_version
       ) VALUES ($1, $2, $3, $4, $5, 'boom-goal', 'active', 0,
                 '{}'::jsonb, NULL, 'v1')`,
      [
        WS, fixture.worldId, fixture.worldlineId, fixture.recordId,
        goalInstanceIdFor(sourceGoalScope, "boom-goal"),
      ],
    );
    await fixture.ownerPool.query(
      `CREATE OR REPLACE FUNCTION realm_test_fail_goal_clone()
       RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         IF NEW.goal_key = 'boom-goal' THEN
           RAISE EXCEPTION 'injected goal clone identity failure';
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    await fixture.ownerPool.query(
      `CREATE TRIGGER realm_test_fail_goal_clone
       BEFORE INSERT ON goal_instances
       FOR EACH ROW EXECUTE FUNCTION realm_test_fail_goal_clone()`,
    );
    t.after(async () => {
      await fixture.ownerPool.query(
        `DROP TRIGGER IF EXISTS realm_test_fail_goal_clone ON goal_instances`,
      ).catch(() => undefined);
      await fixture.ownerPool.query(
        `DROP FUNCTION IF EXISTS realm_test_fail_goal_clone()`,
      ).catch(() => undefined);
    });
    const beforeRollback = await countTopology();
    await assert.rejects(
      runtimeLibrary.branchRecord(SCOPE, {
        sourceRecordId: fixture.recordId,
        idempotencyKey: "goal-rollback-branch",
      }),
      /injected goal clone identity failure/,
    );
    assert.deepEqual(
      await countTopology(),
      beforeRollback,
      "克隆失败必须回滚整个分支拓扑，零残留",
    );
    // 该幂等键的确定性 record id 也不得落库。
    const rollbackDigest = createHash("sha256")
      .update(`${WS}:${fixture.recordId}:goal-rollback-branch`)
      .digest("hex")
      .slice(0, 18);
    const rollbackRecord = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM records
       WHERE workspace_id = $1 AND id = $2`,
      [WS, `record_branch_${rollbackDigest}`],
    );
    assert.equal(rollbackRecord.rows[0]!.count, "0");

    // ---- 无 Goal 旧路径回归：历史分叉语义逐字节不变，两端零 Goal 行 ----
    await ownerLibrary.create(SCOPE, {
      kind: "world",
      name: "无目标试验场",
      era: "静纪",
      summary: "无 Goal 分支回归世界。",
    });
    const legacySnapshot = await ownerLibrary.list(SCOPE);
    const legacyWorld = legacySnapshot.worlds.find(
      (world) => world.name === "无目标试验场",
    )!;
    const legacyStory = legacyWorld.stories[0]!;
    const legacyRecord = legacyStory.records[0]!;
    const legacyAssets = await fixture.ownerPool.query<{
      scene_id: string;
      policy_id: string;
      calendar_id: string;
    }>(
      `SELECT scene.id AS scene_id, policy.id AS policy_id, world.calendar_id
       FROM worlds AS world
       JOIN LATERAL (
         SELECT id FROM scenes
         WHERE workspace_id = world.workspace_id AND record_id = $2
         ORDER BY start_tick ASC, start_ordinal ASC LIMIT 1
       ) AS scene ON true
       JOIN LATERAL (
         SELECT id FROM visibility_policies
         WHERE workspace_id = world.workspace_id AND record_id = $2
         LIMIT 1
       ) AS policy ON true
       WHERE world.workspace_id = $1 AND world.id = $3`,
      [WS, legacyRecord.id, legacyWorld.id],
    );
    const legacyFixture: Fixture = {
      ownerPool: fixture.ownerPool,
      runtimePool: fixture.runtimePool,
      worldId: legacyWorld.id,
      worldlineId: legacyWorld.worldlines[0]!.id,
      storyId: legacyStory.id,
      recordId: legacyRecord.id,
      sceneId: legacyAssets.rows[0]!.scene_id,
      policyId: legacyAssets.rows[0]!.policy_id,
      calendarId: legacyAssets.rows[0]!.calendar_id,
    };
    // recordOrdinal 11/12：避开本库既有合成事件 id（event_branch_test_1/2）。
    const legacyEventId1 = await commitSyntheticEvent(fixture.ownerPool, legacyFixture, {
      tick: 50, ordinal: 1, recordOrdinal: 11, content: "旧路径第一段。",
    });
    await commitSyntheticEvent(fixture.ownerPool, legacyFixture, {
      tick: 50, ordinal: 2, recordOrdinal: 12, content: "旧路径第二段。",
    });
    const legacyBranch = await runtimeLibrary.branchRecord(SCOPE, {
      sourceRecordId: legacyRecord.id,
      fork: { eventId: legacyEventId1 },
      idempotencyKey: "legacy-mid-branch",
    });
    assert.equal(legacyBranch.replayed, false);
    assert.deepEqual(legacyBranch.fork, { tick: 50, ordinal: 1 });
    const legacyGoalRows = await fixture.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM goal_instances
       WHERE workspace_id = $1 AND world_id = $2`,
      [WS, legacyWorld.id],
    );
    assert.equal(legacyGoalRows.rows[0]!.count, "0", "无 Goal 路径不得产生 Goal 行");
  },
);

function tickingClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 5, 0, second++)).toISOString();
}
