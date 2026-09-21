/**
 * lobby listRooms 200→500 超线性根因诊断（一次性只读测量脚本，不入测试门）。
 * 对 modules/application/lobby-service.ts:175-186（reapExpiredRooms UPDATE）
 * 与 216-244（listRooms SELECT）的逐字 SQL 做 EXPLAIN (ANALYZE, BUFFERS,
 * FORMAT JSON) 取样（$1/$2 内联为字面量，来源在输出注明），并附对照变体
 * （roomsOnly / noMemberAgg）做成本归因。只读或回滚执行，不改生产。
 *
 * 用法：DATABASE_URL=postgresql://<role>@127.0.0.1:<port>/postgres \
 *   node scripts/lobby-query-diagnosis.mjs
 * 输出：stdout 为 machine-readable JSON；不打印连接串/端口/用户名/错误原文。
 */
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import {
  assertLoopbackDatabaseUrl,
  safeErrorCategory,
  summarizeDurations,
} from "./baseline-common.mjs";

const SCALES = [50, 200, 500];
const RUNS = 20;
const EXPIRED_ROOMS_FOR_REAP = 12;

// ---- 逐字提取自 modules/application/lobby-service.ts（来源见输出 sqlSource）----
// lobby-service.ts:175-181（reapExpiredRooms；$1=workspaceId 内联）
const REAP_SQL = (workspaceLiteral) =>
  `UPDATE lobby_rooms SET status = 'closed', updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = ${workspaceLiteral} AND status = 'open'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= CURRENT_TIMESTAMP
       RETURNING id`;

// lobby-service.ts:216-244（listRooms SELECT；$1=workspaceId、$2=principalId 内联）
const LIST_SQL = (workspaceLiteral, principalLiteral) =>
  `SELECT room.id, room.name, room.status, room.capacity,
                  room.password_hash IS NOT NULL AS has_password,
                  COALESCE(member_counts.member_count, '0') AS member_count,
                  host_account.display_name AS host_display_name,
                  viewer_member.role AS viewer_role,
                  room.world_id,
                  world.name AS world_name
           FROM lobby_rooms AS room
           LEFT JOIN (
             SELECT member.workspace_id, member.room_id, count(*)::text AS member_count
             FROM lobby_room_members AS member
             WHERE member.left_at IS NULL
             GROUP BY member.workspace_id, member.room_id
           ) AS member_counts
             ON member_counts.workspace_id = room.workspace_id
            AND member_counts.room_id = room.id
           LEFT JOIN accounts AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id
           LEFT JOIN lobby_room_members AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
            AND viewer_member.principal_id = ${principalLiteral}
            AND viewer_member.left_at IS NULL
           LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id
           WHERE room.workspace_id = ${workspaceLiteral}
           ORDER BY room.created_at DESC, room.id DESC`;

// 对照变体 A：去掉 member 聚合子查询（其余保持一致；member_count 以常量占位）。
const NO_MEMBER_AGG_SQL = (workspaceLiteral, principalLiteral) => {
  const replaced = LIST_SQL(workspaceLiteral, principalLiteral)
    .replace(
      `LEFT JOIN (
             SELECT member.workspace_id, member.room_id, count(*)::text AS member_count
             FROM lobby_room_members AS member
             WHERE member.left_at IS NULL
             GROUP BY member.workspace_id, member.room_id
           ) AS member_counts
             ON member_counts.workspace_id = room.workspace_id
            AND member_counts.room_id = room.id`,
      `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS room_id, '3'::text AS member_count) AS member_counts
             ON member_counts.workspace_id = room.workspace_id
            AND member_counts.room_id = room.id`,
    );
  if (!replaced.includes("'3'::text AS member_count")) {
    throw new Error("noMemberAgg variant extraction failed (source SQL drift)");
  }
  return replaced;
};

// 对照变体 B：最小形态（仅房间表 + 同一 WHERE/ORDER BY）。
const ROOMS_ONLY_SQL = (workspaceLiteral) =>
  `SELECT room.id, room.name, room.status, room.capacity
           FROM lobby_rooms AS room
           WHERE room.workspace_id = ${workspaceLiteral}
           ORDER BY room.created_at DESC, room.id DESC`;

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();
const createdDatabases = [];

function walkPlan(node, acc) {
  acc.nodeTypes[node["Node Type"]] = (acc.nodeTypes[node["Node Type"]] ?? 0) + 1;
  acc.sharedHitBlocks += node["Shared Hit Blocks"] ?? 0;
  acc.sharedReadBlocks += node["Shared Read Blocks"] ?? 0;
  for (const child of node.Plans ?? []) walkPlan(child, acc);
  return acc;
}

