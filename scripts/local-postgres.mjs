import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
// 数据目录解析优先级：
// 1. REALM_POSTGRES_DATA_DIR（显式最高优先）；
// 2. REALM_DATA_HOME（desktop launcher 重定位）；
// 3. 默认 ~/.local/realm-pgsql/data——用户目录、与源码分离，删除 ~/.realm/app 不丢世界。
// Windows：可执行名带 .exe；不使用 unix socket（-k 仅 POSIX）；路径不依赖 POSIX。
const dataHome = process.env.REALM_DATA_HOME?.trim();
const postgresRoot = process.env.REALM_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const userDataDefault = resolve(homedir(), ".local", "realm-pgsql", "data");
const legacyProjectData = resolve(projectRoot, ".local", "postgres", "data");
const dataDirectory = process.env.REALM_POSTGRES_DATA_DIR
  ? resolve(process.env.REALM_POSTGRES_DATA_DIR)
  : (dataHome
    ? resolve(dataHome, "postgres", "data")
    : userDataDefault);
const logPath = process.env.REALM_POSTGRES_LOG
  ?? (dataHome
    ? resolve(dataHome, "postgres", "postgres.log")
    : resolve(homedir(), ".local", "realm-pgsql", "postgres.log"));
// 旧默认（项目内 .local/postgres）无缝迁移：新位置无数据而旧位置有时整体搬。
// 同分区 renameSync 是原子操作；搬完旧位置不再存在，不会双份占用。
if (
  !process.env.REALM_POSTGRES_DATA_DIR
  && !dataHome
  && !existsSync(resolve(dataDirectory, "PG_VERSION"))
  && existsSync(resolve(legacyProjectData, "PG_VERSION"))
) {
  mkdirSync(dirname(dataDirectory), { recursive: true });
  renameSync(legacyProjectData, dataDirectory);
  console.log(`[local-postgres] migrated data directory: ${legacyProjectData} -> ${dataDirectory}`);
}
const host = "127.0.0.1";
const port = process.env.REALM_POSTGRES_PORT ?? "5432";
const database = process.env.REALM_POSTGRES_DB ?? "realm_local";
const requestedSocketDirectory = process.env.REALM_POSTGRES_SOCKET_DIR ?? "/tmp/realm-pg";
// macOS limits the complete Unix socket path to 103 bytes. Keep the data and
// logs under REALM_DATA_HOME, but fall back to a short per-port socket directory
// for deep temporary/package paths. Application connections use TCP loopback.
const socketFileName = `.s.PGSQL.${port}`;
const socketDirectory = requestedSocketDirectory.length + 1 + socketFileName.length <= 103
  ? requestedSocketDirectory
  : resolve("/tmp", `realm-pg-${port}`);
const action = process.argv[2] ?? "status";
const exeSuffix = process.platform === "win32" ? ".exe" : "";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function executable(name) {
  const path = resolve(postgresRoot, `${name}${exeSuffix}`);
  if (!existsSync(path)) {
    throw new Error(
      `Local PostgreSQL executable not found: ${path}. Install postgresql@17 locally or set REALM_POSTGRES_BIN.`,
    );
  }
  return path;
}

const dockerMode = process.env.REALM_POSTGRES_MODE === "docker";
const dockerImage = process.env.REALM_POSTGRES_DOCKER_IMAGE ?? "pgvector/pgvector:pg17";
const dockerName = process.env.REALM_POSTGRES_DOCKER_NAME ?? "realm-postgres";
const dockerVolume = process.env.REALM_POSTGRES_DOCKER_VOLUME ?? "realm-postgres-data";

function dockerRun(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture
      ? [result.stderr, result.stdout].filter(Boolean).join("\\n").trim()
      : "";
    throw new Error(`docker ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function dockerInspect() {
  return dockerRun(
    ["inspect", "--format", "{{.State.Status}}", dockerName],
    { capture: true, allowFailure: true },
  );
}

function dockerReady() {
  const result = dockerRun(
    ["exec", dockerName, "pg_isready", "-U", "postgres", "-d", database],
    { capture: true, allowFailure: true },
  );
  return result.status === 0;
}

function waitForDockerReady() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (dockerReady()) return;
    spawnSync(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32"
      ? ["/c", "timeout", "/t", "1", "/nobreak"]
      : ["-c", "sleep 1"], { stdio: "ignore" });
  }
  throw new Error(`Docker PostgreSQL did not become ready: ${dockerName}`);
}

function startDocker() {
  const inspected = dockerInspect();
  const state = inspected.status === 0 ? inspected.stdout.trim() : "";
  if (state === "running") {
    waitForDockerReady();
    return;
  }
  if (state) {
    dockerRun(["start", dockerName]);
    waitForDockerReady();
    return;
  }
  dockerRun(["volume", "create", dockerVolume], { capture: true });
  dockerRun([
    "run", "--detach",
    "--name", dockerName,
    "--restart", "unless-stopped",
    "--env", "POSTGRES_USER=postgres",
    "--env", "POSTGRES_DB=" + database,
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--publish", `${host}:${port}:5432`,
    "--volume", `${dockerVolume}:/var/lib/postgresql/data`,
    dockerImage,
  ]);
  waitForDockerReady();
  console.log(`REALM PostgreSQL is local-only in Docker at ${host}:${port}/${database}.`);
}

function stopDocker() {
  const inspected = dockerInspect();
  if (inspected.status === 0 && inspected.stdout.trim() === "running") {
    dockerRun(["stop", dockerName]);
  }
  console.log("REALM Docker PostgreSQL is stopped; its named volume was kept.");
}

function statusDocker() {
  const inspected = dockerInspect();
  if (inspected.status === 0 && inspected.stdout.trim() === "running" && dockerReady()) {
    console.log(`REALM Docker PostgreSQL is ready at ${host}:${port}/${database}.`);
    return;
  }
  console.error(`REALM Docker PostgreSQL is not ready (${dockerName}).`);
  process.exitCode = 1;
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
    const termination = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    throw new Error(`${name} failed (${termination})${detail ? `: ${detail}` : "."}`);
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

function startServer() {
  try {
    run("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      logPath,
      "-o",
      // unix socket 目录仅 POSIX；Windows 走纯 TCP loopback。
      process.platform === "win32"
        ? `-h ${host} -p ${port}`
        : `-h ${host} -p ${port} -k ${shellQuote(socketDirectory)}`,
      "-w",
      "start",
    ]);
  } catch (error) {
    let serverLog = "";
    try {
      serverLog = readFileSync(logPath, "utf8").trim();
    } catch {
      // Preserve the original pg_ctl error when no log was created.
    }
    const detail = serverLog ? `\nPostgreSQL server log:\n${serverLog.slice(-4_000)}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}

switch (action) {
  case "start": {
    if (dockerMode) {
      startDocker();
      break;
    }
    initialize();
    mkdirSync(socketDirectory, { recursive: true });
    if (controlStatus().status !== 0) {
      if (readiness().status === 0) {
        throw new Error(
          `${host}:${port} is already used by a PostgreSQL server outside this project cluster.`,
        );
      }
      startServer();
    }
    ensureDatabase();
    if (readiness().status !== 0) {
      throw new Error("Realm PostgreSQL started but did not become ready.");
    }
    console.log(`Realm PostgreSQL is local-only at ${host}:${port}/${database}.`);
    break;
  }
  case "stop": {
    if (dockerMode) {
      stopDocker();
      break;
    }
    if (controlStatus().status === 0) {
      run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    console.log("Realm PostgreSQL is stopped.");
    break;
  }
  case "status": {
    if (dockerMode) {
      statusDocker();
      break;
    }
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
