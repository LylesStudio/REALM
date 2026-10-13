/**
 * 内容解析层 · base genesis 经 resolver 路径的 disposable PostgreSQL 验收。
 *
 * 证明（目标 Slice 1 第 3/5 条）：
 * - LibraryService.createGenesisFromContent 经注入的 ContentResolver +
 *   WorldBinding 消费内容，base mode 默认 BaseContentResolver；产物是
 *   可玩 Record（世界/故事/记录/场景/阵容/开场旁白/record_heads 全部
 *   落库），worlds/records.world_version 恒为 LOCAL_WORLD_VERSION 哨兵，
 *   Library 读回 binding 恒为 { kind: "base" }；
 * - 落库文本与 base resolver 解析值逐字一致（genesis 不再自持内容）；
 * - preset 命令同样经 resolver（注入的包装 resolver 观察到调用）；
 * - 失败路径 fail-closed 零残留：未知 contentKey、world-bound binding、
 *   base 草稿声明未解析的 Goal；
 * - demo seed 兼容 shim 落库内容与 base resolver zh-CN 规范值一致。
 *
 * 自包含隔离：在本集群新建专属一次性数据库、应用完整 migration chain、
 * 结束时 DROP DATABASE，绝不写共享数据库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import {
  BASE_CONTENT_RESOLVER,
} from "../modules/content-resolution/base-resolver.ts";
import {
  baseContentRequestBase,
  type ContentResolver,
  type GenesisContentRequest,
} from "../modules/content-resolution/public.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";

installTestSessionSecret();

const adminConnectionString = process.env.DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

test(
  "base genesis through the content resolver produces a playable Record",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_cr_genesis_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    ownerPool.on("error", () => {});

    t.after(async () => {
      await ownerPool.end();
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
    await seedCapabilitySessionKey(ownerPool, LOCAL_RECORD_SCOPE.workspaceId);
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, display_name) DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
    );

    // 注入观察 resolver：证明 genesis/preset 经 ContentResolver 消费内容。
    const genesisCalls: GenesisContentRequest[] = [];
    const observingResolver: ContentResolver = new Proxy(BASE_CONTENT_RESOLVER, {
      get(target, property, receiver) {
        if (property === "resolveGenesisContent") {
          return (request: GenesisContentRequest) => {
            genesisCalls.push(request);
            return target.resolveGenesisContent(request);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const service = createPostgresLibraryService(ownerPool, ownerPool, {
      contentResolver: observingResolver,
    });
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      sessionProof: sessionProofFor(LOCAL_RECORD_SCOPE.principalId),
    };

    // ===== 正向：resolver 内容驱动的 base genesis → 可玩 Record =====
    const expected = BASE_CONTENT_RESOLVER.resolveGenesisContent({
      binding: { kind: "base" },
      contentKey: "dnd-tavern",
      language: "zh-CN",
    });
    assert.ok(expected);
    const created = await service.createGenesisFromContent(scope, {
      binding: { kind: "base" },
      contentKey: "dnd-tavern",
      language: "zh-CN",
    });
    assert.equal(genesisCalls.length, 1);
    assert.deepEqual(genesisCalls[0]?.binding, { kind: "base" });

    const worldRow = await ownerPool.query<{
      name: string;
      world_version: string;
      settings: Record<string, unknown>;
    }>(
      `SELECT name, world_version, settings
       FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, created.worldId],
    );
    assert.equal(worldRow.rows[0]?.name, expected.world.name);
    assert.equal(worldRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);
    assert.equal(worldRow.rows[0]?.settings.style, "western_fantasy");
    assert.equal(worldRow.rows[0]?.settings.language, "zh-CN");

    const recordRow = await ownerPool.query<{ title: string; world_version: string }>(
      `SELECT title, world_version
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(recordRow.rows[0]?.title, expected.record.title);
    assert.equal(recordRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);

    // Library 读模型：哨兵版本 → 精确 base binding。
    const snapshot = await service.list(scope);
    const createdWorld = snapshot.worlds.find((world) => world.id === created.worldId);
    assert.ok(createdWorld);
    assert.deepEqual(createdWorld.binding, { kind: "base" });

    // 可玩性：场景/阵容/开场旁白/record_heads 全部按 resolver 内容落库。
    const sceneRow = await ownerPool.query<{ location: string; objective: string }>(
      `SELECT location, objective
       FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(sceneRow.rows[0]?.location, expected.scene.location);
    assert.equal(sceneRow.rows[0]?.objective, expected.scene.objective);

    const characterRows = await ownerPool.query<{ display_name: string }>(
      `SELECT display_name
       FROM character_definitions
       WHERE workspace_id = $1 AND world_id = $2
       ORDER BY display_name`,
      [scope.workspaceId, created.worldId],
    );
    assert.deepEqual(
      characterRows.rows.map((row) => row.display_name),
      ["测试旅人", ...expected.characters.map((character) => character.displayName)].sort(),
    );
    const participantRows = await ownerPool.query<{ controller_mode: string }>(
      `SELECT controller_mode
       FROM participants
       WHERE workspace_id = $1 AND record_id = $2 AND is_active
       ORDER BY speaking_order`,
      [scope.workspaceId, created.recordId],
    );
    assert.deepEqual(
      participantRows.rows.map((row) => row.controller_mode),
      ["human", "ai", "ai"],
    );

    const openingEvent = await ownerPool.query<{ content: string }>(
      `SELECT content
       FROM events
       WHERE workspace_id = $1 AND record_id = $2
         AND event_kind = 'narration.committed'
       ORDER BY record_ordinal
       LIMIT 1`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(openingEvent.rows[0]?.content, expected.opening);
    const headRow = await ownerPool.query<{ next_record_ordinal: number }>(
      `SELECT next_record_ordinal
       FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.ok((headRow.rows[0]?.next_record_ordinal ?? 0) >= 2);

    // ===== preset 命令同样经 resolver =====
    const preset = await service.create(scope, {
      kind: "preset-world",
      presetKey: "anime-hero",
      language: "en",
    });
    assert.ok(preset && "recordId" in preset && typeof preset.recordId === "string");
    const presetRecordId = preset.recordId;
    assert.equal(genesisCalls.length, 2);
    const presetWorld = await ownerPool.query<{ world_version: string }>(
      `SELECT records.world_version
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, presetRecordId],
    );
    assert.equal(presetWorld.rows[0]?.world_version, LOCAL_WORLD_VERSION);

    // ===== demo seed shim 落库内容 = base resolver zh-CN 规范值 =====
    const demoScopeZh = baseContentRequestBase("zh-CN", "ember-coast");
    const demoWorldContent = BASE_CONTENT_RESOLVER.resolveWorld(demoScopeZh);
    const demoWorldRow = await ownerPool.query<{ name: string; summary: string }>(
      `SELECT name, summary
       FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, POSTGRES_DEMO_IDS.world],
    );
    assert.equal(demoWorldRow.rows[0]?.name, demoWorldContent?.name);
    assert.equal(demoWorldRow.rows[0]?.summary, demoWorldContent?.summary);
    const demoCharacterRow = await ownerPool.query<{ profile: { role: string } }>(
      `SELECT profile
       FROM character_definitions
       WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, POSTGRES_DEMO_IDS.playerDefinition],
    );
    assert.equal(
      demoCharacterRow.rows[0]?.profile.role,
      BASE_CONTENT_RESOLVER.resolveCharacter({ ...demoScopeZh, characterKey: "player" })?.role,
    );

    // ===== 失败路径 fail-closed 零残留 =====
    const worldCount = async () => (await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM worlds WHERE workspace_id = $1`,
      [scope.workspaceId],
    )).rows[0]!.count;
    const beforeFailures = await worldCount();

    await assert.rejects(
      () => service.createGenesisFromContent(scope, {
        binding: { kind: "base" },
        contentKey: "no-such-bundle",
        language: "zh-CN",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "INVALID_COMMAND",
    );
    await assert.rejects(
      () => service.createGenesisFromContent(scope, {
        binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
        language: "zh-CN",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "INVALID_COMMAND",
    );
    // base 草稿声明未解析的 Goal：genesis 经 resolver fail-closed。
    await assert.rejects(
      () => service.createGenesis(scope, {
        world: { name: "幽影城", era: "", summary: "" },
        style: "modern",
        story: { title: "序", premise: "" },
        record: { title: "一" },
        playerRole: "",
        companions: [],
        scene: { location: "", weather: "", tension: "", objective: "" },
        playerStance: "player",
        opening: "",
        goals: [{ goalKey: "base.no-such-goal", policyVersion: "base-v1" }],
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "INVALID_COMMAND",
    );
    // policyVersion 与 engine-owned 定义不符同样拒绝。
    await assert.rejects(
      () => service.createGenesis(scope, {
        world: { name: "幽影城", era: "", summary: "" },
        style: "modern",
        story: { title: "序", premise: "" },
        record: { title: "一" },
        playerRole: "",
        companions: [],
        scene: { location: "", weather: "", tension: "", objective: "" },
        playerStance: "player",
        opening: "",
        goals: [{ goalKey: "base.first-narration", policyVersion: "forged-v9" }],
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "INVALID_COMMAND",
    );
    assert.equal(await worldCount(), beforeFailures, "失败路径不得残留世界行");
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
  if (!/^realm_cr_genesis_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
