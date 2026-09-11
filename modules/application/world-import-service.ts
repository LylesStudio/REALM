/**
 * v37 Y3：`.realm` 导入 service（F.4 事务链全经受控函数）。
 *
 * - dry-run 两事务：tx0 幂等预查 + realm_import_job_create（job+created
 *   原子）；tx1 包校验（G.3 链已在内存完成）+ D.6 冲突预扫 + copy
 *   eligibility → begin_validation → register_pack_tables（manifest.tables
 *   全量 + wireDigest enrichment；函数内重算 == job 不可变列）→
 *   finish_validation(outcome, report)。
 * - execute：重传包重算双 hash（logical_pack_hash + transfer_entries_sha256，
 *   enrichment 的 copy_key/mode 一律取 job 行）比对 job 不可变列 → tx1
 *   begin_execute（RETURNING attemptNo；并发串行）→ tx2 单事务全或无
 *   （txid 绑定由函数强制）→ 失败 tx3 fail_execute。
 * - archive 包 execute 永拒（service 预检 422 + DB begin_execute RAISE
 *   双兜底）；dry-run 报告正常产出。
 * - reconcile（懒触发）：stale pending/validating/executing（>30min）→
 *   recover_crash('PROCESS_CRASH')。
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PACK_LIMITS,
  RealmPackError,
  contentDigest,
  packRowToInsertRow,
  scopeDigest as importScopeDigest,
  sha256Hex,
  tableWireDigest,
  transferEntriesSha256,
  validateRealmPack,
  type InsertRow,
  type PackColumnSpec,
  type TransferEntry,
  type ValidatedPack,
} from "../world-transfer/realm-pack.ts";
import {
  PACK_TABLE_ORDER,
  matrixRow,
} from "../world-transfer/export-matrix.ts";

export type ImportErrorCode =
  | "INVALID_REQUEST"
  | "CLIENT_DISCONNECTED"
  | "INVALID_PACK"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "MIGRATION_REQUIRED"
  | "TRANSFER_NOT_PROVISIONED"
  | "PACK_TOO_LARGE"
  | "PACK_RATIO_EXCEEDED"
  | "SIZE_SPOOF"
  | "CRC_MISMATCH"
  | "HASH_MISMATCH"
  | "PACK_LIMIT_EXCEEDED"
  | "PACK_MISMATCH"
  | "WORLD_EXISTS"
  | "ID_COLLISION"
  | "JOB_STATE_CONFLICT"
  | "COPY_INELIGIBLE"
  | "ARCHIVE_PACK_NOT_IMPORTABLE"
  | "JOB_NOT_FOUND"
  | "IMPORT_FAILED";

export class WorldImportError extends Error {
  readonly code: ImportErrorCode;
  readonly details?: unknown;
  constructor(code: ImportErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorldImportError";
    this.code = code;
    this.details = details;
  }
}

export interface ImportReport {
  kind: string;
  mode: string;
  tables: readonly { name: string; rows: number }[];
  files: number;
  redactions: readonly { table: string; columns: readonly string[]; reason: string }[];
  warnings: string[];
  targetWorldName: string;
  worldExists: boolean;
  idCollisions: readonly { table: string; id: string }[];
  copyEligible: boolean;
  blockingFields: readonly { table: string; column: string; hit: string }[];
}

const COPY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** D.6 copy 重映射：newId = <前缀>_<sha256(logicalPackHash:copyKey:原id)[:18]>。 */
export function remapId(
  logicalPackHash: string,
  copyKey: string,
  originalId: string,
): string {
  const prefix = originalId.split("_")[0] ?? originalId;
  const suffix = createHash("sha256")
    .update(`${logicalPackHash}:${copyKey}:${originalId}`, "utf8")
    .digest("hex")
    .slice(0, 18);
  return `${prefix}_${suffix}`;
}

/** 自引用列（batch 内拓扑序插入——NOT DEFERRABLE FK 逐行检查，父先子后）。 */
const SELF_REF_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  worldlines: ["parent_worldline_id"],
  records: ["linked_record_id"],
  character_instances: ["predecessor_instance_id"],
  world_claims: ["supersedes_claim_id"],
  canon_revisions: ["parent_revision_id"],
  information_packets: ["parent_packet_id"],
  memory_conclusions: ["supersedes_memory_id"],
};

/** 自引用行拓扑排序（根先叶后；环 → IMPORT_FAILED）。 */
function topoSortRows(table: string, rows: InsertRow[]): InsertRow[] {
  const selfRef = SELF_REF_COLUMNS[table];
  if (!selfRef || rows.length < 2) return rows;
  const keyOf = (row: InsertRow) => String(row.id ?? "");
  const byId = new Map(rows.map((row) => [keyOf(row), row]));
  const depth = new Map<string, number>();
  const depthOf = (row: InsertRow, seen: Set<string>): number => {
    const id = keyOf(row);
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) {
      throw new WorldImportError("IMPORT_FAILED", `self-reference cycle in ${table}`);
    }
    seen.add(id);
    let d = 0;
    for (const column of selfRef) {
      const ref = row[column];
      if (typeof ref === "string" && ref !== "" && byId.has(ref)) {
        d = Math.max(d, depthOf(byId.get(ref)!, seen) + 1);
      }
    }
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const row of rows) depthOf(row, new Set());
  return [...rows].sort((a, b) => depth.get(keyOf(a))! - depth.get(keyOf(b))!);
}

