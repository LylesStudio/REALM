import {
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "./realmworld-manifest.ts";
import { parseRealmWorldVersion } from "./realmworld-version.ts";
import type { RealmWorldSignatureVerifier } from "./realmworld-loader.ts";

export type RealmWorldTrustedKeyMaterial =
  | ReadonlyMap<string, string | Uint8Array>
  | Readonly<Record<string, string | Uint8Array>>;

export type RealmWorldTrustStoreStatus = "active" | "revoked";

export interface RealmWorldTrustStoreKeyV1 {
  keyId: string;
  publicKey: string;
  status: RealmWorldTrustStoreStatus;
  notBefore?: string;
  notAfter?: string;
}

/**
 * Trust-store 的 engine base 内容版本段（Slice 5 operator lifecycle）：
 * operator 显式 activate/switch/rollback 的记录。activeVersion 是包兼容闸
 *（manifest `engineCompat.baseRange`）评估所对照的活动 base 版本；
 * previousVersion 是最近一次 switch/activate 前的活动版本（rollback 目标）。
 * 文档校验只做结构/严格 semver 检查；目标版本必须属于引擎可 serve 集合
 * 的约束由 operator 变更函数（realmworld-trust-store.ts）执行。
 */
export interface RealmWorldTrustStoreBaseV1 {
  activeVersion: string;
  previousVersion?: string;
}

export interface RealmWorldTrustStoreDocumentV1 {
  format: "realmworld-trust-store";
  version: 1;
  keys: readonly RealmWorldTrustStoreKeyV1[];
  base?: RealmWorldTrustStoreBaseV1;
}

export class RealmWorldTrustStoreError extends Error {
  readonly code:
    | "TRUST_STORE_INVALID"
    | "TRUST_STORE_DUPLICATE_KEY"
    | "TRUST_STORE_KEY_NOT_FOUND"
    | "TRUST_STORE_KEY_CONFLICT"
    | "TRUST_STORE_UNREADABLE"
    | "TRUST_STORE_WRITE_FAILED"
    | "BASE_VERSION_INVALID"
    | "BASE_VERSION_UNSUPPORTED"
    | "BASE_ALREADY_ACTIVE"
    | "BASE_NOT_ACTIVE"
    | "BASE_ROLLBACK_UNAVAILABLE";

  constructor(
    code: RealmWorldTrustStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RealmWorldTrustStoreError";
    this.code = code;
  }
}

function entriesOf(
  trustedKeys: RealmWorldTrustedKeyMaterial,
): Iterable<readonly [string, string | Uint8Array]> {
  return trustedKeys instanceof Map
    ? trustedKeys.entries()
    : Object.entries(trustedKeys);
}

function parseTrustedKeys(trustedKeys: RealmWorldTrustedKeyMaterial): ReadonlyMap<string, KeyObject> {
  const parsed = new Map<string, KeyObject>();
  for (const [keyId, material] of entriesOf(trustedKeys)) {
    if (typeof keyId !== "string" || keyId.length === 0) continue;
    try {
      parsed.set(keyId, createPublicKey(
        typeof material === "string"
          ? material
          : { key: Buffer.from(material), format: "der", type: "spki" },
      ));
    } catch {
      // Invalid operator configuration is a non-matching key, never a package error.
    }
  }
  return parsed;
}

function decodeSignature(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 ? decoded : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function trustStoreText(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 16_384
    || value.trim() !== value
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", `invalid trust store ${where}`);
  }
  return value;
}

function publicKeyText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "invalid trust store publicKey");
  }
  // Trust material is public-key-only: never accept or store private keys.
  if (value.includes("PRIVATE KEY")) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store publicKey is invalid");
  }
  return value;
}

function trustStoreTime(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  const text = trustStoreText(value, where);
  if (!Number.isFinite(Date.parse(text))) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", `invalid trust store ${where}`);
  }
  return text;
}

/**
 * Strictly validate a versioned operator trust document and return a
 * normalized, frozen v1 document. Throws RealmWorldTrustStoreError on any
 * malformed, duplicate, or invalid-key entry; error messages never carry key
 * material.
 */
