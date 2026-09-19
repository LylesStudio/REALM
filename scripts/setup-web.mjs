#!/usr/bin/env node
/**
 * REALM web bootstrap CLI.
 *
 * The CLI is deliberately conservative:
 * - it detects the local toolchain before changing anything;
 * - installation commands require an explicit confirmation (or --yes);
 * - an existing .env.local is never silently overwritten;
 * - PostgreSQL stays on loopback, either through a local PostgreSQL 17 +
 *   pgvector toolchain or a local-only Docker pgvector container;
 * - after bootstrap it starts the dev server and opens the browser.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const MIN_NODE = [22, 13, 0];
const DEFAULT_DATABASE = "realm_local";
const DEFAULT_PORT = 55432;
const DOCKER_IMAGE = "pgvector/pgvector:pg17";
const DOCKER_NAME = "realm-postgres";
const DOCKER_VOLUME = "realm-postgres-data";

function commandPath(name, platform = process.platform) {
  const lookup = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [name], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
}

function commandAvailable(name, platform = process.platform) {
  return Boolean(commandPath(name, platform));
}

export function parseNodeVersion(value) {
  const match = String(value).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

export function versionAtLeast(value, minimum) {
  const actual = Array.isArray(value) ? value : parseNodeVersion(value);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function executableName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

// Windows 可执行体解析：真实安装是 .exe，嵌入式构件的 pg_config 等是
// .cmd 批处理 shim——两种形态都要认（.bat 兜底）。
function resolveExecutablePath(bin, name, platform = process.platform) {
  if (platform !== "win32") {
    const path = join(bin, name);
    return existsSync(path) ? path : null;
  }
  for (const candidate of [`${name}.exe`, `${name}.cmd`, `${name}.bat`]) {
    const path = join(bin, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function hasPostgresTools(bin, platform = process.platform) {
  if (!bin) return false;
  return ["pg_ctl", "initdb", "psql", "createdb", "pg_config"]
    .every((name) => resolveExecutablePath(bin, name, platform) !== null);
}

function candidatePostgresBins(environment, platform) {
  const candidates = [];
  if (environment.REALM_POSTGRES_BIN?.trim()) {
    candidates.push(resolve(environment.REALM_POSTGRES_BIN.trim()));
  }
  // 嵌入式构件（scripts/embedded-pg.mjs install）：免 Docker 的本地 PG17+pgvector。
  if (platform === "linux") {
    candidates.push(
      join(homedir(), ".local", "realm-pgsql", "17.10", "bin"),
      join(homedir(), ".local", "realm-pgsql", "17", "bin"),
    );
  }
  if (platform === "darwin") {
    candidates.push(
      join(homedir(), ".local", "realm-pgsql", "17.10", "bin"),
      "/opt/homebrew/opt/postgresql@17/bin",
      "/usr/local/opt/postgresql@17/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  }
  if (platform === "win32") {
    const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
    candidates.push(
      join(homedir(), ".local", "realm-pgsql", "17.10", "bin"),
      join(programFiles, "PostgreSQL", "17", "bin"),
      join(programFiles, "PostgreSQL", "16", "bin"),
    );
  }
  const pgCtl = commandPath(executableName("pg_ctl", platform), platform);
  if (pgCtl) candidates.push(dirname(pgCtl));
  return [...new Set(candidates)];
}

export function findPostgresBin(environment = process.env, platform = process.platform) {
  return candidatePostgresBins(environment, platform)
    .find((candidate) => hasPostgresTools(candidate, platform)) ?? null;
}

// Windows 上 Node spawn 无法直接执行 .cmd/.bat（CreateProcess 不认脚本，
// 需经 cmd.exe 解释）——嵌入式构件的 pg_config 恰好是 .cmd shim。
function spawnWithShell(command, args, options = {}) {
  const isWinScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  return spawnSync(command, args, {
    ...options,
    ...(isWinScript ? { shell: true } : {}),
  });
}

function pgVectorAvailable(bin, platform = process.platform) {
  if (!bin) return false;
  const pgConfig = resolveExecutablePath(bin, "pg_config", platform);
  if (!pgConfig) return false;
  const result = spawnWithShell(pgConfig, ["--sharedir"], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return false;
  const share = result.stdout.trim();
  return existsSync(join(share, "extension", "vector.control"));
}

export function detectEnvironment({ environment = process.env, platform = process.platform } = {}) {
  const localPostgresBin = findPostgresBin(environment, platform);
  const dockerInstalled = commandAvailable("docker", platform);
  const dockerReady = dockerInstalled
    && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  return {
    platform,
    node: process.versions.node,
    nodeOk: versionAtLeast(process.versions.node, MIN_NODE),
    npm: commandAvailable(platform === "win32" ? "npm.cmd" : "npm", platform),
    localPostgresBin,
    localPgVector: pgVectorAvailable(localPostgresBin, platform),
    dockerInstalled,
    dockerReady,
    brew: platform === "darwin" && commandAvailable("brew", platform),
    winget: platform === "win32" && commandAvailable("winget", platform),
  };
}

export function chooseDatabasePlan(environment) {
  if (environment.localPostgresBin && environment.localPgVector) {
    return { mode: "local", pgBin: environment.localPostgresBin, install: [] };
  }
  if (environment.dockerReady) {
    return { mode: "docker", pgBin: null, install: [] };
  }
  if (environment.platform === "darwin" && environment.brew) {
    return {
      mode: "local",
      pgBin: null,
      install: [{
        command: "brew",
        args: ["install", "postgresql@17", "pgvector"],
        label: "Homebrew PostgreSQL 17 + pgvector",
      }],
    };
  }
  if (environment.platform === "win32" && environment.winget) {
    return {
      mode: "docker",
      pgBin: null,
      install: [{
        command: "winget",
        args: [
          "install",
          "--id",
          "Docker.DockerDesktop",
          "--exact",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ],
        label: "Docker Desktop for Windows",
      }],
    };
  }
  return { mode: "manual", pgBin: null, install: [] };
}

function shellEnvValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "");
}

export function buildDatabaseEnvironment(mode, {
  database = DEFAULT_DATABASE,
  port = DEFAULT_PORT,
  appPort = 9999,
  pgBin = null,
} = {}) {
  const url = (role) => `postgresql://${role}@127.0.0.1:${port}/${database}`;
  const values = {
    DATABASE_URL: url("postgres"),
    REALM_RUNTIME_DATABASE_URL: url("realm_runtime"),
    REALM_TRANSFER_DATABASE_URL: url("realm_transfer"),
    REALM_POSTGRES_MODE: mode,
    REALM_POSTGRES_PORT: String(port),
    REALM_POSTGRES_DB: database,
    HOST_BIND: "127.0.0.1",
    PORT: String(appPort),
  };
  if (mode === "docker") {
    values.REALM_POSTGRES_DOCKER_IMAGE = DOCKER_IMAGE;
    values.REALM_POSTGRES_DOCKER_NAME = DOCKER_NAME;
    values.REALM_POSTGRES_DOCKER_VOLUME = DOCKER_VOLUME;
  } else if (pgBin) {
    values.REALM_POSTGRES_BIN = pgBin;
  }
  return values;
}

export function parseEnvText(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

export function mergeEnvText(text, values) {
  const lines = String(text).split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    const replacement = `${key}=${shellEnvValue(value)}`;
    if (index >= 0) lines[index] = replacement;
    else lines.push(replacement);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(command, args, options = {}) {
  const result = spawnWithShell(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
  return result;
}

function startDockerDesktop(platform) {
  if (platform === "darwin") {
    spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
  } else if (platform === "win32") {
    const candidates = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Docker", "Docker Desktop.exe"),
    ];
    const executable = candidates.find((candidate) => existsSync(candidate));
    if (executable) spawn(executable, [], { detached: true, stdio: "ignore" }).unref();
  }
}

async function confirm(question, assumeYes) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function writeLocalEnv(values) {
  const envPath = resolve(projectRoot, ".env.local");
  let existing = "";
  if (existsSync(envPath)) existing = readFileSync(envPath, "utf8");
  else {
    const template = resolve(projectRoot, ".env.example");
    if (existsSync(template)) copyFileSync(template, envPath);
  }
  const source = existing || (existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
  writeFileSync(envPath, mergeEnvText(source, values), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* Windows has no POSIX mode */ }
  return envPath;
}

