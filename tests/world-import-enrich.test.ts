/**
 * RealmWorld Phase 1A：旧 `.realm` v1 行快照包的 world identity 兼容测试。
 * 0054 之前导出的包 worlds 行没有 worldVersion 键；导入侧 enrich 必须按
 * 0054 的同一确定性哨兵回填（bootstrap 键集等值才能通过），而已携带
 * worldVersion 的新包必须原样保留。纯函数驱动 enrichPack，无数据库。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  utf8,
  tableWireDigest,
  type PackColumnSpec,
  type RealmManifest,
  type ValidatedPack,
} from "../modules/world-transfer/realm-pack.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import { enrichPack } from "../modules/application/world-import-service.ts";
import { declaredSemanticEventsFromWorldSettings } from "../modules/world-transfer/semantic-events.ts";

/** 目标库为 0054 之后形态（含 world_version 列）。 */
const WORLDS_COLUMNS: readonly PackColumnSpec[] = [
  { name: "workspace_id", type: "text" },
  { name: "id", type: "text" },
  { name: "name", type: "text" },
  { name: "status", type: "text" },
  { name: "calendar_id", type: "text" },
  { name: "summary", type: "text" },
  { name: "settings", type: "jsonb" },
  { name: "created_at", type: "timestamptz" },
  { name: "updated_at", type: "timestamptz" },
  { name: "world_version", type: "text" },
];

const LEGACY_WORLDS_COLUMNS: readonly PackColumnSpec[] =
  WORLDS_COLUMNS.filter((column) => column.name !== "world_version");

function manifestForWorlds(): RealmManifest {
  return {
    format: "realm-pack",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    exporter: {
      app: "realm",
      appVersion: "test",
      schemaLatest: "0053_membership_capability.sql",
    },
    source: { worldId: "world_src", worldName: "源世界" },
    scope: {
      kind: "full",
      storyIds: null,
      recordIds: null,
      includeLinked: false,
      includeMemberships: false,
      completeness: "complete",
    },
    requiresMigrations: [],
    tables: [{ name: "worlds", rows: 1, sha256: "0".repeat(64) }],
    files: [],
    redactions: [],
    principalPolicy: "preserve-attribution",
    contentHash: "0".repeat(64),
  };
}

function packWithWorldsRow(row: Record<string, unknown>): ValidatedPack {
  return {
    manifest: manifestForWorlds(),
    tables: new Map([["worlds", utf8(`${JSON.stringify(row)}\n`)]]),
    files: new Map(),
  };
}

const baseRow = {
  workspaceId: "ws_demo",
  id: "world_src",
  name: "源世界",
  status: "active",
  calendarId: "native_calendar",
  summary: "",
  settings: {},
  createdAt: "2026-01-01T00:00:00.000000Z",
  updatedAt: "2026-01-01T00:00:00.000000Z",
};

const enrichOptions = {
  workspaceId: "ws_demo",
  copyKey: "",
  importerPrincipal: "principal_importer",
};

test("legacy pack without worldVersion is enriched with the deterministic sentinel", () => {
  const enrichment = enrichPack(
    packWithWorldsRow(baseRow),
    new Map([["worlds", WORLDS_COLUMNS]]),
    enrichOptions,
  );
  const worldRows = enrichment.tables.get("worlds");
  assert.ok(worldRows && worldRows.length === 1);
  assert.equal(worldRows[0]?.["world_version"], LOCAL_WORLD_VERSION);
});

test("legacy pack remains importable into a pre-0054 target without an unknown key", () => {
  const enrichment = enrichPack(
    packWithWorldsRow(baseRow),
    new Map([["worlds", LEGACY_WORLDS_COLUMNS]]),
    enrichOptions,
  );
  const worldRows = enrichment.tables.get("worlds");
  assert.ok(worldRows && worldRows.length === 1);
  assert.equal(worldRows[0]?.world_version, undefined);
});

