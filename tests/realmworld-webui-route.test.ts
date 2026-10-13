/**
 * GET /worlds/[worldId]/[worldVersion]/ui/[[...path]] 路由契约测试：
 * 真实 ed25519 签名 fixture 经 installRealmWorldDirectory 安装、
 * 文件型 trust-store verifier 挂载。覆盖 positive entry/asset、identity
 * 二次核对、not-installed、missing asset、trust/config negative、
 * unsupported bridge major、无 webui、MIME allowlist 与路径校验。
 * 全程只写 tmpdir，不触共享 realm_dev 或数据库。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  computeRealmWorldContentHash,
  installRealmWorldDirectory,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  serializeRealmWorldManifest,
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import { createRealmWorldSignatureVerifierFromTrustStoreFile } from "../modules/world-transfer/realmworld-trust-store.ts";
import { GET as serveWebUi } from "../app/worlds/[worldId]/[worldVersion]/ui/[[...path]]/route.ts";

const keyA = generateKeyPairSync("ed25519");
const keyB = generateKeyPairSync("ed25519");

function publicPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString().trim();
}

function trustStoreDocument(keyId: string, key: KeyObject): string {
  return `${JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [{ keyId, publicKey: publicPem(key), status: "active" }],
  }, null, 2)}\n`;
}

interface FixtureSpec {
  worldId: string;
  worldVersion: string;
  files: Record<string, string>;
  webui?: { entry: string; bridgeMajor: number };
  signatureKey?: KeyObject;
}

function signedManifest(spec: FixtureSpec, files: Map<string, Uint8Array>): RealmWorldManifestV1 {
  const unsigned: RealmWorldManifestV1 = {
    format: "realmworld",
    formatVersion: 1,
    worldId: spec.worldId,
    worldVersion: spec.worldVersion,
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange: ">=1.0.0 <2.0.0",
    },
    contentHash: computeRealmWorldContentHash(files),
    signature: { algorithm: "ed25519", keyId: "key-a", value: "placeholder" },
    ...(spec.webui ? { webui: spec.webui } : {}),
  };
  const payload = serializeRealmWorldManifestSigningPayload(unsigned);
  const value = sign(null, Buffer.from(payload, "utf8"), spec.signatureKey ?? keyA.privateKey)
    .toString("base64url");
  return { ...unsigned, signature: { ...unsigned.signature, value } };
}

async function writeFixtureSource(root: string, spec: FixtureSpec): Promise<void> {
  const files = new Map<string, Uint8Array>();
  const content: Record<string, string> = {
    "content/index.json": '{"format":"realmworld-content","schemaVersion":1,"modules":["content/world.json"]}',
    "content/world.json": JSON.stringify({
      worldId: spec.worldId,
      title: { en: spec.worldId },
      settings: {},
    }),
    ...spec.files,
  };
  for (const [path, text] of Object.entries(content)) {
    files.set(path, Buffer.from(text, "utf8"));
  }
  const manifest = signedManifest(spec, files);
  await mkdir(root, { recursive: true });
  for (const [path, text] of Object.entries(content)) {
    const destination = join(root, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, text);
  }
  await writeFile(
    join(root, "realmworld-manifest.json"),
    serializeRealmWorldManifest(manifest),
  );
}

const HARBOR: FixtureSpec = {
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  webui: { entry: "ui/index.html", bridgeMajor: 1 },
  files: {
    "ui/index.html": "<!doctype html><title>Harbor</title>",
    "ui/assets/app.js": "console.log('harbor');",
    "ui/style.css": "body { margin: 0; }",
    "ui/notes.txt": "internal notes",
  },
};

const BRIDGE_NEXT: FixtureSpec = {
  worldId: "world-bridge-next",
  worldVersion: "1.0.0",
  webui: { entry: "ui/index.html", bridgeMajor: 2 },
  files: { "ui/index.html": "<!doctype html><title>Next</title>" },
};

const NO_WEBUI: FixtureSpec = {
  worldId: "world-quiet",
  worldVersion: "1.0.0",
  files: {},
};

interface Harness {
  root: string;
  installRoot: string;
  trustStorePath: string;
}

async function setupHarness(t: TestContext, key: KeyObject = keyA.publicKey): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "realmworld-webui-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const trustStorePath = join(root, "trust-store.json");
  await writeFile(trustStorePath, trustStoreDocument("key-a", key), { mode: 0o600 });
  const verifier = createRealmWorldSignatureVerifierFromTrustStoreFile({ path: trustStorePath });
  for (const spec of [HARBOR, BRIDGE_NEXT, NO_WEBUI]) {
    const source = join(root, "source", spec.worldId);
    await writeFixtureSource(source, spec);
    await installRealmWorldDirectory({ sourceDir: source, installRoot, verifySignature: verifier });
  }
  return { root, installRoot, trustStorePath };
}

async function withEnv<T>(harness: Harness, run: () => Promise<T>): Promise<T> {
  const savedInstall = process.env.REALM_REALMWORLD_INSTALL_ROOT;
  const savedTrust = process.env.REALM_REALMWORLD_TRUST_STORE;
  const savedRuntimeDb = process.env.REALM_RUNTIME_DATABASE_URL;
  process.env.REALM_REALMWORLD_INSTALL_ROOT = harness.installRoot;
  process.env.REALM_REALMWORLD_TRUST_STORE = harness.trustStorePath;
  // 关闭 access gate，回落本地单用户 principal，保持路由测试无 DB。
  delete process.env.REALM_RUNTIME_DATABASE_URL;
  try {
    return await run();
  } finally {
    if (savedInstall === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
    else process.env.REALM_REALMWORLD_INSTALL_ROOT = savedInstall;
    if (savedTrust === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
    else process.env.REALM_REALMWORLD_TRUST_STORE = savedTrust;
    if (savedRuntimeDb === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = savedRuntimeDb;
  }
}

function call(
  worldId: string,
  worldVersion: string,
  path?: string[],
): Promise<Response> {
  return serveWebUi(
    new Request(`http://127.0.0.1/worlds/${worldId}/${worldVersion}/ui/`),
    { params: Promise.resolve({ worldId, worldVersion, path }) },
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { ok: false; error: { code: string } };
  assert.equal(body.ok, false);
  return body.error.code;
}

test("webui route: 默认 entry 返回已验证 bytes 与稳定安全头", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const response = await call("world-harbor", "1.2.0");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(await response.text(), "<!doctype html><title>Harbor</title>");

    const emptyPath = await call("world-harbor", "1.2.0", []);
    assert.equal(emptyPath.status, 200);
    assert.equal(await emptyPath.text(), "<!doctype html><title>Harbor</title>");
  });
});

test("webui route: 合法嵌套 asset 按 MIME allowlist 返回", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const js = await call("world-harbor", "1.2.0", ["assets", "app.js"]);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("Content-Type"), "text/javascript; charset=utf-8");
    assert.equal(await js.text(), "console.log('harbor');");
    const css = await call("world-harbor", "1.2.0", ["style.css"]);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("Content-Type"), "text/css; charset=utf-8");
  });
});

test("webui route: manifest identity 与请求 binding 不一致 → 409 fail-closed", async (t) => {
  const harness = await setupHarness(t);
  // 复制已安装目录到另一 version 身份：签名仍有效，但 manifest 声明不符。
  await cp(
    join(harness.installRoot, "world-harbor", "1.2.0"),
    join(harness.installRoot, "world-harbor", "9.9.9"),
    { recursive: true },
  );
  await withEnv(harness, async () => {
    const response = await call("world-harbor", "9.9.9");
    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), "REALMWORLD_IDENTITY_MISMATCH");
  });
});

test("webui route: 未安装 / 缺失 asset / 无 webui 的稳定 404", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const missing = await call("world-ghost", "1.0.0");
    assert.equal(missing.status, 404);
    assert.equal(await errorCode(missing), "REALMWORLD_NOT_INSTALLED");

    const noAsset = await call("world-harbor", "1.2.0", ["missing.js"]);
    assert.equal(noAsset.status, 404);
    assert.equal(await errorCode(noAsset), "WEBUI_ASSET_NOT_FOUND");

    const quiet = await call("world-quiet", "1.0.0");
    assert.equal(quiet.status, 404);
    assert.equal(await errorCode(quiet), "WEBUI_NOT_DECLARED");
  });
});

test("webui route: traversal 与非法 identity → 400，且不泄露细节", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const traversal = await call("world-harbor", "1.2.0", ["assets", "..", "..", "content", "world.json"]);
    assert.equal(traversal.status, 400);
    assert.equal(await errorCode(traversal), "INVALID_REQUEST");

    const encoded = await call("world-harbor", "1.2.0", ["%2e%2e"]);
    assert.equal(encoded.status, 400);

    const backslash = await call("world-harbor", "1.2.0", ["assets\\app.js"]);
    assert.equal(backslash.status, 400);

    const badIdentity = await call("..", "1.2.0");
    assert.equal(badIdentity.status, 400);
    const body = JSON.stringify(await badIdentity.json());
    assert.ok(!body.includes(harness.installRoot));
  });
});

test("webui route: unsupported bridge major → 501 fail-closed", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const response = await call("world-bridge-next", "1.0.0");
    assert.equal(response.status, 501);
    assert.equal(await errorCode(response), "WEBUI_BRIDGE_UNSUPPORTED");
  });
});

test("webui route: 非 allowlist 扩展名 → 415", async (t) => {
  const harness = await setupHarness(t);
  await withEnv(harness, async () => {
    const response = await call("world-harbor", "1.2.0", ["notes.txt"]);
    assert.equal(response.status, 415);
    assert.equal(await errorCode(response), "WEBUI_MEDIA_TYPE_NOT_ALLOWED");
  });
});

test("webui route: 缺 trust-store/install 配置 → 503 fail-closed", async (t) => {
  const harness = await setupHarness(t);
  const savedInstall = process.env.REALM_REALMWORLD_INSTALL_ROOT;
  const savedTrust = process.env.REALM_REALMWORLD_TRUST_STORE;
  const savedRuntimeDb = process.env.REALM_RUNTIME_DATABASE_URL;
  delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
  delete process.env.REALM_REALMWORLD_TRUST_STORE;
  delete process.env.REALM_RUNTIME_DATABASE_URL;
  try {
    const response = await call("world-harbor", "1.2.0");
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), "REALMWORLD_CONTENT_UNAVAILABLE");
  } finally {
    if (savedInstall !== undefined) process.env.REALM_REALMWORLD_INSTALL_ROOT = savedInstall;
    if (savedTrust !== undefined) process.env.REALM_REALMWORLD_TRUST_STORE = savedTrust;
    if (savedRuntimeDb !== undefined) process.env.REALM_RUNTIME_DATABASE_URL = savedRuntimeDb;
  }
  assert.ok(harness.root.length > 0);
});

test("webui route: 签名不被 trust-store 信任 → 503，不回显签名/路径细节", async (t) => {
  // 安装时用 key-a 信任，请求前轮换为只信 key-b → 验签失败 fail-closed。
  const harness = await setupHarness(t);
  await writeFile(harness.trustStorePath, trustStoreDocument("key-b", keyB.publicKey), { mode: 0o600 });
  await withEnv(harness, async () => {
    const response = await call("world-harbor", "1.2.0");
    assert.equal(response.status, 503);
    const body = await response.json() as { ok: false; error: { code: string; message?: string } };
    assert.equal(body.error.code, "REALMWORLD_CONTENT_UNAVAILABLE");
    const text = JSON.stringify(body);
    assert.ok(!text.includes(harness.installRoot));
    assert.ok(!text.includes("key-a"));
    assert.ok(!text.includes("signature"));
  });
});
