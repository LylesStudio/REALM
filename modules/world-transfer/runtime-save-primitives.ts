/** Dependency-free runtime-save budgets, error identity and exact wire counter. */
export type RealmRuntimeSaveErrorCode =
  | "INVALID_SAVE"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "RUNTIME_HASH_MISMATCH";

export class RealmRuntimeSaveError extends Error {
  readonly code: RealmRuntimeSaveErrorCode;

  constructor(code: RealmRuntimeSaveErrorCode, message: string) {
    super(message);
    this.name = "RealmRuntimeSaveError";
    this.code = code;
  }
}

export const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;

export const RUNTIME_SAVE_FILE_BYTES = MAX_RUNTIME_FILE_BYTES;

export function memoryStringCharacterBytes(code: number): number {
  if (code === 34 || code === 92 || [8,9,10,12,13].includes(code)) return 2;
  if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) return 6;
  return code < 128 ? 1 : code < 2048 ? 2 : 3;
}

export type RuntimeSectionWireFormatter = "canonical-runtime" | "normalized-domain";

/** Count data, never invoke an accessor or toJSON. Arrays schedule one child
 * at a time; the active set detects cycles without deduplicating emitted rows.
 * The domain formatter has JSON.stringify's null holes/omitted undefined keys;
 * canonicalJson's sparse map/join emits empty slots instead.
 */
export function countRuntimeSectionWireBytes(
  value: unknown,
  formatter: RuntimeSectionWireFormatter,
  limitBytes = Number.MAX_SAFE_INTEGER,
): number {
  const invalid = (): never => { throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime section wire data or byte budget is invalid"); };
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0
    || !["canonical-runtime", "normalized-domain"].includes(formatter)) invalid();
  let bytes = 0;
  const add = (extra: number): void => {
    if (extra > limitBytes - bytes) invalid();
    bytes += extra;
  };
  const string = (text: string): void => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i), next = text.charCodeAt(i + 1);
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { add(4); i++; }
      else add(memoryStringCharacterBytes(code));
    }
  };
  type Frame = { value: object; keys?: string[]; index: number; emitted: number; length: number };
  const frames: Frame[] = [];
  const active = new WeakSet<object>();
  const descriptorFor = (object: object, key: string): PropertyDescriptor | undefined => {
    for (let current: object | null = object; current !== null; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) return descriptor;
    }
    return undefined;
  };
  const visit = (item: unknown): void => {
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item !== "object" || active.has(item)) invalid();
    const object = item as object;
    if (formatter === "normalized-domain") {
      const toJSON = descriptorFor(object, "toJSON");
      if (toJSON !== undefined && (!("value" in toJSON) || typeof toJSON.value === "function")) invalid();
    }
    const keys = Array.isArray(object) ? undefined : Object.keys(object);
    add(2);
    active.add(object);
    frames.push({ value: object, keys, index: 0, emitted: 0,
      length: keys === undefined ? (object as unknown[]).length : keys.length });
  };
  visit(value);
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.index === frame.length) { active.delete(frame.value); frames.pop(); continue; }
    const key = frame.keys === undefined ? String(frame.index) : frame.keys[frame.index]!;
    frame.index++;
    const descriptor = frame.keys === undefined ? descriptorFor(frame.value, key)
      : Object.getOwnPropertyDescriptor(frame.value, key);
    // Holes in canonicalJson's map/join contribute commas, but no value.
    if (descriptor === undefined && frame.keys === undefined) {
      if (frame.emitted++) add(1);
      if (formatter === "normalized-domain") add(4);
      continue;
    }
    if (descriptor === undefined || !("value" in descriptor)) invalid();
    const child: unknown = descriptor!.value;
    if (child === undefined && formatter === "normalized-domain" && frame.keys !== undefined) continue;
    if (frame.emitted++) add(1);
    if (frame.keys !== undefined) { string(key); add(1); }
    if (child === undefined && formatter === "normalized-domain") add(4);
    else visit(child);
  }
  return bytes;
}
