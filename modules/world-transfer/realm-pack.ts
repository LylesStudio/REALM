/**
 * v37 §D.1/D.2/G.2/G.3/G.4/H.1：`.realm` 世界包契约实现（server-only）。
 *
 * - manifest schema version 1（字段序冻结；未知字段 fail-closed）；
 * - 双 codec：pack NDJSON codec（camelCase/ordinal 键序/类型编码）与
 *   insert codec（snake_case 真实列名/值形态收敛 {string,boolean,null,
 *   string 数组}）——camel→snake 唯一转换点在本文件；
 * - 写出：fflate zipSync 两遍内存构建（条目序 manifest → tables/* 声明序
 *   → files/* id 升序；method 8/0；flags 仅 bit11；mtime DOS epoch 零；
 *   无 extra/comment；level 6）；
 * - 读入：自写严格 CD 结构 validator（G.3 parser ABI：任何 inflate 之前
 *   完成结构校验；未列字段一律 no-go）+ node:zlib inflateRawSync 硬上界
 *   + zlib.crc32 逐条比对 + manifest sha256 链 + ratio 预筛；
 * - canonical 序列化与 digest 链（G.4；与 0042 PL/pgSQL helper 双侧逐字节
 *   一致；长度前缀一律 Unicode code point 计数——Z57）；
 * - 自写有界 multipart 解析器（H.1；不调用 formData/arrayBuffer）。
 */
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { zipSync, strToU8, type ZipOptions } from "fflate";
import {
  PACK_TABLE_ORDER,
} from "./export-matrix.ts";

// ---------------------------------------------------------------------------
// 错误与分类
// ---------------------------------------------------------------------------

export type RealmPackErrorCode =
  | "INVALID_PACK"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "MIGRATION_REQUIRED"
  | "PACK_TOO_LARGE"
  | "PACK_RATIO_EXCEEDED"
  | "SIZE_SPOOF"
  | "CRC_MISMATCH"
  | "HASH_MISMATCH"
  | "PACK_LIMIT_EXCEEDED"
  | "CLIENT_DISCONNECTED"
  | "INVALID_REQUEST";

export class RealmPackError extends Error {
  readonly code: RealmPackErrorCode;
  readonly status: number;
  constructor(code: RealmPackErrorCode, message: string) {
    super(message);
    this.name = "RealmPackError";
    this.code = code;
    this.status = code === "PACK_TOO_LARGE"
      ? 413
      : code === "MIGRATION_REQUIRED"
        ? 503
        : code === "CLIENT_DISCONNECTED" || code === "INVALID_REQUEST"
          ? 400
          : 422;
  }
}

// ---------------------------------------------------------------------------
// 资源上限（J.5）
// ---------------------------------------------------------------------------

export const PACK_LIMITS = {
  /** 条目数上限（EOCD totalEntries）。 */
  entriesMax: 2000,
  /** 单条目压缩上限。 */
  entryCompressedMax: 64 * 1024 * 1024,
  /** manifest/ndjson 单条目解压上限。 */
  manifestMax: 16 * 1024 * 1024,
  ndjsonMax: 16 * 1024 * 1024,
  /** files/*.bin 单条目解压上限。 */
  fileMax: 32 * 1024 * 1024,
  /** 累计解压上限。 */
  totalUncompressedMax: 256 * 1024 * 1024,
  /** method 8 ratio 预筛（su/sc）。 */
  ratioMax: 100,
  /** 单表行数上限（register DB 级同值硬上限）。 */
  tableRowsMax: 100_000,
  /** 全表合计行数上限。 */
  totalRowsMax: 500_000,
} as const;

export const MULTIPART_LIMITS = {
  /** body 硬上限 = ZIP 67_108_864 + framing 4_194_304（metadata 16_384 属 framing 内）。 */
  bodyMaxBytes: 71_303_168,
  zipMaxBytes: 67_108_864,
  framingMaxBytes: 4_194_304,
  fieldMax: 4,
  fieldNameMax: 32,
  textValueMax: 1_024,
  filenameMax: 255,
} as const;

// ---------------------------------------------------------------------------
// 基础工具（code-point 长度 ABI——Z57）
// ---------------------------------------------------------------------------

/** Unicode code point 计数（== PG char_length；禁 String.length）。 */
export function codePointLength(value: string): number {
  return [...value].length;
}

export function utf8(value: string): Uint8Array {
  return strToU8(value);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha256").update(data).digest("hex");
}

