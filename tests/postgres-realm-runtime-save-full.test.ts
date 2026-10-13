/**
 * `.realm` runtime-save v2 全量运行态切片 PG 验收（disposable scratch PG；
 * 独立临时库，绝不触碰共享 realm_dev）。
 *
 * 覆盖：
 * 1. 含 action receipt（d20 物化骰点 + asset 消耗 + stance 效果）、
 *    character_effect、observation 的 Record 存档 → restore → 幂等 replay
 *    不重复、不重掷（receipt/mechanic 与 source 逐字节一致）；
 * 2. 目标 Record 的 source event/actor/scene/policy/character instance 引用
 *    全部重映射到 restore 作用域 id；
 * 3. 失败场景 fail-closed 且整体回滚零残留：receipt 跨 Record 事件引用、
 *    observation 指向未恢复事件、目标 World 缺 effect definition、
 *    schema 损坏（parse 期 fail-closed）；
 * 4. RLS/workspace boundary：observer/无 membership principal、跨 workspace
 *    restore 一律 WORLD_NOT_FOUND 且零残留。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { zipSync } from "fflate";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterMemoryRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRulePack,
  createPostgresRuntimeRepository,
  RealmRuntimeSaveRepositoryError,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import {
  ensureWorldBaseRuleDefinitions,
  grantBaseAssetToInstance,
  grantBaseSkillsToInstances,
  readWorldStyle,
} from "../modules/application/base-rule-definitions.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import { createDeterministicActionResolver } from "../modules/actions/public.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import {
  buildRealmRuntimeSaveArchive,
  computeRealmRuntimeSaveContentHash,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
  serializeRealmRuntimeSaveManifestV2,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveActionReceiptsV1,
  type RealmRuntimeSaveCharacterEffectsV1,
  type RealmRuntimeSaveManifestV2,
  type RealmRuntimeSaveObservationsV1,
} from "../modules/world-transfer/realm-runtime-save.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const WORLD_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
};
const RECORD_SCOPE = {
  ...WORLD_SCOPE,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL integration tests require a loopback database URL.");
  }
  return value;
}

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_save_full_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  ownerPool.on("error", () => {});
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  runtimePool.on("error", () => {});

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(
      await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"),
    );
  }
  await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
  return { ownerPool, runtimePool };
}

/** 脚本化随机源（确定性语义断言用）；耗尽即抛错防静默越界。 */
function scriptedRandom(script: readonly number[]): {
  randomInt: (min: number, max: number) => number;
  exhausted: () => boolean;
} {
  const queue = [...script];
  return {
    randomInt(min, max) {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("scripted randomInt exhausted");
      }
      if (next < min || next > max) {
        throw new Error(`scripted value ${next} out of [${min}, ${max}]`);
      }
      return next;
    },
    exhausted: () => queue.length === 0,
  };
}

function createService(
  runtimePool: pg.Pool,
  randomInt: (min: number, max: number) => number,
) {
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
  return createLocalRecordService({
    repository,
    projection: createPostgresDeliveryProjectionRepository(runtimePool),
    actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
    runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(runtimePool),
    memorySync,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `pg-save-full-token-${++sequence}`,
      clock: () => new Date("2026-08-20T03:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-20T03:00:00.000Z"),
    idFactory: () => `pg-save-full-${++sequence}`,
    orchestrator: createLocalM2TurnOrchestrator({
      characters: [],
      actionResolver: createDeterministicActionResolver({
        rulePack: createPostgresRulePack(runtimePool, RECORD_SCOPE),
        allowStatefulReceipts: true,
        randomInt,
      }),
    }),
  });
}

