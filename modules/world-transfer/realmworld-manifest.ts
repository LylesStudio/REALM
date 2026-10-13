/**
 * RealmWorld Phase 4 foundation: strict `.realmworld` manifest contract.
 *
 * This module only validates and canonicalizes the manifest. It does not read
 * files, verify signatures, install packages, or mount a World. Those actions
 * belong to the loader lifecycle and must consume this fail-closed boundary.
 */
import { parseEngineBaseVersionRange } from "./engine-base.ts";
import { LOCAL_WORLD_VERSION } from "./realm-save.ts";

export const REALMWORLD_FORMAT = "realmworld" as const;
export const REALMWORLD_FORMAT_VERSION = 1 as const;
export const REALMWORLD_MANIFEST_FILENAME = "realmworld-manifest.json" as const;

export type RealmWorldManifestErrorCode =
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_FORMAT_VERSION";

export class RealmWorldManifestError extends Error {
  readonly code: RealmWorldManifestErrorCode;

  constructor(code: RealmWorldManifestErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldManifestError";
    this.code = code;
  }
}

export interface RealmWorldEngineCompat {
  schemaLatest: string;
  requiresMigrations: readonly string[];
  /**
   * 包声明兼容的引擎 base 内容版本区间（有界确定性文法，见
   * engine-base.ts）。引擎 base 版本变化后不再兼容的包在
   * install/mount/restore 闸 fail-closed（BASE_VERSION_INCOMPATIBLE）。
   */
  baseRange: string;
}

export interface RealmWorldSignature {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface RealmWorldWebUI {
  entry: string;
  bridgeMajor: number;
}

export interface RealmWorldManifestV1 {
  format: typeof REALMWORLD_FORMAT;
  formatVersion: typeof REALMWORLD_FORMAT_VERSION;
  worldId: string;
  worldVersion: string;
  engineCompat: RealmWorldEngineCompat;
  contentHash: string;
  signature: RealmWorldSignature;
  webui?: RealmWorldWebUI;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MAX_IDENTITY_LENGTH = 256;
const MAX_SCHEMA_LENGTH = 256;
const MAX_SIGNATURE_KEY_LENGTH = 256;
const MAX_SIGNATURE_VALUE_LENGTH = 4096;
const MAX_WEBUI_ENTRY_LENGTH = 512;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmWorldManifestError(
        "INVALID_MANIFEST",
        `unknown manifest key ${where ? `${where}.` : ""}${key}`,
      );
    }
  }
}

function requireField(
  value: Record<string, unknown>,
  key: string,
  where: string,
): unknown {
  if (!hasOwn(value, key)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      `manifest ${where}.${key} is required`,
    );
  }
  return value[key];
}

function requireBoundedString(
  value: unknown,
  where: string,
  maxLength: number,
): string {
  const hasControlChars = typeof value === "string"
    && [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || hasControlChars
  ) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      `manifest ${where} must be a bounded non-empty string`,
    );
  }
  return value;
}

function requireIdentity(value: unknown, where: string): string {
  const identity = requireBoundedString(value, where, MAX_IDENTITY_LENGTH);
  if (
    identity.includes("/")
    || identity.includes("\\")
    || identity === "."
    || identity === ".."
  ) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      `manifest ${where} must be a single safe path component`,
    );
  }
  return identity;
}

function requireMigrationName(value: unknown, where: string): string {
  const name = requireBoundedString(value, where, MAX_SCHEMA_LENGTH);
  if (!MIGRATION_NAME.test(name)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      `manifest ${where} must be a migration filename`,
    );
  }
  return name;
}

function requireInteger(value: unknown, where: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      `manifest ${where} must be an integer >= ${minimum}`,
    );
  }
  return value as number;
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest contentHash must be lowercase sha256 hex",
    );
  }
  return value;
}

function requireRelativeEntry(value: unknown): string {
  const entry = requireBoundedString(value, "webui.entry", MAX_WEBUI_ENTRY_LENGTH);
  const segments = entry.split("/");
  if (
    entry.startsWith("/")
    || entry.includes("\\")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest webui.entry must be a relative safe path",
    );
  }
  return entry;
}

