/**
 * lobby member 聚合改写实验（一次性脚本，不入测试门）。
 * 基线：modules/application/lobby-service.ts listRooms 的 member_counts
 * 非关联派生表（fresh 统计缺失时退化为 nested-loop per-room GroupAggregate，
 * 见 lobby-query-diagnosis）。候选：显式 MATERIALIZED CTE + workspace 过滤
 * 下推（等价性论证：派生表经 JOIN ON workspace_id = room.workspace_id 且
 * room.workspace_id = $1，其它 workspace 的聚合行永不被消费）。
 *
 * 输出：
 * A. 等价性矩阵（0/1/3 成员、成员已离开、closed、密码房、绑定世界、
 *    viewer host/player/非成员、缺账号占位）——OLD/NEW 返回行逐字段深比较；
 * B. 50/200/500 房 ×3 成员、fresh（不 ANALYZE）与 VACUUM ANALYZE 两种状态，
 *    OLD/NEW 各 20 次 warm 原始执行计时（无 EXPLAIN 包裹）+ EXPLAIN 取样
 *    计划/缓冲证据。
 * 只读测量，不改生产。stdout JSON 不含连接信息。
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

// OLD：逐字提取自 lobby-service.ts listRooms（$1/$2 内联字面量）。
const OLD_SQL = (ws, principal) =>
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
            AND viewer_member.principal_id = ${principal}
            AND viewer_member.left_at IS NULL
           LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id
           WHERE room.workspace_id = ${ws}
           ORDER BY room.created_at DESC, room.id DESC`;

// NEW：显式 MATERIALIZED CTE + workspace 过滤下推（聚合一次，禁止 per-room 重算）。
const NEW_SQL = (ws, principal) =>
  `WITH member_counts AS MATERIALIZED (
             SELECT member.workspace_id, member.room_id, count(*)::text AS member_count
             FROM lobby_room_members AS member
             WHERE member.left_at IS NULL
               AND member.workspace_id = ${ws}
             GROUP BY member.workspace_id, member.room_id
           )
           SELECT room.id, room.name, room.status, room.capacity,
                  room.password_hash IS NOT NULL AS has_password,
                  COALESCE(member_counts.member_count, '0') AS member_count,
                  host_account.display_name AS host_display_name,
                  viewer_member.role AS viewer_role,
                  room.world_id,
                  world.name AS world_name
           FROM lobby_rooms AS room
           LEFT JOIN member_counts
             ON member_counts.workspace_id = room.workspace_id
            AND member_counts.room_id = room.id
           LEFT JOIN accounts AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id
           LEFT JOIN lobby_room_members AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
            AND viewer_member.principal_id = ${principal}
            AND viewer_member.left_at IS NULL
           LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id
           WHERE room.workspace_id = ${ws}
           ORDER BY room.created_at DESC, room.id DESC`;

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();
const createdDatabases = [];

async function createDb() {
  const name = `realm_lobby_exp_${Math.random().toString(36).slice(2, 10)}`;
  createdDatabases.push(name);
  await maintenance.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString.href);
  url.pathname = `/${name}`;
  return url;
}

async function migrate(pool) {
  const dir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort()) {
    if (f.endsWith(".sql")) await pool.query(await readFile(new URL(f, dir), "utf8"));
  }
}

/** 服务语义等价的关键：listRooms 的 JS 映射（占位名/数字规整）两侧一致比较。 */
function mapRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hostDisplayName: row.host_display_name?.trim() || "旅人",
    memberCount: Math.max(0, Number(row.member_count) || 0),
    capacity: row.capacity,
    hasPassword: row.has_password,
    status: row.status,
    viewerRole: row.viewer_role,
    worldId: row.world_id,
    worldName: row.world_name,
  }));
}

