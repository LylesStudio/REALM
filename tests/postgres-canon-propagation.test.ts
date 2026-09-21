/**
 * 批次 T11-B——Canon merge 原子传播入队（规范
 * docs/development/T11-B-PROPAGATION-ENABLEMENT-IMPLEMENTATION.md §四）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0025 全链 + demo 拓扑种子）：
 * merge+propagate:"public" 同事务产生恰一个 Campaign/root Packet/pending
 * job；拓扑缺失整事务回滚零残留；reject/无 attest/空晋升不创建；重复
 * merge 409 不重复；未知世界 404。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { POST as canonPOST } from "../app/api/canon/route.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
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

function canonRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/canon", {
    method: "POST",
    headers: { cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "T11-B: canon merge atomically enqueues propagation only with explicit public attestation",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11b_${randomUUID().replaceAll("-", "")}`;
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
    await seedPostgresDemoPropagationTopology(ownerPool);

    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    const propagationCounts = async () => {
      const [campaigns, packets, jobs] = await Promise.all([
        ownerPool.query(`SELECT count(*)::int AS c FROM information_campaigns`),
        ownerPool.query(`SELECT count(*)::int AS c FROM information_packets`),
        ownerPool.query(`SELECT count(*)::int AS c FROM propagation_jobs`),
      ]);
      return {
        campaigns: campaigns.rows[0].c as number,
        packets: packets.rows[0].c as number,
        jobs: jobs.rows[0].c as number,
      };
    };
    /** 建一个可合并提案：实体 + record_confirmed Claim + story 级提案。 */
    const seedProposal = async (marker: string, truthStatus = "record_confirmed") => {
      const entityId = newId("entity");
      await knowledge.upsertEntity(SCOPE, {
        id: entityId,
        entityKind: "setting",
        name: `传播样本${marker}`,
        summary: "",
        validFromTick: 0,
        validToTick: null,
      });
      const claimId = newId("claim");
      await knowledge.appendClaim(SCOPE, {
        id: claimId,
        subjectEntityId: entityId,
        predicate: "状态",
        objectValue: marker,
        scope: "story",
        truthStatus: truthStatus as never,
        confidence: 1,
        validFromTick: 0,
        validToTick: null,
        sourceRecordId: null,
        sourceEventId: null,
        supersedesClaimId: null,
      });
      const propose = await canonPOST(canonRequest({
        action: "propose",
        worldId: SCOPE.worldId,
        targetLevel: "story",
        claimIds: [claimId],
        rationale: `提案${marker}`,
      }));
      assert.equal(propose.status, 201);
      const proposeBody = await propose.json() as { proposal: { id: string } };
      return proposeBody.proposal.id;
    };

    // 1. merge + propagate:"public" → 同事务恰一个 Campaign/root Packet/pending job。
    const proposalId = await seedProposal("甲");
    const merge = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId,
      decision: "merge",
      decidedBy: "user",
      propagate: "public",
    }));
    assert.equal(merge.status, 200);
    const mergeBody = await merge.json() as {
      proposal: { status: string };
    };
    assert.equal(mergeBody.proposal.status, "merged");
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    const campaign = await ownerPool.query(
      `SELECT id, canon_revision_id, security_class, algorithm_version
       FROM information_campaigns`,
    );
    const revisionId = campaign.rows[0].canon_revision_id as string;
    assert.equal(
      campaign.rows[0].id,
      `campaign_canon_${revisionId}`,
      "Campaign 身份必须由 revision 确定性派生",
    );
    assert.equal(campaign.rows[0].security_class, "public");
    assert.equal(campaign.rows[0].algorithm_version, "realm-propagate-v1");
    const packet = await ownerPool.query(
      `SELECT id, campaign_id, channel, parent_packet_id FROM information_packets`,
    );
    assert.equal(packet.rows[0].id, `packet_campaign_canon_${revisionId}_root`);
    assert.equal(packet.rows[0].channel, "official_bulletin");
    const job = await ownerPool.query(
      `SELECT id, status, input FROM propagation_jobs`,
    );
    assert.equal(job.rows[0].id, `job_campaign_canon_${revisionId}`);
    assert.equal(job.rows[0].status, "pending");
    const jobInput = job.rows[0].input as {
      nodes: unknown[]; routes: unknown[]; topologyVersion: string;
    };
    assert.equal(jobInput.nodes.length, 3, "拓扑快照物化进 job input");
    assert.equal(jobInput.routes.length, 2);
    assert.match(jobInput.topologyVersion, /^pt_[0-9a-f]{24}$/);

    // 2. 重放同一 merge：proposal 非 pending → 409，零新增（幂等闸门）。
    const replay = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId,
      decision: "merge",
      decidedBy: "user",
      propagate: "public",
    }));
    assert.equal(replay.status, 409);
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 3. 拓扑缺失（canon_origin 停用）→ 整个 merge 回滚：提案仍 pending、
    //    零 promoted Claim、零 Campaign/Packet/Job。
    await ownerPool.query(
      `UPDATE propagation_nodes SET active = FALSE WHERE node_key = 'canon_origin'`,
    );
    const brokenId = await seedProposal("乙");
    const claimsBefore = await ownerPool.query(
      `SELECT count(*)::int AS c FROM world_claims`,
    );
    const brokenMerge = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId: brokenId,
      decision: "merge",
      decidedBy: "user",
      propagate: "public",
    }));
    assert.equal(brokenMerge.status, 409);
    const brokenBody = await brokenMerge.json() as { error: { code: string } };
    assert.equal(brokenBody.error.code, "TOPOLOGY_ORIGIN_MISSING");
    const brokenProposal = await ownerPool.query(
      `SELECT status FROM canon_proposals WHERE id = $1`,
      [brokenId],
    );
    assert.equal(brokenProposal.rows[0].status, "pending", "回滚后提案必须仍 pending");
    const claimsAfter = await ownerPool.query(
      `SELECT count(*)::int AS c FROM world_claims`,
    );
    assert.equal(claimsAfter.rows[0].c, claimsBefore.rows[0].c, "回滚零 promoted Claim");
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });
    await ownerPool.query(
      `UPDATE propagation_nodes SET active = TRUE WHERE node_key = 'canon_origin'`,
    );

    // 4. 无 attest 的 merge：Canon 成立，零传播任务。
    const plainId = await seedProposal("丙");
    const plainMerge = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId: plainId,
      decision: "merge",
      decidedBy: "user",
    }));
    assert.equal(plainMerge.status, 200);
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 5. reject + propagate 字段也不触发。
    const rejectedId = await seedProposal("丁");
    const reject = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId: rejectedId,
      decision: "reject",
      decidedBy: "user",
      propagate: "public",
    }));
    assert.equal(reject.status, 200);
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 6. 空晋升（Claim 已是 story_canon）+ attest：merge 成功但不创建空 Campaign。
    const emptyId = await seedProposal("戊", "story_canon");
    const emptyMerge = await canonPOST(canonRequest({
      action: "decide",
      worldId: SCOPE.worldId,
      proposalId: emptyId,
      decision: "merge",
      decidedBy: "user",
      propagate: "public",
    }));
    assert.equal(emptyMerge.status, 200);
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 7. 未知世界 404（不泄露存在性）。
    const unknown = await canonPOST(canonRequest({
      action: "decide",
      worldId: "world_nope",
      proposalId: "canon_nope",
      decision: "merge",
      propagate: "public",
    }));
    assert.equal(unknown.status, 404);
  },
);
