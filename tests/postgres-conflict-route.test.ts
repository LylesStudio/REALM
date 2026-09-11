/**
 * 批次 T10-B2——/api/worldline/conflict causal 分支生产接线
 * （docs/development/T10-B2-CONFLICT-DETECTION.md §四）。
 * 真实临时 PG 库（t.after 拆库，不污染开发库）：legacy 分支零回归；
 * causal 400/404 各态；成员请求从 DB 读事实（life_state 终止 hard 冲突、
 * dependency 依赖冲突、报告含 DB 独有 claim 证明非客户端注入）；全程零写库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { POST } from "../app/api/worldline/conflict/route.ts";
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
  "0024_graph_invalidation_events.sql",
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
  return new Request("http://localhost/api/worldline/conflict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "T10-B2: causal conflict preview reads DB facts under membership scope, legacy branch unchanged",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b2_${randomUUID().replaceAll("-", "")}`;
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

    // legacy 分支零回归（纯游标分类，不触 DB）。
    const legacy = await POST(postJson({
      pastChange: { tick: 100, ordinal: 0 },
      existingFuture: { tick: 200, ordinal: 0 },
    }));
    assert.equal(legacy.status, 200);
    const legacyBody = (await legacy.json()) as {
      conflict: string;
      shouldBranch: boolean;
    };
    assert.equal(typeof legacyBody.conflict, "string");
    assert.equal(typeof legacyBody.shouldBranch, "boolean");

    // F1：causal 缺 worldId → 400。
    const missingWorld = await POST(postJson({
      mode: "causal",
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "terminate",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "dead",
          targetClaimId: "claim_1",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(missingWorld.status, 400);

    // F3：坏 changeSet → 400（terminate 缺 targetClaimId）。
    const badChange = await POST(postJson({
      mode: "causal",
      worldId: "world_ember_coast",
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "terminate",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "dead",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(badChange.status, 400);

    // F2：未知世界 → 404（不泄露存在性）。
    const unknown = await POST(postJson({
      mode: "causal",
      worldId: "world_nope",
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "assert",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "alive",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(unknown.status, 404);

    // 成员世界 + DB 事实：claims/edges 只能来自解析 scope。
    const library = createPostgresLibraryService(ownerPool);
    const scope = { workspaceId: "ws_demo", principalId: "principal_demo_player" };
    await library.create(scope, {
      kind: "world",
      name: "因果校验场",
      era: "编年",
      summary: "检测冲突的世界。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "因果校验场",
    )!;
    const worldScope = {
      workspaceId: scope.workspaceId,
      worldId: world.id,
      worldlineId: world.worldlines[0]!.id,
    };
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    await knowledge.upsertEntity(worldScope, {
      id: "entity_milo",
      entityKind: "person",
      name: "弥洛",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    await knowledge.appendClaim(worldScope, {
      id: "claim_alive",
      subjectEntityId: "entity_milo",
      predicate: "life_state",
      objectValue: "alive",
      scope: "story",
      truthStatus: "story_canon",
      confidence: 1,
      validFromTick: 100,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    // DB 独有的未来行为 Claim（请求体从不携带它——报告出现即证明读库）。
    await knowledge.appendClaim(worldScope, {
      id: "claim_future_deed",
      subjectEntityId: "entity_milo",
      predicate: "performs",
      objectValue: "译出灯塔铭文",
      scope: "story",
      truthStatus: "story_canon",
      confidence: 1,
      validFromTick: 200,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    await knowledge.appendClaim(worldScope, {
      id: "claim_dependent",
      subjectEntityId: "entity_milo",
      predicate: "knows",
      objectValue: "灯塔方位",
      scope: "story",
      truthStatus: "story_canon",
      confidence: 1,
      validFromTick: 200,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    await knowledge.appendCausalEdge(worldScope, {
      id: "edge_enables",
      fromClaimId: "claim_alive",
      toClaimId: "claim_dependent",
      edgeKind: "enables",
    });

    // life_state：过去终止弥洛 → claim_future_deed（DB 独有）冲突，hard。
    const lifeState = await POST(postJson({
      mode: "causal",
      worldId: world.id,
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "terminate",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "dead",
          targetClaimId: "claim_alive",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(lifeState.status, 200);
    const lifeReport = (await lifeState.json()) as {
      mode: string;
      algorithm: string;
      scope: { worldId: string };
      report: {
        deterministic: { conflictingClaimId: string }[];
        classification: { conflict: string; shouldBranch: boolean };
      };
    };
    assert.equal(lifeReport.mode, "causal");
    assert.equal(lifeReport.algorithm, "realm-causal-conflict/v1");
    assert.equal(lifeReport.scope.worldId, world.id);
    assert.ok(
      lifeReport.report.deterministic.some(
        (conflict) => conflict.conflictingClaimId === "claim_future_deed",
      ),
      "report must carry the DB-only future claim (proves server-side facts)",
    );
    assert.equal(lifeReport.report.classification.conflict, "hard");
    assert.equal(lifeReport.report.classification.shouldBranch, true);

    // dependency：supersede 被依赖的 claim_alive → 依赖冲突。
    const dependency = await POST(postJson({
      mode: "causal",
      worldId: world.id,
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "supersede",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "missing",
          targetClaimId: "claim_alive",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(dependency.status, 200);
    const dependencyReport = (await dependency.json()) as {
      report: {
        dependency: { fromClaimId: string; toClaimId: string }[];
      };
    };
    assert.ok(
      dependencyReport.report.dependency.some(
        (conflict) =>
          conflict.fromClaimId === "claim_alive"
          && conflict.toClaimId === "claim_dependent",
      ),
    );

    // 零写库：治理台账前后为空。
    const writes = await ownerPool.query(
      `SELECT (SELECT count(*)::int FROM worldline_merges) AS merges,
              (SELECT count(*)::int FROM canon_proposals) AS proposals`,
    );
    assert.equal(writes.rows[0].merges, 0);
    assert.equal(writes.rows[0].proposals, 0);
  },
);

test("T10-B2: causal database failures return a safe 500", async (t) => {
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

  const response = await POST(postJson({
    mode: "causal",
    worldId: "world_ember_coast",
    existingFuture: { tick: 300, ordinal: 0 },
    changeSet: {
      changes: [{
        kind: "assert",
        subjectEntityId: "entity_milo",
        predicate: "life_state",
        objectValue: "alive",
        effectiveCursor: { tick: 150, ordinal: 0 },
      }],
    },
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: "INTERNAL_ERROR" },
  });
});

/** 批次 T10-B3：console.error 捕获（与 merge 侧同型）。 */
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

