import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import type { RealmWorldSignatureVerifier } from "../modules/world-transfer/realmworld-loader.ts";
import {
  parseRealmWorldTrustStore,
  RealmWorldTrustStoreError,
  validateRealmWorldTrustStoreDocument,
  type RealmWorldTrustStoreDocumentV1,
} from "../modules/world-transfer/realmworld-signature.ts";
import {
  activateRealmWorldTrustStoreKey,
  addRealmWorldTrustStoreKey,
  createRealmWorldSignatureVerifierFromTrustStoreFile,
  mutateRealmWorldTrustStoreFile,
  readRealmWorldTrustStoreFile,
  revokeRealmWorldTrustStoreKey,
  rotateRealmWorldTrustStoreKey,
  writeRealmWorldTrustStoreFileAtomic,
} from "../modules/world-transfer/realmworld-trust-store.ts";

const execFileAsync = promisify(execFile);

const keyA = generateKeyPairSync("ed25519");
const keyB = generateKeyPairSync("ed25519");
const publicA = keyA.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
const publicB = keyB.publicKey.export({ type: "spki", format: "pem" }).toString().trim();

const baseManifest: RealmWorldManifestV1 = {
  format: "realmworld",
  formatVersion: 1,
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  engineCompat: {
    schemaLatest: "0055_goal_runtime.sql",
    requiresMigrations: ["0055_goal_runtime.sql"],
    baseRange: ">=1.0.0 <2.0.0",
  },
  contentHash: "a".repeat(64),
  signature: { algorithm: "ed25519", keyId: "key-a", value: "placeholder" },
  webui: { entry: "ui/index.html", bridgeMajor: 1 },
};

function signedManifest(
  privateKey: typeof keyA.privateKey,
  keyId: string,
): RealmWorldManifestV1 {
  const unsigned = { ...baseManifest, signature: { ...baseManifest.signature, keyId } };
  const payload = serializeRealmWorldManifestSigningPayload(unsigned);
  const value = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  return { ...unsigned, signature: { ...unsigned.signature, value } };
}

function emptyDocument(): RealmWorldTrustStoreDocumentV1 {
  return { format: "realmworld-trust-store", version: 1, keys: [] };
}

function documentWithKeyA(): RealmWorldTrustStoreDocumentV1 {
  return addRealmWorldTrustStoreKey({
    document: emptyDocument(),
    keyId: "key-a",
    publicKey: publicA,
  });
}

function trustStoreError(error: unknown, code: RealmWorldTrustStoreError["code"]): boolean {
  return error instanceof RealmWorldTrustStoreError && error.code === code;
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "realmworld-trust-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempFiles(
  dir: string,
): Promise<{ storePath: string; keyAPath: string; keyBPath: string }> {
  const keyAPath = join(dir, "operator-a.pub");
  const keyBPath = join(dir, "operator-b.pub");
  await writeFile(keyAPath, `${publicA}\n`, { mode: 0o600 });
  await writeFile(keyBPath, `${publicB}\n`, { mode: 0o600 });
  return { storePath: join(dir, "trust-store.json"), keyAPath, keyBPath };
}

async function verifyWith(
  verifier: RealmWorldSignatureVerifier,
  manifest: RealmWorldManifestV1,
): Promise<boolean> {
  return verifier({ manifest, manifestBytes: Buffer.from("unused"), contentHash: manifest.contentHash });
}

