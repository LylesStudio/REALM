/**
 * v37 §D.7 逐表逐字段矩阵（代码常量单一来源；91 行，另有 2 张 durable 台账不进矩阵）。
 *
 * 档位：T=template / F=full / A=archive(selection)；派生=trigger 重建不进包；
 * flag=仅 includeMemberships 展示形态；excluded=不出包。
 * 归属：A=直接 world_id 断言；B=continuity→world 归属断言。
 *
 * 围栏规则（机器可检查，Y1/Y3 双向 diff）：
 * ① 表集 diff：61 行 ↔ information_schema + migrations CREATE TABLE 枚举；
 * ② managed-columns diff：下列 FK/scope/principal/semantic/redaction/特殊
 *    编码列必须逐列有处理规则；普通数据列「原样搬运 + copy opaque 兜底」；
 * ③ tenant key：42 张内容表全部含 workspace_id；
 * ④ 派生表/派生列归类 fail-closed；
 * ⑤ text[] 元素非 NULL 清单冻结 count=8（单一来源）。
 */

/** 档位标记：T/F/A 三档皆可、F/A、仅 F、派生、flag、bootstrap-owned、排除。 */
export type TableTier =
  | "TFA"
  | "FA"
  | "F"
  | "bootstrap"
  | "flag"
  | "derived"
  | "excluded";

export interface ExportMatrixRow {
  readonly table: string;
  readonly tier: TableTier;
  readonly ownership: "A" | "B" | null;
  /** copy 模式重映射列（snake_case；引用/身份列）。 */
  readonly rewriteColumns: readonly string[];
  /** copy 模式 conditional-rewrite（命中 remap 集才重写，否则原样）。 */
  readonly conditionalRewriteColumns: readonly string[];
  /** JSON Pointer 重映射（列内结构）。 */
  readonly jsonPointers: readonly string[];
  /** principal 身份列（D.5 矩阵）。 */
  readonly principalColumns: readonly string[];
  /** semantic 保留列（绝不重写）。 */
  readonly semanticColumns: readonly string[];
  /** template 模式 redaction 列（统一归一/NULL 化）。 */
  readonly templateRedactionColumns: readonly string[];
  /** 恒 NULL redaction（导出逐行断言；events 专属）。 */
  readonly forcedNullColumns: readonly string[];
  /** 特殊编码列（codec 特判；bytea/vector/jsonb/timestamptz 通用列不逐列列出）。 */
  readonly specialColumns: readonly { column: string; codec: "fileref" }[];
}

function row(
  table: string,
  tier: TableTier,
  ownership: "A" | "B" | null,
  extras: Partial<Omit<ExportMatrixRow, "table" | "tier" | "ownership">> = {},
): ExportMatrixRow {
  return {
    table,
    tier,
    ownership,
    rewriteColumns: extras.rewriteColumns ?? [],
    conditionalRewriteColumns: extras.conditionalRewriteColumns ?? [],
    jsonPointers: extras.jsonPointers ?? [],
    principalColumns: extras.principalColumns ?? [],
    semanticColumns: extras.semanticColumns ?? [],
    templateRedactionColumns: extras.templateRedactionColumns ?? [],
    forcedNullColumns: extras.forcedNullColumns ?? [],
    specialColumns: extras.specialColumns ?? [],
  };
}

