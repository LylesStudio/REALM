/**
 * RealmWorld operator trust-store CLI (local, non-network).
 *
 * Manages the public-key trust-store document consumed by the Web routes
 * (app/api/realmworld/env.ts) and the Goal assessment worker
 * (scripts/goal-assessment-worker.mjs). Trust material is public-key-only:
 * this tool never generates or stores private keys and never prints key
 * material, filesystem paths, or anything beyond bounded status/key IDs.
 *
 * Usage:
 *   node --experimental-strip-types scripts/realmworld-trust-store.mjs <command> [options]
 *
 * Commands:
 *   validate --store <path>
 *   add      --store <path> --key-id <id> --public-key-file <path>
 *            [--status active|revoked] [--not-before <iso>] [--not-after <iso>]
 *   activate --store <path> --key-id <id> [--not-before <iso>] [--not-after <iso>]
 *   rotate   --store <path> --old-key-id <id> --new-key-id <id>
 *            --new-public-key-file <path> [--not-before <iso>] [--not-after <iso>]
 *            [--revoke-old] [--expire-old <iso>]
 *   revoke   --store <path> --key-id <id> [--not-after <iso>]
 *   base-status   --store <path>
 *   base-activate --store <path> --version <semver>
 *   base-switch   --store <path> --version <semver>
 *   base-rollback --store <path>
 *
 * rotate adds the replacement key active first; pass --revoke-old and/or
 * --expire-old to retire the previous key (staged rotation is supported).
 * The base-* commands manage the operator-active engine base content version
 * recorded in the trust store (the version RealmWorld package
 * engineCompat.baseRange declarations are evaluated against); targets must be
 * servable by this engine build.
 * All writes go through the atomic same-directory writer with restrictive
 * permissions; a failed mutation leaves the previous document intact.
 *
 * Exit codes: 0 success, 1 operation failure, 2 usage error.
 */
import { readFile } from "node:fs/promises";
import { RealmWorldTrustStoreError } from "../modules/world-transfer/realmworld-signature.ts";
import {
  activateRealmWorldTrustStoreKey,
  activateRealmWorldTrustStoreBase,
  addRealmWorldTrustStoreKey,
  mutateRealmWorldTrustStoreFile,
  readRealmWorldTrustStoreFile,
  resolveEngineBaseActiveVersion,
  revokeRealmWorldTrustStoreKey,
  rollbackRealmWorldTrustStoreBase,
  rotateRealmWorldTrustStoreKey,
  switchRealmWorldTrustStoreBase,
} from "../modules/world-transfer/realmworld-trust-store.ts";

const USAGE = `usage: realmworld-trust-store <command> [options]
  validate --store <path>
  add --store <path> --key-id <id> --public-key-file <path> [--status active|revoked] [--not-before <iso>] [--not-after <iso>]
  activate --store <path> --key-id <id> [--not-before <iso>] [--not-after <iso>]
  rotate --store <path> --old-key-id <id> --new-key-id <id> --new-public-key-file <path> [--not-before <iso>] [--not-after <iso>] [--revoke-old] [--expire-old <iso>]
  revoke --store <path> --key-id <id> [--not-after <iso>]
  base-status --store <path>
  base-activate --store <path> --version <semver>
  base-switch --store <path> --version <semver>
  base-rollback --store <path>`;

const VALUE_FLAGS = new Set([
  "--store",
  "--key-id",
  "--public-key-file",
  "--version",
  "--status",
  "--not-before",
  "--not-after",
  "--old-key-id",
  "--new-key-id",
  "--new-public-key-file",
  "--expire-old",
]);
const BOOLEAN_FLAGS = new Set(["--revoke-old"]);

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command.startsWith("-")) throw new UsageError("missing command");
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      options.set(flag, true);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument: ${flag}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`missing value for ${flag}`);
    }
    options.set(flag, value);
    index += 1;
  }
  return { command, options };
}

function required(options, flag) {
  const value = options.get(flag);
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`missing required ${flag}`);
  }
  return value;
}

function optional(options, flag) {
  const value = options.get(flag);
  return typeof value === "string" ? value : undefined;
}

