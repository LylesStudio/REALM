/**
 * lobby viewer_member join 改写实验（一次性只读脚本，不入测试门）。
 * 基线 OLD = 当前生产 listRooms（MATERIALIZED member_counts CTE +
 * viewer_member LEFT JOIN；lobby-query-diagnosis/lobby-residual-joins-diagnosis
 * 已定位 fresh 状态下 viewer_member per-room lookup 为最大残余）。
 * 候选：
 *  A. viewer_membership MATERIALIZED CTE（workspace+principal 一次读取再 join）；
 *  B. LATERAL 主键直达（workspace_id, room_id, principal_id + left_at 语义）。
 * accounts/worlds join 不动。主测 realm_runtime + 事务内 set_config。
 *
 * 用法：DATABASE_URL=postgresql://<role>@127.0.0.1:<port>/postgres \
 *   node scripts/lobby-viewer-join-experiment.mjs
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

const CTE_MEMBER_COUNTS = (ws) =>
  `member_counts AS MATERIALIZED (
             SELECT member.workspace_id, member.room_id, count(*)::text AS member_count
             FROM lobby_room_members AS member
             WHERE member.left_at IS NULL
               AND member.workspace_id = ${ws}
             GROUP BY member.workspace_id, member.room_id
           )`;

const SELECT_TAIL = (ws) =>
  `SELECT room.id, room.name, room.status, room.capacity,
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
           %VIEWER_JOIN%
           LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id
           WHERE room.workspace_id = ${ws}
           ORDER BY room.created_at DESC, room.id DESC`;

// OLD：当前生产形态（逐字对齐 lobby-service.ts）。
const OLD_SQL = (ws, principal) =>
  `WITH ${CTE_MEMBER_COUNTS(ws)}
           ${SELECT_TAIL(ws).replace(
             "%VIEWER_JOIN%",
             `LEFT JOIN lobby_room_members AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
            AND viewer_member.principal_id = ${principal}
            AND viewer_member.left_at IS NULL`,
           )}`;

// 候选 A：viewer_membership MATERIALIZED CTE（一次读取 workspace+principal）。
const CANDIDATE_A_SQL = (ws, principal) =>
  `WITH ${CTE_MEMBER_COUNTS(ws)},
           viewer_membership AS MATERIALIZED (
             SELECT member.workspace_id, member.room_id, member.role
             FROM lobby_room_members AS member
             WHERE member.workspace_id = ${ws}
               AND member.principal_id = ${principal}
               AND member.left_at IS NULL
           )
           ${SELECT_TAIL(ws).replace(
             "%VIEWER_JOIN%",
             `LEFT JOIN viewer_membership AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id`,
           )}`;

// 候选 B：LATERAL 主键直达 lookup。
const CANDIDATE_B_SQL = (ws, principal) =>
  `WITH ${CTE_MEMBER_COUNTS(ws)}
           ${SELECT_TAIL(ws).replace(
             "%VIEWER_JOIN%",
             `LEFT JOIN LATERAL (
             SELECT member.role
             FROM lobby_room_members AS member
             WHERE member.workspace_id = room.workspace_id
               AND member.room_id = room.id
               AND member.principal_id = ${principal}
               AND member.left_at IS NULL
           ) AS viewer_member ON true`,
           )}`;

const CANDIDATES = {
  old: OLD_SQL,
  candidateA_cte: CANDIDATE_A_SQL,
  candidateB_lateral: CANDIDATE_B_SQL,
};

for (const [name, build] of Object.entries(CANDIDATES)) {
  if (!build("'ws_exp'", "'principal_a'").includes("lobby_rooms")) {
    throw new Error(`candidate ${name} extraction failed`);
  }
}

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();
const createdDatabases = [];

async function createDb() {
  const name = `realm_lobby_viewer_${Math.random().toString(36).slice(2, 10)}`;
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

/** 与 lobby-service.ts listRooms 的 JS 映射一致（占位名/数字规整）。 */
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

/**
 * 等价性矩阵：viewer 活跃（host/player）/非成员/已离开、closed 房、缺账号、
 * 绑定 world、workspace 隔离（ws_other 的同 principal 成员行不得泄漏为
 * viewerRole，房间也不得出现）。OLD/A/B 逐字段深比较。
 */