/** D.7 矩阵全量（91 行；声明序 = 包内 tables/* 序）。 */
export const EXPORT_MATRIX: readonly ExportMatrixRow[] = [
  row("workspaces", "excluded", null),
  row("worlds", "bootstrap", "A"),
  row("worldlines", "TFA", "A", {
    rewriteColumns: ["parent_worldline_id"],
    templateRedactionColumns: ["head_tick", "head_ordinal"],
  }),
  row("stories", "FA", "A"),
  row("records", "FA", "A", {
    rewriteColumns: ["story_id", "linked_record_id"],
  }),
  row("scenes", "FA", "A", { rewriteColumns: ["record_id"] }),
  row("character_definitions", "TFA", "A", {
    jsonPointers: ["/profile/avatar_file_id"],
  }),
  row("character_continuities", "TFA", "A", {
    rewriteColumns: ["definition_id"],
    semanticColumns: ["continuity_key"],
  }),
  row("character_instances", "FA", "A", {
    // record_id（FK→records）copy 必须重映射——D.7 该行漏列，FK 实测补齐。
    rewriteColumns: ["record_id", "continuity_id", "predecessor_instance_id"],
  }),
  row("player_world_memberships", "flag", "A", {
    principalColumns: ["principal_id"],
  }),
  row("participants", "FA", "A", {
    rewriteColumns: ["record_id", "character_instance_id"],
    principalColumns: ["principal_id"],
  }),
  row("visibility_policies", "FA", "A", {
    rewriteColumns: [
      "record_id",
      "scene_id",
      "private_character_instance_id",
      "audience_character_instance_ids",
    ],
    semanticColumns: ["restricted_domain_id", "policy_key", "policy_version"],
  }),
  row("visibility_policy_audiences", "derived", "A"),
  row("command_inbox", "excluded", null),
  row("turn_runs", "excluded", null),
  row("events", "FA", "A", {
    rewriteColumns: [
      "record_id",
      "scene_id",
      "actor_participant_id",
      "visibility_policy_id",
    ],
    forcedNullColumns: ["causation_command_id", "turn_run_id", "command_group_id"],
  }),
  row("record_heads", "FA", "A", {
    rewriteColumns: ["record_id", "last_event_id"],
  }),
  row("observations", "FA", "A", {
    // record_id（FK→records）copy 必须重映射——D.7 该行漏列，FK 实测补齐。
    rewriteColumns: ["record_id", "observer_character_instance_id", "source_event_id"],
  }),
  row("context_manifests", "excluded", null),
  row("context_snapshots", "excluded", null),
  // 大厅是 workspace 级约局元数据（非世界内容），不进 .realm 包。
  row("lobby_rooms", "excluded", null),
  row("lobby_room_members", "excluded", null),
  // 场景图生成台账是运行时操作状态（queue/轮询/绑定），非世界内容；
  // 图像字节由 world_files（fileref codec）承载，台账不进 .realm 包。
  row("scene_image_generations", "excluded", null),
  // 自动模式请求队列同样是运行时意图台账，不进 .realm 包。
  row("scene_image_requests", "excluded", null),
  row("outbox", "excluded", null),
  // Goal runtime facts remain database-scoped until the dedicated `.realm`
  // runtime-save route is implemented; they are never content-package rows.
  row("goal_instances", "excluded", null),
  row("goal_assessment_jobs", "excluded", null),
  row("goal_assessments", "excluded", null),
  // Authoring history and command replay require dedicated runtime-save remapping.
  row("record_goal_definitions", "excluded", null),
  row("record_goal_commands", "excluded", null),
  row("record_goal_restore_admissions", "excluded", null),
  row("record_narrative_state", "derived", "A", { rewriteColumns: ["record_id", "source_event_id"], semanticColumns: ["document"] }),
  // Story Graph runtime projections and unlock evidence are server-owned
  // state; they stay out of .realm packages until a dedicated runtime-save
  // route can preserve their replay/evidence invariants.
  row("story_node_instances", "excluded", null),
  row("story_unlock_ledger", "excluded", null),
  // 0057 版本切换审计是控制面台账（谁何时把哪条 Record 切到哪个
  // RealmWorld 版本），不是世界内容；绑定真相随 records.world_version
  // 走，审计行不进 .realm 包。
  row("realmworld_version_switches", "excluded", null),
  // 0059 World Command 台账是跨 Record 提交的运行时幂等/结果 ledger
  // （同 command_inbox/turn_runs/outbox 的 excluded 语义），不是世界
  // 内容，不进 .realm 包。
  row("world_command_groups", "excluded", null),
  row("world_command_records", "excluded", null),
  // Project/Finance runtime facts are server-owned projections and append-only
  // ledgers; they remain excluded until a dedicated runtime-save route can
  // preserve command replay and financial evidence invariants. The dedicated
  // worldline snapshot in project-finance-runtime-save.ts is that replay
  // proof. These rows stay excluded from the record pack and the realm-import
  // allowlist, which cannot own a worldline ledger without applying it twice.
  row("projects", "excluded", null),
  row("project_milestones", "excluded", null),
  row("project_story_links", "excluded", null),
  row("budget_allocations", "excluded", null),
  row("finance_accounts", "excluded", null),
  row("ledger_entries", "excluded", null),
  row("project_finance_command_groups", "excluded", null),
  row("obligations", "excluded", null),
  row("obligation_settlements", "excluded", null),
  row("committed_fact_commands", "excluded", null),
  row("performance_assessments", "excluded", null),
  row("member_relationship_revisions", "excluded", null),
  row("memory_conclusions", "F", "A", {
    rewriteColumns: [
      "observer_continuity_id",
      "source_record_id",
      "source_observation_id",
      "supersedes_memory_id",
    ],
    conditionalRewriteColumns: ["observed_entity_key"],
  }),
  row("memory_snapshots", "F", "A", {
    rewriteColumns: ["observer_continuity_id", "item_ids"],
  }),
  row("memory_cache_epochs", "F", "B", {
    rewriteColumns: ["observer_continuity_id"],
  }),
  row("skill_definitions", "TFA", "A", {
    semanticColumns: ["skill_key", "rule_pack_key"],
  }),
  row("character_skills", "FA", "A", {
    // record_id（FK→records）copy 必须重映射——D.7 该行漏列，FK 实测补齐。
    rewriteColumns: ["record_id", "character_instance_id", "skill_definition_id"],
  }),
  row("asset_definitions", "TFA", "A", {
    semanticColumns: ["asset_key", "rule_pack_key"],
  }),
  row("character_assets", "FA", "A", {
    // record_id（FK→records）copy 必须重映射——D.7 该行漏列，FK 实测补齐。
    rewriteColumns: ["record_id", "character_instance_id", "asset_definition_id"],
  }),
  row("effect_definitions", "TFA", "A", {
    semanticColumns: ["effect_key", "rule_pack_key"],
  }),
  row("action_receipts", "FA", "A", {
    rewriteColumns: ["record_id", "actor_character_instance_id", "source_event_id"],
    forcedNullColumns: ["command_group_id"],
  }),
  row("character_effects", "FA", "A", {
    rewriteColumns: [
      "record_id",
      "character_instance_id",
      "effect_definition_id",
      "source_action_receipt_id",
    ],
  }),
  row("relationship_states", "F", "A", {
    rewriteColumns: [
      "observer_continuity_id",
      "source_record_id",
      "source_observation_id",
    ],
    conditionalRewriteColumns: ["target_entity_key"],
  }),
  row("world_entities", "TFA", "A"),
  row("world_claims", "TFA", "A", {
    rewriteColumns: [
      "subject_entity_id",
      "supersedes_claim_id",
      "source_record_id",
      "source_event_id",
    ],
    templateRedactionColumns: ["source_record_id", "source_event_id"],
  }),
  row("world_relations", "TFA", "A", {
    rewriteColumns: ["subject_entity_id", "object_entity_id", "source_claim_id"],
  }),
  row("world_articles", "TFA", "A", {
    rewriteColumns: ["claim_ids", "source_event_ids"],
  }),
  row("causal_edges", "TFA", "A", {
    rewriteColumns: ["from_claim_id", "to_claim_id"],
  }),
  row("canon_proposals", "TFA", "A", {
    rewriteColumns: ["article_id", "claim_ids"],
    principalColumns: ["proposed_by", "decided_by"],
  }),
  row("canon_revisions", "TFA", "A", {
    rewriteColumns: ["parent_revision_id", "accepted_proposal_id"],
  }),
  row("canon_revision_audiences", "TFA", "A", {
    rewriteColumns: ["revision_id", "continuity_id"],
  }),
  row("information_campaigns", "TFA", "A", {
    rewriteColumns: ["canon_revision_id", "root_claim_ids"],
  }),
  row("information_packets", "TFA", "A", {
    rewriteColumns: ["campaign_id", "parent_packet_id", "claim_ids", "omitted_claim_ids"],
    semanticColumns: ["channel", "framing", "content_hash"],
  }),
  row("propagation_exposures", "TFA", "A", {
    rewriteColumns: ["campaign_id", "packet_id"],
    semanticColumns: ["node_key", "channel"],
  }),
  row("propagation_jobs", "excluded", null),
  row("propagation_nodes", "TFA", "A", {
    semanticColumns: ["node_key", "canon_origin"],
  }),
  row("propagation_routes", "TFA", "A", {
    rewriteColumns: ["id"],
    semanticColumns: ["from_node", "to_node", "recipient"],
  }),
  row("propagation_node_audiences", "TFA", "A", {
    rewriteColumns: ["continuity_id"],
    semanticColumns: ["node_key"],
  }),
  row("semantic_conflict_evaluations", "excluded", null),
  row("worldline_merges", "F", "A", {
    rewriteColumns: [
      "source_worldline_a",
      "source_worldline_b",
      "merged_worldline_id",
    ],
    jsonPointers: [
      "/manifest[]/sourceWorldlineId",
      "/manifest[]/sourceRecordId",
      "/manifest[]/eventId",
      "/conflict_report/conflicts[]/aEventId",
      "/conflict_report/conflicts[]/bEventId",
    ],
    principalColumns: ["operator"],
  }),
  row("article_qualifications", "TFA", "A", {
    rewriteColumns: ["article_id"],
    principalColumns: ["attested_by"],
    templateRedactionColumns: ["available_from_tick", "available_from_ordinal"],
  }),
  row("article_import_entries", "TFA", "A", {
    rewriteColumns: ["article_id"],
    semanticColumns: ["source_namespace", "stable_entry_identity", "entry_content_hash"],
  }),
  row("world_files", "TFA", "A", {
    specialColumns: [{ column: "data", codec: "fileref" }],
  }),
  row("graph_invalidation_events", "excluded", null),
  row("record_first_nights", "excluded", null),
  row("record_self_play_sessions", "excluded", null),
  // 0058：统一 durable job 队列是运行时操作状态（租约/尝试计数），永不导出。
  row("realm_durable_jobs", "excluded", null),
  row("accounts", "excluded", null),
  row("realm_import_jobs", "excluded", null),
  row("realm_import_job_events", "excluded", null),
  row("realm_import_bootstrap", "excluded", null),
  row("realm_import_content_log", "excluded", null),
  row("realm_import_pack_tables", "excluded", null),
  // 0053：capability 密钥/nonce 台账是控制面内部表，永不导出。
  row("realm_capability_keys", "excluded", null),
  row("realm_capability_nonces", "excluded", null),
];