/** C collation 字节序比较（UTF-8 字节序 == PG COLLATE "C"）。 */
export function compareC(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ---------------------------------------------------------------------------
// G.4 canonical 序列化（scope/digest 链）
// ---------------------------------------------------------------------------

export interface PackScope {
  kind: "template" | "full" | "archive";
  storyIds: readonly string[] | null;
  recordIds: readonly string[] | null;
  includeLinked: boolean;
  includeMemberships: boolean;
  completeness: "complete" | "partial";
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function sortedQuotedIds(ids: readonly string[] | null): string {
  if (ids === null) return "null";
  const sorted = [...ids].sort(compareC);
  return `[${sorted.map(jsonString).join(",")}]`;
}

/** canonicalScope（G.4 冻结形态）。 */
export function canonicalScope(scope: PackScope): string {
  return `{"kind":${jsonString(scope.kind)}`
    + `,"storyIds":${sortedQuotedIds(scope.storyIds)}`
    + `,"recordIds":${sortedQuotedIds(scope.recordIds)}`
    + `,"includeLinked":${scope.includeLinked ? "true" : "false"}`
    + `,"includeMemberships":${scope.includeMemberships ? "true" : "false"}`
    + `,"completeness":${jsonString(scope.completeness)}}`;
}

export function scopeDigest(scope: PackScope): string {
  return sha256Hex(canonicalScope(scope));
}

// ---------------------------------------------------------------------------
// G.4 import 侧 digest 链（JS 侧；与 0042 PL helper 逐字节一致）
// ---------------------------------------------------------------------------

/** insert codec 值形态收敛：{string, boolean, null, string 数组}。 */
export type InsertValue = string | boolean | null | readonly string[];
export type InsertRow = Record<string, InsertValue>;

function encodeCanonicalValue(value: InsertValue): string {
  if (value === null) return "0";
  if (typeof value === "string") return `1${value}`;
  if (typeof value === "boolean") return `2${value ? "true" : "false"}`;
  if (Array.isArray(value)) {
    let out = "3";
    for (const element of value) {
      if (typeof element !== "string") {
        throw new RealmPackError("INVALID_PACK", "canonical array elements must be strings");
      }
      out += `${codePointLength(element)}:${element}`;
    }
    return out;
  }
  throw new RealmPackError(
    "INVALID_PACK",
    `non-canonical insert codec value kind: ${typeof value}`,
  );
}

/** canonicalRow(row)：键按 (codePointLength ASC, C 字节序 ASC) 排序，
 *  段 = len:key + len:seg（长度全按 code point）。 */
export function canonicalRow(row: InsertRow): string {
  const keys = Object.keys(row).sort(
    (a, b) => (codePointLength(a) - codePointLength(b)) || compareC(a, b),
  );
  let out = "";
  for (const key of keys) {
    const seg = encodeCanonicalValue(row[key] as InsertValue);
    out += `${codePointLength(key)}:${key}${codePointLength(seg)}:${seg}`;
  }
  return out;
}

export function rowDigest(row: InsertRow): string {
  return sha256Hex(canonicalRow(row));
}

/** tableWireDigest(rows)：rowDigest 按 C 序 ASC 拼接（每个 + '\n'）。 */
export function tableWireDigest(rows: readonly InsertRow[]): string {
  const digests = rows.map(rowDigest).sort(compareC);
  return sha256Hex(digests.map((d) => `${d}\n`).join(""));
}

export interface TransferEntry {
  name: string;
  rows: number;
  sha256: string;
  wireDigest: string;
}

/** transferEntriesSha256（含 wireDigest 的单链不可替换绑定——C1）。 */
export function transferEntriesSha256(entries: readonly TransferEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareC(a.name, b.name));
  return sha256Hex(
    sorted.map((e) => `${e.name}\n${e.rows}\n${e.sha256}\n${e.wireDigest}\n`).join(""),
  );
}

/** contentDigest（content_log 行：name\n rows\n wire_digest\n，C 序）。 */
export function contentDigest(
  logRows: readonly { name: string; rows: number; wireDigest: string }[],
): string {
  const sorted = [...logRows].sort((a, b) => compareC(a.name, b.name));
  return sha256Hex(
    sorted.map((e) => `${e.name}\n${e.rows}\n${e.wireDigest}\n`).join(""),
  );
}

// ---------------------------------------------------------------------------
// D.2 双 codec
// ---------------------------------------------------------------------------

/** 列类型（导出侧由 information_schema 驱动；包 lib 不直接查库）。 */
export type PackColumnType =
  | "text"
  | "int"
  | "bigint"
  | "numeric"
  | "boolean"
  | "timestamptz"
  | "bytea"
  | "fileref"
  | "vector"
  | "text[]"
  | "jsonb";

export interface PackColumnSpec {
  /** 真实 snake_case 列名（information_schema ordinal_position 序）。 */
  readonly name: string;
  readonly type: PackColumnType;
}

/** snake_case → lowerCamel（pack 键名）。 */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** lowerCamel → snake_case（insert 键名；唯一转换点）。 */
export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/** timestamptz canonical：恰好 6 位小数、零填充、UTC（C1；不经 driver Date
 *  解析参与导出——导出查询在 SQL 侧 to_char 直出，本函数供本地/测试用）。 */
export function formatTimestamptz(date: Date): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const base = iso.slice(0, 19);
  const ms = iso.slice(20, 23);
  return `${base}.${ms}000Z`;
}

/** canonical JSON（键递归排序紧凑；jsonb 列的 pack/insert 形态基础）。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    // fail-closed：canonical JSON 不存在 undefined 形态（静默会产生非法 JSON）。
    throw new RealmPackError("INVALID_PACK", "undefined is not a canonical JSON value");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RealmPackError("INVALID_PACK", "non-finite number is not canonical JSON");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareC);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** 导出侧：DB 值 → pack JSON 值（列类型由 spec 驱动）。 */
export function encodePackValue(
  column: PackColumnSpec,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "text":
    case "timestamptz":
      return typeof value === "string" ? value : String(value);
    case "int":
    case "bigint":
    case "numeric":
      return typeof value === "string" ? value : String(value);
    case "boolean":
      return value === true || value === "t" || value === "true";
    case "bytea": {
      // pg bytea 输出形态 '\x<hex>'。
      const hex = typeof value === "string" && value.startsWith("\\x")
        ? value.slice(2)
        : Buffer.isBuffer(value)
          ? value.toString("hex")
          : (() => {
              throw new RealmPackError("INVALID_PACK", `bad bytea value for ${column.name}`);
            })();
      return { $bytea: Buffer.from(hex, "hex").toString("base64") };
    }
    case "fileref":
      // world_files.data：导入回写从 files/<id>.bin 读字节；包内为引用。
      return { $fileRef: String(value) };
    case "vector": {
      if (Array.isArray(value)) return { $vector: value.map(Number) };
      const text = String(value);
      const inner = text.replace(/^\[/, "").replace(/\]$/, "");
      return {
        $vector: inner.length === 0 ? [] : inner.split(",").map((x) => Number(x.trim())),
      };
    }
    case "text[]":
      return Array.isArray(value) ? [...value] : (() => {
        throw new RealmPackError("INVALID_PACK", `bad text[] value for ${column.name}`);
      })();
    case "jsonb":
      return JSON.parse(canonicalJson(value)) as unknown;
  }
}

/** pack 行 → NDJSON 字节（键序 = columns 声明序（ordinal_position）；
 *  列名 camelCase；行末 '\n' 含末行）。 */
export function serializePackRow(
  columns: readonly PackColumnSpec[],
  row: Record<string, unknown>,
): string {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[snakeToCamel(column.name)] = encodePackValue(column, row[column.name]);
  }
  return JSON.stringify(out);
}

export function ndjsonBytes(
  columns: readonly PackColumnSpec[],
  rows: readonly Record<string, unknown>[],
): Uint8Array {
  return utf8(rows.map((row) => `${serializePackRow(columns, row)}\n`).join(""));
}

