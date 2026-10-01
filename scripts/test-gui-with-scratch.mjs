/**
 * Run Playwright against a disposable PostgreSQL cluster and an isolated
 * project copy. The runner refuses shared DB/service fallbacks and deletes only
 * the exact temporary cluster and scratch directory it created.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakeProviderProfile,
  resolveGuiTestAdvertisedOrigin,
  resolveGuiTestOperatorPrincipals,
  targetsGuiAdvertisedOriginSpec,
} from "./gui-scratch-config.mjs";
import {
  dockerAvailable,
  findFreeLoopbackPort,
  startScratchPgCluster,
} from "../tests/helpers/v37-test-cluster.mjs";
import {
  createFakeOpenAiProvider,
  FAKE_PROVIDER_MODEL,
} from "../tests/helpers/fake-openai-provider.mjs";
import { webChildEnv } from "./web-child-env.mjs";

const require = createRequire(import.meta.url);
const pg = require("pg");
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const token = randomBytes(32).toString("hex");
let cluster;
let server;
let stateDirectory;
let fakeProvider;
let finalExitCode = 1;

function spawnExit(command, commandArgs, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? root,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited on ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
}

async function waitForResponse(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Isolated server still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("The isolated REALM server did not become ready.");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => server.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function makeIsolatedProject(directory) {
  const excludedDirectories = new Set([
    ".git", ".local", ".playwright", ".next", ".vinext", "dist", "node_modules",
  ]);
  const physicalProjectFiles = new Set([
    ".gitignore", "package.json", "package-lock.json", "vite.config.ts",
    "next.config.ts", "postcss.config.mjs", "eslint.config.mjs", "tsconfig.json",
    "playwright.config.ts",
  ]);
  async function linkTree(sourceDirectory, destinationDirectory) {
    await mkdir(destinationDirectory, { recursive: true });
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const sourcePath = resolve(sourceDirectory, entry.name);
      const destinationPath = resolve(destinationDirectory, entry.name);
      if (entry.isDirectory() && sourceDirectory === root && entry.name === "tests") {
        await mkdir(destinationPath, { recursive: true });
        const guiSource = resolve(sourcePath, "gui");
        const guiDestination = resolve(destinationPath, "gui");
        await mkdir(guiDestination, { recursive: true });
        for (const guiEntry of await readdir(guiSource, { withFileTypes: true })) {
          if (guiEntry.isFile()) {
            await copyFile(resolve(guiSource, guiEntry.name), resolve(guiDestination, guiEntry.name));
          }
        }
        // GUI spec 需要引用 tests/helpers 的共享 fixture（fake provider 等）：
        // 符号链接到真实仓库（helpers 只读，不写回）。
        const helpersSource = resolve(sourcePath, "helpers");
        try {
          await symlink(helpersSource, resolve(destinationPath, "helpers"), "dir");
        } catch {
          // helpers 目录不存在时忽略。
        }
      } else if (entry.isDirectory()) {
        await linkTree(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        if ([".env", ".env.local", ".env.example", ".realm-transfer-password"].includes(entry.name)) continue;
        if (sourceDirectory === root && physicalProjectFiles.has(entry.name)) {
          await copyFile(sourcePath, destinationPath);
        } else {
          await symlink(sourcePath, destinationPath);
        }
      }
    }
  }
  const project = resolve(directory, "project");
  await linkTree(root, project);
  await copyFile(resolve(root, ".env.example"), resolve(project, ".env.local"));
  await symlink(resolve(root, "node_modules"), resolve(project, "node_modules"), "dir");
  await mkdir(resolve(project, ".vinext"), { recursive: true });
  await mkdir(resolve(project, ".playwright"), { recursive: true });
  return project;
}

async function run() {
  // 真实 provider smoke 的显式 opt-in 先行校验（fail-fast，不起集群）：
  // 缺 REALM_MODEL_PROVIDER 即拒绝，值绝不打印/写日志。
  const realProviderSmoke = process.env.REALM_ENABLE_REAL_PROVIDER_SMOKE === "1";
  if (realProviderSmoke && !process.env.REALM_MODEL_PROVIDER?.trim()) {
    throw new Error(
      "Real-provider smoke requires REALM_MODEL_PROVIDER (values are never logged).",
    );
  }
  const advertisedOrigin = resolveGuiTestAdvertisedOrigin(
    process.env.REALM_GUI_TEST_ADVERTISED_ORIGIN,
    targetsGuiAdvertisedOriginSpec(args),
  );
  if (!(await dockerAvailable())) {
    throw new Error("Docker is required; refusing fallback to any shared database or service.");
  }
  cluster = await startScratchPgCluster({ label: "gui", roles: ["realm_runtime"] });

  const admin = new pg.Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  await admin.query("CREATE DATABASE realm_dev");
  await admin.end();

  const adminUrl = new URL(cluster.adminUrl);
  adminUrl.pathname = "/realm_dev";
  const adminUrlForProvision = new URL(adminUrl);
  adminUrlForProvision.username = "postgres";
  const adminUrlForMigration = new URL(adminUrlForProvision);
  const runtimeUrl = new URL(cluster.runtimeUrl);
  runtimeUrl.pathname = "/realm_dev";
  stateDirectory = await mkdtemp(resolve(tmpdir(), "realm-gui-scratch-"));
  const isolatedProject = await makeIsolatedProject(stateDirectory);
  const secretDirectory = resolve(stateDirectory, "private");
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  const provisionSecret = `${token}-transfer`;
  const provisionSecretPath = resolve(secretDirectory, ".realm-transfer-password");
  await writeFile(provisionSecretPath, `${provisionSecret}\n`, { mode: 0o600 });
  await chmod(provisionSecretPath, 0o600);

  const envKeys = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ",
    "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "LD_LIBRARY_PATH",
  ];
  const preservedEnvironment = Object.fromEntries(
    envKeys.filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  // 默认模式完全离线：确定性 fake provider。真实 provider smoke 是显式
  // opt-in 的独立命令（REALM_ENABLE_REAL_PROVIDER_SMOKE=1）：此时不启动
  // fake、不透传 fake 设置，只把宿主已有的模型供应商环境变量原样透传
  // （值绝不打印/写日志），缺失即 fail-closed 拒绝（已在 run() 开头校验）。
  const REAL_PROVIDER_PASSTHROUGH = [
    "REALM_MODEL_PROVIDER", "REALM_MODEL_BASE_URL", "REALM_MODEL_ID", "REALM_MODEL_API_KEY",
    "REALM_OPENROUTER_BASE_URL", "REALM_OPENROUTER_MODEL",
    "OPENROUTER_API_KEY", "REALM_OPENROUTER_API_KEY",
  ];
  let providerEnv = {};
  if (realProviderSmoke) {
    const present = REAL_PROVIDER_PASSTHROUGH.filter((name) => process.env[name]?.trim());
    providerEnv = Object.fromEntries(present.map((name) => [name, process.env[name]]));
    console.error(`[gui-scratch] real-provider smoke: passing through ${present.length} model env var(s) (values redacted).`);
  } else {
    fakeProvider = await createFakeOpenAiProvider({
      logger: (line) => console.error(`[fake-provider] ${line}`),
    });
    const settingsDirectory = resolve(stateDirectory, "settings");
    await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
    const fakeProfile = createFakeProviderProfile(fakeProvider.baseUrl, FAKE_PROVIDER_MODEL);
    const settingsPath = resolve(settingsDirectory, "model-provider.json");
    await writeFile(settingsPath, `${JSON.stringify(fakeProfile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(settingsPath, 0o600);
    providerEnv = {
      REALM_MODEL_PROVIDER: "custom-openai",
      REALM_MODEL_API_KEY: "",
    };
    console.error("[gui-scratch] deterministic fake provider on loopback (offline default).");
  }
  // F7 fixture（M7 收口）：仅精确目标 f-comfyui-operator.spec.ts 时注入
  // 固定 fixture operator principal；宿主 REALM_OPERATOR_PRINCIPALS 绝不
  // 透传，其它 GUI 命令不携带。同一 resolver 结果派生 testEnv 的显式
  // marker（REALM_GUI_OPERATOR_FIXTURE=1），spec 据此区分「应注入而未
  // 注入（跳过）」与「注入了却被 403（授权回归=失败）」。
  const guiOperatorFixture = resolveGuiTestOperatorPrincipals(args);
  const appEnv = {
    ...preservedEnvironment,
    HOST_BIND: "127.0.0.1",
    // Lobby lease tests need the short TTL documented in z-lobby-lease.spec.ts.
    REALM_LOBBY_LEASE_MS: "3000",
    REALM_LOBBY_REAP_MS: "1000",
    ...(advertisedOrigin
      ? { REALM_ADVERTISED_ORIGIN: advertisedOrigin }
      : {}),
    ...(guiOperatorFixture
      ? { REALM_OPERATOR_PRINCIPALS: guiOperatorFixture }
      : {}),
    ...providerEnv,
    DATABASE_URL: adminUrlForMigration.href,
    REALM_RUNTIME_DATABASE_URL: runtimeUrl.href,
    REALM_SESSION_SECRET: token,
    REALM_DATA_HOME: stateDirectory,
    REALM_PROVISION_SECRET_DIR: secretDirectory,
    NODE_PATH: resolve(root, "node_modules"),
  };
  console.error("[gui-scratch] provisioning disposable roles, migrations and demo seed …");
  const provisionCode = await spawnExit(
    process.execPath,
    ["scripts/local-provision-realm-transfer.mjs"],
    { cwd: isolatedProject, env: { ...appEnv, DATABASE_URL: adminUrlForProvision.href } },
  );
  if (provisionCode !== 0) throw new Error(`Scratch role provisioning exited ${provisionCode}.`);
  const migrationCode = await spawnExit(process.execPath, ["scripts/postgres-migrate.mjs"], {
    cwd: isolatedProject,
    env: appEnv,
  });
  if (migrationCode !== 0) throw new Error(`Scratch migration exited ${migrationCode}.`);
  const seedCode = await spawnExit(
    process.execPath,
    ["--experimental-strip-types", "scripts/postgres-seed-demo.mjs"],
    { cwd: isolatedProject, env: appEnv },
  );
  if (seedCode !== 0) throw new Error(`Scratch seed exited ${seedCode}.`);

  // 0053：seed 后 provision capability 会话密钥（与 appEnv 的
  // REALM_SESSION_SECRET 同值；app 登录的 membership 写入依赖它）。
  const capabilitySessionCode = await spawnExit(
    process.execPath,
    ["--experimental-strip-types", "scripts/local-provision-capability-session.mjs"],
    { cwd: isolatedProject, env: appEnv },
  );
  if (capabilitySessionCode !== 0) throw new Error(`Scratch capability session provisioning exited ${capabilitySessionCode}.`);

  const probe = new pg.Client({ connectionString: adminUrl.href });
  await probe.connect();
  const result = await probe.query(
    `SELECT current_database() AS database_name,
            inet_server_addr()::text AS server_address,
            (SELECT count(*)::int FROM workspaces WHERE id = 'ws_demo') AS demo_workspace_count
       FROM (SELECT 1) AS singleton`,
  );
  await probe.end();
  const row = result.rows[0];
  const addressHost = row?.server_address?.replace(/\/\d+$/, "");
  if (row?.database_name !== "realm_dev"
    || !["127.0.0.1", "::1"].includes(addressHost)
    || row?.demo_workspace_count !== 1) {
    throw new Error("Scratch DB identity, loopback, and demo seed verification failed.");
  }

  const port = await findFreeLoopbackPort();
  const captured = [];
  server = spawn(process.execPath, [
    resolve(root, "node_modules/vinext/dist/cli.js"),
    "dev",
    "--hostname", "127.0.0.1",
    "--port", String(port),
  // Web/Vinext 进程剥离 owner/provision 凭据（DATABASE_URL 只供上面的
  // provision/migrate/seed 步骤）。
  ], { cwd: isolatedProject, env: webChildEnv(appEnv), stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      captured.push(chunk);
      (stream === server.stdout ? process.stdout : process.stderr).write(chunk);
    });
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForResponse(baseUrl, 90_000);
  if (server.exitCode !== null || captured.join("").includes("Another vinext dev server is already running")) {
    throw new Error("The isolated server did not acquire its own project lock.");
  }

  const testEnv = {
    ...preservedEnvironment,
    REALM_GUI_SCRATCH: "1",
    GUI_BASE_URL: baseUrl,
    GUI_AUTH_STATE_PATH: resolve(stateDirectory, "auth-state.json"),
    GUI_OUTPUT_DIR: resolve(stateDirectory, "playwright-output"),
    DATABASE_URL: adminUrl.href,
    REALM_RUNTIME_DATABASE_URL: runtimeUrl.href,
    REALM_SESSION_SECRET: token,
    REALM_DATA_HOME: stateDirectory,
    ...(advertisedOrigin
      ? { REALM_GUI_TEST_ADVERTISED_ORIGIN: advertisedOrigin }
      : {}),
    ...(!realProviderSmoke ? { REALM_DETERMINISTIC_FAKE_PROVIDER: "1" } : {}),
    // 真实 provider smoke 标记原样透传给 spec 门禁（默认缺失=跳过）。
    ...(realProviderSmoke ? { REALM_ENABLE_REAL_PROVIDER_SMOKE: "1" } : {}),
    // F7：marker 只从 resolver 派生（guiOperatorFixture），绝不读宿主环境。
    ...(guiOperatorFixture ? { REALM_GUI_OPERATOR_FIXTURE: "1" } : {}),
    NODE_PATH: resolve(root, "node_modules"),
  };
  const playwright = resolve(root, "node_modules/@playwright/test/cli.js");
  finalExitCode = await spawnExit(process.execPath, [playwright, "test", ...args], {
    cwd: isolatedProject,
    env: testEnv,
  });
}

try {
  await run();
} catch (error) {
  console.error(`[gui-scratch] FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
  finalExitCode = 1;
} finally {
  await stopServer();
  if (fakeProvider) {
    await fakeProvider.stop();
    console.error("[gui-scratch] fake provider stopped.");
  }
  if (cluster) {
    await cluster.stop();
    console.error("[gui-scratch] disposable PostgreSQL container removed.");
  }
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
}

process.exit(finalExitCode);
