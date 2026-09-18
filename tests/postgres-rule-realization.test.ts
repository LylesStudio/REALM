/**
 * 批次 T4 规则系统真化——PostgreSQL 集成测试
 * （public documentation §7）。
 *
 * 覆盖（临时库 + 全 19 迁移，不新增 mock）：
 * 1. 基础定义装配恰为 2 技能 + 1 资产 + 1 姿态，幂等，判定参数入 metadata；
 * 2. 数据驱动能力目录——非 demo key（keen_insight/steady_hand/travel_kit/
 *    watchful_guard）授权后目录可见；PG 规则包按 metadata 推导判定形态
 *    （check/自动成功/fail-closed）；
 * 3. 引擎工具账本闭环——use_asset 真实扣减并落 action_receipts、重放幂等
 *    不重复扣减、余额归零目录隐藏且过期选择 400、take_stance 落 active 行
 *    后目录隐藏；consume_resource/apply_effect 的余额守卫、定义权威、
 *    重复进入/移除、目标授权等失败矩阵逐项 fail-closed。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterMemoryRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresRulePack,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import {
  BASE_PLAYER_ASSET_QUANTITY,
  ensureWorldBaseRuleDefinitions,
  grantBaseAssetToInstance,
  grantBaseSkillsToInstances,
  readWorldStyle,
} from "../modules/application/base-rule-definitions.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import {
  createDeterministicActionResolver,
  type ActionTransaction,
} from "../modules/actions/public.ts";
import {
  applyEffect,
  consumeResource,
  type ActionLedgerScope,
} from "../modules/actions/engine.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const WORLD_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  location: "旧时光号破损的木质甲板",
};
const GRANT_SCOPE = {
  ...WORLD_SCOPE,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};
const LEDGER_SCOPE: ActionLedgerScope = {
  ...GRANT_SCOPE,
  actorCharacterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
};
const CATALOG_SCOPE = {
  ...GRANT_SCOPE,
  principalId: POSTGRES_DEMO_IDS.principal,
  characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
};

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_t4_test_${randomUUID().replaceAll("-", "")}`;
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
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await owner.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
  return { owner, ownerPool, runtimePool };
}

test(
  "T4 base rule definitions assemble exactly 2 skills + 1 asset + 1 stance idempotently",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t);

    const definitionIds = await withWorkspaceTransaction(
      ownerPool,
      WORLD_SCOPE.workspaceId,
      async (client) => {
        const style = await readWorldStyle(client, WORLD_SCOPE);
        const first = await ensureWorldBaseRuleDefinitions(client, WORLD_SCOPE, style);
        // 重复装配（创世兜底/多记录共用入口）不得产生重复行。
        await ensureWorldBaseRuleDefinitions(client, WORLD_SCOPE, style);
        return first;
      },
    );

    const counts = await ownerPool.query<{
      skills: number;
      assets: number;
      effects: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM skill_definitions
          WHERE workspace_id = $1 AND world_id = $2
            AND rule_pack_key = 'realm.base.v1') AS skills,
        (SELECT count(*)::int FROM asset_definitions
          WHERE workspace_id = $1 AND world_id = $2
            AND rule_pack_key = 'realm.base.v1') AS assets,
        (SELECT count(*)::int FROM effect_definitions
          WHERE workspace_id = $1 AND world_id = $2
            AND rule_pack_key = 'realm.base.v1') AS effects
    `, [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId]);
    assert.deepEqual(counts.rows[0], { skills: 2, assets: 1, effects: 1 });

    const check = await ownerPool.query<{ skill_key: string; metadata: unknown }>(
      `SELECT skill_key, metadata
       FROM skill_definitions
       WHERE workspace_id = $1 AND world_id = $2
         AND rule_pack_key = 'realm.base.v1'
       ORDER BY skill_key`,
      [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId],
    );
    assert.deepEqual(
      check.rows.map((row) => row.skill_key),
      ["keen_insight", "steady_hand"],
    );
    const keen = check.rows.find((row) => row.skill_key === "keen_insight")!;
    assert.deepEqual((keen.metadata as { check: unknown }).check, {
      system: "d20",
      modifier: 1,
      target: 10,
      partialMargin: 2,
    });
    const steady = check.rows.find((row) => row.skill_key === "steady_hand")!;
    assert.deepEqual(steady.metadata, {});

    assert.equal(definitionIds.skillDefinitionIds.size, 2);
    assert.ok(definitionIds.assetDefinitionId.trim().length > 0);
    assert.ok(definitionIds.stanceDefinitionId.trim().length > 0);
  },
);

test(
  "T4 capability catalog and PG rule pack are data-driven for non-demo keys",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    const baseDefinitionIds = await withWorkspaceTransaction(
      ownerPool,
      WORLD_SCOPE.workspaceId,
      async (client) => {
        const style = await readWorldStyle(client, WORLD_SCOPE);
        const definitions = await ensureWorldBaseRuleDefinitions(
          client,
          WORLD_SCOPE,
          style,
        );
        await grantBaseSkillsToInstances(
          client,
          GRANT_SCOPE,
          definitions.skillDefinitionIds,
          [POSTGRES_DEMO_IDS.playerInstance, POSTGRES_DEMO_IDS.scoutInstance],
        );
        await grantBaseAssetToInstance(
          client,
          GRANT_SCOPE,
          definitions.assetDefinitionId,
          POSTGRES_DEMO_IDS.playerInstance,
        );
        return definitions;
      },
    );
    const assetDefinitionId = baseDefinitionIds.assetDefinitionId;
    const stanceDefinitionId = baseDefinitionIds.stanceDefinitionId;

    const catalog = createPostgresActionAffordanceCatalog(runtimePool);
    const affordances = await catalog.listAuthorized(CATALOG_SCOPE);
    const ids = affordances.map((item) => item.id);
    for (const expected of [
      "skill.keen_insight.scene_surroundings",
      "skill.steady_hand",
      "asset.travel_kit",
      "stance.watchful_guard",
    ]) {
      assert.ok(ids.includes(expected), `catalog should expose ${expected}`);
    }
    const travelKit = affordances.find((item) => item.id === "asset.travel_kit")!;
    assert.match(travelKit.description, new RegExp(`剩余 ${BASE_PLAYER_ASSET_QUANTITY} 次`));

    const rulePack = createPostgresRulePack(runtimePool, WORLD_SCOPE);
    const actor = {
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
      participantId: POSTGRES_DEMO_IDS.playerParticipant,
      displayName: "玩家",
    };

    // metadata.check 有效 → 检定，参数原样取自定义数据。
    const keenDecision = await rulePack.decide({
      actor,
      call: {
        callId: "t4:keen",
        name: "use_skill",
        arguments: { skillId: "keen_insight", targetId: null, intent: "观察" },
      },
    });
    assert.equal(keenDecision.resolution, "check");
    assert.deepEqual(keenDecision.check, {
      system: "d20",
      modifier: 1,
      target: 10,
      partialMargin: 2,
    });
    const targetedKeenDecision = await rulePack.decide({
      actor,
      call: {
        callId: "t4:keen:scene",
        name: "use_skill",
        arguments: {
          skillId: "keen_insight",
          targetId: "scene_surroundings",
          intent: "观察当前场景",
        },
      },
    });
    assert.equal(
      targetedKeenDecision.facts.success,
      "玩家运用「明察」完成了这次尝试。",
    );
    assert.equal(targetedKeenDecision.privateObservation, undefined);
    assert.equal(targetedKeenDecision.privateObservationDetail, undefined);

    // 无 check → 自动成功。
    const steadyDecision = await rulePack.decide({
      actor,
      call: {
        callId: "t4:steady",
        name: "use_skill",
        arguments: { skillId: "steady_hand", targetId: null, intent: "操作" },
      },
    });
    assert.equal(steadyDecision.resolution, "automatic");
    assert.equal(steadyDecision.automaticOutcome, "success");

    // consumable 资产 → 账本成本指向定义行。
    const assetDecision = await rulePack.decide({
      actor,
      call: {
        callId: "t4:kit",
        name: "use_asset",
        arguments: { assetId: "travel_kit", targetId: null, intent: "使用" },
      },
    });
    assert.deepEqual(assetDecision.costs, [{
      resourceId: `asset:${assetDefinitionId}`,
      amount: 1,
    }]);

    // 姿态 → apply 效果指向定义行。
    const stanceDecision = await rulePack.decide({
      actor,
      call: {
        callId: "t4:stance",
        name: "take_stance",
        arguments: { stanceId: "watchful_guard", intent: "警戒" },
      },
    });
    assert.deepEqual(stanceDecision.effects, [{
      effectId: stanceDefinitionId,
      targetId: POSTGRES_DEMO_IDS.playerInstance,
      operation: "apply",
    }]);

    // 未定义能力 fail-closed（保持既有错误形态）。
    await assert.rejects(
      rulePack.decide({
        actor,
        call: {
          callId: "t4:missing:skill",
          name: "use_skill",
          arguments: { skillId: "no_such_skill", targetId: null, intent: "x" },
        },
      }),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "SKILL_NOT_AVAILABLE",
    );
    await assert.rejects(
      rulePack.decide({
        actor,
        call: {
          callId: "t4:missing:asset",
          name: "use_asset",
          arguments: { assetId: "no_such_asset", targetId: null, intent: "x" },
        },
      }),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "ASSET_NOT_AVAILABLE",
    );
    await assert.rejects(
      rulePack.decide({
        actor,
        call: {
          callId: "t4:missing:stance",
          name: "take_stance",
          arguments: { stanceId: "no_such_stance", intent: "x" },
        },
      }),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "STANCE_NOT_AVAILABLE",
    );
  },
);

test(
  "T4 engine tools close the ledger loop with deduction, replay idempotency and fail-closed guards",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    await withWorkspaceTransaction(
      ownerPool,
      WORLD_SCOPE.workspaceId,
      async (client) => {
        const style = await readWorldStyle(client, WORLD_SCOPE);
        const definitions = await ensureWorldBaseRuleDefinitions(
          client,
          WORLD_SCOPE,
          style,
        );
        await grantBaseSkillsToInstances(
          client,
          GRANT_SCOPE,
          definitions.skillDefinitionIds,
          [POSTGRES_DEMO_IDS.playerInstance],
        );
        await grantBaseAssetToInstance(
          client,
          GRANT_SCOPE,
          definitions.assetDefinitionId,
          POSTGRES_DEMO_IDS.playerInstance,
        );
      },
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
      pool: runtimePool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      mapFormalEvent: mapLocalFormalEvent,
      allocateWorldCursors({ previous, eventCount }) {
        return Array.from({ length: eventCount }, (_, index) => ({
          tick: previous.tick,
          ordinal: previous.ordinal + index + 1,
          calendarId: previous.calendarId,
          display: "停战纪元17年 · 雾月12日 · 入夜",
        }));
      },
    });
    const memoryRepository = createPostgresCharacterMemoryRepository(runtimePool);
    const memorySync = createMemorySyncScheduler({
      extract: (scope) => memoryRepository.extractAuthorized(scope),
    });
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      memorySync,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `pg-t4-token-${++sequence}`,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-20T03:00:00.000Z"),
      idFactory: () => `pg-t4-${++sequence}`,
      orchestrator: createLocalM2TurnOrchestrator({
        characters: [],
        // 真实模型路径同款：PG 数据驱动规则包 + stateful 账本许可。
        actionResolver: createDeterministicActionResolver({
          rulePack: createPostgresRulePack(runtimePool, WORLD_SCOPE),
          allowStatefulReceipts: true,
        }),
      }),
    });

    async function readLedger() {
      const result = await ownerPool.query<{
        quantity: number | null;
        receipt_count: number;
        active_effect_count: number;
      }>(`
        SELECT
          (SELECT asset.quantity::int
           FROM character_assets AS asset
           WHERE asset.workspace_id = $1
             AND asset.record_id = $2
             AND asset.character_instance_id = $3
             AND asset.asset_definition_id = (
               SELECT id FROM asset_definitions
               WHERE workspace_id = $1 AND world_id = $4 AND asset_key = 'travel_kit'
             )) AS quantity,
          (SELECT count(*)::int FROM action_receipts) AS receipt_count,
          (SELECT count(*)::int FROM character_effects WHERE status = 'active')
            AS active_effect_count
      `, [
        WORLD_SCOPE.workspaceId,
        POSTGRES_DEMO_IDS.record,
        POSTGRES_DEMO_IDS.playerInstance,
        POSTGRES_DEMO_IDS.world,
      ]);
      return result.rows[0]!;
    }

    const initial = await service.loadRecord();
    const kit = initial.affordances.find((item) => item.id === "asset.travel_kit");
    assert.ok(kit, "travel_kit should be listed before use");
    assert.match(kit!.description, /剩余 2 次/);

    // use_asset → quantity 真实扣减并落 receipt。
    const kitCommand = {
      recordId: POSTGRES_DEMO_IDS.record,
      content: kit!.suggestedText,
      idempotencyKey: "t4-use-kit-1",
      writeToken: initial.writeToken,
      actionSelection: { affordanceId: kit!.id },
    };
    const firstUse = await service.submitMessage(kitCommand);
    assert.equal(firstUse.disposition, "committed");
    assert.match(
      firstUse.affordances.find((item) => item.id === "asset.travel_kit")
        ?.description ?? "",
      /剩余 1 次/,
    );
    const afterFirst = await readLedger();
    assert.equal(afterFirst.quantity, 1);
    assert.equal(afterFirst.receipt_count, 1);

    // 同一命令原样重放 → duplicate，不重复扣减、不新增 receipt。
    const replay = await service.submitMessage(kitCommand);
    assert.equal(replay.disposition, "duplicate");
    const afterReplay = await readLedger();
    assert.equal(afterReplay.quantity, 1);
    assert.equal(afterReplay.receipt_count, 1);

    // 第二次真实扣减 → 余额归零，目录隐藏该资产。
    const secondUse = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: kit!.suggestedText,
      idempotencyKey: "t4-use-kit-2",
      writeToken: firstUse.writeToken,
      actionSelection: { affordanceId: kit!.id },
    });
    assert.equal(secondUse.disposition, "committed");
    assert.equal(
      secondUse.affordances.some((item) => item.id === "asset.travel_kit"),
      false,
    );
    const afterSecond = await readLedger();
    assert.equal(afterSecond.quantity, 0);
    assert.equal(afterSecond.receipt_count, 2);

    // 过期选择（目录已隐藏）→ 400 INVALID_ACTION_SELECTION（保持既有形态）。
    await assert.rejects(
      service.submitMessage({
        recordId: POSTGRES_DEMO_IDS.record,
        content: kit!.suggestedText,
        idempotencyKey: "t4-use-kit-3",
        writeToken: secondUse.writeToken,
        actionSelection: { affordanceId: kit!.id },
      }),
      (error: unknown) =>
        error instanceof LocalRecordServiceError
        && error.code === "INVALID_ACTION_SELECTION",
    );

    // take_stance → character_effects active 行，目录隐藏该姿态。
    const stance = secondUse.affordances.find(
      (item) => item.id === "stance.watchful_guard",
    );
    assert.ok(stance, "watchful_guard should be listed before entering");
    const stanceCommitted = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: stance!.suggestedText,
      idempotencyKey: "t4-take-stance",
      writeToken: secondUse.writeToken,
      actionSelection: { affordanceId: stance!.id },
    });
    assert.equal(stanceCommitted.disposition, "committed");
    assert.equal(
      stanceCommitted.affordances.some((item) => item.id === stance!.id),
      false,
    );
    const afterStance = await readLedger();
    assert.equal(afterStance.active_effect_count, 1);
    assert.equal(afterStance.receipt_count, 3);

    // 引擎工具失败矩阵（同一连接事务内逐项验证后整体回滚，不污染服务状态）。
    const ledgerClient = await ownerPool.connect();
    try {
      await ledgerClient.query("BEGIN");
      await ledgerClient.query("SELECT set_config('realm.workspace_id', $1, true)", [
        WORLD_SCOPE.workspaceId,
      ]);
      {
        const client = ledgerClient;
        await assert.rejects(
          consumeResource(
            client,
            LEDGER_SCOPE,
            { resourceId: "stamina", amount: 1 },
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "RESOURCE_KIND_NOT_AVAILABLE",
        );
        await assert.rejects(
          consumeResource(
            client,
            LEDGER_SCOPE,
            { resourceId: "asset:no_such_asset", amount: 1 },
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "RESOURCE_DEFINITION_UNKNOWN",
        );
        const kitDefinition = await client.query<{ id: string }>(
          `SELECT id FROM asset_definitions
           WHERE workspace_id = $1 AND world_id = $2 AND asset_key = 'travel_kit'`,
          [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId],
        );
        const kitDefinitionId = kitDefinition.rows[0]!.id;
        await assert.rejects(
          // travel_kit 余额已归零：余额守卫拒绝。
          consumeResource(
            client,
            LEDGER_SCOPE,
            { resourceId: `asset:${kitDefinitionId}`, amount: 1 },
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "RESOURCE_UNAVAILABLE",
        );
        const stanceDefinition = await ownerPool.query<{ id: string }>(
          `SELECT id FROM effect_definitions
           WHERE workspace_id = $1 AND world_id = $2 AND effect_key = 'watchful_guard'`,
          [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId],
        );
        const stanceDefinitionId = stanceDefinition.rows[0]!.id;
        // 账本游标约束要求 ended >= applied；从 active 行读出真实游标后递增。
        const activeCursor = await client.query<{ tick: number; ordinal: number }>(
          `SELECT applied_tick::int AS tick, applied_ordinal::int AS ordinal
           FROM character_effects
           WHERE workspace_id = $1
             AND record_id = $2
             AND character_instance_id = $3
             AND effect_definition_id = $4
             AND status = 'active'`,
          [
            WORLD_SCOPE.workspaceId,
            POSTGRES_DEMO_IDS.record,
            POSTGRES_DEMO_IDS.playerInstance,
            stanceDefinitionId,
          ],
        );
        const directReferences = {
          receiptId: "t4-direct",
          transactionId: "t4-direct:action",
          tick: activeCursor.rows[0]!.tick,
          ordinal: activeCursor.rows[0]!.ordinal + 1,
        };
        await assert.rejects(
          applyEffect(
            client,
            LEDGER_SCOPE,
            {
              effectId: stanceDefinitionId,
              targetId: POSTGRES_DEMO_IDS.playerInstance,
              operation: "apply",
            },
            directReferences,
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "EFFECT_ALREADY_ACTIVE",
        );
        await assert.rejects(
          applyEffect(
            client,
            LEDGER_SCOPE,
            {
              effectId: stanceDefinitionId,
              targetId: POSTGRES_DEMO_IDS.scoutInstance,
              operation: "apply",
            },
            directReferences,
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "EFFECT_TARGET_NOT_AUTHORIZED",
        );
        await assert.rejects(
          applyEffect(
            client,
            LEDGER_SCOPE,
            {
              effectId: "no_such_effect",
              targetId: POSTGRES_DEMO_IDS.playerInstance,
              operation: "apply",
            },
            directReferences,
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "EFFECT_DEFINITION_UNKNOWN",
        );
        // remove 语义：先成功移除 active 行，再次移除 fail-closed。
        await applyEffect(
          client,
          LEDGER_SCOPE,
          {
            effectId: stanceDefinitionId,
            targetId: POSTGRES_DEMO_IDS.playerInstance,
            operation: "remove",
          },
          directReferences,
          "2026-08-20T03:00:00.000Z",
        );
        await assert.rejects(
          applyEffect(
            client,
            LEDGER_SCOPE,
            {
              effectId: stanceDefinitionId,
              targetId: POSTGRES_DEMO_IDS.playerInstance,
              operation: "remove",
            },
            directReferences,
            "2026-08-20T03:00:00.000Z",
          ),
          (error: unknown) =>
            error instanceof FatalTurnError
            && error.code === "EFFECT_NOT_ACTIVE",
        );
      }
      await ledgerClient.query("ROLLBACK");
    } catch (error) {
      await ledgerClient.query("ROLLBACK");
      throw error;
    } finally {
      ledgerClient.release();
    }
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
  if (!/^realm_t4_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
