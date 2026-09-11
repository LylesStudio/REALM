import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterMemoryRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import { createCharacterMemoryService } from "../modules/memory/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

test(
  "library lists the demo world and creates world, story and record",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_library_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const owner = new pg.Client({ connectionString: ownerUrl.href });
    await owner.connect();
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

    t.after(async () => {
      await ownerPool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of [
      "0001_runtime_contract.sql",
      "0002_runtime_contract_hardening.sql",
      "0003_runtime_repository.sql",
      "0004_runtime_security_hardening.sql",
      "0005_hybrid_memory.sql",
      "0006_action_state_ledger.sql",
      "0007_dynamic_visibility_policies.sql",
      "0008_record_timeline_kind.sql",
      "0012_accounts.sql",
      "0013_membership_insert_grant.sql",
      "0014_scene_crystallization_grants.sql",
      "0015_account_ui_language.sql",
      "0016_world_files.sql",
      "0017_account_last_opened.sql",
      "0018_account_last_opened_fk_set_null.sql",
      "0019_record_first_nights.sql",
      "0020_record_self_play_sessions.sql",
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
    ]) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await owner.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    // 当前账号的 displayName 是新记录人类玩家名的唯一权威来源。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, display_name) DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
    );

    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };
    const initial = await service.list(scope);
    assert.equal(initial.worlds.length, 1);
    assert.equal(initial.worlds[0]?.stories[0]?.records.length, 1);
    // 世界文风：demo seed 显式 classical。
    assert.equal(initial.worlds[0]?.style, "classical");

    await service.create(scope, {
      kind: "world",
      name: "白塔遗境",
      era: "灰历 300 年",
      summary: "一座拒绝被记录的高塔。",
    });
    const withWorld = await service.list(scope);
    assert.equal(withWorld.worlds.length, 2);
    const createdWorld = withWorld.worlds.find((world) => world.name === "白塔遗境");
    assert.ok(createdWorld);
    assert.equal(createdWorld?.worldlines.length, 1);
    assert.equal(createdWorld?.stories.length, 1);
    assert.equal(createdWorld?.stories[0]?.records.length, 1);
    assert.equal(createdWorld?.stories[0]?.records[0]?.timelineKind, "primary");
    // 缺省无 style 键：读取为空串，前端/运行时按 modern 兜底。
    assert.equal(createdWorld?.style, "");
    const keenInsight = await ownerPool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata
       FROM skill_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND skill_key = 'keen_insight'`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdWorld!.id],
    );
    const keenMetadata = keenInsight.rows[0]?.metadata;
    assert.equal(keenMetadata?.defaultTargetId, "scene_surroundings");
    assert.deepEqual(keenMetadata?.check, {
      system: "d20",
      modifier: 1,
      target: 10,
      partialMargin: 2,
    });
    assert.equal(keenMetadata?.outcomes, undefined);
    assert.equal(keenMetadata?.targets, undefined);

    // 文风切换：写入后可读回，未提及的 settings 键不受影响。
    await service.create(scope, {
      kind: "world-style",
      worldId: createdWorld!.id,
      style: "anime",
    });
    const withStyle = await service.list(scope);
    const styledWorld = withStyle.worlds.find(
      (world) => world.id === createdWorld!.id,
    );
    assert.equal(styledWorld?.style, "anime");
    assert.equal(styledWorld?.era, "灰历 300 年");
    // 未知风格值 fail-closed 到 modern（仍写入合法值，不存脏数据）。
    await service.create(scope, {
      kind: "world-style",
      worldId: createdWorld!.id,
      style: "gothic",
    });
    const afterInvalid = await service.list(scope);
    assert.equal(
      afterInvalid.worlds.find((world) => world.id === createdWorld!.id)?.style,
      "modern",
    );

    await service.create(scope, {
      kind: "branch",
      worldId: createdWorld!.id,
      label: "未开启塔门的另一日",
    });
    const withBranch = await service.list(scope);
    assert.equal(
      withBranch.worlds.find((world) => world.id === createdWorld!.id)
        ?.worldlines.length,
      2,
    );

    await service.create(scope, {
      kind: "character",
      worldId: createdWorld!.id,
      name: "阿岚",
      role: "守塔人",
      summary: "最后一个记得旧日钟声的人。",
    });
    const withCharacter = await service.list(scope);
    assert.equal(
      withCharacter.worlds.find((world) => world.id === createdWorld!.id)
        ?.characters.length,
      2,
    );

    await service.create(scope, {
      kind: "story",
      worldId: createdWorld!.id,
      title: "守塔人的最后一日",
      premise: "塔门第一次在正午开启。",
    });
    const withStory = await service.list(scope);
    const createdStory = withStory.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.title === "守塔人的最后一日");
    assert.ok(createdStory);
    // 批次 T12 验收修正：snapshot 必须携带 story premise（故事视图数据源）。
    assert.equal(createdStory.premise, "塔门第一次在正午开启。");

    await service.create(scope, {
      kind: "record",
      storyId: createdStory.id,
      title: "正午的访客",
    });
    const finalSnapshot = await service.list(scope);
    const finalStory = finalSnapshot.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === createdStory!.id);
    assert.ok(finalStory);
    assert.equal(finalStory.records.length, 1);
    assert.equal(finalStory.records[0]?.title, "正午的访客");

    const createdRecordId = finalStory.records[0]!.id;
    const arlanDefinition = await ownerPool.query<{ id: string }>(
      `SELECT id
       FROM character_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND display_name = '阿岚'`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdWorld!.id],
    );
    const arlanDefinitionId = arlanDefinition.rows[0]?.id;
    assert.ok(arlanDefinitionId);
    const seatBefore = await ownerPool.query<{
      instance_id: string;
      participant_active: boolean;
      instance_status: string;
    }>(
      `SELECT instance.id AS instance_id,
              participant.is_active AS participant_active,
              instance.status AS instance_status
       FROM character_instances AS instance
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = instance.workspace_id AND continuity.id = instance.continuity_id
       JOIN participants AS participant
         ON participant.workspace_id = instance.workspace_id
        AND participant.record_id = instance.record_id
        AND participant.character_instance_id = instance.id
       WHERE instance.workspace_id = $1 AND instance.record_id = $2 AND continuity.definition_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId, arlanDefinitionId],
    );
    assert.equal(seatBefore.rows.length, 1);
    assert.equal(seatBefore.rows[0]?.participant_active, true);
    await service.create(scope, {
      kind: "character-activity",
      worldId: createdWorld!.id,
      recordId: createdRecordId,
      definitionId: arlanDefinitionId,
      active: false,
    });
    const activityScopeProvider = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const inactiveScope = await activityScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: createdRecordId,
    });
    assert.ok(inactiveScope);
    assert.equal(inactiveScope.aiCharacters.some((actor) => actor.displayName === "阿岚"), false);
    const seatAfterLeave = await ownerPool.query<{
      participant_active: boolean;
      instance_status: string;
    }>(
      `SELECT participant.is_active AS participant_active, instance.status AS instance_status
       FROM character_instances AS instance
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = instance.workspace_id AND continuity.id = instance.continuity_id
       JOIN participants AS participant
         ON participant.workspace_id = instance.workspace_id
        AND participant.record_id = instance.record_id
        AND participant.character_instance_id = instance.id
       WHERE instance.workspace_id = $1 AND instance.record_id = $2 AND continuity.definition_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId, arlanDefinitionId],
    );
    assert.deepEqual(seatAfterLeave.rows[0], { participant_active: false, instance_status: "absent" });
    await service.create(scope, {
      kind: "character-activity",
      worldId: createdWorld!.id,
      recordId: createdRecordId,
      definitionId: arlanDefinitionId,
      active: true,
    });
    const activeScope = await activityScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: createdRecordId,
    });
    assert.ok(activeScope?.aiCharacters.some((actor) => actor.displayName === "阿岚"));
    const seatAfterReturn = await ownerPool.query<{
      instance_id: string;
      participant_active: boolean;
      instance_status: string;
    }>(
      `SELECT instance.id AS instance_id,
              participant.is_active AS participant_active,
              instance.status AS instance_status
       FROM character_instances AS instance
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = instance.workspace_id AND continuity.id = instance.continuity_id
       JOIN participants AS participant
         ON participant.workspace_id = instance.workspace_id
        AND participant.record_id = instance.record_id
        AND participant.character_instance_id = instance.id
       WHERE instance.workspace_id = $1 AND instance.record_id = $2 AND continuity.definition_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId, arlanDefinitionId],
    );
    assert.equal(seatAfterReturn.rows[0]?.instance_id, seatBefore.rows[0]?.instance_id);
    assert.deepEqual(
      {
        participant_active: seatAfterReturn.rows[0]?.participant_active,
        instance_status: seatAfterReturn.rows[0]?.instance_status,
      },
      { participant_active: true, instance_status: "present" },
    );
    let sequence = 0;
    const repository = createPostgresRuntimeRepository<
      { text: string; visibility: TurnVisibilityPlan },
      M2TurnPlan,
      M2TurnCandidate,
      M2TurnValidation,
      {
        schemaVersion: 1;
        role: "player" | "character" | "narrator" | "system";
        speaker: string;
        participantId: string | null;
        content: string;
        segments: readonly SemanticSegment[];
        actionTransaction?: ActionTransaction;
      },
      { recordId: string; eventIds: readonly string[] }
    >({
      pool: ownerPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      mapFormalEvent: mapLocalFormalEvent,
      allocateWorldCursors({ previous, eventCount }) {
        return Array.from({ length: eventCount }, (_, index) => ({
          tick: previous.tick,
          ordinal: previous.ordinal + index + 1,
          calendarId: previous.calendarId,
          display: "新记录",
        }));
      },
    });
    const runtimeScopeProvider = createPostgresRecordRuntimeScopeRepository(ownerPool);
    // 批次 T2：回合提交后由 memorySync 异步萃取；记忆断言前 await idle()。
    const memoryRepository = createPostgresCharacterMemoryRepository(ownerPool);
    const memorySync = createMemorySyncScheduler({
      extract: (scope) => memoryRepository.extractAuthorized(scope),
    });
    const recordService = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider,
      memorySync,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `library-token-${++sequence}`,
        clock: () => new Date("2026-08-14T05:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-14T05:00:00.000Z"),
      idFactory: () => `library-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });
    const createdEnvelope = await recordService.loadRecord(createdRecordId);
    assert.equal(createdEnvelope.record.record.id, createdRecordId);
    // 鬼影清除：新世界阵容 = 当前账号玩家 + 本世界自定义角色，
    // 不得出现演示世界的塞娜/弥洛，玩家名取自 accounts.display_name。
    assert.deepEqual(
      createdEnvelope.record.cast.map((member) => member.name).sort(),
      ["测试旅人", "阿岚"].sort(),
    );
    assert.equal(
      createdEnvelope.record.cast.find((member) => member.name === "测试旅人")
        ?.controlledBy,
      "human",
    );
    assert.ok(
      createdEnvelope.record.cast.some((member) => member.name === "阿岚"),
    );
    // 投影动态树：当前世界线的故事列表与当前故事的记录列表。
    assert.deepEqual(
      createdEnvelope.record.stories.map((story) => story.title),
      ["白塔遗境 · 序章", "守塔人的最后一日"],
    );
    assert.deepEqual(
      createdEnvelope.record.records.map((record) => record.title),
      ["正午的访客"],
    );
    const committed = await recordService.submitMessage({
      recordId: createdRecordId,
      content: "我们第一次来到这座塔。",
      idempotencyKey: "library-playable-message",
      writeToken: createdEnvelope.writeToken,
    });
    assert.equal(committed.disposition, "committed");
    assert.ok(
      committed.record.events.some((event) =>
        event.content.includes("我们第一次来到这座塔。")
      ),
    );

    // 模拟源 Record 已经发生过状态结晶：副本必须清空这两个动态字段，
    // 但源 Record 的当前状态保持不变。
    await ownerPool.query(
      `UPDATE scenes
       SET tension = '旧局势', objective = '旧目标'
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId],
    );

    const duplicated = await service.duplicateRecord(scope, createdRecordId);
    assert.equal(duplicated.worldId, createdWorld!.id);
    const afterDuplicate = await service.list(scope);
    const duplicateStory = afterDuplicate.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === duplicated.storyId);
    assert.ok(duplicateStory);
    const duplicateRecord = duplicateStory!.records.find(
      (record) => record.id === duplicated.recordId,
    );
    assert.equal(duplicateRecord?.timelineKind, "retrospection");
    assert.equal(duplicateRecord?.linkedRecordId, createdRecordId);
    await ownerPool.query(
      `UPDATE scenes
       SET tension = '旧版局势', objective = '旧版目标'
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, duplicated.recordId],
    );
    const duplicateEnvelope = await recordService.loadRecord(duplicated.recordId);
    assert.equal(duplicateEnvelope.record.events.length, 0);
    assert.equal(duplicateEnvelope.record.scene.tension, "");
    assert.equal(duplicateEnvelope.record.scene.objective, "");
    const duplicateScope = await runtimeScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: duplicated.recordId,
    });
    assert.equal(duplicateScope?.brief.tension, "");
    assert.equal(duplicateScope?.brief.objective, "");
    assert.deepEqual(
      duplicateEnvelope.record.cast.map((member) => member.name).sort(),
      ["测试旅人", "阿岚"].sort(),
    );
    const originalAfterDuplicate = await recordService.loadRecord(createdRecordId);
    assert.equal(originalAfterDuplicate.record.scene.tension, "旧局势");
    assert.equal(originalAfterDuplicate.record.scene.objective, "旧目标");
    assert.ok(originalAfterDuplicate.record.events.some((event) =>
      event.content.includes("我们第一次来到这座塔。")
    ));

    await service.create(scope, {
      kind: "record",
      storyId: createdStory.id,
      title: "塔内的第二次相遇",
    });
    const afterSecond = await service.list(scope);
    const secondRecord = afterSecond.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === createdStory!.id)!.records
      .find((record) => record.title === "塔内的第二次相遇")!;
    const secondScope = await runtimeScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: secondRecord.id,
    });
    const alan = secondScope?.aiCharacters.find((actor) => actor.displayName === "阿岚");
    assert.ok(alan);
    // 参与者仍 active 但 CharacterInstance 已 gone 时，运行时视角必须 fail-closed，
    // 不得把离场角色重新装配成可行动的 AI cast。
    await ownerPool.query(
      `UPDATE character_instances
       SET status = 'retired'
       WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, alan.characterInstanceId],
    );
    const goneScope = await runtimeScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: secondRecord.id,
    });
    assert.equal(
      goneScope?.aiCharacters.some((actor) => actor.characterInstanceId === alan.characterInstanceId),
      false,
    );
    await ownerPool.query(
      `UPDATE character_instances
       SET status = 'present'
       WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, alan.characterInstanceId],
    );
    // 行动卡动态生长：新世界（无场景数据）走中性兜底，不得串演示世界文案。
    const actionCatalog = createPostgresActionAffordanceCatalog(ownerPool);
    const playerInstance = secondScope!.playerActor.characterInstanceId;
    const newWorldAffordances = await actionCatalog.listAuthorized({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: secondScope!.worldId,
      worldlineId: secondScope!.worldlineId,
      recordId: secondRecord.id,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      characterInstanceId: playerInstance,
    });
    const observe = newWorldAffordances.find(
      (item) => item.id === "scene.observe_surroundings",
    );
    assert.ok(observe);
    assert.equal(observe.description, "留意周遭环境的变化。");
    assert.equal(observe.suggestedText, "我观察周遭的变化。");
    assert.ok(!observe.description.includes("防波堤"));
    assert.ok(!observe.description.includes("灯塔"));

    // demo 世界有场景数据：文案贴合其场景，不得退化为中性兜底。
    const demoAffordances = await actionCatalog.listAuthorized({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: "world_ember_coast",
      worldlineId: "worldline_origin",
      recordId: LOCAL_RECORD_SCOPE.recordId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      characterInstanceId: "char_inst_player",
    });
    const demoObserve = demoAffordances.find(
      (item) => item.id === "scene.observe_surroundings",
    );
    assert.ok(demoObserve);
    assert.ok(demoObserve.description.includes("灰鲸港 · 北防波堤"));
    assert.ok(demoObserve.description.includes("冷雾，无风"));
    // demo 世界为 classical（demo-seed 显式写入）：建议语随文风分流。
    assert.equal(
      demoObserve.suggestedText,
      "我留心灰鲸港 · 北防波堤一带的动静。",
    );
    await memorySync.idle();
    const memory = createCharacterMemoryService({
      repository: memoryRepository,
    });
    const recalled = await memory.recall({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: secondScope!.worldId,
      worldlineId: secondScope!.worldlineId,
      recordId: secondRecord.id,
      characterInstanceId: alan!.characterInstanceId,
      query: "我们第一次来到这座塔",
      limit: 6,
    });
    assert.ok(
      recalled.some((item) => item.content.includes("我们第一次来到这座塔")),
    );
    const summary = await memory.summarize({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: secondScope!.worldId,
      worldlineId: secondScope!.worldlineId,
      recordId: secondRecord.id,
      characterInstanceId: alan!.characterInstanceId,
    });
    assert.ok(summary.includes("近期要点"));
    const summarized = await memory.recall({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: secondScope!.worldId,
      worldlineId: secondScope!.worldlineId,
      recordId: secondRecord.id,
      characterInstanceId: alan!.characterInstanceId,
      query: "近期要点",
      limit: 20,
    });
    assert.ok(summarized.some((item) => item.memoryKind === "summary"));

    await service.create(scope, {
      kind: "record",
      storyId: createdStory.id,
      title: "更早的回溯",
      retrospection: true,
    });
    await service.create(scope, {
      kind: "record",
      storyId: createdStory.id,
      title: "合并视图",
      mergeTargetRecordId: createdRecordId,
    });
    const timeline = await service.list(scope);
    const timelineRecords = timeline.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === createdStory!.id)!.records;
    assert.ok(
      timelineRecords.some((record) =>
        record.title === "更早的回溯" && record.timelineKind === "retrospection"
      ),
    );
    assert.ok(
      timelineRecords.some((record) =>
        record.title === "合并视图"
        && record.timelineKind === "merged"
        && record.linkedRecordId === createdRecordId
      ),
    );

    await assert.rejects(
      service.create(scope, {
        kind: "story",
        worldId: "missing_world",
        title: "不会创建",
        premise: "",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_FOUND",
    );

    // 启笔铸界：单事务原子创建世界/故事/记录/阵容/场景，
    // 人类玩家名绑定 accounts.display_name，同伴来自草稿。
    const genesis = await service.createGenesis(scope, {
      world: { name: "云港志", era: "风账纪元 3 年", summary: "云海上的旧船港。" },
      style: "modern",
      story: { title: "雾中航船", premise: "一艘无籍船靠岸。" },
      record: { title: "靠岸" },
      playerRole: "替港口辨认风声的新账房",
      companions: [
        { name: "阿橹", role: "记账员", summary: "听得懂风声的人。" },
        { name: "老锚", role: "泊台向导", summary: "认得每一条航线。" },
      ],
      scene: {
        location: "七号泊台",
        weather: "平流雾",
        tension: "港卫警惕",
        objective: "登记来船",
      },
      playerStance: "player",
      opening: "",
    });
    const genesisLibrary = await service.list(scope);
    const genesisWorld = genesisLibrary.worlds.find(
      (world) => world.id === genesis.worldId,
    );
    assert.ok(genesisWorld);
    assert.equal(genesisWorld.worldlines.length, 1);
    assert.equal(genesisWorld.stories[0]?.id, genesis.storyId);
    assert.equal(genesisWorld.stories[0]?.records[0]?.id, genesis.recordId);
    // 阵容定义含自动装配的人类玩家与草稿同伴，无任何演示世界角色。
    assert.deepEqual(
      genesisWorld.characters.map((character) => character.name).sort(),
      ["测试旅人", "阿橹", "老锚"].sort(),
    );

    const genesisEnvelope = await recordService.loadRecord(genesis.recordId);
    assert.equal(genesisEnvelope.record.record.id, genesis.recordId);
    assert.deepEqual(
      genesisEnvelope.record.cast.map((member) => member.name).sort(),
      ["测试旅人", "阿橹", "老锚"].sort(),
    );
    const genesisPlayer = genesisEnvelope.record.cast.find(
      (member) => member.name === "测试旅人",
    );
    assert.equal(genesisPlayer?.controlledBy, "human");
    assert.equal(genesisPlayer?.role, "替港口辨认风声的新账房");
    assert.equal(genesisEnvelope.record.scene.location, "七号泊台");
    assert.equal(genesisEnvelope.record.scene.weather, "平流雾");
    assert.equal(genesisEnvelope.record.scene.tension, "港卫警惕");
    assert.equal(genesisEnvelope.record.scene.objective, "登记来船");
    assert.deepEqual(
      genesisEnvelope.record.stories.map((story) => story.title),
      ["雾中航船"],
    );
    assert.deepEqual(
      genesisEnvelope.record.records.map((record) => record.title),
      ["靠岸"],
    );

    // ===== 批次 S · 需求三：观察者创世 + 卷首旁白 =====
    const observerGenesis = await service.createGenesis(scope, {
      world: { name: "观灯塔", era: "雾历元年", summary: "只有执笔者能看见的灯塔。" },
      style: "modern",
      story: { title: "首夜值守", premise: "观察者执笔入局。" },
      record: { title: "值守" },
      playerRole: "",
      companions: [
        { name: "灯芯", role: "守灯人", summary: "守着灯不灭的人。" },
      ],
      scene: { location: "灯室", weather: "浓雾", tension: "候船", objective: "点灯" },
      playerStance: "observer",
      opening: "雾压在灯室的玻璃上，执笔者落笔入局。",
    });

    // membership role='observer'，omniscient 仍为 true（不碰不可变约束）。
    const observerMembership = await ownerPool.query<{
      role: string;
      omniscient_player_character: boolean;
    }>(
      `SELECT role, omniscient_player_character
       FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.worldId, LOCAL_RECORD_SCOPE.principalId],
    );
    assert.equal(observerMembership.rows[0]?.role, "observer");
    assert.equal(observerMembership.rows[0]?.omniscient_player_character, true);

    // 席位形态：人类 narrator 席位（无角色实例）+ AI 角色席位；
    // 绝不创建玩家角色定义/实例/参与者。
    const observerSeats = await ownerPool.query<{
      participant_kind: string;
      controller_mode: string;
      principal_id: string | null;
      is_active: boolean;
      character_instance_id: string | null;
    }>(
      `SELECT participant_kind, controller_mode, principal_id, is_active,
              character_instance_id
       FROM participants
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY speaking_order ASC`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.recordId],
    );
    assert.deepEqual(
      observerSeats.rows.map((row) => row.participant_kind),
      ["narrator", "character"],
    );
    const narratorSeat = observerSeats.rows[0]!;
    assert.equal(narratorSeat.controller_mode, "human");
    assert.equal(narratorSeat.principal_id, LOCAL_RECORD_SCOPE.principalId);
    assert.equal(narratorSeat.character_instance_id, null);
    assert.equal(narratorSeat.is_active, true);
    assert.equal(observerSeats.rows[1]!.controller_mode, "ai");

    // 交付投影：viewer.membershipRole 透出；cast 只列 character 参与者
    // （观察者在阵容外）；开场事件在时间线。
    const delivery = createPostgresDeliveryProjectionRepository(ownerPool);
    const observerDelivery = await delivery.loadDeliveryForPlayer({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: observerGenesis.recordId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    });
    assert.ok(observerDelivery);
    assert.equal(observerDelivery.viewer.membershipRole, "observer");
    assert.equal(observerDelivery.viewer.perspective, "omniscient");
    assert.deepEqual(
      observerDelivery.record.cast.map((member) => member.name),
      ["灯芯"],
    );
    assert.equal(observerDelivery.record.events.length, 1);
    const openingEvent = observerDelivery.record.events[0]!;
    assert.equal(openingEvent.speaker, "旁白");
    assert.equal(openingEvent.type, "narration");
    assert.equal(openingEvent.content, "雾压在灯室的玻璃上，执笔者落笔入局。");

    // record_heads 推进：version=1、next_ordinal=2、last_event_id 指向开场事件。
    const observerHead = await ownerPool.query<{
      record_version: string;
      next_record_ordinal: string;
      last_event_id: string | null;
    }>(
      `SELECT record_version::text, next_record_ordinal::text, last_event_id
       FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.recordId],
    );
    assert.equal(observerHead.rows[0]?.record_version, "1");
    assert.equal(observerHead.rows[0]?.next_record_ordinal, "2");
    assert.ok(observerHead.rows[0]?.last_event_id);

    // 世界线头必须与开场事件的世界坐标 (0,1) 同步推进——否则观察者
    // 首回合 release 从旧头 (0,0) 分配游标，撞 events 世界坐标唯一约束。
    const observerWorldline = await ownerPool.query<{
      head_tick: string;
      head_ordinal: string;
    }>(
      `SELECT worldline.head_tick::text, worldline.head_ordinal::text
       FROM worldlines AS worldline
       JOIN records AS record
         ON record.workspace_id = worldline.workspace_id
        AND record.worldline_id = worldline.id
       WHERE record.workspace_id = $1 AND record.id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.recordId],
    );
    assert.equal(observerWorldline.rows[0]?.head_tick, "0");
    assert.equal(observerWorldline.rows[0]?.head_ordinal, "1");

    // 运行时席位解析：playerActor = narrator 席位，characterInstanceId 空串，
    // displayName 取账号昵称；AI 角色照常列出。
    const observerScope = await runtimeScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: observerGenesis.recordId,
    });
    assert.ok(observerScope);
    assert.equal(observerScope.playerActor.characterInstanceId, "");
    assert.ok(observerScope.playerActor.participantId.startsWith("participant_narrator"));
    assert.equal(observerScope.playerActor.displayName, "测试旅人");
    assert.deepEqual(
      observerScope.aiCharacters.map((actor) => actor.displayName),
      ["灯芯"],
    );

    // 观察者打开记录：affordances 为空（不触碰行动目录非空校验），
    // 徽标语义与开场事件随 envelope 就位。
    const observerEnvelope = await recordService.loadRecord(observerGenesis.recordId);
    assert.equal(observerEnvelope.affordances.length, 0);
    assert.equal(observerEnvelope.viewer.membershipRole, "observer");
    assert.equal(observerEnvelope.record.events.length, 1);

    // 批次 T10-B6：observer 只读新语义——添角色前把本人姿态切回 player
    //（姿态往返语义不变，此处对齐夹具状态而非放宽矩阵）。
    await service.create(scope, {
      kind: "player-stance",
      worldId: observerGenesis.worldId,
      stance: "player",
    });

    // ===== 批次 S · 需求三：添角色并进当前阵容（attachRecordId） =====
    await service.create(scope, {
      kind: "character",
      worldId: observerGenesis.worldId,
      name: "雾中新使",
      role: "信使",
      summary: "随雾而来。",
      attachRecordId: observerGenesis.recordId,
    });
    const attachedEnvelope = await recordService.loadRecord(observerGenesis.recordId);
    // 姿态切回 player 后人类席位在阵容中（T10-B6 对齐）：玩家本人 + 灯芯 + 雾中新使。
    assert.deepEqual(
      attachedEnvelope.record.cast.map((member) => member.name).sort(),
      ["雾中新使", "灯芯", "测试旅人"].sort(),
    );
    // 每个定义只装配一次：同名条目在阵容中仅出现一次。
    assert.equal(
      attachedEnvelope.record.cast.filter((member) => member.name === "雾中新使").length,
      1,
    );
    // 未携带 attachRecordId 的角色只入世界库，不进阵容。
    await service.create(scope, {
      kind: "character",
      worldId: observerGenesis.worldId,
      name: "局外客",
      role: "旅客",
      summary: "尚未登场。",
    });
    const detachedEnvelope = await recordService.loadRecord(observerGenesis.recordId);
    assert.ok(!detachedEnvelope.record.cast.some((member) => member.name === "局外客"));

    // ===== 批次 S · 需求三：观察者执笔真实回合（卷首旁白后世界游标回归） =====
    // 开场事件已占世界坐标 (0,1)；执笔者回合必须能正常 release，
    // 而不是撞世界坐标唯一约束被误报 FORMAL_EVENT_ID_CONFLICT。
    const narratorTurn = await recordService.submitMessage({
      recordId: observerGenesis.recordId,
      content: "雾中新使沿着石阶走向灯塔。",
      idempotencyKey: "observer-narrator-turn",
      writeToken: detachedEnvelope.writeToken,
    });
    assert.equal(narratorTurn.disposition, "committed");
    assert.ok(narratorTurn.record.events.length > 1);
    assert.ok(
      narratorTurn.record.events.some((event) =>
        event.content.includes("雾中新使沿着石阶走向灯塔。")
      ),
    );
    // attachRecordId 指向不存在/异世界的记录 → fail-closed。
    await assert.rejects(
      service.create(scope, {
        kind: "character",
        worldId: observerGenesis.worldId,
        name: "错位者",
        role: "",
        summary: "",
        attachRecordId: "record_missing",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_FOUND",
    );

    // ===== 批次 S · 需求三：姿态切换（player-stance 命令） =====
    // 观察者世界 → 入局：role 变更、narrator 席位停用、玩家席位按约定补建。
    await service.create(scope, {
      kind: "player-stance",
      worldId: observerGenesis.worldId,
      stance: "player",
    });
    const afterJoin = await ownerPool.query<{ role: string }>(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.worldId, LOCAL_RECORD_SCOPE.principalId],
    );
    assert.equal(afterJoin.rows[0]?.role, "player");
    const joinEnvelope = await recordService.loadRecord(observerGenesis.recordId);
    assert.equal(joinEnvelope.viewer.membershipRole, "player");
    assert.ok(joinEnvelope.record.cast.some((member) => member.name === "测试旅人"));
    // 补建走 char_def_player_<world> 约定，且玩家席位带来可用行动卡。
    const playerDefs = await ownerPool.query<{ id: string }>(
      `SELECT id FROM character_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [
        LOCAL_RECORD_SCOPE.workspaceId,
        observerGenesis.worldId,
        `char_def_player_${observerGenesis.worldId.slice(-24)}`,
      ],
    );
    assert.equal(playerDefs.rows.length, 1);
    assert.ok(joinEnvelope.affordances.length > 0);

    // 入局 → 观察者：玩家席位置 is_active=false（绝不删除），narrator 席位复活。
    await service.create(scope, {
      kind: "player-stance",
      worldId: observerGenesis.worldId,
      stance: "observer",
    });
    const afterLeave = await ownerPool.query<{
      participant_kind: string;
      is_active: boolean;
    }>(
      `SELECT participant_kind, is_active
       FROM participants
       WHERE workspace_id = $1 AND record_id = $2
         AND principal_id = $3
       ORDER BY participant_kind ASC`,
      [LOCAL_RECORD_SCOPE.workspaceId, observerGenesis.recordId, LOCAL_RECORD_SCOPE.principalId],
    );
    const humanSeat = afterLeave.rows.find((row) => row.participant_kind === "character");
    const narratorAgain = afterLeave.rows.find((row) => row.participant_kind === "narrator");
    assert.equal(humanSeat?.is_active, false);
    assert.equal(narratorAgain?.is_active, true);
    const leaveEnvelope = await recordService.loadRecord(observerGenesis.recordId);
    assert.equal(leaveEnvelope.viewer.membershipRole, "observer");
    assert.ok(!leaveEnvelope.record.cast.some(
      (member) => member.name === "测试旅人" && member.isActive,
    ));
    assert.equal(leaveEnvelope.affordances.length, 0);

    // 入局创建的世界切观察者再切回：原玩家席位复活，参与者行数不增长。
    const seatsBeforeToggle = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM participants
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, genesis.recordId],
    );
    await service.create(scope, {
      kind: "player-stance",
      worldId: genesis.worldId,
      stance: "observer",
    });
    const observerPhaseEnvelope = await recordService.loadRecord(genesis.recordId);
    assert.equal(observerPhaseEnvelope.viewer.membershipRole, "observer");
    assert.ok(!observerPhaseEnvelope.record.cast.some(
      (member) => member.name === "测试旅人" && member.isActive,
    ));
    await service.create(scope, {
      kind: "player-stance",
      worldId: genesis.worldId,
      stance: "player",
    });
    const restoredEnvelope = await recordService.loadRecord(genesis.recordId);
    assert.equal(restoredEnvelope.viewer.membershipRole, "player");
    assert.ok(restoredEnvelope.record.cast.some(
      (member) => member.name === "测试旅人" && member.isActive,
    ));
    const seatsAfterToggle = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM participants
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, genesis.recordId],
    );
    // narrator 席位永不删除（events FK）：往返一次净增一个停用 narrator 席位；
    // 本人的人类角色席位始终只有一行（复活而非重建）。
    assert.equal(
      seatsAfterToggle.rows[0]?.count,
      String(Number(seatsBeforeToggle.rows[0]?.count) + 1),
    );
    const humanSeats = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM participants
       WHERE workspace_id = $1 AND record_id = $2
         AND participant_kind = 'character' AND controller_mode = 'human'
         AND principal_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, genesis.recordId, LOCAL_RECORD_SCOPE.principalId],
    );
    assert.equal(humanSeats.rows[0]?.count, "1");

    // 批次 T12-B：同故事再建一条 Record，用于归档后验证
    // ① 深链打开 archived Record fail-closed；② 投影导航列表不外显 archived。
    await service.create(scope, {
      kind: "record",
      storyId: createdStory.id,
      title: "守夜人",
    });
    const siblingSnapshot = await service.list(scope);
    const siblingRecordId = siblingSnapshot.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === createdStory.id)!
      .records.find((record) => record.title === "守夜人")!.id;

    // Record 删除：隐藏列表、保留 append-only Events、清空最近打开记忆，且重复请求幂等。
    const eventCountBeforeDelete = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId],
    );
    await ownerPool.query(
      `UPDATE accounts SET last_record_id = $2
       WHERE workspace_id = $1 AND principal_id = $3`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId, LOCAL_RECORD_SCOPE.principalId],
    );
    await service.create(scope, {
      kind: "delete-record",
      worldId: createdWorld!.id,
      recordId: createdRecordId,
    });
    const deletedStatus = await ownerPool.query<{ status: string }>(
      `SELECT status FROM records WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId],
    );
    assert.equal(deletedStatus.rows[0]?.status, "archived");
    const eventCountAfterDelete = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, createdRecordId],
    );
    assert.equal(eventCountAfterDelete.rows[0]?.count, eventCountBeforeDelete.rows[0]?.count);
    const accountAfterDelete = await ownerPool.query<{ last_record_id: string | null }>(
      `SELECT last_record_id FROM accounts
       WHERE workspace_id = $1 AND principal_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId],
    );
    assert.equal(accountAfterDelete.rows[0]?.last_record_id, null);
    assert.equal(await runtimeScopeProvider.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: createdRecordId,
    }), null);
    const afterRecordDelete = await service.list(scope);
    const afterDeleteStory = afterRecordDelete.worlds
      .find((world) => world.id === createdWorld!.id)!
      .stories.find((story) => story.id === createdStory.id);
    assert.ok(afterDeleteStory);
    assert.equal(afterDeleteStory.records.some((record) => record.id === createdRecordId), false);
    // 批次 T12-B：未归档的同级 Record 保留。
    assert.equal(afterDeleteStory.records.some((record) => record.id === siblingRecordId), true);
    // 批次 T12-B①：深链直接打开已归档 Record fail-closed（NOT_FOUND）。
    await assert.rejects(
      recordService.loadRecord(createdRecordId),
      (error: unknown) =>
        error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
    );
    // 批次 T12-B②：同故事打开未归档 Record，投影导航列表不含 archived。
    const siblingEnvelope = await recordService.loadRecord(siblingRecordId);
    assert.equal(
      siblingEnvelope.record.records.some((record) => record.id === createdRecordId),
      false,
    );
    assert.equal(
      siblingEnvelope.record.records.some((record) => record.id === siblingRecordId),
      true,
    );
    await service.create(scope, {
      kind: "delete-record",
      worldId: createdWorld!.id,
      recordId: createdRecordId,
    });

    // 未知世界 fail-closed。
    await assert.rejects(
      service.create(scope, {
        kind: "player-stance",
        worldId: "missing_world",
        stance: "observer",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_FOUND",
    );
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_library_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}


test(
  "library hides ghost containers left by archived retrospection records",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_library_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of readdirSync(migrationDir).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      principalId: POSTGRES_DEMO_IDS.principal,
    };
    const demoWorldId = POSTGRES_DEMO_IDS.world;

    // 空 primary Story 与空手动 Worldline（无 Record）必须保留可见。
    await service.create(scope, {
      kind: "story",
      worldId: demoWorldId,
      title: "空的故事",
      premise: "尚无记录。",
    });
    const emptyWorldlineId = `worldline_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, '空分支', 'active', 0, 0)`,
      [POSTGRES_DEMO_IDS.workspace, demoWorldId, emptyWorldlineId],
    );

    const baseline = await service.list(scope);
    const baselineWorld = baseline.worlds.find((world) => world.id === demoWorldId)!;
    const baseStoryCount = baselineWorld.storyCount;
    const baseWorldlineCount = baselineWorld.worldlines.length;

    // 真实 duplicateRecord 产生两个 retrospection 派生（各自独立 Story/Worldline）。
    const retroA = await service.duplicateRecord(scope, POSTGRES_DEMO_IDS.record);
    const retroB = await service.duplicateRecord(scope, POSTGRES_DEMO_IDS.record);
    const retroARow = (await ownerPool.query(
      `SELECT story_id, worldline_id FROM records WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, retroA.recordId],
    )).rows[0];
    const retroBRow = (await ownerPool.query(
      `SELECT story_id, worldline_id FROM records WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, retroB.recordId],
    )).rows[0];

    // 归档 retroA；retroB 保持 active。
    await service.create(scope, {
      kind: "delete-record",
      worldId: demoWorldId,
      recordId: retroA.recordId,
    });

    const after = await service.list(scope);
    const world = after.worlds.find((item) => item.id === demoWorldId)!;

    // storyCount：只多 active 派生一个（archived 派生的 Story 不计入）。
    assert.equal(world.storyCount, baseStoryCount + 1, "archived 派生的空 Story 不得计入 storyCount");
    assert.equal(world.worldlines.length, baseWorldlineCount + 1, "archived 派生的空 Worldline 不得出现");
    // stories：retroA 的 Story 消失，retroB 与 primary/空 Story 保留。
    assert.ok(!world.stories.some((story) => story.id === retroARow.story_id), "archived 派生的 Story 不得出现");
    assert.ok(world.stories.some((story) => story.id === retroBRow.story_id), "active 派生的 Story 必须保留");
    assert.ok(world.stories.some((story) => story.id === POSTGRES_DEMO_IDS.story), "primary Story 必须保留");
    assert.ok(world.stories.some((story) => story.title === "空的故事"), "无 Record 的空 Story 必须保留");
    // worldlines：retroA 的 Worldline 消失，retroB/primary/空分支保留。
    assert.ok(!world.worldlines.some((line) => line.id === retroARow.worldline_id), "archived 派生的 Worldline 不得出现");
    assert.ok(world.worldlines.some((line) => line.id === retroBRow.worldline_id), "active 派生的 Worldline 必须保留");
    assert.ok(world.worldlines.some((line) => line.id === POSTGRES_DEMO_IDS.worldline), "primary Worldline 必须保留");
    assert.ok(world.worldlines.some((line) => line.id === emptyWorldlineId), "无 Record 的空 Worldline 必须保留");
    // records：retroA 的 Record 任何列表都不出现；retroB 的保留。
    const allRecords = world.stories.flatMap((story) => story.records);
    assert.ok(!allRecords.some((record) => record.id === retroA.recordId));
    assert.ok(allRecords.some((record) => record.id === retroB.recordId));

    // append-only 边界：归档 Record 行仍在，status=archived，未物理删除。
    const archivedRow = await ownerPool.query(
      `SELECT status FROM records WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, retroA.recordId],
    );
    assert.equal(archivedRow.rows[0]?.status, "archived", "归档是隐藏而非物理删除");
  },
);