export function validateRealmWorldTrustStoreDocument(
  input: string | Uint8Array | RealmWorldTrustStoreDocumentV1,
): RealmWorldTrustStoreDocumentV1 {
  let value: unknown = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    try {
      value = JSON.parse(Buffer.from(input).toString("utf8"));
    } catch {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store is not valid JSON");
    }
  }
  if (!isPlainObject(value) || !exactKeys(value, ["format", "version", "keys", "base"])) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store shape is invalid");
  }
  if (value.format !== "realmworld-trust-store" || value.version !== 1 || !Array.isArray(value.keys)) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store version is unsupported");
  }
  const seen = new Set<string>();
  const keys: RealmWorldTrustStoreKeyV1[] = [];
  for (const rawKey of value.keys) {
    if (
      !isPlainObject(rawKey)
      || !exactKeys(rawKey, ["keyId", "publicKey", "status", "notBefore", "notAfter"])
    ) {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store key shape is invalid");
    }
    const keyId = trustStoreText(rawKey.keyId, "keyId");
    if (seen.has(keyId)) {
      throw new RealmWorldTrustStoreError("TRUST_STORE_DUPLICATE_KEY", "trust store keyId is duplicated");
    }
    seen.add(keyId);
    const publicKey = publicKeyText(rawKey.publicKey);
    if (rawKey.status !== "active" && rawKey.status !== "revoked") {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store key status is invalid");
    }
    const notBefore = trustStoreTime(rawKey.notBefore, "notBefore");
    const notAfter = trustStoreTime(rawKey.notAfter, "notAfter");
    const notBeforeEpoch = notBefore === undefined ? -Infinity : Date.parse(notBefore);
    const notAfterEpoch = notAfter === undefined ? Infinity : Date.parse(notAfter);
    if (notBeforeEpoch > notAfterEpoch) {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store key validity window is invalid");
    }
    // Parse every key before activation so malformed future/revoked entries do
    // not hide an operator configuration error.
    try {
      createPublicKey(publicKey);
    } catch {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store public key is invalid");
    }
    keys.push(Object.freeze({
      keyId,
      publicKey,
      status: rawKey.status,
      ...(notBefore === undefined ? {} : { notBefore }),
      ...(notAfter === undefined ? {} : { notAfter }),
    }));
  }
  let base: RealmWorldTrustStoreBaseV1 | undefined;
  if (value.base !== undefined) {
    if (
      !isPlainObject(value.base)
      || !exactKeys(value.base, ["activeVersion", "previousVersion"])
    ) {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store base shape is invalid");
    }
    const activeVersion = trustStoreText(value.base.activeVersion, "base.activeVersion");
    if (!parseRealmWorldVersion(activeVersion)) {
      throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store base activeVersion is invalid");
    }
    let previousVersion: string | undefined;
    if (value.base.previousVersion !== undefined) {
      previousVersion = trustStoreText(value.base.previousVersion, "base.previousVersion");
      if (!parseRealmWorldVersion(previousVersion) || previousVersion === activeVersion) {
        throw new RealmWorldTrustStoreError(
          "TRUST_STORE_INVALID",
          "trust store base previousVersion is invalid",
        );
      }
    }
    base = Object.freeze({
      activeVersion,
      ...(previousVersion === undefined ? {} : { previousVersion }),
    });
  }
  return Object.freeze({
    format: "realmworld-trust-store",
    version: 1,
    keys: Object.freeze(keys),
    ...(base === undefined ? {} : { base }),
  });
}

/** Parse and apply active/revoked key state from an operator trust document. */
export function parseRealmWorldTrustStore(
  input: string | Uint8Array | RealmWorldTrustStoreDocumentV1,
  now = new Date(),
): ReadonlyMap<string, string> {
  const document = validateRealmWorldTrustStoreDocument(input);
  const nowEpoch = now.getTime();
  if (!Number.isFinite(nowEpoch)) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_INVALID", "trust store clock is invalid");
  }
  const parsed = new Map<string, string>();
  for (const key of document.keys) {
    const notBeforeEpoch = key.notBefore === undefined ? -Infinity : Date.parse(key.notBefore);
    const notAfterEpoch = key.notAfter === undefined ? Infinity : Date.parse(key.notAfter);
    if (key.status === "active" && nowEpoch >= notBeforeEpoch && nowEpoch <= notAfterEpoch) {
      parsed.set(key.keyId, key.publicKey);
    }
  }
  return parsed;
}

/** Create the production signature verifier from a public-key trust store. */
export function createRealmWorldSignatureVerifier(input: {
  trustedKeys: RealmWorldTrustedKeyMaterial;
}): RealmWorldSignatureVerifier {
  const trustedKeys = parseTrustedKeys(input.trustedKeys);
  return ({ manifest }: { manifest: RealmWorldManifestV1 }) => {
    if (manifest.signature.algorithm !== "ed25519") return false;
    const publicKey = trustedKeys.get(manifest.signature.keyId);
    const signature = decodeSignature(manifest.signature.value);
    if (!publicKey || !signature) return false;
    try {
      return verify(
        null,
        Buffer.from(serializeRealmWorldManifestSigningPayload(manifest), "utf8"),
        publicKey,
        signature,
      );
    } catch {
      return false;
    }
  };
}

/** Build a verifier from a versioned trust document with rotation/revocation. */
export function createRealmWorldSignatureVerifierFromTrustStoreDocument(input: {
  document: string | Uint8Array | RealmWorldTrustStoreDocumentV1;
  now?: Date;
}): RealmWorldSignatureVerifier {
  const trustedKeys = parseRealmWorldTrustStore(input.document, input.now);
  return createRealmWorldSignatureVerifier({ trustedKeys });
}
