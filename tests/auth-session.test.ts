import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionValue,
  isAccessGateEnabled,
  principalFromRequest,
  principalIdForDisplayName,
  sessionCookieHeader,
  verifySessionValue,
} from "../modules/identity/auth.ts";
import {
  hashAccountPassword,
  verifyAccountPassword,
} from "../modules/identity/password.ts";
import { safeLoginReturnTo } from "../modules/identity/return-to.ts";

// 隔离：createSessionValue/校验需要会话密钥——用测试哨兵值，不读
// cwd/.local 的真实安装密钥（后者按 M5 规则必须 fail-closed 时不受测试影响）。
process.env.REALM_SESSION_SECRET ??= "test-only-auth-session-secret-00001";

test("session value round-trips and rejects tampering and expiry", () => {
  const value = createSessionValue("principal_abc123", 1000);
  assert.equal(verifySessionValue(value, 2000), "principal_abc123");

  // 篡改签名/主体被拒绝。
  const tampered = value.replace("principal_abc123", "principal_evil99");
  assert.equal(verifySessionValue(tampered, 2000), null);
  assert.equal(verifySessionValue(`${value}ff`, 2000), null);
  assert.equal(verifySessionValue("garbage", 2000), null);

  // 过期被拒绝。
  const expired = createSessionValue("principal_abc123", 0);
  assert.equal(verifySessionValue(expired, Date.now() + 1), null);
  // 非 principal 前缀被拒绝。
  assert.equal(verifySessionValue("x.1.z"), null);
});

test("login return_to is restricted to same-origin local paths", () => {
  assert.equal(safeLoginReturnTo("/records/1?tab=events"), "/records/1?tab=events");
  for (const value of ["//evil.example", "\\\\evil.example", "/\\evil.example", "https://evil.example/"]) {
    assert.equal(safeLoginReturnTo(value), "/");
  }
});

test("cookie header is httpOnly with 30-day persistence", () => {
  const header = sessionCookieHeader("principal_abc123");
  assert.match(header, /HttpOnly/);
  assert.match(header, /Max-Age=2592000/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /realm_session=principal_abc123\./);
});

test("principal derivation is deterministic and contains no credential material", () => {
  const first = principalIdForDisplayName("洛川");
  const second = principalIdForDisplayName("洛川");
  assert.equal(first, second);
  assert.match(first, /^principal_[a-f0-9]{18}$/);
  assert.notEqual(principalIdForDisplayName("弥洛"), first);
});

