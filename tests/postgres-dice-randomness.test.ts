/**
 * 批次 T5 骰子真随机与多骰系——PostgreSQL 集成测试
 * （public documentation §6）。
 *
 * 覆盖（临时库 + 全 19 迁移，不新增 mock）：
 * 1. 大样本真随机分布非恒定（伪随机查表特征消失；本项无需数据库）；
 * 2. 五骰系语义数据驱动——自定义定义落库后经 PG 规则包裁决，骰点随
 *    action_receipts 一次物化，重放（duplicate/重读投影）读同一物化结果；
 * 3. 抽牌不放回——逐张耗尽后 DECK_EXHAUSTED fail-closed，绝不静默重置。
 *
 * 语义断言用注入的确定性脚本随机源（randomInt 队列）；分布断言用生产
 * 缺省 CSPRNG。
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
import {
  createDeterministicActionResolver,
  type ActionTransaction,
} from "../modules/actions/public.ts";
import { resolveUncertainty } from "../modules/actions/engine.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { MechanicDetail } from "../modules/actions/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

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
const ACTOR = {
  characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
  participantId: POSTGRES_DEMO_IDS.playerParticipant,
  displayName: "玩家",
} as const;

/** 批次 T5 自定义骰系定义（skill_key → metadata.check）。 */
const DICE_SKILLS: Readonly<Record<string, Record<string, unknown>>> = {
  two_six: { system: "2d6", modifier: 1, target: 8 },
  percent_probe: { system: "percentile", modifier: 0, target: 40 },
  battle_pool: { system: "pool", modifier: 0, target: 2, dice: 3, sides: 6, successOn: 5 },
  fate_cards: {
    system: "draw",
    deck: ["铜币", "银币", "金币"],
    successCards: ["金币"],
  },
};

