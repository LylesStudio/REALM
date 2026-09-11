import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresCanonRepository,
  createPostgresPropagationRepository,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { createCanonService } from "../modules/worldline/canon.ts";
import {
  propagate,
  type InformationPacket,
} from "../modules/propagation/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_m5_test_${randomUUID().replaceAll("-", "")}`;
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

  for (const filename of [
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
    "0024_graph_invalidation_events.sql",
    "0026_canon_security_audience.sql",
  ]) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await owner.query(sql);
  }
  await seedPostgresDemo(ownerPool);
  return ownerPool;
}

test(
  "knowledge graph links entities, claims, relations and articles",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );

    await knowledge.upsertEntity(SCOPE, {
      id: "entity_bell",
      entityKind: "setting",
      name: "无声钟",
      summary: "停战后沉寂十七年的海钟。",
      validFromTick: 0,
      validToTick: null,
    });
    await knowledge.upsertEntity(SCOPE, {
      id: "entity_milo",
      entityKind: "person",
      name: "弥洛",
      summary: "魔族铭文学者。",
      validFromTick: 0,
      validToTick: null,
    });
    await knowledge.appendClaim(SCOPE, {
      id: "claim_bell_rang",
      subjectEntityId: "entity_bell",
      predicate: "响了",
      objectValue: "雾月12日夜三声",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 100,
      validToTick: null,
      sourceRecordId: "record_first_watch",
      sourceEventId: "event_opening",
      supersedesClaimId: null,
    });
    const promoted = await knowledge.promoteClaim(
      SCOPE,
      "claim_bell_rang",
      "story_canon",
      "claim_bell_rang_v2",
    );
    assert.equal(promoted.truthStatus, "story_canon");
    assert.equal(promoted.supersedesClaimId, "claim_bell_rang");

    await knowledge.projectRelation(SCOPE, {
      claimId: "claim_bell_rang_v2",
      objectEntityId: "entity_milo",
      relationId: "rel_bell_milo",
    });
    const relations = await knowledge.listRelations(SCOPE, {
      subjectEntityId: "entity_bell",
    });
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.objectEntityId, "entity_milo");

    await knowledge.createArticle(SCOPE, {
      id: "article_bell",
      title: "无声钟再鸣",
      body: "停战十七年后，无声钟在雾月12日夜响了三声。",
      claimIds: ["claim_bell_rang_v2"],
      sourceEventIds: ["event_opening"],
    });
    const articles = await knowledge.listArticles(SCOPE);
    assert.equal(articles.length, 1);
    assert.deepEqual(articles[0]?.claimIds, ["claim_bell_rang_v2"]);

    // claims append-only：改写被拒绝。
    await assert.rejects(
      ownerPool.query(
        `UPDATE world_claims SET object_value = 'x' WHERE id = 'claim_bell_rang'`,
      ),
    );
  },
);

