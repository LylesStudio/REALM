/**
 * 世界知识与人物设定自然生长——PostgreSQL 集成测试。
 *
 * 覆盖：公开回合的 growth 真实写回（world_claims 为 record 级
 * record_confirmed 且 source 可追踪；character_instances.state.profileNotes
 * 追加合并）；无场景 delta 时不产生空 correction；重新 resolve
 * RecordRuntimeScope 能读到新 profileSummary 与 recordKnowledge；
 * 重复调度幂等（ON CONFLICT DO NOTHING + note 去重）；restricted 回合
 * 不产生公共增长。写入路径全部走受限 realm_runtime 角色（含
 * gateWorldWrite），断言走 owner 连接。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresActionAffordanceCatalog,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  createPostgresSceneCrystallizationStore,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresCharacterGrowthStore } from "../database/postgres/character-growth-store.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import type { SceneCrystallizer } from "../modules/application/scene-crystallization.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

/** 固定 growth 提取结果（无场景 delta）：一次世界事实 + 一条人物 note。 */
const GROWTH_EXTRACTION = {
  delta: null,
  worldClaims: [{
    entity: "北岸灯塔",
    entityKind: "geography" as const,
    predicate: "异常",
    value: "无风夜自行点亮",
  }],
  characterNotes: [{
    characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
    note: "能辨认旧世界文字的刻痕",
  }],
};

const stubCrystallizer: SceneCrystallizer = {
  async extract() {
    return GROWTH_EXTRACTION;
  },
  async adjudicate() {
    return null;
  },
};

async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition was not met in time");
}