/**
 * 同一事务内 set_config（RLS 对齐服务路径）+ EXPLAIN ANALYZE，随后 ROLLBACK
 * （reap UPDATE 不留副作用；SELECT 本为只读）。首轮 warm-up 丢弃。
 * EXPLAIN ANALYZE 自身影响：真实执行（含 instrumentation 开销），warm 后
 * buffer 基本全 shared hit——它测的是「热缓存 + 观测开销下的计划形态」，
 * 不是生产冷读耗时；绝对值与 R4 baseline（无 EXPLAIN 包裹）不可直接互比。
 */
async function explainSampled(client, workspaceId, sql, runs) {
  await runOnce(client, workspaceId, sql); // warm-up
  const execution = [];
  const planning = [];
  let last = null;
  for (let index = 0; index < runs; index += 1) {
    last = await runOnce(client, workspaceId, sql);
    execution.push(last.executionMs);
    planning.push(last.planningMs);
  }
  const plan = last.plan;
  const acc = walkPlan(plan.Plan, { nodeTypes: {}, sharedHitBlocks: 0, sharedReadBlocks: 0 });
  return {
    runs,
    executionMs: summarizeDurations(execution),
    planningMs: summarizeDurations(planning),
    topNode: {
      type: plan.Plan["Node Type"],
      actualRows: plan.Plan["Actual Rows"],
      actualLoops: plan.Plan["Actual Loops"],
    },
    nodeTypes: acc.nodeTypes,
    sharedHitBlocks: acc.sharedHitBlocks,
    sharedReadBlocks: acc.sharedReadBlocks,
  };
}

async function runOnce(client, workspaceId, sql) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [workspaceId]);
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    return { plan: result.rows[0]["QUERY PLAN"][0], executionMs: result.rows[0]["QUERY PLAN"][0]["Execution Time"], planningMs: result.rows[0]["QUERY PLAN"][0]["Planning Time"] };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

async function migrate(pool) {
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await pool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
}