/** restore 作用域产物计数（零残留断言；临时库内无其它 restore 行）。 */
async function restoreArtifactCounts(pool: pg.Pool) {
  const { rows } = await pool.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM worldlines WHERE id LIKE 'worldline\\_restore\\_%') AS worldlines,
      (SELECT count(*)::int FROM stories WHERE id LIKE 'story\\_restore\\_%') AS stories,
      (SELECT count(*)::int FROM records WHERE id LIKE 'record\\_restore\\_%') AS records,
      (SELECT count(*)::int FROM events WHERE id LIKE 'restore\\_event\\_%') AS events,
      (SELECT count(*)::int FROM goal_instances WHERE id LIKE 'goal\\_restore\\_%') AS goals,
      (SELECT count(*)::int FROM goal_assessments WHERE id LIKE 'assessment\\_restore\\_%') AS assessments,
      (SELECT count(*)::int FROM action_receipts WHERE id LIKE 'action\\_receipt\\_restore\\_%') AS receipts,
      (SELECT count(*)::int FROM character_effects WHERE id LIKE 'character\\_effect\\_restore\\_%') AS effects,
      (SELECT count(*)::int FROM observations WHERE id LIKE 'observation\\_restore\\_%') AS observations,
      (SELECT count(*)::int FROM participants WHERE id LIKE 'participant\\_restore\\_%') AS participants,
      (SELECT count(*)::int FROM character_instances WHERE id LIKE 'character\\_instance\\_restore\\_%') AS instances,
      (SELECT count(*)::int FROM scenes WHERE id LIKE 'scene\\_restore\\_%') AS scenes,
      (SELECT count(*)::int FROM visibility_policies WHERE id LIKE 'policy\\_restore\\_%') AS policies
  `);
  return rows[0]!;
}

test(
  "runtime-save v2 action receipts / character effects / observations 全量切片",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);

    // 装配 base 规则定义并授权玩家实例（d20 技能 + 消耗品 + 姿态）。
    await withWorkspaceTransaction(ownerPool, WORLD_SCOPE.workspaceId, async (client) => {
      const style = await readWorldStyle(client, WORLD_SCOPE);
      const base = await ensureWorldBaseRuleDefinitions(client, WORLD_SCOPE, style);
      await grantBaseSkillsToInstances(client, RECORD_SCOPE, base.skillDefinitionIds, [
        POSTGRES_DEMO_IDS.playerInstance,
      ]);
      await grantBaseAssetToInstance(
        client,
        RECORD_SCOPE,
        base.assetDefinitionId,
        POSTGRES_DEMO_IDS.playerInstance,
      );
    });

    // 脚本：keen_insight d20 掷 14（+1=15 ≥ 10 成功）；asset/stance 为
    // automatic 裁决，不得消耗任何随机值。
    const script = scriptedRandom([14]);
    const service = createService(runtimePool, script.randomInt);
    const catalog = createPostgresActionAffordanceCatalog(runtimePool);
    const affordances = await catalog.listAuthorized({
      ...RECORD_SCOPE,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
    });
    const skillAffordance = affordances.find((item) => item.id.startsWith("skill.keen_insight"))?.id;
    assert.ok(skillAffordance, "catalog should expose a keen_insight skill affordance");

    const initial = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
    const skillTurn = await service.submitMessage({
      recordId: RECORD_SCOPE.recordId,
      content: "仔细观察周围环境。",
      idempotencyKey: "save-full-skill-1",
      writeToken: initial.writeToken,
      actionSelection: { affordanceId: skillAffordance },
    });
    assert.equal(skillTurn.disposition, "committed");
    const assetTurn = await service.submitMessage({
      recordId: RECORD_SCOPE.recordId,
      content: "打开旅行工具包。",
      idempotencyKey: "save-full-asset-1",
      writeToken: skillTurn.writeToken,
      actionSelection: { affordanceId: "asset.travel_kit" },
    });
    assert.equal(assetTurn.disposition, "committed");
    const stanceTurn = await service.submitMessage({
      recordId: RECORD_SCOPE.recordId,
      content: "进入守望姿态。",
      idempotencyKey: "save-full-stance-1",
      writeToken: assetTurn.writeToken,
      actionSelection: { affordanceId: "stance.watchful_guard" },
    });
    assert.equal(stanceTurn.disposition, "committed");
    assert.ok(script.exhausted(), "only the d20 check may consume scripted randomness");

    // ---- source 运行态快照 --------------------------------------------
    const sourceReceipts = (await ownerPool.query<{
      id: string;
      transaction_id: string;
      actor_character_instance_id: string;
      source_event_id: string;
      receipt: Record<string, unknown>;
    }>(
      `SELECT id, transaction_id, actor_character_instance_id, source_event_id, receipt
       FROM action_receipts
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY world_tick ASC, world_ordinal ASC, id ASC`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    )).rows;
    assert.equal(sourceReceipts.length, 3, "skill+asset+stance 各物化一张 receipt");
    const sourceEffects = (await ownerPool.query<{
      id: string;
      character_instance_id: string;
      status: string;
      applied_tick: string;
      applied_ordinal: string;
    }>(
      `SELECT id, character_instance_id, status, applied_tick, applied_ordinal
       FROM character_effects
       WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    )).rows;
    assert.equal(sourceEffects.length, 1);
    assert.equal(sourceEffects[0]!.status, "active");
    const sourceObservations = (await ownerPool.query<{
      id: string;
      observer_character_instance_id: string;
      source_event_id: string;
      content: string;
      dedupe_key: string;
    }>(
      `SELECT id, observer_character_instance_id, source_event_id, content, dedupe_key
       FROM observations
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    )).rows;
    assert.ok(sourceObservations.length >= 2, "plain turn 为在场观察者落 observations");
    const sourceEventCount = (await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM events
       WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    )).rows[0]!.count;

    // ---- save：三段运行态进入存档 -------------------------------------
    const reader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const archive = await reader.load({
      workspaceId: WORLD_SCOPE.workspaceId,
      recordId: RECORD_SCOPE.recordId,
    });
    assert.ok(archive, "demo Record must be loadable");
    assert.equal(archive.manifest.mode, "base");
    assert.equal(archive.actionReceipts?.receipts.length, 3);
    assert.equal(archive.characterEffects?.effects.length, 1);
    assert.equal(archive.observations?.observations.length, sourceObservations.length);
    // 存档字节级 round-trip：parse(build(archive)) 与 reader 输出一致。
    const archiveBytes = buildRealmRuntimeSaveArchive(archive);
    const reparsed = parseRealmRuntimeSaveArchive(archiveBytes);
    assert.deepEqual(reparsed.actionReceipts, archive.actionReceipts);
    assert.deepEqual(reparsed.characterEffects, archive.characterEffects);
    assert.deepEqual(reparsed.observations, archive.observations);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtimePool);
    const restoreInput = {
      workspaceId: WORLD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      archive,
      targetWorldId: WORLD_SCOPE.worldId,
      idempotencyKey: "save-full-restore-1",
    };

    // ---- restore：全量物化到目标 Record --------------------------------
    const restored = await restorer.restore(restoreInput);
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedEventCount, sourceEventCount);
    assert.equal(restored.importedActionReceiptCount, 3);
    assert.equal(restored.importedCharacterEffectCount, 1);
    assert.equal(restored.importedObservationCount, sourceObservations.length);

    const targetReceipts = (await ownerPool.query<{
      id: string;
      transaction_id: string;
      actor_character_instance_id: string;
      source_event_id: string;
      receipt: Record<string, unknown>;
    }>(
      `SELECT id, transaction_id, actor_character_instance_id, source_event_id, receipt
       FROM action_receipts
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY world_tick ASC, world_ordinal ASC, id ASC`,
      [WORLD_SCOPE.workspaceId, restored.recordId],
    )).rows;
    assert.equal(targetReceipts.length, 3);
    const targetEventIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, restored.recordId],
    )).rows.map((row) => row.id));
    for (const [index, target] of targetReceipts.entries()) {
      const source = sourceReceipts[index]!;
      // 骰点/消耗/效果逐字节一致：restore 复制物化事实，绝不重掷。
      assert.deepEqual(target.receipt, source.receipt);
      assert.equal(target.transaction_id, source.transaction_id);
      // 引用全部重映射到目标 topology id，绝不回指 source id。
      assert.match(target.id, /^action_receipt_restore_/);
      assert.notEqual(target.actor_character_instance_id, source.actor_character_instance_id);
      assert.notEqual(target.source_event_id, source.source_event_id);
      assert.ok(targetEventIds.has(target.source_event_id));
    }
    // mechanic（d20 掷 14）在目标 Record 原样可读。
    const targetMechanic = targetReceipts[0]!.receipt.mechanic as { rolls: number[]; total: number };
    assert.deepEqual(targetMechanic.rolls, [14]);
    assert.equal(targetMechanic.total, 15);

    const targetEffects = (await ownerPool.query<{
      id: string;
      character_instance_id: string;
      effect_definition_id: string;
      source_action_receipt_id: string;
      status: string;
      applied_tick: string;
      applied_ordinal: string;
    }>(
      `SELECT id, character_instance_id, effect_definition_id,
              source_action_receipt_id, status, applied_tick, applied_ordinal
       FROM character_effects
       WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, restored.recordId],
    )).rows;
    assert.equal(targetEffects.length, 1);
    const targetEffect = targetEffects[0]!;
    assert.equal(targetEffect.status, "active");
    assert.match(targetEffect.id, /^character_effect_restore_/);
    // effect definition 按 effect_key 解析到目标 World 的既有定义行。
    const stanceDefinition = (await ownerPool.query<{ id: string }>(
      `SELECT id FROM effect_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND effect_key = 'watchful_guard'`,
      [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId],
    )).rows[0]!;
    assert.equal(targetEffect.effect_definition_id, stanceDefinition.id);
    assert.notEqual(targetEffect.character_instance_id, sourceEffects[0]!.character_instance_id);
    assert.equal(targetEffect.applied_tick, sourceEffects[0]!.applied_tick);
    assert.equal(targetEffect.applied_ordinal, sourceEffects[0]!.applied_ordinal);
    // 效果指向同一 restore 作用域内重映射后的 receipt。
    assert.ok(targetReceipts.some((receipt) => receipt.id === targetEffect.source_action_receipt_id));

    const targetObservations = (await ownerPool.query<{
      id: string;
      observer_character_instance_id: string;
      source_event_id: string | null;
      content: string;
      dedupe_key: string;
    }>(
      `SELECT id, observer_character_instance_id, source_event_id, content, dedupe_key
       FROM observations
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
      [WORLD_SCOPE.workspaceId, restored.recordId],
    )).rows;
    assert.equal(targetObservations.length, sourceObservations.length);
    const targetInstanceIds = new Set((await ownerPool.query<{ id: string }>(
      `SELECT id FROM character_instances WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, restored.recordId],
    )).rows.map((row) => row.id));
    assert.deepEqual(
      targetObservations.map((row) => row.content).sort(),
      sourceObservations.map((row) => row.content).sort(),
    );
    const sourceByDedupeKey = new Map(sourceObservations.map((row) => [row.dedupe_key, row]));
    for (const target of targetObservations) {
      const source = sourceByDedupeKey.get(target.dedupe_key)!;
      assert.ok(source, "target observation must pair with a source observation");
      assert.match(target.id, /^observation_restore_/);
      assert.ok(targetInstanceIds.has(target.observer_character_instance_id));
      assert.notEqual(target.observer_character_instance_id, source.observer_character_instance_id);
      if (target.source_event_id !== null) {
        assert.ok(targetEventIds.has(target.source_event_id));
        assert.notEqual(target.source_event_id, source.source_event_id);
      }
    }

    // 投影读回：恢复 Record 的骰点来自物化 receipt（读库不重掷）。
    const reloaded = await service.loadRecord(restored.recordId);
    const reloadedDice = reloaded.record.events.findLast((event) => event.dice)?.dice;
    assert.ok(reloadedDice, "restored Record projection must expose the materialized dice");
    assert.deepEqual(reloadedDice.rolls, [14]);
    assert.equal(reloadedDice.total, 15);

    // ---- 幂等 replay：同存档同键 → 不重复、不重掷 ----------------------
    const replay = await restorer.restore(restoreInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, restored.recordId);
    assert.equal(replay.importedActionReceiptCount, 3);
    const afterReplay = await ownerPool.query<{ receipts: number; effects: number; observations: number }>(
      `SELECT
         (SELECT count(*)::int FROM action_receipts WHERE record_id = $1) AS receipts,
         (SELECT count(*)::int FROM character_effects WHERE record_id = $1) AS effects,
         (SELECT count(*)::int FROM observations WHERE record_id = $1) AS observations`,
      [restored.recordId],
    );
    assert.deepEqual(afterReplay.rows[0], {
      receipts: 3,
      effects: 1,
      observations: sourceObservations.length,
    });
    const baseline = await restoreArtifactCounts(ownerPool);

    // ---- 失败场景（全部 fail-closed + 零残留） -------------------------
    const rebuildArchive = (overrides: {
      actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
      characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
      observations?: RealmRuntimeSaveObservationsV1;
    }): RealmRuntimeSaveArchive => {
      const actionReceipts = overrides.actionReceipts ?? archive.actionReceipts!;
      const characterEffects = overrides.characterEffects ?? archive.characterEffects!;
      const observations = overrides.observations ?? archive.observations!;
      const manifest = realmRuntimeSaveManifestFromData({
        engineApi: archive.manifest.engineApi,
        mode: archive.manifest.mode,
        world: archive.manifest.world,
        scope: archive.manifest.scope,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts,
        characterEffects,
        observations,
      });
      return {
        manifest,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts,
        characterEffects,
        observations,
      };
    };
    const expectRestoreFailure = async (
      badArchive: RealmRuntimeSaveArchive,
      idempotencyKey: string,
      code: RealmRuntimeSaveRepositoryError["code"],
    ) => {
      await assert.rejects(
        restorer.restore({ ...restoreInput, archive: badArchive, idempotencyKey }),
        (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
          && error.code === code,
      );
      assert.deepEqual(
        await restoreArtifactCounts(ownerPool),
        baseline,
        `${code} 失败路径不得留下任何 restore 残留`,
      );
    };

    // F1：receipt 指向存档 Record 之外的事件（跨 Record 引用）。
    await expectRestoreFailure(
      rebuildArchive({
        actionReceipts: {
          ...archive.actionReceipts!,
          receipts: archive.actionReceipts!.receipts.map((receipt, index) => index === 0
            ? { ...receipt, sourceEventId: "event_foreign_record" }
            : receipt),
        },
      }),
      "save-full-bad-receipt-event",
      "RUNTIME_SAVE_INVALID",
    );

    // F2：observation 指向未恢复事件。
    await expectRestoreFailure(
      rebuildArchive({
        observations: {
          ...archive.observations!,
          observations: archive.observations!.observations.map((observation, index) => index === 0
            ? { ...observation, sourceEventId: "event_never_restored" }
            : observation),
        },
      }),
      "save-full-bad-observation-event",
      "RUNTIME_SAVE_INVALID",
    );

    // F3：目标 World 缺少 effect definition（事务内 fail-closed 回滚）。
    await expectRestoreFailure(
      rebuildArchive({
        characterEffects: {
          ...archive.characterEffects!,
          effects: archive.characterEffects!.effects.map((effect) => ({
            ...effect,
            effectKey: "no_such_effect",
          })),
        },
      }),
      "save-full-missing-effect-definition",
      "RESTORE_INVALID_TARGET",
    );

    // F4：schema 损坏（缺必填键、hash 正确重算）→ parse 期 fail-closed。
    const corruptedObservations = Buffer.from(JSON.stringify({
      format: "realm-runtime-observations",
      schemaVersion: 1,
      observations: [{ sourceObservationId: "obs-broken" }],
    }));
    const recordEntry = Buffer.from(JSON.stringify(archive.record));
    const goalsEntry = Buffer.from(JSON.stringify(archive.goals));
    const corruptedManifest: RealmRuntimeSaveManifestV2 = {
      ...archive.manifest,
      snapshot: {
        ...archive.manifest.snapshot,
        runtimeHash: computeRealmRuntimeSaveContentHash(new Map([
          ["runtime/record.json", recordEntry],
          ["runtime/goals.json", goalsEntry],
          ["runtime/observations.json", corruptedObservations],
        ])),
      },
    };
    const corruptedBytes = zipSync({
      "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(corruptedManifest)),
      "runtime/record.json": recordEntry,
      "runtime/goals.json": goalsEntry,
      "runtime/observations.json": corruptedObservations,
    });
    assert.throws(
      () => parseRealmRuntimeSaveArchive(corruptedBytes),
      (error: unknown) => error instanceof RealmRuntimeSaveError
        && error.code === "INVALID_SAVE",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "schema 损坏的存档不得触及任何目标表",
    );

    // F5：RLS/workspace boundary——observer、无 membership principal、
    // 跨 workspace 一律 WORLD_NOT_FOUND 且零残留。
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_observer', 'observer')
       ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
      [WORLD_SCOPE.workspaceId, WORLD_SCOPE.worldId],
    );
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_save_full_other', '其它工作台')
       ON CONFLICT (id) DO NOTHING`,
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_observer", idempotencyKey: "save-full-observer" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, principalId: "principal_nobody", idempotencyKey: "save-full-nobody" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    await assert.rejects(
      restorer.restore({ ...restoreInput, workspaceId: "ws_save_full_other", idempotencyKey: "save-full-ws" }),
      (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
        && error.code === "WORLD_NOT_FOUND",
    );
    assert.deepEqual(
      await restoreArtifactCounts(ownerPool),
      baseline,
      "边界失败路径不得留下任何 restore 残留",
    );
  },
);
