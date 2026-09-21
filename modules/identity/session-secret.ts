/**
 * 会话签名密钥（server-only）：
 * 1. REALM_SESSION_SECRET 环境变量（显式优先）；
 * 2. 安装级稳定密钥文件 <settingsRoot>/secure/session-secret（0600，
 *    一次性生成后复用——进程重启会话不失效）；
 * 3. 开发兜底常量（仅文件系统不可写时，告警一次）。
 * 绝不读取 REALM_ACCESS_TOKEN（已退役），密钥不进日志/响应。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

let cached: string | null = null;
let warned = false;

export function sessionSecret(): string {
  if (cached) return cached;
  const fromEnv = process.env.REALM_SESSION_SECRET?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  const secretPath = resolve(settingsRoot, "secure", "session-secret");
  try {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch {
    // 不存在则创建（0600 + 原子 rename）。
  }
  try {
    const generated = randomBytes(32).toString("hex");
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${secretPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, secretPath);
    chmodSync(secretPath, 0o600);
    cached = generated;
    return cached;
  } catch {
    if (!warned) {
      warned = true;
      console.warn("[realm] session secret file unavailable; using the development fallback (sessions invalid across restarts)");
    }
    cached = "realm-local-development-only";
    return cached;
  }
}

/** 测试隔离：清除模块级缓存（下个调用重读环境/文件）。 */
export function resetSessionSecretCache(): void {
  cached = null;
}
