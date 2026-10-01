/**
 * Web 子进程环境卫生契约（M5 收口）：owner/provision 专用凭据
 * （DATABASE_URL=postgres 所有者、REALM_PROVISION_SECRET_DIR）绝不进入
 * Web/Vinext 进程。
 *
 * 全部用无害哨兵值；不读任何真实 .env/凭据文件。
 * 钉住：① 剥离助手语义；② launcher 的 bootstrap 步骤保留 owner URL 而
 * Web spawn 剥离；③ dev-server（npm/systemd/直接路径）剥离；
 * ④ setup-web 把 owner 键写进独立 .env.owner.local 而非 .env.local；
 * ⑤ instrumentation.ts 兜底删除（vinext .env.local 自动加载向量）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OWNER_ONLY_ENV_KEYS,
  webChildEnv,
} from "../scripts/web-child-env.mjs";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const SENTINELS = {
  DATABASE_URL: "postgresql://postgres@127.0.0.1:1/sentinel_owner",
  REALM_PROVISION_SECRET_DIR: "/tmp/sentinel-provision-dir",
  REALM_RUNTIME_DATABASE_URL: "postgresql://realm_runtime@127.0.0.1:1/sentinel_runtime",
  REALM_TRANSFER_DATABASE_URL: "postgresql://realm_transfer@127.0.0.1:1/sentinel_transfer",
  REALM_SESSION_SECRET: "sentinel-session-secret-value",
  REALM_DATA_HOME: "/tmp/sentinel-data-home",
  HOST_BIND: "127.0.0.1",
  PORT: "9999",
  PATH: "/usr/bin",
};

test("webChildEnv 只剥离 owner/provision 键，保留应用必需项", () => {
  const sanitized = webChildEnv({ ...SENTINELS });
  for (const key of OWNER_ONLY_ENV_KEYS) {
    assert.equal(sanitized[key], undefined, `${key} 必须被剥离`);
  }
  assert.ok(OWNER_ONLY_ENV_KEYS.includes("DATABASE_URL"));
  assert.ok(OWNER_ONLY_ENV_KEYS.includes("REALM_PROVISION_SECRET_DIR"));
  for (const key of [
    "REALM_RUNTIME_DATABASE_URL",
    "REALM_TRANSFER_DATABASE_URL",
    "REALM_SESSION_SECRET",
    "REALM_DATA_HOME",
    "HOST_BIND",
    "PORT",
    "PATH",
  ]) {
    assert.equal(sanitized[key], SENTINELS[key], `${key} 必须保留`);
  }
  // 不改写传入对象。
  assert.equal(SENTINELS.DATABASE_URL.includes("sentinel_owner"), true);
});

test("launcher：bootstrap 步骤保留 owner URL；Web spawn 用剥离 env", () => {
  const launcher = read("launcher/realm-launcher.mjs");
  // bootstrap（provision/migrate/seed）继续用 childEnv（含 DATABASE_URL）。
  assert.match(launcher, /local-provision-realm-transfer\.mjs"\), \{\s*cwd: appDir,\s*env: childEnv/);
  assert.match(launcher, /postgres-migrate\.mjs"\), \{\s*cwd: appDir,\s*env: childEnv/);
  assert.match(launcher, /postgres-seed-demo\.mjs"/);
  // Web spawn 剥离。
  assert.match(
    launcher,
    /appServer = spawn\(nodeExe, \[resolve\(appScriptDir, "dev-server\.mjs"\), "start"\], \{\s*cwd: appDir,\s*env: webChildEnv\(childEnv\)/,
    "app server 必须用 webChildEnv(childEnv)",
  );
  assert.match(launcher, /import \{ webChildEnv \} from "\.\.\/scripts\/web-child-env\.mjs"/);
});

test("dev-server（npm/systemd/直接路径）：Vinext spawn 剥离 owner 键", () => {
  const devServer = read("scripts/dev-server.mjs");
  assert.match(devServer, /import \{ webChildEnv \} from "\.\/web-child-env\.mjs"/);
  assert.match(devServer, /env: webChildEnv\(\)/);
  // 信号转发语义不回退（wrapper 退出不得留孤儿子进程）。
  assert.match(devServer, /process\.once\("SIGTERM"/);
  assert.match(devServer, /child\.kill\("SIGKILL"\)/);
});

test("setup-web：owner 键写入独立 .env.owner.local；.env.local 不含 DATABASE_URL", () => {
  const setup = read("scripts/setup-web.mjs");
  assert.match(setup, /OWNER_ONLY_ENV_KEYS/);
  assert.match(setup, /"\.env\.owner\.local"/);
  // 写入 .env.local 的内容已剥离 owner 键。
  assert.match(setup, /OWNER_ONLY_ENV_KEYS\.some\(\(key\) => line\.startsWith/);
  const example = read(".env.example");
  assert.doesNotMatch(example, /^DATABASE_URL=/m, ".env.example 不再默认注入 owner URL");
  // db:* 脚本从 owner 文件读 DATABASE_URL。
    const pkg = JSON.parse(read("package.json"));
  for (const scriptName of [
    "db:postgres:start",
    "db:postgres:migrate",
    "db:postgres:seed",
    "db:postgres:provision-capability-session",
  ]) {
    assert.ok(
      pkg.scripts[scriptName]?.includes("--env-file-if-exists=.env.owner.local"),
      `${scriptName} 必须读 .env.owner.local`,
    );
  }
});

test("instrumentation.ts 兜底删除（vinext .env.local 自动加载向量）", () => {
  const hook = read("instrumentation.ts");
  assert.match(hook, /export function register\(\)/);
  assert.match(hook, /delete process\.env\.DATABASE_URL/);
  assert.match(hook, /delete process\.env\.REALM_PROVISION_SECRET_DIR/);
  assert.doesNotMatch(hook, /process\.env\.[A-Z_]+ *=/);
});

test("GUI scratch runner：Web 服务 spawn 剥离 owner 键", () => {
  const runner = read("scripts/test-gui-with-scratch.mjs");
  assert.match(runner, /webChildEnv\(appEnv\)/);
});