/** 派生表（行生成型触发器覆盖；不进包/digest/INSERT——Z44/Z46）。 */
export const DERIVED_TABLES: readonly string[] = ["visibility_policy_audiences"];

/** 派生列（is_generated<>'NEVER' OR is_identity='YES'；当前唯一——Z52）。 */
export const DERIVED_COLUMNS: readonly string[] = ["observations.search_document"];

/** bootstrap-owned（worlds 由 begin_bootstrap 写入，不经 insert_rows）。 */
export const BOOTSTRAP_TABLES: readonly string[] = ["worlds"];

/** flag 表（includeMemberships 展示形态；不进 tables[]/contentHash）。 */
export const FLAG_TABLES: readonly string[] = ["player_world_memberships"];

/** text[] 元素非 NULL invariant 清单（冻结 count=8 单一来源——M5/v30 C5）。 */
export const TEXT_ARRAY_NON_NULL_COLUMNS: readonly string[] = [
  "visibility_policies.audience_character_instance_ids",
  "memory_snapshots.item_ids",
  "world_articles.claim_ids",
  "world_articles.source_event_ids",
  "canon_proposals.claim_ids",
  "information_campaigns.root_claim_ids",
  "information_packets.claim_ids",
  "information_packets.omitted_claim_ids",
];

