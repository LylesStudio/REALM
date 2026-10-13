/**
 * Base provider operator lifecycle（Slice 5）纯测试（无 DB）：
 * - ENGINE_BASE_WORLD 规范哨兵与可 serve 版本集合；
 * - baseRange 区间文法（精确、通配、caret、tilde、比较子合取、非法 fail-closed）；
 * - manifest：baseRange 必填且可解析、base 哨兵身份冒充拒绝；
 * - loader：install/mount 按活动 base 版本评估 baseRange，
 *   不兼容 fail-closed BASE_VERSION_INCOMPATIBLE；
 * - trust-store base 段结构校验 + activate/switch/rollback 纯变更矩阵；
 * - HTTP operator 路由：session fail-closed、稳定码、响应不泄露
 *   installRoot/trust-store 路径/keyId/签名材料。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ENGINE_BASE_CONTENT_VERSION,
  ENGINE_BASE_CONTENT_VERSIONS,
  ENGINE_BASE_WORLD,
  isEngineBaseVersionSatisfied,
  isEngineBaseContentVersionServable,
  isEngineBaseWorldIdentity,
  parseEngineBaseVersionRange,
} from "../modules/world-transfer/engine-base.ts";
import {
  computeRealmWorldContentHash,
  installRealmWorldDirectory,
  mountRealmWorld,
  RealmWorldLoaderError,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  parseRealmWorldManifest,
  RealmWorldManifestError,
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifest,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import {
  RealmWorldTrustStoreError,
  validateRealmWorldTrustStoreDocument,
  type RealmWorldTrustStoreDocumentV1,
} from "../modules/world-transfer/realmworld-signature.ts";
import {
  activateRealmWorldTrustStoreBase,
  addRealmWorldTrustStoreKey,
  mutateRealmWorldTrustStoreFile,
  readRealmWorldTrustStoreFile,
  resolveEngineBaseActiveVersion,
  rollbackRealmWorldTrustStoreBase,
  switchRealmWorldTrustStoreBase,
} from "../modules/world-transfer/realmworld-trust-store.ts";
import { GET as baseProviderStatus } from "../app/api/base-provider/status/route.ts";
import { POST as baseProviderActivate } from "../app/api/base-provider/activate/route.ts";
import { POST as baseProviderSwitch } from "../app/api/base-provider/switch/route.ts";
import { POST as baseProviderRollback } from "../app/api/base-provider/rollback/route.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { installTestSessionSecret, sessionProofFor } from "./helpers/session-proof.ts";
import { generateKeyPairSync } from "node:crypto";

installTestSessionSecret();

// ---------------------------------------------------------------------------
// ENGINE_BASE_WORLD 规范声明
// ---------------------------------------------------------------------------

test("ENGINE_BASE_WORLD is the canonical deterministic base sentinel", () => {
  assert.equal(ENGINE_BASE_WORLD.worldId, "");
  assert.equal(ENGINE_BASE_WORLD.worldVersion, LOCAL_WORLD_VERSION);
  assert.ok(Object.isFrozen(ENGINE_BASE_WORLD));
  assert.ok(isEngineBaseWorldIdentity("", LOCAL_WORLD_VERSION));
  assert.ok(!isEngineBaseWorldIdentity("world-harbor", LOCAL_WORLD_VERSION));
  assert.ok(!isEngineBaseWorldIdentity("", "1.0.0"));
  assert.ok(ENGINE_BASE_CONTENT_VERSIONS.includes(ENGINE_BASE_CONTENT_VERSION));
  assert.ok(isEngineBaseContentVersionServable(ENGINE_BASE_CONTENT_VERSION));
  assert.ok(!isEngineBaseContentVersionServable("9.9.9"));
});

// ---------------------------------------------------------------------------
// baseRange 区间文法
// ---------------------------------------------------------------------------

test("engine base version range grammar is bounded and deterministic", () => {
  // 合法形态
  assert.ok(isEngineBaseVersionSatisfied("*", "1.0.0"));
  assert.ok(isEngineBaseVersionSatisfied("*", "0.0.1"));
  assert.ok(isEngineBaseVersionSatisfied("1.0.0", "1.0.0"));
  assert.ok(!isEngineBaseVersionSatisfied("1.0.0", "1.0.1"));
  assert.ok(isEngineBaseVersionSatisfied("=1.0.0", "1.0.0"));
  assert.ok(isEngineBaseVersionSatisfied("^1.2.3", "1.9.9"));
  assert.ok(!isEngineBaseVersionSatisfied("^1.2.3", "2.0.0"));
  assert.ok(!isEngineBaseVersionSatisfied("^1.2.3", "1.2.2"));
  assert.ok(isEngineBaseVersionSatisfied("^0.2.3", "0.2.9"));
  assert.ok(!isEngineBaseVersionSatisfied("^0.2.3", "0.3.0"));
  assert.ok(isEngineBaseVersionSatisfied("^0.0.3", "0.0.3"));
  assert.ok(!isEngineBaseVersionSatisfied("^0.0.3", "0.0.4"));
  assert.ok(isEngineBaseVersionSatisfied("~1.2.3", "1.2.9"));
  assert.ok(!isEngineBaseVersionSatisfied("~1.2.3", "1.3.0"));
  assert.ok(isEngineBaseVersionSatisfied(">=1.0.0 <2.0.0", "1.4.2"));
  assert.ok(!isEngineBaseVersionSatisfied(">=1.0.0 <2.0.0", "2.0.0"));
  assert.ok(!isEngineBaseVersionSatisfied(">=1.0.0 <2.0.0", "0.9.9"));
  assert.ok(isEngineBaseVersionSatisfied(">1.0.0 <=1.5.0", "1.5.0"));
  assert.ok(!isEngineBaseVersionSatisfied(">1.0.0 <=1.5.0", "1.0.0"));

  // 非法形态一律不可解析（fail-closed）
  for (const bad of [
    "",
    " ",
    " 1.0.0",
    "1.0.0 ",
    "1.0",
    "v1.0.0",
    "1.0.0-rc.1",
    "01.0.0",
    "latest",
    "^x.y.z",
    ">= 1.0.0",
    "1.0.0 || 2.0.0",
    ">=1.0.0, <2.0.0",
    `>${"1".repeat(300)}`,
    ">=1.0.0 ".repeat(9).trim(),
  ]) {
    assert.equal(parseEngineBaseVersionRange(bad), null, `range ${JSON.stringify(bad)}`);
    assert.equal(isEngineBaseVersionSatisfied(bad, "1.0.0"), false);
  }
  // 版本非严格 semver → 不满足任何区间
  assert.equal(isEngineBaseVersionSatisfied("*", "0.0.0-local"), false);
  assert.equal(isEngineBaseVersionSatisfied(">=1.0.0", "1.0"), false);
});

// ---------------------------------------------------------------------------
// manifest：baseRange 必填 + base 哨兵冒充拒绝
// ---------------------------------------------------------------------------

function manifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: "world-harbor",
    worldVersion: "1.2.0",
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange: ">=1.0.0 <2.0.0",
    },
    contentHash: "a".repeat(64),
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "trusted" },
    ...overrides,
  };
}

test("RealmWorld manifest requires a parseable engineCompat.baseRange", () => {
  const parsed = parseRealmWorldManifest(JSON.stringify(manifestInput()));
  assert.equal(parsed.engineCompat.baseRange, ">=1.0.0 <2.0.0");

  // 缺 baseRange → fail-closed
  const missing = manifestInput();
  delete (missing.engineCompat as Record<string, unknown>).baseRange;
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(missing)),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "INVALID_MANIFEST",
  );
  // 不可解析区间 → fail-closed
  for (const bad of ["latest", "1.0", ">= 1.0.0", ""]) {
    const input = manifestInput();
    (input.engineCompat as Record<string, unknown>).baseRange = bad;
    assert.throws(
      () => parseRealmWorldManifest(JSON.stringify(input)),
      (error: unknown) => error instanceof RealmWorldManifestError
        && error.code === "INVALID_MANIFEST",
      `baseRange ${JSON.stringify(bad)}`,
    );
  }
  // 未知 engineCompat 键 → fail-closed
  const extra = manifestInput();
  (extra.engineCompat as Record<string, unknown>).extra = true;
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(extra)),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "INVALID_MANIFEST",
  );
});

test("RealmWorld manifest must not masquerade as the engine base sentinel", () => {
  assert.throws(
    () => parseRealmWorldManifest(JSON.stringify(manifestInput({ worldVersion: LOCAL_WORLD_VERSION }))),
    (error: unknown) => error instanceof RealmWorldManifestError
      && error.code === "INVALID_MANIFEST",
  );
  // 序列化 canonical 字节含 baseRange（键序冻结）。
  const manifest: RealmWorldManifestV1 = parseRealmWorldManifest(JSON.stringify(manifestInput()));
  const serialized = serializeRealmWorldManifest(manifest);
  assert.match(serialized, /"baseRange":">=1\.0\.0 <2\.0\.0"/);
  assert.deepEqual(parseRealmWorldManifest(serialized), manifest);
});

// ---------------------------------------------------------------------------
// loader：BASE_VERSION_INCOMPATIBLE fail-closed
// ---------------------------------------------------------------------------

const CONTENT_FILES = new Map<string, Uint8Array>([
  ["content/index.json", Buffer.from(JSON.stringify({
    format: "realmworld-content",
    schemaVersion: 1,
    modules: ["content/world.json", "content/runtime.json", "content/goals.json"],
  }))],
  ["content/world.json", Buffer.from(
    '{"worldId":"world-harbor","title":{"en":"Harbor"},"settings":{"era":"storm"}}',
  )],
  ["content/runtime.json", Buffer.from(
    '{"format":"realmworld-runtime","schemaVersion":1,"story":{"title":{"en":"Harbor Story"},"premise":{"en":"The watch begins."}},"record":{"title":{"en":"First Watch"}},"scene":{"title":{"en":"North Pier"},"location":{"en":"North pier"},"objective":{"en":"Hold the line"},"tension":{"en":"Quiet pressure"},"weather":{"en":"Salt rain"},"displayTime":{"en":"Night"}},"playerRole":{"en":"Keeper"},"playerStance":"player","characters":[]}',
  )],
  ["content/goals.json", Buffer.from(
    '{"format":"realmworld-goals","schemaVersion":1,"goals":[]}',
  )],
]);

const verifyTrusted = ({ manifest }: { manifest: RealmWorldManifestV1 }) =>
  manifest.signature.value === "trusted";

async function createPackage(root: string, baseRange: string): Promise<void> {
  const manifest: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: "world-harbor",
    worldVersion: "1.2.0",
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange,
    },
    contentHash: computeRealmWorldContentHash(CONTENT_FILES),
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "trusted" },
  };
  await mkdir(root, { recursive: true });
  for (const [relativePath, bytes] of CONTENT_FILES) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(join(root, "realmworld-manifest.json"), serializeRealmWorldManifest(manifest));
}

test("loader fails closed with BASE_VERSION_INCOMPATIBLE on base range mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "realm-base-compat-"));
  try {
    // 不兼容区间：install 即拒（默认引擎当前 base 版本）。
    await createPackage(join(root, "source-incompatible"), ">=2.0.0");
    await assert.rejects(
      () => installRealmWorldDirectory({
        sourceDir: join(root, "source-incompatible"),
        installRoot: join(root, "install"),
        verifySignature: verifyTrusted,
      }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "BASE_VERSION_INCOMPATIBLE",
    );

    // 兼容区间：install 成功；但按更高活动 base 版本 mount → fail-closed，
    // 按缺省/匹配活动版本 mount → 成功（rollback 恢复兼容基线语义）。
    await createPackage(join(root, "source-compatible"), ">=1.0.0 <2.0.0");
    await installRealmWorldDirectory({
      sourceDir: join(root, "source-compatible"),
      installRoot: join(root, "install"),
      verifySignature: verifyTrusted,
    });
    await assert.rejects(
      () => mountRealmWorld({
        installRoot: join(root, "install"),
        worldId: "world-harbor",
        worldVersion: "1.2.0",
        verifySignature: verifyTrusted,
        engineBaseVersion: "2.0.0",
      }),
      (error: unknown) => error instanceof RealmWorldLoaderError
        && error.code === "BASE_VERSION_INCOMPATIBLE",
    );
    const mounted = await mountRealmWorld({
      installRoot: join(root, "install"),
      worldId: "world-harbor",
      worldVersion: "1.2.0",
      verifySignature: verifyTrusted,
      engineBaseVersion: "1.0.0",
    });
    assert.equal(mounted.manifest.worldId, "world-harbor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// trust-store base 段校验 + operator lifecycle 纯变更
// ---------------------------------------------------------------------------

const TRUST_KEY = {
  keyId: "fixture-key",
  publicKey: generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" }).toString().trim(),
  status: "active" as const,
};

function storeDocument(base?: { activeVersion: string; previousVersion?: string })
  : RealmWorldTrustStoreDocumentV1 {
  return validateRealmWorldTrustStoreDocument({
    format: "realmworld-trust-store",
    version: 1,
    keys: [TRUST_KEY],
    ...(base ? { base } : {}),
  });
}

test("trust-store base section is strictly validated", () => {
  // 合法段通过并冻结保留
  const document = storeDocument({ activeVersion: "1.0.0", previousVersion: "0.9.0" });
  assert.equal(document.base?.activeVersion, "1.0.0");
  assert.equal(document.base?.previousVersion, "0.9.0");

  // 非 semver / previous===active / 未知键 一律 fail-closed
  for (const base of [
    { activeVersion: "latest" },
    { activeVersion: "1.0.0", previousVersion: "1.0.0" },
    { activeVersion: "1.0.0", extra: true },
    { activeVersion: "1.0.0", previousVersion: "0.9" },
  ]) {
    assert.throws(
      () => storeDocument(base as { activeVersion: string }),
      (error: unknown) => error instanceof RealmWorldTrustStoreError
        && error.code === "TRUST_STORE_INVALID",
      JSON.stringify(base),
    );
  }

  // key 变更保留 base 段
  const rotated = addRealmWorldTrustStoreKey({
    document,
    keyId: "second-key",
    publicKey: TRUST_KEY.publicKey,
  });
  assert.equal(rotated.base?.activeVersion, "1.0.0");
  assert.equal(rotated.keys.length, 2);
});

test("base provider lifecycle mutations are validated and fail closed", () => {
  const available = ["1.0.0", "2.0.0"];

  // activate：无 base 段 → 激活；同版本幂等 replay（同一文档引用）；
  // 已激活异版本 → BASE_ALREADY_ACTIVE；非法/不可 serve → fail-closed。
  const inactive = storeDocument();
  assert.equal(resolveEngineBaseActiveVersion(inactive), ENGINE_BASE_CONTENT_VERSION);
  const activated = activateRealmWorldTrustStoreBase({
    document: inactive, version: "1.0.0", availableVersions: available,
  });
  assert.equal(activated.base?.activeVersion, "1.0.0");
  assert.equal(activated.base?.previousVersion, undefined);
  // 同版本幂等 replay：文档内容不变（可能为重新校验的新引用）。
  assert.deepEqual(
    activateRealmWorldTrustStoreBase({
      document: activated, version: "1.0.0", availableVersions: available,
    }),
    activated,
  );
  assert.throws(
    () => activateRealmWorldTrustStoreBase({
      document: activated, version: "2.0.0", availableVersions: available,
    }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_ALREADY_ACTIVE",
  );
  assert.throws(
    () => activateRealmWorldTrustStoreBase({
      document: inactive, version: "9.9.9", availableVersions: available,
    }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_VERSION_UNSUPPORTED",
  );
  assert.throws(
    () => activateRealmWorldTrustStoreBase({
      document: inactive, version: "latest", availableVersions: available,
    }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_VERSION_INVALID",
  );

  // switch：未激活 → BASE_NOT_ACTIVE；同版本幂等 replay；成功记录 previous。
  assert.throws(
    () => switchRealmWorldTrustStoreBase({
      document: inactive, targetVersion: "2.0.0", availableVersions: available,
    }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_NOT_ACTIVE",
  );
  assert.deepEqual(
    switchRealmWorldTrustStoreBase({
      document: activated, targetVersion: "1.0.0", availableVersions: available,
    }),
    activated,
  );
  const switched = switchRealmWorldTrustStoreBase({
    document: activated, targetVersion: "2.0.0", availableVersions: available,
  });
  assert.equal(switched.base?.activeVersion, "2.0.0");
  assert.equal(switched.base?.previousVersion, "1.0.0");

  // rollback：未激活/无 previous → fail-closed；成功清除 previous；
  // previous 已不可 serve → fail-closed。
  assert.throws(
    () => rollbackRealmWorldTrustStoreBase({ document: inactive, availableVersions: available }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_NOT_ACTIVE",
  );
  assert.throws(
    () => rollbackRealmWorldTrustStoreBase({ document: activated, availableVersions: available }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_ROLLBACK_UNAVAILABLE",
  );
  const rolledBack = rollbackRealmWorldTrustStoreBase({
    document: switched, availableVersions: available,
  });
  assert.equal(rolledBack.base?.activeVersion, "1.0.0");
  assert.equal(rolledBack.base?.previousVersion, undefined);
  assert.throws(
    () => rollbackRealmWorldTrustStoreBase({ document: switched, availableVersions: ["2.0.0"] }),
    (error: unknown) => error instanceof RealmWorldTrustStoreError
      && error.code === "BASE_VERSION_UNSUPPORTED",
  );

  // 活动版本解析：base 段优先于引擎默认。
  assert.equal(resolveEngineBaseActiveVersion(switched), "2.0.0");
});

// ---------------------------------------------------------------------------
// HTTP operator 路由
// ---------------------------------------------------------------------------

async function withRouteEnv(
  storePath: string | null,
  callback: () => Promise<void>,
): Promise<void> {
  const previousStore = process.env.REALM_REALMWORLD_TRUST_STORE;
  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  // 启用门禁（任意 URL 即可；路由不触 DB），验证 operator session 边界。
  process.env.REALM_RUNTIME_DATABASE_URL = "postgres://127.0.0.1:1/realm_gate_probe";
  if (storePath === null) delete process.env.REALM_REALMWORLD_TRUST_STORE;
  else process.env.REALM_REALMWORLD_TRUST_STORE = storePath;
  try {
    await callback();
  } finally {
    if (previousStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
    else process.env.REALM_REALMWORLD_TRUST_STORE = previousStore;
    if (previousRuntimeUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
  }
}

function operatorRequest(
  url: string,
  options: { method?: string; body?: unknown; session?: string | null; idempotencyKey?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey !== null) {
    headers.set("idempotency-key", options.idempotencyKey ?? "op-key-1");
  }
  if (options.session) headers.set("cookie", `realm_session=${options.session}`);
  return new Request(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

test("base provider routes fail closed on missing/incorrect operator session", async () => {
  await withRouteEnv(null, async () => {
    const noSession = await baseProviderStatus(operatorRequest("https://local/api/base-provider/status"));
    assert.equal(noSession.status, 401);
    const badSession = await baseProviderActivate(operatorRequest(
      "https://local/api/base-provider/activate",
      { method: "POST", body: { version: "1.0.0" }, session: "forged.session.value" },
    ));
    assert.equal(badSession.status, 401);
    for (const route of [baseProviderSwitch, baseProviderRollback]) {
      const response = await route(operatorRequest("https://local/api/base-provider/op", {
        method: "POST",
        body: { targetVersion: "1.0.0" },
      }));
      assert.equal(response.status, 401);
    }
  });
});

test("base provider routes: status/activate/switch/rollback lifecycle and no leaks", async () => {
  const root = await mkdtemp(join(tmpdir(), "realm-base-route-"));
  const storePath = join(root, "trust-store.json");
  await writeFile(storePath, JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [TRUST_KEY],
  }));
  const session = sessionProofFor(LOCAL_RECORD_SCOPE.principalId);
  try {
    await withRouteEnv(storePath, async () => {
      // status：引擎默认（未声明 base 段）。
      const status = await baseProviderStatus(operatorRequest(
        "https://local/api/base-provider/status",
        { session },
      ));
      assert.equal(status.status, 200);
      const statusBody = await status.json() as {
        ok: true;
        base: { activeVersion: string; previousVersion: string | null; declared: boolean };
      };
      assert.equal(statusBody.base.activeVersion, ENGINE_BASE_CONTENT_VERSION);
      assert.equal(statusBody.base.declared, false);

      // idempotency-key 必填。
      const noKey = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: "1.0.0" }, session, idempotencyKey: null },
      ));
      assert.equal(noKey.status, 400);
      assert.equal((await noKey.json() as { error: { code: string } }).error.code,
        "INVALID_IDEMPOTENCY_KEY");

      // 非法版本 → 400；不可 serve 版本 → 422。
      const invalid = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: "latest" }, session },
      ));
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code,
        "BASE_VERSION_INVALID");
      const unsupported = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: "9.9.9" }, session },
      ));
      assert.equal(unsupported.status, 422);
      assert.equal((await unsupported.json() as { error: { code: string } }).error.code,
        "BASE_VERSION_UNSUPPORTED");

      // activate 成功 → replay 幂等；异版本 activate → 409；rollback 无目标 → 409。
      const activated = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: ENGINE_BASE_CONTENT_VERSION }, session },
      ));
      assert.equal(activated.status, 200);
      const activatedBody = await activated.json() as {
        replayed: boolean;
        base: { activeVersion: string; declared: boolean };
      };
      assert.equal(activatedBody.replayed, false);
      assert.equal(activatedBody.base.activeVersion, ENGINE_BASE_CONTENT_VERSION);
      assert.equal(activatedBody.base.declared, true);

      const replayed = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: ENGINE_BASE_CONTENT_VERSION }, session },
      ));
      assert.equal(replayed.status, 200);
      assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);

      const rollbackUnavailable = await baseProviderRollback(operatorRequest(
        "https://local/api/base-provider/rollback",
        { method: "POST", session },
      ));
      assert.equal(rollbackUnavailable.status, 409);
      assert.equal(
        (await rollbackUnavailable.json() as { error: { code: string } }).error.code,
        "BASE_ROLLBACK_UNAVAILABLE",
      );

      // switch 到不可 serve 版本 → 422；同版本 switch → 200 replay。
      const switchUnsupported = await baseProviderSwitch(operatorRequest(
        "https://local/api/base-provider/switch",
        { method: "POST", body: { targetVersion: "9.9.9" }, session },
      ));
      assert.equal(switchUnsupported.status, 422);
      const switchReplay = await baseProviderSwitch(operatorRequest(
        "https://local/api/base-provider/switch",
        { method: "POST", body: { targetVersion: ENGINE_BASE_CONTENT_VERSION }, session },
      ));
      assert.equal(switchReplay.status, 200);
      assert.equal((await switchReplay.json() as { replayed: boolean }).replayed, true);

      // 落盘文档实际携带 base 段（下次读取仍生效）。
      const persisted = await readRealmWorldTrustStoreFile(storePath);
      assert.equal(persisted.base?.activeVersion, ENGINE_BASE_CONTENT_VERSION);
      assert.equal(persisted.keys.length, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base provider routes never leak installRoot, store path, or key material", async () => {
  const root = await mkdtemp(join(tmpdir(), "realm-base-route-leak-"));
  const storePath = join(root, "trust-store.json");
  await writeFile(storePath, JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [TRUST_KEY],
  }));
  const session = sessionProofFor(LOCAL_RECORD_SCOPE.principalId);
  try {
    await withRouteEnv(storePath, async () => {
      const responses = [
        await baseProviderStatus(operatorRequest("https://local/api/base-provider/status", { session })),
        await baseProviderActivate(operatorRequest(
          "https://local/api/base-provider/activate",
          { method: "POST", body: { version: ENGINE_BASE_CONTENT_VERSION }, session },
        )),
        await baseProviderSwitch(operatorRequest(
          "https://local/api/base-provider/switch",
          { method: "POST", body: { targetVersion: "9.9.9" }, session },
        )),
        await baseProviderRollback(operatorRequest(
          "https://local/api/base-provider/rollback",
          { method: "POST", session },
        )),
      ];
      for (const response of responses) {
        const text = await response.text();
        assert.ok(!text.includes(storePath), `leaked store path: ${text}`);
        assert.ok(!text.includes(root), `leaked install/store root: ${text}`);
        assert.ok(!text.includes("PUBLIC KEY"), `leaked key material: ${text}`);
        assert.ok(!text.includes("fixture-key"), `leaked keyId: ${text}`);
      }
    });

    // 未配置 store：命令路由 fail-closed 503，status 仍报告引擎默认。
    await withRouteEnv(null, async () => {
      const session2 = sessionProofFor(LOCAL_RECORD_SCOPE.principalId);
      const unavailable = await baseProviderActivate(operatorRequest(
        "https://local/api/base-provider/activate",
        { method: "POST", body: { version: ENGINE_BASE_CONTENT_VERSION }, session: session2 },
      ));
      assert.equal(unavailable.status, 503);
      assert.equal(
        (await unavailable.json() as { error: { code: string } }).error.code,
        "BASE_PROVIDER_UNAVAILABLE",
      );
      const status = await baseProviderStatus(operatorRequest(
        "https://local/api/base-provider/status",
        { session: session2 },
      ));
      assert.equal(status.status, 200);
      const body = await status.json() as { base: { activeVersion: string; declared: boolean } };
      assert.equal(body.base.activeVersion, ENGINE_BASE_CONTENT_VERSION);
      assert.equal(body.base.declared, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base lifecycle mutations persist through the atomic file writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "realm-base-file-"));
  const storePath = join(root, "trust-store.json");
  await writeFile(storePath, JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [TRUST_KEY],
  }));
  try {
    await mutateRealmWorldTrustStoreFile(storePath, (document) =>
      activateRealmWorldTrustStoreBase({
        document, version: "1.0.0", availableVersions: ["1.0.0", "2.0.0"],
      }));
    await mutateRealmWorldTrustStoreFile(storePath, (document) =>
      switchRealmWorldTrustStoreBase({
        document, targetVersion: "2.0.0", availableVersions: ["1.0.0", "2.0.0"],
      }));
    let document = await readRealmWorldTrustStoreFile(storePath);
    assert.equal(document.base?.activeVersion, "2.0.0");
    assert.equal(document.base?.previousVersion, "1.0.0");
    assert.equal(resolveEngineBaseActiveVersion(document), "2.0.0");

    document = await mutateRealmWorldTrustStoreFile(storePath, (current) =>
      rollbackRealmWorldTrustStoreBase({ document: current, availableVersions: ["1.0.0", "2.0.0"] }));
    assert.equal(document.base?.activeVersion, "1.0.0");
    assert.equal(document.base?.previousVersion, undefined);
    // keys 段在 base 变更后原样保留。
    assert.equal(document.keys.length, 1);
    assert.equal(document.keys[0]?.keyId, "fixture-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