function readLocalEnv() {
  const path = resolve(projectRoot, ".env.local");
  return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
}

async function waitForHttpRange(startPort, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let offset = 0; offset < 20; offset += 1) {
      const url = `http://127.0.0.1:${startPort + offset}`;
      try {
        const response = await fetch(url);
        if (response.status >= 200 && response.status < 500) return url;
      } catch {
        // this candidate is not ready
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return null;
}

async function loopbackPortFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export async function chooseDockerPort(preferred = DEFAULT_PORT) {
  for (let offset = 0; offset < 10; offset += 1) {
    const port = preferred + offset * 10;
    if (await loopbackPortFree(port)) return port;
  }
  throw new Error(`No free loopback PostgreSQL port near ${preferred}`);
}

export async function chooseWebPort(preferred = 9999) {
  for (let offset = 0; offset < 20; offset += 1) {
    const port = preferred + offset;
    if (await loopbackPortFree(port)) return port;
  }
  throw new Error(`No free loopback web port near ${preferred}`);
}

function openBrowser(url, platform = process.platform) {
  if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (platform === "win32") spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (commandAvailable("xdg-open", platform)) spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function launchWebServer(environment) {
  const command = npmCommand(process.platform);
  const child = spawn(command, ["run", "dev"], {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  const port = Number(environment.PORT ?? "9999");
  const readyUrl = await waitForHttpRange(port);
  if (!readyUrl) {
    child.kill();
    throw new Error(`REALM did not become ready near http://127.0.0.1:${port}`);
  }
  console.log(`REALM is ready at ${readyUrl}`);
  if (!process.env.REALM_SETUP_WEB_NO_OPEN) openBrowser(readyUrl);
  await new Promise((resolvePromise, reject) => {
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`REALM stopped by ${signal}`));
      else resolvePromise(code ?? 0);
    });
    child.once("error", reject);
  });
}

