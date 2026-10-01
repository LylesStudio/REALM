/**
 * P1-1 PG 运行证明：preview 授权路径不扫描全量事件。
 * scratch 库全链迁移 + demo seed；用计数代理连接池断言
 * authorizeRecordViewer 的 SQL 不含 events 表读取，非成员 fail-closed。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { handlePreviewGet } from "../app/api/record/preview/route.ts";
import {
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalPreviewHub,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "restricted preview uses META authorization, principal-bound PG identity, and audience-filtered HTTP SSE",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const runtimeUrl = requireLoopbackUrl(runtimeConnectionString!);
    const databaseName = `realm_prev_auth_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
    t.after(async () => {
      await runtimePool.end();
      await pool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await pool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(pool);

    const bystanderPrincipalId = "principal_preview_bystander";
    const recordWorld = await pool.query<{ world_id: string }>(
      `SELECT world_id FROM records WHERE workspace_id = $1 AND id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    assert.ok(recordWorld.rows[0]?.world_id, "demo Record must exist in scratch DB");
    await pool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, $3, 'player')`,
      [LOCAL_RECORD_SCOPE.workspaceId, recordWorld.rows[0].world_id, bystanderPrincipalId],
    );
    const bystanderSeat = await pool.query<{
      id: string;
      character_instance_id: string;
    }>(
      `SELECT id, character_instance_id
       FROM participants
       WHERE workspace_id = $1 AND record_id = $2
         AND principal_id IS NULL AND participant_kind = 'character'
         AND controller_mode = 'ai' AND is_active = true
       ORDER BY speaking_order DESC, id ASC
       LIMIT 1`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    assert.ok(bystanderSeat.rows[0], "demo Record must have an unbound active character seat");
    await pool.query(
      `UPDATE participants
       SET principal_id = $1, controller_mode = 'human', updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $2 AND record_id = $3 AND id = $4`,
      [
        bystanderPrincipalId,
        LOCAL_RECORD_SCOPE.workspaceId,
        LOCAL_RECORD_SCOPE.recordId,
        bystanderSeat.rows[0].id,
      ],
    );

    // 计数代理：记录每条 SQL 是否命中 events 表。
    const sqlLog: string[] = [];
    const countingPool = new Proxy(runtimePool, {
      get(target, prop) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(clientTarget, clientProp) {
                if (clientProp === "query") {
                  return (sql: string, params?: unknown[]) => {
                    sqlLog.push(sql);
                    return clientTarget.query(sql, params);
                  };
                }
                const value = clientTarget[clientProp as keyof pg.PoolClient];
                return typeof value === "function"
                  ? (value as (...args: unknown[]) => unknown).bind(clientTarget)
                  : value;
              },
            });
          };
        }
        return target[prop as keyof pg.Pool];
      },
    });

    const previewHub = createLocalPreviewHub();
    const service = createLocalRecordService({
      repository: createInMemoryRuntimeRepository({
        recordHeads: [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }],
      }),
      projection: createPostgresDeliveryProjectionRepository(countingPool),
      tokens: createMemoryWriteTokenRegistry(),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(countingPool),
      previewHub,
    });

    // 成员授权：通过；SQL 中不得出现 EVENTS_SQL 全量事件读取形态
    //（events AS event + visibility_policies JOIN；META_SQL 的
    // empty_retro_event 元数据子查询是合法且必要的）。
    sqlLog.length = 0;
    const viewerCharacterInstanceId = await service.authorizeRecordViewer(
      LOCAL_RECORD_SCOPE.recordId,
      LOCAL_RECORD_SCOPE.principalId,
    );
    assert.ok(viewerCharacterInstanceId, "real DB scope must bind the authenticated principal to a viewer character");
    const isFullEventsScan = (sql: string) =>
      /from\s+events\s+as\s+event\b/i.test(sql)
      && /join\s+visibility_policies\b/i.test(sql);
    const eventReads = sqlLog.filter(isFullEventsScan);
    assert.deepEqual(
      eventReads,
      [],
      `preview 授权不得执行 EVENTS_SQL 全量读取（命中 ${eventReads.length} 条）`,
    );
    assert.ok(sqlLog.length > 0, "授权应有实际 SQL 证据（非空跑）");

    // 非成员：安全 404（同样不执行全量事件读取）。
    sqlLog.length = 0;
    await assert.rejects(
      service.authorizeRecordViewer(LOCAL_RECORD_SCOPE.recordId, "principal_stranger"),
      (error: unknown) =>
        error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
    );
    assert.deepEqual(sqlLog.filter(isFullEventsScan), []);

    const bystanderViewerCharacterInstanceId = await service.authorizeRecordViewer(
      LOCAL_RECORD_SCOPE.recordId,
      bystanderPrincipalId,
    );
    assert.equal(
      bystanderViewerCharacterInstanceId,
      bystanderSeat.rows[0].character_instance_id,
      "viewer identity must come from the matching principal-bound participant row",
    );
    assert.notEqual(bystanderViewerCharacterInstanceId, viewerCharacterInstanceId);
    assert.deepEqual(sqlLog.filter(isFullEventsScan), []);

    const audienceController = new AbortController();
    const bystanderController = new AbortController();
    let audienceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bystanderReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      sqlLog.length = 0;
      const anonymousResponse = await handlePreviewGet(
        new Request(
          `http://localhost/api/record/preview?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
        ),
        service,
      );
      assert.equal(anonymousResponse.status, 401);
      assert.equal(sqlLog.length, 0, "unauthenticated request must fail before touching PostgreSQL");

      const audienceResponse = await handlePreviewGet(
        new Request(
          `http://localhost/api/record/preview?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
          {
            headers: {
              cookie: `realm_session=${createSessionValue(LOCAL_RECORD_SCOPE.principalId)}`,
            },
            signal: audienceController.signal,
          },
        ),
        service,
      );
      const bystanderResponse = await handlePreviewGet(
        new Request(
          `http://localhost/api/record/preview?recordId=${LOCAL_RECORD_SCOPE.recordId}`
            + `&principalId=${LOCAL_RECORD_SCOPE.principalId}`
            + `&viewerCharacterInstanceId=${viewerCharacterInstanceId}`,
          {
            headers: {
              cookie: `realm_session=${createSessionValue(bystanderPrincipalId)}`,
            },
            signal: bystanderController.signal,
          },
        ),
        service,
      );
      assert.equal(audienceResponse.status, 200);
      assert.equal(bystanderResponse.status, 200);
      audienceReader = audienceResponse.body!.getReader();
      bystanderReader = bystanderResponse.body!.getReader();

      const deniedResponse = await handlePreviewGet(
        new Request(
          `http://localhost/api/record/preview?recordId=${LOCAL_RECORD_SCOPE.recordId}`,
          {
            headers: {
              cookie: `realm_session=${createSessionValue("principal_preview_stranger")}`,
            },
          },
        ),
        service,
      );
      assert.equal(deniedResponse.status, 404);
      assert.notEqual(
        deniedResponse.headers.get("content-type"),
        "text/event-stream; charset=utf-8",
      );

      previewHub.begin(
        LOCAL_RECORD_SCOPE.recordId,
        "preview_pg_cross_identity",
        new AbortController().signal,
        {
          kind: "restricted",
          domainId: "pair:preview-authorization-test",
          audienceCharacterInstanceIds: [viewerCharacterInstanceId!],
        },
      );
      previewHub.publishChunk(
        LOCAL_RECORD_SCOPE.recordId,
        "旁白",
        "PG restricted chunk must stay private",
      );
      previewHub.end(LOCAL_RECORD_SCOPE.recordId, "committed");

      const decoder = new TextDecoder();
      const audienceChunk = decoder.decode((await audienceReader.read()).value);
      const audienceEnd = decoder.decode((await audienceReader.read()).value);
      assert.match(audienceChunk, /event: preview\n/);
      assert.match(audienceChunk, /PG restricted chunk must stay private/);
      assert.match(audienceEnd, /event: preview-end\n/);
      assert.match(audienceEnd, /"outcome":"committed"/);

      const bystanderRead = await Promise.race([
        bystanderReader.read().then(({ done, value }) =>
          done ? "closed" : decoder.decode(value),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("no-event"), 100)),
      ]);
      assert.equal(
        bystanderRead,
        "no-event",
        "non-audience must receive neither restricted chunk nor end metadata, even with spoofed query identity",
      );
      assert.deepEqual(sqlLog.filter(isFullEventsScan), []);
    } finally {
      audienceController.abort();
      bystanderController.abort();
      await audienceReader?.cancel().catch(() => {});
      await bystanderReader?.cancel().catch(() => {});
    }
  },
);
