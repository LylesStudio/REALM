/**
 * 账户登录门禁 + identity-aware sessions。
 *
 * 门禁语义（DEPLOY-AUTH 新版）：REALM_RUNTIME_DATABASE_URL 存在 → 页面与
 * API 要求账户会话（账户名 + 可选密码）；缺失 → 纯单机/测试回落本地单用户
 * principal。REALM_ACCESS_TOKEN 已退役——存在也仅被忽略，绝不再作为凭据。
 * Sessions 是 30 天 httpOnly HMAC cookie；cookie 只携带 principalId，
 * 签名密钥来自 session-secret.ts（环境变量 → 安装级 0600 文件 → 开发兜底），
 * 绝不依赖已退役的访问令牌。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "./session-secret.ts";

export const SESSION_COOKIE = "realm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 门禁 = 运行时数据库存在（账户登录需要 accounts 表）。 */
export function isAccessGateEnabled(): boolean {
  return Boolean(process.env.REALM_RUNTIME_DATABASE_URL?.trim());
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

/** principal id 由昵称哈希派生；不包含任何凭据材料。 */
export function principalIdForDisplayName(displayName: string): string {
  const digest = createHmac("sha256", "realm-account-v1")
    .update(displayName.trim())
    .digest("hex")
    .slice(0, 18);
  return `principal_${digest}`;
}

export function createSessionValue(principalId: string, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${principalId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(
  value: string | undefined | null,
  now = Date.now(),
): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [principalId, expiresAtText, signature] = parts;
  const payload = `${principalId}.${expiresAtText}`;
  const expected = sign(payload);
  const left = Buffer.from(signature ?? "");
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return null;
  if (!principalId || !principalId.startsWith("principal_")) return null;
  return principalId ?? null;
}

export function principalFromRequest(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const entry of cookie.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === SESSION_COOKIE) {
      return verifySessionValue(rest.join("="));
    }
  }
  return null;
}

export function sessionCookieHeader(principalId: string): string {
  const value = createSessionValue(principalId);
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
