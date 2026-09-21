/**
 * 批次 T11-B——semantic review 路由 PG 集成（规范 §六，迁移 0001–0025 全链
 * 临时库，t.after 强制拆库）：high-risk 真实路由产出带作用域列的 evidence
 * （模型可达=source:model / 不可达=fallback，均只写证据不改正式状态）；
 * hard 不调模型零 evidence；404/400 边界；既有 conflict 路由
 * legacy/causal 回归（零写库、响应形态不变）。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { POST as semanticPOST } from "../app/api/worldline/conflict/semantic/route.ts";
import { POST as conflictPOST } from "../app/api/worldline/conflict/route.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

// 新门禁（0051）：runtime DB 存在即要求账户会话；路由请求统一携带。
const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;

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

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
};

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

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

test(
  "T11-B: semantic review route persists scoped evidence and keeps deterministic preview intact",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 60_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11bsr_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
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

    const evidenceRows = async () => {
      const result = await ownerPool.query(
        `SELECT source, model, prompt_version, world_id, worldline_id, request_id
         FROM semantic_conflict_evaluations ORDER BY created_at, id`,
      );
      return result.rows;
    };
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );

    // 1. high-risk（无锚点过去变更）→ 语义复审执行：evidence 落库且作用域
    //    列齐全；source 取决于模型可达性（model 或 fallback 都合法）。
    const highRisk = await semanticPOST(new Request(
      "http://localhost/api/worldline/conflict/semantic",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          worldId: SCOPE.worldId,
          existingFuture: { tick: 5, ordinal: 0 },
          changeSet: {
            changes: [{
              kind: "assert",
              subjectEntityId: "e1",
              predicate: "布局",
              objectValue: "改变",
              effectiveCursor: { tick: 1, ordinal: 0 },
            }],
          },
        }),
      },
    ));
    assert.equal(highRisk.status, 200);
    const highRiskBody = await highRisk.json() as {
      deterministic: { classification: { conflict: string } };
      semantic: { source: string; scope?: { worldId: string }; requestId?: string } | null;
    };
    assert.equal(highRiskBody.deterministic.classification.conflict, "high-risk");
    assert.ok(highRiskBody.semantic, "high-risk 必须产生复审证据");
    assert.ok(["model", "fallback"].includes(highRiskBody.semantic!.source));
    const rowsAfterHighRisk = await evidenceRows();
    assert.equal(rowsAfterHighRisk.length, 1, "evidence 恰一行");
    assert.equal(rowsAfterHighRisk[0].world_id, SCOPE.worldId);
    assert.equal(rowsAfterHighRisk[0].worldline_id, SCOPE.worldlineId);
    assert.match(rowsAfterHighRisk[0].request_id, /^sr_/);
    assert.equal(rowsAfterHighRisk[0].prompt_version, "semantic-conflict-v1");

    // 2. hard（确定性 life_state 冲突）→ 不调模型，零新增 evidence。
    const entityId = newId("entity");
    await knowledge.upsertEntity(SCOPE, {
      id: entityId,
      entityKind: "person",
      name: "复审样本",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    const claimId = newId("claim");
    await knowledge.appendClaim(SCOPE, {
      id: claimId,
      subjectEntityId: entityId,
      predicate: "状态",
      objectValue: "存活",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 5,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const hard = await semanticPOST(new Request(
      "http://localhost/api/worldline/conflict/semantic",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          worldId: SCOPE.worldId,
          existingFuture: { tick: 5, ordinal: 0 },
          changeSet: {
            changes: [{
              kind: "terminate",
              subjectEntityId: entityId,
              predicate: "状态",
              objectValue: "死亡",
              targetClaimId: claimId,
              effectiveCursor: { tick: 1, ordinal: 0 },
            }],
          },
        }),
      },
    ));
    assert.equal(hard.status, 200);
    const hardBody = await hard.json() as { semantic: unknown; deterministic: { classification: { conflict: string } } };
    assert.equal(hardBody.deterministic.classification.conflict, "hard");
    assert.equal(hardBody.semantic, null, "hard 不调模型");
    assert.equal((await evidenceRows()).length, 1, "hard 不产生新 evidence");

    // 3. 边界：未知世界 404、缺 worldId 400。
    const notFound = await semanticPOST(new Request(
      "http://localhost/api/worldline/conflict/semantic",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          worldId: "world_nope",
          existingFuture: { tick: 5, ordinal: 0 },
          changeSet: { changes: [{ kind: "assert", subjectEntityId: "e", predicate: "p", objectValue: "v", effectiveCursor: { tick: 1, ordinal: 0 } }] },
        }),
      },
    ));
    assert.equal(notFound.status, 404);
    const missingWorldId = await semanticPOST(new Request(
      "http://localhost/api/worldline/conflict/semantic",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ existingFuture: { tick: 5, ordinal: 0 }, changeSet: { changes: [{ kind: "assert", subjectEntityId: "e", predicate: "p", objectValue: "v", effectiveCursor: { tick: 1, ordinal: 0 } }] } }),
      },
    ));
    assert.equal(missingWorldId.status, 400);

    // 4. 既有 conflict 路由回归：legacy 与 causal 形态不变、零写库、
    //    零 evidence、零模型调用。
    const claimsBefore = await ownerPool.query(
      `SELECT count(*)::int AS c FROM world_claims`,
    );
    const legacy = await conflictPOST(new Request(
      "http://localhost/api/worldline/conflict",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          pastChange: { tick: 1, ordinal: 0 },
          existingFuture: { tick: 5, ordinal: 0 },
        }),
      },
    ));
    assert.equal(legacy.status, 200);
    const legacyBody = await legacy.json() as { conflict: string; shouldBranch: boolean };
    assert.equal(typeof legacyBody.conflict, "string");
    assert.equal(typeof legacyBody.shouldBranch, "boolean");

    const causal = await conflictPOST(new Request(
      "http://localhost/api/worldline/conflict",
      {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "causal",
          worldId: SCOPE.worldId,
          existingFuture: { tick: 5, ordinal: 0 },
          changeSet: {
            changes: [{
              kind: "assert",
              subjectEntityId: "e1",
              predicate: "布局",
              objectValue: "改变",
              effectiveCursor: { tick: 1, ordinal: 0 },
            }],
          },
        }),
      },
    ));
    assert.equal(causal.status, 200);
    const causalBody = await causal.json() as { mode: string; report: unknown };
    assert.equal(causalBody.mode, "causal");
    assert.ok(causalBody.report, "causal 报告形态不变");
    assert.equal((await evidenceRows()).length, 1, "既有路由不产生 evidence");
    const claimsAfter = await ownerPool.query(
      `SELECT count(*)::int AS c FROM world_claims`,
    );
    assert.equal(claimsAfter.rows[0].c, claimsBefore.rows[0].c, "既有路由零写库");
  },
);
