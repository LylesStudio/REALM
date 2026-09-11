/**
 * v37 X1：archived 世界写入门禁矩阵（plan v37 §D.0 方法级清单）。
 * - 每个内容面（C）入口族在 archived 世界一律拒绝（WORLD_ARCHIVED /
 *   RECORD_ARCHIVED / TAVERN_IMPORT_WORLD_ARCHIVED）；
 * - 收尾面（K）允许：markTurnFailure / claimOutbox / settleOutbox /
 *   requestStop / world-archive / record-archive 幂等；
 * - admission 面（C）拒绝：acceptCommand / self-play start /
 *   first-night claimAttempt / qualify（另有专项套件）；
 * - gate 锁内重读：调用方事务外的旧 status 不影响判定（归档后写入仍拒）；
 * - commit × record-archive 双向 barrier（records FOR UPDATE 串行）。
 * 隔离库 finally DROP。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresCanonRepository,
  createPostgresCharacterMemoryRepository,
  createPostgresPropagationRepository,
  createPostgresRuntimeRepository,
  createPostgresSceneCrystallizationStore,
  createPostgresSemanticConflictEvidenceStore,
  createPostgresWorldKnowledgeRepository,
  createPostgresWorldlineMergeRepository,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import { createPostgresCanonPropagation } from "../database/postgres/canon-propagation.ts";
import {
  createPostgresFirstNightStore,
} from "../database/postgres/first-night-store.ts";
import {
  createPostgresSelfPlayStore,
} from "../database/postgres/self-play-store.ts";
import {
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  createCommandFingerprint,
  createReleaseFingerprint,
  executeTurn,
  type JsonValue,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import {
  LibraryServiceError,
} from "../modules/application/library-service.ts";
import {
  importTavernBundle,
} from "../modules/application/tavern-import-service.ts";
import {
  TavernImportError,
} from "../modules/import/tavern-parser.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
const RECORD = POSTGRES_DEMO_IDS.record;
const OWNER = POSTGRES_DEMO_IDS.principal;
const SCOPE = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

async function createTempDatabase(t: test.TestContext, label: string) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_gate_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 8 });
  ownerPool.on("error", () => undefined);
  t.after(async () => {
    await ownerPool.end().catch(() => undefined);
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  return { ownerPool };
}

async function setWorldStatus(pool: pg.Pool, status: "active" | "archived") {
  await pool.query(
    `UPDATE worlds SET status = $3 WHERE workspace_id = $1 AND id = $2`,
    [WS, WORLD, status],
  );
}

async function expectArchived(
  label: string,
  action: () => Promise<unknown>,
  codes: readonly string[] = ["WORLD_ARCHIVED"],
) {
  await assert.rejects(action, (error: unknown) => {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: string }).code
      : undefined;
    assert.ok(
      code !== undefined && codes.includes(code),
      `${label}: expected ${codes.join("|")}, got ${String(code)} (${String(error)})`,
    );
    return true;
  });
}

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

test(
  "archived world: every content-plane entry family rejects (D.0 matrix)",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "cmatrix");

    const runtime = createPostgresRuntimeRepository({
      pool: ownerPool,
      workspaceId: WS,
      mapFormalEvent() {
        throw new Error("not reached");
      },
    });
    const firstNight = createPostgresFirstNightStore(ownerPool, WS);
    const crystallization = createPostgresSceneCrystallizationStore(ownerPool);
    const memory = createPostgresCharacterMemoryRepository(ownerPool);
    const propagation = createPostgresPropagationRepository(ownerPool);
    const merges = createPostgresWorldlineMergeRepository(ownerPool);
    const knowledge = createPostgresWorldKnowledgeRepository(ownerPool);
    const canon = createPostgresCanonRepository(ownerPool);
    const canonPropagation = createPostgresCanonPropagation();
    const evidence = createPostgresSemanticConflictEvidenceStore(ownerPool, WS);
    const selfPlay = createPostgresSelfPlayStore(ownerPool, WS);
    const library = createPostgresLibraryService(ownerPool);

    // canon mergeProposal 需要 pending proposal（active 时建）。
    await canon.createProposal(SCOPE, {
      id: "canon_gate_probe",
      targetLevel: "worldline",
      articleId: null,
      claimIds: [],
      rationale: "probe",
      status: "pending",
      proposedBy: "dm",
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    });
    // first-night pending marker（active 时建）。
    await ownerPool.query(
      `INSERT INTO record_first_nights (workspace_id, record_id, world_id, state, context)
       VALUES ($1, $2, $3, 'pending', '{}'::jsonb)`,
      [WS, RECORD, WORLD],
    );

    // —— 归档（K 面状态转换自身允许）。gate 锁内重读：此后一切 C 面拒绝。——
    await setWorldStatus(ownerPool, "archived");

    // runtime-repository C 面：acceptCommand（admission）。
    const command: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: RECORD,
      expectedRecordVersion: 0,
      idempotencyKey: `gate-${randomUUID()}`,
      actorId: null,
      payload: ["探测"],
    };
    await expectArchived("acceptCommand", () =>
      runtime.acceptCommand({
        turnId: `turn_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        command,
        commandFingerprint: createCommandFingerprint(command),
        now: new Date().toISOString(),
      }));

    // first-night C 面：claimAttempt / commitPack。
    await expectArchived("first-night claimAttempt", () => firstNight.claimAttempt(RECORD));
    await expectArchived("first-night commitPack", () =>
      firstNight.commitPack(RECORD, {
        scene: { title: "t", location: "l", objective: "o" },
        characters: [],
        hook: { content: "h", suggestions: ["a", "b"] },
      } as never, "ready"));

    // scene-crystallization C 面：applyDelta。
    await expectArchived("crystallization applyDelta", () =>
      crystallization.applyDelta(
        {
          workspaceId: WS,
          worldId: WORLD,
          worldlineId: WORLDLINE,
          recordId: RECORD,
          calendarId: "native_calendar",
          publicPolicyId: POSTGRES_DEMO_IDS.publicPolicy,
        },
        {},
      ));

    // memory C 面 ×3。
    const memoryBase = {
      workspaceId: WS,
      worldId: WORLD,
      worldlineId: WORLDLINE,
      recordId: RECORD,
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
    };
    await expectArchived("memory appendAuthorized", () =>
      memory.appendAuthorized({
        ...memoryBase,
        observedEntityKey: "entity_probe",
        content: "probe",
        memoryKind: "explicit",
        fidelity: 1,
        keywords: [],
        embedding: [],
        embeddingModel: "none",
      }));
    await expectArchived("memory upsertRelationshipAuthorized", () =>
      memory.upsertRelationshipAuthorized({
        ...memoryBase,
        targetEntityKey: "entity_probe",
        relationKind: "trust",
        content: "probe",
        fidelity: 1,
      }));
    await expectArchived("memory createSnapshotAuthorized", () =>
      memory.createSnapshotAuthorized({
        ...memoryBase,
        snapshotId: `snap_${randomUUID().slice(0, 8)}`,
        snapshotKind: "recall",
        content: "probe",
        itemIds: [],
        tokenCount: 0,
      }));

    // propagation-repository C 面：saveRun。
    await expectArchived("propagation saveRun", () =>
      propagation.saveRun(SCOPE, {
        campaign: {
          id: `camp_${randomUUID().slice(0, 8)}`,
          securityClass: "public",
          effectiveTick: 1,
          salience: 0.5,
          complexity: 0.5,
        },
        packets: [],
        exposures: [],
        algorithmVersion: "realm-propagate-v1",
      }));

    // worldline-merge C 面 ×3。
    const mergeRow = {
      id: `merge_${randomUUID().slice(0, 8)}`,
      idempotencyKey: `ik_${randomUUID().slice(0, 8)}`,
      sourceWorldlineA: WORLDLINE,
      sourceWorldlineB: WORLDLINE,
      mergedWorldlineId: null,
      operator: "dm",
      status: "rejected" as const,
      conflictReport: {},
      manifest: [],
      createdAt: new Date().toISOString(),
    };
    await expectArchived("merge insertMerge", () => merges.insertMerge(SCOPE, mergeRow));
    await expectArchived("merge createMergedTopology", () =>
      merges.createMergedTopology(SCOPE, {
        worldlineId: `worldline_${randomUUID().slice(0, 8)}`,
        label: "merged",
        storyId: `story_${randomUUID().slice(0, 8)}`,
        storyTitle: "merged",
        records: [],
        headTick: 0,
        headOrdinal: 0,
      }));
    await expectArchived("merge createMergedTopologyAndAudit", () =>
      merges.createMergedTopologyAndAudit!(
        SCOPE,
        {
          worldlineId: `worldline_${randomUUID().slice(0, 8)}`,
          label: "merged",
          storyId: `story_${randomUUID().slice(0, 8)}`,
          storyTitle: "merged",
          records: [],
          headTick: 0,
          headOrdinal: 0,
        },
        { ...mergeRow, id: `merge_${randomUUID().slice(0, 8)}`, idempotencyKey: `ik_${randomUUID().slice(0, 8)}` },
      ));

    // world-knowledge C 面 ×6。
    await expectArchived("knowledge upsertEntity", () =>
      knowledge.upsertEntity(SCOPE, {
        id: `entity_${randomUUID().slice(0, 8)}`,
        entityKind: "setting",
        name: "probe",
        summary: "",
        validFromTick: 0,
        validToTick: null,
      }));
    await expectArchived("knowledge appendClaim", () =>
      knowledge.appendClaim(SCOPE, {
        id: `claim_${randomUUID().slice(0, 8)}`,
        subjectEntityId: "entity_missing",
        predicate: "probe",
        objectValue: "v",
        scope: "story",
        truthStatus: "mentioned",
        confidence: 1,
        validFromTick: 0,
        validToTick: null,
        sourceRecordId: null,
        sourceEventId: null,
        supersedesClaimId: null,
      }));
    await expectArchived("knowledge appendClaims", () =>
      knowledge.appendClaims(SCOPE, [{
        id: `claim_${randomUUID().slice(0, 8)}`,
        subjectEntityId: "entity_missing",
        predicate: "probe",
        objectValue: "v",
        scope: "story",
        truthStatus: "mentioned",
        confidence: 1,
        validFromTick: 0,
        validToTick: null,
        sourceRecordId: null,
        sourceEventId: null,
        supersedesClaimId: null,
      }]));
    await expectArchived("knowledge appendRelation", () =>
      knowledge.appendRelation(SCOPE, {
        id: `rel_${randomUUID().slice(0, 8)}`,
        subjectEntityId: "a",
        predicate: "p",
        objectEntityId: "b",
        sourceClaimId: "c",
      }));
    await expectArchived("knowledge createArticle", () =>
      knowledge.createArticle(SCOPE, {
        id: `article_${randomUUID().slice(0, 8)}`,
        title: "probe",
        body: "probe",
        claimIds: [],
        sourceEventIds: [],
      }));
    await expectArchived("knowledge appendCausalEdge", () =>
      knowledge.appendCausalEdge(SCOPE, {
        id: `edge_${randomUUID().slice(0, 8)}`,
        fromClaimId: "a",
        toClaimId: "b",
        edgeKind: "enables",
      }));

    // canon-repository C 面 ×2（propose 空 claimIds 走服务层短路，
    // 这里直驱 repository 验证 gate）。
    await expectArchived("canon createProposal", () =>
      canon.createProposal(SCOPE, {
        id: `canon_${randomUUID().slice(0, 8)}`,
        targetLevel: "worldline",
        articleId: null,
        claimIds: [],
        rationale: "probe",
        status: "pending",
        proposedBy: "dm",
        decidedBy: null,
        decidedAt: null,
        createdAt: new Date().toISOString(),
      }));
    await expectArchived("canon mergeProposal", () =>
      canon.mergeProposal(SCOPE, {
        proposalId: "canon_gate_probe",
        decidedBy: "dm",
        promotedClaims: [],
        article: null,
        revision: {
          id: `rev_${randomUUID().slice(0, 8)}`,
          articleId: "article_probe",
          parentRevisionId: null,
          acceptedProposalId: "canon_gate_probe",
          body: "probe",
          createdAt: new Date().toISOString(),
        } as never,
      }));

    // canon-propagation C 面：planAndEnqueue（宿主事务 client 直驱）。
    await withWorkspaceTransaction(ownerPool, WS, async (client) => {
      await expectArchived("canon-propagation planAndEnqueue", () =>
        canonPropagation.planAndEnqueue(client, SCOPE, {
          revision: {
            id: `rev_${randomUUID().slice(0, 8)}`,
            articleId: "article_probe",
            parentRevisionId: null,
            acceptedProposalId: "canon_gate_probe",
            body: "probe",
            createdAt: new Date().toISOString(),
          } as never,
          promotedClaims: [],
          securityClass: "public",
          audienceContinuityIds: [],
        }));
    });

    // semantic-conflict C 面：append（带 scope）。
    await expectArchived("semantic-conflict append", () =>
      evidence.append({
        source: "probe",
        model: "none",
        promptVersion: "v0",
        inputDigest: "0".repeat(24),
        result: { verdict: "none" },
        scope: SCOPE,
        requestId: null,
      } as never));

    // self-play C 面：start（新会话 admission）。
    await expectArchived("self-play start", () =>
      selfPlay.start({
        sessionId: `selfplay_${randomUUID().slice(0, 8)}`,
        recordId: RECORD,
        worldId: WORLD,
        beatBudget: 2,
        requestedBy: OWNER,
      }));

    // library-service C 面分支。
    const libraryScope = { workspaceId: WS, principalId: OWNER };
    const libraryCommands = [
      { kind: "story", worldId: WORLD, title: "t", premise: "p" },
      { kind: "branch", worldId: WORLD, label: "l" },
      { kind: "world-style", worldId: WORLD, style: "modern" },
      { kind: "character", worldId: WORLD, name: "n", role: "r", summary: "s" },
      { kind: "player-stance", worldId: WORLD, stance: "observer" },
      {
        kind: "attach-character",
        worldId: WORLD,
        recordId: RECORD,
        definitionId: POSTGRES_DEMO_IDS.scoutDefinition,
      },
      {
        kind: "character-activity",
        worldId: WORLD,
        recordId: RECORD,
        definitionId: POSTGRES_DEMO_IDS.scoutDefinition,
        active: true,
      },
    ] as const;
    for (const command of libraryCommands) {
      await assert.rejects(
        library.create(libraryScope, command as never),
        (error: unknown) => {
          assert.ok(
            error instanceof LibraryServiceError && error.code === "WORLD_ARCHIVED",
            `library ${command.kind}: expected WORLD_ARCHIVED, got ${String(error)}`,
          );
          return true;
        },
      );
    }

    // tavern-import C 面：持锁形态 archived 拒绝。
    await assert.rejects(
      importTavernBundle(
        ownerPool,
        { workspaceId: WS, worldId: WORLD },
        buildPngWithCard({
          name: "探测员",
          description: "probe",
          personality: "",
          first_mes: "你好。",
          scenario: "",
        }),
        "probe.png",
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof TavernImportError
            && error.code === "TAVERN_IMPORT_WORLD_ARCHIVED",
          `tavern import: expected TAVERN_IMPORT_WORLD_ARCHIVED, got ${String(error)}`,
        );
        return true;
      },
    );

    // 恢复 active 后写路径恢复（gate 每事务锁内重读，不缓存旧 status）。
    await setWorldStatus(ownerPool, "active");
    await knowledge.upsertEntity(SCOPE, {
      id: `entity_${randomUUID().slice(0, 8)}`,
      entityKind: "setting",
      name: "probe",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
  },
);

test(
  "archived world: C-plane turn lifecycle rejected mid-flight; K-plane bookkeeping allowed",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "turns");
    let sequence = 0;
    const runtime = createPostgresRuntimeRepository<
      readonly JsonValue[],
      { objective: string },
      { text: string },
      { accepted: boolean },
      { content: string },
      { eventId: string }
    >({
      pool: ownerPool,
      workspaceId: WS,
      mapFormalEvent({ draft, worldCursor }) {
        return {
          sceneId: POSTGRES_DEMO_IDS.scene,
          visibilityPolicyId: POSTGRES_DEMO_IDS.publicPolicy,
          eventKind: "utterance.committed",
          speakerName: "塞娜",
          content: draft.payload.content,
          observations: [
            {
              observationId: `${draft.eventId}-observation`,
              observerCharacterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
              dedupeKey: `${draft.eventId}:direct`,
              kind: "direct",
              content: draft.payload.content,
              availableFrom: worldCursor,
            },
          ],
        };
      },
    });
    const dependencies: TurnRuntimeDependencies<
      readonly JsonValue[],
      { objective: string },
      { text: string },
      { accepted: boolean },
      { content: string },
      { eventId: string }
    > = {
      repository: runtime,
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft() { return { text: "探测。" }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context: { turnId: string }) {
          const eventId = `${context.turnId}-event`;
          return {
            formalEvents: [
              { eventId, kind: "utterance.committed", payload: { content: "探测。" } },
            ],
            outbox: [
              {
                messageId: `${context.turnId}-outbox`,
                dedupeKey: `${context.turnId}:projection`,
                topic: "record.event.committed",
                payload: { eventId },
              },
            ],
          };
        },
      },
      idFactory: () => `gate-runtime-${++sequence}`,
      clock: () => new Date().toISOString(),
    };

    // active：一个完整回合（产生 outbox 消息）。
    const doneCommand: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: RECORD,
      expectedRecordVersion: 1,
      idempotencyKey: `gate-done-${randomUUID()}`,
      actorId: null,
      payload: ["完成"],
    };
    const completed = await executeTurn(doneCommand, dependencies);
    assert.equal(completed.state, "completed");

    // active：第二个回合推进到 accepted。
    const midCommand: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: RECORD,
      expectedRecordVersion: 2,
      idempotencyKey: `gate-mid-${randomUUID()}`,
      actorId: null,
      payload: ["中途"],
    };
    const accepted = await runtime.acceptCommand({
      turnId: `turn_mid_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      command: midCommand,
      commandFingerprint: createCommandFingerprint(midCommand),
      now: new Date().toISOString(),
    });
    const advanced = await runtime.advanceTurn({
      turnId: accepted.run.turnId,
      expectedRevision: accepted.run.revision,
      expectedState: "accepted",
      nextState: "planning",
      now: new Date().toISOString(),
    });

    // —— 归档。——
    await setWorldStatus(ownerPool, "archived");

    // C 面：advanceTurn / beginStageAttempt / restartTurn / commitRelease 拒绝。
    await expectArchived("advanceTurn", () =>
      runtime.advanceTurn({
        turnId: accepted.run.turnId,
        expectedRevision: advanced.revision,
        expectedState: "planning",
        nextState: "drafting",
        plan: {
          planId: "plan_probe",
          body: { objective: "respond" },
          createdAt: new Date().toISOString(),
        },
        now: new Date().toISOString(),
      }));
    await expectArchived("beginStageAttempt", () =>
      runtime.beginStageAttempt({
        turnId: accepted.run.turnId,
        expectedRevision: advanced.revision,
        stage: "planning",
        now: new Date().toISOString(),
      }));

    // K 面：markTurnFailure 允许收尾（archived 不阻断失败簿记）。
    const failed = await runtime.markTurnFailure({
      turnId: accepted.run.turnId,
      expectedRevision: advanced.revision,
      expectedState: "planning",
      failure: {
        disposition: "retryable",
        stage: "planning",
        resumeFrom: "planning",
        code: "PROBE",
        message: "probe failure",
        attempt: 1,
        occurredAt: new Date().toISOString(),
      },
      now: new Date().toISOString(),
    });
    assert.equal(failed.state, "retryable");

    // C 面：restartTurn（恢复推进）在 archived 下拒绝。
    await expectArchived("restartTurn", () =>
      runtime.restartTurn({
        turnId: accepted.run.turnId,
        expectedRevision: failed.revision,
        now: new Date().toISOString(),
      }));

    // K 面：outbox 认领/ack 簿记在 archived 下允许。
    const outboxMessages = await runtime.listOutboxMessages();
    assert.equal(outboxMessages.length, 1);
    const message = outboxMessages[0]!;
    const claimed = await runtime.claimOutbox({
      messageId: message.messageId,
      expectedRevision: message.revision,
      leaseOwner: "gate-probe",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      now: new Date().toISOString(),
    });
    assert.equal(claimed.state, "delivering");
    const settled = await runtime.settleOutbox({
      messageId: message.messageId,
      expectedRevision: claimed.revision,
      outcome: "delivered",
      leaseOwner: "gate-probe",
      now: new Date().toISOString(),
    });
    assert.equal(settled.state, "delivered");

    // commitRelease archived 拒绝：构造 releasing 态 turn（active 时推进），
    // 归档后 commitRelease → WORLD_ARCHIVED。
    await setWorldStatus(ownerPool, "active");
    const releaseCommand: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: RECORD,
      expectedRecordVersion: 2,
      idempotencyKey: `gate-release-${randomUUID()}`,
      actorId: null,
      payload: ["提交"],
    };
    const releasedTurn = await runtime.acceptCommand({
      turnId: `turn_rel_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      command: releaseCommand,
      commandFingerprint: createCommandFingerprint(releaseCommand),
      now: new Date().toISOString(),
    });
    let run = releasedTurn.run;
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "accepted",
      nextState: "planning",
      now: new Date().toISOString(),
    });
    run = await runtime.beginStageAttempt({
      turnId: run.turnId,
      expectedRevision: run.revision,
      stage: "planning",
      now: new Date().toISOString(),
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "planning",
      nextState: "drafting",
      plan: {
        planId: "plan_rel",
        body: { objective: "respond" },
        createdAt: new Date().toISOString(),
      },
      now: new Date().toISOString(),
    });
    run = await runtime.beginStageAttempt({
      turnId: run.turnId,
      expectedRevision: run.revision,
      stage: "drafting",
      now: new Date().toISOString(),
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "drafting",
      nextState: "validating",
      candidate: {
        candidateId: "cand_rel",
        body: { text: "提交。" },
        createdAt: new Date().toISOString(),
        draftingAttempt: 1,
      },
      now: new Date().toISOString(),
    });
    run = await runtime.beginStageAttempt({
      turnId: run.turnId,
      expectedRevision: run.revision,
      stage: "validating",
      now: new Date().toISOString(),
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "validating",
      nextState: "releasing",
      validation: {
        validationId: "val_rel",
        body: { accepted: true },
        createdAt: new Date().toISOString(),
      },
      now: new Date().toISOString(),
    });
    run = await runtime.beginStageAttempt({
      turnId: run.turnId,
      expectedRevision: run.revision,
      stage: "releasing",
      now: new Date().toISOString(),
    });
    const bundle = {
      formalEvents: [
        {
          eventId: `${run.turnId}-event`,
          kind: "utterance.committed",
          payload: { content: "提交。" },
        },
      ],
      outbox: [
        {
          messageId: `${run.turnId}-outbox`,
          dedupeKey: `${run.turnId}:projection`,
          topic: "record.event.committed",
          payload: { eventId: `${run.turnId}-event` },
        },
      ],
    };
    await setWorldStatus(ownerPool, "archived");
    await expectArchived("commitRelease", () =>
      runtime.commitRelease({
        turnId: run.turnId,
        expectedRevision: run.revision,
        bundle,
        releaseFingerprint: createReleaseFingerprint(bundle),
        now: new Date().toISOString(),
      }));
    const unchanged = await runtime.loadTurn(run.turnId);
    assert.equal(unchanged?.state, "releasing", "被拒的 commitRelease 不得落库");
  },
);

test(
  "record-archive two-way barrier: writer record lock serializes with archive; archived record rejects",
  { skip: !adminConnectionString, timeout: 180_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "recarchive");
    const library = createPostgresLibraryService(ownerPool);
    const runtime = createPostgresRuntimeRepository({
      pool: ownerPool,
      workspaceId: WS,
      mapFormalEvent() {
        throw new Error("not reached");
      },
    });

    // 写者持 records FOR UPDATE（gateRecordActive 同形）→ 归档（records
    // FOR UPDATE）必须等待（lock_timeout 55P03）。
    const writer = await ownerPool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
      await writer.query(
        "SELECT status FROM records WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [WS, RECORD],
      );
      const archiver = await ownerPool.connect();
      try {
        await archiver.query("BEGIN");
        await archiver.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
        await archiver.query("SET LOCAL lock_timeout = '1s'");
        await assert.rejects(
          archiver.query(
            "SELECT status FROM records WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
            [WS, RECORD],
          ),
          (error: unknown) => (error as { code?: string }).code === "55P03",
        );
      } finally {
        await archiver.query("ROLLBACK").catch(() => undefined);
        archiver.release();
      }
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }

    // record-archive（K 面）正常执行。
    await library.create(
      { workspaceId: WS, principalId: OWNER },
      { kind: "delete-record", worldId: WORLD, recordId: RECORD },
    );

    // archived record：acceptCommand → RECORD_ARCHIVED（gate 锁内重读）。
    const command: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: RECORD,
      expectedRecordVersion: 1,
      idempotencyKey: `gate-rec-${randomUUID()}`,
      actorId: null,
      payload: ["归档后"],
    };
    await assert.rejects(
      runtime.acceptCommand({
        turnId: `turn_rec_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        command,
        commandFingerprint: createCommandFingerprint(command),
        now: new Date().toISOString(),
      }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        assert.ok(
          code === "RECORD_ARCHIVED" || code === "RECORD_NOT_FOUND",
          `expected RECORD_ARCHIVED/RECORD_NOT_FOUND, got ${String(code)}`,
        );
        return true;
      },
    );
  },
);
