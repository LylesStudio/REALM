/**
 * PG 测试辅助：capability 会话证明（0053）。
 * 安装测试专用会话密钥（env + 清缓存），并按同值把密钥副本种子进
 * scratch DB（realm_capability_keys purpose='session'）。全部值是随机
 * 语义的测试常量，绝不使用/读取任何真实密钥或 .env。
 */
import { createSessionValue } from "../../modules/identity/auth.ts";
import {
  resetSessionSecretCache,
  sessionSecret,
} from "../../modules/identity/session-secret.ts";

export const TEST_CAPABILITY_SESSION_SECRET =
  "test-only-capability-session-secret-v0-937451";

export function installTestSessionSecret(): void {
  // runner 已注入（scratch 一次一值）则沿用；否则用显式测试常量。
  if (!process.env.REALM_SESSION_SECRET?.trim()) {
    process.env.REALM_SESSION_SECRET = TEST_CAPABILITY_SESSION_SECRET;
  }
  resetSessionSecretCache();
}

export function sessionProofFor(principalId: string): string {
  return createSessionValue(principalId);
}

/** 以 admin/owner 身份把会话密钥副本种子进 scratch 库（测试夹具）。 */
export async function seedCapabilitySessionKey(
  admin: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  workspaceId: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO realm_capability_keys (workspace_id, kid, key, purpose, status)
     VALUES ($1, 'session-primary', $2, 'session', 'active')
     ON CONFLICT (workspace_id, kid) DO NOTHING`,
    [workspaceId, Buffer.from(sessionSecret(), "utf8")],
  );
}
