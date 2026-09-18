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
import {
  createPostgresDeliveryProjectionRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "preview authorization reads META only (no full events scan)",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_prev_auth_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    t.after(async () => {
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

    // 计数代理：记录每条 SQL 是否命中 events 表。
    const sqlLog: string[] = [];
    const countingPool = new Proxy(pool, {
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

    const service = createLocalRecordService({
      repository: createInMemoryRuntimeRepository({
        recordHeads: [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }],
      }),
      projection: createPostgresDeliveryProjectionRepository(countingPool),
      tokens: createMemoryWriteTokenRegistry(),
    });

    // 成员授权：通过；SQL 中不得出现 EVENTS_SQL 全量事件读取形态
    //（events AS event + visibility_policies JOIN；META_SQL 的
    // empty_retro_event 元数据子查询是合法且必要的）。
    sqlLog.length = 0;
    await service.authorizeRecordViewer(
      LOCAL_RECORD_SCOPE.recordId,
      LOCAL_RECORD_SCOPE.principalId,
    );
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
  },
);