// ---------------------------------------------------------------------------
// enrichment（包行 → 落库行：copy 重映射 + 身份/principal 规则 + codec）
// ---------------------------------------------------------------------------

interface Enrichment {
  newWorldId: string;
  /** 每表 insert-codec 行（拓扑序）。 */
  tables: Map<string, InsertRow[]>;
  transferEntries: TransferEntry[];
  blockingFields: { table: string; column: string; hit: string }[];
  /** 导入侧 worlds status 重写登记（archive 世界只读封存不经导入恢复）。 */
  worldStatusRedacted: boolean;
}

function enrichPack(
  pack: ValidatedPack,
  columnsByTable: ReadonlyMap<string, readonly PackColumnSpec[]>,
  options: {
    workspaceId: string;
    copyKey: string;
    importerPrincipal: string;
  },
): Enrichment {
  const { manifest } = pack;
  const copy = options.copyKey !== "";
  const logicalPackHash = manifest.contentHash;
  const remap = (id: string): string =>
    copy ? remapId(logicalPackHash, options.copyKey, id) : id;
  const newWorldId = remap(manifest.source.worldId);

  // 身份集合（conditional-rewrite 的命中域）：全部 identity 列原值。
  const identityIds = new Set<string>([manifest.source.worldId]);
  for (const [table, bytes] of pack.tables) {
    for (const line of Buffer.from(bytes).toString("utf8").trim().split("\n")) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if ((key === "id" || key === "worldlineId") && typeof value === "string") {
          identityIds.add(value);
        }
      }
    }
    void table;
  }

  const blockingFields: { table: string; column: string; hit: string }[] = [];
  const tables = new Map<string, InsertRow[]>();

  for (const [table, bytes] of pack.tables) {
    const columns = columnsByTable.get(table);
    if (!columns) {
      throw new WorldImportError("INVALID_PACK", `no column metadata for ${table}`);
    }
    const matrix = matrixRow(table);
    const jsonPointerColumns = new Map(
      matrix.jsonPointers.map((pointer) => {
        const column = pointer.split("/")[1]!;
        return [column, pointer];
      }),
    );
    const lines = Buffer.from(bytes).toString("utf8").trim().split("\n");
    const insertRows: InsertRow[] = [];
    for (const line of lines) {
      const packRow = JSON.parse(line) as Record<string, unknown>;
      // —— copy 重映射（包字节不变，落库时重写——D.6）——
      const remapped = { ...packRow };
      for (const [key, value] of Object.entries(remapped)) {
        const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
        if (value === null || value === undefined) continue;
        if (key === "worldId") {
          remapped[key] = newWorldId;
          continue;
        }
        if (key === "worldlineId" || key === "id") {
          remapped[key] = remap(String(value));
          continue;
        }
        if (matrix.rewriteColumns.includes(snake)) {
          if (Array.isArray(value)) {
            remapped[key] = value.map((item) => remap(String(item)));
          } else {
            remapped[key] = remap(String(value));
          }
          continue;
        }
        if (matrix.conditionalRewriteColumns.includes(snake)) {
          const text = String(value);
          remapped[key] = identityIds.has(text) ? remap(text) : text;
          continue;
        }
        if (matrix.principalColumns.includes(snake)) {
          const text = String(value);
          if (snake === "principal_id") {
            // D.5：participants.principal_id → importer（两模式同）。
            remapped[key] = options.importerPrincipal;
          } else if (copy && text.startsWith("principal_")) {
            // D.5：copy 模式 attested_by/operator/proposed_by/decided_by →
            // 'imported_legacy'（非 principal_ 前缀系统 actor 原样）。
            remapped[key] = "imported_legacy";
          }
          continue;
        }
      }
      // JSON Pointer 重写（character_definitions /profile/avatar_file_id；
      // worldline_merges manifest/conflict_report 路径）。
      for (const [snakeColumn] of jsonPointerColumns) {
        const camel = snakeColumn.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
        const value = remapped[camel];
        if (value === null || value === undefined) continue;
        // pointer 形态：/<column>/<inner…> 或 /<column>[]/<inner…>（column 段
        // 带 [] 表示列值本身是数组，逐项重写 inner 路径）。
        remapped[camel] = rewriteJsonPointers(
          value,
          matrix.jsonPointers
            .filter((pointer) => pointer.split("/")[1]!.replace(/\[\]$/, "") === snakeColumn)
            .map((pointer) => {
              const segments = pointer.split("/").filter((segment) => segment !== "");
              return segments.slice(1).join("/") + (segments[0]!.endsWith("[]") ? "@columnIsArray" : "");
            }),
          remap,
        );
      }
      let converted: InsertRow;
      try {
        converted = packRowToInsertRow(columns, remapped, (fileId) => {
        const file = pack.files.get(fileId);
        if (!file) {
          throw new WorldImportError(
            "INVALID_PACK",
            `file reference closure violated: ${fileId}`,
          );
        }
        return file;
      });
      } catch (error) {
        throw new WorldImportError(
          "INVALID_PACK",
          `enrichment failed for ${table}: ${error instanceof Error ? error.message : String(error)} :: ${JSON.stringify(remapped).slice(0, 200)}`,
        );
      }
      insertRows.push(converted);
    }

    // copy eligibility 预扫（D.6）：opaque jsonb 列（无 pointer 规则）命中
    // 被重映射原始 id → blockingFields。
    if (copy) {
      for (const column of columns) {
        if (column.type !== "jsonb") continue;
        if (matrix.jsonPointers.some((p) => p.split("/")[1] === column.name)) continue;
        for (const row of insertRows) {
          const value = row[column.name];
          if (typeof value !== "string") continue;
          for (const id of identityIds) {
            if (value.includes(id)) {
              blockingFields.push({ table, column: column.name, hit: id });
            }
          }
        }
      }
    }
    tables.set(table, topoSortRows(table, insertRows));
  }

  // worlds 行：status 由 service 重写为 active（函数断言最终值——archive
  // 世界只读封存不经导入恢复；重写记 redaction）。
  let worldStatusRedacted = false;
  const worldRows = tables.get("worlds");
  if (worldRows) {
    for (const row of worldRows) {
      if (row.status !== "active") {
        row.status = "active";
        worldStatusRedacted = true;
      }
    }
  }

  // transfer entries（manifest.tables + wireDigest enrichment——单链）。
  const transferEntries: TransferEntry[] = manifest.tables.map((entry) => ({
    name: entry.name,
    rows: entry.rows,
    sha256: entry.sha256,
    wireDigest: tableWireDigest(tables.get(entry.name) ?? []),
  }));
  return { newWorldId, tables, transferEntries, blockingFields, worldStatusRedacted };
}