/** 导入侧：pack 行（camelCase）→ insert 行（snake_case 真实列名 +
 *  值形态收敛 {string, boolean, null, string 数组}——C5）。
 *  fileBytes: world_files.data 的 $fileRef 回写字节（→ "\x<hex>"）。 */
export function packRowToInsertRow(
  columns: readonly PackColumnSpec[],
  packRow: Record<string, unknown>,
  fileBytes?: (fileId: string) => Uint8Array,
): InsertRow {
  const out: InsertRow = {};
  for (const column of columns) {
    const value = packRow[snakeToCamel(column.name)];
    const key = column.name;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    switch (column.type) {
      case "text":
      case "timestamptz":
      case "int":
      case "bigint":
      case "numeric":
        if (typeof value !== "string") {
          throw new RealmPackError("INVALID_PACK", `bad string codec value for ${key}`);
        }
        out[key] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new RealmPackError("INVALID_PACK", `bad boolean codec value for ${key}`);
        }
        out[key] = value;
        break;
      case "bytea": {
        const ref = value as { $bytea?: unknown };
        if (typeof ref?.$bytea !== "string") {
          throw new RealmPackError("INVALID_PACK", `bad bytea codec value for ${key}`);
        }
        out[key] = `\\x${Buffer.from(ref.$bytea, "base64").toString("hex")}`;
        break;
      }
      case "fileref": {
        const ref = value as { $fileRef?: unknown };
        if (typeof ref?.$fileRef !== "string") {
          throw new RealmPackError("INVALID_PACK", `bad fileRef codec value for ${key}`);
        }
        if (!fileBytes) {
          throw new RealmPackError("INVALID_PACK", `fileRef without files map for ${key}`);
        }
        out[key] = `\\x${Buffer.from(fileBytes(ref.$fileRef)).toString("hex")}`;
        break;
      }
      case "vector": {
        const ref = value as { $vector?: unknown };
        if (!Array.isArray(ref?.$vector)) {
          throw new RealmPackError("INVALID_PACK", `bad vector codec value for ${key}`);
        }
        out[key] = `[${(ref.$vector as unknown[]).map((x) => String(x)).join(",")}]`;
        break;
      }
      case "text[]":
        if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
          throw new RealmPackError("INVALID_PACK", `bad text[] codec value for ${key}`);
        }
        out[key] = value as readonly string[];
        break;
      case "jsonb":
        out[key] = canonicalJson(value);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// D.1 manifest（version 1；字段序冻结；未知字段 fail-closed）
// ---------------------------------------------------------------------------

export const REQUIRES_MIGRATIONS: readonly string[] = [
  "0041_article_qualification_and_import_entries.sql",
  "0042_realm_transfer_and_import_jobs.sql",
  "0043_propagation_node_audience_archived_guard.sql",
];

export interface ManifestTableEntry {
  name: string;
  rows: number;
  sha256: string;
}

export interface ManifestFileEntry {
  id: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  kind: string;
  filename: string;
}

export interface RealmManifest {
  format: "realm-pack";
  version: 1;
  createdAt: string;
  exporter: { app: "realm"; appVersion: string; schemaLatest: string };
  source: { worldId: string; worldName: string };
  scope: PackScope;
  requiresMigrations: readonly string[];
  tables: readonly ManifestTableEntry[];
  files: readonly ManifestFileEntry[];
  memberships?: readonly { principalRef: string; role: "owner" | "member" | "viewer" }[];
  redactions: readonly { table: string; columns: readonly string[]; reason: string }[];
  principalPolicy: "preserve-attribution";
  contentHash: string;
}

/** manifest 字节 = JSON.stringify（key 序 = 声明序；无空格；非 ASCII 不转义）。 */
export function serializeManifest(manifest: RealmManifest): string {
  const out: Record<string, unknown> = {
    format: manifest.format,
    version: manifest.version,
    createdAt: manifest.createdAt,
    exporter: {
      app: manifest.exporter.app,
      appVersion: manifest.exporter.appVersion,
      schemaLatest: manifest.exporter.schemaLatest,
    },
    source: { worldId: manifest.source.worldId, worldName: manifest.source.worldName },
    scope: {
      kind: manifest.scope.kind,
      storyIds: manifest.scope.storyIds === null ? null : [...manifest.scope.storyIds].sort(compareC),
      recordIds: manifest.scope.recordIds === null ? null : [...manifest.scope.recordIds].sort(compareC),
      includeLinked: manifest.scope.includeLinked,
      includeMemberships: manifest.scope.includeMemberships,
      completeness: manifest.scope.completeness,
    },
    requiresMigrations: [...manifest.requiresMigrations],
    tables: manifest.tables.map((t) => ({ name: t.name, rows: t.rows, sha256: t.sha256 })),
    files: manifest.files.map((f) => ({
      id: f.id,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      contentType: f.contentType,
      kind: f.kind,
      filename: f.filename,
    })),
  };
  if (manifest.memberships !== undefined) {
    out.memberships = manifest.memberships.map((m) => ({
      principalRef: m.principalRef,
      role: m.role,
    }));
  }
  out.redactions = manifest.redactions.map((r) => ({
    table: r.table,
    columns: [...r.columns],
    reason: r.reason,
  }));
  out.principalPolicy = manifest.principalPolicy;
  out.contentHash = manifest.contentHash;
  return JSON.stringify(out);
}

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmPackError("INVALID_PACK", `unknown manifest key ${where}.${key}`);
    }
  }
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new RealmPackError("INVALID_PACK", `manifest ${where} must be a string`);
  }
  return value;
}

/** 严格 manifest 解析（未知顶层/嵌套字段 → 422；version>1 →
 *  UNSUPPORTED_FORMAT_VERSION）。 */
