#!/usr/bin/env node
/**
 * REALM 桌面 launcher（Windows x64 + macOS arm64/x64 unsigned preview；跨平台 Node 脚本，
 * 在打包形态下由 bundled Node 运行，在开发机上由系统 Node 运行）。
 *
 * 职责：
 * - 解析安装目录（REALM_HOME=launcher 上一级）与数据目录
 *   （REALM_DATA_HOME 覆盖；缺省 Windows=%LOCALAPPDATA%/REALM，
 *   其它平台=~/.local/share/REALM）；
 * - single-instance lock（stale 可恢复；活跃实例给清晰错误）；
 * - 选择未占用 loopback app/PG 端口，组装 child env（连接串/密码绝不打印）；
 * - 首启顺序：PG start → provision → migrations → demo seed → app start
 *   → health → 打开系统浏览器；已有数据幂等；
 * - 唯一父进程：管理 PG postmaster（经 local-postgres.mjs）与 app server
 *   （dev-server.mjs start），Ctrl-C/exit/child failure 优雅停止；
 * - `--check`：完整启动 → health → 取首页 → 优雅停止 → exit 0（CI smoke）。
 *
 * Tauri 协同：`realm-service-host.mjs` 以 JSON-lines 协议包装 startRealm，
 * 供 Tauri Rust controller spawn/解析（桌面「打开网页/打开客户端」选择
 * 界面与 Android client-only 共用同一服务语义）；launcher 自身 CLI 行为
 * 不变。
 *
 * 边界：不启动 propagation worker；不改 Record/Event/RLS/模型语义；
 * 不携带也不输出任何凭据。
 */
import { spawn, spawnSync } from "node:child_process";
import { normalizeAdvertisedOrigin } from "./advertised-origin.mjs";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveDataHome(environment = process.env, platform = process.platform) {
  const explicit = environment.REALM_DATA_HOME?.trim();
  if (explicit) return explicit;
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim()
      ?? resolve(homedir(), "AppData", "Local");
    return resolve(localAppData, "REALM");
  }
  if (platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "REALM");
  }
  return resolve(homedir(), ".local", "share", "REALM");
}

export function platformTag(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `darwin-${arch}`;
  }
  return null;
}

export function realmHome(launcherDir = fileURLToPath(new URL(".", import.meta.url))) {
  return resolve(launcherDir, "..");
}

/** loopback 端口候选：首选 + 顺移候选段（冲突时递增 10，最多 5 档）。 */
export function portCandidates(preferred, slots = 5) {
  return Array.from({ length: slots }, (_, index) => preferred + index * 10);
}

