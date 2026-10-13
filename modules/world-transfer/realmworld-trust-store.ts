/**
 * RealmWorld operator trust-store lifecycle: filesystem-backed loading,
 * validated pure mutations (add/activate/rotate/revoke), atomic replacement,
 * and a file-backed signature verifier for long-lived processes.
 *
 * Trust material is public-key-only. This module never generates or stores
 * private keys, and error messages never carry key material or filesystem
 * paths. Everything fails closed: an unreadable, symlinked, non-regular,
 * malformed, duplicate, or invalid-key store is never silently trusted.
 */
import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  ENGINE_BASE_CONTENT_VERSION,
  ENGINE_BASE_CONTENT_VERSIONS,
} from "./engine-base.ts";
import type {
  RealmWorldSignatureVerifier,
  RealmWorldSignatureVerifierInput,
} from "./realmworld-loader.ts";
import { parseRealmWorldVersion } from "./realmworld-version.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreDocument,
  RealmWorldTrustStoreError,
  validateRealmWorldTrustStoreDocument,
  type RealmWorldTrustStoreBaseV1,
  type RealmWorldTrustStoreDocumentV1,
  type RealmWorldTrustStoreKeyV1,
  type RealmWorldTrustStoreStatus,
} from "./realmworld-signature.ts";

export type RealmWorldTrustStoreDocumentInput =
  string | Uint8Array | RealmWorldTrustStoreDocumentV1;

const TRUST_STORE_FILE_MODE = 0o600;

/**
 * Read and strictly validate a trust-store document from disk. Rejects
 * missing, symlinked, or non-regular paths and any malformed/duplicate/
 * invalid-key document; private-key material is rejected by validation.
 */
export async function readRealmWorldTrustStoreFile(
  path: string,
): Promise<RealmWorldTrustStoreDocumentV1> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    throw new RealmWorldTrustStoreError("TRUST_STORE_UNREADABLE", "trust store is not readable");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RealmWorldTrustStoreError(
      "TRUST_STORE_UNREADABLE",
      "trust store path is not a regular file",
    );
  }
  let handle: FileHandle;
  try {
    // Defense in depth against a symlink swapped in after lstat.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new RealmWorldTrustStoreError("TRUST_STORE_UNREADABLE", "trust store is not readable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new RealmWorldTrustStoreError(
        "TRUST_STORE_UNREADABLE",
        "trust store path is not a regular file",
      );
    }
    return validateRealmWorldTrustStoreDocument(await handle.readFile("utf8"));
  } finally {
    await handle.close().catch(() => {});
  }
}

function findKey(
  document: RealmWorldTrustStoreDocumentV1,
  keyId: string,
): RealmWorldTrustStoreKeyV1 | undefined {
  return document.keys.find((key) => key.keyId === keyId);
}

function requireKey(
  document: RealmWorldTrustStoreDocumentV1,
  keyId: string,
): RealmWorldTrustStoreKeyV1 {
  const key = findKey(document, keyId);
  if (!key) {
    throw new RealmWorldTrustStoreError("TRUST_STORE_KEY_NOT_FOUND", "trust store keyId is unknown");
  }
  return key;
}

function rejectExistingKey(
  document: RealmWorldTrustStoreDocumentV1,
  keyId: string,
  publicKey: string,
): void {
  const existing = findKey(document, keyId);
  if (!existing) return;
  // Never silently overwrite an existing keyId with different public material.
  throw new RealmWorldTrustStoreError(
    existing.publicKey === publicKey ? "TRUST_STORE_DUPLICATE_KEY" : "TRUST_STORE_KEY_CONFLICT",
    "trust store keyId already exists",
  );
}

/** Validate the candidate document before it may be activated or persisted. */
function commitKeys(
  keys: readonly RealmWorldTrustStoreKeyV1[],
  base?: RealmWorldTrustStoreBaseV1,
): RealmWorldTrustStoreDocumentV1 {
  return validateRealmWorldTrustStoreDocument({
    format: "realmworld-trust-store",
    version: 1,
    keys,
    ...(base === undefined ? {} : { base }),
  });
}

function optionalWindow(
  notBefore: string | undefined,
  notAfter: string | undefined,
): Pick<RealmWorldTrustStoreKeyV1, "notBefore" | "notAfter"> {
  return {
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(notAfter === undefined ? {} : { notAfter }),
  };
}