export function parseManifest(bytes: Uint8Array): RealmManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RealmPackError("INVALID_PACK", "manifest is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new RealmPackError("INVALID_PACK", "manifest must be an object");
  }
  assertExactKeys(parsed, [
    "format", "version", "createdAt", "exporter", "source", "scope",
    "requiresMigrations", "tables", "files", "memberships", "redactions",
    "principalPolicy", "contentHash",
  ], "");
  if (parsed.format !== "realm-pack") {
    throw new RealmPackError("INVALID_PACK", "manifest format must be realm-pack");
  }
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version)) {
    throw new RealmPackError("INVALID_PACK", "manifest version must be an integer");
  }
  if (parsed.version > 1) {
    throw new RealmPackError("UNSUPPORTED_FORMAT_VERSION", "manifest version > 1");
  }
  const createdAt = requireString(parsed.createdAt, "createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) {
    throw new RealmPackError("INVALID_PACK", "manifest createdAt must be .sssZ");
  }
  if (!isPlainObject(parsed.exporter)) {
    throw new RealmPackError("INVALID_PACK", "manifest exporter must be an object");
  }
  assertExactKeys(parsed.exporter, ["app", "appVersion", "schemaLatest"], "exporter");
  if (parsed.exporter.app !== "realm") {
    throw new RealmPackError("INVALID_PACK", "manifest exporter.app must be realm");
  }
  const exporter = {
    app: "realm" as const,
    appVersion: requireString(parsed.exporter.appVersion, "exporter.appVersion"),
    schemaLatest: requireString(parsed.exporter.schemaLatest, "exporter.schemaLatest"),
  };
  if (!isPlainObject(parsed.source)) {
    throw new RealmPackError("INVALID_PACK", "manifest source must be an object");
  }
  assertExactKeys(parsed.source, ["worldId", "worldName"], "source");
  const source = {
    worldId: requireString(parsed.source.worldId, "source.worldId"),
    worldName: requireString(parsed.source.worldName, "source.worldName"),
  };
  if (!isPlainObject(parsed.scope)) {
    throw new RealmPackError("INVALID_PACK", "manifest scope must be an object");
  }
  assertExactKeys(parsed.scope, [
    "kind", "storyIds", "recordIds", "includeLinked", "includeMemberships", "completeness",
  ], "scope");
  const scopeRaw = parsed.scope;
  if (!["template", "full", "archive"].includes(String(scopeRaw.kind))) {
    throw new RealmPackError("INVALID_PACK", "manifest scope.kind invalid");
  }
  const idList = (value: unknown, where: string): string[] | null => {
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      throw new RealmPackError("INVALID_PACK", `manifest scope.${where} must be string[]|null`);
    }
    return value as string[];
  };
  if (typeof scopeRaw.includeLinked !== "boolean"
    || typeof scopeRaw.includeMemberships !== "boolean") {
    throw new RealmPackError("INVALID_PACK", "manifest scope flags must be boolean");
  }
  if (!["complete", "partial"].includes(String(scopeRaw.completeness))) {
    throw new RealmPackError("INVALID_PACK", "manifest scope.completeness invalid");
  }
  const scope: PackScope = {
    kind: scopeRaw.kind as PackScope["kind"],
    storyIds: idList(scopeRaw.storyIds, "storyIds"),
    recordIds: idList(scopeRaw.recordIds, "recordIds"),
    includeLinked: scopeRaw.includeLinked,
    includeMemberships: scopeRaw.includeMemberships,
    completeness: scopeRaw.completeness as PackScope["completeness"],
  };
  if (!Array.isArray(parsed.requiresMigrations)
    || !parsed.requiresMigrations.every((x) => typeof x === "string")) {
    throw new RealmPackError("INVALID_PACK", "manifest requiresMigrations must be string[]");
  }
  if (!Array.isArray(parsed.tables)) {
    throw new RealmPackError("INVALID_PACK", "manifest tables must be an array");
  }
  const tables: ManifestTableEntry[] = parsed.tables.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new RealmPackError("INVALID_PACK", `manifest tables[${i}] must be an object`);
    }
    // 包 ABI 边界（C1 冻结）：tables[] 条目恒三字段。
    assertExactKeys(entry, ["name", "rows", "sha256"], `tables[${i}]`);
    const name = requireString(entry.name, `tables[${i}].name`);
    if (typeof entry.rows !== "number" || !Number.isInteger(entry.rows) || entry.rows < 1) {
      throw new RealmPackError("INVALID_PACK", `manifest tables[${i}].rows must be >= 1`);
    }
    const sha256 = requireString(entry.sha256, `tables[${i}].sha256`);
    if (!HEX64.test(sha256)) {
      throw new RealmPackError("INVALID_PACK", `manifest tables[${i}].sha256 must be hex64`);
    }
    return { name, rows: entry.rows, sha256 };
  });
  if (!Array.isArray(parsed.files)) {
    throw new RealmPackError("INVALID_PACK", "manifest files must be an array");
  }
  const files: ManifestFileEntry[] = parsed.files.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new RealmPackError("INVALID_PACK", `manifest files[${i}] must be an object`);
    }
    assertExactKeys(entry, ["id", "sha256", "sizeBytes", "contentType", "kind", "filename"], `files[${i}]`);
    const sha256 = requireString(entry.sha256, `files[${i}].sha256`);
    if (!HEX64.test(sha256)) {
      throw new RealmPackError("INVALID_PACK", `manifest files[${i}].sha256 must be hex64`);
    }
    if (typeof entry.sizeBytes !== "number" || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new RealmPackError("INVALID_PACK", `manifest files[${i}].sizeBytes must be >= 0`);
    }
    return {
      id: requireString(entry.id, `files[${i}].id`),
      sha256,
      sizeBytes: entry.sizeBytes,
      contentType: requireString(entry.contentType, `files[${i}].contentType`),
      kind: requireString(entry.kind, `files[${i}].kind`),
      filename: requireString(entry.filename, `files[${i}].filename`),
    };
  });
  let memberships: RealmManifest["memberships"];
  if (parsed.memberships !== undefined) {
    if (!Array.isArray(parsed.memberships)) {
      throw new RealmPackError("INVALID_PACK", "manifest memberships must be an array");
    }
    memberships = parsed.memberships.map((entry, i) => {
      if (!isPlainObject(entry)) {
        throw new RealmPackError("INVALID_PACK", `manifest memberships[${i}] must be an object`);
      }
      assertExactKeys(entry, ["principalRef", "role"], `memberships[${i}]`);
      if (!["owner", "member", "viewer"].includes(String(entry.role))) {
        throw new RealmPackError("INVALID_PACK", `manifest memberships[${i}].role invalid`);
      }
      return {
        principalRef: requireString(entry.principalRef, `memberships[${i}].principalRef`),
        role: entry.role as "owner" | "member" | "viewer",
      };
    });
  }
  if (!Array.isArray(parsed.redactions)) {
    throw new RealmPackError("INVALID_PACK", "manifest redactions must be an array");
  }
  const redactions = parsed.redactions.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new RealmPackError("INVALID_PACK", `manifest redactions[${i}] must be an object`);
    }
    assertExactKeys(entry, ["table", "columns", "reason"], `redactions[${i}]`);
    if (!Array.isArray(entry.columns) || !entry.columns.every((x) => typeof x === "string")) {
      throw new RealmPackError("INVALID_PACK", `manifest redactions[${i}].columns must be string[]`);
    }
    return {
      table: requireString(entry.table, `redactions[${i}].table`),
      columns: entry.columns as string[],
      reason: requireString(entry.reason, `redactions[${i}].reason`),
    };
  });
  if (parsed.principalPolicy !== "preserve-attribution") {
    throw new RealmPackError("INVALID_PACK", "manifest principalPolicy invalid");
  }
  const contentHash = requireString(parsed.contentHash, "contentHash");
  if (!HEX64.test(contentHash)) {
    throw new RealmPackError("INVALID_PACK", "manifest contentHash must be hex64");
  }
  return {
    format: "realm-pack",
    version: 1,
    createdAt,
    exporter,
    source,
    scope,
    requiresMigrations: parsed.requiresMigrations as string[],
    tables,
    files,
    ...(memberships !== undefined ? { memberships } : {}),
    redactions,
    principalPolicy: "preserve-attribution",
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// G.4 contentHash / logicalPackHash
// ---------------------------------------------------------------------------

export interface PackTableData {
  name: string;
  rows: number;
  bytes: Uint8Array;
}

export interface PackFileData {
  id: string;
  bytes: Uint8Array;
}

/** tableDigestInput（G.4）：表按声明序（零行表不出现），文件按 id 升序。 */
export function tableDigestInput(
  tables: readonly PackTableData[],
  files: readonly PackFileData[],
): string {
  let out = "";
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const name of PACK_TABLE_ORDER) {
    const table = byName.get(name);
    if (!table) continue;
    if (table.rows < 1) continue;
    out += `${table.name}\n${table.rows}\n${sha256Hex(table.bytes)}\n`;
  }
  for (const table of tables) {
    if (!PACK_TABLE_ORDER.includes(table.name)) {
      throw new RealmPackError("INVALID_PACK", `table not in declared order: ${table.name}`);
    }
  }
  const sortedFiles = [...files].sort((a, b) => compareC(a.id, b.id));
  for (const file of sortedFiles) {
    out += `file:${file.id}\n${file.bytes.length}\n${sha256Hex(file.bytes)}\n`;
  }
  return out;
}

