/**
 * 大厅性能 baseline（一次性脚本，不入测试门）。
 * 场景 A：N 房间 × 3 成员（N ∈ 50/200/500，每档独立临时库）的 listRooms
 *   耗时/查询数/payload 字节（含 list 开头的 lazy reap 事务开销）。
 * 场景 B：K 个并发大厅 SSE 连接（K ∈ 1/2/4）在 25 秒窗口内由 route 实际
 *   触发的 reap 相关 SQL（以 app/api/lobby/events/route.ts 真实实现为
 *   对象；REALM_LOBBY_REAP_MS/REALM_LOBBY_LEASE_MS 注入 1000ms 加速 tick；
 *   seed 一批已过期房间，统计每个连接的 reap/写/notify SQL 次数）。
 *
 * 用法：DATABASE_URL=postgresql://<role>@127.0.0.1:<port>/postgres \
 *   node scripts/lobby-baseline.mjs
 * 输出：stdout 为 machine-readable JSON；不打印连接串/端口/用户名/错误原文。
 */
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createLobbyService } from "../modules/application/lobby-service.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import {
  assertLoopbackDatabaseUrl,
  categorizeSql,
  createCountingPool,
  safeErrorCategory,
  summarizeDurations,
} from "./baseline-common.mjs";

const RUNS_PER_SCALE = 20;
const LIST_SCALES = [50, 200, 500];
const SSE_CONNECTION_COUNTS = [1, 2, 4];
const SSE_WINDOW_MS = 25_000;
const SSE_EXPIRED_ROOMS = 12;

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();

const createdDatabases = [];

async function createScratchDatabase() {
  const databaseName = `realm_lobby_perf_${Math.random().toString(36).slice(2, 10)}`;
  createdDatabases.push(databaseName);
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const dbUrl = new URL(connectionString.href);
  dbUrl.pathname = `/${databaseName}`;
  return dbUrl;
}

async function migrate(pool) {
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await pool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
}

