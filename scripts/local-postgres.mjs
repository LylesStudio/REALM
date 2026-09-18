import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
// 重定位（desktop launcher）：REALM_DATA_HOME 设置时，数据/日志/socket 默认
// 全部落在数据目录；未设置时保持开发者既有 `.local/postgres` 行为。
// Windows：可执行名带 .exe；不使用 unix socket（-k 仅 POSIX）；路径不依赖 POSIX。
const dataHome = process.env.REALM_DATA_HOME?.trim();
const postgresRoot = process.env.REALM_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const dataDirectory = process.env.REALM_POSTGRES_DATA_DIR
  ?? (dataHome
    ? resolve(dataHome, "postgres", "data")
    : resolve(projectRoot, ".local/postgres/data"));
const logPath = process.env.REALM_POSTGRES_LOG
  ?? (dataHome
    ? resolve(dataHome, "postgres", "postgres.log")
    : resolve(projectRoot, ".local/postgres/postgres.log"));
const socketDirectory = process.env.REALM_POSTGRES_SOCKET_DIR ?? "/tmp/realm-pg";
const host = "127.0.0.1";
const port = process.env.REALM_POSTGRES_PORT ?? "5432";
const database = process.env.REALM_POSTGRES_DB ?? "realm_local";
const action = process.argv[2] ?? "status";
const exeSuffix = process.platform === "win32" ? ".exe" : "";

function executable(name) {
  const path = resolve(postgresRoot, `${name}${exeSuffix}`);
  if (!existsSync(path)) {
    throw new Error(
      `Local PostgreSQL executable not found: ${path}. Install postgresql@17 locally or set REALM_POSTGRES_BIN.`,
    );
  }
  return path;
}

function run(name, args, options = {}) {
  const result = spawnSync(executable(name), args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture
      ? [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(`${name} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function controlStatus() {
  return run("pg_ctl", ["-D", dataDirectory, "status"], {
    allowFailure: true,
    capture: true,
  });
}

function readiness() {
  return run(
    "pg_isready",
    ["-h", host, "-p", port, "-d", database],
    { allowFailure: true, capture: true },
  );
}

function initialize() {
  if (existsSync(resolve(dataDirectory, "PG_VERSION"))) return;
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(socketDirectory, { recursive: true });
  // Windows initdb 不支持 --auth-local；trust 仅限本地开发/打包集群
  // （生产部署必须改密码认证——见桌面打包文档）。
  run("initdb", [
    "-D",
    dataDirectory,
    "--encoding=UTF8",
    "--locale=C",
    // 连接串固定使用 postgres 超级用户（DATABASE_URL 等）；initdb 缺省
    // 超级用户 = OS 用户名，fresh 集群上会导致 provision/迁移连接失败。
    "--username=postgres",
    ...(process.platform === "win32"
      ? ["--auth=trust"]
      : ["--auth-local=trust", "--auth-host=trust"]),
  ]);
}

function ensureDatabase() {
  // 集群超级用户固定为 postgres（initdb --username=postgres）；psql/
  // createdb 缺省按 OS 用户连接，fresh 集群上 role 不存在。
  const lookup = run(
    "psql",
    [
      "-h",
      host,
      "-p",
      port,
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
    ],
    { capture: true },
  );
  if (lookup.stdout.trim() === "1") return;
  run("createdb", ["-h", host, "-p", port, "-U", "postgres", database]);
}

switch (action) {
  case "start": {
    initialize();
    mkdirSync(socketDirectory, { recursive: true });
    if (controlStatus().status !== 0) {
      if (readiness().status === 0) {
        throw new Error(
          `${host}:${port} is already used by a PostgreSQL server outside this project cluster.`,
        );
      }
      run("pg_ctl", [
        "-D",
        dataDirectory,
        "-l",
        logPath,
        "-o",
        // unix socket 目录仅 POSIX；Windows 走纯 TCP loopback。
        process.platform === "win32"
          ? `-h ${host} -p ${port}`
          : `-h ${host} -p ${port} -k ${socketDirectory}`,
        "-w",
        "start",
      ]);
    }
    ensureDatabase();
    if (readiness().status !== 0) {
      throw new Error("Realm PostgreSQL started but did not become ready.");
    }
    console.log(`Realm PostgreSQL is local-only at ${host}:${port}/${database}.`);
    break;
  }
  case "stop": {
    if (controlStatus().status === 0) {
      run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    console.log("Realm PostgreSQL is stopped.");
    break;
  }
  case "status": {
    const controlled = controlStatus();
    const ready = readiness();
    if (controlled.status === 0 && ready.status === 0) {
      process.stdout.write(controlled.stdout);
      process.stdout.write(ready.stdout);
    } else {
      const detail = [controlled.stderr, ready.stdout, ready.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      console.error(
        `Realm PostgreSQL is not ready${detail ? `:\n${detail}` : "."}`,
      );
      process.exitCode = 1;
    }
    break;
  }
  default:
    throw new Error("Usage: node scripts/local-postgres.mjs start|stop|status");
}
