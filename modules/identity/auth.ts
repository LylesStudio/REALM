/**
 * Access gate + identity-aware sessions.
 *
 * REALM_ACCESS_TOKEN unset → gate disabled, everything falls back to the
 * local single-user principal. Set → every page and API requires a session.
 * Sessions are stateless HMAC cookies; credentials are never stored, logged
 * or hashed into any digest.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "realm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isAccessGateEnabled(): boolean {
  return Boolean(process.env.REALM_ACCESS_TOKEN?.trim());
}

export function verifyAccessToken(candidate: string): boolean {
  const expected = process.env.REALM_ACCESS_TOKEN ?? "";
  if (!expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret(): string {
  return process.env.REALM_SESSION_SECRET?.trim()
    || process.env.REALM_ACCESS_TOKEN?.trim()
    || "realm-local-development-only";
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
