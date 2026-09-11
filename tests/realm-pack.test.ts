/**
 * v37 Y0：realm-pack 库测试——G.5 冻结九向量逐值相等、双 codec
 * round-trip、字节确定性、G.3 恶意包矩阵逐项、multipart 边界矩阵、
 * export-matrix 围栏（61 表 diff / text[] 清单 === 8 / scope 23/36/41）。
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  RealmPackError,
  buildRealmPack,
  canonicalRow,
  canonicalScope,
  codePointLength,
  computeContentHash,
  contentDigest,
  formatTimestamptz,
  packRowToInsertRow,
  parseManifest,
  parseMultipartBounded,
  rowDigest,
  scopeDigest,
  serializeManifest,
  serializePackRow,
  sha256Hex,
  tableWireDigest,
  transferEntriesSha256,
  utf8,
  validateRealmPack,
  type PackColumnSpec,
  type RealmManifest,
} from "../modules/world-transfer/realm-pack.ts";
import {
  EXPORT_MATRIX,
  PACK_TABLE_ORDER,
  SCOPE_IMPORTABLE,
  TEXT_ARRAY_NON_NULL_COLUMNS,
} from "../modules/world-transfer/export-matrix.ts";

function manifestFromFixed(fixedJson: string): RealmManifest {
  return parseManifest(utf8(fixedJson));
}

// ---------------------------------------------------------------------------
// G.5 向量 1/2：canonicalScope / scopeDigest
// ---------------------------------------------------------------------------

test("vector 1: scopeDigest full empty selection", () => {
  const canonical = canonicalScope({
    kind: "full",
    storyIds: null,
    recordIds: null,
    includeLinked: false,
    includeMemberships: false,
    completeness: "complete",
  });
  assert.equal(
    canonical,
    '{"kind":"full","storyIds":null,"recordIds":null,"includeLinked":false,"includeMemberships":false,"completeness":"complete"}',
  );
  assert.equal(
    scopeDigest({
      kind: "full",
      storyIds: null,
      recordIds: null,
      includeLinked: false,
      includeMemberships: false,
      completeness: "complete",
    }),
    "e3acd72e06e0adb0d88f92866a527365ad229192ab58d71e12a8543e8076e172",
  );
});

test("vector 2: scopeDigest selection with unsorted input sorted", () => {
  const canonical = canonicalScope({
    kind: "archive",
    storyIds: ["story_b", "story_a"],
    recordIds: ["record_x"],
    includeLinked: true,
    includeMemberships: false,
    completeness: "partial",
  });
  assert.equal(
    canonical,
    '{"kind":"archive","storyIds":["story_a","story_b"],"recordIds":["record_x"],"includeLinked":true,"includeMemberships":false,"completeness":"partial"}',
  );
  assert.equal(
    scopeDigest({
      kind: "archive",
      storyIds: ["story_b", "story_a"],
      recordIds: ["record_x"],
      includeLinked: true,
      includeMemberships: false,
      completeness: "partial",
    }),
    "a4a587bbccaafacb6ff58da8624f49989db06a983504e485b5182ac29db7393a",
  );
});

// ---------------------------------------------------------------------------
// G.5 向量 3：logicalPackHash 最小包 + 非 ASCII + file 条目
// ---------------------------------------------------------------------------

test("vector 3: contentHash minimal pack with non-ASCII and file entry", () => {
  const worldsBytes = utf8('{"id":"world_demo","name":"灯塔"}\n');
  assert.equal(
    sha256Hex(worldsBytes),
    "2511cf6b11c2e49068c60681749777f6cf8a4ad41c49f8cdae092c62a09e20fa",
  );
  const fileBytes = utf8("PNG-PROBE");
  assert.equal(fileBytes.length, 9);
  assert.equal(
    sha256Hex(fileBytes),
    "8d696c78dd03ffd11f562351c4ad81f0683f3bc65ee413c76ae8f9158e7fa515",
  );
  const contentHash = computeContentHash(
    [{ name: "worlds", rows: 1, bytes: worldsBytes }],
    [{ id: "file_0000000000000000ab", bytes: fileBytes }],
  );
  assert.equal(
    contentHash,
    "214d46c97343b622859ebd485ebf3609c411dca9bbe979e326c8a8dfc8d4071d",
  );
});

// ---------------------------------------------------------------------------
// G.5 向量 4：world_files 行 + manifest 固定字节
// ---------------------------------------------------------------------------

const V4_MANIFEST = '{"format":"realm-pack","version":1,"createdAt":"2026-01-02T03:04:05.000Z","exporter":{"app":"realm","appVersion":"0.1.0","schemaLatest":"0043_propagation_node_audience_archived_guard.sql"},"source":{"worldId":"world_demo","worldName":"灯塔"},"scope":{"kind":"full","storyIds":null,"recordIds":null,"includeLinked":false,"includeMemberships":false,"completeness":"complete"},"requiresMigrations":["0041_article_qualification_and_import_entries.sql","0042_realm_transfer_and_import_jobs.sql","0043_propagation_node_audience_archived_guard.sql"],"tables":[{"name":"worlds","rows":1,"sha256":"2511cf6b11c2e49068c60681749777f6cf8a4ad41c49f8cdae092c62a09e20fa"},{"name":"world_files","rows":1,"sha256":"b177b2b2405a5cd86af89c7ac6421e529a0f96367c6d0f08ac27714649a73f4c"}],"files":[{"id":"file_0000000000000000ab","sha256":"8d696c78dd03ffd11f562351c4ad81f0683f3bc65ee413c76ae8f9158e7fa515","sizeBytes":9,"contentType":"image/png","kind":"character_avatar","filename":"probe.png"}],"redactions":[{"table":"events","columns":["causationCommandId","turnRunId"],"reason":"transient command lifecycle"}],"principalPolicy":"preserve-attribution","contentHash":"22994d63eaf8fcf0594818aa156d03178b5458a528b5f03093de77ae984dd2a4"}';

test("vector 4: world_files row + manifest fixed bytes", () => {
  const filesRowBytes = utf8(
    '{"workspaceId":"ws_demo","worldId":"world_demo","id":"file_0000000000000000ab","kind":"character_avatar","contentType":"image/png","filename":"probe.png","sha256":"8d696c78dd03ffd11f562351c4ad81f0683f3bc65ee413c76ae8f9158e7fa515","sizeBytes":"9","data":{"$fileRef":"file_0000000000000000ab"},"createdAt":"2026-01-02T03:04:05.000000Z"}\n',
  );
  assert.equal(
    sha256Hex(filesRowBytes),
    "b177b2b2405a5cd86af89c7ac6421e529a0f96367c6d0f08ac27714649a73f4c",
  );
  const manifestBytes = utf8(V4_MANIFEST);
  assert.equal(manifestBytes.length, 1215);
  assert.equal(
    sha256Hex(manifestBytes),
    "acdab6faa953b44179dba8dddbfd2752b0c6f90a44adc5919f3830e08512f7c4",
  );
  // manifest 解析-再序列化逐字节回环。
  const parsed = manifestFromFixed(V4_MANIFEST);
  assert.equal(serializeManifest(parsed), V4_MANIFEST);
  // contentHash 重算链。
  const worldsBytes = utf8('{"id":"world_demo","name":"灯塔"}\n');
  const fileBytes = utf8("PNG-PROBE");
  assert.equal(
    computeContentHash(
      [
        { name: "worlds", rows: 1, bytes: worldsBytes },
        { name: "world_files", rows: 1, bytes: filesRowBytes },
      ],
      [{ id: "file_0000000000000000ab", bytes: fileBytes }],
    ),
    "22994d63eaf8fcf0594818aa156d03178b5458a528b5f03093de77ae984dd2a4",
  );
});

// ---------------------------------------------------------------------------
// G.5 向量 5/6：完整包经 validator 全链
// ---------------------------------------------------------------------------

const V5_WORLDS = '{"workspaceId":"ws_demo","id":"world_demo","name":"灯塔模板","status":"active","calendarId":"native_calendar","summary":"","settings":{},"createdAt":"2026-01-02T03:04:05.000000Z","updatedAt":"2026-01-02T03:04:05.000000Z"}\n';
const V5_WORLDLINES = '{"workspaceId":"ws_demo","worldId":"world_demo","id":"worldline_origin","label":"原初世界线","status":"active","parentWorldlineId":null,"forkTick":null,"forkOrdinal":null,"headTick":"0","headOrdinal":"0","createdAt":"2026-01-02T03:04:05.000000Z","updatedAt":"2026-01-02T03:04:05.000000Z"}\n';
const V5_MANIFEST = '{"format":"realm-pack","version":1,"createdAt":"2026-01-02T03:04:05.000Z","exporter":{"app":"realm","appVersion":"0.1.0","schemaLatest":"0043_propagation_node_audience_archived_guard.sql"},"source":{"worldId":"world_demo","worldName":"灯塔模板"},"scope":{"kind":"template","storyIds":null,"recordIds":null,"includeLinked":false,"includeMemberships":false,"completeness":"partial"},"requiresMigrations":["0041_article_qualification_and_import_entries.sql","0042_realm_transfer_and_import_jobs.sql","0043_propagation_node_audience_archived_guard.sql"],"tables":[{"name":"worlds","rows":1,"sha256":"4e8fe894c02da3236f2962a0010af0b95c4177cde963e94b05962b1fc7fcefe1"},{"name":"worldlines","rows":1,"sha256":"6d968d6f6da5ca8f21116248fe239113132fa6d8cea2c0c896dd170cde837622"}],"files":[],"redactions":[{"table":"worldlines","columns":["headTick","headOrdinal"],"reason":"template fresh start (head reset to 0,0)"},{"table":"article_qualifications","columns":["availableFromTick","availableFromOrdinal"],"reason":"template fresh start (head reset to 0,0)"}],"principalPolicy":"preserve-attribution","contentHash":"8fe0d66a9fa0ab259556057fefb68bb486a27c11cde261966ea45f73b6852211"}';

test("vector 5: minimal template pack passes the full validator chain", () => {
  const worldsBytes = utf8(V5_WORLDS);
  const worldlinesBytes = utf8(V5_WORLDLINES);
  assert.equal(sha256Hex(worldsBytes), "4e8fe894c02da3236f2962a0010af0b95c4177cde963e94b05962b1fc7fcefe1");
  assert.equal(sha256Hex(worldlinesBytes), "6d968d6f6da5ca8f21116248fe239113132fa6d8cea2c0c896dd170cde837622");
  assert.equal(
    computeContentHash(
      [
        { name: "worlds", rows: 1, bytes: worldsBytes },
        { name: "worldlines", rows: 1, bytes: worldlinesBytes },
      ],
      [],
    ),
    "8fe0d66a9fa0ab259556057fefb68bb486a27c11cde261966ea45f73b6852211",
  );
  const manifestBytes = utf8(V5_MANIFEST);
  assert.equal(manifestBytes.length, 1177);
  assert.equal(sha256Hex(manifestBytes), "7e7fbd413862b0b09d96d6c95450ad45ae83a8c258ca3aa63426fc5ccb2707fd");

  const pack = buildRealmPack({
    manifestBytes,
    tables: [
      { name: "worlds", rows: 1, bytes: worldsBytes },
      { name: "worldlines", rows: 1, bytes: worldlinesBytes },
    ],
    files: [],
  });
  const validated = validateRealmPack(pack);
  assert.equal(validated.manifest.contentHash, "8fe0d66a9fa0ab259556057fefb68bb486a27c11cde261966ea45f73b6852211");
  assert.equal(validated.manifest.scope.kind, "template");
  assert.deepEqual([...validated.tables.keys()].sort(), ["worldlines", "worlds"]);
  // manifest 解析-再序列化逐字节回环。
  assert.equal(serializeManifest(validated.manifest), V5_MANIFEST);
});

const V6_ENTITIES = '{"workspaceId":"ws_demo","worldId":"world_demo","worldlineId":"worldline_origin","id":"entity_beacon","entityKind":"setting","name":"长明灯塔","summary":"","validFromTick":"0","validToTick":null,"createdAt":"2026-01-02T03:04:05.000000Z","updatedAt":"2026-01-02T03:04:05.000000Z"}\n';
const V6_CLAIMS = '{"workspaceId":"ws_demo","worldId":"world_demo","worldlineId":"worldline_origin","id":"claim_beacon_lit","subjectEntityId":"entity_beacon","predicate":"状态","objectValue":"长明","scope":"story","truthStatus":"story_canon","confidence":"1.0000","validFromTick":"0","validToTick":null,"sourceRecordId":null,"sourceEventId":null,"supersedesClaimId":null,"createdAt":"2026-01-02T03:04:05.000000Z"}\n';
const V6_MANIFEST = '{"format":"realm-pack","version":1,"createdAt":"2026-01-02T03:04:05.000Z","exporter":{"app":"realm","appVersion":"0.1.0","schemaLatest":"0043_propagation_node_audience_archived_guard.sql"},"source":{"worldId":"world_demo","worldName":"灯塔模板"},"scope":{"kind":"template","storyIds":null,"recordIds":null,"includeLinked":false,"includeMemberships":false,"completeness":"partial"},"requiresMigrations":["0041_article_qualification_and_import_entries.sql","0042_realm_transfer_and_import_jobs.sql","0043_propagation_node_audience_archived_guard.sql"],"tables":[{"name":"worlds","rows":1,"sha256":"4e8fe894c02da3236f2962a0010af0b95c4177cde963e94b05962b1fc7fcefe1"},{"name":"worldlines","rows":1,"sha256":"6d968d6f6da5ca8f21116248fe239113132fa6d8cea2c0c896dd170cde837622"},{"name":"world_entities","rows":1,"sha256":"5a7207646ea2984e98472c8ab744244c159c0ef1f3f8fc379fbfd3142c501cd2"},{"name":"world_claims","rows":1,"sha256":"d53f87f962fab22ab4f884a0530b66504437b23269cc2d5e453e6c87cf398123"}],"files":[],"redactions":[{"table":"worldlines","columns":["headTick","headOrdinal"],"reason":"template fresh start (head reset to 0,0)"},{"table":"article_qualifications","columns":["availableFromTick","availableFromOrdinal"],"reason":"template fresh start (head reset to 0,0)"},{"table":"world_claims","columns":["sourceRecordId","sourceEventId"],"reason":"template excludes record-scoped rows; nullable refs redacted to null"}],"principalPolicy":"preserve-attribution","contentHash":"6d9ac486f0c2af0264ce03ddd5dd140b5e176dc438f4535c8a4c4c6648a69eeb"}';

test("vector 6: template pack with nullable claim-ref redaction anchors", () => {
  const entitiesBytes = utf8(V6_ENTITIES);
  const claimsBytes = utf8(V6_CLAIMS);
  assert.equal(sha256Hex(entitiesBytes), "5a7207646ea2984e98472c8ab744244c159c0ef1f3f8fc379fbfd3142c501cd2");
  assert.equal(sha256Hex(claimsBytes), "d53f87f962fab22ab4f884a0530b66504437b23269cc2d5e453e6c87cf398123");
  const worldsBytes = utf8(V5_WORLDS);
  const worldlinesBytes = utf8(V5_WORLDLINES);
  assert.equal(
    computeContentHash(
      [
        { name: "worlds", rows: 1, bytes: worldsBytes },
        { name: "worldlines", rows: 1, bytes: worldlinesBytes },
        { name: "world_entities", rows: 1, bytes: entitiesBytes },
        { name: "world_claims", rows: 1, bytes: claimsBytes },
      ],
      [],
    ),
    "6d9ac486f0c2af0264ce03ddd5dd140b5e176dc438f4535c8a4c4c6648a69eeb",
  );
  const manifestBytes = utf8(V6_MANIFEST);
  assert.equal(manifestBytes.length, 1547);
  assert.equal(sha256Hex(manifestBytes), "3b972dc4459979e963a527b1649e589a857836d1b5960439989912d308e7add1");

  const pack = buildRealmPack({
    manifestBytes,
    tables: [
      { name: "worlds", rows: 1, bytes: worldsBytes },
      { name: "worldlines", rows: 1, bytes: worldlinesBytes },
      { name: "world_entities", rows: 1, bytes: entitiesBytes },
      { name: "world_claims", rows: 1, bytes: claimsBytes },
    ],
    files: [],
  });
  const validated = validateRealmPack(pack);
  assert.equal(serializeManifest(validated.manifest), V6_MANIFEST);
  assert.equal(validated.manifest.redactions.length, 3);
});

// ---------------------------------------------------------------------------
// G.5 向量 7：canonicalRow / rowDigest / tableWireDigest
// ---------------------------------------------------------------------------

test("vector 7: canonicalRow/rowDigest/tableWireDigest all value kinds", () => {
  const rowA = JSON.parse(
    '{"workspace_id":"ws_demo","world_id":"world_demo","id":"worldline_origin","label":"原初世界线","status":"active","parent_worldline_id":null,"fork_tick":null,"fork_ordinal":null,"head_tick":"0","head_ordinal":"0","ephemeral":false,"tags":["alpha","β"],"empty_tags":[],"profile":"{\\"avatar\\":null,\\"bio\\":\\"灯塔\\"}","created_at":"2026-01-02T03:04:05.000000Z","updated_at":"2026-01-02T03:04:05.000000Z"}',
  );
  const canonical = canonicalRow(rowA);
  assert.equal(
    canonical,
    '2:id17:1worldline_origin4:tags11:35:alpha1:β5:label6:1原初世界线6:status7:1active7:profile27:1{"avatar":null,"bio":"灯塔"}8:world_id11:1world_demo9:ephemeral6:2false9:fork_tick1:09:head_tick2:1010:created_at28:12026-01-02T03:04:05.000000Z10:empty_tags1:310:updated_at28:12026-01-02T03:04:05.000000Z12:fork_ordinal1:012:head_ordinal2:1012:workspace_id8:1ws_demo19:parent_worldline_id1:0',
  );
  assert.equal(rowDigest(rowA), "006fbaca578881ada8936b1564543944b59ac3b9bd83a1d164d7845da96a9070");
  const rowB = JSON.parse(
    '{"workspace_id":"ws_demo","world_id":"world_demo","id":"worldline_branch","label":"branch","status":"active","parent_worldline_id":"worldline_origin","fork_tick":"7","fork_ordinal":"3","head_tick":"12","head_ordinal":"4","ephemeral":true,"tags":[],"empty_tags":[],"profile":"{}","created_at":"2026-01-02T03:04:05.000000Z","updated_at":"2026-01-02T03:04:05.000000Z"}',
  );
  assert.equal(rowDigest(rowB), "4bddbce4e890674e5d3e9e6cfe17beb78f065c2d12777d27d29d5d2d8a3970d9");
  assert.equal(
    tableWireDigest([rowA, rowB]),
    "5dd78bb7910b202c803e13dfe69183283fd7f80a200f53c3eb8ba71a7b854939",
  );
});

// ---------------------------------------------------------------------------
// G.5 向量 8：transferEntriesSha256 / contentDigest（展示序 vs canonical C 序）
// ---------------------------------------------------------------------------

test("vector 8: transferEntriesSha256/contentDigest canonical C-order anchors", () => {
  // entries 声明序（展示序）：worlds 在前；hash 只对 C 序 preimage 计算。
  const entries = [
    {
      name: "worlds",
      rows: 1,
      sha256: "4e8fe894c02da3236f2962a0010af0b95c4177cde963e94b05962b1fc7fcefe1",
      wireDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      name: "worldlines",
      rows: 1,
      sha256: "6d968d6f6da5ca8f21116248fe239113132fa6d8cea2c0c896dd170cde837622",
      wireDigest: "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc",
    },
  ];
  assert.equal(
    transferEntriesSha256(entries),
    "e86b14cde6f9031fc47e1c33af16011b11ea286e6cb61c89a1e9666abb225a92",
  );
  // 乱序输入必须得到同一值（canonical C 序）。
  assert.equal(
    transferEntriesSha256([entries[1]!, entries[0]!]),
    "e86b14cde6f9031fc47e1c33af16011b11ea286e6cb61c89a1e9666abb225a92",
  );
  assert.equal(
    contentDigest([
      { name: "worlds", rows: 1, wireDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "worldlines", rows: 1, wireDigest: "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc" },
    ]),
    "3996268d0dd95d5e6e5f6107bf9cfe500f3e902819c4e78446165cc1f5331103",
  );
  // tableWireDigest([rowA]) 锚点（worldlines 条目 wireDigest 来源）。
  const rowA = JSON.parse(
    '{"workspace_id":"ws_demo","world_id":"world_demo","id":"worldline_origin","label":"原初世界线","status":"active","parent_worldline_id":null,"fork_tick":null,"fork_ordinal":null,"head_tick":"0","head_ordinal":"0","ephemeral":false,"tags":["alpha","β"],"empty_tags":[],"profile":"{\\"avatar\\":null,\\"bio\\":\\"灯塔\\"}","created_at":"2026-01-02T03:04:05.000000Z","updated_at":"2026-01-02T03:04:05.000000Z"}',
  );
  assert.equal(
    tableWireDigest([rowA]),
    "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc",
  );
});

// ---------------------------------------------------------------------------
// G.5 向量 9：Unicode/UTF-8 长度 ABI（astral + precomposed + 组合序列）
// ---------------------------------------------------------------------------

test("vector 9: Unicode code-point length ABI anchors", () => {
  // 全部非 ASCII 以 \u 逃逸书写（fixture 字节纪律——M3）：
  // label = U+706F U+5854 U+1F6A8（3 cp）；note = c,a,f,U+00E9（4 cp）；
  // tags = [U+1F6A8（1 cp）、U+00E9 precomposed（1 cp）、U+0065+U+0301（2 cp）]。
  const rowU = JSON.parse(
    '{"id":"entity_beacon","label":"\u706f\u5854\ud83d\udea8","note":"caf\u00e9","tags":["\ud83d\udea8","\u00e9","e\u0301"]}',
  );
  assert.equal(codePointLength(rowU.label), 3);
  assert.equal(codePointLength(rowU.note), 4);
  assert.deepEqual(rowU.tags.map((s: string) => codePointLength(s)), [1, 1, 2]);
  const canonical = canonicalRow(rowU);
  assert.equal(
    canonical,
    "2:id14:1entity_beacon4:note5:1caf\u00e94:tags11:31:\ud83d\udea81:\u00e92:e\u03015:label4:1\u706f\u5854\ud83d\udea8",
  );
  assert.equal(rowDigest(rowU), "612a989ffc28c05a5f90d3ffebb8c82479ac41924b05ef5719bbda0ad9de4fd2");
  assert.equal(
    tableWireDigest([rowU]),
    "80a22801ad2fa2e89870cb3f8e0c2eb41b3df1038ff5ca6430aa7297999897a0",
  );
  // 负例（视觉相近但码点不同）：tags[2] 换成 precomposed U+00E9 → digest 必须不同。
  const rowNeg = JSON.parse(
    '{"id":"entity_beacon","label":"\u706f\u5854\ud83d\udea8","note":"caf\u00e9","tags":["\ud83d\udea8","\u00e9","\u00e9"]}',
  );
  const negDigest = rowDigest(rowNeg);
  assert.equal(negDigest, "6aae430e98abd8517bfb6d6414d25383cb5d8049f7e1fa9fbad3d31cb348be71");
  assert.notEqual(negDigest, rowDigest(rowU));
  assert.equal(
    tableWireDigest([rowNeg]),
    "64b37db48c5fd49f029bdbbf56ce3c6f84541bdd39c3077b9664831aa01cce70",
  );
});

// ---------------------------------------------------------------------------
// 字节确定性 + round-trip
// ---------------------------------------------------------------------------

function samplePack(createdAt: string) {
  const worldsBytes = utf8(V5_WORLDS);
  const worldlinesBytes = utf8(V5_WORLDLINES);
  const fileBytes = utf8("PNG-PROBE");
  const tables = [
    { name: "worlds", rows: 1, bytes: worldsBytes },
    { name: "worldlines", rows: 1, bytes: worldlinesBytes },
  ];
  const files = [{ id: "file_0000000000000000ab", bytes: fileBytes }];
  const manifest: RealmManifest = {
    format: "realm-pack",
    version: 1,
    createdAt,
    exporter: {
      app: "realm",
      appVersion: "0.1.0",
      schemaLatest: "0043_propagation_node_audience_archived_guard.sql",
    },
    source: { worldId: "world_demo", worldName: "灯塔模板" },
    scope: {
      kind: "full",
      storyIds: null,
      recordIds: null,
      includeLinked: false,
      includeMemberships: false,
      completeness: "complete",
    },
    requiresMigrations: [
      "0041_article_qualification_and_import_entries.sql",
      "0042_realm_transfer_and_import_jobs.sql",
      "0043_propagation_node_audience_archived_guard.sql",
    ],
    tables: tables.map((t) => ({ name: t.name, rows: t.rows, sha256: sha256Hex(t.bytes) })),
    files: [{
      id: "file_0000000000000000ab",
      sha256: sha256Hex(fileBytes),
      sizeBytes: 9,
      contentType: "image/png",
      kind: "character_avatar",
      filename: "probe.png",
    }],
    redactions: [],
    principalPolicy: "preserve-attribution",
    contentHash: computeContentHash(tables, files),
  };
  return buildRealmPack({
    manifestBytes: utf8(serializeManifest(manifest)),
    tables,
    files,
  });
}

test("deterministic ZIP: identical bytes except manifest.createdAt", () => {
  const a = samplePack("2026-01-02T03:04:05.000Z");
  const b = samplePack("2026-01-02T03:04:05.000Z");
  assert.deepEqual(Buffer.from(a), Buffer.from(b), "same input must be byte-identical");
  const c = samplePack("2026-01-03T03:04:05.000Z");
  assert.notDeepEqual(Buffer.from(a), Buffer.from(c));
  const round = validateRealmPack(a);
  assert.equal(round.manifest.source.worldName, "灯塔模板");
  assert.equal(round.files.get("file_0000000000000000ab")?.length, 9);
  assert.deepEqual(
    Buffer.from(round.tables.get("worldlines")!),
    Buffer.from(utf8(V5_WORLDLINES)),
  );
});

// ---------------------------------------------------------------------------
// G.3 恶意包矩阵
// ---------------------------------------------------------------------------

function expectPackError(code: string, mutate: (bytes: Buffer) => Buffer) {
  const base = Buffer.from(samplePack("2026-01-02T03:04:05.000Z"));
  const mutated = mutate(base);
  assert.throws(
    () => validateRealmPack(new Uint8Array(mutated)),
    (error: unknown) => {
      assert.ok(error instanceof RealmPackError, `expected RealmPackError, got ${String(error)}`);
      assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
      return true;
    },
  );
}

function cdOffsetOf(buf: Buffer): number {
  const eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return buf.readUInt32LE(eocd + 16);
}

test("G.3 malicious matrix: ZIP64 / flags / extra / comment / trailing / symlink", () => {
  expectPackError("INVALID_PACK", (b) =>
    Buffer.concat([b, Buffer.from([0x50, 0x4b, 0x06, 0x06, 0, 0, 0, 0])])); // ZIP64 EOCD record
  expectPackError("INVALID_PACK", (b) =>
    Buffer.concat([b, Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0])])); // ZIP64 locator
  expectPackError("INVALID_PACK", (b) => Buffer.concat([b, Buffer.from([0xde, 0xad])])); // trailing
  expectPackError("INVALID_PACK", (b) => { // encrypted flag bit0（CD + local 同步）
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt16LE(out.readUInt16LE(cd + 8) | 0x1, cd + 8);
    out.writeUInt16LE(out.readUInt16LE(6) | 0x1, 6);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // data descriptor bit3
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt16LE(out.readUInt16LE(cd + 8) | 0x8, cd + 8);
    out.writeUInt16LE(out.readUInt16LE(6) | 0x8, 6);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // CD extra field
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt16LE(4, cd + 30);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // EOCD comment
    const out = Buffer.concat([Buffer.from(b), Buffer.from("hi")]);
    const eocd = out.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    out.writeUInt16LE(2, eocd + 20);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // external attrs（symlink 位）
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt32LE(0xa1ff0000, cd + 38);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // multi-disk
    const out = Buffer.from(b);
    const eocd = out.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    out.writeUInt16LE(1, eocd + 4);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // versionMadeBy 漂移
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt16LE(21, cd + 4);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // 未知 method（CD + local 同步）
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt16LE(99, cd + 10);
    out.writeUInt16LE(99, 8);
    return out;
  });
});

test("G.3 malicious matrix: size spoof / ratio / CRC / hash / overlap / name rules", () => {
  expectPackError("SIZE_SPOOF", (b) => { // CD+local su 虚报 +1
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    const su = out.readUInt32LE(cd + 24);
    out.writeUInt32LE(su + 1, cd + 24);
    out.writeUInt32LE(su + 1, 22);
    return out;
  });
  expectPackError("PACK_RATIO_EXCEEDED", (b) => { // method 8 ratio 101×
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    const sc = out.readUInt32LE(cd + 20);
    const su = out.readUInt32LE(cd + 24);
    out.writeUInt32LE(sc * 101, cd + 24);
    out.writeUInt32LE(sc * 101, 22);
    void su;
    return out;
  });
  expectPackError("CRC_MISMATCH", (b) => { // CD CRC 篡改（local 同步）
    const out = Buffer.from(b);
    const cd = cdOffsetOf(out);
    out.writeUInt32LE((out.readUInt32LE(cd + 16) ^ 0xffffffff) >>> 0, cd + 16);
    out.writeUInt32LE((out.readUInt32LE(14) ^ 0xffffffff) >>> 0, 14);
    return out;
  });
  expectPackError("PACK_LIMIT_EXCEEDED", (b) => { // EOCD 条目数超上限（>2000）
    const out = Buffer.from(b);
    const eocd = out.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    out.writeUInt16LE(2001, eocd + 8);
    out.writeUInt16LE(2001, eocd + 10);
    return out;
  });
  expectPackError("INVALID_PACK", (b) => { // CD 条目数与实际不符
    const out = Buffer.from(b);
    const eocd = out.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    out.writeUInt16LE(1, eocd + 8);
    out.writeUInt16LE(1, eocd + 10);
    return out;
  });
  // 篡改 manifest.tables 的 sha256 字段（重建包）→ sha256 链拒绝。
  {
    const worldsBytes = utf8(V5_WORLDS);
    const worldlinesBytes = utf8(V5_WORLDLINES);
    const tables = [
      { name: "worlds", rows: 1, bytes: worldsBytes },
      { name: "worldlines", rows: 1, bytes: worldlinesBytes },
    ];
    const manifest: RealmManifest = {
      format: "realm-pack",
      version: 1,
      createdAt: "2026-01-02T03:04:05.000Z",
      exporter: {
        app: "realm",
        appVersion: "0.1.0",
        schemaLatest: "0043_propagation_node_audience_archived_guard.sql",
      },
      source: { worldId: "world_demo", worldName: "灯塔模板" },
      scope: {
        kind: "full", storyIds: null, recordIds: null,
        includeLinked: false, includeMemberships: false, completeness: "complete",
      },
      requiresMigrations: [
        "0041_article_qualification_and_import_entries.sql",
        "0042_realm_transfer_and_import_jobs.sql",
        "0043_propagation_node_audience_archived_guard.sql",
      ],
      tables: tables.map((t) => ({ name: t.name, rows: t.rows, sha256: sha256Hex(t.bytes) })),
      files: [],
      redactions: [],
      principalPolicy: "preserve-attribution",
      contentHash: computeContentHash(tables, []),
    };
    manifest.tables[0]!.sha256 = "0".repeat(64);
    const tampered = buildRealmPack({
      manifestBytes: utf8(serializeManifest(manifest)),
      tables,
      files: [],
    });
    assert.throws(
      () => validateRealmPack(tampered),
      (error: unknown) => error instanceof RealmPackError && error.code === "HASH_MISMATCH",
    );
  }
  // 非白名单条目名：构造一个自包含 ZIP（手工 local+CD+EOCD）。
  const handcrafted = (name: string) => {
    const data = Buffer.from("x");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = 0; // 结构先行：名非法即拒，CRC 无关紧要
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method 0
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(nameBuf.length, 28);
    const cdOffset = 30 + nameBuf.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + nameBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([local, nameBuf, data, cdEntry, nameBuf, eocd]);
  };
  assert.throws(
    () => validateRealmPack(new Uint8Array(handcrafted("tables/../evil.ndjson"))),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_PACK",
  );
  assert.throws(
    () => validateRealmPack(new Uint8Array(handcrafted("/abs/path.ndjson"))),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_PACK",
  );
});

// ---------------------------------------------------------------------------
// H.1 multipart 边界矩阵
// ---------------------------------------------------------------------------

function multipartBody(parts: {
  fields?: Record<string, string>;
  fileName?: string | null;
  fileBytes?: Buffer;
  boundary?: string;
}): { body: Buffer; contentType: string } {
  const boundary = parts.boundary ?? "----realmboundary0123456789";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }
  if (parts.fileName !== null && parts.fileName !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.fileName}"\r\nContent-Type: application/vnd.realm.world+zip\r\n\r\n`,
      "utf8",
    ));
    chunks.push(parts.fileBytes ?? Buffer.from("PKfake"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test("multipart: well-formed single file + fields parses", async () => {
  const { body, contentType } = multipartBody({
    fields: { importMode: "preserve" },
    fileName: "world.realm",
    fileBytes: Buffer.from("PK\x03\x04payload"),
  });
  const result = await parseMultipartBounded({ contentType, body });
  assert.equal(result.fields.get("importMode"), "preserve");
  assert.equal(result.file.filename, "world.realm");
  assert.deepEqual(Buffer.from(result.file.bytes), Buffer.from("PK\x03\x04payload"));
});

test("multipart: boundary matrix", async () => {
  const oversized = Buffer.alloc(71_303_169, 0x41);
  await assert.rejects(
    parseMultipartBounded({
      contentType: "multipart/form-data; boundary=x",
      body: oversized,
    }),
    (error: unknown) => error instanceof RealmPackError && error.code === "PACK_TOO_LARGE",
  );
  // chunked 流累计超限中断。
  const chunks = [Buffer.alloc(40_000_000), Buffer.alloc(40_000_000)];
  async function* stream() {
    for (const chunk of chunks) yield chunk;
  }
  await assert.rejects(
    parseMultipartBounded({
      contentType: "multipart/form-data; boundary=x",
      body: stream(),
    }),
    (error: unknown) => error instanceof RealmPackError && error.code === "PACK_TOO_LARGE",
  );
  // 断开统一 400。
  async function* broken() {
    yield Buffer.from("--x\r\n");
    throw new Error("socket hangup");
  }
  await assert.rejects(
    parseMultipartBounded({
      contentType: "multipart/form-data; boundary=x",
      body: broken(),
    }),
    (error: unknown) => error instanceof RealmPackError && error.code === "CLIENT_DISCONNECTED",
  );
  // 字段数 > 4。
  const tooMany = multipartBody({
    fields: { a: "1", b: "2", c: "3", d: "4", e: "5" },
    fileName: "w.realm",
  });
  await assert.rejects(
    parseMultipartBounded({ contentType: tooMany.contentType, body: tooMany.body }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // 字段名 > 32。
  const longName = multipartBody({
    fields: { ["n".repeat(33)]: "1" },
    fileName: "w.realm",
  });
  await assert.rejects(
    parseMultipartBounded({ contentType: longName.contentType, body: longName.body }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // 文本值 > 1024。
  const longValue = multipartBody({
    fields: { importMode: "x".repeat(1025) },
    fileName: "w.realm",
  });
  await assert.rejects(
    parseMultipartBounded({ contentType: longValue.contentType, body: longValue.body }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // filename > 255。
  const longFile = multipartBody({
    fileName: `${"f".repeat(256)}.realm`,
  });
  await assert.rejects(
    parseMultipartBounded({ contentType: longFile.contentType, body: longFile.body }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // 缺 file part。
  const noFile = multipartBody({ fields: { importMode: "preserve" }, fileName: null });
  await assert.rejects(
    parseMultipartBounded({ contentType: noFile.contentType, body: noFile.body }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // 非 multipart content-type。
  await assert.rejects(
    parseMultipartBounded({ contentType: "application/json", body: Buffer.from("{}") }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
  // body 不以 boundary 开头。
  await assert.rejects(
    parseMultipartBounded({
      contentType: "multipart/form-data; boundary=x",
      body: Buffer.from("garbage\r\n--x--\r\n"),
    }),
    (error: unknown) => error instanceof RealmPackError && error.code === "INVALID_REQUEST",
  );
});

// ---------------------------------------------------------------------------
// D.2 双 codec round-trip
// ---------------------------------------------------------------------------

test("dual codec round-trip: camel→snake keys and all value kinds", () => {
  const columns: readonly PackColumnSpec[] = [
    { name: "workspace_id", type: "text" },
    { name: "world_id", type: "text" },
    { name: "id", type: "text" },
    { name: "head_tick", type: "bigint" },
    { name: "confidence", type: "numeric" },
    { name: "active", type: "boolean" },
    { name: "created_at", type: "timestamptz" },
    { name: "data", type: "bytea" },
    { name: "embedding", type: "vector" },
    { name: "tags", type: "text[]" },
    { name: "settings", type: "jsonb" },
  ];
  const dbRow = {
    workspace_id: "ws_demo",
    world_id: "world_demo",
    id: "row_1",
    head_tick: "9007199254740993", // 超 JS safe integer 的 bigint 文本
    confidence: "1.0000",
    active: true,
    created_at: "2026-01-02T03:04:05.123456Z", // 微秒非零（C1 六位 codec）
    data: "\\xDEADBEEF",
    embedding: "[0.1,0.2,0.3]",
    tags: ["alpha", "β"],
    settings: { b: 1, a: { z: null, y: "灯塔" } },
  };
  const line = serializePackRow(columns, dbRow);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  // 键名 camelCase + 键序 = columns 声明序。
  assert.deepEqual(Object.keys(parsed), [
    "workspaceId", "worldId", "id", "headTick", "confidence", "active",
    "createdAt", "data", "embedding", "tags", "settings",
  ]);
  assert.deepEqual(parsed.data, { $bytea: Buffer.from("DEADBEEF", "hex").toString("base64") });
  assert.deepEqual(parsed.embedding, { $vector: [0.1, 0.2, 0.3] });
  // jsonb 键递归排序。
  assert.equal(JSON.stringify(parsed.settings), '{"a":{"y":"灯塔","z":null},"b":1}');

  const insertRow = packRowToInsertRow(columns, parsed);
  assert.deepEqual(insertRow, {
    workspace_id: "ws_demo",
    world_id: "world_demo",
    id: "row_1",
    head_tick: "9007199254740993",
    confidence: "1.0000",
    active: true,
    created_at: "2026-01-02T03:04:05.123456Z",
    data: "\\xdeadbeef",
    embedding: "[0.1,0.2,0.3]",
    tags: ["alpha", "β"],
    settings: '{"a":{"y":"灯塔","z":null},"b":1}',
  });

  // world_files fileref：包内 $fileRef → 导入回写 \xhex（来自 files map）。
  const fileColumns: readonly PackColumnSpec[] = [
    { name: "id", type: "text" },
    { name: "data", type: "fileref" },
  ];
  const fileRow = { id: "file_ab", data: "file_ab" };
  const fileLine = serializePackRow(fileColumns, fileRow);
  const fileParsed = JSON.parse(fileLine) as Record<string, unknown>;
  assert.deepEqual(fileParsed.data, { $fileRef: "file_ab" });
  const fileInsert = packRowToInsertRow(fileColumns, fileParsed, () => utf8("PNG-PROBE"));
  assert.equal(fileInsert.data, `\\x${Buffer.from("PNG-PROBE").toString("hex")}`);

  // 微秒边界：.000001Z / .123456Z 与 formatTimestamptz 毫秒形态。
  assert.equal(
    formatTimestamptz(new Date("2026-01-02T03:04:05.123Z")),
    "2026-01-02T03:04:05.123000Z",
  );
  for (const value of ["2026-01-02T03:04:05.123456Z", "2026-01-02T03:04:05.000001Z"]) {
    const roundTrip = packRowToInsertRow(
      [{ name: "created_at", type: "timestamptz" }],
      JSON.parse(serializePackRow([{ name: "created_at", type: "timestamptz" }], { created_at: value })),
    );
    assert.equal(roundTrip.created_at, value);
  }
});

// ---------------------------------------------------------------------------
// D.7 export-matrix 围栏
// ---------------------------------------------------------------------------

test("export-matrix fences: 61-table diff / text[] list / scope sets", async () => {
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  const tablePattern = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/g;
  const actual = new Set<string>();
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    const sql = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL(filename, migrationDir), "utf8"));
    for (const match of sql.matchAll(tablePattern)) actual.add(match[1]!);
  }
  // 0042 已入库：5 个规划表成为实有表（56+5=61，planned 集合为空）。
  const planned: string[] = [];
  assert.equal(actual.size, 61, `实有表应为 61（56+0042 五表），实际 ${actual.size}`);
  const matrixTables = new Set(EXPORT_MATRIX.map((entry) => entry.table));
  assert.equal(matrixTables.size, 61, `矩阵应为 61 行，实际 ${matrixTables.size}`);
  for (const table of [...actual, ...planned]) {
    assert.ok(matrixTables.has(table), `矩阵缺表：${table}`);
  }
  for (const table of matrixTables) {
    assert.ok(
      actual.has(table) || planned.includes(table),
      `矩阵多表（无 schema 来源）：${table}`,
    );
  }
  assert.equal(TEXT_ARRAY_NON_NULL_COLUMNS.length, 8, "text[] 清单冻结 count=8");
  assert.equal(SCOPE_IMPORTABLE.template.length, 23);
  assert.equal(SCOPE_IMPORTABLE.archive.length, 36);
  assert.equal(SCOPE_IMPORTABLE.full.length, 41);
  assert.equal(PACK_TABLE_ORDER.length, 42);
});

// ---------------------------------------------------------------------------
// Y0 server-only 静态断言：app/components/** 零 fflate import
// ---------------------------------------------------------------------------

test("server-only fence: no fflate import under app/components", async () => {
  const { readdir: readDir, readFile: read } = await import("node:fs/promises");
  const roots = ["../app/components", "../app"];
  const offenders: string[] = [];
  async function walk(rel: string) {
    let entries: string[];
    try {
      entries = await readDir(new URL(rel, import.meta.url));
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry}`;
      const info = await import("node:fs/promises").then((fs) =>
        fs.stat(new URL(child, import.meta.url)));
      if (info.isDirectory()) await walk(child);
      else if (/\.(ts|tsx|mjs)$/.test(entry)) {
        const source = await read(new URL(child, import.meta.url), "utf8");
        if (/from\s+["']fflate["']|require\(["']fflate["']\)/.test(source)) {
          offenders.push(child);
        }
      }
    }
  }
  for (const root of roots) await walk(root);
  assert.deepEqual(offenders, [], `fflate 不得进入前端路径：${offenders.join(", ")}`);
});