async function createTempDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_t5_test_${randomUUID().replaceAll("-", "")}`;
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

/** 装配基础定义 + 授权，并落自定义骰系定义与玩家授权。 */
async function assembleDiceSkills(pool: pg.Pool): Promise<void> {
  await withWorkspaceTransaction(
    pool,
    WORLD_SCOPE.workspaceId,
    async (client) => {
      const style = await readWorldStyle(client, WORLD_SCOPE);
      const base = await ensureWorldBaseRuleDefinitions(client, WORLD_SCOPE, style);
      await grantBaseSkillsToInstances(client, RECORD_SCOPE, base.skillDefinitionIds, [
        POSTGRES_DEMO_IDS.playerInstance,
      ]);
      await grantBaseAssetToInstance(
        client, RECORD_SCOPE, base.assetDefinitionId,
        POSTGRES_DEMO_IDS.playerInstance,
      );
      for (const [skillKey, check] of Object.entries(DICE_SKILLS)) {
        const definitionId = `t5_skill_${skillKey}`;
        await client.query(
          `INSERT INTO skill_definitions (
             workspace_id, world_id, id, skill_key, title, description,
             rule_pack_key, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (workspace_id, world_id, skill_key) DO NOTHING`,
          [
            WORLD_SCOPE.workspaceId,
            WORLD_SCOPE.worldId,
            definitionId,
            skillKey,
            `T5 ${skillKey}`,
            `批次 T5 骰系集成定义 ${skillKey}`,
            "realm.t5-dice.v1",
            JSON.stringify({ check }),
          ],
        );
        await client.query(
          `INSERT INTO character_skills (
             workspace_id, world_id, worldline_id, record_id,
             character_instance_id, skill_definition_id,
             acquired_tick, acquired_ordinal
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
           ON CONFLICT (
             workspace_id, record_id, character_instance_id, skill_definition_id
           ) DO NOTHING`,
          [
            WORLD_SCOPE.workspaceId,
            WORLD_SCOPE.worldId,
            RECORD_SCOPE.worldlineId,
            RECORD_SCOPE.recordId,
            POSTGRES_DEMO_IDS.playerInstance,
            definitionId,
          ],
        );
      }
    },
  );
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
    memorySync,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `pg-t5-token-${++sequence}`,
      clock: () => new Date("2026-08-20T03:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-20T03:00:00.000Z"),
    idFactory: () => `pg-t5-${++sequence}`,
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

function diceOf(envelope: { record: { events: readonly { dice?: MechanicDetail }[] } }) {
  // 信封事件跨回合累计——取最新一条带骰点的事件。
  const event = envelope.record.events.findLast((item) => item.dice);
  assert.ok(event?.dice, "committed turn should project a dice block");
  return event.dice;
}

test(
  "T5 five dice systems resolve data-driven semantics and replay reads the materialized roll",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);
    await assembleDiceSkills(ownerPool);

    // 脚本顺序：2d6 [3,5] → percentile [38] → pool [6,2,5] → draw index 2（金币）。
    const script = scriptedRandom([3, 5, 38, 6, 2, 5, 2]);
    const service = createService(runtimePool, script.randomInt);
    const initial = await service.loadRecord();

    async function submitSkill(
      skillId: string,
      idempotencyKey: string,
      writeToken: string,
    ) {
      return service.submitMessage({
        recordId: POSTGRES_DEMO_IDS.record,
        content: `使用 ${skillId}`,
        idempotencyKey,
        writeToken,
        actionSelection: { affordanceId: `skill.${skillId}` },
      });
    }

    // 2d6：3+5+1 = 9 ≥ 8 成功。
    const twoSix = await submitSkill("two_six", "t5-2d6-1", initial.writeToken);
    assert.equal(twoSix.disposition, "committed");
    const twoSixDice = diceOf(twoSix);
    assert.equal(twoSixDice.system, "2d6");
    assert.deepEqual(twoSixDice.rolls, [3, 5]);
    assert.equal(twoSixDice.total, 9);
    assert.equal(twoSixDice.success, true);

    // percentile：38 ≤ 40 成功。
    const percentile = await submitSkill(
      "percent_probe", "t5-percentile-1", twoSix.writeToken,
    );
    const percentileDice = diceOf(percentile);
    assert.equal(percentileDice.system, "percentile");
    assert.deepEqual(percentileDice.rolls, [38]);
    assert.equal(percentileDice.total, 38);
    assert.equal(percentileDice.success, true);

    // pool：3d6 [6,2,5] ≥5 计成功 → 2 成功 ≥ 2。
    const pool = await submitSkill("battle_pool", "t5-pool-1", percentile.writeToken);
    const poolDice = diceOf(pool);
    assert.equal(poolDice.system, "pool");
    assert.deepEqual(poolDice.rolls, [6, 2, 5]);
    assert.equal(poolDice.total, 2);
    assert.equal(poolDice.success, true);

    // draw：index 2 → 金币（successCards）成功，抽后剩余 2。
    const drawCommand = {
      recordId: POSTGRES_DEMO_IDS.record,
      content: "使用 fate_cards",
      idempotencyKey: "t5-draw-1",
      writeToken: pool.writeToken,
      actionSelection: { affordanceId: "skill.fate_cards" },
    };
    const draw = await service.submitMessage(drawCommand);
    const drawDice = diceOf(draw);
    assert.equal(drawDice.system, "draw");
    assert.equal(drawDice.drawnCard, "金币");
    assert.equal(drawDice.deckRemaining, 2);
    assert.equal(drawDice.skillKey, "fate_cards");
    assert.equal(drawDice.success, true);
    assert.ok(script.exhausted(), "scripted random source must be fully consumed");

    // 物化：action_receipts 恰 4 行，mechanic 与投影骰点逐一相等。
    const receipts = await ownerPool.query<{ mechanic: MechanicDetail }>(
      `SELECT receipt->'mechanic' AS mechanic
       FROM action_receipts
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY world_ordinal`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    );
    assert.equal(receipts.rowCount, 4);
    assert.deepEqual(receipts.rows.map((row) => row.mechanic), [
      twoSixDice, percentileDice, poolDice, drawDice,
    ]);

    // 重放幂等：同一命令原样重放 → duplicate，不重掷、不新增 receipt。
    const replay = await service.submitMessage(drawCommand);
    assert.equal(replay.disposition, "duplicate");
    const afterReplay = await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM action_receipts
       WHERE workspace_id = $1 AND record_id = $2`,
      [WORLD_SCOPE.workspaceId, RECORD_SCOPE.recordId],
    );
    assert.equal(afterReplay.rows[0]!.count, 4);
    // 重读投影（跨实例）→ 同一物化骰点（读库不重掷）。
    const reread = await service.loadRecord();
    assert.deepEqual(diceOf(reread), drawDice);
  },
);

