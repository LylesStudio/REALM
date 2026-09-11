import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationPaths = [
  "../database/postgres/migrations/0001_runtime_contract.sql",
  "../database/postgres/migrations/0002_runtime_contract_hardening.sql",
  "../database/postgres/migrations/0003_runtime_repository.sql",
  "../database/postgres/migrations/0004_runtime_security_hardening.sql",
  "../database/postgres/migrations/0005_hybrid_memory.sql",
  "../database/postgres/migrations/0006_action_state_ledger.sql",
  "../database/postgres/migrations/0007_dynamic_visibility_policies.sql",
  "../database/postgres/migrations/0008_record_timeline_kind.sql",
  "../database/postgres/migrations/0009_memory_m3_completion.sql",
  "../database/postgres/migrations/0010_world_governance.sql",
  "../database/postgres/migrations/0011_worldline_merge_semantic_propagation_jobs.sql",
  "../database/postgres/migrations/0012_accounts.sql",
  "../database/postgres/migrations/0013_membership_insert_grant.sql",
  "../database/postgres/migrations/0014_scene_crystallization_grants.sql",
  "../database/postgres/migrations/0015_account_ui_language.sql",
  "../database/postgres/migrations/0016_world_files.sql",
  "../database/postgres/migrations/0017_account_last_opened.sql",
  "../database/postgres/migrations/0018_account_last_opened_fk_set_null.sql",
  "../database/postgres/migrations/0019_record_first_nights.sql",
  "../database/postgres/migrations/0020_record_self_play_sessions.sql",
  "../database/postgres/migrations/0021_world_admin.sql",
  "../database/postgres/migrations/0022_worldline_merge_grants.sql",
  "../database/postgres/migrations/0023_library_runtime_grants.sql",
  "../database/postgres/migrations/0024_graph_invalidation_events.sql",
  "../database/postgres/migrations/0025_propagation_topology_semantic_scope.sql",
  "../database/postgres/migrations/0026_canon_security_audience.sql",
  "../database/postgres/migrations/0027_propagation_node_audiences.sql",
  "../database/postgres/migrations/0028_propagation_node_audiences_owner_append.sql",
  "../database/postgres/migrations/0029_record_scene_tension.sql",
  "../database/postgres/migrations/0030_character_instance_state.sql",
  "../database/postgres/migrations/0031_keen_insight_discovery.sql",
  "../database/postgres/migrations/0032_character_activity_grants.sql",
  "../database/postgres/migrations/0033_base_skill_metadata_grant.sql",
  "../database/postgres/migrations/0034_revoke_broad_skill_metadata_grant.sql",
  "../database/postgres/migrations/0035_keen_insight_concrete_discovery.sql",
  "../database/postgres/migrations/0036_keen_insight_location_context.sql",
  "../database/postgres/migrations/0037_record_archive_grant.sql",
  "../database/postgres/migrations/0038_remove_base_skill_hidden_clue.sql",
  "../database/postgres/migrations/0039_scene_weather_snapshot.sql",
  "../database/postgres/migrations/0040_scene_display_time_snapshot.sql",
  "../database/postgres/migrations/0041_article_qualification_and_import_entries.sql",
  "../database/postgres/migrations/0042_realm_transfer_and_import_jobs.sql",
  "../database/postgres/migrations/0043_propagation_node_audience_archived_guard.sql",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));
const migrationSql = migrationPaths.map((path) => readFileSync(path, "utf8"));
const sql = migrationSql.join("\n");
const canonicalSql = canonical(sql);

const scopedTables = [
  "worlds",
  "worldlines",
  "stories",
  "records",
  "scenes",
  "character_definitions",
  "character_continuities",
  "character_instances",
  "player_world_memberships",
  "participants",
  "visibility_policies",
  "visibility_policy_audiences",
  "command_inbox",
  "turn_runs",
  "events",
  "record_heads",
  "observations",
  "context_manifests",
  "context_snapshots",
  "outbox",
  "memory_conclusions",
  "skill_definitions",
  "character_skills",
  "asset_definitions",
  "character_assets",
  "effect_definitions",
  "action_receipts",
  "character_effects",
  "relationship_states",
  "memory_snapshots",
  "memory_cache_epochs",
  "world_entities",
  "world_claims",
  "world_relations",
  "world_articles",
  "causal_edges",
  "canon_proposals",
  "canon_revisions",
  "information_campaigns",
  "information_packets",
  "propagation_exposures",
  "worldline_merges",
  "semantic_conflict_evaluations",
  "propagation_jobs",
  "accounts",
  "world_files",
  "record_first_nights",
  "record_self_play_sessions",
  "graph_invalidation_events",
  "propagation_nodes",
  "propagation_routes",
  "canon_revision_audiences",
  "propagation_node_audiences",
  "article_qualifications",
  "article_import_entries",
  "realm_import_jobs",
  "realm_import_job_events",
  "realm_import_bootstrap",
  "realm_import_content_log",
  "realm_import_pack_tables",
];

