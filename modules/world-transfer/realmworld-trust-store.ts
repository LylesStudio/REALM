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
import type {
  RealmWorldSignatureVerifier,
  RealmWorldSignatureVerifierInput,
} from "./realmworld-loader.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreDocument,
  RealmWorldTrustStoreError,
  validateRealmWorldTrustStoreDocument,
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
): RealmWorldTrustStoreDocumentV1 {
  return validateRealmWorldTrustStoreDocument({
    format: "realmworld-trust-store",
    version: 1,
    keys,
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
  ]);
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
    : key));
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
    : key));
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
  return commitKeys(keys);
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