/** Bound any operator-controlled identifier before printing it. */
function bounded(text) {
  const value = String(text);
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

async function readPublicKeyMaterial(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new RealmWorldTrustStoreError("TRUST_STORE_UNREADABLE", "public key file is not readable");
  }
  // PEM files end with a newline; the strict document schema rejects it.
  return raw.trim();
}

function report(document, action) {
  console.log(`ok: ${action} (keys: ${document.keys.length})`);
  for (const key of document.keys) {
    console.log(`key ${bounded(key.keyId)} status=${key.status}`);
  }
}

function reportBase(document, action) {
  const base = document.base;
  console.log(
    `ok: ${action} (base active=${bounded(base?.activeVersion ?? "engine-default")}`
      + `${base?.previousVersion ? ` previous=${bounded(base.previousVersion)}` : ""})`,
  );
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const store = required(options, "--store");
  switch (command) {
    case "validate": {
      const document = await readRealmWorldTrustStoreFile(store);
      report(document, "trust store valid");
      break;
    }
    case "add": {
      const status = optional(options, "--status") ?? "active";
      if (status !== "active" && status !== "revoked") {
        throw new UsageError("--status must be active or revoked");
      }
      const keyId = required(options, "--key-id");
      const publicKey = await readPublicKeyMaterial(required(options, "--public-key-file"));
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        addRealmWorldTrustStoreKey({
          document: current,
          keyId,
          publicKey,
          status,
          notBefore: optional(options, "--not-before"),
          notAfter: optional(options, "--not-after"),
        }));
      report(document, `added key ${bounded(keyId)}`);
      break;
    }
    case "activate": {
      const keyId = required(options, "--key-id");
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        activateRealmWorldTrustStoreKey({
          document: current,
          keyId,
          notBefore: optional(options, "--not-before"),
          notAfter: optional(options, "--not-after"),
        }));
      report(document, `activated key ${bounded(keyId)}`);
      break;
    }
    case "rotate": {
      const oldKeyId = required(options, "--old-key-id");
      const newKeyId = required(options, "--new-key-id");
      const newPublicKey = await readPublicKeyMaterial(required(options, "--new-public-key-file"));
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        rotateRealmWorldTrustStoreKey({
          document: current,
          oldKeyId,
          newKeyId,
          newPublicKey,
          notBefore: optional(options, "--not-before"),
          notAfter: optional(options, "--not-after"),
          revokeOld: options.get("--revoke-old") === true,
          expireOld: optional(options, "--expire-old"),
        }));
      report(document, `rotated key ${bounded(oldKeyId)} -> ${bounded(newKeyId)}`);
      break;
    }
    case "revoke": {
      const keyId = required(options, "--key-id");
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        revokeRealmWorldTrustStoreKey({
          document: current,
          keyId,
          notAfter: optional(options, "--not-after"),
        }));
      report(document, `revoked key ${bounded(keyId)}`);
      break;
    }
    case "base-status": {
      const document = await readRealmWorldTrustStoreFile(store);
      reportBase(document, `base active version ${bounded(resolveEngineBaseActiveVersion(document))}`);
      break;
    }
    case "base-activate": {
      const version = required(options, "--version");
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        activateRealmWorldTrustStoreBase({ document: current, version }));
      reportBase(document, `activated base ${bounded(version)}`);
      break;
    }
    case "base-switch": {
      const version = required(options, "--version");
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        switchRealmWorldTrustStoreBase({ document: current, targetVersion: version }));
      reportBase(document, `switched base to ${bounded(version)}`);
      break;
    }
    case "base-rollback": {
      const document = await mutateRealmWorldTrustStoreFile(store, (current) =>
        rollbackRealmWorldTrustStoreBase({ document: current }));
      reportBase(document, "rolled back base version");
      break;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  // Bounded, safe errors only: trust-store error codes/messages never carry
  // key material or paths; anything unexpected is reported generically.
  if (error instanceof RealmWorldTrustStoreError) {
    console.error(`error: ${error.code}: ${error.message}`);
  } else {
    console.error("error: TRUST_STORE_OPERATION_FAILED: trust store operation failed");
  }
  process.exit(1);
}