test(
  "public turns grow record-local world knowledge and profile notes; restricted turns never do",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_growth_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

    const runtimeUrl = new URL(runtimeConnectionString!);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });

    t.after(async () => {
      await ownerPool.end();
      await runtimePool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(
        await readFile(
          new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
          "utf8",
        ),
      );
    }
    await seedPostgresDemo(ownerPool);

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
        recipientId?: string | null;
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
          display: "测试时间",
        }));
      },
    });
    const scopeProvider = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      runtimeScopeProvider: scopeProvider,
      sceneCrystallizer: stubCrystallizer,
      sceneCrystallizationStore: createPostgresSceneCrystallizationStore(runtimePool),
      worldKnowledge: createWorldKnowledgeService(
        createPostgresWorldKnowledgeRepository(runtimePool),
      ),
      characterGrowth: createPostgresCharacterGrowthStore(runtimePool),
      // 仅「压低声音」判为密谈；其余 public。
      visibilityAssessor: {
        async assess({ playerText }) {
          if (playerText.includes("压低声音")) {
            return {
              visibility: {
                kind: "restricted" as const,
                domainId: "domain_secret",
                audienceCharacterInstanceIds: [POSTGRES_DEMO_IDS.scoutInstance],
              },
              reason: "密谈。",
            };
          }
          return { visibility: { kind: "public" as const }, reason: "公开。" };
        },
      },
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `growth-token-${++sequence}`,
        clock: () => new Date("2026-09-06T02:00:00.000Z"),
      }),
      clock: () => new Date("2026-09-06T02:00:00.000Z"),
      idFactory: () => `growth-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    const claimCount = async () => {
      const result = await ownerPool.query(
        `SELECT count(*)::int AS count
         FROM world_claims
         WHERE workspace_id = $1 AND source_record_id = $2`,
        [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
      );
      return result.rows[0].count as number;
    };
    const profileNotes = async () => {
      const result = await ownerPool.query(
        `SELECT state -> 'profileNotes' AS notes
         FROM character_instances
         WHERE workspace_id = $1 AND record_id = $2 AND id = $3`,
        [
          POSTGRES_DEMO_IDS.workspace,
          POSTGRES_DEMO_IDS.record,
          POSTGRES_DEMO_IDS.scoutInstance,
        ],
      );
      const notes = result.rows[0]?.notes;
      return Array.isArray(notes) ? notes as unknown[] : [];
    };
    const sceneCount = async () => {
      const result = await ownerPool.query(
        `SELECT count(*)::int AS count FROM scenes
         WHERE workspace_id = $1 AND record_id = $2`,
        [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
      );
      return result.rows[0].count as number;
    };
    const baselineScenes = await sceneCount();

    // ---- 回合 1（公开）：growth 写回 world_claims + profileNotes ----
    const first = await service.loadRecord();
    const turn1 = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "塞娜说她认得灯塔上的刻痕。",
      idempotencyKey: "pg-growth-1",
      writeToken: first.writeToken,
    });
    assert.equal(turn1.disposition, "committed");

    await eventually(async () => (await claimCount()) === 1);
    await eventually(async () => (await profileNotes()).length === 1);

    const claims = await ownerPool.query(
      `SELECT predicate, object_value, scope, truth_status,
              source_record_id, source_event_id, subject_entity_id,
              valid_from_tick, valid_to_tick
       FROM world_claims
       WHERE workspace_id = $1 AND source_record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );
    assert.equal(claims.rows.length, 1);
    const claim = claims.rows[0];
    assert.equal(claim.predicate, "异常");
    assert.equal(claim.object_value, "无风夜自行点亮");
    assert.equal(claim.scope, "record");
    assert.equal(claim.truth_status, "record_confirmed");
    assert.equal(claim.source_record_id, POSTGRES_DEMO_IDS.record);
    assert.ok(claim.source_event_id, "claim 携带 source_event_id");
    const sourceEvent = await ownerPool.query(
      `SELECT world_tick FROM events WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, claim.source_event_id],
    );
    assert.equal(sourceEvent.rows.length, 1, "source_event_id 指向真实已提交事件");
    // Batch 4A：entity/claim 绑定同一个真实来源 Event cursor（非 0、非回退）。
    const sourceTick = Number(sourceEvent.rows[0].world_tick);
    assert.ok(sourceTick > 0, "来源事件 cursor 必须为正");
    assert.equal(
      Number(claim.valid_from_tick),
      sourceTick,
      "claim valid_from_tick 必须等于来源 Event 的 world_tick",
    );
    assert.equal(claim.valid_to_tick, null);
    // 实体按名称确定性生成。
    const entity = await ownerPool.query(
      `SELECT entity_kind, name, valid_from_tick FROM world_entities
       WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, claim.subject_entity_id],
    );
    assert.equal(entity.rows[0]?.name, "北岸灯塔");
    assert.equal(entity.rows[0]?.entity_kind, "geography");
    assert.equal(
      Number(entity.rows[0]?.valid_from_tick),
      sourceTick,
      "entity 与 claim 使用同一来源 cursor",
    );
    // profile note 追加进 state.profileNotes，不动定义简介。
    // Batch 4B：新 note 以 object entry 落库，服务端 provenance/cursor 盖章。
    const storedNotes = await profileNotes() as unknown[];
    assert.equal(storedNotes.length, 1);
    const storedEntry = storedNotes[0] as Record<string, unknown>;
    assert.equal(storedEntry.note, "能辨认旧世界文字的刻痕");
    assert.equal(storedEntry.sourceRecordId, POSTGRES_DEMO_IDS.record);
    assert.equal(storedEntry.sourceEventId, claim.source_event_id);
    assert.equal(
      Number(storedEntry.validFromTick),
      sourceTick,
      "note validFromTick 必须等于来源 Event 的 world_tick",
    );
    assert.equal(storedEntry.validToTick, null);
    assert.equal(storedEntry.revokedAt, null);
    assert.ok(
      typeof storedEntry.createdAt === "string"
        && !Number.isNaN(Date.parse(storedEntry.createdAt)),
      "note createdAt 来自 DB 侧 recorded_at",
    );
    const definition = await ownerPool.query(
      `SELECT profile FROM character_definitions
       WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.scoutDefinition],
    );
    assert.ok(
      !JSON.stringify(definition.rows[0]?.profile).includes("旧世界文字的刻痕"),
      "growth 绝不覆盖 character_definitions.profile",
    );
    // 无场景 delta：不产生空 correction（场景行数不变）。
    assert.equal(await sceneCount(), baselineScenes);

    // ---- 重新 resolve scope：profileSummary 与 recordKnowledge 可读 ----
    const scope = await scopeProvider.resolve({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(scope);
    const scout = scope!.aiCharacters.find(
      (actor) => actor.characterInstanceId === POSTGRES_DEMO_IDS.scoutInstance,
    );
    assert.ok(
      scout!.profileSummary.includes("能辨认旧世界文字的刻痕"),
      "下一次 resolve scope 能读到合并后的 profileSummary",
    );
    assert.ok(
      scout!.profileSummary.includes("熟悉灰鲸港每一条暗巷"),
      "基底设定保持，不被覆盖",
    );
    assert.ok(
      scope!.recordKnowledge.some((line) =>
        line.includes("北岸灯塔") && line.includes("无风夜自行点亮")
      ),
      "recordKnowledge 读回 record_confirmed 知识",
    );
    assert.ok(
      scope!.recentPublicDialogue.every((line) => "speakerParticipantId" in line),
      "公开对话摘要携带主体 ID",
    );

    // ---- 回合 2（公开，同一提取结果）：重复调度幂等 ----
    const second = await service.loadRecord();
    const turn2 = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "塞娜又提起灯塔的刻痕。",
      idempotencyKey: "pg-growth-2",
      writeToken: second.writeToken,
    });
    assert.equal(turn2.disposition, "committed");
    await eventually(async () => {
      // 等待第二回合的 growth 管线至少跑完一次（profileNotes 仍是 1 条即
      // 去重生效；claim 仍 1 行即 ON CONFLICT 幂等）。
      return (await claimCount()) === 1 && (await profileNotes()).length === 1;
    });
    // 再等一拍确认没有第二份增长。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await claimCount(), 1, "重复调度不产生重复 claim");
    assert.equal((await profileNotes()).length, 1, "重复 note 精确去重");

    // ---- 回合 3（restricted）：不产生公共增长 ----
    const third = await service.loadRecord();
    let proposalId = "";
    await assert.rejects(
      service.submitMessage({
        recordId: LOCAL_RECORD_SCOPE.recordId,
        content: "我压低声音说出灯塔的秘密。",
        idempotencyKey: "pg-growth-3",
        writeToken: third.writeToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LocalRecordServiceError);
        assert.equal(error.code, "VISIBILITY_CONFIRMATION_REQUIRED");
        proposalId = error.visibilityProposal!.proposalId;
        return true;
      },
    );
    const restricted = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我压低声音说出灯塔的秘密。",
      idempotencyKey: "pg-growth-3",
      writeToken: third.writeToken,
      visibilityConfirmation: { proposalId, decision: "restricted" },
    });
    assert.equal(restricted.disposition, "committed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await claimCount(), 1, "restricted 回合不产生公共 claim");
    assert.equal(
      (await profileNotes()).length,
      1,
      "restricted 回合不产生 profile growth",
    );

    // ---- Batch 4A：cursor 边界与 fail-closed 矩阵 ----
    // cursor 前不可见：构造一条 future growth（valid_from 远超当前 head），
    // 读侧在本 Record 当前 cursor 下绝不可见。
    const head = await ownerPool.query(
      `SELECT last_world_tick FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );
    const headTick = Number(head.rows[0].last_world_tick);
    await ownerPool.query(
      `INSERT INTO world_claims (
         workspace_id, world_id, worldline_id, id, subject_entity_id,
         predicate, object_value, scope, truth_status, confidence,
         valid_from_tick, valid_to_tick,
         source_record_id, source_event_id, supersedes_claim_id
       ) VALUES ($1, $2, $3, 'claim_4a_future', $4, '状态', '未来才生效的事实',
                 'record', 'record_confirmed', 1, $5, NULL, $6, NULL, NULL)`,
      [
        POSTGRES_DEMO_IDS.workspace,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        claim.subject_entity_id,
        headTick + 1000,
        POSTGRES_DEMO_IDS.record,
      ],
    );
    const scopedAfterFuture = await scopeProvider.resolve({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    assert.ok(
      !scopedAfterFuture!.recordKnowledge.some((line) =>
        line.includes("未来才生效的事实")
      ),
      "cursor 前的读侧绝不可见未来 growth",
    );
    assert.ok(
      scopedAfterFuture!.recordKnowledge.some((line) =>
        line.includes("无风夜自行点亮")
      ),
      "已生效 growth 仍可见",
    );

    // repo 级 fail-closed：unknown / cross-record / cross-worldline /
    // cross-workspace 来源一律零写入（false 或 gate 拒绝），绝不写 tick=0。
    const repo = createPostgresWorldKnowledgeRepository(runtimePool);
    const growthScope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
    };
    const rejectInput = {
      entities: [{
        id: "entity_4a_reject",
        entityKind: "geography" as const,
        name: "拒绝实体",
        summary: "",
      }],
      claims: [{
        id: "claim_4a_reject",
        subjectEntityId: "entity_4a_reject",
        predicate: "状态",
        objectValue: "不应落库",
        scope: "record" as const,
        truthStatus: "record_confirmed" as const,
        confidence: 1,
        supersedesClaimId: null,
      }],
    };
    assert.equal(
      await repo.appendDialogueGrowth(growthScope, {
        ...rejectInput,
        recordId: POSTGRES_DEMO_IDS.record,
        sourceEventId: "turn_unknown:narration",
      }),
      false,
      "未知来源事件必须 fail-closed",
    );
    assert.equal(
      await repo.appendDialogueGrowth(growthScope, {
        ...rejectInput,
        recordId: "record_other",
        sourceEventId: claim.source_event_id,
      }),
      false,
      "cross-record 来源必须 fail-closed",
    );
    assert.equal(
      await repo.appendDialogueGrowth(
        { ...growthScope, worldlineId: "worldline_other" },
        {
          ...rejectInput,
          recordId: POSTGRES_DEMO_IDS.record,
          sourceEventId: claim.source_event_id,
        },
      ),
      false,
      "cross-worldline 来源必须 fail-closed",
    );
    let crossWorkspaceRejected = false;
    try {
      crossWorkspaceRejected = !await repo.appendDialogueGrowth(
        { ...growthScope, workspaceId: "workspace_stranger" },
        {
          ...rejectInput,
          recordId: POSTGRES_DEMO_IDS.record,
          sourceEventId: claim.source_event_id,
        },
      );
    } catch {
      crossWorkspaceRejected = true; // gate 拒绝同样是 fail-closed
    }
    assert.ok(crossWorkspaceRejected, "cross-workspace 来源必须 fail-closed");
    const rejectedRows = await ownerPool.query(
      `SELECT (SELECT count(*)::int FROM world_claims WHERE workspace_id = $1 AND id = 'claim_4a_reject') AS claims,
              (SELECT count(*)::int FROM world_entities WHERE workspace_id = $1 AND id = 'entity_4a_reject') AS entities`,
      [POSTGRES_DEMO_IDS.workspace],
    );
    assert.deepEqual(rejectedRows.rows[0], { claims: 0, entities: 0 },
      "fail-closed 路径零写入（无 entity/claim，更无 tick=0）");

    // repo 级幂等重放：同一来源同一确定性 ID 调两次，只落一行。
    const replayInput = {
      recordId: POSTGRES_DEMO_IDS.record,
      sourceEventId: claim.source_event_id as string,
      entities: [{
        id: "entity_4a_replay",
        entityKind: "geography" as const,
        name: "重放实体",
        summary: "",
      }],
      claims: [{
        id: "claim_4a_replay",
        subjectEntityId: "entity_4a_replay",
        predicate: "状态",
        objectValue: "重放不重复",
        scope: "record" as const,
        truthStatus: "record_confirmed" as const,
        confidence: 1,
        supersedesClaimId: null,
      }],
    };
    assert.equal(await repo.appendDialogueGrowth(growthScope, replayInput), true);
    assert.equal(await repo.appendDialogueGrowth(growthScope, replayInput), true);
    const replayRows = await ownerPool.query(
      `SELECT count(*)::int AS count, min(valid_from_tick) AS tick
       FROM world_claims
       WHERE workspace_id = $1 AND id = 'claim_4a_replay'`,
      [POSTGRES_DEMO_IDS.workspace],
    );
    assert.equal(replayRows.rows[0].count, 1, "幂等重放不产生重复 claim");
    assert.equal(
      Number(replayRows.rows[0].tick),
      sourceTick,
      "重放 claim 仍绑定同一来源 cursor",
    );

    // ---- Batch 4B：profileSummary 渲染边界（混合数组双读 + 生命周期） ----
    // 用 owner SQL 直接构造混合 profileNotes：legacy string、当前有效
    // entry、revoked、过期、未来、malformed——读侧只渲染前两者，metadata
    // 绝不进入 profileSummary（亦即不进入 character block/extraction
    // participants）。
    await ownerPool.query(
      `UPDATE character_instances
       SET state = state || $3::jsonb
       WHERE workspace_id = $1 AND record_id = $2 AND id = $4`,
      [
        POSTGRES_DEMO_IDS.workspace,
        POSTGRES_DEMO_IDS.record,
        JSON.stringify({
          profileNotes: [
            "旧字符串笔记仍然可读",
            {
              note: "当前有效的新笔记",
              sourceRecordId: POSTGRES_DEMO_IDS.record,
              sourceEventId: claim.source_event_id,
              validFromTick: headTick,
              validToTick: null,
              createdAt: "2026-09-06T02:00:00.000Z",
              revokedAt: null,
            },
            {
              note: "已撤销笔记不可读",
              sourceRecordId: POSTGRES_DEMO_IDS.record,
              sourceEventId: claim.source_event_id,
              validFromTick: headTick,
              validToTick: null,
              createdAt: "2026-09-06T02:00:00.000Z",
              revokedAt: "2026-09-06T03:00:00.000Z",
            },
            {
              note: "已过期笔记不可读",
              sourceRecordId: POSTGRES_DEMO_IDS.record,
              sourceEventId: claim.source_event_id,
              validFromTick: 0,
              validToTick: headTick,
              createdAt: "2026-09-06T02:00:00.000Z",
              revokedAt: null,
            },
            {
              note: "未来笔记不可读",
              sourceRecordId: POSTGRES_DEMO_IDS.record,
              sourceEventId: claim.source_event_id,
              validFromTick: headTick + 1000,
              validToTick: null,
              createdAt: "2026-09-06T02:00:00.000Z",
              revokedAt: null,
            },
            { note: 42 },
            { note: "缺来源的畸形笔记不可读" },
          ],
        }),
        POSTGRES_DEMO_IDS.scoutInstance,
      ],
    );
    const scopedAfterNotes = await scopeProvider.resolve({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: POSTGRES_DEMO_IDS.record,
    });
    const scoutAfterNotes = scopedAfterNotes!.aiCharacters.find(
      (actor) => actor.characterInstanceId === POSTGRES_DEMO_IDS.scoutInstance,
    )!;
    assert.ok(
      scoutAfterNotes.profileSummary.includes("旧字符串笔记仍然可读"),
      "旧字符串 entry 双读兼容",
    );
    assert.ok(
      scoutAfterNotes.profileSummary.includes("当前有效的新笔记"),
      "当前有效 entry 渲染 note 文本",
    );
    assert.ok(
      scoutAfterNotes.profileSummary.includes("熟悉灰鲸港每一条暗巷"),
      "基底设定保持，不被覆盖",
    );
    for (const hidden of [
      "已撤销笔记不可读",
      "已过期笔记不可读",
      "未来笔记不可读",
      "缺来源的畸形笔记不可读",
    ]) {
      assert.ok(
        !scoutAfterNotes.profileSummary.includes(hidden),
        `${hidden}——不得渲染`,
      );
    }
    // metadata（source IDs/cursor/timestamps/revocation）绝不进入 prompt 文本。
    for (const metadataLeak of [
      "sourceEventId",
      "sourceRecordId",
      "validFromTick",
      "revokedAt",
      ":narration",
      ":player",
    ]) {
      assert.ok(
        !scoutAfterNotes.profileSummary.includes(metadataLeak),
        `profileSummary 不得泄漏 ${metadataLeak}`,
      );
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
  if (!/^realm_growth_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