/** Pure mutation: add a new key (active by default). Never overwrites. */
export function addRealmWorldTrustStoreKey(input: {
  document: RealmWorldTrustStoreDocumentInput;
  keyId: string;
  publicKey: string;
  status?: RealmWorldTrustStoreStatus;
  notBefore?: string;
  notAfter?: string;
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  rejectExistingKey(document, input.keyId, input.publicKey);
  return commitKeys([
    ...document.keys,
    {
      keyId: input.keyId,
      publicKey: input.publicKey,
      status: input.status ?? "active",
      ...optionalWindow(input.notBefore, input.notAfter),
    },
  ], document.base);
}

/** Pure mutation: (re)activate an existing key, optionally setting its window. */
export function activateRealmWorldTrustStoreKey(input: {
  document: RealmWorldTrustStoreDocumentInput;
  keyId: string;
  notBefore?: string;
  notAfter?: string;
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  requireKey(document, input.keyId);
  return commitKeys(document.keys.map((key) => key.keyId === input.keyId
    ? { ...key, status: "active", ...optionalWindow(input.notBefore, input.notAfter) }
    : key), document.base);
}

/** Pure mutation: revoke an existing key, optionally expiring it at a time. */
export function revokeRealmWorldTrustStoreKey(input: {
  document: RealmWorldTrustStoreDocumentInput;
  keyId: string;
  notAfter?: string;
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  requireKey(document, input.keyId);
  return commitKeys(document.keys.map((key) => key.keyId === input.keyId
    ? { ...key, status: "revoked", ...(input.notAfter === undefined ? {} : { notAfter: input.notAfter }) }
    : key), document.base);
}

/**
 * Pure mutation: rotate from an existing key to a replacement. The
 * replacement is added active alongside the old key first; the old key is
 * only revoked/expired when requested, so operators can stage a rotation
 * (add replacement, deploy, then revoke the old key) without a trust gap.
 */
export function rotateRealmWorldTrustStoreKey(input: {
  document: RealmWorldTrustStoreDocumentInput;
  oldKeyId: string;
  newKeyId: string;
  newPublicKey: string;
  notBefore?: string;
  notAfter?: string;
  revokeOld?: boolean;
  expireOld?: string;
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  requireKey(document, input.oldKeyId);
  rejectExistingKey(document, input.newKeyId, input.newPublicKey);
  const keys = document.keys.map((key) => key.keyId === input.oldKeyId
    ? {
        ...key,
        ...(input.revokeOld ? { status: "revoked" as const } : {}),
        ...(input.expireOld === undefined ? {} : { notAfter: input.expireOld }),
      }
    : key);
  keys.push({
    keyId: input.newKeyId,
    publicKey: input.newPublicKey,
    status: "active",
    ...optionalWindow(input.notBefore, input.notAfter),
  });
  return commitKeys(keys, document.base);
}

/**
 * Atomically replace the trust-store file: write a validated document to a
 * restrictive-mode temp file in the same directory, fsync, then rename over
 * the target. A failed write leaves the previous document intact and no temp
 * file behind.
 */
export async function writeRealmWorldTrustStoreFileAtomic(input: {
  path: string;
  document: RealmWorldTrustStoreDocumentInput;
}): Promise<void> {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const tempPath = join(
    dirname(input.path),
    `.${basename(input.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, "wx", TRUST_STORE_FILE_MODE);
    await handle.chmod(TRUST_STORE_FILE_MODE);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, input.path);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw new RealmWorldTrustStoreError("TRUST_STORE_WRITE_FAILED", "trust store write failed");
  }
}

/**
 * Read-validate, mutate, and atomically persist a trust-store file. A failed
 * mutation never touches the on-disk document.
 */
export async function mutateRealmWorldTrustStoreFile(
  path: string,
  mutate: (document: RealmWorldTrustStoreDocumentV1) => RealmWorldTrustStoreDocumentV1,
): Promise<RealmWorldTrustStoreDocumentV1> {
  const current = await readRealmWorldTrustStoreFile(path);
  const next = mutate(current);
  await writeRealmWorldTrustStoreFileAtomic({ path, document: next });
  return next;
}

/**
 * File-backed verifier for long-lived processes. The trust store is re-read
 * and re-validated on every verification, so an operator rotation or
 * revocation is observed on the next verification without a process restart;
 * any store failure fails closed. Deterministic callers that already hold a
 * document should keep using createRealmWorldSignatureVerifierFromTrustStoreDocument.
 */
export function createRealmWorldSignatureVerifierFromTrustStoreFile(input: {
  path: string;
  now?: () => Date;
}): RealmWorldSignatureVerifier {
  const now = input.now ?? (() => new Date());
  return async (verification: RealmWorldSignatureVerifierInput) => {
    try {
      const document = await readRealmWorldTrustStoreFile(input.path);
      const verify = createRealmWorldSignatureVerifierFromTrustStoreDocument({
        document,
        now: now(),
      });
      return await verify(verification);
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Engine base 内容版本 operator lifecycle（Slice 5）
// ---------------------------------------------------------------------------
//
// base content provider 是 engine-owned、不安装、不可卸载；operator 能管理
// 的只是"活动 base 内容版本"（包兼容闸 engineCompat.baseRange 的对照版本）。
// 目标版本必须属于引擎可 serve 集合（默认 ENGINE_BASE_CONTENT_VERSIONS；
// 测试可注入），未知/不可 serve/形态非法一律 fail-closed。

/** 文档声明的活动 base 版本；无 base 段 = 引擎当前版本（默认兼容基线）。 */
export function resolveEngineBaseActiveVersion(
  document: RealmWorldTrustStoreDocumentInput,
): string {
  const parsed = validateRealmWorldTrustStoreDocument(document);
  return parsed.base?.activeVersion ?? ENGINE_BASE_CONTENT_VERSION;
}

function requireBaseVersion(
  version: string,
  availableVersions: readonly string[],
): string {
  if (!parseRealmWorldVersion(version)) {
    throw new RealmWorldTrustStoreError(
      "BASE_VERSION_INVALID",
      "base version must be strict semver",
    );
  }
  if (!availableVersions.includes(version)) {
    throw new RealmWorldTrustStoreError(
      "BASE_VERSION_UNSUPPORTED",
      "base version is not servable by this engine",
    );
  }
  return version;
}

function commitBase(
  document: RealmWorldTrustStoreDocumentV1,
  base: RealmWorldTrustStoreBaseV1,
): RealmWorldTrustStoreDocumentV1 {
  return commitKeys(document.keys, base);
}

/**
 * Pure mutation: 首次显式激活 base 版本（文档尚无 base 段）。已有 base 段
 * 时必须用 switch/rollback——重复 activate 同版本按幂等 replay 返回原文档。
 */
export function activateRealmWorldTrustStoreBase(input: {
  document: RealmWorldTrustStoreDocumentInput;
  version: string;
  availableVersions?: readonly string[];
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  const available = input.availableVersions ?? ENGINE_BASE_CONTENT_VERSIONS;
  const version = requireBaseVersion(input.version, available);
  if (document.base) {
    if (document.base.activeVersion === version) return document;
    throw new RealmWorldTrustStoreError(
      "BASE_ALREADY_ACTIVE",
      "base content is already active; use switch",
    );
  }
  return commitBase(document, { activeVersion: version });
}

/**
 * Pure mutation: 切换活动 base 版本。目标必须可 serve 且不同于当前；
 * 同版本按幂等 replay 返回原文档；切换记录 previousVersion 作为回滚目标。
 */
export function switchRealmWorldTrustStoreBase(input: {
  document: RealmWorldTrustStoreDocumentInput;
  targetVersion: string;
  availableVersions?: readonly string[];
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  if (!document.base) {
    throw new RealmWorldTrustStoreError(
      "BASE_NOT_ACTIVE",
      "base content is not active; use activate",
    );
  }
  const available = input.availableVersions ?? ENGINE_BASE_CONTENT_VERSIONS;
  const target = requireBaseVersion(input.targetVersion, available);
  if (document.base.activeVersion === target) return document;
  return commitBase(document, {
    activeVersion: target,
    previousVersion: document.base.activeVersion,
  });
}

/**
 * Pure mutation: 回滚到最近一次 switch 前的活动 base 版本。无回滚目标或
 * 目标已不可 serve 一律 fail-closed；回滚后清除 previousVersion。
 */
export function rollbackRealmWorldTrustStoreBase(input: {
  document: RealmWorldTrustStoreDocumentInput;
  availableVersions?: readonly string[];
}): RealmWorldTrustStoreDocumentV1 {
  const document = validateRealmWorldTrustStoreDocument(input.document);
  if (!document.base) {
    throw new RealmWorldTrustStoreError(
      "BASE_NOT_ACTIVE",
      "base content is not active; use activate",
    );
  }
  const previous = document.base.previousVersion;
  if (!previous) {
    throw new RealmWorldTrustStoreError(
      "BASE_ROLLBACK_UNAVAILABLE",
      "no previous base version is recorded",
    );
  }
  const available = input.availableVersions ?? ENGINE_BASE_CONTENT_VERSIONS;
  requireBaseVersion(previous, available);
  return commitBase(document, { activeVersion: previous });
}
