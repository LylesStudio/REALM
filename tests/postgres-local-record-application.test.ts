import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { normalizeRecordEnvelope } from "../app/components/record-types.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresDeliveryProjectionRepository,
  createPostgresCharacterMemoryRepository,
  createPostgresActionAffordanceCatalog,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import {
  createLocalM2TurnOrchestrator,
  createModelPoweredM2TurnOrchestrator,
} from "../modules/orchestration/public.ts";
import { createMemoryPrefetchHub } from "../modules/memory/pipeline.ts";
import type {
  ModelChatRequest,
  ModelGateway,
} from "../modules/inference/public.ts";
import {
  createDeterministicActionResolver,
  type ActionTransaction,
} from "../modules/actions/public.ts";
import { createCharacterMemoryService } from "../modules/memory/public.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";

const adminConnectionString = process.env.DATABASE_URL;

test(
  "restricted PostgreSQL role completes the Application GET-token-POST-replay/conflict closure",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_application_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const owner = new pg.Client({ connectionString: ownerUrl.href });
    await owner.connect();
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 1 });

    t.after(async () => {
      await runtimePool.end();
      await ownerPool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
    }
    await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });

    const identity = await runtimePool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT current_user, role.rolsuper, role.rolbypassrls
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    assert.deepEqual(identity.rows[0], {
      current_user: "realm_runtime",
      rolsuper: false,
      rolbypassrls: false,
    });

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
    let sequence = 0;
    // 批次 T2：萃取已拆出召回事务，回合提交后由 memorySync 异步物化；
    // 测试在记忆断言前 await idle() 等待后台萃取完成。
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
        randomToken: () => `pg-token-${++sequence}`,
        clock: () => new Date("2026-08-13T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-13T03:00:00.000Z"),
      idFactory: () => `pg-application-${++sequence}`,
      orchestrator: createLocalM2TurnOrchestrator({
        characters: [{
          characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
          participantId: POSTGRES_DEMO_IDS.scoutParticipant,
          displayName: "塞娜",
        }],
        actionResolver: createDeterministicActionResolver({
          allowStatefulReceipts: true,
        }),
      }),
    });

    const initial = await service.loadRecord();
    const stale = await service.loadRecord();
    assert.equal(initial.record.events.length, 1);
    assert.deepEqual(
      initial.affordances.map((item) => item.kind),
      ["skill", "asset", "stance", "scene"],
    );
    assert.deepEqual(initial.viewer, {
      cursor: "viewer-local",
      perspective: "character",
      dynamicKnowledgeVisible: true,
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
      membershipRole: "owner",
    });
    assert.equal(initial.viewer.dynamicKnowledgeVisible, true);
    assert.equal(JSON.stringify(initial).includes("canonicalVersion"), false);
    const browserInitial = normalizeRecordEnvelope({ ok: true, ...initial });

    const originalLocation = initial.record.scene.location;
    const originalEra = initial.record.world.era;
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('realm.workspace_id', $1, true)", [
        LOCAL_RECORD_SCOPE.workspaceId,
      ]);
      await owner.query(
        `UPDATE player_world_memberships
         SET can_view_dynamic_knowledge = false
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [
          LOCAL_RECORD_SCOPE.workspaceId,
          POSTGRES_DEMO_IDS.world,
          LOCAL_RECORD_SCOPE.principalId,
        ],
      );
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }

    const hidden = await service.loadRecord();
    assert.equal(hidden.viewer.dynamicKnowledgeVisible, false);
    assert.equal(hidden.record.scene.location, "");
    assert.equal(hidden.record.world.era, "");
    assert.equal(hidden.record.story.status, "");
    assert.deepEqual(hidden.record.cast, []);
    assert.notEqual(originalLocation, hidden.record.scene.location);
    assert.notEqual(originalEra, hidden.record.world.era);
    const browserHidden = normalizeRecordEnvelope(
      { ok: true, ...hidden },
      browserInitial.record,
    );
    assert.equal(browserHidden.viewer.dynamicKnowledgeVisible, false);
    assert.equal(browserHidden.record.scene.location, "");
    assert.equal(browserHidden.record.world.era, "");
    assert.equal(browserHidden.record.story.status, "");
    assert.deepEqual(browserHidden.record.cast, []);

    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('realm.workspace_id', $1, true)", [
        LOCAL_RECORD_SCOPE.workspaceId,
      ]);
      await owner.query(
        `UPDATE player_world_memberships
         SET can_view_dynamic_knowledge = true
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [
          LOCAL_RECORD_SCOPE.workspaceId,
          POSTGRES_DEMO_IDS.world,
          LOCAL_RECORD_SCOPE.principalId,
        ],
      );
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }

    const command = {
      recordId: POSTGRES_DEMO_IDS.record,
      content: "先不要拆信，检查信使离开的方向。",
      idempotencyKey: "postgres-application-message",
      writeToken: initial.writeToken,
    };
    const committed = await service.submitMessage(command);
    assert.equal(committed.disposition, "committed");
    assert.equal(committed.record.events.length, 4);
    assert.deepEqual(
      committed.record.events.slice(-3).map((event) => event.role),
      ["player", "narrator", "character"],
    );
    assert.equal(
      committed.record.events.at(-2)?.segments.some((segment) => segment.kind === "fact"),
      true,
    );
    assert.deepEqual(
      committed.record.events.at(-1)?.segments.map((segment) => segment.kind),
      ["action"],
    );
    assert.equal(JSON.stringify(committed).includes("candidate"), false);
    assert.equal(JSON.stringify(committed).includes("manifest"), false);
    assert.equal(JSON.stringify(committed).includes("actionTransaction"), false);

    const replay = await service.submitMessage(command);
    assert.equal(replay.disposition, "duplicate");

    await memorySync.idle();
    const memory = createCharacterMemoryService({
      repository: memoryRepository,
    });
    const recalled = await memory.recall({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      query: "信使离开的方向",
      limit: 5,
    });
    assert.ok(recalled.some((item) => item.content.includes("信使离开的方向")));
    assert.ok(recalled.every((item) =>
      item.observerContinuityId === POSTGRES_DEMO_IDS.scoutContinuity
    ));
    await assert.rejects(
      service.submitMessage({
        ...command,
        idempotencyKey: "stale-postgres-message",
        writeToken: stale.writeToken,
      }),
      (error: unknown) =>
        error instanceof LocalRecordServiceError
        && error.code === "WRITE_CONFLICT"
        && error.currentVersion === 4,
    );

    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('realm.workspace_id', $1, true)", [
        LOCAL_RECORD_SCOPE.workspaceId,
      ]);
      const counts = await owner.query<{
        runtime_events: number;
        observations: number;
        outbox: number;
        record_version: number;
        next_record_ordinal: number;
        memory_conclusions: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM events WHERE turn_run_id IS NOT NULL) AS runtime_events,
          (SELECT count(*)::int FROM observations) AS observations,
          (SELECT count(*)::int FROM outbox) AS outbox,
          (SELECT count(*)::int FROM memory_conclusions) AS memory_conclusions,
          head.record_version::int,
          head.next_record_ordinal::int
        FROM record_heads AS head
        WHERE head.record_id = $1
      `, [POSTGRES_DEMO_IDS.record]);
      const count = counts.rows[0]!;
      // 批次 T2：sync_turn 是 record 级集合式萃取——回合提交后异步物化该
      // record 全部 continuity 的 observations（不再只物化召回方 continuity）。
      assert.equal(count.memory_conclusions, count.observations);
      assert.deepEqual({
        runtime_events: count.runtime_events,
        observations: count.observations,
        outbox: count.outbox,
        record_version: count.record_version,
        next_record_ordinal: count.next_record_ordinal,
      }, {
        runtime_events: 4,
        observations: 9,
        outbox: 1,
        record_version: 2,
        next_record_ordinal: 6,
      });
      await owner.query("ROLLBACK");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }

    const beforeAsset = await service.loadRecord();
    const asset = beforeAsset.affordances.find((item) => item.kind === "asset");
    assert.ok(asset);
    const assetCommand = {
      recordId: POSTGRES_DEMO_IDS.record,
      content: asset.suggestedText,
      idempotencyKey: "use-signal-lantern",
      writeToken: beforeAsset.writeToken,
      actionSelection: { affordanceId: asset.id },
    };
    const assetCommitted = await service.submitMessage(assetCommand);
    assert.equal(assetCommitted.disposition, "committed");
    assert.match(
      assetCommitted.affordances.find((item) => item.kind === "asset")?.description ?? "",
      /剩余 1 次/,
    );
    const assetReplay = await service.submitMessage(assetCommand);
    assert.equal(assetReplay.disposition, "duplicate");
    assert.match(
      assetReplay.affordances.find((item) => item.kind === "asset")?.description ?? "",
      /剩余 1 次/,
    );

    const stance = assetCommitted.affordances.find((item) => item.kind === "stance");
    assert.ok(stance);
    const stanceCommitted = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: stance.suggestedText,
      idempotencyKey: "take-guarded-watch",
      writeToken: assetCommitted.writeToken,
      actionSelection: { affordanceId: stance.id },
    });
    assert.equal(stanceCommitted.disposition, "committed");
    assert.equal(
      stanceCommitted.affordances.some((item) => item.id === stance.id),
      false,
    );

    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('realm.workspace_id', $1, true)", [
        LOCAL_RECORD_SCOPE.workspaceId,
      ]);
      const state = await owner.query<{
        quantity: number;
        receipt_count: number;
        active_effect_count: number;
      }>(`
        SELECT
          asset.quantity::int,
          (SELECT count(*)::int FROM action_receipts) AS receipt_count,
          (SELECT count(*)::int FROM character_effects WHERE status = 'active')
            AS active_effect_count
        FROM character_assets AS asset
        WHERE asset.workspace_id = $1
          AND asset.record_id = $2
          AND asset.character_instance_id = $3
          AND asset.asset_definition_id = $4
      `, [
        LOCAL_RECORD_SCOPE.workspaceId,
        POSTGRES_DEMO_IDS.record,
        POSTGRES_DEMO_IDS.playerInstance,
        POSTGRES_DEMO_IDS.signalLanternAsset,
      ]);
      assert.deepEqual(state.rows[0], {
        quantity: 1,
        receipt_count: 5,
        active_effect_count: 1,
      });
      await owner.query("ROLLBACK");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }

  },
);

test(
  "dynamic restricted visibility requires confirmation and excludes non-audience observations",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const adminConnectionString = process.env.DATABASE_URL!;
    const adminUrl = requireLoopbackUrl(adminConnectionString);
    const databaseName = `realm_visibility_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const owner = new pg.Client({ connectionString: ownerUrl.href });
    await owner.connect();
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 1 });

    t.after(async () => {
      await runtimePool.end();
      await ownerPool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
    }
    await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });

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
    let sequence = 0;
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `visibility-token-${++sequence}`,
        clock: () => new Date("2026-08-14T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-14T03:00:00.000Z"),
      idFactory: () => `visibility-application-${++sequence}`,
      visibilityAssessor: {
        async assess({ playerText }) {
          return playerText.includes("不要让其他人听到")
            ? {
                visibility: {
                  kind: "restricted" as const,
                  domainId: "secret:player:scout",
                  audienceCharacterInstanceIds: [
                    POSTGRES_DEMO_IDS.playerInstance,
                    POSTGRES_DEMO_IDS.scoutInstance,
                  ],
                },
                reason: "玩家明确要求不要让其他人听到。",
              }
            : {
                visibility: { kind: "public" as const },
                reason: "普通公开交流。",
              };
        },
      },
      orchestrator: createLocalM2TurnOrchestrator({
        characters: [
          {
            characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
            participantId: POSTGRES_DEMO_IDS.scoutParticipant,
            displayName: "塞娜",
          },
          {
            characterInstanceId: POSTGRES_DEMO_IDS.scholarInstance,
            participantId: POSTGRES_DEMO_IDS.scholarParticipant,
            displayName: "弥洛",
          },
        ],
        actionResolver: createDeterministicActionResolver({
          allowStatefulReceipts: true,
        }),
      }),
    });

    const initial = await service.loadRecord();
    const proposalError = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我悄悄跟她说：不要让其他人听到。",
      idempotencyKey: "secret-before-confirm",
      writeToken: initial.writeToken,
    }).then(
      () => null,
      (error: unknown) => error as LocalRecordServiceError,
    );
    assert.ok(proposalError instanceof LocalRecordServiceError);
    assert.equal(proposalError.code, "VISIBILITY_CONFIRMATION_REQUIRED");
    assert.equal(proposalError.visibilityProposal?.kind, "restricted");
    assert.deepEqual(
      proposalError.visibilityProposal?.audienceCharacterInstanceIds,
      [POSTGRES_DEMO_IDS.playerInstance, POSTGRES_DEMO_IDS.scoutInstance],
    );

    const committed = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我悄悄跟她说：不要让其他人听到。",
      idempotencyKey: "secret-after-confirm",
      writeToken: initial.writeToken,
      visibilityConfirmation: {
        proposalId: proposalError.visibilityProposal!.proposalId,
        decision: "restricted",
      },
    });
    assert.equal(committed.disposition, "committed");
    assert.ok(
      committed.record.events.some((event) =>
        event.content.includes("不要让其他人听到")
      ),
    );
    assert.ok(
      committed.record.events.some((event) => event.role === "character"),
    );

    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('realm.workspace_id', $1, true)", [
        LOCAL_RECORD_SCOPE.workspaceId,
      ]);
      const policies = await owner.query<{
        policy_kind: string;
        audience: string[];
      }>(`
        SELECT
          policy.policy_kind,
          policy.audience_character_instance_ids AS audience
        FROM visibility_policies AS policy
        WHERE policy.policy_kind = 'restricted'
      `);
      assert.equal(policies.rows.length, 1);
      assert.deepEqual(policies.rows[0]?.audience, [
        POSTGRES_DEMO_IDS.playerInstance,
        POSTGRES_DEMO_IDS.scoutInstance,
      ]);
      const observations = await owner.query<{ observer: string }>(`
        SELECT observation.observer_character_instance_id AS observer
        FROM observations AS observation
        WHERE observation.metadata->>'channel' = 'restricted-scene'
      `);
      assert.deepEqual(
        [...new Set(observations.rows.map((row) => row.observer))],
        [POSTGRES_DEMO_IDS.playerInstance, POSTGRES_DEMO_IDS.scoutInstance],
      );
      assert.equal(
        observations.rows.some((row) =>
          row.observer === POSTGRES_DEMO_IDS.scholarInstance
        ),
        false,
      );
      await owner.query("ROLLBACK");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  },
);