test("access gate follows runtime DB presence; retired token is ignored", () => {
  const savedDb = process.env.REALM_RUNTIME_DATABASE_URL;
  const savedToken = process.env.REALM_ACCESS_TOKEN;
  try {
    delete process.env.REALM_RUNTIME_DATABASE_URL;
    delete process.env.REALM_ACCESS_TOKEN;
    assert.equal(isAccessGateEnabled(), false);

    process.env.REALM_RUNTIME_DATABASE_URL = "postgresql://realm_runtime@127.0.0.1:5432/realm";
    assert.equal(isAccessGateEnabled(), true, "runtime DB 存在即要求账户登录");

    // 退役 token 存在与否不再影响门禁语义。
    process.env.REALM_ACCESS_TOKEN = "legacy-token";
    assert.equal(isAccessGateEnabled(), true);

    delete process.env.REALM_RUNTIME_DATABASE_URL;
    assert.equal(isAccessGateEnabled(), false);

    // 请求级解析：cookie 中的有效会话被接受。
    const value = createSessionValue("principal_demo_player");
    const request = new Request("http://localhost/", {
      headers: { cookie: `other=1; realm_session=${value}` },
    });
    assert.equal(principalFromRequest(request), "principal_demo_player");
    assert.equal(
      principalFromRequest(new Request("http://localhost/")),
      null,
    );
  } finally {
    if (savedDb === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = savedDb;
    if (savedToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
    else process.env.REALM_ACCESS_TOKEN = savedToken;
  }
});

test("password hash: scrypt round-trip, salt per account, strict verify", () => {
  const first = hashAccountPassword("灯塔口令");
  const second = hashAccountPassword("灯塔口令");
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second, "每账户随机 salt");
  assert.equal(verifyAccountPassword("灯塔口令", first), true);
  assert.equal(verifyAccountPassword("灯塔口另", first), false);
  assert.equal(verifyAccountPassword("灯塔口令", null), false);
  assert.equal(verifyAccountPassword("灯塔口令", "garbage"), false);
  assert.equal(verifyAccountPassword("", first), false);
  assert.equal(verifyAccountPassword("灯塔口令", "scrypt$999999999$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"), false);
  assert.equal(verifyAccountPassword("x".repeat(129), first), false);
  assert.ok(!first.includes("灯塔口令"), "hash 不含明文");
});

test("provisioning-grade session secret: weak env/dev-fallback rejected, valid env/file accepted", async () => {
  const { sessionSecretForProvisioning } = await import("../modules/identity/session-secret.ts");
  const saved = process.env.REALM_SESSION_SECRET;
  const savedHome = process.env.REALM_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "realm-prov-secret-"));
  try {
    // 弱 env（短）被拒。
    process.env.REALM_SESSION_SECRET = "test-only-short";
    assert.equal(sessionSecretForProvisioning(), null, "短 env 密钥不得用于 provisioning");
    // 公知开发兜底值（即使经 env 传入）被拒。
    process.env.REALM_SESSION_SECRET = "realm-local-development-only";
    assert.equal(sessionSecretForProvisioning(), null, "开发兜底值不得用于 provisioning");
    // 合格 env 接受。
    process.env.REALM_SESSION_SECRET = "test-only-provisioning-grade-secret-0001";
    const fromEnv = sessionSecretForProvisioning();
    assert.equal(fromEnv?.source, "env");
    // 文件分支：短文件内容被拒；合格内容接受。
    delete process.env.REALM_SESSION_SECRET;
    process.env.REALM_DATA_HOME = dir;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "secure"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "secure", "session-secret"), "too-short\n", { mode: 0o600 });
    assert.equal(sessionSecretForProvisioning(), null, "短文件密钥不得用于 provisioning");
    writeFileSync(join(dir, "secure", "session-secret"), "test-only-file-secret- provisioning-grade-x".replace(" ", ""), { mode: 0o600 });
    const fromFile = sessionSecretForProvisioning();
    assert.equal(fromFile?.source, "file");
  } finally {
    if (saved === undefined) delete process.env.REALM_SESSION_SECRET;
    else process.env.REALM_SESSION_SECRET = saved;
    if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted install key creation: fresh dataHome generates 0600 file in 0700 dir, idempotent, shared with runtime", async () => {
  const { ensureProvisionableSessionSecret, sessionSecret, resetSessionSecretCache } = await import("../modules/identity/session-secret.ts");
  const saved = process.env.REALM_SESSION_SECRET;
  const savedHome = process.env.REALM_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "realm-prov-create-"));
  // 全新目录：无 secure/、无文件。
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  try {
    delete process.env.REALM_SESSION_SECRET;
    process.env.REALM_DATA_HOME = dir;
    const created = ensureProvisionableSessionSecret();
    assert.ok(created, "全新安装必须能创建安装级密钥");
    assert.equal(created!.source, "created");
    assert.ok(created!.secret.length >= 32);
    assert.notEqual(created!.secret, "realm-local-development-only");
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(dir, "secure")).mode & 0o777, 0o700, "目录 0700");
    assert.equal(statSync(join(dir, "secure", "session-secret")).mode & 0o777, 0o600, "文件 0600");
    // 幂等：重复调用返回同值。
    const again = ensureProvisionableSessionSecret();
    assert.equal(again!.secret, created!.secret);
    assert.equal(again!.source, "file");
    // 运行时读取同值（同一个密钥服务两个面）。
    resetSessionSecretCache();
    assert.equal(sessionSecret(), created!.secret);
    resetSessionSecretCache();
  } finally {
    if (saved === undefined) delete process.env.REALM_SESSION_SECRET;
    else process.env.REALM_SESSION_SECRET = saved;
    if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = savedHome;
    resetSessionSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A. session key file safety: insecure existing key fails closed for provisioning and runtime", async () => {
  const {
    sessionSecretForProvisioning,
    ensureProvisionableSessionSecret,
    sessionSecret,
    resetSessionSecretCache,
  } = await import("../modules/identity/session-secret.ts");
  const saved = process.env.REALM_SESSION_SECRET;
  const savedHome = process.env.REALM_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "realm-keymode-"));
  const { chmodSync, symlinkSync, writeFileSync: writeKey, unlinkSync } = await import("node:fs");
  mkdirSync(join(dir, "secure"), { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "secure", "session-secret");
  const VALID_KEY = "test-only-mode-check-secret-value-0001";
  try {
    delete process.env.REALM_SESSION_SECRET;
    process.env.REALM_DATA_HOME = dir;

    // 0644 文件（常见宽松默认）必须 fail-closed。
    writeKey(keyPath, `${VALID_KEY}\n`, { mode: 0o644 });
    assert.equal(sessionSecretForProvisioning(), null, "0644 密钥文件不得用于 provisioning");
    resetSessionSecretCache();
    assert.throws(() => sessionSecret(), /insecure|permission|0600/i, "运行时不得消费不安全的既有密钥");

    // 0700 目录 + 0600 普通文件 → 接受。
    chmodSync(keyPath, 0o600);
    const accepted = sessionSecretForProvisioning();
    assert.equal(accepted?.source, "file");
    resetSessionSecretCache();
    assert.equal(sessionSecret(), VALID_KEY);

    // 符号链接密钥文件 → fail-closed（即使目标合法）。
    unlinkSync(keyPath);
    const realPath = join(dir, "real-secret");
    writeKey(realPath, `${VALID_KEY}\n`, { mode: 0o600 });
    symlinkSync(realPath, keyPath);
    assert.equal(sessionSecretForProvisioning(), null, "符号链接密钥文件不得用于 provisioning");
    resetSessionSecretCache();
    assert.throws(() => sessionSecret(), /insecure|symlink|0600/i);
    unlinkSync(keyPath);

    // 目录权限放开（0755）即使文件 0600 也 fail-closed。
    writeKey(keyPath, `${VALID_KEY}\n`, { mode: 0o600 });
    chmodSync(join(dir, "secure"), 0o755);
    assert.equal(sessionSecretForProvisioning(), null, "目录 0755 时不得用于 provisioning");
    resetSessionSecretCache();
    assert.throws(() => sessionSecret(), /insecure|0700|directory/i);
    chmodSync(join(dir, "secure"), 0o700);

    // ensureProvisionable：不得覆盖既有不安全文件（fail-closed，不创建不替换）。
    chmodSync(keyPath, 0o644);
    assert.equal(ensureProvisionableSessionSecret(), null, "不得用新密钥替换不安全的既有文件");
  } finally {
    if (saved === undefined) delete process.env.REALM_SESSION_SECRET;
    else process.env.REALM_SESSION_SECRET = saved;
    if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = savedHome;
    resetSessionSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2. repeated provisioning reads the existing winner without rotation", async () => {
  const { ensureProvisionableSessionSecret, resetSessionSecretCache } = await import("../modules/identity/session-secret.ts");
  const savedHome = process.env.REALM_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "realm-keyrace-"));
  try {
    delete process.env.REALM_SESSION_SECRET;
    process.env.REALM_DATA_HOME = dir;
    // 已存在的 winner 必须被读取复用；真正并发竞争由 A4 覆盖。
    const winner = ensureProvisionableSessionSecret();
    assert.ok(winner);
    // 重置缓存/清缓存不影响文件；再次 ensure 必须回读同一 winner（不轮换）。
    resetSessionSecretCache();
    const again = ensureProvisionableSessionSecret();
    assert.equal(again!.secret, winner!.secret, "并发/重复首写必须收敛到同一 winner 密钥");
    assert.equal(again!.source, "file");
  } finally {
    if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = savedHome;
    resetSessionSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A3. secure-perms but non-grade key content fails closed everywhere; file left untouched", async () => {
  const {
    sessionSecretForProvisioning,
    ensureProvisionableSessionSecret,
    sessionSecret,
    resetSessionSecretCache,
    InsecureSessionKeyError,
  } = await import("../modules/identity/session-secret.ts");
  const saved = process.env.REALM_SESSION_SECRET;
  const savedHome = process.env.REALM_DATA_HOME;
  const dir = mkdtempSync(join(tmpdir(), "realm-keycontent-"));
  const { readFileSync, statSync, writeFileSync: writeKey } = await import("node:fs");
  const keyPath = join(dir, "secure", "session-secret");
  try {
    delete process.env.REALM_SESSION_SECRET;
    process.env.REALM_DATA_HOME = dir;
    mkdirSync(join(dir, "secure"), { recursive: true, mode: 0o700 });

    // 0600 文件 + 0700 目录，但内容只有 12 字节（不满足密钥契约）。
    writeKey(keyPath, "short-key-12\n", { mode: 0o600 });
    assert.equal(sessionSecretForProvisioning(), null, "内容不合格必须拒绝 provisioning");
    resetSessionSecretCache();
    assert.throws(() => sessionSecret(), InsecureSessionKeyError, "运行时必须抛 InsecureSessionKeyError");
    assert.equal(
      ensureProvisionableSessionSecret(),
      null,
      "provisioning 不得替换内容不合格的既有文件",
    );
    // 文件必须原样保留（不覆盖/不 chmod/不轮换/不删除）。
    assert.equal(readFileSync(keyPath, "utf8"), "short-key-12\n", "既有文件内容必须原样保留");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "既有文件权限不得被改写");

    // 内容为公知开发兜底值（即使权限合规）同样 fail-closed。
    writeKey(keyPath, "realm-local-development-only\n", { mode: 0o600 });
    assert.equal(sessionSecretForProvisioning(), null);
    resetSessionSecretCache();
    assert.throws(() => sessionSecret(), InsecureSessionKeyError);
    assert.equal(ensureProvisionableSessionSecret(), null);
    assert.equal(readFileSync(keyPath, "utf8"), "realm-local-development-only\n");
  } finally {
    if (saved === undefined) delete process.env.REALM_SESSION_SECRET;
    else process.env.REALM_SESSION_SECRET = saved;
    if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = savedHome;
    resetSessionSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4. cross-process first creation is atomic no-replace: 8 ready racers, one winner, all agree", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync, writeFileSync: writeFile, readFileSync, statSync, readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "realm-keyrace-xp-"));
  const barrier = join(dir, "start.flag");
  const secureDir = join(dir, "secure");
  const childPath = new URL("./helpers/session-key-race-child.ts", import.meta.url).pathname;
  const RACER_COUNT = 8;
  const readyPaths = Array.from({ length: RACER_COUNT }, (_, i) => join(dir, `ready-${i}`));
  const runChild = (index: number) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", childPath, dir, barrier, readyPaths[index]!],
        {
          env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
    });
  try {
    // 8 个真实子进程同一 barrier 开跑：只有一个候选可首次落地，
    // 其余 7 个必须读回同一 winner（不得覆盖）。
    const pending = Array.from({ length: RACER_COUNT }, (_, index) => runChild(index));
    const readyDeadline = Date.now() + 15_000;
    while (readyPaths.some((path) => !existsSync(path)) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const allReadyBeforeRelease = readyPaths.every(existsSync);
    writeFile(barrier, "go");
    const finished = await Promise.all(pending);
    assert.equal(allReadyBeforeRelease, true, "所有子进程必须到达 barrier 后才能统一放行");
    const results = finished.map((run, index) => {
      assert.equal(run.code, 0, `racer ${index} 退出异常: ${run.stderr}`);
      return JSON.parse(run.stdout.trim()) as {
        ok: boolean; source: string | null; keyLength: number; keyHash: string | null;
      };
    });
    for (const [index, result] of results.entries()) {
      assert.equal(result.ok, true, `racer ${index} 必须成功（一赢七随）`);
    }
    const hashes = new Set(results.map((result) => result.keyHash));
    assert.equal(hashes.size, 1, "所有参与者必须读回同一 winner 密钥");
    assert.ok(results[0]!.keyLength! >= 32);
    const created = results.filter((result) => result.source === "created");
    const followers = results.filter((result) => result.source === "file");
    assert.equal(created.length, 1, "必须恰好一个创建者");
    assert.equal(followers.length, RACER_COUNT - 1, "其余必须随附读回 winner");
    const keyPath = join(secureDir, "session-secret");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "落地文件必须 0600");
    assert.equal(statSync(secureDir).mode & 0o777, 0o700, "目录必须 0700");
    assert.ok(readFileSync(keyPath, "utf8").trim().length >= 32);
    assert.deepEqual(
      readdirSync(secureDir).filter((name) => name.endsWith(".tmp")),
      [],
      "不得留下临时文件",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A5. poisoned winner: all ready parties fail closed and nothing is replaced", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync, writeFileSync: writeFile, readFileSync, statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "realm-keyrace-poison-"));
  const barrier = join(dir, "start.flag");
  const childPath = new URL("./helpers/session-key-race-child.ts", import.meta.url).pathname;
  const keyPath = join(dir, "secure", "session-secret");
  const readyPaths = [join(dir, "ready-a"), join(dir, "ready-b")];
  mkdirSync(join(dir, "secure"), { recursive: true, mode: 0o700 });
  writeFile(keyPath, "poison-short\n", { mode: 0o600 });
  const runChild = (index: number) =>
    new Promise<{ code: number | null; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", childPath, dir, barrier, readyPaths[index]!],
        {
          env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => resolvePromise({ code, stdout }));
    });
  try {
    const pendingA = runChild(0);
    const pendingB = runChild(1);
    const readyDeadline = Date.now() + 15_000;
    while (readyPaths.some((path) => !existsSync(path)) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const allReadyBeforeRelease = readyPaths.every(existsSync);
    writeFile(barrier, "go");
    const [a, b] = await Promise.all([pendingA, pendingB]);
    assert.equal(allReadyBeforeRelease, true, "双方必须到达 barrier 后才能统一放行");
    const resultA = JSON.parse(a.stdout.trim()) as { ok: boolean };
    const resultB = JSON.parse(b.stdout.trim()) as { ok: boolean };
    assert.equal(resultA.ok, false, "winner 不合法时所有方 fail-closed");
    assert.equal(resultB.ok, false);
    assert.equal(readFileSync(keyPath, "utf8"), "poison-short\n", "毒化文件必须原样保留");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B. production runtime signing path fails closed when no secret source exists (no dev fallback, no cookie)", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "realm-prod-secret-"));
  try {
    // 同名路径被普通文件占用 → <dataHome>/secure 目录创建确定性失败，
    // 安装级密钥无法创建。
    writeFileSync(join(dir, "secure"), "occupied");
    const authModuleUrl = new URL("../modules/identity/auth.ts", import.meta.url).href;
    // 子进程走真实生产签名路径（createSessionValue → sessionSecret）；
    // 最小环境白名单：不继承任何 REALM_* 凭据/生产环境。
    const childScript = `
      const auth = await import(${JSON.stringify(authModuleUrl)});
      try {
        const value = auth.createSessionValue("principal_probe_prod");
        console.log(JSON.stringify({ ok: true, value }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          name: error && error.name ? error.name : "Error",
          message: error && error.message ? String(error.message) : String(error),
        }));
      }
    `;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "--eval", childScript],
          {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              NODE_ENV: "production",
              REALM_DATA_HOME: dir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
      },
    );
    assert.equal(result.code, 0, `子进程必须自行捕获并报告失败: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; name?: string; message?: string; value?: string };
    assert.equal(parsed.ok, false, "production 下无密钥来源必须 fail-closed");
    assert.equal(parsed.name, "SessionSecretUnavailableError", "必须抛稳定的安全错误类别");
    assert.ok(!parsed.message!.includes("realm-local-development-only"), "错误不得含开发兜底值");
    assert.ok(!parsed.message!.includes(dir), "错误不得泄露文件路径");
    assert.ok(!result.stdout.includes("realm-local-development-only"), "绝不输出公开兜底 secret");
    assert.ok(!result.stdout.includes("principal_probe_prod."), "不得产生可用 cookie/signature");
    assert.ok(!result.stderr.includes("realm-local-development-only"), "日志不得含兜底 secret");
    assert.ok(!result.stderr.includes(dir), "日志不得含路径/环境信息");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B2. non-production keeps the development-fallback compat path (warning, secret never printed)", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "realm-dev-secret-"));
  try {
    writeFileSync(join(dir, "secure"), "occupied");
    const authModuleUrl = new URL("../modules/identity/auth.ts", import.meta.url).href;
    const childScript = `
      const auth = await import(${JSON.stringify(authModuleUrl)});
      const value = auth.createSessionValue("principal_probe_dev");
      const roundTrip = auth.verifySessionValue(value) === "principal_probe_dev";
      console.log(JSON.stringify({ ok: true, roundTrip }));
    `;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "--eval", childScript],
          {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              NODE_ENV: "development",
              REALM_DATA_HOME: dir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
      },
    );
    assert.equal(result.code, 0, `开发兼容分支子进程异常: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; roundTrip: boolean };
    assert.equal(parsed.ok, true, "非 production 保留开发兜底兼容");
    assert.equal(parsed.roundTrip, true, "兜底签发的会话必须可校验（重启失效语义不变）");
    assert.ok(!result.stdout.includes("realm-local-development-only"), "secret 不出现在输出");
    assert.ok(!result.stderr.includes("realm-local-development-only"), "secret 不出现在告警日志");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
