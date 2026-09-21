/**
 * 账户密码哈希（server-only，Node 内置 crypto.scrypt；无新依赖）。
 * 格式：scrypt$N$r$p$saltHex$hashHex（每账户随机 salt；timingSafeEqual 校验）。
 * 明文绝不进日志/响应/客户端。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** 密码长度上限（字节有界；UTF-8 超长输入拒绝）。 */
export const PASSWORD_MAX_LENGTH = 128;

export class PasswordPolicyError extends Error {
  readonly code = "PASSWORD_POLICY" as const;

  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export function hashAccountPassword(password: string): string {
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError("密码最长 128 字符。");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** 校验：形状非法/不匹配一律 false（fail-closed，不抛内部细节）。 */
export function verifyAccountPassword(
  password: string,
  stored: string | null | undefined,
): boolean {
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_LENGTH) return false;
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];
  if (
    n !== SCRYPT_N
    || r !== SCRYPT_R
    || p !== SCRYPT_P
    || !saltHex
    || !hashHex
    || !/^[0-9a-f]{32}$/.test(saltHex)
    || !/^[0-9a-f]{128}$/.test(hashHex)
  ) {
    return false;
  }
  try {
    const candidate = scryptSync(password, Buffer.from(saltHex, "hex"), KEY_BYTES, {
      N: n,
      r,
      p,
    });
    const expected = Buffer.from(hashHex, "hex");
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