test(
  "committed turn materializes durable memory and the next turn's character prompt consumes it",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    // Clean-up Iteration Phase 1 垂直闭环：生产装配形态（model-powered
    // 编排器 + 真实 PG 记忆管线）——回合提交 → sync_turn 物化 → 下一回合
    // prefetch 召回 → 角色 prompt 的 user context 真实携带记忆。
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_application_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });

    t.after(async () => {
      await runtimePool.end();
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    let sequence = 0;
    const memoryRepository = createPostgresCharacterMemoryRepository(runtimePool);
    const memory = createCharacterMemoryService({ repository: memoryRepository });
    const memorySync = createMemorySyncScheduler({
      extract: (scope) => memoryRepository.extractAuthorized(scope),
    });
    const memoryPrefetch = createMemoryPrefetchHub({
      recall: async (input) => {
        const memories = await memory.recall({ ...input, limit: 6 });
        return memories.map((item) => `- ${item.content}`).join("\n");
      },
    });
    // recallMemory 探针：记录每回合实际消费到的记忆文本。
    const recallLog: { turn: number; text: string }[] = [];
    let turnNo = 0;
    const capturedPrompts: ModelChatRequest[] = [];
    const fakeGateway: ModelGateway = {
      async discoverModels() {
        return [];
      },
      async chat(request) {
        capturedPrompts.push(request);
        const system = request.messages[0]?.content ?? "";
        const json = (value: unknown) => ({
          model: "fake-model",
          content: JSON.stringify(value),
          toolCalls: [] as const,
          finishReason: "stop",
          usage: null,
        });
        if (system.includes("presence gate")) {
          return json({ shouldSpeak: false, characterInstanceId: null, triggerKind: null, reason: "无素材。" });
        }
        if (system.includes("information visibility")) {
          return json({ visibility: "public", audienceCharacterInstanceIds: [], reason: "公开。" });
        }
        if (system.includes("DM Controller")) {
          return json({
            goal: "回应玩家",
            activatedCharacterInstanceIds: [POSTGRES_DEMO_IDS.scoutInstance],
            narratorEnabled: true,
          });
        }
        if (system.includes("independent Narrator")) {
          return json({ environment: "冷雾贴着防波堤。", storyBeat: "灯影摇了一下。", suggestions: [] });
        }
        if (system.includes("You speak only as the character")) {
          return json({ action: "塞娜点头。", dialogue: "“我记下了。”" });
        }
        if (system.includes("DM output reviewer")) {
          return json({ accepted: true, goalSatisfied: true, worldCompatible: true });
        }
        // character propose（tools 链）：不调用工具。
        return {
          model: "fake-model",
          content: "",
          toolCalls: [] as const,
          finishReason: "stop",
          usage: null,
        };
      },
    };

    const service = createLocalRecordService({
      repository: createPostgresRuntimeRepository({
        pool: runtimePool,
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        mapFormalEvent: mapLocalFormalEvent,
        allocateWorldCursors({ previous, eventCount }) {
          return Array.from({ length: eventCount }, (_, index) => ({
            tick: previous.tick,
            ordinal: previous.ordinal + index + 1,
            calendarId: previous.calendarId,
            display: previous.display,
          }));
        },
      }),
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      memorySync,
      memoryPrefetch,
      characterMemory: memory,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `pg-memory-${++sequence}`,
        clock: () => new Date("2026-09-03T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-09-03T03:00:00.000Z"),
      idFactory: () => `pg-memory-${++sequence}`,
      orchestratorFactory: (scope) => createModelPoweredM2TurnOrchestrator({
        characters: scope.aiCharacters,
        getGateway: async () => fakeGateway,
        brief: scope.brief,
        style: scope.style,
        async recallMemory(character) {
          const text = memoryPrefetch.consume(scope.recordId, character.characterInstanceId);
          recallLog.push({ turn: turnNo, text });
          return text;
        },
      }),
    });

    const initial = await service.loadRecord();
    // 回合 1：提交一条会成为观察/记忆素材的玩家输入。
    turnNo = 1;
    const first = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "先不要拆信，检查信使离开的方向。",
      idempotencyKey: "memory-vertical-turn-1",
      writeToken: initial.writeToken,
    });
    assert.equal(first.disposition, "committed");
    // 回合 1 消费时记忆尚未物化（prefetch 在提交前发起）：fail-closed 空。
    assert.ok(
      recallLog.filter((entry) => entry.turn === 1).every((entry) => entry.text === ""),
      "当前回合不得消费未提交内容萃取出的记忆",
    );
    await memorySync.idle();
    const durable = await memory.recall({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      query: "信使离开的方向",
      limit: 6,
    });
    assert.ok(
      durable.some((item) => item.content.includes("信使离开的方向")),
      "回合 1 提交后 sync_turn 必须物化出持久记忆",
    );

    // 回合 2：新输入与记忆共享关键词，预取召回应命中并在角色 prompt 可见。
    turnNo = 2;
    const second = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "信使离开的方向有什么线索？",
      idempotencyKey: "memory-vertical-turn-2",
      writeToken: first.writeToken,
    });
    assert.equal(second.disposition, "committed");
    const turn2Recalls = recallLog.filter((entry) => entry.turn === 2 && entry.text !== "");
    assert.ok(
      turn2Recalls.some((entry) => entry.text.includes("信使")),
      "下一回合角色 recallMemory 必须拿到持久化记忆",
    );
    const characterCalls = capturedPrompts.filter((request) =>
      (request.messages[0]?.content ?? "").includes("You speak only as the character")
    );
    assert.ok(
      characterCalls.some((request) =>
        (request.messages[1]?.content ?? "").includes("信使")
        && (request.messages[1]?.content ?? "").includes("[Available long-term memories]")
      ),
      "角色 react prompt 的 user context 必须真实携带记忆块",
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
  if (!/^realm_(?:application|visibility)_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