test("trust store validation rejects malformed, duplicate, invalid, and private-key documents", () => {
  assert.throws(() => validateRealmWorldTrustStoreDocument("not json"), (error) =>
    trustStoreError(error, "TRUST_STORE_INVALID"));
  assert.throws(() => validateRealmWorldTrustStoreDocument(
    JSON.stringify({ format: "other", version: 1, keys: [] }),
  ), (error) => trustStoreError(error, "TRUST_STORE_INVALID"));
  assert.throws(() => validateRealmWorldTrustStoreDocument({
    format: "realmworld-trust-store",
    version: 1,
    keys: [
      { keyId: "dup", publicKey: publicA, status: "active" },
      { keyId: "dup", publicKey: publicA, status: "revoked" },
    ],
  }), (error) => trustStoreError(error, "TRUST_STORE_DUPLICATE_KEY"));
  assert.throws(() => addRealmWorldTrustStoreKey({
    document: emptyDocument(),
    keyId: "broken",
    publicKey: "not-a-key",
  }), (error) => trustStoreError(error, "TRUST_STORE_INVALID"));
  // Trust material is public-key-only: private keys are never accepted.
  const privatePem = keyA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => addRealmWorldTrustStoreKey({
    document: emptyDocument(),
    keyId: "private",
    publicKey: privatePem,
  }), (error) => trustStoreError(error, "TRUST_STORE_INVALID"));
});

test("add mutation is pure and rejects duplicate or conflicting keyIds", () => {
  const original = documentWithKeyA();
  const snapshot = JSON.stringify(original);
  const extended = addRealmWorldTrustStoreKey({
    document: original,
    keyId: "key-b",
    publicKey: publicB,
  });
  assert.equal(JSON.stringify(original), snapshot, "mutation must not mutate its input");
  assert.equal(extended.keys.length, 2);
  assert.throws(() => addRealmWorldTrustStoreKey({
    document: original,
    keyId: "key-a",
    publicKey: publicA,
  }), (error) => trustStoreError(error, "TRUST_STORE_DUPLICATE_KEY"));
  // An existing keyId is never silently overwritten with different material.
  assert.throws(() => addRealmWorldTrustStoreKey({
    document: original,
    keyId: "key-a",
    publicKey: publicB,
  }), (error) => trustStoreError(error, "TRUST_STORE_KEY_CONFLICT"));
  assert.equal(JSON.stringify(original), snapshot, "failed mutation must leave the document intact");
});

test("activate and revoke mutations enforce known keyIds and status transitions", () => {
  const document = documentWithKeyA();
  assert.throws(() => revokeRealmWorldTrustStoreKey({ document, keyId: "missing" }), (error) =>
    trustStoreError(error, "TRUST_STORE_KEY_NOT_FOUND"));
  assert.throws(() => activateRealmWorldTrustStoreKey({ document, keyId: "missing" }), (error) =>
    trustStoreError(error, "TRUST_STORE_KEY_NOT_FOUND"));
  const revoked = revokeRealmWorldTrustStoreKey({ document, keyId: "key-a" });
  assert.equal(revoked.keys[0]?.status, "revoked");
  assert.equal(parseRealmWorldTrustStore(revoked).size, 0);
  const reactivated = activateRealmWorldTrustStoreKey({ document: revoked, keyId: "key-a" });
  assert.equal(parseRealmWorldTrustStore(reactivated).get("key-a"), publicA);
});

test("rotation stages the replacement before revoking or expiring the old key", () => {
  const document = documentWithKeyA();
  const staged = rotateRealmWorldTrustStoreKey({
    document,
    oldKeyId: "key-a",
    newKeyId: "key-b",
    newPublicKey: publicB,
  });
  assert.equal(staged.keys.length, 2);
  assert.equal(staged.keys.find((key) => key.keyId === "key-a")?.status, "active");
  assert.equal(staged.keys.find((key) => key.keyId === "key-b")?.status, "active");
  const active = parseRealmWorldTrustStore(staged);
  assert.equal(active.size, 2, "staged rotation keeps both keys verifiable");

  const retired = rotateRealmWorldTrustStoreKey({
    document,
    oldKeyId: "key-a",
    newKeyId: "key-b",
    newPublicKey: publicB,
    revokeOld: true,
  });
  assert.equal(retired.keys.find((key) => key.keyId === "key-a")?.status, "revoked");
  assert.deepEqual([...parseRealmWorldTrustStore(retired).keys()], ["key-b"]);

  const expiring = rotateRealmWorldTrustStoreKey({
    document,
    oldKeyId: "key-a",
    newKeyId: "key-b",
    newPublicKey: publicB,
    expireOld: "2026-10-05T00:00:00.000Z",
  });
  assert.equal(expiring.keys.find((key) => key.keyId === "key-a")?.notAfter, "2026-10-05T00:00:00.000Z");

  assert.throws(() => rotateRealmWorldTrustStoreKey({
    document,
    oldKeyId: "missing",
    newKeyId: "key-b",
    newPublicKey: publicB,
  }), (error) => trustStoreError(error, "TRUST_STORE_KEY_NOT_FOUND"));
  // Rotating onto an existing keyId never silently overwrites its material.
  assert.throws(() => rotateRealmWorldTrustStoreKey({
    document,
    oldKeyId: "key-a",
    newKeyId: "key-a",
    newPublicKey: publicB,
  }), (error) => trustStoreError(error, "TRUST_STORE_KEY_CONFLICT"));
});