test(
  "T5 card draw excludes materialized draws and fails closed on exhaustion",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createTempDatabase(t);
    await assembleDiceSkills(ownerPool);

    // 三次抽牌脚本：index 2（金币）→ 剩余牌堆 [铜币,银币] index 1（银币）
    // → 剩余 [铜币] index 0（铜币）。
    const script = scriptedRandom([2, 1, 0]);
    const service = createService(runtimePool, script.randomInt);
    const initial = await service.loadRecord();

    const drawn: string[] = [];
    let writeToken = initial.writeToken;
    for (const [index, expected] of ["金币", "银币", "铜币"].entries()) {
      const committed = await service.submitMessage({
        recordId: POSTGRES_DEMO_IDS.record,
        content: "抽一张命运牌",
        idempotencyKey: `t5-draw-seq-${index}`,
        writeToken,
        actionSelection: { affordanceId: "skill.fate_cards" },
      });
      assert.equal(committed.disposition, "committed");
      const dice = diceOf(committed);
      assert.equal(dice.drawnCard, expected);
      assert.equal(dice.deckRemaining, 2 - index);
      drawn.push(dice.drawnCard!);
      writeToken = committed.writeToken;
    }
    // 不放回：三次抽牌互不相同（牌堆逐张耗尽）。
    assert.equal(new Set(drawn).size, 3);

    // 抽空 → DECK_EXHAUSTED fail-closed（规则包层直查，绝不静默重置）。
    const rulePack = createPostgresRulePack(runtimePool, RECORD_SCOPE);
    await assert.rejects(
      rulePack.decide({
        actor: ACTOR,
        call: {
          callId: "t5-draw-exhausted",
          name: "use_skill",
          arguments: { skillId: "fate_cards", targetId: null, intent: "再抽" },
        },
      }),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "DECK_EXHAUSTED",
    );
  },
);

test("T5 large-sample rolls are non-constant (pseudo-random lookup is gone)", () => {
  // d20 大样本：600 次取值散布（查表伪随机对同一 seed 恒定——本断言必发散）。
  const d20Rolls = new Set<number>();
  for (let index = 0; index < 600; index += 1) {
    const { mechanic } = resolveUncertainty({
      check: { system: "d20", modifier: 0, target: 11 },
    });
    d20Rolls.add(mechanic.rolls[0]!);
  }
  assert.ok(d20Rolls.size >= 12, `d20 sample too narrow: ${d20Rolls.size}`);

  // 2d6 求和散布（2..12）。
  const sums = new Set<number>();
  for (let index = 0; index < 600; index += 1) {
    const { mechanic } = resolveUncertainty({
      check: { system: "2d6", modifier: 0, target: 7 },
    });
    sums.add(mechanic.rolls[0]! + mechanic.rolls[1]!);
  }
  assert.ok(sums.size >= 8, `2d6 sample too narrow: ${sums.size}`);

  // pool 成功数散布（3d6 successOn 5 → 0..3）。
  const successCounts = new Set<number>();
  for (let index = 0; index < 400; index += 1) {
    const { mechanic } = resolveUncertainty({
      check: { system: "pool", modifier: 0, target: 2, dice: 3, sides: 6, successOn: 5 },
    });
    successCounts.add(mechanic.total);
  }
  assert.ok(successCounts.size >= 2, "pool success counts must vary");

  // 同一 check 连续两次掷骰结果不绑定（查表特征：同 seed 必同结果）。
  const outcomes = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const { mechanic } = resolveUncertainty({
      check: { system: "d20", modifier: 2, target: 12 },
    });
    outcomes.add(`${mechanic.rolls[0]}:${mechanic.success}`);
  }
  assert.ok(outcomes.size > 1, "identical checks must not replay identical rolls");
});
