/**
 * RealmWorld Phase 1A：`realm-save` v1 存档 manifest 契约测试。
 * 覆盖：base/world-bound 正常解析、稳定序列化、未知字段/错误类型 fail-closed、
 * 版本差异 warning（非硬失败）、缺 World 错误分类、WorldBinding 映射、
 * 本地哨兵版本锁定。纯函数，无数据库。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_WORLD_VERSION,
  REALM_SAVE_ENGINE_API,
  RealmSaveError,
  assessRealmSaveWorld,
  parseRealmSaveManifest,
  realmSaveManifestFromBinding,
  serializeRealmSaveManifest,
  worldBindingFromManifest,
  worldBindingFromWorldIdentity,
  type RealmSaveManifestV1,
} from "../modules/world-transfer/realm-save.ts";

const baseManifest: RealmSaveManifestV1 = {
  format: "realm-save",
  formatVersion: 1,
  mode: "base",
  engineApi: "1.x",
  world: null,
};

const worldBoundManifest: RealmSaveManifestV1 = {
  format: "realm-save",
  formatVersion: 1,
  mode: "world-bound",
  engineApi: "1.x",
  world: { worldId: "realmworld_idol", worldVersion: "1.4.0" },
};

test("serializes manifests to stable byte-exact JSON", () => {
  assert.equal(
    serializeRealmSaveManifest(baseManifest),
    '{"format":"realm-save","formatVersion":1,"mode":"base","engineApi":"1.x","world":null}',
  );
  assert.equal(
    serializeRealmSaveManifest(worldBoundManifest),
    '{"format":"realm-save","formatVersion":1,"mode":"world-bound","engineApi":"1.x",'
      + '"world":{"worldId":"realmworld_idol","worldVersion":"1.4.0"}}',
  );
  // 解析→再序列化字节一致（键序冻结）。
  for (const manifest of [baseManifest, worldBoundManifest]) {
    const once = serializeRealmSaveManifest(manifest);
    assert.equal(serializeRealmSaveManifest(parseRealmSaveManifest(once)), once);
  }
});

test("parses base and world-bound manifests and maps WorldBinding", () => {
  assert.deepEqual(parseRealmSaveManifest(serializeRealmSaveManifest(baseManifest)), baseManifest);
  assert.deepEqual(
    parseRealmSaveManifest(serializeRealmSaveManifest(worldBoundManifest)),
    worldBoundManifest,
  );
  // Uint8Array 输入等价。
  const bytes = new TextEncoder().encode(serializeRealmSaveManifest(worldBoundManifest));
  assert.deepEqual(parseRealmSaveManifest(bytes), worldBoundManifest);

  assert.deepEqual(worldBindingFromManifest(baseManifest), { kind: "base" });
  assert.deepEqual(worldBindingFromManifest(worldBoundManifest), {
    kind: "world",
    worldId: "realmworld_idol",
    worldVersion: "1.4.0",
  });
  assert.deepEqual(realmSaveManifestFromBinding({ kind: "base" }), baseManifest);
  assert.deepEqual(
    realmSaveManifestFromBinding({
      kind: "world",
      worldId: "realmworld_idol",
      worldVersion: "1.4.0",
    }),
    worldBoundManifest,
  );
});

test("locks the deterministic local sentinel version and engine api", () => {
  assert.equal(LOCAL_WORLD_VERSION, "0.0.0-local");
  assert.equal(REALM_SAVE_ENGINE_API, "1.x");
});

test("maps database world identity to WorldBinding fail-closed", () => {
  // 本地哨兵版本 → base；worldId 不参与绑定（绝不把 base 偷绑到某个 worldId）。
  assert.deepEqual(
    worldBindingFromWorldIdentity({
      worldId: "world_ember_coast",
      worldVersion: LOCAL_WORLD_VERSION,
    }),
    { kind: "base" },
  );
  // 真实版本 → world-bound，逐字段透传。
  assert.deepEqual(
    worldBindingFromWorldIdentity({
      worldId: "realmworld_idol",
      worldVersion: "1.4.0",
    }),
    { kind: "world", worldId: "realmworld_idol", worldVersion: "1.4.0" },
  );
  // 非法身份一律拒绝——证明不会静默降级为 base。
  const invalid: ReadonlyArray<{ worldId: unknown; worldVersion: unknown }> = [
    { worldId: "", worldVersion: "1.4.0" },
    { worldId: "   ", worldVersion: "1.4.0" },
    { worldId: " realmworld_idol ", worldVersion: "1.4.0" },
    { worldId: "realmworld_idol", worldVersion: "" },
    { worldId: "realmworld_idol", worldVersion: "   " },
    { worldId: "realmworld_idol", worldVersion: " 1.4.0 " },
    { worldId: null, worldVersion: "1.4.0" },
    { worldId: "realmworld_idol", worldVersion: null },
    { worldId: 42, worldVersion: "1.4.0" },
    { worldId: "realmworld_idol", worldVersion: 1.4 },
  ];
  for (const identity of invalid) {
    assert.throws(
      () => worldBindingFromWorldIdentity(identity),
      (error: unknown) =>
        error instanceof RealmSaveError && error.code === "INVALID_SAVE",
      `must reject ${JSON.stringify(identity)}`,
    );
  }
});

test("rejects malformed saves fail-closed", () => {
  const worldBoundJson = serializeRealmSaveManifest(worldBoundManifest);
  const cases: ReadonlyArray<{
    name: string;
    input: string;
    code: "INVALID_SAVE" | "UNSUPPORTED_FORMAT_VERSION";
  }> = [
    {
      name: "unknown top-level key",
      input: worldBoundJson.replace(
        '"engineApi":"1.x"',
        '"engineApi":"1.x","note":"surprise"',
      ),
      code: "INVALID_SAVE",
    },
    {
      name: "unknown nested world key",
      input: worldBoundJson.replace(
        '"worldVersion":"1.4.0"',
        '"worldVersion":"1.4.0","extra":true',
      ),
      code: "INVALID_SAVE",
    },
    {
      name: "wrong format identifier",
      input: worldBoundJson.replace('"realm-save"', '"realm-pack"'),
      code: "INVALID_SAVE",
    },
    {
      name: "newer format version",
      input: worldBoundJson.replace('"formatVersion":1', '"formatVersion":2'),
      code: "UNSUPPORTED_FORMAT_VERSION",
    },
    {
      name: "format version of wrong type",
      input: worldBoundJson.replace('"formatVersion":1', '"formatVersion":"1"'),
      code: "INVALID_SAVE",
    },
    {
      name: "unsupported lower format version",
      input: worldBoundJson.replace('"formatVersion":1', '"formatVersion":0'),
      code: "INVALID_SAVE",
    },
    {
      name: "illegal mode",
      input: worldBoundJson.replace('"world-bound"', '"sandbox"'),
      code: "INVALID_SAVE",
    },
    {
      name: "engine api beyond supported major",
      input: worldBoundJson.replace('"engineApi":"1.x"', '"engineApi":"2.x"'),
      code: "INVALID_SAVE",
    },
    {
      name: "engine api of wrong type",
      input: worldBoundJson.replace('"engineApi":"1.x"', '"engineApi":1'),
      code: "INVALID_SAVE",
    },
    {
      name: "base mode carrying a world ref",
      input:
        '{"format":"realm-save","formatVersion":1,"mode":"base","engineApi":"1.x",'
        + '"world":{"worldId":"realmworld_idol","worldVersion":"1.4.0"}}',
      code: "INVALID_SAVE",
    },
    {
      name: "world-bound mode without world ref",
      input:
        '{"format":"realm-save","formatVersion":1,"mode":"world-bound","engineApi":"1.x","world":null}',
      code: "INVALID_SAVE",
    },
    {
      name: "empty worldId",
      input: worldBoundJson.replace('"realmworld_idol"', '""'),
      code: "INVALID_SAVE",
    },
    {
      name: "whitespace-only worldVersion",
      input: worldBoundJson.replace('"1.4.0"', '"   "'),
      code: "INVALID_SAVE",
    },
    {
      name: "padded worldId",
      input: worldBoundJson.replace('"realmworld_idol"', '" realmworld_idol "'),
      code: "INVALID_SAVE",
    },
    {
      name: "world ref of wrong shape",
      input: worldBoundJson.replace(
        '{"worldId":"realmworld_idol","worldVersion":"1.4.0"}',
        '[]',
      ),
      code: "INVALID_SAVE",
    },
    { name: "not JSON", input: "not a save", code: "INVALID_SAVE" },
    { name: "top-level array", input: "[]", code: "INVALID_SAVE" },
  ];
  for (const { name, input, code } of cases) {
    assert.throws(
      () => parseRealmSaveManifest(input),
      (error: unknown) =>
        error instanceof RealmSaveError && error.code === code,
      name,
    );
  }
});

test("assesses installed worlds: ok / version warning / missing-world error", () => {
  // base 存档不触碰 World 解析。
  assert.deepEqual(assessRealmSaveWorld(baseManifest, () => null), { kind: "base" });

  const ok = assessRealmSaveWorld(worldBoundManifest, () => "1.4.0");
  assert.deepEqual(ok, {
    kind: "ok",
    worldId: "realmworld_idol",
    worldVersion: "1.4.0",
  });

  // 同一 worldId、版本不同：可读取的风险提示，不是硬失败。
  const warning = assessRealmSaveWorld(worldBoundManifest, () => "1.5.0");
  assert.deepEqual(warning, {
    kind: "warning",
    code: "WORLD_VERSION_MISMATCH",
    worldId: "realmworld_idol",
    requiredVersion: "1.4.0",
    installedVersion: "1.5.0",
  });
  assert.notEqual(warning.kind, "error");

  // 缺 World：明确错误分类，绝不静默降级为 base。
  const missing = assessRealmSaveWorld(worldBoundManifest, () => null);
  assert.deepEqual(missing, {
    kind: "error",
    code: "WORLD_NOT_INSTALLED",
    worldId: "realmworld_idol",
  });
  assert.notEqual(missing.kind, "base");
});