/** 直接 SQL 批量 seed（setup，不计入 measured；成员=host+2 玩家）。 */
async function seedLobby(pool, workspaceId, roomCount, options = {}) {
  const lease = options.expired
    ? `CURRENT_TIMESTAMP - INTERVAL '10 seconds'`
    : `CURRENT_TIMESTAMP + INTERVAL '1 hour'`;
  await pool.query(
    `INSERT INTO workspaces (id, name) VALUES ($1, 'perf') ON CONFLICT DO NOTHING`,
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
    const roomId = `room_perf_${index}`;
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

async function runListScale(roomCount) {
  const dbUrl = await createScratchDatabase();
  const pool = new pg.Pool({ connectionString: dbUrl.href, max: 4 });
  const counting = createCountingPool(pool);
  try {
    await migrate(counting.pool);
    await seedLobby(counting.pool, "ws_perf", roomCount);
    const setupQueries = counting.state.queries;

    const lobby = createLobbyService(counting.pool);
    const scope = { workspaceId: "ws_perf", principalId: "principal_a" };
    // 首轮 warm-up（不计入）。
    await lobby.listRooms(scope);
    const durations = [];
    let measuredQueries = 0;
    let payloadBytes = 0;
    let actualRooms = 0;
    for (let run = 0; run < RUNS_PER_SCALE; run += 1) {
      const before = counting.state.queries;
      const start = performance.now();
      const rooms = await lobby.listRooms(scope);
      durations.push(performance.now() - start);
      measuredQueries += counting.state.queries - before;
      actualRooms = rooms.length;
      payloadBytes = Buffer.byteLength(JSON.stringify(rooms));
    }
    return {
      targetRooms: roomCount,
      membersPerRoom: 3,
      actualRooms,
      runs: RUNS_PER_SCALE,
      setupQueries,
      warmupRuns: 1,
      measuredQueriesTotal: measuredQueries,
      queriesPerRun: Number((measuredQueries / RUNS_PER_SCALE).toFixed(2)),
      payloadBytes,
      ...summarizeDurations(durations),
    };
  } finally {
    await pool.end();
  }
}

/**
 * 场景 B：真实 route 的并发 SSE reap。route 内部经 getSharedRuntimePool
 * 取池——脚本先取同一池并包装 connect/query 计数（同一进程同一模块实例）。
 * LISTEN 连接由 route 自建的独立 pg.Client 承载，不在计数内（每连接固定
 * 1 条 LISTEN，输出中单独标注）。
 */
async function runSseScenario() {
  const dbUrl = await createScratchDatabase();
  const setupPool = new pg.Pool({ connectionString: dbUrl.href, max: 2 });
  const savedEnv = {
    REALM_RUNTIME_DATABASE_URL: process.env.REALM_RUNTIME_DATABASE_URL,
    REALM_LOBBY_REAP_MS: process.env.REALM_LOBBY_REAP_MS,
    REALM_LOBBY_LEASE_MS: process.env.REALM_LOBBY_LEASE_MS,
    REALM_ACCESS_TOKEN: process.env.REALM_ACCESS_TOKEN,
  };
  const { getSharedRuntimePool, endSharedRuntimePools } = await import("../app/api/world-scope.ts");
  const { GET } = await import("../app/api/lobby/events/route.ts");
  // 新门禁（0051 后）：runtime DB 存在即要求账户会话——注入本地 principal 会话。
  const { createSessionValue } = await import("../modules/identity/auth.ts");
  const sessionCookie = `realm_session=${createSessionValue("principal_perf")}`;
  const totals = { txn: 0, config: 0, notify: 0, reap_write: 0, read: 0, other: 0 };
  try {
    await migrate(setupPool);
    await seedLobby(setupPool, LOCAL_RECORD_SCOPE.workspaceId, SSE_EXPIRED_ROOMS, { expired: true });

    process.env.REALM_RUNTIME_DATABASE_URL = dbUrl.href;
    process.env.REALM_LOBBY_REAP_MS = "1000";
    process.env.REALM_LOBBY_LEASE_MS = "1000";
    delete process.env.REALM_ACCESS_TOKEN;

    const sharedPool = getSharedRuntimePool(dbUrl.href);
    const originalConnect = sharedPool.connect.bind(sharedPool);
    sharedPool.connect = async () => {
      const client = await originalConnect();
      // 每次检出返回新 Proxy（不改动底层 client）——直接赋值 client.query
      // 会让同一池化 client 的 wrapper 反复叠包，计数随复用次数虚增。
      return new Proxy(client, {
        get(clientTarget, clientProp) {
          if (clientProp === "query") {
            return (...args) => {
              totals[categorizeSql(args[0])] += 1;
              return clientTarget.query(...args);
            };
          }
          const value = clientTarget[clientProp];
          return typeof value === "function" ? value.bind(clientTarget) : value;
        },
      });
    };

    const connections = [];
    for (const count of SSE_CONNECTION_COUNTS) {
      const before = { ...totals };
      const readers = [];
      for (let index = 0; index < count; index += 1) {
        const response = await GET(new Request("http://127.0.0.1/api/lobby/events", { headers: { cookie: sessionCookie } }));
        const reader = response.body.getReader();
        readers.push(reader);
        // 等到 snapshot 帧（确认连接建立），有界等待防挂死。
        const first = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot timeout")), 5_000)),
        ]);
        if (first.done) throw new Error("SSE stream closed before snapshot");
      }
      await new Promise((resolve) => setTimeout(resolve, SSE_WINDOW_MS));
      for (const reader of readers) {
        await reader.cancel().catch(() => undefined);
      }
      // 在途 reap 收尾。
      await new Promise((resolve) => setTimeout(resolve, 500));
      const delta = Object.fromEntries(
        Object.keys(totals).map((key) => [key, totals[key] - before[key]]),
      );
      connections.push({
        concurrentConnections: count,
        windowMs: SSE_WINDOW_MS,
        reapTickMs: 1000,
        leaseTtlMs: 1000,
        expiredRoomsSeeded: SSE_EXPIRED_ROOMS,
        sqlTotals: delta,
        sqlPerConnection: Object.fromEntries(
          Object.entries(delta).map(([key, value]) => [key, Number((value / count).toFixed(2))]),
        ),
        uncountedListenQueriesPerConnection: 1,
      });
    }
    return { connections };
  } finally {
    await endSharedRuntimePools();
    await setupPool.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

try {
  const listScales = [];
  for (const scale of LIST_SCALES) {
    listScales.push(await runListScale(scale));
  }
  const sse = await runSseScenario();
  const report = {
    scenario: "lobby-listRooms-and-sse-reap",
    behavior: "listRooms: lazy reap 事务 + 单条聚合 SELECT（含事务开销）；SSE: 每连接每 tick 一次 reapExpired",
    runsPerScale: RUNS_PER_SCALE,
    listScales,
    sseReap: sse,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const scale of listScales) {
    console.error(
      `[summary] rooms=${scale.actualRooms} runs=${scale.runs} `
      + `queries/run=${scale.queriesPerRun} payload=${scale.payloadBytes}B `
      + `avg=${scale.avgMs}ms p50=${scale.p50Ms}ms p95=${scale.p95Ms}ms`,
    );
  }
  for (const entry of sse.connections) {
    console.error(
      `[summary] sse K=${entry.concurrentConnections} window=${entry.windowMs}ms `
      + `per-connection sql=${JSON.stringify(entry.sqlPerConnection)}`,
    );
  }
} catch (error) {
  console.error(`[baseline] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
} finally {
  for (const databaseName of createdDatabases) {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
  }
  await maintenance.end();
}