/** scope 可导入表集（register 白名单；与 F.2 realm_import_scope_allows 同序同源）。 */
export const SCOPE_IMPORTABLE: Readonly<
  Record<"template" | "archive" | "full", readonly string[]>
> = {
  template: [
    "worldlines",
    "character_definitions", "character_continuities",
    "skill_definitions", "asset_definitions", "effect_definitions",
    "world_entities", "world_claims", "world_relations", "world_articles", "causal_edges",
    "canon_proposals", "canon_revisions", "canon_revision_audiences",
    "information_campaigns", "information_packets", "propagation_exposures",
    "propagation_nodes", "propagation_routes", "propagation_node_audiences",
    "article_qualifications", "article_import_entries", "world_files",
  ],
  archive: [
    "worldlines",
    "character_definitions", "character_continuities",
    "skill_definitions", "asset_definitions", "effect_definitions",
    "world_entities", "world_claims", "world_relations", "world_articles", "causal_edges",
    "canon_proposals", "canon_revisions", "canon_revision_audiences",
    "information_campaigns", "information_packets", "propagation_exposures",
    "propagation_nodes", "propagation_routes", "propagation_node_audiences",
    "article_qualifications", "article_import_entries", "world_files",
    "stories", "records", "scenes",
    "character_instances", "participants", "visibility_policies",
    "events", "record_heads", "observations",
    "character_skills", "character_assets",
    "action_receipts", "character_effects",
  ],
  full: [
    "worldlines",
    "character_definitions", "character_continuities",
    "skill_definitions", "asset_definitions", "effect_definitions",
    "world_entities", "world_claims", "world_relations", "world_articles", "causal_edges",
    "canon_proposals", "canon_revisions", "canon_revision_audiences",
    "information_campaigns", "information_packets", "propagation_exposures",
    "propagation_nodes", "propagation_routes", "propagation_node_audiences",
    "article_qualifications", "article_import_entries", "world_files",
    "stories", "records", "scenes",
    "character_instances", "participants", "visibility_policies",
    "events", "record_heads", "observations",
    "character_skills", "character_assets",
    "action_receipts", "character_effects",
    "memory_conclusions", "memory_snapshots", "memory_cache_epochs",
    "relationship_states", "worldline_merges",
  ],
};

/** D.7 声明序（tables/* 写出顺序；零行表不出现）。 */
export const PACK_TABLE_ORDER: readonly string[] = EXPORT_MATRIX
  .filter((entry) =>
    entry.tier !== "excluded" && entry.tier !== "derived" && entry.tier !== "flag")
  .map((entry) => entry.table);

export function matrixRow(table: string): ExportMatrixRow {
  const entry = EXPORT_MATRIX.find((item) => item.table === table);
  if (!entry) throw new Error(`unknown export matrix table: ${table}`);
  return entry;
}

/** 档位 → scope kind 是否允许导出该表。 */
export function tierAllows(
  tier: TableTier,
  kind: "template" | "full" | "archive",
): boolean {
  if (tier === "bootstrap") return true;
  if (tier === "TFA") return true;
  if (tier === "FA") return kind === "full" || kind === "archive";
  if (tier === "F") return kind === "full";
  return false;
}
