/**
 * Slice 3：嵌入式统一 durable job runtime 的真实 PostgreSQL 端到端。
 * 一次性库（t.after 强制拆库，全迁移链 + demo seed）：装配
 * createDurableJobRuntime（advisory lock + realm_runtime 受限角色）并注入
 * createLocalRecordService——startSelfPlay 不再进程内起拍，而是入队
 * self-play-beat durable job；host claim→拍执行→completeBeat CAS→收束。
 * 断言：会话 completed、realm_durable_jobs 行 completed、事件落库带
 * selfPlay 标记、completeBeat 拍号 CAS 防重复计拍、host 幂等 stop。
 * 零开发库污染。
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
import { createDurableJobRuntime } from "../modules/application/durable-job-runtime.ts";
import {
  LOCAL_RECORD_SCOPE,
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

test(
  "Slice 3: self-play beats run through the embedded durable job host on real PG",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_djrt_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    ownerPool.on("error", () => undefined);
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
    runtimePool.on("error", () => undefined);

    const durableRuntime = createDurableJobRuntime({
      connectionString: runtimeUrl.href,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      leaseDurationMs: 60_000,
      idleMinMs: 50,
      idleMaxMs: 200,
      logger: () => {},
    });

    t.after(async () => {
      await durableRuntime.stop().catch(() => undefined);
      await ownerPool.end().catch(() => undefined);
      await runtimePool.end().catch(() => undefined);
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const store = createPostgresSelfPlayStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);
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
        selfPlay?: { beat: number };
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
      selfPlayStore: store,
      durableJobRuntime: durableRuntime,
      selfPlayBeatBudget: 1,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `djrt-token-${++sequence}`,
        clock: () => new Date("2026-08-21T00:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-21T00:00:00.000Z"),
      idFactory: () => `djrt-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    // startSelfPlay 入队 beat job；embedded host 经 advisory lock 单实例执行。
    const session = await service.startSelfPlay(LOCAL_RECORD_SCOPE.recordId);
    assert.equal(session.state, "running");

    let final = null;
    let settledJobState: string | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      final = await store.load(session.id);
      // The business session is committed by the handler *before* the host
      // acknowledges its leased queue row. Observe both durable boundaries,
      // not whichever happens to win the next PostgreSQL round trip.
      const job = await ownerPool.query<{ state: string }>(
        `SELECT state FROM realm_durable_jobs WHERE workspace_id = $1 AND id = $2`,
        [LOCAL_RECORD_SCOPE.workspaceId, `self-play-beat:${session.id}:1`],
      );
      settledJobState = job.rows[0]?.state;
      if (final && ["completed", "failed", "cancelled"].includes(final.state)
        && settledJobState && ["completed", "failed", "cancelled"].includes(settledJobState)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(final?.state, "completed");
    assert.equal(final?.beatsCompleted, 1);
    assert.equal(settledJobState, "completed", "the host must acknowledge the durable job before assertions");

    // durable job 行落 completed（lease fencing 收束）。
    const jobRows = await ownerPool.query<{
      id: string;
      state: string;
      attempt_count: number;
      job_kind: string;
    }>(
      `SELECT id, state, attempt_count, job_kind FROM realm_durable_jobs
       WHERE workspace_id = $1 ORDER BY id`,
      [LOCAL_RECORD_SCOPE.workspaceId],
    );
    assert.deepEqual(
      jobRows.rows.map((row) => [row.id, row.job_kind, row.state, Number(row.attempt_count)]),
      [[`self-play-beat:${session.id}:1`, "self-play-beat", "completed", 1]],
    );

    // 拍事件真实落库并带 selfPlay 标记。
    const selfPlayEvents = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND record_id = $2
         AND payload->'selfPlay' IS NOT NULL`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    assert.ok(selfPlayEvents.rows[0]!.n >= 1, "durable beat commits self-play events");

    // completeBeat 拍号 CAS（真实 PG）：重复拍号落账返回 null。
    const counted = await store.completeBeat(session.id, 1);
    assert.equal(counted, null, "终态行/CAS 错位不得重复计拍");

    // host 幂等 stop：释放 advisory lock 与连接池。
    await durableRuntime.stop();
    await durableRuntime.stop();
  },
);
