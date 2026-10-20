/** Shared exact archive validators. No runtime dependency on the archive facade. */
import type { JsonValue } from "../runtime/public.ts";
import { RealmRuntimeSaveError } from "./runtime-save-primitives.ts";

const SAFE_IDENTITY = /^[A-Za-z0-9._-]+$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

export function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `unknown save key ${where}.${key}`);
    }
  }
}

export function requireField(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save key ${where}.${key} is required`);
  }
  return value[key];
}

export function requireIdentity(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !SAFE_IDENTITY.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} is not a safe identity`);
  }
  return value;
}

export function requireInteger(value: unknown, where: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be an integer >= ${minimum}`);
  }
  return value as number;
}
