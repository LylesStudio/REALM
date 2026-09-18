/**
 * 批次 T6 导入卡参局——PostgreSQL 集成测试
 * （public documentation §5）。
 *
 * 覆盖（临时库 + 全 19 迁移，不新增 mock）：
 * 1. 导入带 extensions.realm_skills 的卡——合法条目落 skill_definitions
 *    （realm.imported.v1，check 按 T5 契约预验）、非法条目跳过进 warnings、
 *    profile.realm_skill_keys 关联；装配入阵容后授权闭环（卡技能 + 基础技能 +
 *    基础资产 quantity 1，玩家 quantity 2 不变），重复挂入幂等不重复；
 * 2. 参局裁决——PG 规则包按卡技能 metadata.check 推导（2d6）、resolver
 *    判定出 MechanicDetail、未定义技能 SKILL_NOT_AVAILABLE、非持有角色
 *    的技能不进其持有列表（提示词/校验面的 fail-closed 数据源）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresCharacterSkillProvider,
  createPostgresRulePack,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { importTavernBundle } from "../modules/application/tavern-import-service.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const MIGRATIONS = [
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
  "0024_graph_invalidation_events.sql",
    "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
];

const CARD = {
  spec: "chara_card_v2",
  data: {
    name: "艾拉",
    description: "旅队里的年轻制图师。",
    personality: "谨慎",
    extensions: {
      realm_skills: [
        {
          skillKey: "cartography",
          title: "制图术",
          description: "描绘并判读地形。",
          check: { system: "2d6", modifier: 1, target: 8 },
        },
        { skillKey: "herbalism", title: "草药辨识", description: "辨认常见草药。" },
        { skillKey: "BAD KEY!", title: "非法键", description: "非法 skillKey。" },
        {
          skillKey: "cursed_die",
          title: "被诅咒的骰",
          description: "非法 check。",
          check: { system: "d20", modifier: 1.5, target: 10 },
        },
      ],
    },
  },
};

function buildPngWithCard(card: unknown): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const base64 = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([
      Buffer.from("chara", "latin1"),
      Buffer.from([0]),
      Buffer.from(base64, "latin1"),
    ])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = new URL(adminConnectionString!);
  if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
    throw new Error("PostgreSQL integration tests require a loopback database URL.");
  }
  const databaseName = `realm_t6_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  t.after(async () => {
    await ownerPool.end();
    await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });
  for (const filename of MIGRATIONS) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await ownerPool.query(sql);
  }
  await seedPostgresDemo(ownerPool);
  await ownerPool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, display_name) DO NOTHING`,
    [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
  );
  return { ownerPool };
}

const SCOPE = {
  workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
  principalId: LOCAL_RECORD_SCOPE.principalId,
};

/** 建世界 → 导入卡 → 故事 → 记录（装配路径），返回各 id。 */
async function assembleWorldWithImportedCard(ownerPool: pg.Pool) {
  const service = createPostgresLibraryService(ownerPool);
  await service.create(SCOPE, {
    kind: "world",
    name: "图志旷野",
    era: "测绘纪元 12 年",
    summary: "一张等待被补完的地图。",
  });
  const withWorld = await service.list(SCOPE);
  const world = withWorld.worlds.find((item) => item.name === "图志旷野")!;

  const report = await importTavernBundle(
    ownerPool,
    { workspaceId: SCOPE.workspaceId, worldId: world.id },
    buildPngWithCard(CARD),
    "ella.png",
  );

  await service.create(SCOPE, {
    kind: "story",
    worldId: world.id,
    title: "空白图幅",
    premise: "制图师抵达无人踏足的山谷。",
  });
  const withStory = await service.list(SCOPE);
  const story = withStory.worlds.find((item) => item.id === world.id)!
    .stories.find((item) => item.title === "空白图幅")!;
  await service.create(SCOPE, {
    kind: "record",
    storyId: story.id,
    title: "第一幅速写",
  });
  const withRecord = await service.list(SCOPE);
  const record = withRecord.worlds.find((item) => item.id === world.id)!
    .stories.find((item) => item.id === story.id)!.records
    .find((item) => item.title === "第一幅速写")!;
  return { service, world, story, record, report };
}