/** contentHash（= logicalPackHash）= sha256(utf8(tableDigestInput))。 */
export function computeContentHash(
  tables: readonly PackTableData[],
  files: readonly PackFileData[],
): string {
  return sha256Hex(tableDigestInput(tables, files));
}

// ---------------------------------------------------------------------------
// G.2 写出（zipSync 两遍内存构建）
// ---------------------------------------------------------------------------

/** DOS epoch 零（本地时间 1980-01-01 00:00:00 → DOS time/date 恒 0/0x21，
 *  与时区无关——fflate 取本地分量）。 */
const DOS_EPOCH_ZERO = new Date(1980, 0, 1, 0, 0, 0);

/**
 * 构建确定性 ZIP：manifest（首 local header）→ tables/*（声明序）→
 * files/*（id 升序）；method 8（manifest/tables，level 6）/ 0（files/*.bin）；
 * mtime DOS epoch 零；无 extra/comment。同库同数据两次导出：tables/files
 * 字节逐字节一致，仅 manifest.createdAt 不同。
 */
export function buildRealmPack(input: {
  manifestBytes: Uint8Array;
  tables: readonly PackTableData[];
  files: readonly PackFileData[];
}): Uint8Array {
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};
  entries["realm-manifest.json"] = [input.manifestBytes, { level: 6, mtime: DOS_EPOCH_ZERO }];
  const byName = new Map(input.tables.map((t) => [t.name, t]));
  for (const name of PACK_TABLE_ORDER) {
    const table = byName.get(name);
    if (!table) continue;
    if (table.rows < 1) continue;
    entries[`tables/${name}.ndjson`] = [table.bytes, { level: 6, mtime: DOS_EPOCH_ZERO }];
  }
  for (const table of input.tables) {
    if (!PACK_TABLE_ORDER.includes(table.name)) {
      throw new RealmPackError("INVALID_PACK", `table not in declared order: ${table.name}`);
    }
  }
  const sortedFiles = [...input.files].sort((a, b) => compareC(a.id, b.id));
  for (const file of sortedFiles) {
    entries[`files/${file.id}.bin`] = [file.bytes, { level: 0, mtime: DOS_EPOCH_ZERO }];
  }
  return zipSync(entries);
}

// ---------------------------------------------------------------------------
// G.3 读入 validator（唯一 parser ABI；任何 inflate 之前执行；只解析结构）
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const ENTRY_NAME_RE = /^(realm-manifest\.json|tables\/[a-z_]+\.ndjson|files\/[A-Za-z0-9_-]+\.bin)$/;

interface CdEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  sc: number;
  su: number;
  lho: number;
}

function u16(buf: Uint8Array, off: number): number {
  if (off + 2 > buf.length) throw new RealmPackError("INVALID_PACK", "truncated u16");
  return buf[off]! | (buf[off + 1]! << 8);
}

function u32(buf: Uint8Array, off: number): number {
  if (off + 4 > buf.length) throw new RealmPackError("INVALID_PACK", "truncated u32");
  const value = (buf[off]!) | (buf[off + 1]! << 8) | (buf[off + 2]! << 16)
    | (buf[off + 3]! << 24);
  return value >>> 0;
}