async function equivalenceMatrix() {
  const url = await createDb();
  const runtimeUrl = new URL(url.href);
  runtimeUrl.username = "realm_runtime";
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  try {
    await migrate(pool);
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws_exp', 'exp'), ('ws_other', 'other')`);
    await pool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES
       ('ws_exp', 'principal_host', '房主'), ('ws_exp', 'principal_a', '旅人甲'), ('ws_exp', 'principal_b', '旅人乙'),
       ('ws_other', 'principal_a', '他域旅人')`,
    );
    await pool.query(`INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ('ws_exp', 'world_exp', '边界港', 'cal_exp')`);
    await pool.query(
      `INSERT INTO lobby_rooms (workspace_id, id, name, status, capacity, password_hash, host_principal_id, world_id, lease_expires_at) VALUES
       ('ws_exp', 'room_full', '满员房', 'open', 4, 'scrypt$fake', 'principal_host', 'world_exp', CURRENT_TIMESTAMP + INTERVAL '1 hour'),
       ('ws_exp', 'room_solo', '单人房', 'open', 2, NULL, 'principal_ghost', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour'),
       ('ws_exp', 'room_left', '空房', 'open', 4, NULL, 'principal_host', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour'),
       ('ws_exp', 'room_closed', '关闭房', 'closed', 4, NULL, 'principal_host', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour'),
       ('ws_other', 'room_other', '他域房', 'open', 4, NULL, 'principal_a', NULL, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    );
    await pool.query(
      `INSERT INTO lobby_room_members (workspace_id, room_id, principal_id, role, left_at) VALUES
       ('ws_exp', 'room_full', 'principal_host', 'host', NULL),
       ('ws_exp', 'room_full', 'principal_a', 'player', NULL),
       ('ws_exp', 'room_full', 'principal_b', 'player', NULL),
       ('ws_exp', 'room_solo', 'principal_ghost', 'host', NULL),
       ('ws_exp', 'room_left', 'principal_a', 'player', CURRENT_TIMESTAMP),
       ('ws_other', 'room_other', 'principal_a', 'host', NULL)`,
    );
    const viewers = ["principal_a", "principal_host", "principal_stranger"];
    const perViewer = {};
    for (const viewer of viewers) {
      const results = {};
      for (const [name, build] of Object.entries(CANDIDATES)) {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, ["ws_exp"]);
        const rows = (await client.query(build(`'ws_exp'`, `'${viewer}'`))).rows;
        await client.query("ROLLBACK");
        results[name] = mapRows(rows);
      }
      const oldJson = JSON.stringify(results.old);
      perViewer[viewer] = {
        rows: results.old.length,
        candidateA: JSON.stringify(results.candidateA_cte) === oldJson ? "equivalent" : "MISMATCH",
        candidateB: JSON.stringify(results.candidateB_lateral) === oldJson ? "equivalent" : "MISMATCH",
        sample: results.old,
      };
    }
    const allEquivalent = Object.values(perViewer).every(
      (entry) => entry.candidateA === "equivalent" && entry.candidateB === "equivalent",
    );
    return { status: allEquivalent ? "equivalent" : "MISMATCH", perViewer };
  } finally {
    await client.end();
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

/** realm_runtime + 事务内 set_config（RLS 对齐服务路径）；raw 计时 + EXPLAIN 取证。 */
async function measure(client, workspaceId, sql, runs) {
  const timed = [];
  let rowCount = 0;
  for (let index = 0; index < runs + 1; index += 1) {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [workspaceId]);
    const start = performance.now();
    const result = await client.query(sql);
    const elapsed = performance.now() - start;
    await client.query("ROLLBACK");
    if (index === 0) continue;
    timed.push(elapsed);
    rowCount = result.rowCount ?? 0;
  }
  await client.query("BEGIN");
  await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [workspaceId]);
  const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  await client.query("ROLLBACK");
  const plan = explained.rows[0]["QUERY PLAN"][0];
  const acc = walkPlan(plan.Plan, { nodeTypes: {}, sharedHitBlocks: 0, sharedReadBlocks: 0, maxLoops: 0 });
  return {
    runs,
    rowCount,
    rawExec: summarizeDurations(timed),
    plan: {
      topNode: plan.Plan["Node Type"],
      nodeTypes: acc.nodeTypes,
      maxActualLoops: acc.maxLoops,
      sharedHitBlocks: acc.sharedHitBlocks,
      sharedReadBlocks: acc.sharedReadBlocks,
    },
  };
}

async function measureScale(roomCount) {
  const url = await createDb();
  const runtimeUrl = new URL(url.href);
  runtimeUrl.username = "realm_runtime";
  const workspaceId = "ws_exp";
  const ws = `'${workspaceId}'`;
  const principal = `'principal_a'`;
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  try {
    const setupPool = new pg.Pool({ connectionString: url.href, max: 2 });
    await migrate(setupPool);
    await seedScale(setupPool, workspaceId, roomCount);
    await setupPool.end();

    const runCandidates = async () => {
      const out = {};
      for (const [name, build] of Object.entries(CANDIDATES)) {
        out[name] = await measure(client, workspaceId, build(ws, principal), RUNS);
      }
      return out;
    };
    const fresh = await runCandidates();
    const superClient = new pg.Client({ connectionString: url.href });
    await superClient.connect();
    await superClient.query("VACUUM ANALYZE lobby_room_members");
    await superClient.query("VACUUM ANALYZE lobby_rooms");
    await superClient.query("VACUUM ANALYZE accounts");
    await superClient.end();
    const analyzed = await runCandidates();
    return { rooms: roomCount, fresh, analyzed };
  } finally {
    await client.end().catch(() => undefined);
  }
}

try {
  const equivalence = await equivalenceMatrix();
  const scales = [];
  for (const scale of SCALES) {
    scales.push(await measureScale(scale));
  }
  const report = {
    scenario: "lobby-viewer-join-rewrite-experiment",
    candidates: {
      old: "当前生产 viewer_member LEFT JOIN",
      candidateA_cte: "viewer_membership MATERIALIZED CTE（workspace+principal 一次读取）",
      candidateB_lateral: "LATERAL 主键直达 lookup",
    },
    role: "realm_runtime（FORCE RLS + 事务内 set_config）",
    runsPerMeasurement: RUNS,
    equivalence,
    scales,
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(`[summary] equivalence: ${equivalence.status}`);
  for (const scale of scales) {
    for (const state of ["fresh", "analyzed"]) {
      const row = scale[state];
      console.error(
        `[summary] rooms=${scale.rooms} ${state} `
        + Object.entries(row)
          .map(([k, v]) => `${k}=${v.rawExec.avgMs}ms(hit=${v.plan.sharedHitBlocks},loops=${v.plan.maxActualLoops})`)
          .join(" "),
      );
    }
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