test("validity windows gate activation and inverted windows are invalid", () => {
  const windowed = addRealmWorldTrustStoreKey({
    document: emptyDocument(),
    keyId: "key-a",
    publicKey: publicA,
    notBefore: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-10-31T23:59:59.999Z",
  });
  assert.equal(parseRealmWorldTrustStore(windowed, new Date("2026-10-05T00:00:00.000Z")).size, 1);
  assert.equal(parseRealmWorldTrustStore(windowed, new Date("2026-09-30T23:59:59.999Z")).size, 0);
  assert.equal(parseRealmWorldTrustStore(windowed, new Date("2026-11-01T00:00:00.000Z")).size, 0);
  assert.throws(() => addRealmWorldTrustStoreKey({
    document: emptyDocument(),
    keyId: "key-a",
    publicKey: publicA,
    notBefore: "2026-11-01T00:00:00.000Z",
    notAfter: "2026-10-01T00:00:00.000Z",
  }), (error) => trustStoreError(error, "TRUST_STORE_INVALID"));
});

test("atomic writer installs a restrictive-mode store and replaces it atomically", async (t) => {
  const dir = await tempDir(t);
  const storePath = join(dir, "trust-store.json");
  await writeRealmWorldTrustStoreFileAtomic({ path: storePath, document: documentWithKeyA() });
  const mode = (await stat(storePath)).mode & 0o777;
  assert.equal(mode, 0o600, "trust store must be written with restrictive permissions");
  const loaded = await readRealmWorldTrustStoreFile(storePath);
  assert.equal(loaded.keys.length, 1);
  await writeRealmWorldTrustStoreFileAtomic({ path: storePath, document: emptyDocument() });
  assert.equal((await readRealmWorldTrustStoreFile(storePath)).keys.length, 0);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("failed atomic write leaves the previous document and no temp file behind", async (t) => {
  const dir = await tempDir(t);
  const storePath = join(dir, "trust-store.json");
  await writeRealmWorldTrustStoreFileAtomic({ path: storePath, document: documentWithKeyA() });
  const before = await readFile(storePath, "utf8");
  // A mutation conflict rejects before any write is attempted.
  await assert.rejects(() => mutateRealmWorldTrustStoreFile(storePath, (current) =>
    addRealmWorldTrustStoreKey({ document: current, keyId: "key-a", publicKey: publicB })),
    (error) => trustStoreError(error, "TRUST_STORE_KEY_CONFLICT"));
  // An invalid candidate document rejects inside the atomic writer.
  await assert.rejects(() => writeRealmWorldTrustStoreFileAtomic({
    path: storePath,
    document: JSON.stringify({
      format: "realmworld-trust-store",
      version: 1,
      keys: [{ keyId: "broken", publicKey: "not-a-key", status: "active" }],
    }),
  }), (error) => trustStoreError(error, "TRUST_STORE_INVALID"));
  assert.equal(await readFile(storePath, "utf8"), before, "store must remain intact after failures");
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("atomic write failure on an unwritable target cleans up the temp file", async (t) => {
  const dir = await tempDir(t);
  const blockedPath = join(dir, "trust-store.json");
  await mkdir(blockedPath); // renaming a file over a directory fails
  await assert.rejects(() => writeRealmWorldTrustStoreFileAtomic({
    path: blockedPath,
    document: documentWithKeyA(),
  }), (error) => trustStoreError(error, "TRUST_STORE_WRITE_FAILED"));
  assert.equal((await stat(blockedPath)).isDirectory(), true, "previous path state is intact");
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("file loader rejects missing, symlinked, and non-regular stores fail-closed", async (t) => {
  const dir = await tempDir(t);
  const storePath = join(dir, "trust-store.json");
  await assert.rejects(() => readRealmWorldTrustStoreFile(join(dir, "missing.json")), (error) =>
    trustStoreError(error, "TRUST_STORE_UNREADABLE"));
  await assert.rejects(() => readRealmWorldTrustStoreFile(dir), (error) =>
    trustStoreError(error, "TRUST_STORE_UNREADABLE"));
  await writeRealmWorldTrustStoreFileAtomic({ path: storePath, document: documentWithKeyA() });
  const linkPath = join(dir, "trust-store-link.json");
  await symlink(storePath, linkPath);
  await assert.rejects(() => readRealmWorldTrustStoreFile(linkPath), (error) =>
    trustStoreError(error, "TRUST_STORE_UNREADABLE"));
  await writeFile(join(dir, "malformed.json"), "{ not json");
  await assert.rejects(() => readRealmWorldTrustStoreFile(join(dir, "malformed.json")), (error) =>
    trustStoreError(error, "TRUST_STORE_INVALID"));
});

test("file-backed verifier observes rotation and revocation without a restart", async (t) => {
  const dir = await tempDir(t);
  const storePath = join(dir, "trust-store.json");
  await writeRealmWorldTrustStoreFileAtomic({ path: storePath, document: documentWithKeyA() });
  const verifier = createRealmWorldSignatureVerifierFromTrustStoreFile({ path: storePath });
  const manifestA = signedManifest(keyA.privateKey, "key-a");
  const manifestB = signedManifest(keyB.privateKey, "key-b");
  assert.equal(await verifyWith(verifier, manifestA), true);
  assert.equal(await verifyWith(verifier, manifestB), false);

  // Operator rotates on disk: replacement added active, old key revoked.
  await mutateRealmWorldTrustStoreFile(storePath, (current) =>
    rotateRealmWorldTrustStoreKey({
      document: current,
      oldKeyId: "key-a",
      newKeyId: "key-b",
      newPublicKey: publicB,
      revokeOld: true,
    }));
  assert.equal(await verifyWith(verifier, manifestA), false, "revoked key fails on next verification");
  assert.equal(await verifyWith(verifier, manifestB), true, "replacement verifies on next verification");

  // A staged (not yet revoked) rotation keeps the old key verifiable.
  await mutateRealmWorldTrustStoreFile(storePath, (current) =>
    activateRealmWorldTrustStoreKey({ document: current, keyId: "key-a" }));
  assert.equal(await verifyWith(verifier, manifestA), true);

  // Revoking the replacement fails closed; deleting the store fails closed.
  await mutateRealmWorldTrustStoreFile(storePath, (current) =>
    revokeRealmWorldTrustStoreKey({ document: current, keyId: "key-b" }));
  assert.equal(await verifyWith(verifier, manifestB), false);
  await rm(storePath);
  assert.equal(await verifyWith(verifier, manifestA), false, "missing store fails closed");
});

test("file-backed verifier enforces validity windows via the injected clock", async (t) => {
  const dir = await tempDir(t);
  const storePath = join(dir, "trust-store.json");
  await writeRealmWorldTrustStoreFileAtomic({
    path: storePath,
    document: addRealmWorldTrustStoreKey({
      document: emptyDocument(),
      keyId: "key-a",
      publicKey: publicA,
      notBefore: "2026-10-01T00:00:00.000Z",
      notAfter: "2026-10-31T23:59:59.999Z",
    }),
  });
  const manifest = signedManifest(keyA.privateKey, "key-a");
  const inWindow = createRealmWorldSignatureVerifierFromTrustStoreFile({
    path: storePath,
    now: () => new Date("2026-10-05T00:00:00.000Z"),
  });
  const outOfWindow = createRealmWorldSignatureVerifierFromTrustStoreFile({
    path: storePath,
    now: () => new Date("2026-11-01T00:00:00.000Z"),
  });
  assert.equal(await verifyWith(inWindow, manifest), true);
  assert.equal(await verifyWith(outOfWindow, manifest), false);
});

test("operator CLI validates, mutates, and never prints key material", async (t) => {
  const dir = await tempDir(t);
  const { storePath, keyAPath, keyBPath } = await tempFiles(dir);
  const cliPath = new URL("../scripts/realmworld-trust-store.mjs", import.meta.url).pathname;
  const run = async (args: string[]) => {
    try {
      const result = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", cliPath, ...args],
        { encoding: "utf8" },
      );
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failed.code === "number" ? failed.code : -1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
      };
    }
  };
  const pemBodies = [publicA, publicB].map((pem) => pem.split("\n")[1] ?? "");
  const assertNoKeyMaterial = (output: { stdout: string; stderr: string }) => {
    const combined = `${output.stdout}\n${output.stderr}`;
    assert.equal(combined.includes("PRIVATE KEY"), false);
    assert.equal(combined.includes("BEGIN PUBLIC KEY"), false);
    for (const body of pemBodies) {
      assert.equal(combined.includes(body), false, "CLI output must not contain PEM material");
    }
  };

  // A fresh store needs an initial empty document before operator mutations.
  await writeFile(storePath, `${JSON.stringify(emptyDocument())}\n`, { mode: 0o600 });

  const missing = await run(["validate", "--store", join(dir, "missing.json")]);
  assert.equal(missing.code, 1);
  assertNoKeyMaterial(missing);

  const added = await run([
    "add", "--store", storePath, "--key-id", "key-a", "--public-key-file", keyAPath,
  ]);
  assert.equal(added.code, 0);
  assert.match(added.stdout, /ok: added key key-a/);
  assertNoKeyMaterial(added);

  const validated = await run(["validate", "--store", storePath]);
  assert.equal(validated.code, 0);
  assert.match(validated.stdout, /key key-a status=active/);
  assertNoKeyMaterial(validated);

  const rotated = await run([
    "rotate", "--store", storePath,
    "--old-key-id", "key-a", "--new-key-id", "key-b",
    "--new-public-key-file", keyBPath, "--revoke-old",
  ]);
  assert.equal(rotated.code, 0);
  assert.match(rotated.stdout, /ok: rotated key key-a -> key-b/);
  assert.match(rotated.stdout, /key key-a status=revoked/);
  assertNoKeyMaterial(rotated);

  const revoked = await run(["revoke", "--store", storePath, "--key-id", "key-b"]);
  assert.equal(revoked.code, 0);
  assert.match(revoked.stdout, /key key-b status=revoked/);
  assertNoKeyMaterial(revoked);

  const activated = await run(["activate", "--store", storePath, "--key-id", "key-b"]);
  assert.equal(activated.code, 0);
  assert.match(activated.stdout, /key key-b status=active/);
  assertNoKeyMaterial(activated);

  const conflict = await run([
    "add", "--store", storePath, "--key-id", "key-a", "--public-key-file", keyBPath,
  ]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /TRUST_STORE_KEY_CONFLICT/);
  assertNoKeyMaterial(conflict);

  const usage = await run(["validate"]);
  assert.equal(usage.code, 2);
  assertNoKeyMaterial(usage);

  // The on-disk document still verifies against the parsed contract.
  const finalDocument = await readRealmWorldTrustStoreFile(storePath);
  assert.equal(finalDocument.keys.length, 2);
});
