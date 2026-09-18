/**
 * v37 §A.1/§D/§F.4：`.realm` 导出 repository（realm_transfer 专用池）。
 *
 * 导出事务协议（F.4）：REPEATABLE READ read-write 单事务——
 * membership FOR SHARE 重验 owner（首语句）→ scope/闭包解析 → 内容 SELECT
 * （声明序）→ redaction → 计算 archive bytes → realm_import_job_create
 * （export 方向 transfer_entries_sha256=NULL，CHECK 强制）→
 * realm_import_job_complete_export(result={tables,files,scopeDigest,
 * contentHash}) → COMMIT → 响应字节（与 archive_bytes_hash 同源同变量）。
 *
 * 信任边界（§E.2 同级条目）：export result 表项摘要由本服务在同一事务从
 * 同一 ZIP 字节派生；complete_export 不保存/不重算 summary digest（不宣称
 * DB 全链闭合）。
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PACK_LIMITS,
  REQUIRES_MIGRATIONS,
  buildRealmPack,
  computeContentHash,
  ndjsonBytes,
  scopeDigest,
  serializeManifest,
  sha256Hex,
  type PackColumnSpec,
  type PackColumnType,
  type PackScope,
  type PackTableData,
  type RealmManifest,
} from "../../modules/world-transfer/realm-pack.ts";
import {
  PACK_TABLE_ORDER,
  TEXT_ARRAY_NON_NULL_COLUMNS,
  matrixRow,
  tierAllows,
} from "../../modules/world-transfer/export-matrix.ts";

export type ExportErrorCode =
  | "NOT_OWNER"
  | "WORLD_NOT_FOUND"
  | "INCOMPLETE_CLOSURE"
  | "TEMPLATE_UNSUPPORTED_BRANCH"
  | "ARRAY_NULL_ELEMENT"
  | "PACK_LIMIT_EXCEEDED"
  | "TRANSFER_NOT_PROVISIONED";

export class WorldTransferError extends Error {
  readonly code: ExportErrorCode;
  readonly details?: unknown;
  constructor(code: ExportErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorldTransferError";
    this.code = code;
    this.details = details;
  }
}

/** D.3 请求 scope（唯一字段集）。 */
export interface ExportRequestScope {
  worldId: string;
  mode: "full" | "template" | "selection";
  storyIds?: readonly string[];
  recordIds?: readonly string[];
  includeLinked?: boolean;
  includeMemberships?: boolean;
}

export interface ExportResult {
  bytes: Uint8Array;
  jobId: string;
  archiveBytesHash: string;
  contentHash: string;
  scopeDigest: string;
  tableSummary: readonly { name: string; rows: number; sha256: string }[];
  fileCount: number;
  manifest: RealmManifest;
}

// ---------------------------------------------------------------------------
// 列元数据（information_schema 驱动；generated/identity 派生列排除——C1）
// ---------------------------------------------------------------------------

async function loadColumnSpecs(
  client: PoolClient,
  table: string,
): Promise<PackColumnSpec[]> {
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
  return result.rows.map((row) => ({
    name: row.column_name,
    type: columnType(table, row.column_name, row.data_type, row.udt_name),
  }));
}

