/**
 * 批次 T10-B18-A：Drizzle/D1 历史迁移 archive 围栏（post-retirement 形态）。
 *
 * 本文件在 T10-B15-A 时守「保留原位」、T10-B16-A 起承担 legacy script/
 * inactive 文案指定锚点（历史形态见 Git）；T10-B18-A 执行退役后同步为
 * post-retirement 形态——archive 位于 docs/archive/d1-drizzle/（整体
 * git mv，内容零改写），原 drizzle/、drizzle.config.ts、db 三件套与
 * legacy tooling 已移除。
 *
 * 锚定纪律不变：存在性/关键头部/journal tags 实锚，不生成 hash 伪证据，
 * 不做全仓 "drizzle" 字符串禁用（历史文档/测试字样合法）。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ARCHIVE_DIR = "docs/archive/d1-drizzle";

const ARCHIVE_SQL = [
  "0000_orange_triathlon.sql",
  "0001_cynical_khan.sql",
  "0002_chunky_spirit.sql",
];
const ARCHIVE_META = [
  "0000_snapshot.json",
  "0001_snapshot.json",
  "0002_snapshot.json",
  "_journal.json",
];
const REMOVED_PATHS = [
  "drizzle/0000_orange_triathlon.sql",
  "drizzle/0001_cynical_khan.sql",
  "drizzle/0002_chunky_spirit.sql",
  "drizzle/meta/_journal.json",
  "drizzle.config.ts",
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
];
const PG_MIGRATION_DIR = "database/postgres/migrations";
const PG_ONLY_CONSTRUCT = /CREATE POLICY|ENABLE ROW LEVEL SECURITY|GRANT\s+\w+\s+ON|realm_runtime/i;

test(
  "the archive unit is complete at its post-retirement location; original paths are gone",
  { skip: !existsSync(join(projectRoot, ARCHIVE_DIR)) },
  () => {
  for (const name of ARCHIVE_SQL) {
    assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, name)), `${ARCHIVE_DIR}/${name} 应在位`);
  }
  for (const name of ARCHIVE_META) {
    assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, "meta", name)), `meta/${name} 应在位`);
  }
  assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, "README.md")), "archive README 应在位");
  for (const path of REMOVED_PATHS) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已被 T10-B18-A 移除`);
  }
});

test("legacy tooling is retired from package records (post-retirement designated anchor)", () => {
  // 批次 T10-B18-A：本用例继续承担指定锚点，形态由「存在」翻为「退役后
  // 不存在」——legacy script、drizzle 依赖、db/index inactive 入口已消失；
  // 「无 db:generate」负断言保持（与存废无关）。
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"db:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
  const lock = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
  assert.doesNotMatch(lock, /node_modules\/drizzle-(orm|kit)/);
  assert.ok(!existsSync(join(projectRoot, "db/index.ts")), "db/index.ts 应已删除");
});

test(
  "archive provenance chain is intact, SQLite-only, and carries config provenance",
  { skip: !existsSync(join(projectRoot, ARCHIVE_DIR)) },
  () => {
  const journal = JSON.parse(
    readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", "_journal.json"), "utf8"),
  );
  assert.equal(journal.dialect, "sqlite");
  assert.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ARCHIVE_SQL.map((name) => name.replace(/\.sql$/, "")),
  );
  for (const name of ARCHIVE_META.filter((entry) => entry.endsWith("_snapshot.json"))) {
    const snapshot = JSON.parse(
      readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", name), "utf8"),
    );
    assert.equal(snapshot.dialect, "sqlite", `${name} dialect 应为 sqlite`);
  }
  const heads = [
    /CREATE TABLE `character_definitions`/,
    /CREATE TABLE `prototype_turn_commits`/,
    /ALTER TABLE `events` ADD `visibility_payload`/,
  ];
  ARCHIVE_SQL.forEach((name, index) => {
    const sql = readFileSync(join(projectRoot, ARCHIVE_DIR, name), "utf8");
    assert.match(sql, heads[index], `${name} 关键头部缺失`);
    assert.match(sql, /-->\s*statement-breakpoint/, `${name} 应保留 drizzle-kit sqlite 签名`);
    assert.doesNotMatch(sql, PG_ONLY_CONSTRUCT, `${name} 出现 PG 专有构造`);
  });
  // config provenance 入 README：全文要点齐全，且明确标注不可据此重建。
  const readme = readFileSync(join(projectRoot, ARCHIVE_DIR, "README.md"), "utf8");
  assert.match(readme, /drizzle\.config\.ts provenance/);
  assert.match(readme, /\.\/db\/schema\.ts/);
  assert.match(readme, /out: "\.\/drizzle"/);
  assert.match(readme, /dialect: "sqlite"/);
  assert.match(readme, /drizzle-kit generate/);
  assert.match(readme, /不要/);
});

test("PostgreSQL authoritative migrations stay complete and archive-free", () => {
  const directory = join(projectRoot, PG_MIGRATION_DIR);
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  // MIGRATION_CONTINUITY_EVOLUTION: full frozen filename identity.
  assert.deepEqual(files, [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0028_propagation_node_audiences_owner_append.sql",
  "0029_record_scene_tension.sql",
  "0030_character_instance_state.sql",
  "0031_keen_insight_discovery.sql",
  "0032_character_activity_grants.sql",
  "0033_base_skill_metadata_grant.sql",
  "0034_revoke_broad_skill_metadata_grant.sql",
  "0035_keen_insight_concrete_discovery.sql",
  "0036_keen_insight_location_context.sql",
  "0037_record_archive_grant.sql",
  "0038_remove_base_skill_hidden_clue.sql",
  "0039_scene_weather_snapshot.sql",
  "0040_scene_display_time_snapshot.sql",
  "0041_article_qualification_and_import_entries.sql",
  "0042_realm_transfer_and_import_jobs.sql",
  "0043_propagation_node_audience_archived_guard.sql",
  "0044_record_branch_timeline_kind.sql",
  "0045_lobby_rooms.sql",
  "0046_lobby_room_world_link.sql",
  "0047_lobby_host_lease.sql",
  "0048_scene_image_generations.sql",
  "0049_scene_image_mode.sql",
  "0050_scene_image_requests.sql",
  "0051_account_password_hash.sql",
  "0052_scene_image_queue_lease_fencing.sql",
  "0053_membership_capability.sql",
  "0054_world_version_identity.sql",
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  "0057_realmworld_record_binding.sql",
  "0058_durable_job_queue.sql",
  "0059_world_commands.sql",
  "0060_goal_scope_terminal_lifecycle.sql",
  "0061_story_graph_runtime.sql",
  "0062_project_finance_foundation.sql",
  "0063_genesis_creation_requests.sql",
  "0064_record_turn_jobs.sql",
  "0065_funding_obligations.sql",
  "0066_committed_fact_commands.sql",
  "0067_member_relationship_revisions.sql",
  "0068_inventory_grant_command.sql",
  "0069_record_goal_authoring.sql",
  "0070_record_goal_authoring_capability.sql",
  "0071_record_narrative_state.sql",
  "0072_record_goal_evolution_capability.sql",
  "0073_record_goal_genesis_capability.sql",
  "0074_record_goal_restore_capability.sql",
  "0075_record_goal_branch_capability.sql",
  "0076_story_definition_bindings.sql",
  "0077_grouped_record_goal_restore_capability.sql",
  "0078_bridge_command_write_authorization.sql",
  "0079_restored_outbox_delivery_origin.sql",
  "0080_realmworld_command_materializations.sql",
  "0081_command_policy_record_lock.sql",
  "0082_performance_evidence_snapshots.sql",
  "0083_goal_content_instance_bindings.sql",
  "0084_performance_evidence_transport_provenance.sql",
  "0085_runtime_performance_transport_body_v3.sql",
  "0086_unsigned_import_declaration_guard.sql",
]);
  assert.deepEqual(
    files.map((name) => name.slice(0, 4)),
    Array.from({ length: 86 }, (_, index) => String(index + 1).padStart(4, "0")),
    "PG migrations 0001–0086 应连续齐全；0048–0050 负责场景图，0051 账户密码，0052 场景图队列 lease fencing、0053 membership capability、0054 world_version 身份、0055 Goal runtime、0056 runtime save/restore grants、0057 RealmWorld Record binding、0058 统一 durable job 队列、0059 World Command 跨 Record 台账、0060 Goal scope 与 terminal lifecycle、0061 Story Graph runtime、0062 Project/Finance foundation、0063 Genesis creation request ledger、0064 record-turn cancellation。",
  );
  for (const name of files) {
    const sql = readFileSync(join(directory, name), "utf8");
    assert.doesNotMatch(sql, /-->\s*statement-breakpoint/, `${name} 混入 drizzle 签名`);
  }
  const runner = readFileSync(join(projectRoot, "scripts/postgres-migrate.mjs"), "utf8");
  assert.match(runner, /database\/postgres\/migrations/);
  assert.doesNotMatch(runner, /drizzle\/|archive\/d1-drizzle/);
});