/** JSON Pointer 常量重写（列内路径；"@columnIsArray" 后缀 = 列值为数组）。 */
function rewriteJsonPointers(
  value: unknown,
  pointers: readonly string[],
  remap: (id: string) => string,
): unknown {
  let out = value;
  for (const pointer of pointers) {
    const isArrayColumn = pointer.endsWith("@columnIsArray");
    const path = isArrayColumn ? pointer.slice(0, -"@columnIsArray".length) : pointer;
    const segments = path.split("/").filter((segment) => segment !== "");
    if (isArrayColumn) {
      if (!Array.isArray(out)) continue;
      out = out.map((item) => rewritePointerValue(item, segments, remap));
    } else {
      out = rewritePointerValue(out, segments, remap);
    }
  }
  return out;
}

function rewritePointerValue(
  value: unknown,
  segments: readonly string[],
  remap: (id: string) => string,
): unknown {
  if (segments.length === 0) {
    return typeof value === "string" && value !== "" ? remap(value) : value;
  }
  const [head, ...rest] = segments;
  const isArrayItem = head!.endsWith("[]");
  const key = isArrayItem ? head!.slice(0, -2) : head!;
  if (typeof value !== "object" || value === null) return value;
  if (isArrayItem) {
    const list = (value as Record<string, unknown>)[key];
    if (!Array.isArray(list)) return value;
    return {
      ...(value as Record<string, unknown>),
      [key]: list.map((item) => rewritePointerValue(item, rest, remap)),
    };
  }
  // 键缺席 = 无可重写（不新增键——undefined 不是 canonical JSON 值）。
  if (!(key in (value as Record<string, unknown>))) return value;
  return {
    ...(value as Record<string, unknown>),
    [key]: rewritePointerValue((value as Record<string, unknown>)[key], rest, remap),
  };
}

// ---------------------------------------------------------------------------
// service 主面
// ---------------------------------------------------------------------------

/** 迁移台账探针（无 ledger 授权的角色可读的对象级等值证据）。 */
const MIGRATION_PROBES: Readonly<Record<string, string>> = {
  "0041_article_qualification_and_import_entries.sql":
    "SELECT to_regclass('public.article_qualifications') AS probe",
  "0042_realm_transfer_and_import_jobs.sql":
    "SELECT to_regclass('public.realm_import_jobs') AS probe",
  "0043_propagation_node_audience_archived_guard.sql":
    `SELECT CASE WHEN prosrc LIKE '%PROPAGATION_AUDIENCE_WORLD_ARCHIVED%'
       THEN 'append_propagation_node_audience' ELSE NULL END AS probe
     FROM pg_proc
     WHERE oid = 'append_propagation_node_audience(text,text,text,text,text,text)'::regprocedure`,
};