function parseStructure(bytes: Uint8Array): { entries: CdEntry[] } {
  if (bytes.length < 22) {
    throw new RealmPackError("INVALID_PACK", "file too small for ZIP");
  }
  // 0. ZIP64 签名一律拒绝。
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    const sig = u32(bytes, i);
    if (sig === SIG_ZIP64_EOCD || sig === SIG_ZIP64_LOCATOR) {
      throw new RealmPackError("INVALID_PACK", "ZIP64 structures are not accepted");
    }
  }
  // 1. EOCD：自文件尾扫描（最多 65558 字节）。
  const scanStart = Math.max(0, bytes.length - 65558);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new RealmPackError("INVALID_PACK", "EOCD not found");
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) {
    throw new RealmPackError("INVALID_PACK", "multi-disk archives are not accepted");
  }
  const diskEntries = u16(bytes, eocd + 8);
  const totalEntries = u16(bytes, eocd + 10);
  if (diskEntries !== totalEntries) {
    throw new RealmPackError("INVALID_PACK", "EOCD entry count mismatch");
  }
  if (totalEntries > PACK_LIMITS.entriesMax) {
    throw new RealmPackError("PACK_LIMIT_EXCEEDED", "too many ZIP entries");
  }
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const commentLen = u16(bytes, eocd + 20);
  if (commentLen !== 0) {
    throw new RealmPackError("INVALID_PACK", "EOCD comment is not accepted");
  }
  if (eocd + 22 !== bytes.length) {
    throw new RealmPackError("INVALID_PACK", "trailing bytes after EOCD");
  }
  if (cdOffset + cdSize > bytes.length || cdOffset + cdSize > eocd) {
    throw new RealmPackError("INVALID_PACK", "CD range out of bounds");
  }
  if (cdOffset + cdSize !== eocd) {
    throw new RealmPackError("INVALID_PACK", "bytes between CD and EOCD");
  }

  // 2. CD 逐条。
  const entries: CdEntry[] = [];
  const seenNames = new Set<string>();
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (u32(bytes, off) !== SIG_CD) {
      throw new RealmPackError("INVALID_PACK", "CD entry signature mismatch");
    }
    const verMadeBy = u16(bytes, off + 4);
    const verNeeded = u16(bytes, off + 6);
    if (verMadeBy !== 20 || verNeeded !== 20) {
      throw new RealmPackError("INVALID_PACK", "unsupported ZIP version fields");
    }
    const flags = u16(bytes, off + 8);
    if (flags & ~0x0800) {
      // 拒 bit0 加密 / bit3 data descriptor / 其余一切置位。
      throw new RealmPackError("INVALID_PACK", "unsupported ZIP flags");
    }
    const method = u16(bytes, off + 10);
    if (method !== 0 && method !== 8) {
      throw new RealmPackError("INVALID_PACK", `unsupported compression method ${method}`);
    }
    const crc = u32(bytes, off + 16);
    const sc = u32(bytes, off + 20);
    const su = u32(bytes, off + 24);
    const nlen = u16(bytes, off + 28);
    const elen = u16(bytes, off + 30);
    const clen = u16(bytes, off + 32);
    if (nlen === 0) throw new RealmPackError("INVALID_PACK", "empty entry name");
    if (elen !== 0) throw new RealmPackError("INVALID_PACK", "extra fields are not accepted");
    if (clen !== 0) throw new RealmPackError("INVALID_PACK", "CD comments are not accepted");
    if (u16(bytes, off + 34) !== 0) {
      throw new RealmPackError("INVALID_PACK", "multi-disk entries are not accepted");
    }
    if (u16(bytes, off + 36) !== 0) {
      throw new RealmPackError("INVALID_PACK", "internal attributes must be zero");
    }
    if (u32(bytes, off + 38) !== 0) {
      // external attrs（含 symlink 位）一律拒。
      throw new RealmPackError("INVALID_PACK", "external attributes are not accepted");
    }
    const lho = u32(bytes, off + 42);
    if (lho >= eocd) throw new RealmPackError("INVALID_PACK", "local header offset out of range");
    const nameBytes = bytes.slice(off + 46, off + 46 + nlen);
    const name = Buffer.from(nameBytes).toString("utf8");
    if (!ENTRY_NAME_RE.test(name)) {
      throw new RealmPackError("INVALID_PACK", `entry name not whitelisted: ${name}`);
    }
    if (seenNames.has(name)) {
      throw new RealmPackError("INVALID_PACK", `duplicate entry name: ${name}`);
    }
    seenNames.add(name);
    entries.push({ name, method, flags, crc, sc, su, lho });
    off += 46 + nlen;
  }
  if (off !== cdOffset + cdSize) {
    throw new RealmPackError("INVALID_PACK", "CD size mismatch");
  }

  // 3. 声明预筛。
  let totalSc = 0;
  let totalSu = 0;
  for (const entry of entries) {
    if (entry.sc > PACK_LIMITS.entryCompressedMax) {
      throw new RealmPackError("PACK_TOO_LARGE", "entry compressed size exceeds limit");
    }
    const suCap = entry.name.startsWith("files/")
      ? PACK_LIMITS.fileMax
      : entry.name === "realm-manifest.json"
        ? PACK_LIMITS.manifestMax
        : PACK_LIMITS.ndjsonMax;
    if (entry.su > suCap) {
      throw new RealmPackError("PACK_TOO_LARGE", "entry uncompressed size exceeds limit");
    }
    if (entry.su === 0) {
      throw new RealmPackError("INVALID_PACK", "zero-length entries are not accepted");
    }
    if (entry.method === 0 && entry.su !== entry.sc) {
      throw new RealmPackError("INVALID_PACK", "stored entry size mismatch");
    }
    if (entry.method === 8 && entry.sc > 0
      && entry.su / entry.sc > PACK_LIMITS.ratioMax) {
      throw new RealmPackError("PACK_RATIO_EXCEEDED", "compression ratio exceeds limit");
    }
    totalSc += entry.sc;
    totalSu += entry.su;
    if (totalSc > PACK_LIMITS.entryCompressedMax) {
      throw new RealmPackError("PACK_TOO_LARGE", "total compressed size exceeds limit");
    }
    if (totalSu > PACK_LIMITS.totalUncompressedMax) {
      throw new RealmPackError("PACK_TOO_LARGE", "total uncompressed size exceeds limit");
    }
  }
  return { entries };
}

export interface ValidatedPack {
  manifest: RealmManifest;
  /** tables/<name>.ndjson → 解压字节（声明序键）。 */
  tables: ReadonlyMap<string, Uint8Array>;
  /** files/<id>.bin → 解压字节。 */
  files: ReadonlyMap<string, Uint8Array>;
}