async function instanceOf(ownerPool: pg.Pool, worldId: string, recordId: string) {
  const result = await ownerPool.query<{
    character_instance_id: string;
    participant_id: string;
  }>(
    `SELECT instance.id AS character_instance_id, participant.id AS participant_id
     FROM character_instances AS instance
     JOIN character_continuities AS continuity
       ON continuity.workspace_id = instance.workspace_id
      AND continuity.worldline_id = instance.worldline_id
      AND continuity.id = instance.continuity_id
     JOIN character_definitions AS definition
       ON definition.workspace_id = continuity.workspace_id
      AND definition.world_id = continuity.world_id
      AND definition.id = continuity.definition_id
     JOIN participants AS participant
       ON participant.workspace_id = instance.workspace_id
      AND participant.record_id = instance.record_id
      AND participant.character_instance_id = instance.id
     WHERE instance.workspace_id = $1
       AND instance.world_id = $2
       AND instance.record_id = $3
       AND definition.display_name = '艾拉'`,
    [SCOPE.workspaceId, worldId, recordId],
  );
  return result.rows[0]!;
}

test(
  "T6 import grants card skills + base asset idempotently through assembly and attach",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t);
    const { service, world, record, report } = await assembleWorldWithImportedCard(
      ownerPool,
    );

    // 导入报告：角色 + 两条非法条目警告（显式报告，不静默）。
    assert.equal(report.character?.name, "艾拉");
    assert.equal(report.warnings.length, 2);
    assert.ok(report.warnings.some((w) => w.includes("BAD KEY!")));
    assert.ok(report.warnings.some((w) => w.includes("cursed_die")));

    // 定义落库：合法两条（realm.imported.v1），check 原样入 metadata。
    const definitions = await ownerPool.query<{
      skill_key: string;
      rule_pack_key: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT skill_key, rule_pack_key, metadata
       FROM skill_definitions
       WHERE workspace_id = $1 AND world_id = $2
       ORDER BY skill_key`,
      [SCOPE.workspaceId, world.id],
    );
    const imported = definitions.rows.filter(
      (row) => row.rule_pack_key === "realm.imported.v1",
    );
    assert.deepEqual(imported.map((row) => row.skill_key), [
      "cartography",
      "herbalism",
    ]);
    assert.deepEqual(imported[0]!.metadata.check, {
      system: "2d6",
      modifier: 1,
      target: 8,
    });
    assert.deepEqual(imported[1]!.metadata, {});

    // profile 关联键。
    const character = await ownerPool.query<{ keys: string[] }>(
      `SELECT profile->'realm_skill_keys' AS keys
       FROM character_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND display_name = '艾拉'`,
      [SCOPE.workspaceId, world.id],
    );
    assert.deepEqual(character.rows[0]!.keys, ["cartography", "herbalism"]);

    // 装配授权闭环：艾拉实例 = 卡技能 2 + 基础技能 2；基础资产 quantity 1。
    const ella = await instanceOf(ownerPool, world.id, record.id);
    const skills = await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM character_skills
       WHERE workspace_id = $1 AND record_id = $2 AND character_instance_id = $3`,
      [SCOPE.workspaceId, record.id, ella.character_instance_id],
    );
    assert.equal(skills.rows[0]!.count, 4);
    const asset = await ownerPool.query<{ quantity: number }>(
      `SELECT quantity::int FROM character_assets
       WHERE workspace_id = $1 AND record_id = $2 AND character_instance_id = $3`,
      [SCOPE.workspaceId, record.id, ella.character_instance_id],
    );
    assert.equal(asset.rows[0]!.quantity, 1);

    // 玩家实例资产余量不变（quantity 2）。
    const playerAsset = await ownerPool.query<{ quantity: number }>(
      `SELECT asset.quantity::int
       FROM character_assets AS asset
       JOIN character_instances AS instance
         ON instance.workspace_id = asset.workspace_id
        AND instance.record_id = asset.record_id
        AND instance.id = asset.character_instance_id
       WHERE asset.workspace_id = $1 AND asset.record_id = $2
         AND instance.controller_mode = 'human'`,
      [SCOPE.workspaceId, record.id],
    );
    assert.equal(playerAsset.rows[0]!.quantity, 2);

    // 幂等：重复挂入（continuity 查重早退 + ON CONFLICT）行数不变。
    const definitionId = report.character!.id;
    await service.create(SCOPE, {
      kind: "attach-character",
      worldId: world.id,
      recordId: record.id,
      definitionId,
    });
    await service.create(SCOPE, {
      kind: "attach-character",
      worldId: world.id,
      recordId: record.id,
      definitionId,
    });
    const afterReattach = await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM character_skills
       WHERE workspace_id = $1 AND record_id = $2 AND character_instance_id = $3`,
      [SCOPE.workspaceId, record.id, ella.character_instance_id],
    );
    assert.equal(afterReattach.rows[0]!.count, 4);

    // fail-closed：不属于本世界的定义 / 不存在的记录。
    await assert.rejects(
      service.create(SCOPE, {
        kind: "attach-character",
        worldId: world.id,
        recordId: record.id,
        definitionId: "char_def_nonexistent",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      service.create(SCOPE, {
        kind: "attach-character",
        worldId: world.id,
        recordId: "record_nonexistent",
        definitionId,
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );
  },
);

test(
  "T6 imported card skill resolves through the PG rule pack; unheld skills stay closed",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t);
    const { world, record } = await assembleWorldWithImportedCard(ownerPool);
    const ella = await instanceOf(ownerPool, world.id, record.id);
    const recordScope = {
      workspaceId: SCOPE.workspaceId,
      worldId: world.id,
      recordId: record.id,
    };
    const actor = {
      characterInstanceId: ella.character_instance_id,
      participantId: ella.participant_id,
      displayName: "艾拉",
    };

    // 卡技能 2d6 推导（数据驱动，参数原样取自定义）。
    const rulePack = createPostgresRulePack(ownerPool, recordScope);
    const decision = await rulePack.decide({
      actor,
      call: {
        callId: "t6:cartography",
        name: "use_skill",
        arguments: { skillId: "cartography", targetId: null, intent: "测绘山谷" },
      },
    });
    assert.equal(decision.resolution, "check");
    assert.deepEqual(decision.check, { system: "2d6", modifier: 1, target: 8 });

    // resolver 判定：脚本骰 3+5+1=9 ≥ 8 成功，MechanicDetail 统一结构。
    const resolver = createDeterministicActionResolver({
      rulePack: createPostgresRulePack(ownerPool, recordScope),
      randomInt: () => 5,
    });
    const transaction = await resolver.resolve({
      actor,
      call: {
        callId: "t6:cartography:resolve",
        name: "use_skill",
        arguments: { skillId: "cartography", targetId: null, intent: "测绘山谷" },
      },
    });
    assert.equal(transaction.receipt.mechanic?.system, "2d6");
    assert.deepEqual(transaction.receipt.mechanic?.rolls, [5, 5]);
    assert.equal(transaction.receipt.mechanic?.total, 11);
    assert.equal(transaction.receipt.outcome, "success");

    // 无 check 卡技能 → 自动成功。
    const auto = await rulePack.decide({
      actor,
      call: {
        callId: "t6:herbalism",
        name: "use_skill",
        arguments: { skillId: "herbalism", targetId: null, intent: "辨认草药" },
      },
    });
    assert.equal(auto.resolution, "automatic");

    // 未定义技能 → SKILL_NOT_AVAILABLE（既有形态）。
    await assert.rejects(
      rulePack.decide({
        actor,
        call: {
          callId: "t6:missing",
          name: "use_skill",
          arguments: { skillId: "no_such_skill", targetId: null, intent: "x" },
        },
      }),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "SKILL_NOT_AVAILABLE",
    );

    // 持有列表（提示词/校验面的 fail-closed 数据源）：艾拉持有卡技能 +
    // 基础技能；玩家实例不持有卡技能（cartography 不在其列表）。
    const recordRow = await ownerPool.query<{ worldline_id: string }>(
      `SELECT worldline_id FROM records
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [SCOPE.workspaceId, world.id, record.id],
    );
    const fullScope = {
      workspaceId: SCOPE.workspaceId,
      worldId: world.id,
      worldlineId: recordRow.rows[0]!.worldline_id,
      recordId: record.id,
    };
    const ellaSkills = await createPostgresCharacterSkillProvider(
      ownerPool,
      fullScope,
    ).listSkills(ella.character_instance_id);
    const ellaKeys = ellaSkills.map((skill) => skill.skillKey);
    for (const expected of [
      "cartography",
      "herbalism",
      "keen_insight",
      "steady_hand",
    ]) {
      assert.ok(ellaKeys.includes(expected), `艾拉应持有 ${expected}`);
    }
    const playerInstance = await ownerPool.query<{ id: string }>(
      `SELECT id FROM character_instances
       WHERE workspace_id = $1 AND record_id = $2 AND controller_mode = 'human'`,
      [SCOPE.workspaceId, record.id],
    );
    const playerSkills = await createPostgresCharacterSkillProvider(
      ownerPool,
      fullScope,
    ).listSkills(playerInstance.rows[0]!.id);
    assert.ok(
      !playerSkills.map((skill) => skill.skillKey).includes("cartography"),
      "玩家实例不应持有导入卡技能",
    );
  },
);
