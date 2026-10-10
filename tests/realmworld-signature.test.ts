import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createRealmWorldSignatureVerifier,
  createRealmWorldSignatureVerifierFromTrustStoreDocument,
  parseRealmWorldTrustStore,
  RealmWorldTrustStoreError,
  type RealmWorldTrustedKeyMaterial,
} from "../modules/world-transfer/realmworld-signature.ts";
import {
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicDer = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

const baseManifest: RealmWorldManifestV1 = {
  format: "realmworld",
  formatVersion: 1,
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  engineCompat: {
    schemaLatest: "0055_goal_runtime.sql",
    requiresMigrations: ["0055_goal_runtime.sql"],
  },
  contentHash: "a".repeat(64),
  signature: { algorithm: "ed25519", keyId: "fixture-key", value: "placeholder" },
  webui: { entry: "ui/index.html", bridgeMajor: 1 },
};

function signedManifest(overrides: Partial<RealmWorldManifestV1> = {}): RealmWorldManifestV1 {
  const unsigned = { ...baseManifest, ...overrides, signature: baseManifest.signature };
  const payload = serializeRealmWorldManifestSigningPayload(unsigned);
  const value = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  return {
    ...unsigned,
    signature: { ...baseManifest.signature, value },
  };
}

test("RealmWorld Ed25519 verifier accepts the canonical manifest payload", async () => {
  const trustedKeys: RealmWorldTrustedKeyMaterial = new Map([["fixture-key", publicDer]]);
  const verify = createRealmWorldSignatureVerifier({ trustedKeys });
  assert.equal(await verify({
    manifest: signedManifest(),
    manifestBytes: Buffer.from("unused"),
    contentHash: baseManifest.contentHash,
  }), true);
});

test("RealmWorld signature verifier rejects unknown keys, tampering, and malformed encodings", async () => {
  const verify = createRealmWorldSignatureVerifier({
    trustedKeys: new Map([["fixture-key", publicDer]]),
  });
  const valid = signedManifest();
  assert.equal(await verify({
    manifest: { ...valid, signature: { ...valid.signature, keyId: "unknown" } },
    manifestBytes: Buffer.from("unused"),
    contentHash: valid.contentHash,
  }), false);
  assert.equal(await verify({
    manifest: { ...valid, worldVersion: "1.3.0" },
    manifestBytes: Buffer.from("unused"),
    contentHash: valid.contentHash,
  }), false);
  assert.equal(await verify({
    manifest: { ...valid, signature: { ...valid.signature, value: "%%%" } },
    manifestBytes: Buffer.from("unused"),
    contentHash: valid.contentHash,
  }), false);
});

test("RealmWorld verifier accepts PEM trusted keys without exposing key material", async () => {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const verify = createRealmWorldSignatureVerifier({
    trustedKeys: { "fixture-key": pem },
  });
  assert.equal(await verify({
    manifest: signedManifest(),
    manifestBytes: Buffer.from("unused"),
    contentHash: baseManifest.contentHash,
  }), true);
});

test("RealmWorld trust store supports validity windows and explicit key revocation", async () => {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const document = {
    format: "realmworld-trust-store" as const,
    version: 1 as const,
    keys: [{
      keyId: "fixture-key",
      publicKey: pem,
      status: "active" as const,
      notBefore: "2026-10-01T00:00:00.000Z",
      notAfter: "2026-10-31T23:59:59.999Z",
    }],
  };
  const active = createRealmWorldSignatureVerifierFromTrustStoreDocument({
    document,
    now: new Date("2026-10-05T00:00:00.000Z"),
  });
  assert.equal(await active({
    manifest: signedManifest(),
    manifestBytes: Buffer.from("unused"),
    contentHash: baseManifest.contentHash,
  }), true);
  const expired = parseRealmWorldTrustStore(document, new Date("2026-11-01T00:00:00.000Z"));
  assert.equal(expired.size, 0);
  assert.throws(
    () => parseRealmWorldTrustStore({
      ...document,
      keys: [document.keys[0]!, document.keys[0]!],
    }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && (error as RealmWorldTrustStoreError).code === "TRUST_STORE_DUPLICATE_KEY",
  );
  const revoked = createRealmWorldSignatureVerifierFromTrustStoreDocument({
    document: { ...document, keys: [{ ...document.keys[0]!, status: "revoked" as const }] },
    now: new Date("2026-10-05T00:00:00.000Z"),
  });
  assert.equal(await revoked({
    manifest: signedManifest(),
    manifestBytes: Buffer.from("unused"),
    contentHash: baseManifest.contentHash,
  }), false);
});
