/**
 * 批次 T10-B1——/api/worldline/merge 路由作用域与审计主体修复
 * （docs/development/T10-B1-GOVERNANCE-REACHABILITY.md §四）。
 * 真实临时 PG 库（t.after 拆库，不污染开发库）：缺失 worldId 400、未知世界
 * 404、成员 dryRun/merge 走解析 scope、请求体 operator 不得冒充审计主体、
 * source 世界线不存在 404、幂等重放同 mergeId。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo } from "../database/postgres/public.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { POST } from "../app/api/worldline/merge/route.ts";
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

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/worldline/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "T10-B1: merge route enforces explicit world scope and authenticated operator",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b1_${randomUUID().replaceAll("-", "")}`;
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
    // 路由级调用走本地回落身份（principal_demo_player）；摘除门禁，用后还原。
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

    // F1：缺失 worldId → 400。
    const missing = await POST(postJson({
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b1-missing",
    }));
    assert.equal(missing.status, 400);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "INVALID_REQUEST",
    );

    // F2：世界不存在 → 404（不泄露存在性）。
    const unknown = await POST(postJson({
      worldId: "world_nope",
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b1-unknown",
    }));
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await unknown.json()) as { error: { code: string } }).error.code,
      "WORLD_NOT_FOUND",
    );

    // 成员世界：新建世界 + 分支世界线（demo principal 是 owner）。
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: "ws_demo",
      principalId: "principal_demo_player",
    };
    await library.create(scope, {
      kind: "world",
      name: "合并试验场",
      era: "并流纪元",
      summary: "两条世界线在此汇合。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "合并试验场",
    )!;
    await library.create(scope, {
      kind: "branch",
      worldId: world.id,
      label: "岔流",
    });
    const worldlines = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!.worldlines;
    assert.equal(worldlines.length, 2);
    const [origin, branch] = worldlines;

    // dryRun 预览：200 preview，不落审计行。
    const dryRun = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-dry",
      dryRun: true,
      operator: "forged-admin",
    }));
    assert.equal(dryRun.status, 200);
    assert.equal(
      ((await dryRun.json()) as { status: string }).status,
      "preview",
    );
    let audit = await ownerPool.query(
      `SELECT count(*)::int AS count FROM worldline_merges WHERE idempotency_key = 't10b1-dry'`,
    );
    assert.equal(audit.rows[0].count, 0, "dryRun never persists an audit row");

    // 真实合并：审计行 operator = 已解析 principal，请求体 operator 被忽略。
    const merged = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-merge",
      operator: "forged-admin",
    }));
    assert.equal(merged.status, 200);
    const mergedBody = (await merged.json()) as {
      status: string;
      mergeId: string;
    };
    assert.equal(mergedBody.status, "merged");
    audit = await ownerPool.query(
      `SELECT operator, world_id FROM worldline_merges WHERE idempotency_key = 't10b1-merge'`,
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(
      audit.rows[0].operator,
      "principal_demo_player",
      "audit operator must be the resolved principal, never the request body",
    );
    assert.equal(audit.rows[0].world_id, world.id, "解析 scope 的世界");

    // F5：幂等重放同 mergeId。
    const replay = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: branch!.id,
      idempotencyKey: "t10b1-merge",
    }));
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { mergeId: string }).mergeId,
      mergedBody.mergeId,
    );

    // F3：source 世界线不存在 → 404 WORLDLINE_NOT_FOUND。
    const missingSource = await POST(postJson({
      worldId: world.id,
      sourceA: origin!.id,
      sourceB: "worldline_nope",
      idempotencyKey: "t10b1-missing-source",
    }));
    assert.equal(missingSource.status, 404);
    assert.equal(
      ((await missingSource.json()) as { error: { code: string } }).error.code,
      "WORLDLINE_NOT_FOUND",
    );
  },
);

/** 批次 T10-B3：console.error 捕获（只进不出敏感材料的断言载体）。 */
function captureConsoleError() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function assertSanitizedInternalLog(line: string, route: string, stage: string) {
  assert.ok(
    line.startsWith("[realm] route internal failure "),
    `log must carry the stable prefix, got: ${line}`,
  );
  const fields = JSON.parse(
    line.slice("[realm] route internal failure ".length),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fields).sort(), ["code", "errorType", "route", "stage"]);
  assert.equal(fields.route, route);
  assert.equal(fields.stage, stage);
  // 严禁字段：连接串/库名/message/stack/请求内容。
  for (const forbidden of [
    "postgresql",
    "127.0.0.1",
    "realm_unavailable",
    "connect",
    "forged",
    "claim_",
    "sourceA",
    " at ",
  ]) {
    assert.ok(!line.includes(forbidden), `log must not contain ${forbidden}`);
  }
}

test("T10-B3: merge internal DB failure keeps 500 and logs only sanitized fields", async (t) => {
  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
  process.env.REALM_RUNTIME_DATABASE_URL =
    "postgresql://realm_runtime@127.0.0.1:1/realm_unavailable";
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
  });

  const capture = captureConsoleError();
  try {
    const response = await POST(postJson({
      worldId: "world_ember_coast",
      sourceA: "worldline_origin",
      sourceB: "worldline_origin",
      idempotencyKey: "t10b3-merge-down",
      operator: "forged-admin",
    }));
    assert.equal(response.status, 500, "HTTP 契约不变");
    assert.deepEqual(
      ((await response.json()) as { error: { code: string } }).error.code,
      "INTERNAL_ERROR",
    );
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1, "恰一行内部诊断");
  assertSanitizedInternalLog(capture.lines[0]!, "worldline/merge", "request");
});