function canonical(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tableBody(tableName) {
  const marker = `create table if not exists ${tableName} (`;
  const start = canonicalSql.indexOf(marker);
  assert.notEqual(start, -1, `missing table ${tableName}`);

  const opening = start + marker.length - 1;
  let depth = 0;
  for (let index = opening; index < canonicalSql.length; index += 1) {
    if (canonicalSql[index] === "(") depth += 1;
    if (canonicalSql[index] === ")") depth -= 1;
    if (depth === 0) return canonicalSql.slice(opening + 1, index);
  }
  assert.fail(`unterminated table ${tableName}`);
}

test("migrations are non-destructive, repeatable, and transaction-runner owned", () => {
  assert.match(canonical(migrationSql[0]), /^-- realm runtime contract v1/);
  assert.match(canonical(migrationSql[1]), /^-- realm runtime contract v1 hardening/);
  assert.match(canonicalSql, /create extension if not exists vector;/);
  assert.doesNotMatch(canonicalSql, /drop table|truncate table/);

  for (const source of migrationSql) {
    assert.doesNotMatch(source, /^\s*BEGIN\s*;\s*$/gim);
    assert.doesNotMatch(source, /^\s*COMMIT\s*;\s*$/gim);
  }

  const tableDeclarations = [
    ...canonicalSql.matchAll(/create table(?: if not exists)? ([a-z_]+)/g),
  ];
  assert.ok(tableDeclarations.length > 0);
  for (const declaration of tableDeclarations) {
    assert.match(declaration[0], /create table if not exists/);
  }

  const indexDeclarations = [
    ...canonicalSql.matchAll(
      /create (?:unique )?index(?: if not exists)? ([a-z_]+)/g,
    ),
  ];
  assert.ok(indexDeclarations.length > 0);
  for (const declaration of indexDeclarations) {
    assert.match(declaration[0], /index if not exists/);
  }
});

test("the complete Runtime Contract v1 table set is present", () => {
  const expected = ["workspaces", ...scopedTables];
  for (const tableName of expected) {
    assert.match(
      canonicalSql,
      new RegExp(`create table if not exists ${tableName} \\(`),
    );
  }
  assert.equal(
    [...canonicalSql.matchAll(/create table if not exists ([a-z_]+) \(/g)].length,
    expected.length,
  );
});

// 0042 的四个 job 子表经 (workspace_id, job_id) 复合 FK 锚定 realm_import_jobs
//（workspace 域由此传递锚定；直接 workspaces FK 由 jobs 表承担）。
const COMPOSITE_JOB_ANCHORED = new Set([
  "realm_import_job_events",
  "realm_import_bootstrap",
  "realm_import_content_log",
  "realm_import_pack_tables",
]);

test("every tenant table is workspace-scoped with a workspace-qualified primary key", () => {
  for (const tableName of scopedTables) {
    const body = tableBody(tableName);
    assert.match(body, /workspace_id text not null/);
    if (COMPOSITE_JOB_ANCHORED.has(tableName)) {
      assert.match(
        body,
        /foreign key \(workspace_id, job_id\) references realm_import_jobs \(workspace_id, id\)/,
      );
    } else {
      assert.match(body, /foreign key \(workspace_id\) references workspaces \(id\)/);
    }
    assert.match(body, /primary key \(\s*workspace_id,/);
  }
});

test("tenant relationships cannot cross workspace boundaries", () => {
  const references = [
    ...canonicalSql.matchAll(/references ([a-z_]+) \(([^)]+)\)/g),
  ];
  assert.ok(references.length > scopedTables.length);

  for (const [, target, columns] of references) {
    if (target === "workspaces") {
      assert.equal(columns.trim(), "id");
      continue;
    }
    assert.equal(
      columns.split(",")[0].trim(),
      "workspace_id",
      `reference to ${target} is not workspace-qualified`,
    );
  }
});

test("forced row-level security denies unscoped workspace access", () => {
  assert.match(canonicalSql, /create or replace function realm_current_workspace_id\(\)/);
  assert.match(canonicalSql, /current_setting\('realm\.workspace_id', true\)/);
  assert.match(canonicalSql, /alter table %i enable row level security/);
  assert.match(canonicalSql, /alter table %i force row level security/);
  assert.match(canonicalSql, /create policy realm_workspace_isolation/);
  assert.match(
    canonicalSql,
    /with check \(workspace_id = realm_current_workspace_id\(\)\)/,
  );

  for (const tableName of scopedTables) {
    if ([
      "memory_conclusions",
      "skill_definitions",
      "character_skills",
      "asset_definitions",
      "character_assets",
      "effect_definitions",
      "action_receipts",
      "character_effects",
      "relationship_states",
      "memory_snapshots",
      "memory_cache_epochs",
      "world_entities",
      "world_claims",
      "world_relations",
      "world_articles",
      "causal_edges",
      "canon_proposals",
      "canon_revisions",
      "information_campaigns",
      "information_packets",
      "propagation_exposures",
      "worldline_merges",
      "semantic_conflict_evaluations",
      "propagation_jobs",
      "accounts",
      "world_files",
      "record_first_nights",
      "record_self_play_sessions",
      "graph_invalidation_events",
      "propagation_nodes",
      "propagation_routes",
      "canon_revision_audiences",
      "propagation_node_audiences",
      "article_qualifications",
      "article_import_entries",
    ].includes(tableName)) {
      assert.match(
        canonicalSql,
        new RegExp(`alter table ${tableName} force row level security`),
      );
    } else {
      assert.match(
        canonicalSql,
        new RegExp(`'${tableName}'`),
        `${tableName} is missing from the RLS relation list`,
      );
    }
  }
});

test("action state is durable, scoped, atomic and least-privilege", () => {
  const receipts = tableBody("action_receipts");
  assert.match(receipts, /source_event_id text not null/);
  assert.match(receipts, /transaction_id text not null/);
  assert.match(receipts, /receipt jsonb not null/);
  assert.match(canonicalSql, /create trigger action_receipts_append_only_guard/);

  const assets = tableBody("character_assets");
  assert.match(assets, /quantity bigint not null/);
  assert.match(assets, /revision bigint not null default 0/);
  assert.match(canonicalSql, /character_assets_available_idx/);

  const effects = tableBody("character_effects");
  assert.match(effects, /source_action_receipt_id text not null/);
  assert.match(effects, /status in \('active', 'expired', 'removed'\)/);
  assert.match(canonicalSql, /character_effects_one_active_idx/);
  assert.match(canonicalSql, /grant update \(quantity, revision, updated_at\) on character_assets to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on action_receipts to realm_runtime/);
});

test("world and Record ordering use explicit cursors rather than display time", () => {
  const events = tableBody("events");
  assert.match(events, /world_tick bigint not null/);
  assert.match(events, /world_ordinal bigint not null/);
  assert.match(events, /record_ordinal bigint not null/);
  assert.match(
    events,
    /unique \(workspace_id, worldline_id, world_tick, world_ordinal\)/,
  );
  assert.match(events, /unique \(workspace_id, record_id, record_ordinal\)/);
  assert.match(events, /display_time text not null default ''/);

  const heads = tableBody("record_heads");
  assert.match(heads, /record_version bigint not null default 0/);
  assert.match(heads, /next_record_ordinal bigint not null default 0/);
});

test("observations separate occurrence from knowledge availability", () => {
  const observations = tableBody("observations");
  assert.match(observations, /observer_character_instance_id text not null/);
  assert.match(observations, /occurred_tick bigint not null/);
  assert.match(observations, /available_from_tick bigint not null/);
  assert.match(
    observations,
    /\(available_from_tick, available_from_ordinal\) >= \(occurred_tick, occurred_ordinal\)/,
  );
  assert.match(observations, /observation_kind in \('direct', 'inferred', 'rumor', 'system_grant'\)/);
});

test("visibility is an immutable, versioned audience snapshot", () => {
  const policies = tableBody("visibility_policies");
  assert.match(policies, /policy_version bigint not null default 1/);
  assert.match(
    policies,
    /policy_kind in \('public', 'scene', 'restricted', 'private', 'dm_only'\)/,
  );
  assert.match(policies, /audience_character_instance_ids text\[\] not null/);
  assert.match(policies, /cardinality\(audience_character_instance_ids\) > 0/);
  assert.match(canonicalSql, /create trigger visibility_policies_update_guard/);
  assert.match(canonicalSql, /create a new version/);

  const audiences = tableBody("visibility_policy_audiences");
  assert.match(audiences, /visibility_policy_id text not null/);
  assert.match(audiences, /character_instance_id text not null/);
  assert.match(
    audiences,
    /foreign key \( workspace_id, world_id, worldline_id, record_id, visibility_policy_id \) references visibility_policies/,
  );
  assert.match(
    audiences,
    /foreign key \( workspace_id, world_id, worldline_id, record_id, character_instance_id \) references character_instances/,
  );
  assert.match(canonicalSql, /cross join lateral unnest\(policy\.audience_character_instance_ids\)/);
  assert.match(canonicalSql, /validate_visibility_policy_audiences/);
  assert.match(canonicalSql, /create trigger visibility_policies_audience_populate/);
  assert.match(canonicalSql, /create trigger visibility_policy_audiences_mutation_guard/);
  assert.match(canonicalSql, /before update or delete on visibility_policy_audiences/);
  assert.match(canonicalSql, /cannot be expanded after its policy protects a committed event/);
  assert.match(canonicalSql, /create trigger events_visibility_audience_guard/);
});

test("command, Turn, head, event, and outbox recovery fences are explicit", () => {
  const commands = tableBody("command_inbox");
  assert.match(commands, /idempotency_key text not null/);
  assert.match(commands, /request_fingerprint text not null/);
  assert.match(commands, /unique \(workspace_id, record_id, idempotency_key\)/);
  assert.match(commands, /expected_record_version bigint not null/);

  const turns = tableBody("turn_runs");
  for (const state of [
    "accepted",
    "planning",
    "drafting",
    "validating",
    "releasing",
    "completed",
    "failed",
    "retryable",
  ]) {
    assert.match(turns, new RegExp(`'${state}'`));
  }
  assert.match(turns, /unique \(workspace_id, command_id, attempt_number\)/);
  assert.match(turns, /lease_expires_at timestamptz/);

  const outbox = tableBody("outbox");
  assert.match(outbox, /unique \(workspace_id, dedupe_key\)/);
  assert.match(outbox, /state text not null default 'pending'/);
  assert.match(canonicalSql, /create index if not exists outbox_dispatch_idx/);
});

test("committed events are connected to visibility and causation", () => {
  const events = tableBody("events");
  assert.match(events, /visibility_policy_id text not null/);
  assert.match(events, /causation_command_id text/);
  assert.match(events, /turn_run_id text/);
  assert.match(events, /unique \(workspace_id, record_id, record_version, batch_index\)/);
  assert.match(canonicalSql, /create unique index if not exists events_command_batch_uidx/);
  assert.match(canonicalSql, /create trigger events_append_only_guard/);
  assert.match(canonicalSql, /before update or delete on events/);
  assert.match(canonicalSql, /append a correction event/);
});

test("character continuity and immutable player perspective are represented", () => {
  const instances = tableBody("character_instances");
  assert.match(instances, /continuity_id text not null/);
  assert.match(instances, /predecessor_instance_id text/);
  assert.match(instances, /inheritance_cutoff_tick bigint not null/);
  assert.match(instances, /unique \(workspace_id, record_id, continuity_id\)/);

  const memberships = tableBody("player_world_memberships");
  assert.match(memberships, /omniscient_player_character boolean not null default true/);
  assert.match(memberships, /can_view_dynamic_knowledge boolean not null default true/);
  assert.match(canonicalSql, /create trigger player_world_memberships_omniscience_guard/);
});

test("protected manifests and the future pgvector hook are explicit", () => {
  const manifests = tableBody("context_manifests");
  assert.match(manifests, /consumer_kind text not null/);
  assert.match(manifests, /cache_family_id text not null/);
  assert.match(manifests, /prefix_hash text not null/);
  assert.match(manifests, /dynamic_hash text not null/);
  assert.match(manifests, /control_details jsonb not null/);
  assert.match(canonicalSql, /protected control-plane diagnostics/);

  const observations = tableBody("observations");
  assert.match(observations, /semantic_embedding vector/);
  assert.match(observations, /search_document tsvector generated always as/);
  assert.match(canonicalSql, /observations_search_document_gin_idx/);
});

test("hybrid memory is continuity scoped, append-only, time safe, and indexed", () => {
  const memories = tableBody("memory_conclusions");
  assert.match(memories, /observer_continuity_id text not null/);
  assert.match(memories, /observed_entity_key text not null/);
  assert.match(memories, /source_observation_id text/);
  assert.match(memories, /semantic_embedding vector\(384\) not null/);
  assert.match(memories, /keywords text\[\] not null/);
  assert.match(memories, /available_from_tick bigint not null/);
  assert.match(memories, /operation in \('add', 'update', 'retract'\)/);
  assert.match(canonicalSql, /memory_conclusions_embedding_hnsw_idx/);
  assert.match(canonicalSql, /memory_conclusions_keywords_gin_idx/);
  assert.match(canonicalSql, /create trigger memory_conclusions_append_only_guard/);
  assert.match(canonicalSql, /grant select on observations to realm_runtime/);
  assert.match(canonicalSql, /grant select, insert on memory_conclusions to realm_runtime/);
});

test("M3 completion tables keep relationships revisable, snapshots immutable and epochs monotonic", () => {
  const relationships = tableBody("relationship_states");
  assert.match(relationships, /observer_continuity_id text not null/);
  assert.match(relationships, /target_entity_key text not null/);
  assert.match(relationships, /relation_kind in \(\s*'trust', 'hostile', 'alliance', 'kinship', 'debt', 'acquaintance', 'note'\s*\)/);
  assert.match(relationships, /fidelity numeric\(5, 4\) not null/);
  assert.match(relationships, /created_at timestamptz not null/);
  assert.match(relationships, /updated_at timestamptz not null/);
  assert.match(relationships, /source_record_id text/);
  assert.match(relationships, /source_observation_id text/);
  assert.match(canonicalSql, /grant select, insert, update on relationship_states to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on relationship_states to realm_runtime/);

  const snapshots = tableBody("memory_snapshots");
  assert.match(snapshots, /snapshot_kind in \('representation', 'recall'\)/);
  assert.match(snapshots, /item_ids text\[\] not null/);
  assert.match(snapshots, /cursor_tick bigint not null/);
  assert.match(snapshots, /cache_epoch integer not null/);
  assert.match(snapshots, /token_count integer not null/);
  assert.match(canonicalSql, /create trigger memory_snapshots_append_only_guard/);
  assert.match(canonicalSql, /grant select, insert on memory_snapshots to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant update on memory_snapshots to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on memory_snapshots to realm_runtime/);

  const epochs = tableBody("memory_cache_epochs");
  assert.match(epochs, /observer_continuity_id text not null/);
  assert.match(epochs, /epoch integer not null default 0/);
  assert.match(canonicalSql, /grant select, insert, update on memory_cache_epochs to realm_runtime/);
});

test("T7 self-play sessions keep an auditable single-active ledger", () => {
  const sessions = tableBody("record_self_play_sessions");
  assert.match(sessions, /state text not null check \(state in \('running', 'stopping', 'completed', 'failed', 'cancelled'\)\)/);
  assert.match(sessions, /beat_budget integer not null/);
  assert.match(sessions, /beats_completed integer not null default 0/);
  assert.match(sessions, /requested_by text not null/);
  assert.match(sessions, /last_error text/);
  // 同一记录至多一条活动会话（running/stopping 部分唯一索引）。
  assert.match(canonicalSql, /create unique index if not exists record_self_play_sessions_active_idx/);
  assert.match(canonicalSql, /where state in \('running', 'stopping'\)/);
  assert.match(canonicalSql, /grant select, insert, update on record_self_play_sessions to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on record_self_play_sessions to realm_runtime/);
});

test("T10-B7 library runtime grants sink the owner-pool exception minimally", () => {
  // 批次 T10-B7：0023 逐项最小授权（表级 INSERT + 两列 UPDATE）；
  // 严禁 GRANT ALL/整 schema/绕 RLS；不授 UPDATE/DELETE 扩大面。
  assert.match(canonicalSql, /grant insert on worlds to realm_runtime/);
  assert.match(canonicalSql, /grant insert on character_definitions to realm_runtime/);
  assert.match(canonicalSql, /grant insert on character_continuities to realm_runtime/);
  assert.match(canonicalSql, /grant insert on character_instances to realm_runtime/);
  assert.match(canonicalSql, /grant insert on participants to realm_runtime/);
  assert.match(canonicalSql, /grant insert on record_heads to realm_runtime/);
  assert.match(canonicalSql, /grant update \(role\) on player_world_memberships to realm_runtime/);
  assert.match(canonicalSql, /grant update \(is_active\) on participants to realm_runtime/);
  assert.match(canonicalSql, /grant insert on skill_definitions to realm_runtime/);
  assert.match(canonicalSql, /grant insert on asset_definitions to realm_runtime/);
  assert.match(canonicalSql, /grant insert on effect_definitions to realm_runtime/);
  assert.match(canonicalSql, /grant insert on character_skills to realm_runtime/);
  assert.match(canonicalSql, /grant insert on character_assets to realm_runtime/);
  const b23 = canonical(migrationSql[migrationPaths.length - 1]);
  assert.doesNotMatch(b23, /grant all/);
  assert.doesNotMatch(b23, /on all tables/);
  assert.doesNotMatch(b23, /grant delete/);
  assert.doesNotMatch(b23, /bypassrls/);
});

test("T10-B1 worldline merge grants add only the topology INSERT surface", () => {
  // 批次 T10-B1：合并拓扑写入最小补授（worldlines/stories/records 仅 INSERT）；
  // 不恢复 SELECT 以外旧宽授权，不授 UPDATE/DELETE。
  assert.match(
    canonicalSql,
    /grant insert on worldlines, stories, records to realm_runtime/,
  );
  assert.doesNotMatch(canonicalSql, /grant insert on worldlines, stories, records to realm_runtime, realm_control/);
  assert.doesNotMatch(canonicalSql, /grant delete on worldlines to realm_runtime/);
});

test("T8 world admin grants stay least-privilege and scoped to status/delete", () => {
  // 批次 T8：归档翻转（status 列级 UPDATE）与受限删除（worlds DELETE）授权；
  // 不授 worlds 全列 UPDATE，不授任何子表 DELETE（级联以外键动作者权限执行）。
  assert.match(canonicalSql, /grant update \(status, updated_at\) on worlds to realm_runtime/);
  assert.match(canonicalSql, /grant delete on worlds to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on events to realm_runtime/);
  assert.doesNotMatch(canonicalSql, /grant delete on records to realm_runtime/);
  const worldsTable = tableBody("worlds");
  assert.match(worldsTable, /status in \('active', 'archived'\)/);
});

test("M5 world governance tables keep knowledge, canon and propagation contracts", () => {

  const entities = tableBody("world_entities");
  assert.match(entities, /entity_kind in \(\s*'geography', 'history', 'setting', 'faction', 'person', 'other'\s*\)/);

  const claims = tableBody("world_claims");
  assert.match(claims, /scope in \('record', 'story', 'world'\)/);
  assert.match(claims, /truth_status in \(\s*'mentioned', 'record_confirmed', 'story_canon', 'world_canon',\s*'rumor', 'hypothesis', 'disputed', 'deprecated'\s*\)/);
  assert.match(claims, /supersedes_claim_id text/);
  assert.match(canonicalSql, /create trigger world_claims_append_only_guard/);

  const articles = tableBody("world_articles");
  assert.match(articles, /claim_ids text\[\] not null/);
  assert.match(articles, /source_event_ids text\[\] not null/);

  const edges = tableBody("causal_edges");
  assert.match(edges, /edge_kind in \('enables', 'contradicts', 'supersedes', 'context'\)/);

  const proposals = tableBody("canon_proposals");
  assert.match(proposals, /target_level in \('story', 'worldline'\)/);
  assert.match(proposals, /status in \('pending', 'merged', 'rejected', 'deferred'\)/);

  const revisions = tableBody("canon_revisions");
  assert.match(revisions, /accepted_proposal_id text not null/);
  assert.match(revisions, /content_hash text not null/);
  assert.match(canonicalSql, /create trigger canon_revisions_append_only_guard/);

  const campaigns = tableBody("information_campaigns");
  assert.match(campaigns, /algorithm_version text not null/);
  assert.match(campaigns, /security_class in \('public', 'restricted', 'secret'\)/);

  const packets = tableBody("information_packets");
  assert.match(packets, /parent_packet_id text/);
  assert.match(packets, /semantic_fidelity_to_parent numeric\(5, 4\) not null/);
  assert.match(canonicalSql, /create trigger information_packets_append_only_guard/);

  const exposures = tableBody("propagation_exposures");
  assert.match(exposures, /arrival_tick bigint not null/);
  assert.match(exposures, /fidelity numeric\(5, 4\) not null/);
  assert.match(exposures, /algorithm_version text not null/);
});

test("M5 batch 2 tables cover merge audit, semantic evidence and worker queue", () => {
  const merges = tableBody("worldline_merges");
  assert.match(merges, /idempotency_key text not null/);
  assert.match(merges, /status in \('merged', 'rejected'\)/);
  assert.match(merges, /operator text not null/);
  assert.match(canonicalSql, /create trigger worldline_merges_append_only_guard/);
  assert.match(canonicalSql, /unique \(workspace_id, idempotency_key\)/);

  const evaluations = tableBody("semantic_conflict_evaluations");
  assert.match(evaluations, /source in \('model', 'fallback'\)/);
  assert.match(evaluations, /prompt_version text not null/);
  assert.match(canonicalSql, /create trigger semantic_conflict_evaluations_append_only_guard/);

  const jobs = tableBody("propagation_jobs");
  assert.match(jobs, /status in \('pending', 'running', 'done', 'failed'\)/);
  assert.match(jobs, /attempts integer not null default 0/);
  assert.match(canonicalSql, /propagation_jobs_queue_idx/);
  assert.match(canonicalSql, /grant select, insert, update on propagation_jobs to realm_runtime/);
});

test("context snapshots pin temporal, cache, and audience scope as immutable data", () => {
  const snapshots = tableBody("context_snapshots");
  assert.match(snapshots, /context_manifest_id text not null/);
  assert.match(snapshots, /scope_kind text not null/);
  assert.match(snapshots, /scope_id text/);
  assert.match(snapshots, /effective_tick bigint not null/);
  assert.match(snapshots, /effective_ordinal bigint not null/);
  assert.match(snapshots, /knowledge_cutoff_tick bigint not null/);
  assert.match(snapshots, /knowledge_cutoff_ordinal bigint not null/);
  assert.match(snapshots, /cache_epoch text not null/);
  assert.match(snapshots, /cache_family_id text not null/);
  assert.match(snapshots, /prefix_hash text not null/);
  assert.match(snapshots, /dynamic_hash text not null/);
  assert.match(snapshots, /snapshot_hash text not null/);
  assert.match(
    snapshots,
    /\(knowledge_cutoff_tick, knowledge_cutoff_ordinal\) <= \(effective_tick, effective_ordinal\)/,
  );
  assert.match(canonicalSql, /create trigger context_snapshots_mutation_guard/);
  assert.match(canonicalSql, /before update or delete on context_snapshots/);
});

test("application roles are least-privilege, forced-RLS readers", () => {
  for (const roleName of ["realm_runtime", "realm_control"]) {
    assert.match(canonicalSql, new RegExp(`rolname = '${roleName}'`));
    assert.match(
      canonicalSql,
      new RegExp(`create role ${roleName} login nosuperuser`),
    );
    assert.match(
      canonicalSql,
      new RegExp(`alter role ${roleName} with login nosuperuser`),
    );
  }
  assert.match(canonicalSql, /noinherit noreplication nobypassrls/);
  assert.match(
    canonicalSql,
    /revoke update, delete on events from public, realm_runtime, realm_control/,
  );
  assert.match(
    canonicalSql,
    /revoke all privileges on context_manifests, context_snapshots from public, realm_runtime, realm_control/,
  );
  assert.match(
    canonicalSql,
    /grant insert on context_manifests, context_snapshots to realm_runtime/,
  );
  assert.match(
    canonicalSql,
    /grant select, insert on context_manifests, context_snapshots to realm_control/,
  );
  assert.match(
    canonicalSql,
    /revoke all privileges on workspaces, worlds, worldlines, stories, records, scenes,[\s\S]*from realm_runtime/,
  );
  assert.match(
    canonicalSql,
    /grant update \( head_tick, head_ordinal, updated_at \) on worldlines to realm_runtime/,
  );
  assert.doesNotMatch(
    canonical(migrationSql[3]),
    /grant delete .*realm_runtime/,
  );
});

/**
 * 批次 T10-B19-A：T 系列授权 provenance 章节与真实 grant 面一致。
 * 只读真实 migration/doc 内容；内容锚定，不用 hash 伪证据。
 */
test("T-series authorization provenance chapter matches the real grant surface", () => {
  const contractDoc = readFileSync(
    fileURLToPath(
      new URL("../docs/architecture/POSTGRESQL-RUNTIME-CONTRACT.md", import.meta.url),
    ),
    "utf8",
  );
  const chapterStart = contractDoc.indexOf("## T-series authorization provenance");
  assert.ok(chapterStart > 0, "provenance 章节应存在");
  const chapter = contractDoc.slice(chapterStart);

  // 迁移锚点：0013–0023 文件名全部入章，且对应 SQL 文件真实存在。
  const tSeriesNames = [
    "0013_membership_insert_grant",
    "0014_scene_crystallization_grants",
    "0015_account_ui_language",
    "0016_world_files",
    "0017_account_last_opened",
    "0018_account_last_opened_fk_set_null",
    "0019_record_first_nights",
    "0020_record_self_play_sessions",
    "0021_world_admin",
    "0022_worldline_merge_grants",
    "0023_library_runtime_grants",
  ];
  for (const name of tSeriesNames) {
    assert.ok(chapter.includes(name), `章节缺迁移锚点 ${name}`);
    assert.ok(
      migrationPaths.some((path) => path.endsWith(`${name}.sql`)),
      `${name}.sql 应存在于迁移链`,
    );
  }

  // 批次与安全边界关键词锚点。
  for (const anchor of [
    "DEPLOY-AUTH",
    "SCENE-CRYSTALLIZATION",
    "I18N-CENTRALIZED",
    "TAVERN-IMPORT",
    "Batch S",
    "T1",
    "T7",
    "T8",
    "T10-B1",
    "T10-B7",
    "RLS",
    "column-level",
    "append-only",
    "fail-closed",
    "contract-only-deferred",
  ]) {
    assert.ok(chapter.includes(anchor), `章节缺锚点 ${anchor}`);
  }

  // 章节与 T 系列 SQL（0013–0023）均无全特权授权。
  assert.doesNotMatch(chapter, /GRANT ALL/);
  const tSeriesSql = migrationPaths
    .slice(12)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(tSeriesSql, /GRANT ALL/);

  // propagation/semantic-conflict 不得写成 active runtime：
  // 章节内提及行必须同含 contract-only-deferred。
  for (const line of chapter.split("\n")) {
    if (/propagation|semantic-conflict/i.test(line)) {
      assert.match(
        line,
        /contract-only-deferred/,
        `提及 propagation/semantic-conflict 的行缺 contract-only-deferred：${line}`,
      );
    }
  }

  // SQL 内容锚点：证明 migration 未被本批改写（关键 grant 语句在位）。
  assert.match(tSeriesSql, /GRANT DELETE ON worlds TO realm_runtime/);
  assert.match(tSeriesSql, /GRANT UPDATE \(is_active\) ON participants TO realm_runtime/);
  assert.match(tSeriesSql, /GRANT UPDATE \(role\) ON player_world_memberships TO realm_runtime/);
  assert.match(tSeriesSql, /GRANT INSERT \([\s\S]*?\) ON scenes TO realm_runtime/);
  assert.match(tSeriesSql, /GRANT UPDATE \(settings\) ON worlds TO realm_runtime/);
  assert.match(tSeriesSql, /GRANT UPDATE \(ui_language\) ON accounts TO realm_runtime/);
});