function printManualPlan(environment) {
  console.error("REALM needs PostgreSQL 17 + pgvector or Docker Desktop.");
  if (environment.platform === "darwin") {
    console.error("Install Homebrew, then run: brew install postgresql@17 pgvector");
  } else if (environment.platform === "win32") {
    console.error("Install Docker Desktop, start it, then run this command again.");
  } else {
    console.error("Install PostgreSQL 17 with pgvector, or Docker, then run this command again.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const assumeYes = argv.includes("--yes");
  const noOpen = argv.includes("--no-open");
  if (noOpen) process.env.REALM_SETUP_WEB_NO_OPEN = "1";
  const environment = detectEnvironment();
  const checkOnly = argv.includes("--check");
  if (checkOnly) {
    const plan = chooseDatabasePlan(environment);
    console.log(JSON.stringify({
      node: environment.node,
      nodeOk: environment.nodeOk,
      npm: environment.npm,
      localPostgres: Boolean(environment.localPostgresBin),
      localPgVector: environment.localPgVector,
      dockerInstalled: environment.dockerInstalled,
      dockerReady: environment.dockerReady,
      databasePlan: plan.mode,
      installActions: plan.install.map((action) => action.label),
    }, null, 2));
    return plan.mode === "manual" || !environment.nodeOk ? 1 : 0;
  }
  if (!environment.nodeOk) {
    console.error(`Node.js ${MIN_NODE.join(".")} or newer is required; current is ${environment.node}.`);
    if (environment.platform === "darwin" && environment.brew
      && await confirm("Install Node.js 22 with Homebrew now?", assumeYes)) {
      runCommand("brew", ["install", "node@22"]);
      console.error("Node.js was installed. Start a new terminal and run npm run setup:web again.");
    }
    return 1;
  }
  if (!environment.npm) throw new Error("npm was not found on PATH.");

  let plan = chooseDatabasePlan(environment);
  for (const action of plan.install) {
    if (!await confirm(`Install ${action.label}?`, assumeYes)) {
      printManualPlan(environment);
      return 1;
    }
    runCommand(action.command, action.args);
  }

  let refreshed = detectEnvironment();
  plan = chooseDatabasePlan(refreshed);
  if (plan.mode === "docker" && !refreshed.dockerReady && refreshed.dockerInstalled) {
    if (!await confirm("Docker is installed but not running. Open Docker Desktop now?", assumeYes)) {
      printManualPlan(refreshed);
      return 1;
    }
    startDockerDesktop(refreshed.platform);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    refreshed = detectEnvironment();
    plan = chooseDatabasePlan(refreshed);
  }
  if (plan.mode === "manual") {
    printManualPlan(refreshed);
    return 1;
  }

  const existingLocalEnv = readLocalEnv();
  const configuredWebPort = Number(existingLocalEnv.PORT ?? 9999);
  const appPort = await chooseWebPort(
    Number.isSafeInteger(configuredWebPort) && configuredWebPort > 0 ? configuredWebPort : 9999,
  );
  const databaseEnvironment = buildDatabaseEnvironment(plan.mode, {
    database: DEFAULT_DATABASE,
    port: plan.mode === "docker" ? await chooseDockerPort() : DEFAULT_PORT,
    appPort,
    pgBin: plan.pgBin,
  });
  const envPath = resolve(projectRoot, ".env.local");
  if (existsSync(envPath)) {
    const current = readLocalEnv();
    const mismatches = Object.keys(databaseEnvironment)
      .filter((key) => current[key] && current[key] !== databaseEnvironment[key]);
    if (mismatches.length > 0 && !await confirm(
      `Update local database settings in .env.local (${mismatches.join(", ")})?`,
      assumeYes,
    )) {
      console.error("Existing .env.local was kept. Resolve the database settings, then rerun setup:web.");
      return 1;
    }
  } else if (!await confirm("Create local .env.local with loopback database settings?", assumeYes)) {
    console.error("No .env.local was created. Rerun setup:web when ready.");
    return 1;
  }
  writeLocalEnv(databaseEnvironment);
  const childEnvironment = { ...process.env, ...readLocalEnv() };

  if (!existsSync(resolve(projectRoot, "node_modules"))) {
    if (!await confirm("Install npm dependencies with npm ci?", assumeYes)) return 1;
    runCommand(npmCommand(process.platform), ["ci"], { env: childEnvironment });
  }
  runCommand(npmCommand(process.platform), ["run", "db:postgres:bootstrap"], {
    env: childEnvironment,
  });
  await launchWebServer(childEnvironment);
  return 0;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { if (code) process.exitCode = code; })
    .catch((error) => {
      console.error(`setup:web failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
