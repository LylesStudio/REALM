/**
 * RealmWorld WebUI Bridge 纯解析边界矩阵：
 * 默认 entry、合法嵌套 asset、unknown/traversal/反斜杠/空段、无 webui、
 * unsupported bridge major、entry 缺失 fail-closed。全程不触文件系统，
 * 错误只携带稳定 machine code，不泄露路径或 manifest 私密内容。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedRealmWorldDirectory } from "../modules/world-transfer/realmworld-loader.ts";
import type { RealmWorldManifestV1 } from "../modules/world-transfer/realmworld-manifest.ts";
import {
  REALMWORLD_WEBUI_BRIDGE_MAJOR,
  resolveRealmWorldWebUiAsset,
  RealmWorldWebUiBridgeError,
} from "../modules/world-transfer/realmworld-webui-bridge.ts";

type Snapshot = Pick<LoadedRealmWorldDirectory, "manifest" | "files">;

function manifestWithWebUi(webui?: RealmWorldManifestV1["webui"]): RealmWorldManifestV1 {
  return {
    format: "realmworld",
    formatVersion: 1,
    worldId: "world-harbor",
    worldVersion: "1.2.0",
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
    },
    contentHash: "a".repeat(64),
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "unused" },
    ...(webui ? { webui } : {}),
  };
}

function snapshot(options: {
  webui?: RealmWorldManifestV1["webui"] | null;
  files?: Record<string, string>;
} = {}): Snapshot {
  const files = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(options.files ?? {
    "ui/index.html": "<!doctype html><title>Harbor</title>",
    "ui/assets/app.js": "console.log('harbor');",
    "ui/style.css": "body { margin: 0; }",
  })) {
    files.set(path, Buffer.from(text, "utf8"));
  }
  return {
    manifest: manifestWithWebUi(
      !("webui" in options)
        ? { entry: "ui/index.html", bridgeMajor: 1 }
        : (options.webui ?? undefined),
    ),
    files,
  };
}

function bridgeError(error: unknown, code: string): boolean {
  return error instanceof RealmWorldWebUiBridgeError && error.code === code;
}

test("bridge boundary: 单一常量 bridge major = 1", () => {
  assert.equal(REALMWORLD_WEBUI_BRIDGE_MAJOR, 1);
});

test("bridge boundary: 空请求路径落到 manifest.webui.entry", () => {
  const resolved = resolveRealmWorldWebUiAsset(snapshot(), []);
  assert.equal(resolved.path, "ui/index.html");
  assert.equal(Buffer.from(resolved.bytes).toString("utf8"), "<!doctype html><title>Harbor</title>");
  assert.equal(resolved.bridgeMajor, 1);
  const resolvedDefault = resolveRealmWorldWebUiAsset(snapshot());
  assert.equal(resolvedDefault.path, "ui/index.html");
});

test("bridge boundary: 合法 ui/ 相对嵌套 asset 解析", () => {
  const js = resolveRealmWorldWebUiAsset(snapshot(), ["assets", "app.js"]);
  assert.equal(js.path, "ui/assets/app.js");
  assert.equal(Buffer.from(js.bytes).toString("utf8"), "console.log('harbor');");
  const css = resolveRealmWorldWebUiAsset(snapshot(), ["style.css"]);
  assert.equal(css.path, "ui/style.css");
});

test("bridge boundary: 未声明的 asset 一律 NOT_FOUND", () => {
  assert.throws(
    () => resolveRealmWorldWebUiAsset(snapshot(), ["missing.js"]),
    (error: unknown) => bridgeError(error, "NOT_FOUND"),
  );
  assert.throws(
    () => resolveRealmWorldWebUiAsset(snapshot(), ["assets", "missing.js"]),
    (error: unknown) => bridgeError(error, "NOT_FOUND"),
  );
});

test("bridge boundary: traversal、反斜杠、空段与编码绕过头一律 INVALID_PATH", () => {
  const malicious: readonly (readonly string[])[] = [
    [".."],
    ["assets", "..", "..", "content", "world.json"],
    ["%2e%2e"],
    ["%2E%2E%2Fcontent%2Fworld.json"],
    ["..%2fcontent%2fworld.json"],
    ["assets\\app.js"],
    ["assets", ""],
    [""],
    ["."],
    ["a b.js"],
    ["content/world.json"],
  ];
  for (const segments of malicious) {
    assert.throws(
      () => resolveRealmWorldWebUiAsset(snapshot(), segments),
      (error: unknown) => bridgeError(error, "INVALID_PATH"),
      `segments ${JSON.stringify(segments)} must be rejected`,
    );
  }
});

test("bridge boundary: 段数与长度有界 fail-closed", () => {
  assert.throws(
    () => resolveRealmWorldWebUiAsset(snapshot(), Array.from({ length: 17 }, () => "a")),
    (error: unknown) => bridgeError(error, "INVALID_PATH"),
  );
  assert.throws(
    () => resolveRealmWorldWebUiAsset(snapshot(), ["a".repeat(257)]),
    (error: unknown) => bridgeError(error, "INVALID_PATH"),
  );
});

test("bridge boundary: 无 webui 的 RealmWorld 一律 NO_WEBUI", () => {
  const without = snapshot({ webui: null, files: {} });
  assert.throws(
    () => resolveRealmWorldWebUiAsset(without, []),
    (error: unknown) => bridgeError(error, "NO_WEBUI"),
  );
  assert.throws(
    () => resolveRealmWorldWebUiAsset(without, ["index.html"]),
    (error: unknown) => bridgeError(error, "NO_WEBUI"),
  );
});

test("bridge boundary: unsupported bridge major 先于任何 asset 拒绝", () => {
  const future = snapshot({
    webui: { entry: "ui/index.html", bridgeMajor: 2 },
  });
  assert.throws(
    () => resolveRealmWorldWebUiAsset(future, []),
    (error: unknown) => bridgeError(error, "UNSUPPORTED_BRIDGE_MAJOR"),
  );
  assert.throws(
    () => resolveRealmWorldWebUiAsset(future, ["assets", "app.js"]),
    (error: unknown) => bridgeError(error, "UNSUPPORTED_BRIDGE_MAJOR"),
  );
});

test("bridge boundary: entry 缺失于已验证快照时 fail-closed NOT_FOUND", () => {
  const broken = snapshot({ files: { "ui/style.css": "body{}" } });
  assert.throws(
    () => resolveRealmWorldWebUiAsset(broken, []),
    (error: unknown) => bridgeError(error, "NOT_FOUND"),
  );
});

test("bridge boundary: 错误不泄露路径、installRoot 或签名细节", () => {
  try {
    resolveRealmWorldWebUiAsset(snapshot(), [".."]);
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof RealmWorldWebUiBridgeError);
    assert.equal(error.message, "WebUI asset path is invalid");
    assert.ok(!error.message.includes(".."));
    assert.ok(!error.message.includes("/"));
  }
  try {
    resolveRealmWorldWebUiAsset(snapshot(), ["missing.js"]);
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof RealmWorldWebUiBridgeError);
    assert.ok(!error.message.includes("missing.js"));
  }
});