test("T10-B3: causal internal DB failure keeps 500 and logs only sanitized fields; bad input stays silent", async (t) => {
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
    // 断库 → 500 不变 + 恰一行脱敏诊断。
    const down = await POST(postJson({
      mode: "causal",
      worldId: "world_ember_coast",
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "terminate",
          subjectEntityId: "entity_milo",
          predicate: "life_state",
          objectValue: "dead",
          targetClaimId: "claim_alive",
          effectiveCursor: { tick: 150, ordinal: 0 },
        }],
      },
    }));
    assert.equal(down.status, 500, "HTTP 契约不变");
    // 输入非法 → 400 照旧，不伪报 internal。
    const bad = await POST(postJson({
      mode: "causal",
      worldId: "world_ember_coast",
      existingFuture: { tick: 300, ordinal: 0 },
      changeSet: { changes: [{ kind: "terminate" }] },
    }));
    assert.equal(bad.status, 400);
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1, "仅断库一次内部诊断（400 不记录）");
  const line = capture.lines[0]!;
  assert.ok(line.startsWith("[realm] route internal failure "));
  const fields = JSON.parse(
    line.slice("[realm] route internal failure ".length),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fields).sort(), ["code", "errorType", "route", "stage"]);
  assert.equal(fields.route, "worldline/conflict");
  assert.equal(fields.stage, "causal-preview");
  for (const forbidden of [
    "postgresql",
    "127.0.0.1",
    "realm_unavailable",
    "connect",
    "entity_milo",
    "claim_alive",
    "life_state",
    " at ",
  ]) {
    assert.ok(!line.includes(forbidden), `log must not contain ${forbidden}`);
  }
});
