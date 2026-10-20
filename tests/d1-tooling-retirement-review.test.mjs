/**
 * D1/Drizzle tooling 退役执行后审计（post-retirement execution audit）。
 *
 * 本文件在 T10-B17-A 时是「退役资格评审」（待退役对象在位 + 零活动引用
 * 实锤，历史形态见 Git 记录与 STATUS/迭代日志）；T10-B18-A 经用户明确
 * 授权执行退役后转为执行后审计——退役对象不存在、archive 完整、
 * 零残留引用、保留项不动。
 *
 * import/export/require 语句解析（行首锚定）+ specifier 形态匹配双轨——
 * resolve 不到的路径也要命中；注释/文档/测试里的 drizzle 字样合法，
 * 不做全仓字符串禁用。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vinext",
  ".local",
  ".playwright",
  "dist",
]);
const SCAN_DIRS = ["app", "modules", "database", "scripts", "tests"];
const ARCHIVE_DIR = "docs/archive/d1-drizzle";

const RETIRED_PATHS = [
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
  "drizzle.config.ts",
  "drizzle/0000_orange_triathlon.sql",
  "drizzle/0001_cynical_khan.sql",
  "drizzle/0002_chunky_spirit.sql",
  "drizzle/meta/_journal.json",
];
const ARCHIVE_FILES = [
  "0000_orange_triathlon.sql",
  "0001_cynical_khan.sql",
  "0002_chunky_spirit.sql",
  "meta/0000_snapshot.json",
  "meta/0001_snapshot.json",
  "meta/0002_snapshot.json",
  "meta/_journal.json",
  "README.md",
];
/** 退役 D1 链的 specifier 形态（resolve 盲区覆盖）。 */
const RETIRED_SPECIFIER =
  /^@\/db(?:\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?)?$|(?:^|\/)db\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?$/;
const DRIZZLE_PACKAGES = ["drizzle-orm", "drizzle-kit"];

function collectSources(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push(path);
      }
    }
  };
  walk(directory);
  return files;
}

function collectAllSources() {
  const files = SCAN_DIRS.flatMap((dir) => collectSources(join(projectRoot, dir)));
  for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(join(projectRoot, entry.name));
    }
  }
  return files;
}

/** import/export 必须出现在行首——注释里的 "import" 字样不构成语句。 */
function extractReferences(source) {
  const references = [];
  const statement =
    /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[\s\S]*?\sfrom\s+["']([^"']+)["']|^[ \t]*import[ \t]+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/gm;
  for (const match of source.matchAll(statement)) {
    references.push({
      specifier: match[3] ?? match[4] ?? match[5],
      typeOnly: Boolean(match[2]),
    });
  }
  return references;
}

const references = collectAllSources().flatMap((file) =>
  extractReferences(readFileSync(file, "utf8")).map((reference) => ({
    file: relative(projectRoot, file),
    ...reference,
  })),
);

test("retired files, package script and drizzle dependencies are all gone", () => {
  for (const path of RETIRED_PATHS) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已被 T10-B18-A 移除`);
  }
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
  const lock = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
  assert.doesNotMatch(lock, /node_modules\/drizzle-(orm|kit)/);
});

test("zero import references to the retired chain across the whole scan surface", () => {
  const offenders = [];
  for (const reference of references) {
    const { specifier } = reference;
    if (
      RETIRED_SPECIFIER.test(specifier)
      || DRIZZLE_PACKAGES.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
      || /(?:^|\/)drizzle(?:\/|$)/.test(specifier)
      || specifier.includes("archive/d1-drizzle")
    ) {
      offenders.push(`${reference.file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test(
  "the archive unit is complete at docs/archive/d1-drizzle",
  { skip: !existsSync(join(projectRoot, ARCHIVE_DIR)) },
  () => {
  for (const name of ARCHIVE_FILES) {
    assert.ok(
      existsSync(join(projectRoot, ARCHIVE_DIR, name)),
      `${ARCHIVE_DIR}/${name} 缺失，archive 单元不完整`,
    );
  }
  const journal = JSON.parse(
    readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", "_journal.json"), "utf8"),
  );
  assert.equal(journal.dialect, "sqlite");
  assert.equal(journal.entries.length, 3);
  // archive 不得混入 PG 权威迁移目录。
  const pgFiles = readdirSync(join(projectRoot, "database/postgres/migrations"));
  for (const name of ARCHIVE_FILES.filter((entry) => entry.endsWith(".sql"))) {
    assert.ok(!pgFiles.includes(name), `${name} 不得出现在 PG migrations`);
  }
});

test("scene-image lease fencing migration is tracked and the queue regression runs in scratch PG", () => {
  const migration = readFileSync(
    join(projectRoot, "database/postgres/migrations/0052_scene_image_queue_lease_fencing.sql"),
    "utf8",
  );
  const runner = readFileSync(join(projectRoot, "scripts/test-postgres-runtime-with-scratch.mjs"), "utf8");
  assert.match(migration, /lease_revision bigint NOT NULL DEFAULT 0/);
  assert.match(runner, /tests\/postgres-scene-image-queue\.test\.ts/);
});

test("retained items stay intact: PG migrations, runner, Core contract and portable types", () => {
  const pgDir = join(projectRoot, "database/postgres/migrations");
  const files = readdirSync(pgDir).filter((name) => name.endsWith(".sql")).sort();
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
  const runner = readFileSync(join(projectRoot, "scripts/postgres-migrate.mjs"), "utf8");
  assert.match(runner, /database\/postgres\/migrations/);
  assert.ok(
    existsSync(join(projectRoot, "modules/application/legacy-record-projection-types.ts")),
    "portable projection types 应保留",
  );
  // Clean-up Iteration：orphan Core story-record 模块已安全删除（零生产
  // 导入的 compat adapter），T10 时期的「保留 Core 契约」时点结论被取代。
  assert.ok(
    !existsSync(join(projectRoot, "modules/story-record/public.ts")),
    "orphan story-record/public.ts 应已删除",
  );
});