async function portFree(port) {
  const { createServer } = await import("node:net");
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export async function pickPort(candidates) {
  for (const port of candidates) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free loopback port among: ${candidates.join(", ")}`);
}

// ---- single-instance lock ----

export function lockPath(dataHome) {
  return resolve(dataHome, "realm.lock");
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireLock(dataHome, { now = () => new Date() } = {}) {
  mkdirSync(dataHome, { recursive: true });
  const path = lockPath(dataHome);
  const contents = `${JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // wx 是 single-instance 的关键：检查与创建必须是一个原子动作。
      writeFileSync(path, contents, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    try {
      const existing = JSON.parse(readFileSync(path, "utf8"));
      if (processAlive(existing?.pid)) {
        throw new LauncherError(
          "REALM is already running. Close the existing window first "
          + "(or stop the running launcher process).",
        );
      }
      // stale lock：旧实例已退出，回收后重新以 wx 抢占。
    } catch (error) {
      if (error instanceof LauncherError) throw error;
      // 损坏的 lock 文件按 stale 处理。
    }
    rmSync(path, { force: true });
  }
  throw new LauncherError("could not acquire the REALM instance lock safely.");
}

export function releaseLock(path, expectedPid = process.pid) {
  try {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    if (existing?.pid !== expectedPid) return;
    rmSync(path, { force: true });
  } catch {
    // best effort：锁文件残留会按 stale 回收。
  }
}

/**
 * advertised origin 解析（纯函数，可单测）：
 * 显式 option > REALM_ADVERTISED_ORIGIN > --lan 具体 IPv4 推导 > null。
 * 非法显式/环境值 fail-closed 抛 LauncherError（不 echo 原值）；
 * 0.0.0.0 与 loopback 不推导，返回 null（调用方给清晰提示）。
 */
export function resolveAdvertisedOrigin(input) {
  const explicit = input?.explicit;
  const fromEnv = input?.environment?.REALM_ADVERTISED_ORIGIN;
  const requested = explicit ?? fromEnv;
  if (requested !== undefined && requested !== null && String(requested).trim()) {
    const parsed = normalizeAdvertisedOrigin(requested);
    if (!parsed.origin) {
      throw new LauncherError(
        "REALM_ADVERTISED_ORIGIN/--advertised-origin is invalid: "
        + "expect an http(s) origin without credentials, path, query or fragment.",
      );
    }
    return parsed.origin;
  }
  const bind = input?.lanBind;
  if (bind && bind !== "0.0.0.0" && bind !== "127.0.0.1") {
    return `http://${bind}:${input.appPort}`;
  }
  return null;
}

export class LauncherError extends Error {}

export function validateLanBind(value) {
  const bind = value.trim();
  if (bind === "0.0.0.0") return bind;
  const octets = bind.split(".");
  if (
    octets.length !== 4
    || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
  ) {
    throw new LauncherError(`LAN bind must be an explicit IPv4 address, got: ${bind}`);
  }
  return bind;
}

// ---- child env ----

export function buildChildEnv(input) {
  const pgUrl = (user) =>
    `postgresql://${user}@127.0.0.1:${input.pgPort}/realm_local`;
  const platform = input.platform ?? process.platform;
  const bundledPgLibrary = input.pgLibraryPath
    ?? ((platform === "darwin" || platform === "linux") && input.pgBin
      ? resolve(input.pgBin, "..", "lib")
      : undefined);
  return {
    ...safeParentEnv(input.environment ?? process.env),
    HOST_BIND: input.hostBind ?? "127.0.0.1",
    PORT: String(input.appPort),
    REALM_DATA_HOME: input.dataHome,
    // 仅打包形态显式提供 pgBin 时才注入；开发模式沿用 local-postgres 默认。
    ...(input.pgBin ? { REALM_POSTGRES_BIN: input.pgBin } : {}),
    ...(bundledPgLibrary && platform === "darwin"
      ? {
        DYLD_LIBRARY_PATH: [
          bundledPgLibrary,
          input.environment?.DYLD_LIBRARY_PATH,
        ].filter(Boolean).join(delimiter),
      }
      : {}),
    ...(bundledPgLibrary && platform === "linux"
      ? {
        LD_LIBRARY_PATH: [
          bundledPgLibrary,
          input.environment?.LD_LIBRARY_PATH,
        ].filter(Boolean).join(delimiter),
      }
      : {}),
    REALM_POSTGRES_PORT: String(input.pgPort),
    REALM_POSTGRES_SOCKET_DIR: resolve(input.dataHome, "postgres", "socket"),
    DATABASE_URL: pgUrl("postgres"),
    REALM_RUNTIME_DATABASE_URL: pgUrl("realm_runtime"),
    REALM_TRANSFER_DATABASE_URL: pgUrl("realm_transfer"),
    // LAN 模式的唯一例外：显式注入访问令牌（父 env 默认不透出任何 secret；
    // 非 LAN 模式绝不注入，保持本地单用户回落语义）。
    ...(input.accessToken ? { REALM_ACCESS_TOKEN: input.accessToken } : {}),
    // 显式校验过的 advertised origin 覆盖白名单透传（同名键后写生效）。
    ...(input.advertisedOrigin
      ? { REALM_ADVERTISED_ORIGIN: input.advertisedOrigin }
      : {}),
  };
}

// 只继承运行时所需的无敏感环境变量。宿主进程可能携带
// OPENAI_API_KEY、*_TOKEN、*_PASSWORD 等值，不能把整个 process.env
// 透传给 bundled Node / PostgreSQL 子进程。
const SAFE_PARENT_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "SystemDrive",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // 动态加载路径不是 secret；Linux 外部/bundled PostgreSQL 依赖它定位
  // 私有 lib（与 darwin 的 DYLD_LIBRARY_PATH 处理同源）。
  "LD_LIBRARY_PATH",
  // 显式 LAN advertised origin（非敏感；校验在 advertised-origin.ts）。
  "REALM_ADVERTISED_ORIGIN",
]);

