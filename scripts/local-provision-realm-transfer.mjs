#!/usr/bin/env node
/**
 * 本地 fresh bootstrap 的 realm_transfer provisioning 步骤（P0-1）。
 *
 * 顺序保证：local-postgres start（initdb/start/create realm_local）之后、
 * postgres-migrate 之前运行——0042 要求 realm_transfer 已由
 * `scripts/provision-realm-transfer.mjs` 创建（migration 永不自建角色）。
 * 本脚本只负责"安全地把密码交给既有 provisioning 入口"：
 *
 * - 密码来源（优先级）：`REALM_TRANSFER_PASSWORD` env（launcher/调用方注入）
 *   → 既有本地密码文件（默认 `.local/postgres/.realm-transfer-password`，
 *   0600，gitignored，可用 `REALM_PROVISION_SECRET_DIR` 覆盖目录）
 *   → 进程内生成随机值并写入该文件（0600），后续重启复用，不轮换。
 * - 密码绝不打印、不写日志、不进入命令行参数；子进程输出由
 *   provision-realm-transfer 保证零凭据。
 * - 幂等：provisioning 入口对已存在角色走 ALTER ROLE + 负向属性读回；
 *   本地 trust-auth 集群下密码仅供安全契约，launcher 可注入自己的 URL。
 *
 * 用法：node scripts/local-provision-realm-transfer.mjs
 *（DATABASE_URL 缺省为本地开发集群 loopback 值；连接串与密码永不打印。）
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const provisionEntry = resolve(projectRoot, "scripts/provision-realm-transfer.mjs");

function fail(message) {
  console.error(`local-provision-realm-transfer: ${message}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL
  ?? "postgresql://postgres@127.0.0.1:5432/realm_local";
try {
  const url = new URL(connectionString);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    fail("provisioning accepts only a loopback DATABASE_URL.");
  }
} catch (error) {
  if (error instanceof Error && error.message.includes("loopback")) throw error;
  fail(`invalid DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`);
}

function resolvePassword() {
  const fromEnv = process.env.REALM_TRANSFER_PASSWORD?.trim();
  if (fromEnv) return { password: fromEnv, persisted: false };
  const secretDirectory = process.env.REALM_PROVISION_SECRET_DIR
    ?? (process.env.REALM_DATA_HOME?.trim()
      ? resolve(process.env.REALM_DATA_HOME.trim(), "postgres")
      : resolve(projectRoot, ".local/postgres"));
  const secretPath = resolve(secretDirectory, ".realm-transfer-password");
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 12) return { password: existing, persisted: true };
  }
  const generated = randomBytes(24).toString("base64url");
  mkdirSync(secretDirectory, { recursive: true });
  writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return { password: generated, persisted: true };
}

const { password } = resolvePassword();
const result = spawnSync(process.execPath, [provisionEntry], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DATABASE_URL: connectionString,
    REALM_TRANSFER_PASSWORD: password,
  },
  encoding: "utf8",
  stdio: "pipe",
});
// 输出必须保持零凭据：只在失败时回显 provision 入口自身的脱敏信息，
// 且本地生成的密码绝不回显（provision 入口本身不打印密码；双保险）。
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout.includes(password) || stderr.includes(password)) {
  fail("credential leak detected in provisioning output; aborting.");
}
process.stdout.write(stdout);
if (result.status !== 0) {
  process.stderr.write(stderr);
  process.exit(result.status ?? 1);
}
