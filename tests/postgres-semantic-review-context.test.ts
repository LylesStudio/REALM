/**
 * 批次 T11-D——semantic review context route
 * （public documentation §3.1）。
 * 真实临时 PG 库（迁移 0001–0025 全链，t.after 强制拆库，零开发库污染）：
 * 无 principal 401；无 runtime 503 LOCAL_RUNTIME_NOT_INITIALIZED；
 * 未知/非成员世界 404 WORLD_NOT_FOUND；成功只返回 ok/scope/existingFuture
 * （existingFuture 来自 worldlines.head_tick/head_ordinal，客户端不可注入）；
 * 全程只读零写库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { GET as contextGET } from "../app/api/worldline/conflict/semantic/context/route.ts";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
];

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

function getContext(worldId: string): Request {
  return new Request(
    `http://localhost/api/worldline/conflict/semantic/context?worldId=${encodeURIComponent(worldId)}`,
  );
}

test(
  "T11-D: semantic review context route gates principal/runtime/membership and returns the head cursor read-only",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 60_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11dctx_${randomUUID().replaceAll("-", "")}`;
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

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    delete process.env.REALM_ACCESS_TOKEN;

    t.after(async () => {
      await endSharedRuntimePools();
      if (previousAccessToken === undefined) {
        delete process.env.REALM_ACCESS_TOKEN;
      } else {
        process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      }
      if (previousRuntimeUrl === undefined) {
        delete process.env.REALM_RUNTIME_DATABASE_URL;
      } else {
        process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      }
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    // 1. 门禁开启且无会话 → 401（无 principal）。
    process.env.REALM_ACCESS_TOKEN = "t11d-context-gate-token";
    const unauthorized = await contextGET(getContext(POSTGRES_DEMO_IDS.world));
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody = await unauthorized.json() as { ok: boolean; error: { code: string } };
    assert.equal(unauthorizedBody.ok, false);
    assert.equal(unauthorizedBody.error.code, "UNAUTHORIZED");
    delete process.env.REALM_ACCESS_TOKEN;

    // 2. 缺 runtime → 503 LOCAL_RUNTIME_NOT_INITIALIZED。
    const savedRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    delete process.env.REALM_RUNTIME_DATABASE_URL;
    const noRuntime = await contextGET(getContext(POSTGRES_DEMO_IDS.world));
    process.env.REALM_RUNTIME_DATABASE_URL = savedRuntimeUrl;
    assert.equal(noRuntime.status, 503);
    const noRuntimeBody = await noRuntime.json() as { ok: boolean; error: { code: string } };
    assert.equal(noRuntimeBody.error.code, "LOCAL_RUNTIME_NOT_INITIALIZED");

    // 3. 未知世界 → 404 WORLD_NOT_FOUND（不泄露存在性）。
    const unknown = await contextGET(getContext("world_nope"));
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.json() as { ok: boolean; error: { code: string } };
    assert.equal(unknownBody.error.code, "WORLD_NOT_FOUND");

    // 4. 非成员世界 → 404（world/worldline 存在但无当前 principal 成员行）。
    const outsiderWorldId = `world_outsider_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const outsiderWorldlineId = `wl_outsider_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id)
       VALUES ($1, $2, $3, 'native')`,
      [POSTGRES_DEMO_IDS.workspace, outsiderWorldId, "局外世界"],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label)
       VALUES ($1, $2, $3, '原初')`,
      [POSTGRES_DEMO_IDS.workspace, outsiderWorldId, outsiderWorldlineId],
    );
    const outsider = await contextGET(getContext(outsiderWorldId));
    assert.equal(outsider.status, 404);
    const outsiderBody = await outsider.json() as { ok: boolean; error: { code: string } };
    assert.equal(outsiderBody.error.code, "WORLD_NOT_FOUND");

    // 5. 成功：existingFuture 来自服务端 worldlines head 游标，scope 只含
    //    worldId/worldlineId，响应不携带任何内部字段。
    const head = await ownerPool.query<{
      id: string;
      head_tick: string;
      head_ordinal: string;
    }>(
      `SELECT id, head_tick, head_ordinal FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.world],
    );
    const headRow = head.rows[0]!;
    await ownerPool.query(
      `UPDATE worldlines SET head_tick = $1 WHERE workspace_id = $2 AND id = $3`,
      ["9007199254740992", POSTGRES_DEMO_IDS.workspace, headRow.id],
    );
    const unsafeHead = await contextGET(getContext(POSTGRES_DEMO_IDS.world));
    assert.equal(unsafeHead.status, 500, "unsafe bigint head must fail closed");
    await ownerPool.query(
      `UPDATE worldlines SET head_tick = $1 WHERE workspace_id = $2 AND id = $3`,
      [headRow.head_tick, POSTGRES_DEMO_IDS.workspace, headRow.id],
    );
    const ok = await contextGET(getContext(POSTGRES_DEMO_IDS.world));
    assert.equal(ok.status, 200);
    const okBody = await ok.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(okBody).sort(), ["existingFuture", "ok", "scope"]);
    assert.equal(okBody.ok, true);
    assert.deepEqual(okBody.scope, {
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: headRow.id,
    });
    assert.deepEqual(okBody.existingFuture, {
      tick: Number(headRow.head_tick),
      ordinal: Number(headRow.head_ordinal),
      calendarId: "native",
      display: "",
    });

    // 6. 只读：零 evidence、零治理写入。
    const writes = await ownerPool.query(
      `SELECT (SELECT count(*)::int FROM semantic_conflict_evaluations) AS evidence,
              (SELECT count(*)::int FROM canon_proposals) AS proposals,
              (SELECT count(*)::int FROM worldline_merges) AS merges`,
    );
    assert.equal(writes.rows[0].evidence, 0, "context 读取不写 evidence");
    assert.equal(writes.rows[0].proposals, 0);
    assert.equal(writes.rows[0].merges, 0);
  },
);