export function safeParentEnv(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => SAFE_PARENT_ENV_KEYS.has(name)),
  );
}

/** child env 中绝不出现的敏感形态（key/password/secret 值）。 */
export function envHasSecretValues(environment) {
  return Object.entries(environment).some(([name, value]) =>
    /password|secret|token|api[-_]?key/i.test(name) && typeof value === "string" && value.length > 0
  );
}

// ---- 进程编排 ----

function runStep(nodeExe, script, options) {
  const result = spawnSync(nodeExe, [...(options.nodeArgs ?? []), script, ...(options.scriptArgs ?? [])], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    const termination = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    throw new LauncherError(
      `bootstrap step failed (${script}): ${termination}\n${output.slice(-4_000)}`,
    );
  }
  return output;
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function waitForHealth(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 400) return response.status;
    } catch {
      // server not ready yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new LauncherError(`application did not become healthy at ${url} within ${timeoutMs}ms`);
}

export function resolveNodeBinary(
  home,
  platform = process.platform,
  arch = process.arch,
) {
  const tag = platformTag(platform, arch);
  if (tag) {
    const relativePath = platform === "win32"
      ? ["node.exe"]
      : ["bin", "node"];
    const bundled = resolve(home, "runtime", "node", tag, ...relativePath);
    if (existsSync(bundled)) return bundled;
  }
  // 开发/CI：系统 Node（本进程 execPath）。
  return process.execPath;
}

export function resolvePgBin(
  home,
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
) {
  const tag = platformTag(platform, arch);
  if (tag) {
    const bundled = resolve(home, "pgsql", tag, "bin");
    if (existsSync(bundled)) return bundled;
    // 兼容早期 bundle 组装布局；新包统一写入 pgsql/<platform-tag>/bin。
    const flat = resolve(home, "pgsql", "bin");
    if (existsSync(flat)) return flat;
  }
  // 开发/CI：沿用 local-postgres 的默认/REALM_POSTGRES_BIN。
  return environment.REALM_POSTGRES_BIN ?? "";
}

