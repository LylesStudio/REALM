/**
 * 批次 T3 角色在场——PostgreSQL 集成测试
 * （docs/development/T3-CHARACTER-PRESENCE.md §4.1）。
 * 覆盖：在场事件经真实 PG 运行时落库（utterance.committed + payload 在场标记）、
 * 头指针连续无空洞、预算恰 1/回合、不产生额外玩家事件、observations 落库、
 * delivery 投影透出 presence。门禁为内联确定性实现，不依赖真实模型。
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
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import type { PresenceAssessor } from "../modules/orchestration/presence.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const MILO_ID = "char_inst_scholar";

/** 内联确定性门禁：只要有弥洛候选就裁决发声（peer 触发）。 */
const deterministicPresenceAssessor: PresenceAssessor = {
  async assess({ candidates }) {
    const milo = candidates.find(
      (candidate) => candidate.characterInstanceId === MILO_ID,
    );
    return milo
      ? {
          kind: "speak",
          characterInstanceId: MILO_ID,
          triggerKind: "peer",
          reason: "同侪发言值得接话。",
        }
      : { kind: "silent", reason: "无候选。" };
  },
};

test(
  "presence turns commit through the real PostgreSQL runtime with budget and markers",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t3_test_${randomUUID().replaceAll("-", "")}`;
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

    for (const filename of (await readdir(migrationDir)).sort()) {
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
        presence?: {
          characterInstanceId: string;
          triggerKind: "environment" | "peer" | "hook";
        };
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
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
      // cooldownMs:0 → 弥洛发声后立刻重新可候选，验证预算按回合限 1。
      turnControl: createTurnControl({ cooldownMs: 0 }),
      presenceAssessor: deterministicPresenceAssessor,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `t3-token-${++sequence}`,
        clock: () => new Date("2026-08-20T06:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-20T06:00:00.000Z"),
      idFactory: () => `t3-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    // ---- 回合 1：未点名 → 弥洛自主在场一次 ----
    const initial = await service.loadRecord();
    const committed = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我沿着防波堤慢慢走。",
      idempotencyKey: "pg-presence-1",
      writeToken: initial.writeToken,
    });
    assert.equal(committed.disposition, "committed");

    let presenceCount = 0;
    let deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const events = await service.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId, 0);
      presenceCount = events.filter((event) => event.presence !== undefined).length;
      if (presenceCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 预算恰 1：单回合只落库一条在场事件。
    assert.equal(presenceCount, 1);

    let events = await service.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId, 0);
    // delivery 投影透出 presence 标记（GUI/观察者可见的内容供给）。
    const presenceEvent = events.find((event) => event.presence !== undefined)!;
    assert.equal(presenceEvent.speaker, "弥洛");
    assert.equal(presenceEvent.role, "character");
    assert.equal(presenceEvent.status, "committed");
    assert.equal(presenceEvent.presence!.characterInstanceId, MILO_ID);
    assert.equal(presenceEvent.presence!.triggerKind, "peer");
    assert.ok(presenceEvent.content.length > 0);
    // 在场不产生玩家事件：玩家事件仍只有回合 1 的一条。
    assert.equal(events.filter((event) => event.role === "player").length, 1);

    // ---- 落库核验：payload 在场标记 + 头指针连续 + observations ----
    const eventRows = await owner.query(
      `SELECT id, event_kind, speaker_name, payload
       FROM events WHERE record_id = $1 ORDER BY record_ordinal ASC`,
      [LOCAL_RECORD_SCOPE.recordId],
    );
    const presenceRows = eventRows.rows.filter(
      (row) => (row.payload as { presence?: unknown }).presence !== undefined,
    );
    assert.equal(presenceRows.length, 1);
    assert.equal(presenceRows[0].event_kind, "utterance.committed");
    assert.equal(presenceRows[0].speaker_name, "弥洛");
    const marker = (presenceRows[0].payload as {
      presence: { characterInstanceId: string; triggerKind: string };
    }).presence;
    assert.equal(marker.characterInstanceId, MILO_ID);
    assert.equal(marker.triggerKind, "peer");

    // 头指针连续：world ordinal 按事件致密推进（last_world_ordinal == 事件总数、
    // next_record_ordinal == 事件总数+1，无空洞）；record_version 按提交批次推进
    // （种子 1 + 玩家回合 1 + 在场回合 1 == 3）。
    const head = await owner.query(
      `SELECT record_version, next_record_ordinal, last_world_ordinal
       FROM record_heads WHERE record_id = $1`,
      [LOCAL_RECORD_SCOPE.recordId],
    );
    assert.equal(head.rows.length, 1);
    assert.equal(Number(head.rows[0].last_world_ordinal), eventRows.rows.length);
    assert.equal(
      Number(head.rows[0].next_record_ordinal),
      eventRows.rows.length + 1,
    );
    assert.equal(Number(head.rows[0].record_version), 3);

    // 在场事件同样写 observations（T7 观察者内容供给）。
    const observationCount = await owner.query(
      `SELECT count(*)::int AS count FROM observations
       WHERE record_id = $1 AND source_event_id = $2`,
      [LOCAL_RECORD_SCOPE.recordId, presenceRows[0].id],
    );
    assert.ok(observationCount.rows[0].count >= 1);

    // ---- 回合 2：预算按回合重置，仍各至多 1 次 ----
    const reloaded = await service.loadRecord();
    const second = await service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我停下来听潮声。",
      idempotencyKey: "pg-presence-2",
      writeToken: reloaded.writeToken,
    });
    assert.equal(second.disposition, "committed");

    deadline = Date.now() + 5000;
    let totalPresence = presenceCount;
    while (Date.now() < deadline) {
      const all = await service.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId, 0);
      totalPresence = all.filter((event) => event.presence !== undefined).length;
      if (totalPresence >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 两回合各恰 1 次；再等一拍确认没有第三条（不刷屏）。
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = await service.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId, 0);
    const finalPresence = events.filter((event) => event.presence !== undefined);
    assert.equal(finalPresence.length, 2);
    assert.equal(totalPresence, 2);
    // 玩家事件仍恰 2 条（在场不冒用玩家身份）。
    assert.equal(events.filter((event) => event.role === "player").length, 2);
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
  if (!/^realm_t3_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
