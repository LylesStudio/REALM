import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRealmWorldArchive,
  computeRealmWorldContentHash,
  installRealmWorldArchive,
  installRealmWorldDirectory,
  loadRealmWorldArchive,
  loadRealmWorldDirectory,
  mountRealmWorld,
  RealmWorldLoaderError,
  type RealmWorldSignatureVerifier,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifest,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import { createInstalledRealmWorldInstantiationResolver } from "../modules/world-transfer/realmworld-runtime-content.ts";

const CONTENT_FILES = {
  "content/index.json": Buffer.from(
    '{"format":"realmworld-content","schemaVersion":1,"modules":["content/world.json","content/runtime.json","content/goals.json"]}',
  ),
  "content/world.json": Buffer.from(
    '{"worldId":"world-harbor","title":{"en":"Harbor"},"settings":{"era":"storm"}}',
  ),
  "content/runtime.json": Buffer.from(
    '{"format":"realmworld-runtime","schemaVersion":1,"story":{"title":{"en":"Harbor Story"},"premise":{"en":"The watch begins."}},"record":{"title":{"en":"First Watch"}},"scene":{"title":{"en":"North Pier"},"location":{"en":"North pier"},"objective":{"en":"Hold the line"},"tension":{"en":"Quiet pressure"},"weather":{"en":"Salt rain"},"displayTime":{"en":"Night"}},"playerRole":{"en":"Keeper"},"playerStance":"player","characters":[]}',
  ),
  "content/goals.json": Buffer.from(
    '{"format":"realmworld-goals","schemaVersion":1,"goals":[]}',
  ),
  "media/cover.bin": Buffer.from("fixture-media"),
  "ui/index.html": Buffer.from("<!doctype html><title>Harbor</title>"),
} as const;

const verifyTrustedSignature: RealmWorldSignatureVerifier = ({ manifest }) =>
  manifest.signature.value === "trusted";

async function createFixture(root: string, options: { signature?: string } = {}): Promise<void> {
  const files = new Map<string, Uint8Array>(
    Object.entries(CONTENT_FILES).map(([path, bytes]) => [path, bytes]),
  );
  const manifest: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: "world-harbor",
    worldVersion: "1.2.0",
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange: ">=1.0.0 <2.0.0",
    },
    contentHash: computeRealmWorldContentHash(files),
    signature: {
      algorithm: "ed25519",
      keyId: "fixture-key",
      value: options.signature ?? "trusted",
    },
    webui: { entry: "ui/index.html", bridgeMajor: 1 },
  };
  await mkdir(root, { recursive: true });
  for (const [relativePath, bytes] of files) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(
    join(root, "realmworld-manifest.json"),
    serializeRealmWorldManifest(manifest),
  );
}

async function withTempRoots(
  callback: (roots: { source: string; install: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "realmworld-loader-test-"));
  const source = join(root, "source");
  const install = join(root, "install");
  try {
    await callback({ source, install });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("RealmWorld directory loader validates content hash, schema, and signature", async () => {
  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    const loaded = await loadRealmWorldDirectory(source, {
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(loaded.manifest.worldId, "world-harbor");
    assert.equal(loaded.manifest.worldVersion, "1.2.0");
    assert.deepEqual(
      JSON.parse(Buffer.from(loaded.files.get("content/world.json")!).toString("utf8")),
      { worldId: "world-harbor", title: { en: "Harbor" }, settings: { era: "storm" } },
    );
    assert.equal(loaded.files.get("ui/index.html")?.byteLength, 36);
  });
});

test("RealmWorld loader rejects tampering, missing verifier, and unsafe files", async () => {
  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    await writeFile(join(source, "content", "world.json"), "tampered");
    await assert.rejects(
      () => loadRealmWorldDirectory(source, { verifySignature: verifyTrustedSignature }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "CONTENT_HASH_MISMATCH",
    );
  });

  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    await assert.rejects(
      () => loadRealmWorldDirectory(source),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "SIGNATURE_VERIFIER_REQUIRED",
    );
  });

  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    await writeFile(join(source, "content", "escape.sql"), "SELECT 1");
    await assert.rejects(
      () => loadRealmWorldDirectory(source, { verifySignature: verifyTrustedSignature }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "UNSUPPORTED_PACKAGE_ENTRY",
    );
  });

  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    const manifestPath = join(source, "realmworld-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      webui: { entry: string };
    };
    manifest.webui.entry = "content/world.json";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => loadRealmWorldDirectory(source, { verifySignature: verifyTrustedSignature }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "CONTENT_SCHEMA_INVALID",
    );
  });
});