/** G.3 全链校验（结构 → 解压 → CRC → sha256 → contentHash）。 */
export function validateRealmPack(bytes: Uint8Array): ValidatedPack {
  const { entries } = parseStructure(bytes);

  // 4. local header 复核 + 数据区边界。
  const dataRegions: { start: number; end: number }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const cd = entries[i]!;
    if (u32(bytes, cd.lho) !== SIG_LOCAL) {
      throw new RealmPackError("INVALID_PACK", "local header signature mismatch");
    }
    if (u16(bytes, cd.lho + 4) !== 20) {
      throw new RealmPackError("INVALID_PACK", "local version mismatch");
    }
    const lflags = u16(bytes, cd.lho + 6);
    const lmethod = u16(bytes, cd.lho + 8);
    const lcrc = u32(bytes, cd.lho + 14);
    const lsc = u32(bytes, cd.lho + 18);
    const lsu = u32(bytes, cd.lho + 22);
    const lnlen = u16(bytes, cd.lho + 26);
    const lelen = u16(bytes, cd.lho + 28);
    if (lelen !== 0) {
      throw new RealmPackError("INVALID_PACK", "local extra fields are not accepted");
    }
    const lname = Buffer.from(bytes.slice(cd.lho + 30, cd.lho + 30 + lnlen)).toString("utf8");
    if (lname !== cd.name || lmethod !== cd.method || lflags !== cd.flags
      || lcrc !== cd.crc || lsc !== cd.sc || lsu !== cd.su) {
      throw new RealmPackError("INVALID_PACK", "local header does not match CD entry");
    }
    const dataStart = cd.lho + 30 + lnlen + lelen;
    if (dataStart + cd.sc > bytes.length) {
      throw new RealmPackError("INVALID_PACK", "entry data out of bounds");
    }
    dataRegions.push({ start: dataStart, end: dataStart + cd.sc });
    // local 序 = CD 序：首个 local 必须是 manifest。
    if (i === 0 && cd.name !== "realm-manifest.json") {
      throw new RealmPackError("INVALID_PACK", "first entry must be the manifest");
    }
  }
  // 数据区互不重叠（offset 排序验证）。
  const sortedRegions = [...dataRegions].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedRegions.length; i += 1) {
    if (sortedRegions[i]!.start < sortedRegions[i - 1]!.end) {
      throw new RealmPackError("INVALID_PACK", "overlapping entry data regions");
    }
  }

  // 5. 解压（逐条硬上界）。
  const manifestCap = PACK_LIMITS.manifestMax;
  const decoded = new Map<string, Uint8Array>();
  let totalOut = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const cd = entries[entryIndex]!;
    const dataStart = dataRegions[entryIndex]!.start;
    const raw = bytes.slice(dataStart, dataStart + cd.sc);
    let out: Uint8Array;
    if (cd.method === 8) {
      const suCap = cd.name.startsWith("files/")
        ? PACK_LIMITS.fileMax
        : cd.name === "realm-manifest.json"
          ? manifestCap
          : PACK_LIMITS.ndjsonMax;
      try {
        out = inflateRawSync(raw, { maxOutputLength: suCap });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          throw new RealmPackError("PACK_TOO_LARGE", "entry exceeds decompression limit");
        }
        throw new RealmPackError("INVALID_PACK", "entry deflate stream invalid");
      }
    } else {
      out = raw.slice();
      if (out.length !== cd.sc) {
        throw new RealmPackError("SIZE_SPOOF", "stored entry length mismatch");
      }
    }
    if (out.length !== cd.su) {
      throw new RealmPackError("SIZE_SPOOF", `entry ${cd.name} size spoofed`);
    }
    totalOut += out.length;
    if (totalOut > PACK_LIMITS.totalUncompressedMax) {
      throw new RealmPackError("PACK_TOO_LARGE", "total decompressed size exceeds limit");
    }
    // 6. CRC 链（逐条）。
    if (crc32(out) !== cd.crc >>> 0) {
      throw new RealmPackError("CRC_MISMATCH", `entry ${cd.name} CRC mismatch`);
    }
    decoded.set(cd.name, out);
  }

  const manifestBytes = decoded.get("realm-manifest.json")!;
  const manifest = parseManifest(manifestBytes);

  // sha256 链：manifest.tables/files 条目与解压字节逐条比对。
  const tables = new Map<string, Uint8Array>();
  const files = new Map<string, Uint8Array>();
  const manifestTableNames = new Set<string>();
  for (const entry of manifest.tables) {
    const key = `tables/${entry.name}.ndjson`;
    const data = decoded.get(key);
    if (!data) throw new RealmPackError("HASH_MISMATCH", `missing table entry ${key}`);
    if (sha256Hex(data) !== entry.sha256) {
      throw new RealmPackError("HASH_MISMATCH", `table ${entry.name} sha256 mismatch`);
    }
    manifestTableNames.add(key);
    tables.set(entry.name, data);
  }
  const manifestFileIds = new Set<string>();
  for (const entry of manifest.files) {
    const key = `files/${entry.id}.bin`;
    const data = decoded.get(key);
    if (!data) throw new RealmPackError("HASH_MISMATCH", `missing file entry ${key}`);
    if (sha256Hex(data) !== entry.sha256 || data.length !== entry.sizeBytes) {
      throw new RealmPackError("HASH_MISMATCH", `file ${entry.id} sha256/size mismatch`);
    }
    manifestFileIds.add(key);
    files.set(entry.id, data);
  }
  for (const name of decoded.keys()) {
    if (name === "realm-manifest.json") continue;
    if (!manifestTableNames.has(name) && !manifestFileIds.has(name)) {
      throw new RealmPackError("INVALID_PACK", `unmanifested entry: ${name}`);
    }
  }
  // contentHash 重算比对。
  const recomputed = computeContentHash(
    manifest.tables.map((t) => ({
      name: t.name,
      rows: t.rows,
      bytes: tables.get(t.name)!,
    })),
    manifest.files.map((f) => ({ id: f.id, bytes: files.get(f.id)! })),
  );
  if (recomputed !== manifest.contentHash) {
    throw new RealmPackError("HASH_MISMATCH", "contentHash mismatch");
  }
  return { manifest, tables, files };
}