function normalizeManifest(value: unknown): RealmWorldManifestV1 {
  if (!isPlainObject(value)) {
    throw new RealmWorldManifestError("INVALID_MANIFEST", "manifest must be an object");
  }
  assertExactKeys(
    value,
    [
      "format",
      "formatVersion",
      "worldId",
      "worldVersion",
      "engineCompat",
      "contentHash",
      "signature",
      "webui",
    ],
    "",
  );

  const format = requireField(value, "format", "manifest");
  if (format !== REALMWORLD_FORMAT) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest format must be realmworld",
    );
  }
  const formatVersion = requireField(value, "formatVersion", "manifest");
  requireInteger(formatVersion, "formatVersion", 1);
  if ((formatVersion as number) > REALMWORLD_FORMAT_VERSION) {
    throw new RealmWorldManifestError(
      "UNSUPPORTED_FORMAT_VERSION",
      "manifest formatVersion is newer than this engine",
    );
  }
  if (formatVersion !== REALMWORLD_FORMAT_VERSION) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest formatVersion must be 1",
    );
  }

  const engineCompatRaw = requireField(value, "engineCompat", "manifest");
  if (!isPlainObject(engineCompatRaw)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest engineCompat must be an object",
    );
  }
  assertExactKeys(
    engineCompatRaw,
    ["schemaLatest", "requiresMigrations", "baseRange"],
    "engineCompat",
  );
  const schemaLatest = requireMigrationName(
    requireField(engineCompatRaw, "schemaLatest", "engineCompat"),
    "engineCompat.schemaLatest",
  );
  const baseRange = requireBoundedString(
    requireField(engineCompatRaw, "baseRange", "engineCompat"),
    "engineCompat.baseRange",
    MAX_SCHEMA_LENGTH,
  );
  if (!parseEngineBaseVersionRange(baseRange)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest engineCompat.baseRange must be a valid base version range",
    );
  }
  const migrationsRaw = requireField(
    engineCompatRaw,
    "requiresMigrations",
    "engineCompat",
  );
  if (!Array.isArray(migrationsRaw)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest engineCompat.requiresMigrations must be an array",
    );
  }
  const requiresMigrations = migrationsRaw.map((migration, index) =>
    requireMigrationName(migration, `engineCompat.requiresMigrations[${index}]`));
  if (new Set(requiresMigrations).size !== requiresMigrations.length) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest engineCompat.requiresMigrations must not contain duplicates",
    );
  }

  const signatureRaw = requireField(value, "signature", "manifest");
  if (!isPlainObject(signatureRaw)) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest signature must be an object",
    );
  }
  assertExactKeys(signatureRaw, ["algorithm", "keyId", "value"], "signature");
  if (requireField(signatureRaw, "algorithm", "signature") !== "ed25519") {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest signature.algorithm must be ed25519",
    );
  }
  const signature = {
    algorithm: "ed25519" as const,
    keyId: requireBoundedString(
      requireField(signatureRaw, "keyId", "signature"),
      "signature.keyId",
      MAX_SIGNATURE_KEY_LENGTH,
    ),
    value: requireBoundedString(
      requireField(signatureRaw, "value", "signature"),
      "signature.value",
      MAX_SIGNATURE_VALUE_LENGTH,
    ),
  };

  let webui: RealmWorldWebUI | undefined;
  if (hasOwn(value, "webui")) {
    const webuiRaw = value.webui;
    if (!isPlainObject(webuiRaw)) {
      throw new RealmWorldManifestError(
        "INVALID_MANIFEST",
        "manifest webui must be an object",
      );
    }
    assertExactKeys(webuiRaw, ["entry", "bridgeMajor"], "webui");
    webui = {
      entry: requireRelativeEntry(requireField(webuiRaw, "entry", "webui")),
      bridgeMajor: requireInteger(
        requireField(webuiRaw, "bridgeMajor", "webui"),
        "webui.bridgeMajor",
        1,
      ),
    };
  }

  const worldId = requireIdentity(requireField(value, "worldId", "manifest"), "worldId");
  const worldVersion = requireIdentity(
    requireField(value, "worldVersion", "manifest"),
    "worldVersion",
  );
  // 用户包绝不可冒充 engine-owned base 哨兵身份（base 不安装、不可卸载，
  // 见 engine-base.ts）。
  if (worldVersion === LOCAL_WORLD_VERSION) {
    throw new RealmWorldManifestError(
      "INVALID_MANIFEST",
      "manifest worldVersion must not claim the engine base sentinel",
    );
  }

  return {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId,
    worldVersion,
    engineCompat: {
      schemaLatest,
      requiresMigrations: [...requiresMigrations].sort(),
      baseRange,
    },
    contentHash: requireHash(requireField(value, "contentHash", "manifest")),
    signature,
    ...(webui ? { webui } : {}),
  };
}

/** Canonical JSON bytes: key order and migration ordering are frozen. */
export function serializeRealmWorldManifest(
  manifest: RealmWorldManifestV1,
): string {
  const valid = normalizeManifest(manifest);
  const output: Record<string, unknown> = {
    format: valid.format,
    formatVersion: valid.formatVersion,
    worldId: valid.worldId,
    worldVersion: valid.worldVersion,
    engineCompat: {
      schemaLatest: valid.engineCompat.schemaLatest,
      requiresMigrations: [...valid.engineCompat.requiresMigrations],
      baseRange: valid.engineCompat.baseRange,
    },
    contentHash: valid.contentHash,
    signature: {
      algorithm: valid.signature.algorithm,
      keyId: valid.signature.keyId,
      value: valid.signature.value,
    },
  };
  if (valid.webui) {
    output.webui = {
      entry: valid.webui.entry,
      bridgeMajor: valid.webui.bridgeMajor,
    };
  }
  return JSON.stringify(output);
}

/**
 * Canonical bytes signed by the RealmWorld publisher. Signature metadata is
 * intentionally excluded so verification does not become self-referential.
 */
export function serializeRealmWorldManifestSigningPayload(
  manifest: RealmWorldManifestV1,
): string {
  const valid = normalizeManifest(manifest);
  const output: Record<string, unknown> = {
    format: valid.format,
    formatVersion: valid.formatVersion,
    worldId: valid.worldId,
    worldVersion: valid.worldVersion,
    engineCompat: {
      schemaLatest: valid.engineCompat.schemaLatest,
      requiresMigrations: [...valid.engineCompat.requiresMigrations],
      baseRange: valid.engineCompat.baseRange,
    },
    contentHash: valid.contentHash,
  };
  if (valid.webui) {
    output.webui = {
      entry: valid.webui.entry,
      bridgeMajor: valid.webui.bridgeMajor,
    };
  }
  return JSON.stringify(output);
}

/** Strict parser for the manifest entry inside a `.realmworld` package. */
export function parseRealmWorldManifest(
  input: string | Uint8Array,
): RealmWorldManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
  } catch {
    throw new RealmWorldManifestError("INVALID_MANIFEST", "manifest is not valid JSON");
  }
  return normalizeManifest(parsed);
}