test("RealmWorld install is atomic and idempotent, then mounts by WorldBinding", async () => {
  await withTempRoots(async ({ source, install }) => {
    await createFixture(source);
    const first = await installRealmWorldDirectory({
      sourceDir: source,
      installRoot: install,
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(first.reused, false);
    assert.equal(await readFile(join(first.installDir, "realmworld-manifest.json"), "utf8"),
      await readFile(join(source, "realmworld-manifest.json"), "utf8"));

    const second = await installRealmWorldDirectory({
      sourceDir: source,
      installRoot: install,
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(second.reused, true);
    assert.equal(second.installDir, first.installDir);

    const mounted = await mountRealmWorld({
      installRoot: install,
      worldId: "world-harbor",
      worldVersion: "1.2.0",
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(mounted.manifest.worldId, "world-harbor");
    assert.equal(mounted.manifest.worldVersion, "1.2.0");
    assert.equal(mounted.rootDir, first.installDir);
    const runtimeResolver = createInstalledRealmWorldInstantiationResolver({
      installRoot: install,
      verifySignature: verifyTrustedSignature,
      locale: "en",
    });
    const runtimePlan = await runtimeResolver({
      kind: "world",
      worldId: "world-harbor",
      worldVersion: "1.2.0",
    });
    assert.equal(runtimePlan?.binding.worldId, "world-harbor");
    assert.equal(runtimePlan?.story.title, "Harbor Story");
    assert.equal(runtimePlan?.scene.objective, "Hold the line");
  });
});

test("RealmWorld .realmworld archive round-trips through the strict ZIP layer", async () => {
  await withTempRoots(async ({ source, install }) => {
    await createFixture(source);
    const directory = await loadRealmWorldDirectory(source, {
      verifySignature: verifyTrustedSignature,
    });
    const archive = buildRealmWorldArchive({
      manifest: directory.manifest,
      files: directory.files,
    });
    const loaded = await loadRealmWorldArchive(archive, {
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(loaded.manifest.contentHash, directory.manifest.contentHash);
    assert.deepEqual([...loaded.files.keys()], [...directory.files.keys()].sort());

    const installed = await installRealmWorldArchive({
      archiveBytes: archive,
      installRoot: install,
      verifySignature: verifyTrustedSignature,
    });
    assert.equal(installed.reused, false);
    await assert.rejects(
      () => loadRealmWorldArchive(archive.slice(0, -1), {
        verifySignature: verifyTrustedSignature,
      }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "INVALID_PACKAGE",
    );
  });
});

test("RealmWorld loader rejects symlinked content and missing mounts fail explicitly", async () => {
  await withTempRoots(async ({ source }) => {
    await createFixture(source);
    await symlink("/etc/hosts", join(source, "media", "hosts"));
    await assert.rejects(
      () => loadRealmWorldDirectory(source, { verifySignature: verifyTrustedSignature }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "SYMLINK_NOT_ALLOWED",
    );
  });

  await withTempRoots(async ({ install }) => {
    await assert.rejects(
      () => mountRealmWorld({
        installRoot: install,
        worldId: "world-missing",
        worldVersion: "1.0.0",
        verifySignature: verifyTrustedSignature,
      }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "WORLD_NOT_INSTALLED",
    );
  });
});

test("A2 installed policy resolver verifies real signatures and rejects self-asserted trust, mutations and missing exact versions", async t => {
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { installSignedRealmWorldFixture, syntheticCommandPolicyFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { createInstalledRealmWorldCommandPolicyResolver, assertMountedCommandPolicy } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  const root = await mkdtemp(join(tmpdir(), "a2-signed-policy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const keyPair = { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  await installSignedRealmWorldFixture({ installRoot: root, worldId: "world-synthetic", version: "1.0.0", recordTitle: "Synthetic",
    keyId: "synthetic", keyPair, commandPolicy: syntheticCommandPolicyFixture(), declaredEvents: ["synthetic.ready"] });
  const resolver = createInstalledRealmWorldCommandPolicyResolver({ installRoot: root, verifySignature: ({ manifest }) => verify(null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), keyPair.publicKeyPem, Buffer.from(manifest.signature.value, "base64url")) });
  const policy = await resolver({ worldId: "world-synthetic", worldVersion: "1.0.0" });
  assert.ok(policy); assertMountedCommandPolicy(policy);
  assert.throws(() => assertMountedCommandPolicy({ ...policy }));
  assert.throws(() => { policy.document.bindings[0]!.all.length = 0; });
  await assert.rejects(() => resolver({ worldId: "world-synthetic", worldVersion: "2.0.0" }));
  await writeFile(join(root, "world-synthetic", "1.0.0", "content", "command-policy.json"), JSON.stringify({ ...syntheticCommandPolicyFixture(), policyVersion: "tampered" }));
  await assert.rejects(() => resolver({ worldId: "world-synthetic", worldVersion: "1.0.0" }), /hash/);
});