// ---------------------------------------------------------------------------
// H.1 自写有界流式 multipart 解析器（不调用 formData/arrayBuffer）
// ---------------------------------------------------------------------------

export interface MultipartResult {
  /** 文本字段（≤4 字段、字段名 ≤32、文本值 ≤1024）。 */
  fields: ReadonlyMap<string, string>;
  /** 恰好一个 file part。 */
  file: { filename: string; bytes: Uint8Array };
}

type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array;

async function collectBounded(
  body: ByteSource,
  signal?: AbortSignal | null,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.length > MULTIPART_LIMITS.bodyMaxBytes) {
      throw new RealmPackError("PACK_TOO_LARGE", "body exceeds limit");
    }
    return body;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) {
        throw new RealmPackError("CLIENT_DISCONNECTED", "client disconnected");
      }
      total += chunk.length;
      if (total > MULTIPART_LIMITS.bodyMaxBytes) {
        throw new RealmPackError("PACK_TOO_LARGE", "body exceeds limit");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RealmPackError) throw error;
    throw new RealmPackError("CLIENT_DISCONNECTED", "client disconnected");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 有界 multipart 解析（H.1 唯一实现）：
 * Content-Length > BODY_MAX → 不读体 413（由调用方在 headers 阶段前置）；
 * chunked 累计超限中断 413；断开统一 400 CLIENT_DISCONNECTED；
 * 字段 ≤4、字段名 ≤32、文本值 ≤1024、filename ≤255、恰一个 file part；
 * 多余字段 400。
 */
export async function parseMultipartBounded(input: {
  contentType: string;
  body: ByteSource;
  signal?: AbortSignal | null;
}): Promise<MultipartResult> {
  const match = /multipart\/form-data;\s*boundary="?([^";]+)"?/.exec(input.contentType);
  if (!match) {
    throw new RealmPackError("INVALID_REQUEST", "content-type must be multipart/form-data");
  }
  const boundary = match[1]!;
  if (boundary.length === 0 || boundary.length > 70) {
    throw new RealmPackError("INVALID_REQUEST", "multipart boundary invalid");
  }
  const body = await collectBounded(input.body, input.signal);

  const delimiter = utf8(`--${boundary}`);
  const terminator = utf8(`--${boundary}--`);
  const crlf = utf8("\r\n");

  // 首行必须是 delimiter。
  if (indexOf(body, delimiter, 0) !== 0) {
    throw new RealmPackError("INVALID_REQUEST", "multipart body must start with boundary");
  }
  const fields = new Map<string, string>();
  let file: { filename: string; bytes: Uint8Array } | null = null;

  let cursor = 0;
  for (;;) {
    if (indexOf(body, terminator, cursor) === cursor) break;
    if (indexOf(body, delimiter, cursor) !== cursor) {
      throw new RealmPackError("INVALID_REQUEST", "multipart delimiter expected");
    }
    cursor += delimiter.length;
    if (indexOf(body, crlf, cursor) !== cursor) {
      throw new RealmPackError("INVALID_REQUEST", "multipart CRLF expected");
    }
    cursor += crlf.length;
    // part headers（至空行）。
    const headerEnd = indexOf(body, utf8("\r\n\r\n"), cursor);
    if (headerEnd === -1) {
      throw new RealmPackError("INVALID_REQUEST", "multipart part headers unterminated");
    }
    const headerText = Buffer.from(body.slice(cursor, headerEnd)).toString("utf8");
    cursor = headerEnd + 4;
    const disposition = headerText.split("\r\n").find((line) =>
      line.toLowerCase().startsWith("content-disposition:"));
    if (!disposition) {
      throw new RealmPackError("INVALID_REQUEST", "multipart part missing disposition");
    }
    const nameMatch = /name="([^"]*)"/.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/.exec(disposition);
    if (!nameMatch) {
      throw new RealmPackError("INVALID_REQUEST", "multipart part missing name");
    }
    const fieldName = nameMatch[1]!;
    if (fieldName.length > MULTIPART_LIMITS.fieldNameMax) {
      throw new RealmPackError("INVALID_REQUEST", "multipart field name too long");
    }
    // part body（至下一个 delimiter/terminator 前的 CRLF）。
    let next = indexOf(body, delimiter, cursor);
    const nextTerm = indexOf(body, terminator, cursor);
    if (nextTerm !== -1 && (next === -1 || nextTerm < next)) next = nextTerm;
    if (next === -1) {
      throw new RealmPackError("INVALID_REQUEST", "multipart part body unterminated");
    }
    // part body 以 CRLF 结尾（delimiter 前 2 字节）。
    if (next < 2 || body[next - 2] !== 0x0d || body[next - 1] !== 0x0a) {
      throw new RealmPackError("INVALID_REQUEST", "multipart part body missing CRLF");
    }
    const partBytes = body.slice(cursor, next - 2);
    cursor = next;

    if (filenameMatch !== null) {
      if (fieldName !== "file") {
        throw new RealmPackError("INVALID_REQUEST", "unexpected file field name");
      }
      if (file !== null) {
        throw new RealmPackError("INVALID_REQUEST", "exactly one file part required");
      }
      const filename = filenameMatch[1]!;
      if (filename.length > MULTIPART_LIMITS.filenameMax) {
        throw new RealmPackError("INVALID_REQUEST", "multipart filename too long");
      }
      file = { filename, bytes: partBytes };
    } else {
      if (fields.size >= MULTIPART_LIMITS.fieldMax) {
        throw new RealmPackError("INVALID_REQUEST", "too many multipart fields");
      }
      if (fields.has(fieldName)) {
        throw new RealmPackError("INVALID_REQUEST", `duplicate field ${fieldName}`);
      }
      const text = Buffer.from(partBytes).toString("utf8");
      if (text.length > MULTIPART_LIMITS.textValueMax) {
        throw new RealmPackError("INVALID_REQUEST", "multipart text value too long");
      }
      fields.set(fieldName, text);
    }
  }
  if (file === null) {
    throw new RealmPackError("INVALID_REQUEST", "exactly one file part required");
  }
  if (file.bytes.length > MULTIPART_LIMITS.zipMaxBytes) {
    throw new RealmPackError("PACK_TOO_LARGE", "file part exceeds ZIP limit");
  }
  return { fields, file };
}