test("world identity pack fails closed against a pre-0054 target", () => {
  assert.throws(
    () => enrichPack(
      packWithWorldsRow({ ...baseRow, worldVersion: "1.4.0" }),
      new Map([["worlds", LEGACY_WORLDS_COLUMNS]]),
      enrichOptions,
    ),
    /world identity requires migration 0054/,
  );
});

test("pack already carrying worldVersion keeps it untouched", () => {
  const enrichment = enrichPack(
    packWithWorldsRow({ ...baseRow, worldVersion: "1.4.0" }),
    new Map([["worlds", WORLDS_COLUMNS]]),
    enrichOptions,
  );
  const worldRows = enrichment.tables.get("worlds");
  assert.ok(worldRows && worldRows.length === 1);
  assert.equal(worldRows[0]?.["world_version"], "1.4.0");
});

for (const copyKey of ["", "a1-copy"]) {
  const mode = copyKey ? "copy" : "preserve";
  test(`A1 ${mode}: unsigned declaration metadata is removed before encoding without changing source bytes`, () => {
    const settings = {
      style: "modern",
      language: "ja",
      declaredEvents: ["example.completed"],
      custom: { declaredEvents: ["descriptive.only"], note: "ordinary user data" },
    };
    const pack = packWithWorldsRow({ ...baseRow, settings, worldVersion: "1.4.0" });
    const originalBytes = Buffer.from(pack.tables.get("worlds")!);
    const enrichment = enrichPack(pack, new Map([["worlds", WORLDS_COLUMNS]]), {
      ...enrichOptions, copyKey,
    });
    const row = enrichment.tables.get("worlds")![0]!;
    const imported = JSON.parse(row.settings as string) as Record<string, unknown>;
    assert.equal(Object.hasOwn(imported, "declaredEvents"), false);
    assert.deepEqual(imported, {
      style: "modern", language: "ja", custom: settings.custom,
    });
    assert.equal(declaredSemanticEventsFromWorldSettings(imported).size, 0);
    assert.equal(enrichment.worldDeclarationMetadataRedacted, true);
    assert.equal(row.world_version, "1.4.0");
    const wire = enrichment.transferEntries.find((entry) => entry.name === "worlds")!.wireDigest;
    assert.equal(wire, tableWireDigest([row]));
    assert.notEqual(wire, tableWireDigest([{ ...row, settings: JSON.stringify(settings) }]));
    assert.deepEqual(Buffer.from(pack.tables.get("worlds")!), originalBytes);
    assert.deepEqual(settings.declaredEvents, ["example.completed"]);
    // Replaying enrichment must not produce a different ledger entry.
    const repeated = enrichPack(pack, new Map([["worlds", WORLDS_COLUMNS]]), {
      ...enrichOptions, copyKey,
    });
    assert.deepEqual(repeated.transferEntries, enrichment.transferEntries);
  });

  for (const declaration of [[], null, "not-a-declaration-list", { malformed: true }]) {
    test(`A1 ${mode}: reserved declaration key is removed for ${JSON.stringify(declaration)}`, () => {
      const enrichment = enrichPack(
        packWithWorldsRow({ ...baseRow, settings: { style: "anime", declaredEvents: declaration } }),
        new Map([["worlds", WORLDS_COLUMNS]]),
        { ...enrichOptions, copyKey },
      );
      assert.deepEqual(JSON.parse(enrichment.tables.get("worlds")![0]!.settings as string), { style: "anime" });
      assert.equal(enrichment.worldDeclarationMetadataRedacted, true);
    });
  }

  test(`A1 ${mode}: ordinary backup settings are preserved with no false redaction`, () => {
    const settings = { style: "classical", language: "zh-CN", custom: { arbitrary: [1, 2, 3] } };
    const enrichment = enrichPack(
      packWithWorldsRow({ ...baseRow, settings }),
      new Map([["worlds", WORLDS_COLUMNS]]),
      { ...enrichOptions, copyKey },
    );
    assert.deepEqual(JSON.parse(enrichment.tables.get("worlds")![0]!.settings as string), settings);
    assert.equal(enrichment.worldDeclarationMetadataRedacted, false);
  });
}