export function createWorldImportService(options: {
  transferPool: Pool;
  workspaceId: string;
}) {
  const { transferPool, workspaceId } = options;

  async function inTx<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await transferPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 台账探针：缺 0041/0042/0043 → 503 MIGRATION_REQUIRED（missing 列完整名）。 */
  async function assertMigrations(client: PoolClient, required: readonly string[]) {
    const missing: string[] = [];
    for (const filename of required) {
      const probe = MIGRATION_PROBES[filename];
      if (!probe) {
        missing.push(filename);
        continue;
      }
      const result = await client.query(probe);
      if (!result.rows[0]?.probe) missing.push(filename);
    }
    if (missing.length > 0) {
      throw new WorldImportError(
        "MIGRATION_REQUIRED",
        "target database is missing required migrations",
        { missing },
      );
    }
  }

  /** 列元数据（可写列集——is_generated='NEVER' AND is_identity='NO'）。 */
  async function loadColumns(
    client: PoolClient,
    tables: readonly string[],
  ): Promise<Map<string, readonly PackColumnSpec[]>> {
    const out = new Map<string, readonly PackColumnSpec[]>();
    for (const table of tables) {
      const result = await client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
      }>(
        `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
           AND is_generated = 'NEVER' AND is_identity = 'NO'
         ORDER BY ordinal_position`,
        [table],
      );
      out.set(table, result.rows.map((row) => ({
        name: row.column_name,
        type: columnTypeOf(table, row.column_name, row.data_type, row.udt_name),
      })));
    }
    return out;
  }

  function columnTypeOf(
    table: string,
    column: string,
    dataType: string,
    udtName: string,
  ): PackColumnSpec["type"] {
    if (table === "world_files" && column === "data") return "fileref";
    if (dataType === "timestamp with time zone") return "timestamptz";
    if (dataType === "bytea") return "bytea";
    if (dataType === "boolean") return "boolean";
    if (dataType === "bigint") return "bigint";
    if (dataType === "integer" || dataType === "smallint") return "int";
    if (dataType === "numeric") return "numeric";
    if (dataType === "jsonb" || dataType === "json") return "jsonb";
    if (dataType === "ARRAY" && udtName === "_text") return "text[]";
    if (dataType === "USER-DEFINED" && udtName === "vector") return "vector";
    return "text";
  }

  /** 表行数上限 service 前置（register 的 DB 级硬上限同值）。 */
  function assertPackLimits(pack: ValidatedPack): void {
    let total = 0;
    for (const entry of pack.manifest.tables) {
      if (entry.rows > PACK_LIMITS.tableRowsMax) {
        throw new WorldImportError(
          "PACK_LIMIT_EXCEEDED",
          `table ${entry.name} exceeds the per-table row limit`,
        );
      }
      total += entry.rows;
    }
    if (total > PACK_LIMITS.totalRowsMax) {
      throw new WorldImportError(
        "PACK_LIMIT_EXCEEDED",
        "pack rows exceed the total limit",
      );
    }
  }

  /** 幂等预查（dry-run tx0 / execute 前置共用）：同包非 cancelled import job。 */
  async function findIdempotentJob(
    client: PoolClient,
    key: { logicalPackHash: string; scopeDigest: string; copyKey: string },
  ) {
    const result = await client.query<{
      id: string;
      status: string;
      result: Record<string, unknown>;
      error_code: string | null;
      mode: string;
      current_attempt_no: string;
    }>(
      `SELECT id, status, result, error_code, mode, current_attempt_no::text
       FROM realm_import_jobs
       WHERE workspace_id = $1 AND direction = 'import'
         AND logical_pack_hash = $2 AND scope_digest = $3 AND copy_key = $4
         AND status <> 'cancelled'`,
      [workspaceId, key.logicalPackHash, key.scopeDigest, key.copyKey],
    );
    return result.rows[0] ?? null;
  }

  /** 最后一条 validation_done 事件的 report（alreadyValidated 读回）。 */
  async function lastValidationReport(client: PoolClient, jobId: string) {
    const result = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM realm_import_job_events
       WHERE workspace_id = $1 AND job_id = $2 AND event_kind = 'validation_done'
       ORDER BY event_seq DESC LIMIT 1`,
      [workspaceId, jobId],
    );
    return result.rows[0]?.payload ?? null;
  }

  /** preserve 冲突预扫（D.6）：WORLD_EXISTS + 全量 workspace 级 id 冲突。 */
  async function scanConflicts(
    client: PoolClient,
    pack: ValidatedPack,
    tables: ReadonlyMap<string, InsertRow[]>,
    newWorldId: string,
  ): Promise<{ worldExists: boolean; collisions: { table: string; id: string }[] }> {
    const worldExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM worlds WHERE workspace_id = $1 AND id = $2) AS exists`,
      [workspaceId, newWorldId],
    );
    const collisions: { table: string; id: string }[] = [];
    for (const [table, rows] of tables) {
      if (rows.length === 0) continue;
      // PK 分量（除 workspace_id）。
      const pkResult = await client.query<{ column_name: string }>(
        // pg_catalog 直查（information_schema.table_constraints 对 SELECT-only
      // 角色实测零行——PK 序/冲突预扫不能用信息视图）。
      `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE n.nspname = 'public' AND t.relname = $1 AND c.contype = 'p'
       ORDER BY array_position(c.conkey, a.attnum)`,
        [table],
      );
      const pkColumns = pkResult.rows
        .map((row) => row.column_name)
        .filter((name) => name !== "workspace_id");
      if (pkColumns.length === 0) continue;
      const probe = await client.query<{ value: Record<string, unknown> }>(
        `SELECT probe_entry.value
         FROM jsonb_array_elements($2::jsonb) AS probe_entry(value)
         WHERE EXISTS (
           SELECT 1 FROM "${table}" AS target
           WHERE target.workspace_id = $1
             AND ${pkColumns.map((column) =>
               `target."${column}" IS NOT DISTINCT FROM probe_entry.value ->> '${column}'`).join(" AND ")})`,
        [
          workspaceId,
          JSON.stringify(rows.map((row) =>
            Object.fromEntries(pkColumns.map((column) => [column, row[column] ?? null])))),
        ],
      );
      if (process.env.REALM_DEBUG_SCAN) {
        console.error("SCAN", table, pkColumns.join(","), rows.length, "rows ->", probe.rows.length, "hits");
      }
      for (const row of probe.rows) {
        collisions.push({
          table,
          id: pkColumns.map((column) => String(row.value[column])).join("|"),
        });
      }
    }
    return { worldExists: worldExists.rows[0]?.exists === true, collisions };
  }

  return {
    /**
     * dry-run（tx0 + tx1）。重复包幂等读回：completed → alreadyImported；
     * validation-failed → alreadyValidated + 既有 report（terminal）；
     * 其余活跃态 → 409 JOB_STATE_CONFLICT；cancelled 不占槽。
     */
    async dryRun(input: {
      bytes: Uint8Array;
      importMode: "preserve" | "copy";
      copyKey?: string;
      operatorPrincipal: string;
    }): Promise<{
      jobId: string;
      report: ImportReport;
      alreadyImported?: boolean;
      alreadyValidated?: boolean;
    }> {
      const copyKey = input.importMode === "copy" ? (input.copyKey ?? "") : "";
      if (input.importMode === "copy" && !COPY_KEY_RE.test(copyKey)) {
        throw new WorldImportError(
          "INVALID_REQUEST",
          "copyKey must match /^[a-z0-9][a-z0-9-]{0,31}$/",
        );
      }
      if (input.importMode === "preserve" && input.copyKey !== undefined) {
        throw new WorldImportError(
          "INVALID_REQUEST",
          "copyKey is forbidden in preserve mode",
        );
      }
      // G.3 全链校验（结构/hash/contentHash）。
      let pack: ValidatedPack;
      try {
        pack = validateRealmPack(input.bytes);
      } catch (error) {
        if (error instanceof RealmPackError) {
          throw new WorldImportError(error.code, error.message);
        }
        throw error;
      }
      assertPackLimits(pack);
      const { manifest } = pack;
      if (manifest.memberships !== undefined) {
        // 导入不绑定 memberships（忽略 + report warning——D.3）。
        void 0;
      }
      const scopeD = manifest.contentHash; // logicalPackHash = contentHash
      const scopeDigestValue = computeScopeDigest(manifest);
      const archiveBytesHash = sha256Hex(input.bytes);

      return inTx(async (client) => {
        await assertMigrations(client, manifest.requiresMigrations);
        const columns = await loadColumns(
          client,
          manifest.tables.map((entry) => entry.name),
        );
        const enrichment = enrichPack(pack, columns, {
          workspaceId,
          copyKey,
          importerPrincipal: input.operatorPrincipal,
        });

        // 幂等预查。
        const existing = await findIdempotentJob(client, {
          logicalPackHash: scopeD,
          scopeDigest: scopeDigestValue,
          copyKey,
        });
        if (existing) {
          if (existing.status === "completed") {
            return {
              jobId: existing.id,
              report: (existing.result.report as ImportReport | undefined)
                ?? emptyReport(manifest),
              alreadyImported: true,
            };
          }
          if (existing.status === "failed") {
            const validation = await lastValidationReport(client, existing.id);
            if (validation && validation.outcome === "failed") {
              return {
                jobId: existing.id,
                report: (validation.report as ImportReport | undefined)
                  ?? emptyReport(manifest),
                alreadyValidated: true,
              };
            }
          }
          throw new WorldImportError(
            "JOB_STATE_CONFLICT",
            `an active import job already exists for this pack: ${existing.id}`,
          );
        }

        const jobId = `job_import_${Date.now().toString(36)}_${
          Math.random().toString(36).slice(2, 8)}`;
        const transferHash = transferEntriesSha256(enrichment.transferEntries);
        try {
          await client.query(
            `SELECT realm_import_job_create($1, $2, 'import', $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              workspaceId,
              jobId,
              scopeD,
              archiveBytesHash,
              scopeDigestValue,
              copyKey,
              manifest.scope.kind,
              manifest.source.worldId,
              input.operatorPrincipal,
              transferHash,
            ],
          );
        } catch (error) {
          const pgCode = (error as { code?: string }).code;
          if (pgCode === "42883" || pgCode === "42P01") {
            throw new WorldImportError(
              "TRANSFER_NOT_PROVISIONED",
              "realm transfer schema is not provisioned (0042 required)",
            );
          }
          throw error;
        }

        // tx1：包校验余部 + 冲突预扫 + copy eligibility + register + finish。
        await client.query(
          "SELECT realm_import_job_begin_validation($1, $2)",
          [workspaceId, jobId],
        );
        // 冲突预扫：preserve 全量（dry-run 报告 WORLD_EXISTS/ID_COLLISION
        // 清单）；copy 的 remapped id 不预扫（确定性新鲜；execute 重扫
        // preserve 语义不变）。
        const conflicts = input.importMode === "preserve"
          ? await scanConflicts(client, pack, enrichment.tables, enrichment.newWorldId)
          : { worldExists: false, collisions: [] };
        const copyEligible = enrichment.blockingFields.length === 0;

        const report: ImportReport = {
          kind: manifest.scope.kind,
          mode: input.importMode,
          tables: manifest.tables.map((entry) => ({ name: entry.name, rows: entry.rows })),
          files: manifest.files.length,
          redactions: [
            ...manifest.redactions,
            ...(enrichment.worldStatusRedacted
              ? [{
                table: "worlds",
                columns: ["status"],
                reason: "imported worlds always start active (archived state is not importable)",
              }]
              : []),
          ],
          warnings: [
            ...(manifest.memberships !== undefined
              ? ["memberships are informational only and were not imported"]
              : []),
            ...(manifest.scope.kind === "archive"
              ? ["archive packs are read-only snapshots; execute is always rejected"]
              : []),
          ],
          targetWorldName: manifest.source.worldName,
          worldExists: conflicts.worldExists,
          idCollisions: conflicts.collisions,
          copyEligible,
          blockingFields: enrichment.blockingFields,
        };

        const failureCode = input.importMode === "preserve" && conflicts.worldExists
          ? "WORLD_EXISTS"
          : conflicts.collisions.length > 0
            ? "ID_COLLISION"
            : !copyEligible
              ? "COPY_INELIGIBLE"
              : null;

        await client.query(
          "SELECT realm_import_register_pack_tables($1, $2, $3::jsonb)",
          [workspaceId, jobId, JSON.stringify(enrichment.transferEntries)],
        );
        await client.query(
          "SELECT realm_import_job_finish_validation($1, $2, $3, $4, $5, $6::jsonb)",
          [
            workspaceId,
            jobId,
            failureCode === null ? "staged" : "failed",
            failureCode,
            failureCode === null ? null : `${failureCode} during dry-run`,
            JSON.stringify(report),
          ],
        );
        return { jobId, report };
      });
    },

    /**
     * execute（tx1 begin_execute → tx2 单事务全或无 → 失败 tx3
     * fail_execute）。重传包重算双 hash 比对 job 不可变列（不等 409
     * PACK_MISMATCH 不动 job）；archive 包永拒 422。
     */
    async execute(input: {
      bytes: Uint8Array;
      jobId: string;
      operatorPrincipal: string;
    }): Promise<{
      jobId: string;
      worldId: string | null;
      alreadyImported: boolean;
      report: ImportReport | null;
    }> {
      let pack: ValidatedPack;
      try {
        pack = validateRealmPack(input.bytes);
      } catch (error) {
        if (error instanceof RealmPackError) {
          throw new WorldImportError(error.code, error.message);
        }
        throw error;
      }
      assertPackLimits(pack);
      const { manifest } = pack;

      // —— 前置读回（非不变量闸门，仅分类）：job 存在性与身份绑定。——
      const job = await inTx(async (client) => {
        const result = await client.query<{
          status: string;
          mode: string;
          copy_key: string;
          logical_pack_hash: string;
          transfer_entries_sha256: string;
          operator_principal: string;
          result: Record<string, unknown>;
        }>(
          `SELECT status, mode, copy_key, logical_pack_hash,
                  transfer_entries_sha256, operator_principal, result
           FROM realm_import_jobs
           WHERE workspace_id = $1 AND id = $2 AND direction = 'import'`,
          [workspaceId, input.jobId],
        );
        return result.rows[0] ?? null;
      });
      if (!job) {
        throw new WorldImportError("JOB_NOT_FOUND", "import job not found");
      }
      if (job.operator_principal !== input.operatorPrincipal) {
        throw new WorldImportError("JOB_NOT_FOUND", "import job not found");
      }
      if (job.mode === "archive") {
        throw new WorldImportError(
          "ARCHIVE_PACK_NOT_IMPORTABLE",
          "archive packs are not importable (dry-run read-only)",
        );
      }
      if (job.status === "completed") {
        return {
          jobId: input.jobId,
          worldId: (job.result.targetWorldId as string | undefined) ?? null,
          alreadyImported: true,
          report: (job.result.report as ImportReport | undefined) ?? null,
        };
      }
      // 双绑定：logical_pack_hash + transfer_entries_sha256（enrichment 的
      // copy_key/mode 一律取 job 行，不取请求参数——C2⑤）。
      if (manifest.contentHash !== job.logical_pack_hash) {
        throw new WorldImportError(
          "PACK_MISMATCH",
          "re-uploaded pack does not match the job logical_pack_hash",
        );
      }

      const columns = await inTx((client) =>
        loadColumns(client, manifest.tables.map((entry) => entry.name)));
      const enrichment = enrichPack(pack, columns, {
        workspaceId,
        copyKey: job.copy_key,
        importerPrincipal: input.operatorPrincipal,
      });
      if (transferEntriesSha256(enrichment.transferEntries)
        !== job.transfer_entries_sha256) {
        throw new WorldImportError(
          "PACK_MISMATCH",
          "re-uploaded pack does not match the job transfer entries digest",
        );
      }

      // tx1：begin_execute（并发 execute 在 FOR UPDATE 上串行，后到者
      // RAISE → 409 JOB_STATE_CONFLICT；validation-failed 终态 RAISE）。
      let attemptNo: bigint;
      try {
        attemptNo = await inTx(async (client) => {
          const result = await client.query<{ realm_import_job_begin_execute: string }>(
            "SELECT realm_import_job_begin_execute($1, $2)",
            [workspaceId, input.jobId],
          );
          return BigInt(result.rows[0]!.realm_import_job_begin_execute);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not executable|not staged|terminal|failed at validation/.test(message)) {
          throw new WorldImportError("JOB_STATE_CONFLICT", message);
        }
        throw error;
      }

      // tx2：单事务全或无（txid 绑定由函数强制）。
      try {
        return await inTx(async (client) => {
          // tx2 首句：job 状态断言（锁内断言由 begin_bootstrap/insert_rows/
          // complete_import 的 FOR UPDATE（definer 上下文）承担——实测 PG17
          // 行锁子句要求 DML 特权，SELECT-only 的 realm_transfer 不能直接
          // FOR UPDATE；此处只读复核分类，真正串行点在函数内）。
          const locked = await client.query<{ status: string; current_attempt_no: string }>(
            `SELECT status, current_attempt_no::text
             FROM realm_import_jobs
             WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, input.jobId],
          );
          const row = locked.rows[0];
          if (!row || row.status !== "executing"
            || BigInt(row.current_attempt_no) !== attemptNo) {
            throw new WorldImportError(
              "JOB_STATE_CONFLICT",
              "job is no longer executing with the claimed attempt",
            );
          }

          // 冲突重扫（preserve；execute 时刻）。
          if (job.copy_key === "") {
            const conflicts = await scanConflicts(
              client,
              pack,
              enrichment.tables,
              enrichment.newWorldId,
            );
            if (conflicts.worldExists) {
              throw new WorldImportError(
                "WORLD_EXISTS",
                "target world already exists",
              );
            }
            if (conflicts.collisions.length > 0) {
              throw new WorldImportError(
                "ID_COLLISION",
                "pack ids collide with existing rows",
                { missing: conflicts.collisions },
              );
            }
          }

          // bootstrap（孤儿清理 → worlds 全行 → 绑定 txid+worlds digest →
          // owner membership → content_log('worlds') 同事务）。
          const worldRows = enrichment.tables.get("worlds");
          if (!worldRows || worldRows.length !== 1) {
            throw new WorldImportError(
              "INVALID_PACK",
              "pack must contain exactly one worlds row",
            );
          }
          const worldRow = { ...worldRows[0]!, status: "active" };
          await client.query(
            "SELECT realm_import_begin_bootstrap($1, $2, $3, $4, $5::jsonb)",
            [
              workspaceId,
              input.jobId,
              attemptNo.toString(),
              enrichment.newWorldId,
              JSON.stringify(worldRow),
            ],
          );

          // 拓扑序逐表 insert_rows（worlds/memberships/派生表不经此函数）。
          for (const table of PACK_TABLE_ORDER) {
            if (table === "worlds") continue;
            const rows = enrichment.tables.get(table);
            if (!rows || rows.length === 0) continue;
            await client.query(
              "SELECT realm_import_insert_rows($1, $2, $3, $4, $5::jsonb)",
              [
                workspaceId,
                input.jobId,
                attemptNo.toString(),
                table,
                JSON.stringify(rows),
              ],
            ).catch((error: unknown) => {
              throw new WorldImportError(
                "IMPORT_FAILED",
                `insert_rows failed for ${table}: ${
                  error instanceof Error ? error.message : String(error)}`,
              );
            });
          }

          // contentDigest 闭环（content_log 本 attempt 实读 → JS 实算）。
          const log = await client.query<{
            table_name: string;
            row_count: string;
            wire_digest: string;
          }>(
            `SELECT table_name, row_count::text, wire_digest
             FROM realm_import_content_log
             WHERE workspace_id = $1 AND job_id = $2 AND attempt_no = $3`,
            [workspaceId, input.jobId, attemptNo.toString()],
          );
          const contentDigestValue = contentDigest(log.rows.map((row) => ({
            name: row.table_name,
            rows: Number(row.row_count),
            wireDigest: row.wire_digest,
          })));

          const report: ImportReport = {
            ...emptyReport(manifest),
            redactions: manifest.redactions,
          };
          await client.query(
            "SELECT realm_import_job_complete_import($1, $2, $3, $4, $5::jsonb)",
            [
              workspaceId,
              input.jobId,
              attemptNo.toString(),
              enrichment.newWorldId,
              JSON.stringify({
                targetWorldId: enrichment.newWorldId,
                contentHash: manifest.contentHash,
                contentDigest: contentDigestValue,
                report,
              }),
            ],
          );
          return {
            jobId: input.jobId,
            worldId: enrichment.newWorldId,
            alreadyImported: false,
            report,
          };
        });
      } catch (error) {
        // tx3：失败簿记（孤儿清理同路径）。
        const code = error instanceof WorldImportError ? error.code : "IMPORT_FAILED";
        const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
        await inTx((client) =>
          client.query(
            "SELECT realm_import_job_fail_execute($1, $2, $3, $4, $5)",
            [workspaceId, input.jobId, attemptNo.toString(), code, message],
          )).catch(() => undefined);
        throw error;
      }
    },

    /** cancel（pending/validating/staged 可取消；executing → 409；已
     *  cancelled → 幂等读回）。operator 断言在 route 层。 */
    async cancel(input: {
      jobId: string;
    }): Promise<{ status: "cancelled"; idempotent: boolean }> {
      return inTx(async (client) => {
        // 只读复核（cancel 的 FOR UPDATE 在受控函数内以 definer 承担）。
        const job = await client.query<{ status: string }>(
          `SELECT status FROM realm_import_jobs
           WHERE workspace_id = $1 AND id = $2 AND direction = 'import'`,
          [workspaceId, input.jobId],
        );
        const row = job.rows[0];
        if (!row) {
          throw new WorldImportError("JOB_NOT_FOUND", "import job not found");
        }
        if (row.status === "cancelled") {
          return { status: "cancelled" as const, idempotent: true };
        }
        try {
          await client.query(
            "SELECT realm_import_job_cancel($1, $2)",
            [workspaceId, input.jobId],
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new WorldImportError("JOB_STATE_CONFLICT", message);
        }
        return { status: "cancelled" as const, idempotent: false };
      });
    },

    /** reconcile（懒触发）：stale pending/validating/executing（>30min）→
     *  recover_crash('PROCESS_CRASH')。返回恢复数量。 */
    async reconcile(): Promise<number> {
      return inTx(async (client) => {
        const stale = await client.query<{ id: string }>(
          `SELECT id FROM realm_import_jobs
           WHERE workspace_id = $1
             AND status IN ('pending', 'validating', 'executing')
             AND updated_at < CURRENT_TIMESTAMP - interval '30 minutes'`,
          [workspaceId],
        );
        for (const row of stale.rows) {
          await client.query(
            "SELECT realm_import_job_recover_crash($1, $2, 'PROCESS_CRASH')",
            [workspaceId, row.id],
          );
        }
        return stale.rows.length;
      });
    },

    /** status：job + 事件时间线（operator/目标 owner 判定在 route 层）。 */
    async getStatus(jobId: string): Promise<{
      id: string;
      status: string;
      mode: string;
      errorCode: string | null;
      result: Record<string, unknown>;
      operatorPrincipal: string;
      targetWorldId: string | null;
      updatedAt: string;
      events: readonly { kind: string; seq: number; at: string; payload: unknown }[];
    } | null> {
      return inTx(async (client) => {
        const job = await client.query<{
          id: string;
          status: string;
          mode: string;
          error_code: string | null;
          result: Record<string, unknown>;
          operator_principal: string;
          target_world_id: string | null;
          updated_at: Date;
        }>(
          `SELECT id, status, mode, error_code, result, operator_principal,
                  target_world_id, updated_at
           FROM realm_import_jobs
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, jobId],
        );
        const row = job.rows[0];
        if (!row) return null;
        const events = await client.query<{
          event_kind: string;
          event_seq: string;
          created_at: Date;
          payload: unknown;
        }>(
          `SELECT event_kind, event_seq, created_at, payload
           FROM realm_import_job_events
           WHERE workspace_id = $1 AND job_id = $2
           ORDER BY event_seq`,
          [workspaceId, jobId],
        );
        return {
          id: row.id,
          status: row.status,
          mode: row.mode,
          errorCode: row.error_code,
          result: row.result,
          operatorPrincipal: row.operator_principal,
          targetWorldId: row.target_world_id,
          updatedAt: row.updated_at.toISOString(),
          events: events.rows.map((event) => ({
            kind: event.event_kind,
            seq: Number(event.event_seq),
            at: event.created_at.toISOString(),
            payload: event.payload,
          })),
        };
      });
    },

    /** jobs 列表（仅 operator 本人；updated_at DESC；limit/offset）。 */
    async listJobs(input: {
      operatorPrincipal: string;
      limit: number;
      offset: number;
    }): Promise<readonly {
      id: string;
      direction: string;
      status: string;
      mode: string;
      errorCode: string | null;
      createdAt: string;
      updatedAt: string;
    }[]> {
      return inTx(async (client) => {
        const result = await client.query<{
          id: string;
          direction: string;
          status: string;
          mode: string;
          error_code: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT id, direction, status, mode, error_code, created_at, updated_at
           FROM realm_import_jobs
           WHERE workspace_id = $1 AND operator_principal = $2
           ORDER BY updated_at DESC, id
           LIMIT $3 OFFSET $4`,
          [workspaceId, input.operatorPrincipal, input.limit, input.offset],
        );
        return result.rows.map((row) => ({
          id: row.id,
          direction: row.direction,
          status: row.status,
          mode: row.mode,
          errorCode: row.error_code,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        }));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function computeScopeDigest(manifest: { scope: Parameters<typeof importScopeDigest>[0] }): string {
  return importScopeDigest(manifest.scope);
}

function emptyReport(manifest: {
  scope: { kind: string };
  tables: readonly { name: string; rows: number }[];
  files: readonly unknown[];
  redactions: readonly { table: string; columns: readonly string[]; reason: string }[];
  source: { worldName: string };
}): ImportReport {
  return {
    kind: manifest.scope.kind,
    mode: "preserve",
    tables: manifest.tables.map((entry) => ({ name: entry.name, rows: entry.rows })),
    files: manifest.files.length,
    redactions: manifest.redactions,
    warnings: [],
    targetWorldName: manifest.source.worldName,
    worldExists: false,
    idCollisions: [],
    copyEligible: true,
    blockingFields: [],
  };
}
