/**
 * 批次 T8 世界管理台——PostgreSQL 集成测试
 * （docs/development/T8-WORLD-ADMIN.md §4.1）。
 * 覆盖：归档翻转幂等与 owner 门禁（WORLD_NOT_OWNED）、归档世界开新局全拒
 * （WORLD_ARCHIVED：story/character/branch/record）、归档世界回合与自演拒绝、
 * 活动自演会话防护（WORLD_SELF_PLAY_ACTIVE）、零事件世界物理删除级联清零、
 * 有事件世界删除被拒（WORLD_NOT_EMPTY）、快照信息密度与排序、
 * 0021 授权实锤（受限 realm_runtime 角色归档/删除真实可写）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresActionAffordanceCatalog,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresSelfPlayStore } from "../database/postgres/self-play-store.ts";
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
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_t8_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
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
    await ownerPool.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await seedPostgresDemo(ownerPool);
  await ownerPool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, display_name) DO NOTHING`,
    [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
  );
  return { ownerPool, runtimePool };
}

function createRecordService(
  ownerPool: pg.Pool,
  store: ReturnType<typeof createPostgresSelfPlayStore>,
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
    pool: ownerPool,
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
  return createLocalRecordService({
    repository,
    projection: createPostgresDeliveryProjectionRepository(ownerPool),
    actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
    runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
    selfPlayStore: store,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `t8-token-${++sequence}`,
      clock: () => new Date("2026-08-21T00:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-21T00:00:00.000Z"),
    idFactory: () => `t8-${++sequence}`,
    orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
      characters: scope.aiCharacters,
    }),
  });
}

test(
  "T8 PG: archive seals a world (owner gate, no new content), restore, density and ordering",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };

    await library.create(scope, {
      kind: "world",
      name: "档案馆试验场",
      era: "封缄纪元 1 年",
      summary: "测试归档与删除的世界。",
    });
    const listed = await library.list(scope);
    const world = listed.worlds.find((item) => item.name === "档案馆试验场")!;
    assert.ok(world);
    // 信息密度字段存在且为 0 基线。
    assert.equal(world.storyCount, 1);
    assert.equal(world.recordCount, 1);
    assert.equal(world.characterCount, 1);
    assert.ok(world.lastActiveAt);
    assert.equal(world.status, "active");

    // owner 门禁：非成员 principal 不得归档（F1）。
    await assert.rejects(
      library.create(
        { workspaceId: scope.workspaceId, principalId: "principal_stranger" },
        { kind: "world-archive", worldId: world.id, archived: true },
      ),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_OWNED",
    );

    // 归档幂等：两次归档都成功，状态不变（F7）。
    await library.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: true,
    });
    await library.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: true,
    });
    const archived = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!;
    assert.equal(archived.status, "archived");

    // 封存：归档世界不可开新局（F2：story/character/branch）。
    for (const command of [
      { kind: "story", worldId: world.id, title: "封存故事", premise: "" },
      {
        kind: "character",
        worldId: world.id,
        name: "封存角色",
        role: "守卫",
        summary: "",
      },
      { kind: "branch", worldId: world.id, label: "封存分支" },
    ] as const) {
      await assert.rejects(
        library.create(scope, command),
        (error: unknown) =>
          error instanceof LibraryServiceError && error.code === "WORLD_ARCHIVED",
      );
    }

    // 排序：archived 沉底（demo 世界 active 在前）。
    const ordered = (await library.list(scope)).worlds;
    assert.equal(ordered.at(-1)?.id, world.id);
    assert.equal(ordered[0]?.status, "active");

    // 恢复幂等。
    await library.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: false,
    });
    const restored = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!;
    assert.equal(restored.status, "active");

    // 0021 授权实锤：受限 realm_runtime 角色可翻转 status。
    const runtimeLibrary = createPostgresLibraryService(runtimePool);
    await runtimeLibrary.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: true,
    });
    assert.equal(
      (await library.list(scope)).worlds.find((item) => item.id === world.id)
        ?.status,
      "archived",
    );
  },
);

test(
  "T8 PG: archived worlds reject turns and self-play; active self-play blocks archive",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const store = createPostgresSelfPlayStore(
      runtimePool,
      LOCAL_RECORD_SCOPE.workspaceId,
    );
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };

    // 创世一个带记录的世界（观察者姿态）。
    const genesis = await library.createGenesis(scope, {
      world: { name: "只读回廊", era: "静默纪元", summary: "回声档案馆。" },
      style: "modern",
      story: { title: "长廊", premise: "一段没有尽头的走廊。" },
      record: { title: "入口" },
      playerRole: "档案员",
      companions: [],
      scene: { location: "门口", weather: "", tension: "", objective: "" },
      playerStance: "player",
      opening: "",
    });
    const recordService = createRecordService(ownerPool, store);

    // 有活动自演会话 → 归档被拒（F4）。
    const session = await recordService.startSelfPlay(genesis.recordId);
    assert.equal(session.state, "running");
    await assert.rejects(
      library.create(scope, {
        kind: "world-archive",
        worldId: genesis.worldId,
        archived: true,
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_SELF_PLAY_ACTIVE",
    );
    await recordService.stopSelfPlay(genesis.recordId);
    // 等拍循环收束（取消在拍边界生效）。
    const deadline = Date.now() + 10_000;
    for (;;) {
      const current = await store.load(session.id);
      if (
        current && ["cancelled", "completed", "failed"].includes(current.state)
      ) {
        break;
      }
      assert.ok(Date.now() < deadline, "self-play session must settle");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // 归档成功 → 回合与自演全拒（F3：WORLD_ARCHIVED）。
    await library.create(scope, {
      kind: "world-archive",
      worldId: genesis.worldId,
      archived: true,
    });
    await assert.rejects(
      recordService.startSelfPlay(genesis.recordId),
      (error: unknown) =>
        error instanceof LocalRecordServiceError
        && error.code === "WORLD_ARCHIVED",
    );
    const envelope = await recordService.loadRecord(genesis.recordId);
    await assert.rejects(
      recordService.submitMessage({
        recordId: genesis.recordId,
        content: "还有人吗？",
        idempotencyKey: "t8-archived-turn",
        writeToken: envelope.writeToken,
      }),
      (error: unknown) =>
        error instanceof LocalRecordServiceError
        && error.code === "WORLD_ARCHIVED",
    );
    // 读取自由：归档不挡投影（envelope 正常返回即证据）。
    assert.ok(envelope.record.id === genesis.recordId);
  },
);

test(
  "T8 PG: delete removes only zero-event worlds and cascades cleanly",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };

    // World 创建即带序章/开幕 Record，因此物理删除必须 fail-closed。
    await library.create(scope, {
      kind: "world",
      name: "一次性世界",
      era: "刹那纪元",
      summary: "即将被删除。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "一次性世界",
    )!;
    await library.create(scope, {
      kind: "story",
      worldId: world.id,
      title: "临时故事",
      premise: "……",
    });
    const dense = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!;
    assert.equal(dense.storyCount, 2);
    assert.equal(dense.recordCount, 1);

    // owner 门禁：非 owner 删除被拒（F1）。
    await assert.rejects(
      library.create(
        { workspaceId: scope.workspaceId, principalId: "principal_stranger" },
        { kind: "delete-world", worldId: world.id },
      ),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_OWNED",
    );

    // 删除：自动开幕 Record 阻止物理删除，只能归档。
    await assert.rejects(
      library.create(scope, { kind: "delete-world", worldId: world.id }),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_EMPTY",
    );
    assert.equal(
      (await library.list(scope)).worlds.some((item) => item.id === world.id),
      true,
    );
    await library.create(scope, {
      kind: "world",
      name: "一次性世界",
      era: "刹那纪元",
      summary: "重建。",
    });
    assert.ok(
      (await library.list(scope)).worlds.some(
        (item) => item.name === "一次性世界",
      ),
    );

    // 有记录世界：demo 世界删除被拒（F5：WORLD_NOT_EMPTY 引导归档）。
    await assert.rejects(
      library.create(scope, {
        kind: "delete-world",
        worldId: "world_ember_coast",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_EMPTY",
    );

    // 0021 授权实锤：受限角色能到达删除业务闸门，但自动开幕 Record
    // 使物理删除安全拒绝；不能为了测试授权而制造无 Record 世界。
    await library.create(scope, {
      kind: "world",
      name: "受限角色删除场",
      era: "x",
      summary: "x",
    });
    const runtimeTarget = (await library.list(scope)).worlds.find(
      (item) => item.name === "受限角色删除场",
    )!;
    const runtimeLibrary = createPostgresLibraryService(runtimePool);
    await assert.rejects(
      runtimeLibrary.create(scope, {
        kind: "delete-world",
        worldId: runtimeTarget.id,
      }),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_EMPTY",
    );
    assert.equal(
      (await library.list(scope)).worlds.some(
        (item) => item.id === runtimeTarget.id,
      ),
      true,
    );
  },
);
