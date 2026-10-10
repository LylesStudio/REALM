import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRecordEnvelope } from "../app/components/record-types.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresDeliveryProjectionRepository,
  createPostgresCharacterMemoryRepository,
  createPostgresActionAffordanceCatalog,
  buildRealmRuntimeSaveBytes,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
  createPostgresGoalProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresGoalAssessmentJobQueue } from "../database/postgres/goal-assessment-job-queue.ts";
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
import { runGoalAssessmentOnce } from "../modules/goals/assessment-worker.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";
import {
  computeRealmWorldContentHash,
  installRealmWorldDirectory,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifest,
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
} from "../modules/world-transfer/realm-runtime-save.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import { POST as saveRuntimeRecord } from "../app/api/record/save/route.ts";
import { POST as restoreRuntimeRecord } from "../app/api/record/restore/route.ts";
import { GET as getRuntimeGoals } from "../app/api/record/goals/route.ts";
import { GET as getRuntimeGoalEvents } from "../app/api/record/goals/events/route.ts";
import { POST as instantiateRealmWorld } from "../app/api/realmworld/instantiate/route.ts";
import { sessionProofFor, seedCapabilitySessionKey } from "./helpers/session-proof.ts";
import { createHeadlessRuntime } from "../modules/runtime/headless-runtime.ts";

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
    const previousRuntimeDatabaseUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousRealmWorldInstallRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT;
    const previousGoalInstallRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    const previousTrustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
    const fixtureRoot = await mkdtemp(join(tmpdir(), "realm-goal-projection-route-"));
    const fixtureSource = join(fixtureRoot, "source");
    const fixtureInstallRoot = join(fixtureRoot, "install");
    const realmWorldFixtureSource = join(fixtureRoot, "realmworld-source");
    const realmWorldFixtureInstallRoot = join(fixtureRoot, "realmworld-install");
    const realmWorldFixtureTrustStore = join(fixtureRoot, "realmworld-trust-store.json");
    const fixtureTrustStore = join(fixtureRoot, "trust-store.json");

    delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
    delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    delete process.env.REALM_REALMWORLD_TRUST_STORE;

    t.after(async () => {
      if (previousRuntimeDatabaseUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeDatabaseUrl;
      if (previousRealmWorldInstallRoot === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      else process.env.REALM_REALMWORLD_INSTALL_ROOT = previousRealmWorldInstallRoot;
      if (previousGoalInstallRoot === undefined) delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
      else process.env.REALM_GOAL_WORKER_INSTALL_ROOT = previousGoalInstallRoot;
      if (previousTrustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
      else process.env.REALM_REALMWORLD_TRUST_STORE = previousTrustStore;
      await runtimePool.end();
      await ownerPool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
      await rm(fixtureRoot, { recursive: true, force: true });
    });

    for (const filename of (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
    }
    await seedPostgresDemo(ownerPool, { omniscientPlayerCharacter: false });
    await seedCapabilitySessionKey(owner, LOCAL_RECORD_SCOPE.workspaceId);

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
    const runtimeScopeRepository = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const runtimeScope = await runtimeScopeRepository.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
    });
    assert.deepEqual(runtimeScope?.worldBinding, { kind: "base" });
    const headlessRuntime = createHeadlessRuntime({
      scope: {
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        recordId: LOCAL_RECORD_SCOPE.recordId,
      },
      scopeResolver: {
        resolve: async (requested) => {
          const resolved = await runtimeScopeRepository.resolve(requested);
          if (!resolved) return null;
          const binding = resolved.worldBinding as unknown as
            | { kind: "base" }
            | { kind: "world"; worldId: string; worldVersion: string };
          return {
            workspaceId: resolved.workspaceId,
            principalId: resolved.principalId,
            recordId: resolved.recordId,
            worldId: resolved.worldId,
            worldlineId: resolved.worldlineId,
            worldBinding: binding,
          };
        },
      },
      service,
    });
    const headlessDescriptor = await headlessRuntime.start();
    assert.deepEqual(headlessDescriptor.worldBinding, { kind: "base" });
    const headlessLoad = await headlessRuntime.execute({ kind: "load" });
    assert.equal(headlessLoad.kind, "record");
    assert.equal(headlessLoad.value.record.id, LOCAL_RECORD_SCOPE.recordId);
    await headlessRuntime.stop();
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    await owner.query(
      `UPDATE worlds SET world_version = $1
       WHERE workspace_id = $2 AND id = $3`,
      [LOCAL_WORLD_VERSION, LOCAL_RECORD_SCOPE.workspaceId, POSTGRES_DEMO_IDS.world],
    );
    await owner.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, revision, progress, outcome, policy_version
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, '{}'::jsonb, NULL, $7)`,
      [
        LOCAL_RECORD_SCOPE.workspaceId,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        LOCAL_RECORD_SCOPE.recordId,
        "base_goal_source",
        "base.first-narration",
        "base-v1",
      ],
    );
    const baseGoalProjectionResponse = await getRuntimeGoals(new Request(
      `http://127.0.0.1/api/record/goals?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
      { headers: { cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}` } },
    ));
    assert.equal(baseGoalProjectionResponse.status, 200);
    assert.deepEqual((await baseGoalProjectionResponse.json()).goals, [{
      goalKey: "base.first-narration",
      state: "active",
      progress: {},
      outcome: null,
    }]);
    await owner.query(
      `DELETE FROM goal_instances
       WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, "base_goal_source"],
    );
    // Phase 4D：binding 真相在 records.world_version；worlds 行保持创建身份。
    // 本 fixture 同步两侧（真实切换由 switch-version 服务负责，见
    // tests/postgres-realmworld-version.test.ts）。
    await owner.query(
      `UPDATE worlds SET world_version = $1
       WHERE workspace_id = $2 AND id = $3`,
      ["1.2.0", LOCAL_RECORD_SCOPE.workspaceId, POSTGRES_DEMO_IDS.world],
    );
    await owner.query(
      `UPDATE records SET world_version = $1
       WHERE workspace_id = $2 AND id = $3`,
      ["1.2.0", LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    const worldBoundScope = await createPostgresRecordRuntimeScopeRepository(runtimePool).resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
    });
    assert.deepEqual(worldBoundScope?.worldBinding, {
      kind: "world",
      worldId: POSTGRES_DEMO_IDS.world,
      worldVersion: "1.2.0",
    });
    await owner.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, revision, progress, outcome, policy_version
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, $7::jsonb, NULL, $8)`,
      [
        LOCAL_RECORD_SCOPE.workspaceId,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        LOCAL_RECORD_SCOPE.recordId,
        "goal_source_restore",
        "goal.restore.coverage",
        JSON.stringify({ count: 1 }),
        "policy-v1",
      ],
    );
    await owner.query(
      `INSERT INTO goal_assessments (
         workspace_id, world_id, worldline_id, record_id, id,
         goal_instance_id, source_event_id, source, status, result,
         evidence_event_ids, evidence_head_version, evidence_head_ordinal,
         evidence_snapshot_hash, policy_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'deterministic', 'accepted', $8::jsonb,
                 $9::text[], 1, 1, $10, $11)`,
      [
        LOCAL_RECORD_SCOPE.workspaceId,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        LOCAL_RECORD_SCOPE.recordId,
        "assessment_source_restore",
        "goal_source_restore",
        POSTGRES_DEMO_IDS.openingEvent,
        JSON.stringify({ accepted: true }),
        [POSTGRES_DEMO_IDS.openingEvent],
        "a".repeat(64),
        "policy-v1",
      ],
    );
    const runtimeSaveReader = createPostgresRealmRuntimeSaveReader(runtimePool);
    const runtimeSave = await runtimeSaveReader.load({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
    });
    assert.ok(runtimeSave);
    assert.deepEqual(runtimeSave.manifest.world, {
      worldId: POSTGRES_DEMO_IDS.world,
      worldVersion: "1.2.0",
    });
    assert.equal(runtimeSave.record.scope.recordId, LOCAL_RECORD_SCOPE.recordId);
    assert.equal(runtimeSave.goals.instances.length, 1);
    assert.equal(runtimeSave.goals.assessments.length, 1);
    const goalProjection = await createPostgresGoalProjectionRepository(runtimePool).load({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
    });
    assert.deepEqual(goalProjection.instances.map((item) => ({
      goalKey: item.goalKey,
      state: item.state,
      progress: item.progress,
    })), [{
      goalKey: "goal.restore.coverage",
      state: "active",
      progress: { count: 1 },
    }]);
    assert.equal(goalProjection.worldId, POSTGRES_DEMO_IDS.world);
    assert.equal(goalProjection.worldVersion, "1.2.0");
    assert.equal(goalProjection.headOrdinal, 0);
    assert.deepEqual(await createPostgresGoalProjectionRepository(runtimePool).listGoalTransitionOrdinalsAfter({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
      cursor: 0,
    }), []);
    const runtimeSaveBytes = await buildRealmRuntimeSaveBytes(runtimeSaveReader, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: LOCAL_RECORD_SCOPE.recordId,
    });
    assert.ok(runtimeSaveBytes && runtimeSaveBytes.byteLength > 0);
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    const unavailableGoalProjectionResponse = await getRuntimeGoals(new Request(
      `http://127.0.0.1/api/record/goals?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
      { headers: { cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}` } },
    ));
    assert.equal(unavailableGoalProjectionResponse.status, 503);
    assert.equal((await unavailableGoalProjectionResponse.json()).error.code, "GOAL_CONTENT_UNAVAILABLE");
    // 共享 route-fixture-key：goal fixture 的 trust store 同时信任它，
    // 使后续 world-bound demo 存档 restore（ember 包，route key 签名）在
    // TRUST_STORE 切回 fixtureTrustStore 后仍通过信任闸。
    const realmWorldFixtureKeyPair = generateKeyPairSync("ed25519");
    const realmWorldFixturePublicKeyPem = realmWorldFixtureKeyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    await installGoalProjectionFixture({
      sourceDir: fixtureSource,
      installRoot: fixtureInstallRoot,
      trustStorePath: fixtureTrustStore,
      additionalTrustedKeys: [{
        keyId: "route-fixture-key",
        publicKeyPem: realmWorldFixturePublicKeyPem,
      }],
    });
    process.env.REALM_GOAL_WORKER_INSTALL_ROOT = fixtureInstallRoot;
    process.env.REALM_REALMWORLD_TRUST_STORE = fixtureTrustStore;
    const availableGoalProjectionResponse = await getRuntimeGoals(new Request(
      `http://127.0.0.1/api/record/goals?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
      { headers: { cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}` } },
    ));
    assert.equal(availableGoalProjectionResponse.status, 200);
    assert.deepEqual((await availableGoalProjectionResponse.json()).goals, [{
      goalKey: "goal.restore.coverage",
      state: "active",
      progress: { count: 1 },
      outcome: null,
    }]);
    await installRealmWorldInstantiationFixture({
      sourceDir: realmWorldFixtureSource,
      installRoot: realmWorldFixtureInstallRoot,
      trustStorePath: realmWorldFixtureTrustStore,
      keyPair: {
        privateKey: realmWorldFixtureKeyPair.privateKey,
        publicKeyPem: realmWorldFixturePublicKeyPem,
      },
    });
    process.env.REALM_REALMWORLD_INSTALL_ROOT = realmWorldFixtureInstallRoot;
    process.env.REALM_REALMWORLD_TRUST_STORE = realmWorldFixtureTrustStore;
    const instantiateHeaders = {
      "content-type": "application/json",
      "idempotency-key": "route-realmworld-fixture",
      cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`,
    };
    const instantiateResponse = await instantiateRealmWorld(new Request(
      "http://127.0.0.1/api/realmworld/instantiate",
      {
        method: "POST",
        headers: instantiateHeaders,
        body: JSON.stringify({
          worldId: "world_route_fixture",
          worldVersion: "1.2.0",
          locale: "en",
        }),
      },
    ));
    assert.equal(instantiateResponse.status, 201);
    const instantiateBody = await instantiateResponse.json() as {
      ok: boolean;
      worldId: string;
      worldlineId: string;
      storyId: string;
      recordId: string;
      replayed: boolean;
    };
    assert.equal(instantiateBody.ok, true);
    assert.equal(instantiateBody.worldId, "world_route_fixture");
    assert.equal(typeof instantiateBody.worldlineId, "string");
    assert.equal(typeof instantiateBody.storyId, "string");
    assert.equal(typeof instantiateBody.recordId, "string");
    assert.equal(instantiateBody.replayed, false);
    const routeReplayResponse = await instantiateRealmWorld(new Request(
      "http://127.0.0.1/api/realmworld/instantiate",
      {
        method: "POST",
        headers: instantiateHeaders,
        body: JSON.stringify({
          worldId: "world_route_fixture",
          worldVersion: "1.2.0",
          locale: "en",
        }),
      },
    ));
    assert.equal(routeReplayResponse.status, 200);
    assert.deepEqual(await routeReplayResponse.json(), { ...instantiateBody, replayed: true });
    const persistedRouteWorld = await owner.query<{
      world_version: string;
      scene_title: string;
      scene_display_time: string;
      record_count: string;
    }>(`
      SELECT w.world_version,
             s.title AS scene_title,
             s.display_time AS scene_display_time,
             COUNT(DISTINCT r.id)::text AS record_count
      FROM worlds AS w
      JOIN worldlines AS wl ON wl.world_id = w.id
      JOIN stories AS st ON st.worldline_id = wl.id
      JOIN records AS r ON r.story_id = st.id
      JOIN scenes AS s ON s.record_id = r.id
      WHERE w.workspace_id = $1 AND w.id = $2
      GROUP BY w.world_version, s.title, s.display_time
    `,
      [LOCAL_RECORD_SCOPE.workspaceId, "world_route_fixture"],
    );
    assert.deepEqual(persistedRouteWorld.rows, [{
      world_version: "1.2.0",
      scene_title: "North Pier",
      scene_display_time: "Night watch",
      record_count: "1",
    }]);
    process.env.REALM_REALMWORLD_TRUST_STORE = fixtureTrustStore;
    const goalEventsResponse = await getRuntimeGoalEvents(new Request(
      `http://127.0.0.1/api/record/goals/events?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
      { headers: { cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}` } },
    ));
    assert.equal(goalEventsResponse.status, 200);
    assert.equal(goalEventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const goalEventsReader = goalEventsResponse.body!.getReader();
    const goalEventsChunk = await goalEventsReader.read();
    assert.equal(goalEventsChunk.done, false);
    const goalEventsText = new TextDecoder().decode(goalEventsChunk.value);
    assert.match(goalEventsText, /event: goal\.projection/);
    assert.match(goalEventsText, /"goalKey":"goal\.restore\.coverage"/);
    const routeResponse = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`,
        },
        body: JSON.stringify({ recordId: LOCAL_RECORD_SCOPE.recordId }),
      },
    ));
    assert.equal(routeResponse.status, 200);
    const routeSaveBytes = new Uint8Array(await routeResponse.arrayBuffer());
    const routeSave = parseRealmRuntimeSaveArchive(routeSaveBytes);
    assert.equal(routeSave.manifest.scope.recordId, LOCAL_RECORD_SCOPE.recordId);
    assert.ok(runtimeSave.topology);
    assert.equal(runtimeSave.topology.participants.length, 3);
    assert.equal(
      runtimeSave.topology.participants.filter((participant) => participant.participantKind === "character").length,
      3,
    );
    assert.equal(runtimeSave.topology.scenes.length, 1);
    assert.equal(runtimeSave.topology.visibilityPolicies.length, 1);
    assert.ok(runtimeSave.record.events.every((event) => {
      const payload = event.payload as { readonly sceneId?: unknown; readonly visibilityPolicyId?: unknown };
      return runtimeSave.topology!.scenes.some((scene) => scene.sourceSceneId === payload.sceneId)
        && runtimeSave.topology!.visibilityPolicies.some((policy) =>
          policy.sourceVisibilityPolicyId === payload.visibilityPolicyId
        );
    }));
    const restoreHeaders = {
      "content-type": "application/vnd.realm.save+zip",
      "idempotency-key": "runtime-save-restore-test",
      "x-realm-target-world": POSTGRES_DEMO_IDS.world,
      cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`,
    };
    const restoreResponse = await restoreRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/restore",
      { method: "POST", headers: restoreHeaders, body: Buffer.from(runtimeSaveBytes) },
    ));
    assert.equal(restoreResponse.status, 201);
    const restoredEnvelope = await restoreResponse.json() as {
      ok: boolean;
      recordId: string;
      worldlineId: string;
      storyId: string;
      importedEventCount: number;
      importedGoalInstanceCount: number;
      importedAssessmentCount: number;
      replayed: boolean;
    };
    assert.equal(restoredEnvelope.ok, true);
    assert.equal(restoredEnvelope.replayed, false);
    assert.equal(restoredEnvelope.importedEventCount, runtimeSave.record.events.length);
    assert.equal(restoredEnvelope.importedGoalInstanceCount, 1);
    assert.equal(restoredEnvelope.importedAssessmentCount, 1);
    const replayResponse = await restoreRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/restore",
      { method: "POST", headers: restoreHeaders, body: Buffer.from(runtimeSaveBytes) },
    ));
    assert.equal(replayResponse.status, 200);
    const replayEnvelope = await replayResponse.json() as { replayed: boolean; recordId: string };
    assert.equal(replayEnvelope.replayed, true);
    assert.equal(replayEnvelope.recordId, restoredEnvelope.recordId);
    const changedGoals = {
      ...runtimeSave.goals,
      instances: runtimeSave.goals.instances.map((row) => (
        typeof row === "object" && row !== null && !Array.isArray(row)
          ? { ...row, progress: { count: 99 } }
          : row
      )),
    };
    const changedManifest = realmRuntimeSaveManifestFromData({
      engineApi: runtimeSave.manifest.engineApi,
      mode: runtimeSave.manifest.mode,
      world: runtimeSave.manifest.world,
      scope: runtimeSave.manifest.scope,
      record: runtimeSave.record,
      goals: changedGoals,
      topology: runtimeSave.topology,
    });
    const changedArchive = buildRealmRuntimeSaveArchive({
      manifest: changedManifest,
      record: runtimeSave.record,
      goals: changedGoals,
      topology: runtimeSave.topology,
    });
    const conflictResponse = await restoreRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/restore",
      { method: "POST", headers: restoreHeaders, body: Buffer.from(changedArchive) },
    ));
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).error.code, "RESTORE_CONFLICT");
    const restoredRows = await owner.query<{
      records: string;
      events: string;
      participants: string;
      characterInstances: string;
      scenes: string;
      visibilityPolicies: string;
      goals: string;
      assessments: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM records WHERE id = $1) AS records,
         (SELECT count(*)::text FROM events WHERE record_id = $1) AS events,
         (SELECT count(*)::text FROM participants WHERE record_id = $1) AS participants,
         (SELECT count(*)::text FROM character_instances WHERE record_id = $1) AS "characterInstances",
         (SELECT count(*)::text FROM scenes WHERE record_id = $1) AS scenes,
         (SELECT count(*)::text FROM visibility_policies WHERE record_id = $1) AS "visibilityPolicies",
         (SELECT count(*)::text FROM goal_instances WHERE record_id = $1) AS goals,
         (SELECT count(*)::text FROM goal_assessments WHERE record_id = $1) AS assessments`,
      [restoredEnvelope.recordId],
    );
    assert.deepEqual(restoredRows.rows[0], {
      records: "1",
      events: String(runtimeSave.record.events.length),
      participants: "4",
      characterInstances: "3",
      scenes: "1",
      visibilityPolicies: "1",
      goals: "1",
      assessments: "1",
    });
    const restoredTargetCounts = await owner.query<{ records: string; worldlines: string; stories: string; events: string; participants: string; scenes: string; policies: string }>(
      `SELECT
         (SELECT count(*)::text FROM records WHERE id LIKE 'record_restore_%') AS records,
         (SELECT count(*)::text FROM worldlines WHERE id LIKE 'worldline_restore_%') AS worldlines,
         (SELECT count(*)::text FROM stories WHERE id LIKE 'story_restore_%') AS stories,
         (SELECT count(*)::text FROM events WHERE id LIKE 'restore_event_%') AS events,
         (SELECT count(*)::text FROM participants WHERE id LIKE 'participant_restore_%') AS participants,
         (SELECT count(*)::text FROM scenes WHERE id LIKE 'scene_restore_%') AS scenes,
         (SELECT count(*)::text FROM visibility_policies WHERE id LIKE 'policy_restore_%') AS policies`,
    );
    const rollbackTopology = runtimeSave.topology!;
    const duplicatePolicy = {
      ...rollbackTopology.visibilityPolicies[0]!,
      sourceVisibilityPolicyId: "visibility_policy_duplicate",
    };
    const rollbackArchive = {
      ...runtimeSave,
      topology: {
        ...rollbackTopology,
        visibilityPolicies: [...rollbackTopology.visibilityPolicies, duplicatePolicy],
      },
    };
    // world-bound 存档需要信任闸 validator（本用例聚焦事务回滚，闸另行覆盖）；
    // 该包已安装可信，故 validator 直接放行。
    await assert.rejects(() => createPostgresRealmRuntimeSaveRestorer(runtimePool, {
      validateWorldBinding: async () => {},
    }).restore({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      archive: rollbackArchive,
      targetWorldId: POSTGRES_DEMO_IDS.world,
      idempotencyKey: "runtime-save-rollback-test",
    }));
    const afterRollbackCounts = await owner.query<{ records: string; worldlines: string; stories: string; events: string; participants: string; scenes: string; policies: string }>(
      `SELECT
         (SELECT count(*)::text FROM records WHERE id LIKE 'record_restore_%') AS records,
         (SELECT count(*)::text FROM worldlines WHERE id LIKE 'worldline_restore_%') AS worldlines,
         (SELECT count(*)::text FROM stories WHERE id LIKE 'story_restore_%') AS stories,
         (SELECT count(*)::text FROM events WHERE id LIKE 'restore_event_%') AS events,
         (SELECT count(*)::text FROM participants WHERE id LIKE 'participant_restore_%') AS participants,
         (SELECT count(*)::text FROM scenes WHERE id LIKE 'scene_restore_%') AS scenes,
         (SELECT count(*)::text FROM visibility_policies WHERE id LIKE 'policy_restore_%') AS policies`,
    );
    assert.deepEqual(afterRollbackCounts.rows[0], restoredTargetCounts.rows[0]);
    const missingSceneTopology = {
      ...rollbackTopology,
      scenes: rollbackTopology.scenes.map((scene) => ({
        ...scene,
        sourceSceneId: "scene_not_saved",
      })),
    };
    const invalidManifest = realmRuntimeSaveManifestFromData({
      engineApi: runtimeSave.manifest.engineApi,
      mode: runtimeSave.manifest.mode,
      world: runtimeSave.manifest.world,
      scope: runtimeSave.manifest.scope,
      record: runtimeSave.record,
      goals: runtimeSave.goals,
      topology: missingSceneTopology,
    });
    const invalidArchive = buildRealmRuntimeSaveArchive({
      manifest: invalidManifest,
      record: runtimeSave.record,
      goals: runtimeSave.goals,
      topology: missingSceneTopology,
    });
    const invalidRestoreResponse = await restoreRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/restore",
      {
        method: "POST",
        headers: {
          ...restoreHeaders,
          "idempotency-key": "runtime-save-invalid-scene-test",
        },
        body: Buffer.from(invalidArchive),
      },
    ));
    assert.equal(invalidRestoreResponse.status, 422);
    assert.equal((await invalidRestoreResponse.json()).error.code, "RUNTIME_SAVE_INVALID");
    const afterInvalidArchiveCounts = await owner.query<{ records: string; worldlines: string; stories: string; events: string; participants: string; scenes: string; policies: string }>(
      `SELECT
         (SELECT count(*)::text FROM records WHERE id LIKE 'record_restore_%') AS records,
         (SELECT count(*)::text FROM worldlines WHERE id LIKE 'worldline_restore_%') AS worldlines,
         (SELECT count(*)::text FROM stories WHERE id LIKE 'story_restore_%') AS stories,
         (SELECT count(*)::text FROM events WHERE id LIKE 'restore_event_%') AS events,
         (SELECT count(*)::text FROM participants WHERE id LIKE 'participant_restore_%') AS participants,
         (SELECT count(*)::text FROM scenes WHERE id LIKE 'scene_restore_%') AS scenes,
         (SELECT count(*)::text FROM visibility_policies WHERE id LIKE 'policy_restore_%') AS policies`,
    );
    assert.deepEqual(afterInvalidArchiveCounts.rows[0], restoredTargetCounts.rows[0]);
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

    const goalSseDefinition: GoalDefinition = {
      goalKey: "goal.restore.coverage",
      policyVersion: "policy-v1",
      mode: "deterministic",
      visible: true,
      rubric: {
        kind: "event_count",
        eventKind: "narration.committed",
        progressKey: "count",
        threshold: 1,
      },
      outcome: { title: "Restore coverage" },
    };
    const goalQueue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      leaseOwner: `goal-sse-${randomUUID()}`,
      leaseDurationMs: 30_000,
    });
    assert.equal(await goalQueue.enqueue({
      jobId: `goal-sse-job-${randomUUID()}`,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: LOCAL_RECORD_SCOPE.recordId,
      goalInstanceId: "goal_source_restore",
      goalKey: "goal.restore.coverage",
      sourceEventId: POSTGRES_DEMO_IDS.openingEvent,
      input: { trigger: "sse-application-test" },
      availableAt: new Date().toISOString(),
    }), "inserted");
    assert.deepEqual(await runGoalAssessmentOnce({
      repository: goalQueue,
      resolveDefinition: async () => goalSseDefinition,
      now: new Date().toISOString(),
    }), { kind: "settled", status: "accepted" });
    const secondGoalEventsChunk = await readWithTimeout(goalEventsReader, 5_000);
    assert.equal(secondGoalEventsChunk.done, false);
    const secondGoalEventsText = new TextDecoder().decode(secondGoalEventsChunk.value);
    assert.match(secondGoalEventsText, /^id: [1-9]\d*\n/);
    assert.match(secondGoalEventsText, /"state":"completed"/);
    const transitionCursor = Number(/^id: (\d+)\n/.exec(secondGoalEventsText)?.[1]);
    assert.ok(Number.isSafeInteger(transitionCursor) && transitionCursor > 0);
    await goalEventsReader.cancel();
    const reconnectGoalEventsResponse = await getRuntimeGoalEvents(new Request(
      `http://127.0.0.1/api/record/goals/events?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
      {
        headers: {
          cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`,
          "Last-Event-ID": String(transitionCursor),
        },
      },
    ));
    assert.equal(reconnectGoalEventsResponse.status, 200);
    const reconnectGoalEventsReader = reconnectGoalEventsResponse.body!.getReader();
    const reconnectGoalEventsChunk = await readWithTimeout(reconnectGoalEventsReader, 5_000);
    assert.equal(reconnectGoalEventsChunk.done, false);
    const reconnectGoalEventsText = new TextDecoder().decode(reconnectGoalEventsChunk.value);
    assert.match(reconnectGoalEventsText, new RegExp(`^id: ${transitionCursor}\n`));
    assert.match(reconnectGoalEventsText, /"state":"completed"/);
    await reconnectGoalEventsReader.cancel();
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
            turnIntent: "回应玩家",
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
          return json({ accepted: true, turnIntentSatisfied: true, worldCompatible: true });
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

async function installRealmWorldInstantiationFixture(input: {
  sourceDir: string;
  installRoot: string;
  trustStorePath: string;
  keyPair: { privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]; publicKeyPem: string };
}): Promise<void> {
  const { privateKey, publicKeyPem } = input.keyPair;
  const installPackage = async (input2: {
    sourceDir: string;
    worldId: string;
    files: ReadonlyMap<string, Uint8Array>;
  }): Promise<void> => {
    const unsigned: RealmWorldManifestV1 = {
      format: REALMWORLD_FORMAT,
      formatVersion: REALMWORLD_FORMAT_VERSION,
      worldId: input2.worldId,
      worldVersion: "1.2.0",
      engineCompat: {
        schemaLatest: "0057_realmworld_record_binding.sql",
        requiresMigrations: ["0055_goal_runtime.sql"],
      },
      contentHash: computeRealmWorldContentHash(input2.files),
      signature: { algorithm: "ed25519", keyId: "route-fixture-key", value: "placeholder" },
    };
    const signature = sign(
      null,
      Buffer.from(serializeRealmWorldManifestSigningPayload(unsigned), "utf8"),
      privateKey,
    ).toString("base64url");
    const manifest: RealmWorldManifestV1 = {
      ...unsigned,
      signature: { ...unsigned.signature, value: signature },
    };
    await mkdir(input2.sourceDir, { recursive: true });
    for (const [relativePath, bytes] of input2.files) {
      const path = join(input2.sourceDir, ...relativePath.split("/"));
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, bytes);
    }
    await writeFile(
      join(input2.sourceDir, "realmworld-manifest.json"),
      serializeRealmWorldManifest(manifest),
    );
    await installRealmWorldDirectory({
      sourceDir: input2.sourceDir,
      installRoot: input.installRoot,
      verifySignature: ({ manifest: candidate }) => candidate.signature.value === signature,
    });
  };
  await installPackage({
    sourceDir: input.sourceDir,
    worldId: "world_route_fixture",
    files: new Map<string, Uint8Array>([
      [
        "content/index.json",
        Buffer.from(JSON.stringify({
          format: "realmworld-content",
          schemaVersion: 1,
          modules: [
            "content/world.json",
            "content/runtime.json",
            "content/goals.json",
          ],
        })),
      ],
      [
        "content/world.json",
        Buffer.from(JSON.stringify({
          worldId: "world_route_fixture",
          title: { en: "Route Harbor" },
          settings: {
            era: "After the Long Storm",
            language: "en",
            weather: "salt rain",
            tension: "quiet pressure",
          },
        })),
      ],
      [
        "content/runtime.json",
        Buffer.from(JSON.stringify({
          format: "realmworld-runtime",
          schemaVersion: 1,
          story: { title: { en: "The Harbor" }, premise: { en: "A sealed tide returns." } },
          record: { title: { en: "First Watch" } },
          scene: {
            title: { en: "North Pier" },
            location: { en: "North pier" },
            objective: { en: "Wait for the tide" },
            tension: { en: "A storm approaches" },
            weather: { en: "Salt rain" },
            displayTime: { en: "Night watch" },
          },
          playerRole: { en: "Keeper" },
          playerStance: "player",
          characters: [{
            characterKey: "scout",
            displayName: { en: "Mara" },
            role: { en: "Scout" },
            summary: { en: "Reads the tide marks." },
            profile: { temperament: "careful" },
          }],
        })),
      ],
      [
        "content/goals.json",
        Buffer.from(JSON.stringify({
          format: "realmworld-goals",
          schemaVersion: 1,
          goals: [],
        })),
      ],
    ]),
  });
  // world-bound demo 存档（world_ember_coast@1.2.0）的 restore 信任闸：
  // 同一 trust key 签名的最小已安装包（mount 只要求 manifest/content hash/
  // 签名有效，不需要 runtime content）。
  await installPackage({
    sourceDir: join(input.sourceDir, "..", "realmworld-ember-source"),
    worldId: POSTGRES_DEMO_IDS.world,
    files: new Map<string, Uint8Array>([
      [
        "content/index.json",
        Buffer.from(JSON.stringify({
          format: "realmworld-content",
          schemaVersion: 1,
          modules: ["content/world.json"],
        })),
      ],
      [
        "content/world.json",
        Buffer.from(JSON.stringify({
          worldId: POSTGRES_DEMO_IDS.world,
          title: { en: "Ember Coast" },
          settings: {},
        })),
      ],
    ]),
  });
  await writeFile(input.trustStorePath, JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [{
      keyId: "route-fixture-key",
      publicKey: publicKeyPem,
      status: "active",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
    }],
  }));
}

async function installGoalProjectionFixture(input: {
  sourceDir: string;
  installRoot: string;
  trustStorePath: string;
  additionalTrustedKeys?: readonly { keyId: string; publicKeyPem: string }[];
}): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const files = new Map<string, Uint8Array>([
    [
      "content/index.json",
      Buffer.from(JSON.stringify({
        format: "realmworld-content",
        schemaVersion: 1,
        modules: ["content/world.json", "content/goals.json"],
      })),
    ],
    [
      "content/world.json",
      Buffer.from(JSON.stringify({
        worldId: POSTGRES_DEMO_IDS.world,
        title: { en: "Fixture Harbor" },
        settings: {},
      })),
    ],
    [
      "content/goals.json",
      Buffer.from(JSON.stringify({
        format: "realmworld-goals",
        schemaVersion: 1,
        goals: [{
          goalKey: "goal.restore.coverage",
          policyVersion: "policy-v1",
          mode: "deterministic",
          visible: true,
          rubric: {
            kind: "event_count",
            eventKind: "narration.committed",
            progressKey: "count",
            threshold: 1,
          },
          outcome: { title: "Restore coverage" },
        }],
      })),
    ],
    ["ui/index.html", Buffer.from("<!doctype html><title>Fixture Harbor</title>")],
  ]);
  const unsigned: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: POSTGRES_DEMO_IDS.world,
    worldVersion: "1.2.0",
    engineCompat: {
      schemaLatest: "0055_goal_runtime.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
    },
    contentHash: computeRealmWorldContentHash(files),
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "placeholder" },
    webui: { entry: "ui/index.html", bridgeMajor: 1 },
  };
  const signature = sign(
    null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(unsigned), "utf8"),
    privateKey,
  ).toString("base64url");
  const manifest: RealmWorldManifestV1 = {
    ...unsigned,
    signature: { ...unsigned.signature, value: signature },
  };
  await mkdir(input.sourceDir, { recursive: true });
  for (const [relativePath, bytes] of files) {
    const path = join(input.sourceDir, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(
    join(input.sourceDir, "realmworld-manifest.json"),
    serializeRealmWorldManifest(manifest),
  );
  await writeFile(input.trustStorePath, JSON.stringify({
    format: "realmworld-trust-store",
    version: 1,
    keys: [
      {
        keyId: "fixture-key",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
      },
      ...(input.additionalTrustedKeys ?? []).map((key) => ({
        keyId: key.keyId,
        publicKey: key.publicKeyPem,
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
      })),
    ],
  }));
  await installRealmWorldDirectory({
    sourceDir: input.sourceDir,
    installRoot: input.installRoot,
    verifySignature: ({ manifest: candidate }) => candidate.signature.value === signature,
  });
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE test read timed out.")), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