async function seedLobby(pool, workspaceId, roomCount, expiredCount) {
  await pool.query(
    `INSERT INTO workspaces (id, name) VALUES ($1, 'diag') ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     SELECT $1, 'principal_host', '房主'
     UNION ALL SELECT $1, 'principal_a', '旅人甲'
     UNION ALL SELECT $1, 'principal_b', '旅人乙'
     ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  const roomValues = [];
  const memberValues = [];
  for (let index = 0; index < roomCount; index += 1) {
    const roomId = `room_diag_${index}`;
    const lease = index < expiredCount
      ? `CURRENT_TIMESTAMP - INTERVAL '10 seconds'`
      : `CURRENT_TIMESTAMP + INTERVAL '1 hour'`;
    roomValues.push(
      `('${workspaceId}', '${roomId}', '房间${index}', 'open', 4, NULL, 'principal_host', ${lease})`,
    );
    for (const [principal, role] of [["principal_host", "host"], ["principal_a", "player"], ["principal_b", "player"]]) {
      memberValues.push(`('${workspaceId}', '${roomId}', '${principal}', '${role}')`);
    }
  }
  await pool.query(
    `INSERT INTO lobby_rooms (workspace_id, id, name, status, capacity, password_hash, host_principal_id, lease_expires_at)
     VALUES ${roomValues.join(",")}`,
  );
  await pool.query(
    `INSERT INTO lobby_room_members (workspace_id, room_id, principal_id, role)
     VALUES ${memberValues.join(",")}`,
  );
}

async function runScale(roomCount) {
  const databaseName = `realm_lobby_diag_${Math.random().toString(36).slice(2, 10)}`;
  createdDatabases.push(databaseName);
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const dbUrl = new URL(connectionString.href);
  dbUrl.pathname = `/${databaseName}`;
  // 生产角色（realm_runtime + FORCE RLS，事务内 set_config 对齐服务路径）。
  const runtimeUrl = new URL(dbUrl.href);
  runtimeUrl.username = "realm_runtime";
  const runtimeClient = new pg.Client({ connectionString: runtimeUrl.href });
  await runtimeClient.connect();
  const workspaceId = "ws_diag";
  const ws = `'${workspaceId}'`;
  const principal = `'principal_a'`;
  try {
    const setupPool = new pg.Pool({ connectionString: dbUrl.href, max: 2 });
    await migrate(setupPool);
    await seedLobby(setupPool, workspaceId, roomCount, EXPIRED_ROOMS_FOR_REAP);
    await setupPool.end();

    const listSelect = await explainSampled(
      runtimeClient, workspaceId, LIST_SQL(ws, principal), RUNS,
    );
    const noMemberAgg = await explainSampled(
      runtimeClient, workspaceId, NO_MEMBER_AGG_SQL(ws, principal), RUNS,
    );
    const roomsOnly = await explainSampled(
      runtimeClient, workspaceId, ROOMS_ONLY_SQL(ws), RUNS,
    );
    // 稳态 reap（先关掉 seed 的过期房——committed，之后 UPDATE 恒 0 行）。
    await runtimeClient.query("BEGIN");
    await runtimeClient.query(`SELECT set_config('realm.workspace_id', $1, true)`, [workspaceId]);
    await runtimeClient.query(REAP_SQL(ws));
    await runtimeClient.query("COMMIT");
    const reapSteady = await explainSampled(runtimeClient, workspaceId, REAP_SQL(ws), RUNS);
    // 含过期房 reap（每轮 EXPLAIN ANALYZE 在事务内执行后 ROLLBACK，12 行保持过期）。
    await (async () => {
      const reset = new pg.Pool({ connectionString: dbUrl.href, max: 1 });
      try {
        const resetResult = await reset.query(
          `UPDATE lobby_rooms SET status = 'open', lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '10 seconds'
           WHERE workspace_id = $1 AND id LIKE 'room_diag_%'
             AND substring(id from 'room_diag_(\\d+)')::int < $2`,
          [workspaceId, EXPIRED_ROOMS_FOR_REAP],
        );
        if (resetResult.rowCount !== EXPIRED_ROOMS_FOR_REAP) {
          throw new Error("reap expired-room reset count mismatch");
        }
      } finally {
        await reset.end().catch(() => undefined);
      }
    })();
    const reapWithExpired = await explainSampled(runtimeClient, workspaceId, REAP_SQL(ws), RUNS);

    // superuser 对照（绕过 RLS；与 R4 baseline 连接形态一致）。
    const superClient = new pg.Client({ connectionString: dbUrl.href });
    await superClient.connect();
    const listSelectSuperuser = await explainSampled(superClient, workspaceId, LIST_SQL(ws, principal), RUNS);
    // VACUUM ANALYZE 对照：fresh bulk-insert 无统计信息是烂计划（nested-loop
    // per-room GroupAggregate）的触发器；维护后重测同一 SQL 验证计划翻转。
    await superClient.query("VACUUM ANALYZE lobby_room_members");
    await superClient.query("VACUUM ANALYZE lobby_rooms");
    const listSelectAfterVacuumAnalyze = await explainSampled(superClient, workspaceId, LIST_SQL(ws, principal), RUNS);
    await superClient.end();

    const indexes = await runtimeClient.query(
      `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes
       WHERE tablename IN ('lobby_rooms', 'lobby_room_members', 'accounts', 'worlds')
       ORDER BY tablename, indexname`,
    );
    return {
      rooms: roomCount,
      membersPerRoom: 3,
      listSelect,
      variants: { noMemberAgg, roomsOnly },
      reapSteady,
      reapWithExpired,
      listSelectSuperuser,
      listSelectAfterVacuumAnalyze,
      indexes: indexes.rows,
    };
  } finally {
    await runtimeClient.end().catch(() => undefined);
  }
}

try {
  const scales = [];
  for (const scale of SCALES) {
    scales.push(await runScale(scale));
  }
  const report = {
    scenario: "lobby-listRooms-query-diagnosis",
    sqlSource: "modules/application/lobby-service.ts:175-186 (reap UPDATE) 与 216-244 (list SELECT) 逐字提取；$1/$2 内联为字面量",
    sampledRunsPerQuery: RUNS,
    roles: {
      runtime: "realm_runtime（FORCE RLS + 事务内 set_config，对齐服务路径）",
      superuser: "postgres（绕过 RLS；与 R4 baseline 连接形态一致，仅 list SELECT 对照）",
    },
    explainCaveat: "EXPLAIN ANALYZE 真实执行并带 instrumentation 开销；warm 后 buffer 基本全 shared hit——测的是热缓存下的计划形态与相对归因，绝对值不等于生产冷读",
    scales,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const scale of scales) {
    console.error(
      `[summary] rooms=${scale.rooms} list exec avg=${scale.listSelect.executionMs.avgMs}ms `
      + `p95=${scale.listSelect.executionMs.p95Ms}ms top=${scale.listSelect.topNode.type} `
      + `nodes=${JSON.stringify(scale.listSelect.nodeTypes)}`,
    );
    console.error(
      `[summary] rooms=${scale.rooms} noMemberAgg avg=${scale.variants.noMemberAgg.executionMs.avgMs}ms `
      + `roomsOnly avg=${scale.variants.roomsOnly.executionMs.avgMs}ms `
      + `reap(steady) avg=${scale.reapSteady.executionMs.avgMs}ms reap(12expired) avg=${scale.reapWithExpired.executionMs.avgMs}ms `
      + `afterVacuumAnalyze avg=${scale.listSelectAfterVacuumAnalyze.executionMs.avgMs}ms top=${scale.listSelectAfterVacuumAnalyze.topNode.type}`,
    );
  }
} catch (error) {
  console.error(`[diagnosis] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
} finally {
  for (const databaseName of createdDatabases) {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
  }
  await maintenance.end();
}
