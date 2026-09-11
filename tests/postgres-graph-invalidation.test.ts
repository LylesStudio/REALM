/**
 * 批次 T11-A2——图谱失效账本 + graph-specific SSE（规范
 * docs/development/T11-A2-GRAPH-SSE-INVALIDATION.md §六）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0024 全链）：
 * 事件 schema/cursor 单调；写事务成功产生事件、回滚不产生事件；
 * Last-Event-ID 重放/去重、跨 world/worldline/workspace 不泄露；
 * W1–W7 逐写路径事件证据；SSE 路由 400/404 与真实流推送/断开清理。
 * 零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { GET as graphEventsGET } from "../app/api/world-knowledge/events/route.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresCanonRepository,
  createPostgresWorldKnowledgeRepository,
  listGraphInvalidationsAfter,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import { appendGraphInvalidation } from "../database/postgres/graph-invalidation.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { createCanonService } from "../modules/worldline/canon.ts";

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
  "0026_canon_security_audience.sql",
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
  "T11-A2: graph invalidation ledger and SSE stream honor scope, replay and write-path coverage",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11a2_${randomUUID().replaceAll("-", "")}`;
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

    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    const canon = createCanonService({
      repository: createPostgresCanonRepository(ownerPool),
      knowledge,
      idFactory: () => randomUUID().replaceAll("-", "").slice(0, 18),
    });
    const ledgerCount = async () => {
      const result = await ownerPool.query(
        `SELECT count(*)::int AS c FROM graph_invalidation_events`,
      );
      return result.rows[0].c as number;
    };
    const ledgerKinds = async () =>
      withWorkspaceTransaction(ownerPool, SCOPE.workspaceId, async (client) => {
        const events = await listGraphInvalidationsAfter(client, SCOPE, 0);
        return events.map((event) => event.kind);
      });

    assert.equal(await ledgerCount(), 0, "种子不应产生失效事件");

    // W1–W4：图谱写路径逐条事件证据。
    const entityId = newId("entity");
    await knowledge.upsertEntity(SCOPE, {
      id: entityId,
      entityKind: "geography",
      name: "失效灯塔",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    const claimId = newId("claim");
    await knowledge.appendClaim(SCOPE, {
      id: claimId,
      subjectEntityId: entityId,
      predicate: "状态",
      objectValue: "点亮",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 0,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const targetId = newId("entity");
    await knowledge.upsertEntity(SCOPE, {
      id: targetId,
      entityKind: "person",
      name: "守灯人",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    await knowledge.projectRelation(SCOPE, {
      claimId,
      objectEntityId: targetId,
      relationId: newId("rel"),
    });
    await knowledge.createArticle(SCOPE, {
      id: newId("article"),
      title: "灯史",
      body: "……",
      claimIds: [claimId],
      sourceEventIds: [],
    });
    // W5–W7：canon 写路径（story 层级门禁实读：scope=story 的 Claim 可提案）。
    const proposal = await canon.propose({
      scope: SCOPE,
      targetLevel: "story",
      claimIds: [claimId],
      rationale: "升格灯塔状态",
      proposedBy: "dm",
    });
    assert.ok(proposal, "story 级 Claim 应产生提案");
    const rejected = await canon.propose({
      scope: SCOPE,
      targetLevel: "story",
      claimIds: [claimId],
      rationale: "将被拒绝",
      proposedBy: "dm",
    });
    await canon.decide({
      scope: SCOPE,
      proposalId: rejected!.id,
      decision: "reject",
      decidedBy: "user",
    });
    await canon.decide({
      scope: SCOPE,
      proposalId: proposal!.id,
      decision: "merge",
      decidedBy: "user",
    });

    const kinds = await ledgerKinds();
    assert.deepEqual(kinds, [
      "entity",
      "claim",
      "entity",
      "relation",
      "article",
      "canon_proposal",
      "canon_proposal",
      "canon_decision",
      "canon_merge",
    ]);

    // schema/cursor：单调递增且事件字段白名单（无实体/Claim 内容）。
    const events = await withWorkspaceTransaction(
      ownerPool,
      SCOPE.workspaceId,
      async (client) => listGraphInvalidationsAfter(client, SCOPE, 0),
      { readOnly: true },
    );
    const cursors = events.map((event) => event.cursor);
    assert.deepEqual(
      cursors,
      [...cursors].sort((left, right) => left - right),
      "cursor 必须单调",
    );
    for (const event of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        ["createdAt", "cursor", "id", "kind", "reason", "worldId", "worldlineId"].sort(),
      );
    }

    // 重放：after=中间 cursor 只返回其后事件（去重语义由 cursor 比较保证）。
    const midpoint = cursors[4];
    const replayed = await withWorkspaceTransaction(
      ownerPool,
      SCOPE.workspaceId,
      async (client) => listGraphInvalidationsAfter(client, SCOPE, midpoint),
      { readOnly: true },
    );
    assert.deepEqual(
      replayed.map((event) => event.cursor),
      cursors.slice(5),
    );

    // 回滚不产生事件（F1）：savepoint 组合内写实体 + 失效记录后回滚。
    const before = await ledgerCount();
    const manual = await ownerPool.connect();
    try {
      await manual.query("BEGIN");
      await withWorkspaceTransaction(manual, SCOPE.workspaceId, async (client) => {
        await client.query(
          `INSERT INTO world_entities (
             workspace_id, world_id, worldline_id, id, entity_kind, name
           ) VALUES ($1, $2, $3, $4, 'other', '回滚幻影')`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, newId("entity")],
        );
        await appendGraphInvalidation(client, SCOPE, "entity", "rollback-test");
        throw new Error("force rollback");
      }).catch(() => undefined);
      await manual.query("COMMIT");
    } finally {
      manual.release();
    }
    assert.equal(await ledgerCount(), before, "回滚后账本不得新增事件");

    // 跨作用域隔离（F2）：异世界/异世界线记录不进本作用域重放。
    await withWorkspaceTransaction(ownerPool, SCOPE.workspaceId, async (client) => {
      await appendGraphInvalidation(
        client,
        { ...SCOPE, worldId: "world_elsewhere" },
        "entity",
        "cross-world",
      );
      await appendGraphInvalidation(
        client,
        { ...SCOPE, worldlineId: "worldline_elsewhere" },
        "entity",
        "cross-worldline",
      );
    });
    const scopedOnly = await withWorkspaceTransaction(
      ownerPool,
      SCOPE.workspaceId,
      async (client) => listGraphInvalidationsAfter(client, SCOPE, 0),
      { readOnly: true },
    );
    assert.ok(
      scopedOnly.every(
        (event) => event.worldId === SCOPE.worldId && event.worldlineId === SCOPE.worldlineId,
      ),
      "重放不得包含异世界/世界线事件",
    );

    // 路由参数与成员边界：缺 worldId 400、非法 Last-Event-ID 400、未知世界 404。
    const missingWorldId = await graphEventsGET(
      new Request("http://localhost/api/world-knowledge/events"),
    );
    assert.equal(missingWorldId.status, 400);
    const badCursor = await graphEventsGET(
      new Request(
        `http://localhost/api/world-knowledge/events?worldId=${SCOPE.worldId}`,
        { headers: { "Last-Event-ID": "abc" } },
      ),
    );
    assert.equal(badCursor.status, 400);
    const unknownWorld = await graphEventsGET(
      new Request("http://localhost/api/world-knowledge/events?worldId=world_nope"),
    );
    assert.equal(unknownWorld.status, 404);

    // SSE 端到端：携带 Last-Event-ID=当前最大 cursor（重放为空），
    // 连接后写入 → 活 NOTIFY 推送事件 → abort 清理。
    const maxCursor = cursors[cursors.length - 1];
    const controller = new AbortController();
    const response = await graphEventsGET(
      new Request(
        `http://localhost/api/world-knowledge/events?worldId=${SCOPE.worldId}`,
        {
          headers: { "Last-Event-ID": String(maxCursor) },
          signal: controller.signal,
        },
      ),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const readChunk = async () => {
      const { value } = await reader.read();
      return value ? new TextDecoder().decode(value) : "";
    };
    // 首帧：retry 指令；Last-Event-ID 之后无账本记录，重放为空——
    // 之后到达的事件只能来自活 NOTIFY 路径。
    const first = await Promise.race([
      readChunk(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    assert.match(first, /retry: 5000/);
    assert.doesNotMatch(first, /graph-invalidation/);

    await knowledge.upsertEntity(SCOPE, {
      id: newId("entity"),
      entityKind: "setting",
      name: "流式烽火台",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    let streamed = "";
    const deadline = Date.now() + 5000;
    while (!streamed.includes("event: graph-invalidation") && Date.now() < deadline) {
      streamed += await readChunk();
    }
    assert.match(streamed, /event: graph-invalidation/);
    assert.match(streamed, /id: \d+/);
    assert.match(streamed, /"kind":"entity"/);
    assert.match(streamed, new RegExp(`"worldId":"${SCOPE.worldId}"`));

    // 断开清理：abort 后流终止（reader 结束），listener/client 由路由回收。
    controller.abort();
    const tail = await Promise.race([
      (async () => {
        try {
          await reader.read();
          return "closed-or-eof";
        } catch {
          return "errored";
        }
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    assert.notEqual(tail, "timeout", "abort 后流应终止");
  },
);
