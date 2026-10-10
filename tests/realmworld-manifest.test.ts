import assert from "node:assert/strict";
import test from "node:test";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  RealmWorldManifestError,
  parseRealmWorldManifest,
  serializeRealmWorldManifest,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";

const validManifest: RealmWorldManifestV1 = {
  format: REALMWORLD_FORMAT,
  formatVersion: REALMWORLD_FORMAT_VERSION,
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  engineCompat: {
    schemaLatest: "0055_goal_runtime.sql",
    requiresMigrations: [
      "0054_world_version_identity.sql",
      "0055_goal_runtime.sql",
    ],
  },
  contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  signature: {
    algorithm: "ed25519",
    keyId: "realmworld-key-1",
    value: "signature-value",
  },
  webui: {
    entry: "ui/index.html",
    bridgeMajor: 1,
  },
};

test("RealmWorld manifest serializes with a frozen canonical shape and round-trips", () => {
  const bytes = serializeRealmWorldManifest(validManifest);
  assert.equal(
    bytes,
    '{"format":"realmworld","formatVersion":1,"worldId":"world-harbor","worldVersion":"1.2.0","engineCompat":{"schemaLatest":"0055_goal_runtime.sql","requiresMigrations":["0054_world_version_identity.sql","0055_goal_runtime.sql"]},"contentHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","signature":{"algorithm":"ed25519","keyId":"realmworld-key-1","value":"signature-value"},"webui":{"entry":"ui/index.html","bridgeMajor":1}}',
  );
  assert.deepEqual(parseRealmWorldManifest(bytes), validManifest);
});

test("RealmWorld manifest canonicalizes migration order and preserves optional webui absence", () => {
  const manifest: RealmWorldManifestV1 = structuredClone(validManifest);
  delete manifest.webui;
  manifest.engineCompat = {
    ...manifest.engineCompat,
    requiresMigrations: [
      "0055_goal_runtime.sql",
      "0054_world_version_identity.sql",
    ],
  };
  const parsed = parseRealmWorldManifest(serializeRealmWorldManifest(manifest));
  assert.deepEqual(parsed.engineCompat.requiresMigrations, [
    "0054_world_version_identity.sql",
    "0055_goal_runtime.sql",
  ]);
  assert.equal("webui" in parsed, false);
});

test("RealmWorld manifest rejects unknown fields at every schema boundary", () => {
  const topLevel = JSON.parse(serializeRealmWorldManifest(validManifest)) as Record<string, unknown>;
  topLevel.extra = true;
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(topLevel)),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "INVALID_MANIFEST",
  );

  const nested = JSON.parse(serializeRealmWorldManifest(validManifest)) as {
    engineCompat: Record<string, unknown>;
  } & Record<string, unknown>;
  nested.engineCompat.extra = true;
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(nested)),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "INVALID_MANIFEST",
  );
});

test("RealmWorld manifest rejects a future format version before content use", () => {
  const future = JSON.parse(serializeRealmWorldManifest(validManifest)) as Record<string, unknown>;
  future.formatVersion = REALMWORLD_FORMAT_VERSION + 1;
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(future)),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "UNSUPPORTED_FORMAT_VERSION",
  );
});

test("RealmWorld identity and content hash are strict and fail closed", () => {
  for (const field of ["worldId", "worldVersion"] as const) {
    const malformed = { ...validManifest, [field]: ` ${validManifest[field]}` };
    assert.throws(() => serializeRealmWorldManifest(malformed), RealmWorldManifestError);
  }
  assert.throws(
    () => serializeRealmWorldManifest({ ...validManifest, contentHash: "sha256:bad" }),
    RealmWorldManifestError,
  );
  assert.throws(
    () => serializeRealmWorldManifest({
      ...validManifest,
      engineCompat: { ...validManifest.engineCompat, requiresMigrations: ["0055_goal_runtime.sql", "0055_goal_runtime.sql"] },
    }),
    RealmWorldManifestError,
  );
  for (const unsafe of ["../outside", "nested/world", "nested\\world", ".", ".."] ) {
    assert.throws(
      () => serializeRealmWorldManifest({ ...validManifest, worldId: unsafe }),
      RealmWorldManifestError,
    );
  }
});

test("RealmWorld WebUI entry is relative and bridgeMajor is positive", () => {
  for (const entry of ["/ui/index.html", "ui/../index.html", "ui\\index.html", ""]) {
    assert.throws(
      () => serializeRealmWorldManifest({ ...validManifest, webui: { entry, bridgeMajor: 1 } }),
      RealmWorldManifestError,
    );
  }
  assert.throws(
    () => serializeRealmWorldManifest({ ...validManifest, webui: { entry: "ui/index.html", bridgeMajor: 0 } }),
    RealmWorldManifestError,
  );
});

test("RealmWorld signature metadata is explicit and bounded", () => {
  assert.throws(
    () => serializeRealmWorldManifest({
      ...validManifest,
      signature: { ...validManifest.signature, algorithm: "rsa" as "ed25519" },
    }),
    RealmWorldManifestError,
  );
  assert.throws(
    () => serializeRealmWorldManifest({
      ...validManifest,
      signature: { ...validManifest.signature, value: "\nsecret" },
    }),
    RealmWorldManifestError,
  );
});