async function equivalenceMatrix() {
  const url = await createDb();
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  try {
    await migrate(pool);
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws_exp', 'exp')`);
    await pool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES
       ('ws_exp', 'principal_host', '房主'), ('ws_exp', 'principal_a', '旅人甲'), ('ws_exp', 'principal_b', '旅人乙')`,
    );
    // 绑定世界的房间需要一个世界行（最小列集；只服务 world join）。
    const worldCols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'worlds' AND is_nullable = 'NO' AND column_default IS NULL
       ORDER BY ordinal_position`,
    );
    if (!worldCols.rows.every((row) => ["workspace_id", "id", "name", "calendar_id"].includes(row.column_name))) {
      return { status: "skipped", reason: "worlds table has unexpected NOT NULL columns" };
    }
    await pool.query(`INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ('ws_exp', 'world_exp', '边界港', 'cal_exp')`);
    const rooms = [
      // id, name, status, capacity, password_hash, host, world_id, lease
      `('ws_exp', 'room_full', '满员房', 'open', 4, 'scrypt$fake', 'principal_host', 'world_exp', CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
      `('ws_exp', 'room_solo', '单人房', 'open', 2, NULL, 'principal_ghost', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
      `('ws_exp', 'room_left', '空房', 'open', 4, NULL, 'principal_host', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
      `('ws_exp', 'room_closed', '关闭房', 'closed', 4, NULL, 'principal_host', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    ];
    await pool.query(
      `INSERT INTO lobby_rooms (workspace_id, id, name, status, capacity, password_hash, host_principal_id, world_id, lease_expires_at)
       VALUES ${rooms.join(",")}`,
    );
    await pool.query(
      `INSERT INTO lobby_room_members (workspace_id, room_id, principal_id, role, left_at) VALUES
       ('ws_exp', 'room_full', 'principal_host', 'host', NULL),
       ('ws_exp', 'room_full', 'principal_a', 'player', NULL),
       ('ws_exp', 'room_full', 'principal_b', 'player', NULL),
       ('ws_exp', 'room_solo', 'principal_ghost', 'host', NULL),
       ('ws_exp', 'room_left', 'principal_host', 'host', CURRENT_TIMESTAMP),
       ('ws_exp', 'room_left', 'principal_a', 'player', CURRENT_TIMESTAMP)`,
    );
    const ws = `'ws_exp'`;
    // viewer=principal_a（room_full 的 player、room_left 已离开、其余非成员）。
    const oldRows = mapRows((await pool.query(OLD_SQL(ws, `'principal_a'`))).rows);
    const newRows = mapRows((await pool.query(NEW_SQL(ws, `'principal_a'`))).rows);
    const match = JSON.stringify(oldRows) === JSON.stringify(newRows);
    // viewer=principal_host（两间 host、缺账号的 room_solo 不是其房）。
    const oldHost = mapRows((await pool.query(OLD_SQL(ws, `'principal_host'`))).rows);
    const newHost = mapRows((await pool.query(NEW_SQL(ws, `'principal_host'`))).rows);
    const hostMatch = JSON.stringify(oldHost) === JSON.stringify(newHost);
    return {
      status: match && hostMatch ? "equivalent" : "MISMATCH",
      viewerPrincipalA: { match, rows: newRows },
      viewerPrincipalHost: { match: hostMatch },
      rowCount: newRows.length,
    };
  } finally {
    await pool.end();
  }
}

async function seedScale(pool, workspaceId, roomCount) {
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'exp')`, [workspaceId]);
  await pool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     SELECT $1, 'principal_host', '房主'
     UNION ALL SELECT $1, 'principal_a', '旅人甲'
     UNION ALL SELECT $1, 'principal_b', '旅人乙'`,
    [workspaceId],
  );
  const roomValues = [];
  const memberValues = [];
  for (let index = 0; index < roomCount; index += 1) {
    const roomId = `room_${index}`;
    roomValues.push(
      `('${workspaceId}', '${roomId}', '房间${index}', 'open', 4, NULL, 'principal_host', CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
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

function walkPlan(node, acc) {
  acc.nodeTypes[node["Node Type"]] = (acc.nodeTypes[node["Node Type"]] ?? 0) + 1;
  acc.sharedHitBlocks += node["Shared Hit Blocks"] ?? 0;
  acc.sharedReadBlocks += node["Shared Read Blocks"] ?? 0;
  acc.maxLoops = Math.max(acc.maxLoops, node["Actual Loops"] ?? 1);
  for (const child of node.Plans ?? []) walkPlan(child, acc);
  return acc;
}

/** 原始执行计时（无 EXPLAIN 包裹，更接近服务路径）+ 一次 EXPLAIN 取证。 */
async function measureQuery(client, workspaceId, sql, runs) {
  await client.query("SELECT 1");
  const timed = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await client.query(sql);
    timed.push(performance.now() - start);
  }
  await client.query("BEGIN");
  await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [workspaceId]);
  const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  await client.query("ROLLBACK");
  const plan = explained.rows[0]["QUERY PLAN"][0];
  const acc = walkPlan(plan.Plan, { nodeTypes: {}, sharedHitBlocks: 0, sharedReadBlocks: 0, maxLoops: 0 });
  return {
    runs,
    rawExec: summarizeDurations(timed),
    plan: {
      topNode: plan.Plan["Node Type"],
      nodeTypes: acc.nodeTypes,
      maxActualLoops: acc.maxLoops,
      sharedHitBlocks: acc.sharedHitBlocks,
      sharedReadBlocks: acc.sharedReadBlocks,
      explainExecutionMs: plan["Execution Time"],
    },
  };
}

async function measureScale(roomCount) {
  const url = await createDb();
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  const workspaceId = "ws_exp";
  const ws = `'${workspaceId}'`;
  const principal = `'principal_a'`;
  try {
    await migrate(pool);
    await seedScale(pool, workspaceId, roomCount);
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    const fresh = {
      old: await measureQuery(client, workspaceId, OLD_SQL(ws, principal), RUNS),
      new: await measureQuery(client, workspaceId, NEW_SQL(ws, principal), RUNS),
    };
    await client.query("VACUUM ANALYZE lobby_room_members");
    await client.query("VACUUM ANALYZE lobby_rooms");
    const analyzed = {
      old: await measureQuery(client, workspaceId, OLD_SQL(ws, principal), RUNS),
      new: await measureQuery(client, workspaceId, NEW_SQL(ws, principal), RUNS),
    };
    await client.end();
    return { rooms: roomCount, fresh, analyzed };
  } finally {
    await pool.end();
  }
}

try {
  const equivalence = await equivalenceMatrix();
  const scales = [];
  for (const scale of SCALES) {
    scales.push(await measureScale(scale));
  }
  const report = {
    scenario: "lobby-member-aggregation-rewrite-experiment",
    candidate: "MATERIALIZED CTE + workspace 过滤下推（聚合一次）",
    runsPerMeasurement: RUNS,
    equivalence,
    scales,
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(`[summary] equivalence: ${equivalence.status} (rows=${equivalence.rowCount ?? "n/a"})`);
  for (const scale of scales) {
    console.error(
      `[summary] rooms=${scale.rooms} fresh OLD avg=${scale.fresh.old.rawExec.avgMs}ms hit=${scale.fresh.old.plan.sharedHitBlocks} loops=${scale.fresh.old.plan.maxActualLoops}`
      + ` | NEW avg=${scale.fresh.new.rawExec.avgMs}ms hit=${scale.fresh.new.plan.sharedHitBlocks} loops=${scale.fresh.new.plan.maxActualLoops}`,
    );
    console.error(
      `[summary] rooms=${scale.rooms} analyzed OLD avg=${scale.analyzed.old.rawExec.avgMs}ms | NEW avg=${scale.analyzed.new.rawExec.avgMs}ms`,
    );
  }
} catch (error) {
  console.error(`[experiment] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
} finally {
  for (const name of createdDatabases) {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
  await maintenance.end();
}