function columnType(
  table: string,
  column: string,
  dataType: string,
  udtName: string,
): PackColumnType {
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

/** timestamptz 唯一 canonical 点（C1）：6 位小数 UTC text 直出，不经 driver。 */
function selectList(columns: readonly PackColumnSpec[]): string {
  return columns
    .map((column) =>
      column.type === "timestamptz"
        ? `to_char("${column.name}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column.name}"`
        : column.type === "fileref"
          ? `id AS "${column.name}"` // world_files.data → $fileRef(id)
          : `"${column.name}"`)
    .join(", ");
}

/** 确定性行序（重导出字节一致的前提）：主键列序。 */
async function primaryKeyColumns(
  client: PoolClient,
  table: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
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
  return result.rows.map((row) => row.column_name);
}

// ---------------------------------------------------------------------------
// 查询拼装（参数编号安全）
// ---------------------------------------------------------------------------

class Query {
  readonly values: unknown[];
  private readonly conditions: string[] = [];
  constructor(workspaceId: string) {
    this.values = [workspaceId];
  }
  andIn(column: string, ids: ReadonlySet<string>): this {
    this.values.push([...ids]);
    this.conditions.push(`${column} = ANY($${this.values.length}::text[])`);
    return this;
  }
  andSql(sql: string, ...values: unknown[]): this {
    const base = this.values.length;
    this.values.push(...values);
    let offset = 0;
    this.conditions.push(sql.replace(/\?/g, () => `$${base + (offset += 1)}`));
    return this;
  }
  where(): string {
    return this.conditions.length === 0 ? "" : `AND ${this.conditions.join(" AND ")}`;
  }
}

// ---------------------------------------------------------------------------
// 闭包上下文（selection 的 id 集合；full/template 用 null 表示该层无过滤）
// ---------------------------------------------------------------------------

interface Closure {
  worldlineIds: Set<string> | null;
  recordIds: Set<string> | null;
  storyIds: Set<string> | null;
  instanceIds: Set<string> | null;
  continuityIds: Set<string> | null;
  definitionIds: Set<string> | null;
  skillDefinitionIds: Set<string> | null;
  assetDefinitionIds: Set<string> | null;
  effectDefinitionIds: Set<string> | null;
  eventIds: Set<string> | null;
  claimIds: Set<string> | null;
  articleIds: Set<string> | null;
  proposalIds: Set<string> | null;
  revisionIds: Set<string> | null;
  campaignIds: Set<string> | null;
  packetIds: Set<string> | null;
  fileIds: Set<string> | null;
}

interface ExtractionContext {
  workspaceId: string;
  worldId: string;
  kind: "template" | "full" | "archive";
  rootWorldlineId: string | null;
  closure: Closure;
  redactions: { table: string; columns: string[]; reason: string }[];
}

const NO_CLOSURE: Closure = {
  worldlineIds: null,
  recordIds: null,
  storyIds: null,
  instanceIds: null,
  continuityIds: null,
  definitionIds: null,
  skillDefinitionIds: null,
  assetDefinitionIds: null,
  effectDefinitionIds: null,
  eventIds: null,
  claimIds: null,
  articleIds: null,
  proposalIds: null,
  revisionIds: null,
  campaignIds: null,
  packetIds: null,
  fileIds: null,
};

export function createWorldTransferRepository() {
  /** 单表抽取（声明列序 + PK 行序 + text[] invariant + 行数上限）。 */
  async function extractTable(
    client: PoolClient,
    ctx: ExtractionContext,
    table: string,
    build?: (query: Query) => Query,
  ): Promise<{ columns: readonly PackColumnSpec[]; rows: Record<string, unknown>[] }> {
    const columns = await loadColumnSpecs(client, table);
    const query = new Query(ctx.workspaceId);
    if (build) build(query);
    const pk = await primaryKeyColumns(client, table);
    const orderBy = pk.length > 0
      ? `ORDER BY ${pk.map((c) => `"${c}"`).join(", ")}`
      : "ORDER BY 1";
    const result = await client.query(
      `SELECT ${selectList(columns)} FROM "${table}"
       WHERE workspace_id = $1 ${query.where()}
       ${orderBy}`,
      query.values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (rows.length > PACK_LIMITS.tableRowsMax) {
      throw new WorldTransferError(
        "PACK_LIMIT_EXCEEDED",
        `table ${table} exceeds the per-table row limit`,
      );
    }
    // text[] 元素 invariant（M5）：命中 NULL 元素 → 422 不出包。
    for (const qualified of TEXT_ARRAY_NON_NULL_COLUMNS) {
      const [tableName, column] = qualified.split(".") as [string, string];
      if (tableName !== table) continue;
      for (const row of rows) {
        const value = row[column];
        if (Array.isArray(value) && value.some((element) => element === null)) {
          throw new WorldTransferError(
            "ARRAY_NULL_ELEMENT",
            `NULL element in ${qualified}`,
          );
        }
      }
    }
    return { columns, rows };
  }

  return { extractTable };
}

// ---------------------------------------------------------------------------
// 闭包解析（D.4 硬规则：违反即失败不出包）
// ---------------------------------------------------------------------------

type IdSet = Set<string>;

async function idSet(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
  column = "id",
): Promise<IdSet> {
  const result = await client.query(sql, params as unknown[]);
  return new Set(result.rows.map((row) => String(row[column])));
}

async function idPairs(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  const result = await client.query(sql, params as unknown[]);
  return result.rows as Record<string, unknown>[];
}

function requireSubset(
  table: string,
  refs: Iterable<string | null | undefined>,
  packed: IdSet,
  missing: { table: string; id: string }[],
): void {
  for (const ref of refs) {
    if (ref === null || ref === undefined || ref === "") continue;
    if (!packed.has(ref)) missing.push({ table, id: ref });
  }
}

function requireArraySubset(
  table: string,
  refs: Iterable<readonly string[]>,
  packed: IdSet,
  missing: { table: string; id: string }[],
): void {
  for (const list of refs) {
    for (const ref of list) {
      if (!packed.has(ref)) missing.push({ table, id: ref });
    }
  }
}

/** selection 闭包（D.4；includeLinked 递归补拉，环检测）。 */
async function resolveSelectionClosure(
  client: PoolClient,
  ctx: ExtractionContext,
  request: ExportRequestScope,
): Promise<Closure> {
  const { workspaceId, worldId } = ctx;
  const missing: { table: string; id: string }[] = [];

  // records：显式 recordIds ∪ storyIds 名下 records。
  const recordIds: IdSet = new Set(request.recordIds ?? []);
  if (request.storyIds && request.storyIds.length > 0) {
    for (const id of await idSet(
      client,
      `SELECT id FROM records WHERE workspace_id = $1 AND world_id = $2
       AND story_id = ANY($3::text[])`,
      [workspaceId, worldId, request.storyIds],
    )) recordIds.add(id);
  }
  // 显式列出的 record 必须属于本世界。
  const knownRecords = await idSet(
    client,
    `SELECT id FROM records WHERE workspace_id = $1 AND world_id = $2`,
    [workspaceId, worldId],
  );
  for (const id of recordIds) {
    if (!knownRecords.has(id)) missing.push({ table: "records", id });
  }
  // includeLinked：linked_record_id 递归补拉（环检测 = visited 集合）。
  if (request.includeLinked) {
    for (;;) {
      const rows = await idPairs(
        client,
        `SELECT id, linked_record_id FROM records
         WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])
           AND linked_record_id IS NOT NULL`,
        [workspaceId, worldId, [...recordIds]],
      );
      let grew = false;
      for (const row of rows) {
        const linked = String(row.linked_record_id);
        if (!recordIds.has(linked)) {
          if (!knownRecords.has(linked)) {
            missing.push({ table: "records", id: linked });
            continue;
          }
          recordIds.add(linked);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }
  // linked_record_id 闭包：未 includeLinked 时指向未列入记录 → fail-closed。
  const recordLinks = await idPairs(
    client,
    `SELECT id, story_id, worldline_id, linked_record_id FROM records
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const storyIds: IdSet = new Set(request.storyIds ?? []);
  for (const row of recordLinks) {
    storyIds.add(String(row.story_id));
    if (row.linked_record_id !== null && !recordIds.has(String(row.linked_record_id))) {
      missing.push({ table: "records", id: String(row.linked_record_id) });
    }
  }
  // stories 存在性与归属。
  const storyRows = await idPairs(
    client,
    `SELECT id, worldline_id FROM stories
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
    [workspaceId, worldId, [...storyIds]],
  );
  const foundStories = new Set(storyRows.map((row) => String(row.id)));
  for (const id of storyIds) {
    if (!foundStories.has(id)) missing.push({ table: "stories", id });
  }
  // worldlines：stories 的 worldline + 祖先链。
  const worldlineIds: IdSet = new Set(storyRows.map((row) => String(row.worldline_id)));
  for (;;) {
    const rows = await idPairs(
      client,
      `SELECT id, parent_worldline_id FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])
         AND parent_worldline_id IS NOT NULL`,
      [workspaceId, worldId, [...worldlineIds]],
    );
    let grew = false;
    for (const row of rows) {
      const parent = String(row.parent_worldline_id);
      if (!worldlineIds.has(parent)) {
        worldlineIds.add(parent);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const sceneIds = await idSet(
    client,
    `SELECT id FROM scenes WHERE workspace_id = $1 AND world_id = $2
     AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const instanceRows = await idPairs(
    client,
    `SELECT id, continuity_id, predecessor_instance_id FROM character_instances
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const instanceIds: IdSet = new Set(instanceRows.map((row) => String(row.id)));
  const continuityIds: IdSet = new Set(instanceRows.map((row) => String(row.continuity_id)));
  for (const row of instanceRows) {
    if (row.predecessor_instance_id !== null
      && !instanceIds.has(String(row.predecessor_instance_id))) {
      missing.push({ table: "character_instances", id: String(row.predecessor_instance_id) });
    }
  }
  const definitionIds = await idSet(
    client,
    `SELECT definition_id AS id FROM character_continuities
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
    [workspaceId, worldId, [...continuityIds]],
  );

  const participantRows = await idPairs(
    client,
    `SELECT id, character_instance_id FROM participants
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const participantIds: IdSet = new Set(participantRows.map((row) => String(row.id)));
  for (const row of participantRows) {
    if (row.character_instance_id !== null
      && !instanceIds.has(String(row.character_instance_id))) {
      missing.push({ table: "character_instances", id: String(row.character_instance_id) });
    }
  }

  const policyRows = await idPairs(
    client,
    `SELECT id, scene_id, private_character_instance_id, audience_character_instance_ids
     FROM visibility_policies
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const policyIds: IdSet = new Set(policyRows.map((row) => String(row.id)));
  for (const row of policyRows) {
    if (row.scene_id !== null && !sceneIds.has(String(row.scene_id))) {
      missing.push({ table: "scenes", id: String(row.scene_id) });
    }
    if (row.private_character_instance_id !== null
      && !instanceIds.has(String(row.private_character_instance_id))) {
      missing.push({
        table: "character_instances",
        id: String(row.private_character_instance_id),
      });
    }
    requireArraySubset(
      "character_instances",
      [(row.audience_character_instance_ids as string[] | null) ?? []],
      instanceIds,
      missing,
    );
  }

  const eventRows = await idPairs(
    client,
    `SELECT id, scene_id, actor_participant_id, visibility_policy_id
     FROM events
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const eventIds: IdSet = new Set(eventRows.map((row) => String(row.id)));
  for (const row of eventRows) {
    if (row.scene_id !== null && !sceneIds.has(String(row.scene_id))) {
      missing.push({ table: "scenes", id: String(row.scene_id) });
    }
    if (row.actor_participant_id !== null
      && !participantIds.has(String(row.actor_participant_id))) {
      missing.push({ table: "participants", id: String(row.actor_participant_id) });
    }
    if (row.visibility_policy_id !== null
      && !policyIds.has(String(row.visibility_policy_id))) {
      missing.push({ table: "visibility_policies", id: String(row.visibility_policy_id) });
    }
  }

  const headRows = await idPairs(
    client,
    `SELECT record_id, last_event_id FROM record_heads
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  for (const row of headRows) {
    if (row.last_event_id !== null && !eventIds.has(String(row.last_event_id))) {
      missing.push({ table: "events", id: String(row.last_event_id) });
    }
  }

  const observationRows = await idPairs(
    client,
    `SELECT observer_character_instance_id, source_event_id FROM observations
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  for (const row of observationRows) {
    if (!instanceIds.has(String(row.observer_character_instance_id))) {
      missing.push({
        table: "character_instances",
        id: String(row.observer_character_instance_id),
      });
    }
    if (row.source_event_id !== null && !eventIds.has(String(row.source_event_id))) {
      missing.push({ table: "events", id: String(row.source_event_id) });
    }
  }

  const skillDefinitionIds = await idSet(
    client,
    `SELECT DISTINCT skill_definition_id AS id FROM character_skills
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const assetDefinitionIds = await idSet(
    client,
    `SELECT DISTINCT asset_definition_id AS id FROM character_assets
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const receiptRows = await idPairs(
    client,
    `SELECT id, actor_character_instance_id, source_event_id FROM action_receipts
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const receiptIds: IdSet = new Set(receiptRows.map((row) => String(row.id)));
  for (const row of receiptRows) {
    if (!instanceIds.has(String(row.actor_character_instance_id))) {
      missing.push({
        table: "character_instances",
        id: String(row.actor_character_instance_id),
      });
    }
    if (row.source_event_id !== null && !eventIds.has(String(row.source_event_id))) {
      missing.push({ table: "events", id: String(row.source_event_id) });
    }
  }
  const effectDefinitionIds = await idSet(
    client,
    `SELECT DISTINCT effect_definition_id AS id FROM character_effects
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  const effectRefs = await idPairs(
    client,
    `SELECT source_action_receipt_id FROM character_effects
     WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($3::text[])`,
    [workspaceId, worldId, [...recordIds]],
  );
  for (const row of effectRefs) {
    if (row.source_action_receipt_id !== null
      && !receiptIds.has(String(row.source_action_receipt_id))) {
      missing.push({ table: "action_receipts", id: String(row.source_action_receipt_id) });
    }
  }

  // avatar 文件闭包（character_definitions profile.avatar_file_id）。
  const avatarRows = await idPairs(
    client,
    `SELECT id, profile->>'avatar_file_id' AS avatar FROM character_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
    [workspaceId, worldId, [...definitionIds]],
  );
  const fileIds: IdSet = new Set();
  for (const row of avatarRows) {
    if (row.avatar !== null && typeof row.avatar === "string" && row.avatar !== "") {
      fileIds.add(String(row.avatar));
    }
  }

  // 知识链（affected worldlines 内全量 + 引用闭包校验）。
  const worldlineList = [...worldlineIds];
  const entityIds = await idSet(
    client,
    `SELECT id FROM world_entities
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const claimRows = await idPairs(
    client,
    `SELECT id, subject_entity_id, source_record_id, source_event_id, supersedes_claim_id
     FROM world_claims
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const claimIds: IdSet = new Set(claimRows.map((row) => String(row.id)));
  for (const row of claimRows) {
    if (!entityIds.has(String(row.subject_entity_id))) {
      missing.push({ table: "world_entities", id: String(row.subject_entity_id) });
    }
    if (row.source_record_id !== null && !recordIds.has(String(row.source_record_id))) {
      missing.push({ table: "records", id: String(row.source_record_id) });
    }
    if (row.source_event_id !== null && !eventIds.has(String(row.source_event_id))) {
      missing.push({ table: "events", id: String(row.source_event_id) });
    }
    if (row.supersedes_claim_id !== null
      && !claimIds.has(String(row.supersedes_claim_id))) {
      missing.push({ table: "world_claims", id: String(row.supersedes_claim_id) });
    }
  }
  const relationRows = await idPairs(
    client,
    `SELECT subject_entity_id, object_entity_id, source_claim_id FROM world_relations
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  for (const row of relationRows) {
    if (!entityIds.has(String(row.subject_entity_id))) {
      missing.push({ table: "world_entities", id: String(row.subject_entity_id) });
    }
    if (!entityIds.has(String(row.object_entity_id))) {
      missing.push({ table: "world_entities", id: String(row.object_entity_id) });
    }
    if (!claimIds.has(String(row.source_claim_id))) {
      missing.push({ table: "world_claims", id: String(row.source_claim_id) });
    }
  }
  const articleRows = await idPairs(
    client,
    `SELECT id, claim_ids, source_event_ids FROM world_articles
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const articleIds: IdSet = new Set();
  for (const row of articleRows) {
    const claimRefs = (row.claim_ids as string[]) ?? [];
    const eventRefs = (row.source_event_ids as string[]) ?? [];
    const before = missing.length;
    requireArraySubset("world_claims", [claimRefs], claimIds, missing);
    requireArraySubset("events", [eventRefs], eventIds, missing);
    // D.4：文章引用不可部分解析——缺失即整包失败；行仍列入（失败不出包）。
    if (missing.length === before) articleIds.add(String(row.id));
  }
  const edgeRows = await idPairs(
    client,
    `SELECT from_claim_id, to_claim_id FROM causal_edges
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  for (const row of edgeRows) {
    if (!claimIds.has(String(row.from_claim_id))) {
      missing.push({ table: "world_claims", id: String(row.from_claim_id) });
    }
    if (!claimIds.has(String(row.to_claim_id))) {
      missing.push({ table: "world_claims", id: String(row.to_claim_id) });
    }
  }

  // canon 链（proposals ↔ revisions fixpoint）。
  let proposalIds: IdSet = new Set();
  let revisionIds: IdSet = new Set();
  for (;;) {
    const proposalRows = await idPairs(
      client,
      `SELECT id, article_id, claim_ids FROM canon_proposals
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
      [workspaceId, worldId, worldlineList],
    );
    const nextProposals: IdSet = new Set();
    for (const row of proposalRows) {
      const articleRef = row.article_id as string | null;
      const claimRefs = (row.claim_ids as string[]) ?? [];
      const proposalRequiredByRevision = await idSet(
        client,
        `SELECT accepted_proposal_id AS id FROM canon_revisions
         WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
        [workspaceId, worldId, [...revisionIds]],
      );
      void proposalRequiredByRevision;
      const articleOk = articleRef === null || articleIds.has(articleRef);
      const claimsOk = claimRefs.every((ref) => claimIds.has(ref));
      const neededByRevision = proposalRows.length > 0 && revisionIds.size > 0
        && await idSet(
          client,
          `SELECT id FROM canon_revisions
           WHERE workspace_id = $1 AND world_id = $2
             AND accepted_proposal_id = ANY($3::text[])`,
          [workspaceId, worldId, [String(row.id)]],
        ).then((set) => set.size > 0);
      if ((articleOk && claimsOk) || neededByRevision) nextProposals.add(String(row.id));
    }
    const revisionRows = await idPairs(
      client,
      `SELECT id, parent_revision_id, accepted_proposal_id FROM canon_revisions
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
      [workspaceId, worldId, worldlineList],
    );
    const nextRevisions: IdSet = new Set();
    for (const row of revisionRows) {
      const parent = row.parent_revision_id as string | null;
      const proposal = String(row.accepted_proposal_id);
      if (nextProposals.has(proposal)) nextRevisions.add(String(row.id));
      else if (parent !== null && nextRevisions.has(parent)) nextRevisions.add(String(row.id));
      else if (parent !== null && revisionIds.has(parent)) nextRevisions.add(String(row.id));
    }
    if (nextProposals.size === proposalIds.size && nextRevisions.size === revisionIds.size) {
      proposalIds = nextProposals;
      revisionIds = nextRevisions;
      break;
    }
    proposalIds = nextProposals;
    revisionIds = nextRevisions;
  }
  // 校验：revisions 的 parent/proposal 必须解析。
  const revisionCheck = await idPairs(
    client,
    `SELECT id, parent_revision_id, accepted_proposal_id FROM canon_revisions
     WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
    [workspaceId, worldId, revisionIds.size > 0 ? [...revisionIds] : ["__none__"]],
  );
  for (const row of revisionCheck) {
    if (row.parent_revision_id !== null
      && !revisionIds.has(String(row.parent_revision_id))) {
      missing.push({ table: "canon_revisions", id: String(row.parent_revision_id) });
    }
    if (!proposalIds.has(String(row.accepted_proposal_id))) {
      missing.push({ table: "canon_proposals", id: String(row.accepted_proposal_id) });
    }
  }
  const audienceRows = await idPairs(
    client,
    `SELECT revision_id, continuity_id FROM canon_revision_audiences
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  for (const row of audienceRows) {
    if (!revisionIds.has(String(row.revision_id))) {
      missing.push({ table: "canon_revisions", id: String(row.revision_id) });
    }
    if (!continuityIds.has(String(row.continuity_id))) {
      missing.push({ table: "character_continuities", id: String(row.continuity_id) });
    }
  }
  const campaignRows = await idPairs(
    client,
    `SELECT id, canon_revision_id, root_claim_ids FROM information_campaigns
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const campaignIds: IdSet = new Set();
  for (const row of campaignRows) {
    const revisionRef = row.canon_revision_id as string | null;
    const roots = (row.root_claim_ids as string[]) ?? [];
    const before = missing.length;
    if (revisionRef !== null && !revisionIds.has(revisionRef)) {
      missing.push({ table: "canon_revisions", id: revisionRef });
    }
    requireArraySubset("world_claims", [roots], claimIds, missing);
    if (missing.length === before) campaignIds.add(String(row.id));
  }
  const packetRows = await idPairs(
    client,
    `SELECT id, campaign_id, parent_packet_id, claim_ids, omitted_claim_ids
     FROM information_packets
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const packetIds: IdSet = new Set();
  for (const row of packetRows) {
    const before = missing.length;
    if (!campaignIds.has(String(row.campaign_id))) {
      missing.push({ table: "information_campaigns", id: String(row.campaign_id) });
    }
    if (row.parent_packet_id !== null && !packetIds.has(String(row.parent_packet_id))) {
      missing.push({ table: "information_packets", id: String(row.parent_packet_id) });
    }
    requireArraySubset("world_claims", [(row.claim_ids as string[]) ?? []], claimIds, missing);
    requireArraySubset(
      "world_claims",
      [(row.omitted_claim_ids as string[]) ?? []],
      claimIds,
      missing,
    );
    if (missing.length === before) packetIds.add(String(row.id));
  }
  const nodeIds = await idSet(
    client,
    `SELECT node_key AS id FROM propagation_nodes
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  const routeRows = await idPairs(
    client,
    `SELECT from_node, to_node FROM propagation_routes
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  for (const row of routeRows) {
    if (!nodeIds.has(String(row.from_node))) {
      missing.push({ table: "propagation_nodes", id: String(row.from_node) });
    }
    if (!nodeIds.has(String(row.to_node))) {
      missing.push({ table: "propagation_nodes", id: String(row.to_node) });
    }
  }
  const nodeAudienceRows = await idPairs(
    client,
    `SELECT continuity_id, node_key FROM propagation_node_audiences
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = ANY($3::text[])`,
    [workspaceId, worldId, worldlineList],
  );
  for (const row of nodeAudienceRows) {
    if (!continuityIds.has(String(row.continuity_id))) {
      missing.push({ table: "character_continuities", id: String(row.continuity_id) });
    }
    if (!nodeIds.has(String(row.node_key))) {
      missing.push({ table: "propagation_nodes", id: String(row.node_key) });
    }
  }

  if (missing.length > 0) {
    throw new WorldTransferError(
      "INCOMPLETE_CLOSURE",
      "selection closure references rows outside the pack",
      { missing },
    );
  }

  return {
    worldlineIds,
    recordIds,
    storyIds,
    instanceIds,
    continuityIds,
    definitionIds,
    skillDefinitionIds,
    assetDefinitionIds,
    effectDefinitionIds,
    eventIds,
    claimIds,
    articleIds,
    proposalIds,
    revisionIds,
    campaignIds,
    packetIds,
    fileIds,
  };
}

// ---------------------------------------------------------------------------
// 导出主编排（F.4 导出事务）
// ---------------------------------------------------------------------------

interface TablePack {
  name: string;
  rows: Record<string, unknown>[];
  columns: readonly PackColumnSpec[];
}

/** template 闭包（root worldline only + 归一 redaction）。 */
function templateClosure(rootWorldlineId: string): Closure {
  return { ...NO_CLOSURE, worldlineIds: new Set([rootWorldlineId]) };
}

/** 应用 template redaction（在抽取后的行上改写 + 登记）。 */
function applyTemplateRedactions(ctx: ExtractionContext, packs: TablePack[]): void {
  let worldlinesTouched = false;
  let qualificationsTouched = false;
  let claimsTouched = false;
  for (const pack of packs) {
    if (pack.name === "worldlines") {
      for (const row of pack.rows) {
        row.head_tick = "0";
        row.head_ordinal = "0";
      }
      worldlinesTouched = true;
    } else if (pack.name === "article_qualifications") {
      for (const row of pack.rows) {
        row.available_from_tick = "0";
        row.available_from_ordinal = "0";
      }
      qualificationsTouched = true;
    } else if (pack.name === "world_claims") {
      for (const row of pack.rows) {
        if (row.source_record_id !== null || row.source_event_id !== null) {
          row.source_record_id = null;
          row.source_event_id = null;
          claimsTouched = true;
        }
      }
    }
  }
  if (worldlinesTouched) {
    ctx.redactions.push({
      table: "worldlines",
      columns: ["headTick", "headOrdinal"],
      reason: "template fresh start (head reset to 0,0)",
    });
  }
  // article_qualifications 的 cursor 归一 redaction 固定登记（向量 5/6 锚点：
  // 即使本包无资格行也登记——template 语义声明）。
  void qualificationsTouched;
  ctx.redactions.push({
    table: "article_qualifications",
    columns: ["availableFromTick", "availableFromOrdinal"],
    reason: "template fresh start (head reset to 0,0)",
  });
  if (claimsTouched) {
    ctx.redactions.push({
      table: "world_claims",
      columns: ["sourceRecordId", "sourceEventId"],
      reason: "template excludes record-scoped rows; nullable refs redacted to null",
    });
  }
}

/** events 恒 NULL redaction（逐行断言——C5；kind ≠ template 时登记）。 */
function applyEventRedactions(ctx: ExtractionContext, packs: TablePack[]): void {
  if (ctx.kind === "template") return;
  for (const pack of packs) {
    if (pack.name !== "events") continue;
    for (const row of pack.rows) {
      row.causation_command_id = null;
      row.turn_run_id = null;
      if (row.causation_command_id !== null || row.turn_run_id !== null) {
        throw new WorldTransferError(
          "INCOMPLETE_CLOSURE",
          "events redaction assertion failed",
        );
      }
    }
  }
  ctx.redactions.push({
    table: "events",
    columns: ["causationCommandId", "turnRunId"],
    reason: "transient command lifecycle",
  });
}

/** template 闭包校验（D.4 fail-closed：指向未导出行的引用 → 409 不出包）。
 *  nullable 声明引用（world_claims source refs）已在 redaction 阶段 NULL 化；
 *  数组引用不可 NULL 化——未解析即失败。 */
function validateTemplateClosure(packs: TablePack[]): void {
  const missing: { table: string; id: string }[] = [];
  const idsOf = (name: string, column = "id") =>
    new Set(
      (packs.find((pack) => pack.name === name)?.rows ?? [])
        .map((row) => String(row[column])),
    );
  const claims = idsOf("world_claims");
  const entities = idsOf("world_entities");
  const articles = idsOf("world_articles");
  const proposals = idsOf("canon_proposals");
  const revisions = idsOf("canon_revisions");
  const campaigns = idsOf("information_campaigns");
  const packets = idsOf("information_packets");
  const nodes = idsOf("propagation_nodes", "node_key");
  const continuities = idsOf("character_continuities");

  for (const pack of packs) {
    switch (pack.name) {
      case "world_relations":
        for (const row of pack.rows) {
          requireSubset("world_entities", [row.subject_entity_id as string], entities, missing);
          requireSubset("world_entities", [row.object_entity_id as string], entities, missing);
          requireSubset("world_claims", [row.source_claim_id as string], claims, missing);
        }
        break;
      case "causal_edges":
        for (const row of pack.rows) {
          requireSubset("world_claims", [row.from_claim_id as string], claims, missing);
          requireSubset("world_claims", [row.to_claim_id as string], claims, missing);
        }
        break;
      case "world_articles":
        for (const row of pack.rows) {
          requireArraySubset("world_claims", [(row.claim_ids as string[]) ?? []], claims, missing);
          // source_event_ids 指向 record 级 events——template 不含 events，
          // 数组引用不可 NULL 化 → fail-closed（D.4）。
          requireArraySubset("events", [(row.source_event_ids as string[]) ?? []], new Set(), missing);
        }
        break;
      case "canon_proposals":
        for (const row of pack.rows) {
          if (row.article_id !== null) {
            requireSubset("world_articles", [row.article_id as string], articles, missing);
          }
          requireArraySubset("world_claims", [(row.claim_ids as string[]) ?? []], claims, missing);
        }
        break;
      case "canon_revisions":
        for (const row of pack.rows) {
          if (row.parent_revision_id !== null) {
            requireSubset("canon_revisions", [row.parent_revision_id as string], revisions, missing);
          }
          requireSubset("canon_proposals", [row.accepted_proposal_id as string], proposals, missing);
        }
        break;
      case "canon_revision_audiences":
        for (const row of pack.rows) {
          requireSubset("canon_revisions", [row.revision_id as string], revisions, missing);
          requireSubset("character_continuities", [row.continuity_id as string], continuities, missing);
        }
        break;
      case "information_campaigns":
        for (const row of pack.rows) {
          if (row.canon_revision_id !== null) {
            requireSubset("canon_revisions", [row.canon_revision_id as string], revisions, missing);
          }
          requireArraySubset("world_claims", [(row.root_claim_ids as string[]) ?? []], claims, missing);
        }
        break;
      case "information_packets":
        for (const row of pack.rows) {
          requireSubset("information_campaigns", [row.campaign_id as string], campaigns, missing);
          if (row.parent_packet_id !== null) {
            requireSubset("information_packets", [row.parent_packet_id as string], packets, missing);
          }
          requireArraySubset("world_claims", [(row.claim_ids as string[]) ?? []], claims, missing);
          requireArraySubset("world_claims", [(row.omitted_claim_ids as string[]) ?? []], claims, missing);
        }
        break;
      case "propagation_exposures":
        for (const row of pack.rows) {
          requireSubset("information_campaigns", [row.campaign_id as string], campaigns, missing);
          requireSubset("information_packets", [row.packet_id as string], packets, missing);
        }
        break;
      case "propagation_routes":
        for (const row of pack.rows) {
          requireSubset("propagation_nodes", [row.from_node as string], nodes, missing);
          requireSubset("propagation_nodes", [row.to_node as string], nodes, missing);
        }
        break;
      case "propagation_node_audiences":
        for (const row of pack.rows) {
          requireSubset("character_continuities", [row.continuity_id as string], continuities, missing);
          requireSubset("propagation_nodes", [row.node_key as string], nodes, missing);
        }
        break;
      case "article_qualifications":
      case "article_import_entries":
        for (const row of pack.rows) {
          requireSubset("world_articles", [row.article_id as string], articles, missing);
        }
        break;
      default:
        break;
    }
  }
  if (missing.length > 0) {
    throw new WorldTransferError(
      "INCOMPLETE_CLOSURE",
      "template closure references rows outside the pack",
      { missing },
    );
  }
}

export function createWorldTransferExporter(pool: Pool) {
  const { extractTable } = createWorldTransferRepository();

  async function exportWorld(input: {
    workspaceId: string;
    request: ExportRequestScope;
    operatorPrincipal: string;
    appVersion: string;
    /** principalId → displayName（调用方经 runtime 池预解析；
     *  realm_transfer 不读 accounts——least privilege 保持 42+5 授权面）。 */
    displayNames: ReadonlyMap<string, string>;
  }): Promise<ExportResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT set_config('realm.workspace_id', $1, true)", [
        input.workspaceId,
      ]);
      const { workspaceId } = input;
      const { worldId } = input.request;
      const kind: "template" | "full" | "archive" = input.request.mode === "selection"
        ? "archive"
        : input.request.mode;

      // D.8：owner 判定 = 事务首语句 membership 重验。注意：PG 行锁子句
      // （FOR SHARE/KEY SHARE/UPDATE）要求至少一项 DML 特权（实测 PG17），
      // SELECT-only 的 realm_transfer 无法直接持锁——锁内重验由
      // realm_import_job_create 函数内 FOR SHARE（SECURITY DEFINER 上下文）
      // 承担（本事务内最终闸门，撤销并发由该锁串行）。
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM player_world_memberships
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [workspaceId, worldId, input.operatorPrincipal],
      );
      if (!membership.rows[0]) {
        throw new WorldTransferError("WORLD_NOT_FOUND", "World not found.");
      }
      if (membership.rows[0].role !== "owner") {
        throw new WorldTransferError("NOT_OWNER", "Only the world owner can export.");
      }

      const world = await client.query<{ name: string; status: string }>(
        `SELECT name, status FROM worlds WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, worldId],
      );
      if (!world.rows[0]) {
        throw new WorldTransferError("WORLD_NOT_FOUND", "World not found.");
      }

      const ctx: ExtractionContext = {
        workspaceId,
        worldId,
        kind,
        rootWorldlineId: null,
        closure: NO_CLOSURE,
        redactions: [],
      };

      // template：root worldline 唯一性（存在非 root → 409）。
      if (kind === "template") {
        const branches = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2
             AND parent_worldline_id IS NOT NULL`,
          [workspaceId, worldId],
        );
        if ((branches.rows[0]?.count ?? 0) > 0) {
          throw new WorldTransferError(
            "TEMPLATE_UNSUPPORTED_BRANCH",
            "Template export requires a single root worldline.",
          );
        }
        const root = await client.query<{ id: string }>(
          `SELECT id FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND parent_worldline_id IS NULL`,
          [workspaceId, worldId],
        );
        if (!root.rows[0]) {
          throw new WorldTransferError("WORLD_NOT_FOUND", "Root worldline not found.");
        }
        ctx.rootWorldlineId = root.rows[0].id;
        ctx.closure = templateClosure(root.rows[0].id);
        // template avatar 文件闭包：全世界 character_definitions 的
        // /profile/avatar_file_id（D.4：instances→continuities→definitions→
        // avatar world_files；template 含全部定义表，故闭包取全量定义）。
        const avatarRows = await idPairs(
          client,
          `SELECT profile->>'avatar_file_id' AS avatar FROM character_definitions
           WHERE workspace_id = $1 AND world_id = $2`,
          [workspaceId, worldId],
        );
        const fileIds = new Set<string>();
        for (const row of avatarRows) {
          if (typeof row.avatar === "string" && row.avatar !== "") {
            fileIds.add(row.avatar);
          }
        }
        ctx.closure = { ...ctx.closure, fileIds };
      } else if (kind === "archive") {
        ctx.closure = await resolveSelectionClosure(client, ctx, input.request);
      }

      // —— 内容抽取（声明序；零行表不出包）——
      const packs: TablePack[] = [];
      const closure = ctx.closure;
      const worldlineFilter = (query: Query) => {
        if (kind === "full") return query;
        return query.andIn("worldline_id", closure.worldlineIds!);
      };
      const recordFilter = (query: Query) => {
        return query.andIn("record_id", closure.recordIds ?? new Set());
      };

      for (const table of PACK_TABLE_ORDER) {
        const entry = matrixRow(table);
        if (!tierAllows(entry.tier, kind)) continue;
        let extracted: { columns: readonly PackColumnSpec[]; rows: Record<string, unknown>[] };
        switch (table) {
          case "worlds":
            extracted = await extractTable(client, ctx, table, (q) =>
              q.andSql("id = ?", worldId));
            break;
          case "worldlines":
            extracted = await extractTable(client, ctx, table, (q) => {
              q.andSql("world_id = ?", worldId);
              if (kind === "template") {
                q.andSql("parent_worldline_id IS NULL");
              } else if (kind === "archive") {
                q.andIn("id", closure.worldlineIds!);
              }
              return q;
            });
            break;
          case "stories":
            extracted = kind === "full"
              ? await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId))
              : await extractTable(client, ctx, table, (q) => q.andIn("id", closure.storyIds!));
            break;
          case "character_definitions":
            extracted = kind === "archive"
              ? await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.definitionIds!))
              : await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId));
            break;
          case "skill_definitions":
            extracted = kind === "archive"
              ? await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.skillDefinitionIds!))
              : await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId));
            break;
          case "asset_definitions":
            extracted = kind === "archive"
              ? await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.assetDefinitionIds!))
              : await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId));
            break;
          case "effect_definitions":
            extracted = kind === "archive"
              ? await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.effectDefinitionIds!))
              : await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId));
            break;
          case "character_continuities":
            extracted = kind === "archive"
              ? await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.continuityIds!))
              : await extractTable(client, ctx, table, (q) =>
                  worldlineFilter(q.andSql("world_id = ?", worldId)));
            break;
          case "world_files":
            extracted = kind === "full"
              ? await extractTable(client, ctx, table, (q) => q.andSql("world_id = ?", worldId))
              : await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.fileIds ?? new Set()));
            break;
          case "memory_cache_epochs": {
            // B 类归属：经 continuity→world（full-only 表）。
            const continuitySet = await idSet(
              client,
              `SELECT id FROM character_continuities
               WHERE workspace_id = $1 AND world_id = $2`,
              [workspaceId, worldId],
            );
            extracted = await extractTable(client, ctx, table, (q) =>
              q.andIn("observer_continuity_id", continuitySet));
            break;
          }
          case "world_entities":
          case "world_relations":
          case "causal_edges":
          case "propagation_nodes":
          case "propagation_routes":
          case "information_campaigns":
          case "information_packets":
          case "propagation_exposures":
          case "canon_proposals":
          case "canon_revisions":
          case "canon_revision_audiences":
          case "world_articles":
          case "world_claims":
          case "article_qualifications":
          case "article_import_entries":
          case "character_instances":
          case "participants":
          case "visibility_policies":
          case "events":
          case "record_heads":
          case "observations":
          case "character_skills":
          case "character_assets":
          case "action_receipts":
          case "character_effects":
          case "records":
          case "scenes":
          case "propagation_node_audiences": {
            if (kind === "archive") {
              // selection：按闭包 id 集合过滤。
              if (table === "records") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.recordIds!));
              } else if (["scenes", "character_instances", "participants",
                "visibility_policies", "events", "record_heads", "observations",
                "character_skills", "character_assets", "action_receipts",
                "character_effects"].includes(table)) {
                extracted = await extractTable(client, ctx, table, (q) => recordFilter(q));
              } else if (table === "world_articles") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.articleIds!));
              } else if (["article_qualifications",
                "article_import_entries"].includes(table)) {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("article_id", closure.articleIds!));
              } else if (table === "canon_proposals") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.proposalIds!));
              } else if (table === "canon_revisions") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.revisionIds!));
              } else if (table === "canon_revision_audiences") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("revision_id", closure.revisionIds!));
              } else if (table === "information_campaigns") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.campaignIds!));
              } else if (table === "information_packets") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("id", closure.packetIds!));
              } else if (table === "propagation_exposures") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("campaign_id", closure.campaignIds!));
              } else if (table === "propagation_node_audiences") {
                extracted = await extractTable(client, ctx, table, (q) =>
                  q.andIn("continuity_id", closure.continuityIds!));
              } else {
                // world_claims/world_entities/world_relations/causal_edges/
                // propagation_nodes/routes：affected worldlines 内全量（闭包
                // 已在 resolveSelectionClosure 校验）。
                extracted = await extractTable(client, ctx, table, (q) =>
                  worldlineFilter(q.andSql("world_id = ?", worldId)));
              }
            } else {
              // full：全表世界范围；template：root worldline。
              extracted = await extractTable(client, ctx, table, (q) =>
                worldlineFilter(q.andSql("world_id = ?", worldId)));
            }
            break;
          }
          case "memory_conclusions":
          case "memory_snapshots":
          case "relationship_states":
          case "worldline_merges":
            extracted = await extractTable(client, ctx, table, (q) =>
              q.andSql("world_id = ?", worldId));
            break;
          default:
            throw new WorldTransferError(
              "INCOMPLETE_CLOSURE",
              `no extraction rule for table ${table}`,
            );
        }
        if (extracted.rows.length > 0) {
          packs.push({ name: table, rows: extracted.rows, columns: extracted.columns });
        }
      }

      // redaction（抽取后改写 + 登记）。
      applyEventRedactions(ctx, packs);
      if (kind === "template") applyTemplateRedactions(ctx, packs);
      if (kind === "template") validateTemplateClosure(packs);

      // —— 包组装 ——
      const tableData: PackTableData[] = [];
      let totalRows = 0;
      for (const pack of packs) {
        const bytes = ndjsonBytes(pack.columns, pack.rows);
        totalRows += pack.rows.length;
        if (totalRows > PACK_LIMITS.totalRowsMax) {
          throw new WorldTransferError(
            "PACK_LIMIT_EXCEEDED",
            "total rows exceed the pack limit",
          );
        }
        tableData.push({ name: pack.name, rows: pack.rows.length, bytes });
      }
      // world_files 字节（files/<id>.bin）。
      const fileRows = packs.find((pack) => pack.name === "world_files")?.rows ?? [];
      const fileIds = fileRows.map((row) => String(row.id));
      const fileData: { id: string; bytes: Uint8Array }[] = [];
      if (fileIds.length > 0) {
        const fileBytes = await client.query<{ id: string; data: Buffer }>(
          `SELECT id, data FROM world_files
           WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])
           ORDER BY id`,
          [workspaceId, worldId, fileIds],
        );
        for (const row of fileBytes.rows) {
          fileData.push({ id: row.id, bytes: new Uint8Array(row.data) });
        }
      }

      const scope: PackScope = {
        kind,
        storyIds: input.request.mode === "selection"
          ? [...(input.request.storyIds ?? [])]
          : null,
        recordIds: input.request.mode === "selection"
          ? [...(input.request.recordIds ?? [])]
          : null,
        includeLinked: input.request.includeLinked ?? false,
        includeMemberships: input.request.includeMemberships ?? false,
        completeness: kind === "full" ? "complete" : "partial",
      };
      const scopeDigestValue = scopeDigest(scope);
      const contentHash = computeContentHash(tableData, fileData);

      // memberships 展示形态（不进 tables[]/contentHash——D.3）。
      let memberships: RealmManifest["memberships"];
      if (input.request.includeMemberships) {
        const rows = await client.query<{
          principal_id: string;
          role: string;
        }>(
          `SELECT membership.principal_id, membership.role
           FROM player_world_memberships AS membership
           WHERE membership.workspace_id = $1 AND membership.world_id = $2
           ORDER BY membership.principal_id`,
          [workspaceId, worldId],
        );
        memberships = rows.rows.map((row) => ({
          principalRef: input.displayNames.get(row.principal_id) ?? row.principal_id,
          role: row.role === "owner" ? "owner" as const
            : row.role === "player" ? "member" as const
            : "viewer" as const,
        }));
      }

      const manifest: RealmManifest = {
        format: "realm-pack",
        version: 1,
        createdAt: new Date().toISOString(),
        exporter: {
          app: "realm",
          appVersion: input.appVersion,
          schemaLatest: REQUIRES_MIGRATIONS[REQUIRES_MIGRATIONS.length - 1]!,
        },
        source: { worldId, worldName: world.rows[0].name },
        scope,
        requiresMigrations: [...REQUIRES_MIGRATIONS],
        tables: tableData.map((table) => ({
          name: table.name,
          rows: table.rows,
          sha256: sha256Hex(table.bytes),
        })),
        files: fileData.map((file) => {
          const meta = fileRows.find((row) => String(row.id) === file.id)!;
          return {
            id: file.id,
            sha256: sha256Hex(file.bytes),
            sizeBytes: file.bytes.length,
            contentType: String(meta.content_type),
            kind: String(meta.kind),
            filename: String(meta.filename),
          };
        }),
        ...(memberships !== undefined ? { memberships } : {}),
        redactions: ctx.redactions,
        principalPolicy: "preserve-attribution",
        contentHash,
      };
      const bytes = buildRealmPack({
        manifestBytes: Buffer.from(serializeManifest(manifest), "utf8"),
        tables: tableData,
        files: fileData,
      });
      const archiveBytesHash = sha256Hex(bytes);

      // —— job 账本（受控函数；函数内 owner 锁内重验为最终闸门）——
      const jobId = `job_export_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      try {
        await client.query(
          `SELECT realm_import_job_create($1, $2, 'export', $3, $4, $5, '', $6, $7, $8, NULL)`,
          [
            workspaceId,
            jobId,
            contentHash,
            archiveBytesHash,
            scopeDigestValue,
            kind,
            worldId,
            input.operatorPrincipal,
          ],
        );
        await client.query(
          `SELECT realm_import_job_complete_export($1, $2, $3::jsonb)`,
          [
            workspaceId,
            jobId,
            JSON.stringify({
              tables: manifest.tables,
              files: manifest.files.length,
              scopeDigest: scopeDigestValue,
              contentHash,
            }),
          ],
        );
      } catch (error) {
        const pgCode = (error as { code?: string }).code;
        if (pgCode === "42883" || pgCode === "42P01") {
          throw new WorldTransferError(
            "TRANSFER_NOT_PROVISIONED",
            "realm transfer schema is not provisioned (0042 required)",
          );
        }
        throw error;
      }

      await client.query("COMMIT");
      return {
        bytes,
        jobId,
        archiveBytesHash,
        contentHash,
        scopeDigest: scopeDigestValue,
        tableSummary: manifest.tables,
        fileCount: manifest.files.length,
        manifest,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { exportWorld };
}