export async function startRealm(options = {}) {
  const home = options.home ?? realmHome();
  const dataHome = options.dataHome ?? resolveDataHome();
  const parentEnvironment = options.environment ?? process.env;
  // LAN 模式校验必须早于任何副作用（日志流/实例锁/子进程）：非法 bind /
  // 缺门禁令牌时 fail-closed，不留文件、不持锁。
  let hostBind = "127.0.0.1";
  let accessToken = "";
  // advertised origin：显式 option > 环境变量；非法值在任何副作用之前
  // fail-closed（错误不 echo 原值——可能内嵌 userinfo）。0.0.0.0 或纯
  // loopback 时不得推导可分享地址（仅具体 IPv4 LAN bind 可安全推导）。
  // 先只校验显式/env 值；LAN 推导在端口选定后由同一纯函数完成。
  resolveAdvertisedOrigin({
    explicit: options.advertisedOrigin ?? null,
    environment: parentEnvironment,
    lanBind: null,
    appPort: 0,
  });
  const requestedLanBind = options.lanBind ?? parentEnvironment.REALM_LAN_BIND;
  if (requestedLanBind?.trim()) {
    const bind = validateLanBind(requestedLanBind);
    accessToken = (parentEnvironment.REALM_ACCESS_TOKEN ?? "").trim();
    if (!accessToken) {
      throw new LauncherError(
        "LAN mode requires REALM_ACCESS_TOKEN to be set (access gate is mandatory on LAN).",
      );
    }
    hostBind = bind;
  }
  const logFile = resolve(dataHome, "logs", "launcher.log");
  mkdirSync(resolve(dataHome, "logs"), { recursive: true });
  const logStream = createWriteStream(logFile, { flags: "a" });
  const log = (line) => {
    logStream.write(`${new Date().toISOString()} ${line}\n`);
  };
  // Tauri host 等编排方可经 onStep 拿到结构化步骤事件（lock/postgres/
  // provision/migrations/seed/server/health/ready）；日志行不变。
  const step = (name) => {
    try {
      options.onStep?.(name);
    } catch { /* 编排方回调故障不阻断启动 */ }
  };
  // 锁必须在任何启动动作之前获得。
  const acquiredLockPath = acquireLock(dataHome, options.lock);
  step("lock");
  const nodeExe = options.nodeExe ?? resolveNodeBinary(home);
  // 双形态：打包形态 home/app 为应用目录；开发形态（repo 根）自身即应用目录。
  const bundledAppDir = resolve(home, "app");
  const appDir = options.appDir
    ?? (existsSync(resolve(bundledAppDir, "scripts", "dev-server.mjs"))
      ? bundledAppDir
      : home);
  const pgBin = options.pgBin ?? resolvePgBin(home);
  const appPort = options.appPort ?? await pickPort(portCandidates(9999));
  const pgPort = options.pgPort ?? await pickPort(portCandidates(55432));
  // 0.0.0.0 仅接受显式传入并记录醒目警告——绝不默认/硬编码。
  if (hostBind === "0.0.0.0") {
    log("WARNING: LAN bind 0.0.0.0 exposes REALM on every interface; trusted LAN only.");
  }
  // 推导：显式 origin 优先；--lan 为具体 IPv4 且未显式配置时推导
  // http://<lanBind>:<appPort>；0.0.0.0 给清晰提示（不生成可分享地址）。
  const advertisedOrigin = resolveAdvertisedOrigin({
    explicit: options.advertisedOrigin ?? null,
    environment: parentEnvironment,
    lanBind: hostBind,
    appPort,
  });
  if (advertisedOrigin && hostBind !== "127.0.0.1" && hostBind !== "0.0.0.0"
    && !options.advertisedOrigin && !parentEnvironment.REALM_ADVERTISED_ORIGIN) {
    log(`advertised origin derived from LAN bind: ${hostBind} (port ${appPort})`);
  }
  if (!advertisedOrigin && hostBind === "0.0.0.0") {
    log("WARNING: 0.0.0.0 bind has no shareable address; set REALM_ADVERTISED_ORIGIN explicitly for invite links.");
  }
  const childEnv = buildChildEnv({
    dataHome,
    pgBin,
    appPort,
    pgPort,
    hostBind,
    accessToken,
    advertisedOrigin,
    environment: parentEnvironment,
  });
  log(`realm home=${home} node=${nodeExe} appPort=${appPort} pgPort=${pgPort}`);

  const appScriptDir = resolve(appDir, "scripts");
  let appServer = null;
  let stopped = false;
  const stop = async (reason) => {
    if (stopped) return;
    stopped = true;
    log(`shutdown: ${reason}`);
    try {
      appServer?.kill("SIGTERM");
    } catch { /* already gone */ }
    try {
      spawnSync(nodeExe, [resolve(appScriptDir, "local-postgres.mjs"), "stop"], {
        cwd: appDir,
        env: childEnv,
        stdio: "ignore",
      });
    } catch { /* best effort */ }
    releaseLock(acquiredLockPath);
    await new Promise((resolvePromise) => logStream.end(resolvePromise));
  };

  try {
    // 首启/幂等启动：PG start → provision → migrations → seed（脚本自身幂等）。
    log("step: postgres start");
    step("postgres");
    // 必须显式传 "start"：local-postgres.mjs 缺省动作是 "status"（只读
    // 检查），fresh 数据目录下缺省调用会误报 not ready。
    runStep(nodeExe, resolve(appScriptDir, "local-postgres.mjs"), {
      cwd: appDir,
      env: childEnv,
      nodeArgs: [],
      scriptArgs: ["start"],
    });
    log("step: provision realm_transfer");
    step("provision");
    runStep(nodeExe, resolve(appScriptDir, "local-provision-realm-transfer.mjs"), {
      cwd: appDir,
      env: childEnv,
    });
    log("step: migrations");
    step("migrations");
    runStep(nodeExe, resolve(appScriptDir, "postgres-migrate.mjs"), {
      cwd: appDir,
      env: childEnv,
    });
    log("step: demo seed");
    step("seed");
    // seed 链会加载 TS 源码（database/postgres/public.ts），需要 strip-types。
    runStep(nodeExe, resolve(appScriptDir, "postgres-seed-demo.mjs"), {
      cwd: appDir,
      env: childEnv,
      nodeArgs: ["--experimental-strip-types"],
    });

    log("step: app server start");
    step("server");
    appServer = spawn(nodeExe, [resolve(appScriptDir, "dev-server.mjs"), "start"], {
      cwd: appDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appServer.stdout?.on("data", (chunk) => logStream.write(chunk));
    appServer.stderr?.on("data", (chunk) => logStream.write(chunk));
    appServer.once("exit", (code) => {
      if (!stopped) {
        void stop(`app server exited unexpectedly (code ${code})`).then(() => {
          process.exitCode = code ?? 1;
        });
      }
    });

    const url = hostBind === "0.0.0.0"
      ? `http://127.0.0.1:${appPort}/`
      : `http://${hostBind}:${appPort}/`;
    log("step: health");
    step("health");
    await waitForHealth(url);
    log(`ready: ${url}`);
    step("ready");

    if (!options.noBrowser) openBrowser(url);
    return {
      url,
      appPort,
      pgPort,
      dataHome,
      advertisedOrigin,
      stop: () => stop("requested"),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let postgresLog = "";
    try {
      postgresLog = readFileSync(resolve(dataHome, "postgres", "postgres.log"), "utf8").trim();
    } catch {
      // Preserve the original bootstrap error when no PostgreSQL log exists.
    }
    const detail = postgresLog
      ? `${reason}\nPostgreSQL server log:\n${postgresLog.slice(-4_000)}`
      : reason;
    await stop(detail);
    if (detail === reason) throw error;
    throw new LauncherError(detail);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const noBrowser = check || args.includes("--no-browser");
  const optionValue = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const handle = await startRealm({
    noBrowser,
    ...(optionValue("--home") ? { home: optionValue("--home") } : {}),
    ...(optionValue("--data-home") ? { dataHome: optionValue("--data-home") } : {}),
    ...(optionValue("--lan") ? { lanBind: optionValue("--lan") } : {}),
    ...(optionValue("--advertised-origin")
      ? { advertisedOrigin: optionValue("--advertised-origin") }
      : {}),
  });
  console.log(`REALM is running at ${handle.url} (data: ${handle.dataHome})`);
  if (check) {
    // CI smoke：取首页验证 SSR 后优雅停止。
    const response = await fetch(handle.url);
    const html = await response.text();
    if (response.status !== 200 || !html.includes("<title>")) {
      throw new LauncherError(`smoke check failed: status ${response.status}`);
    }
    await handle.stop();
    console.log("REALM launcher smoke check passed.");
    return;
  }
  const shutdown = () => {
    void handle.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function sameFile(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

// macOS exposes /tmp and /var through /private symlinks. Node may canonicalize the
// imported module URL while argv keeps the spelling used by the shell, so a plain
// string comparison can silently skip main() in package smoke tests and at launch.
const isDirectRun = process.argv[1]
  && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof LauncherError ? error.message : `launcher failed: ${error}`);
    process.exitCode = 1;
  });
}
