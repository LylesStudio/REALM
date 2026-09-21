/**
 * lobby NEW 查询残余 nested-loop 归因诊断（一次性只读脚本，不入测试门）。
 * 基线 = 当前生产 listRooms（MATERIALIZED member_counts CTE，见
 * lobby-service.ts）。fresh 500 房档仍有约 50ms 残余成本，逐一用
 * NULL/常量占位去掉 viewer_member / accounts / worlds join 归因。
 *
 * 变体只用于诊断（返回字段被占位改写，非语义等价，输出标记
 * diagnostic-only），不提交为生产代码。主测角色 realm_runtime +
 * 事务内 set_config（FORCE RLS 对齐服务路径）；superuser 仅对照。
 *
 * 用法：DATABASE_URL=postgresql://<role>@127.0.0.1:<port>/postgres \
 *   node scripts/lobby-residual-joins-diagnosis.mjs
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

// 当前生产 NEW 查询（逐字对齐 lobby-service.ts listRooms；$1/$2 内联字面量）。
const FULL_SQL = (ws, principal) =>
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

// diagnostic-only 变体：占位去掉单个 join，其余形态不变（字段被改写，非语义等价）。
const VARIANTS = {
  full: (ws, principal) => FULL_SQL(ws, principal),
  noViewerMember: (ws, principal) =>
    FULL_SQL(ws, principal)
      .replace("viewer_member.role AS viewer_role", "NULL::text AS viewer_role")
      .replace(
        `LEFT JOIN lobby_room_members AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
            AND viewer_member.principal_id = ${principal}
            AND viewer_member.left_at IS NULL`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS room_id) AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id`,
      ),
  noAccounts: (ws, principal) =>
    FULL_SQL(ws, principal)
      .replace("host_account.display_name AS host_display_name", "NULL::text AS host_display_name")
      .replace(
        `LEFT JOIN accounts AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS principal_id, NULL::text AS display_name) AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id`,
      ),
  noWorlds: (ws, principal) =>
    FULL_SQL(ws, principal)
      .replace("world.name AS world_name", "NULL::text AS world_name")
      .replace(
        `LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS id, NULL::text AS name) AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id`,
      ),
  // noJoins：三重替换在同一字符串上完成（隔离房间扫描 + CTE + 排序基线）。
  noJoins: (ws, principal) => {
    let sql = FULL_SQL(ws, principal);
    sql = sql
      .replace("viewer_member.role AS viewer_role", "NULL::text AS viewer_role")
      .replace("host_account.display_name AS host_display_name", "NULL::text AS host_display_name")
      .replace("world.name AS world_name", "NULL::text AS world_name")
      .replace(
        `LEFT JOIN accounts AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS principal_id) AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id`,
      )
      .replace(
        `LEFT JOIN lobby_room_members AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
            AND viewer_member.principal_id = ${principal}
            AND viewer_member.left_at IS NULL`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS room_id) AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id`,
      )
      .replace(
        `LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id`,
        `LEFT JOIN (SELECT NULL::text AS workspace_id, NULL::text AS id) AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id`,
      );
    return sql;
  },
};

for (const [name, build] of Object.entries(VARIANTS)) {
  const sql = build("'ws_diag'", "'principal_a'");
  if (name !== "full" && sql === FULL_SQL("'ws_diag'", "'principal_a'")) {
    throw new Error(`variant ${name} extraction failed (source SQL drift)`);
  }
}

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();
const createdDatabases = [];

async function migrate(pool) {
  const dir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort()) {
    if (f.endsWith(".sql")) await pool.query(await readFile(new URL(f, dir), "utf8"));
  }
}

async function seedScale(pool, workspaceId, roomCount) {
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'diag')`, [workspaceId]);
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

/**
 * realm_runtime + FORCE RLS：每条 SQL（含原始计时）都必须在事务内
 * set_config 后执行——否则 workspace 策略直接返回 0 行。事务/ROLLBACK
 * 开销对所有变体一致，归因不受影响（输出注明该常量开销存在）。
 * EXPLAIN ANALYZE 带 instrumentation，仅用于计划/缓冲取证。
 */
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
    if (index === 0) continue; // warm-up 丢弃
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
  const name = `realm_lobby_resid_${Math.random().toString(36).slice(2, 10)}`;
  createdDatabases.push(name);
  await maintenance.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString.href);
  url.pathname = `/${name}`;
  const runtimeUrl = new URL(url.href);
  runtimeUrl.username = "realm_runtime";
  const workspaceId = "ws_diag";
  const ws = `'${workspaceId}'`;
  const principal = `'principal_a'`;
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  try {
    const setupPool = new pg.Pool({ connectionString: url.href, max: 2 });
    await migrate(setupPool);
    await seedScale(setupPool, workspaceId, roomCount);
    await setupPool.end();

    const runVariants = async () => {
      const out = {};
      for (const [variant, build] of Object.entries(VARIANTS)) {
        out[variant] = await measure(client, workspaceId, build(ws, principal), RUNS);
      }
      return out;
    };
    const fresh = await runVariants();
    // VACUUM 需要 superuser（realm_runtime 无表所有权）。
    const superClient = new pg.Client({ connectionString: url.href });
    await superClient.connect();
    await superClient.query("VACUUM ANALYZE lobby_room_members");
    await superClient.query("VACUUM ANALYZE lobby_rooms");
    await superClient.query("VACUUM ANALYZE accounts");
    await superClient.end();
    const analyzed = await runVariants();
    return { rooms: roomCount, fresh, analyzed };
  } finally {
    await client.end().catch(() => undefined);
  }
}

try {
  const scales = [];
  for (const scale of SCALES) {
    scales.push(await measureScale(scale));
  }
  const report = {
    scenario: "lobby-residual-joins-diagnosis",
    base: "当前生产 listRooms（MATERIALIZED member_counts CTE）",
    role: "realm_runtime（FORCE RLS + 事务内 set_config）；raw 计时含统一事务/set_config 常量开销",
    diagnosticOnly: "noViewerMember/noAccounts/noWorlds/noJoins 变体以 NULL 占位改写返回字段，非语义等价，仅用于归因",
    runsPerMeasurement: RUNS,
    scales,
  };
  console.log(JSON.stringify(report, null, 2));
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
  console.error(`[diagnosis] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
} finally {
  for (const name of createdDatabases) {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
  await maintenance.end();
}