test(
  "canon review gates record-level facts and merges atomically",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    const canon = createCanonService({
      repository: createPostgresCanonRepository(ownerPool),
      knowledge,
      idFactory: (() => {
        let sequence = 0;
        return () => `m5-${++sequence}`;
      })(),
    });

    await knowledge.upsertEntity(SCOPE, {
      id: "entity_bell",
      entityKind: "setting",
      name: "无声钟",
      summary: "海钟。",
      validFromTick: 0,
      validToTick: null,
    });
    // record 级事实：不产生提案。
    await knowledge.appendClaim(SCOPE, {
      id: "claim_record_level",
      subjectEntityId: "entity_bell",
      predicate: "被提及",
      objectValue: "玩家随口提到",
      scope: "record",
      truthStatus: "mentioned",
      confidence: 0.5,
      validFromTick: 10,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const gated = await canon.propose({
      scope: SCOPE,
      targetLevel: "story",
      claimIds: ["claim_record_level"],
      rationale: "不应进入审核",
    });
    assert.equal(gated, null);

    // story 级事实：提案 → 合并 → 晋升 + 不可变 Revision。
    await knowledge.appendClaim(SCOPE, {
      id: "claim_story_level",
      subjectEntityId: "entity_bell",
      predicate: "状态",
      objectValue: "再次响起",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 100,
      validToTick: null,
      sourceRecordId: "record_first_watch",
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const proposal = await canon.propose({
      scope: SCOPE,
      targetLevel: "story",
      claimIds: ["claim_story_level"],
      rationale: "无声钟再鸣改变故事走向。",
    });
    assert.ok(proposal);
    assert.equal(proposal!.status, "pending");

    const merged = await canon.decide({
      scope: SCOPE,
      proposalId: proposal!.id,
      decision: "merge",
      decidedBy: "user",
      effectiveCursor: { tick: 100, ordinal: 0 },
    });
    assert.equal(merged.status, "merged");

    const claims = await knowledge.listClaims(SCOPE, {
      truthStatus: "story_canon",
    });
    assert.ok(claims.some((claim) => claim.supersedesClaimId === "claim_story_level"));

    const revision = await canon.latestRevision(SCOPE);
    assert.ok(revision);
    assert.equal(revision!.acceptedProposalId, proposal!.id);
    // Revision 不可变。
    await assert.rejects(
      ownerPool.query(
        `DELETE FROM canon_revisions WHERE id = $1`,
        [revision!.id],
      ),
    );
    // 已决定的提案不能再决定。
    await assert.rejects(
      canon.decide({
        scope: SCOPE,
        proposalId: proposal!.id,
        decision: "reject",
        decidedBy: "user",
      }),
    );

    // 拒绝路径：不产生任何正史变更。
    const proposal2 = await canon.propose({
      scope: SCOPE,
      targetLevel: "story",
      claimIds: ["claim_story_level"],
      rationale: "第二次提案被拒绝。",
    });
    assert.ok(proposal2);
    await canon.decide({
      scope: SCOPE,
      proposalId: proposal2!.id,
      decision: "reject",
      decidedBy: "user",
    });
    const revisions = await ownerPool.query(
      `SELECT count(*)::int AS count FROM canon_revisions`,
    );
    assert.equal(revisions.rows[0].count, 1);
  },
);

test(
  "existing records stay immutable and propagation persists reproducible exposures",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);

    // 未来保护：历史事件不可被改写或删除。
    await assert.rejects(
      ownerPool.query(`UPDATE events SET payload = '{}'::jsonb`),
    );
    await assert.rejects(
      ownerPool.query(`DELETE FROM events`),
    );

    const propagationRepository = createPostgresPropagationRepository(ownerPool);
    const root: InformationPacket = {
      id: "packet_root",
      campaignId: "camp_bell",
      parentPacketId: null,
      channel: "official_bulletin",
      claimIds: ["c1", "c2", "c3", "c4", "c5", "c6"],
      framing: "official",
      omittedClaimIds: [],
      semanticFidelityToParent: 1,
      contentHash: "root",
    };
    const input = {
      campaign: {
        id: "camp_bell",
        securityClass: "public" as const,
        effectiveTick: 10,
        salience: 0.8,
        complexity: 0.3,
      },
      roots: [{ nodeKey: "herald", packet: root }],
      nodes: [
        { key: "herald", clearance: "public" as const },
        { key: "market", clearance: "public" as const },
        { key: "tavern", clearance: "public" as const },
      ],
      routes: [
        { from: "herald", to: "market", channel: "official_bulletin" as const, distance: 2 },
        { from: "market", to: "tavern", channel: "market_rumor" as const, distance: 1 },
      ],
    };
    const first = propagate(input);
    const second = propagate(input);
    assert.deepEqual(first, second);

    await propagationRepository.saveRun(SCOPE, {
      campaign: input.campaign,
      packets: first.packets,
      exposures: first.exposures,
      algorithmVersion: first.algorithmVersion,
    });
    const stored = await propagationRepository.listExposures(SCOPE, "camp_bell");
    assert.equal(stored.length, first.exposures.length);
    assert.deepEqual(
      stored.map((exposure) => [
        exposure.nodeKey,
        exposure.arrivalTick,
        exposure.fidelity,
      ]),
      first.exposures.map((exposure) => [
        exposure.nodeKey,
        exposure.arrivalTick,
        exposure.fidelity,
      ]),
    );
    // Packet 不可变。
    await assert.rejects(
      ownerPool.query(
        `UPDATE information_packets SET framing = 'x' WHERE id = 'packet_root'`,
      ),
    );
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
  if (!/^realm_m5_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
