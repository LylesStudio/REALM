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
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
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

test(
  "interjection turn commits through the real PostgreSQL runtime exactly once",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_m4_test_${randomUUID().replaceAll("-", "")}`;
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

    for (const filename of (await readdir(new URL("../database/postgres/migrations/", import.meta.url))).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
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
    const runtimeScopeProvider = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider,
      turnControl: createTurnControl({ cooldownMs: 60_000 }),
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `m4-token-${++sequence}`,
        clock: () => new Date("2026-08-14T06:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-14T06:00:00.000Z"),
      idFactory: () => `m4-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    const initial = await service.loadRecord();
    const committed = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "弥洛，你怎么看这段铭文？",
      idempotencyKey: "pg-interjection-1",
      writeToken: initial.writeToken,
    });
    assert.equal(committed.disposition, "committed");

    // 真实 PG 运行时下，弥洛的插话事件原子提交且恰好一次。
    let miloCount = 0;
    let playerCount = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const events = await service.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId, 0);
      miloCount = events.filter((event) => event.speaker === "弥洛").length;
      playerCount = events.filter((event) => event.role === "player").length;
      if (miloCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(miloCount, 1);
    // 插话不产生玩家事件：玩家事件仍只有一条。
    assert.equal(playerCount, 1);
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
  if (!/^realm_m4_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
