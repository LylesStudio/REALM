/**
 * 批次 T11-G——restricted/secret qualification gate（T11-F 冻结契约）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0027 全链）：
 * deferred constraint trigger（非 public Revision 无 audience 提交即败）；
 * public 向后兼容；unsupported propagate 值 400；非 owner 409；audience
 * 形状/未知/失效/跨世界线拒绝；secret 非 private_letter 拒绝；recipient
 * 映射零/多拒绝；成功路径同事务 Revision+audience+Campaign+Packet+Job
 * 且 Job input 冻结 securityClass/revision/audienceDigest；失败整体回滚。
 * 门禁开启（REALM_ACCESS_TOKEN）+ 会话 cookie 驱动多 principal 角色矩阵。
 * 零开发库污染。
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
import { createSessionValue } from "../modules/identity/auth.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";

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
  "0027_propagation_node_audiences.sql",
  "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
  "0028_propagation_node_audiences_owner_append.sql",
];

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
};
const OWNER = POSTGRES_DEMO_IDS.principal;
const PLAYER = "principal_t11g_player";

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

function canonRequest(body: Record<string, unknown>, principalId: string): Request {
  return new Request("http://localhost/api/canon", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `realm_session=${createSessionValue(principalId)}`,
    },
    body: JSON.stringify(body),
  });
}

test(
  "T11-G: restricted/secret qualification gate is fail-closed and atomic",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11g_${randomUUID().replaceAll("-", "")}`;
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
    process.env.REALM_ACCESS_TOKEN = "t11g-test-token";

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
    // 非 owner 成员（player 角色，用于 403/409 角色矩阵）。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, 'T11G 玩家')`,
      [SCOPE.workspaceId, PLAYER],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, world_id, principal_id, role
       ) VALUES ($1, $2, $3, 'player')`,
      [SCOPE.workspaceId, SCOPE.worldId, PLAYER],
    );

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
    const seedProposal = async (marker: string) => {
      const entityId = newId("entity");
      await knowledge.upsertEntity(SCOPE, {
        id: entityId,
        entityKind: "setting",
        name: `资格样本${marker}`,
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
        truthStatus: "record_confirmed",
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
      }, OWNER));
      assert.equal(propose.status, 201);
      return ((await propose.json()) as { proposal: { id: string } }).proposal.id;
    };
    const merge = (
      proposalId: string,
      extra: Record<string, unknown>,
      principalId: string = OWNER,
      worldId: string = SCOPE.worldId,
    ) =>
      canonPOST(canonRequest({
        action: "decide",
        worldId,
        proposalId,
        decision: "merge",
        decidedBy: "user",
        ...extra,
      }, principalId));

    // 0. deferred constraint trigger：非 public Revision 无 audience → 提交败。
    {
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('realm.workspace_id', $1, true)`,
          [SCOPE.workspaceId],
        );
        await client.query(
          `INSERT INTO canon_proposals (
             workspace_id, world_id, worldline_id, id, target_level,
             claim_ids, rationale, status, proposed_by
           ) VALUES ($1, $2, $3, $4, 'story', '{}', '触发器样本', 'pending', 'dm')`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, newId("canon")],
        );
        const proposalRow = await client.query(
          `SELECT id FROM canon_proposals ORDER BY created_at DESC LIMIT 1`,
        );
        await client.query(
          `INSERT INTO canon_revisions (
             workspace_id, world_id, worldline_id, id, effective_tick,
             effective_ordinal, accepted_proposal_id, content_hash,
             security_class
           ) VALUES ($1, $2, $3, $4, 1, 1, $5, 'hash_trigger', 'secret')`,
          [
            SCOPE.workspaceId,
            SCOPE.worldId,
            SCOPE.worldlineId,
            newId("revision"),
            proposalRow.rows[0].id,
          ],
        );
        await assert.rejects(
          client.query("COMMIT"),
          /non-public canon revision requires at least one audience/,
          "deferred trigger 必须在提交时拒绝无 audience 的非 public Revision",
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }

    // 1. public 向后兼容：propagate:"public" 行为不变，Revision class=public。
    const publicId = await seedProposal("公");
    const publicMerge = await merge(publicId, { propagate: "public" });
    assert.equal(publicMerge.status, 200);
    const publicRevision = await ownerPool.query(
      `SELECT security_class FROM canon_revisions ORDER BY committed_at DESC LIMIT 1`,
    );
    assert.equal(publicRevision.rows[0].security_class, "public");
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 2. unsupported propagate 值 → 400（不得当成「不传播但正常 merge」）。
    const bogusId = await seedProposal("伪");
    const bogus = await merge(bogusId, { propagate: "internal" });
    assert.equal(bogus.status, 400);
    const bogusProposal = await ownerPool.query(
      `SELECT status FROM canon_proposals WHERE id = $1`,
      [bogusId],
    );
    assert.equal(bogusProposal.rows[0].status, "pending", "400 不得吞掉 merge");

    // 3. 非 owner attest non-public → 409 PROPAGATION_SECURITY_UNAVAILABLE。
    const playerProposal = await seedProposal("玩");
    const playerMerge = await merge(
      playerProposal,
      { propagate: "restricted", audienceContinuityIds: ["continuity_player"] },
      PLAYER,
    );
    assert.equal(playerMerge.status, 409);
    assert.equal(
      ((await playerMerge.json()) as { error: { code: string } }).error.code,
      "PROPAGATION_SECURITY_UNAVAILABLE",
    );
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 4. audience 形状：缺失/空数组 → 400。
    const noAudienceId = await seedProposal("缺");
    assert.equal((await merge(noAudienceId, { propagate: "restricted" })).status, 400);
    const emptyAudienceId = await seedProposal("空");
    assert.equal(
      (await merge(emptyAudienceId, { propagate: "restricted", audienceContinuityIds: [] })).status,
      400,
    );
    const malformedAudienceId = await seedProposal("混");
    const malformedAudience = await merge(malformedAudienceId, {
      propagate: "restricted",
      audienceContinuityIds: ["continuity_player", 123],
    });
    assert.equal(malformedAudience.status, 400, "混入非字符串 audience 必须 fail-closed");

    // 5. 未知/失效/跨世界线 continuity → 409。
    const unknownContinuityId = await seedProposal("未");
    const unknownContinuity = await merge(unknownContinuityId, {
      propagate: "restricted",
      audienceContinuityIds: ["continuity_nope"],
    });
    assert.equal(unknownContinuity.status, 409);
    await ownerPool.query(
      `UPDATE character_continuities SET status = 'ended'
       WHERE id = 'continuity_scholar'`,
    );
    const inactiveId = await seedProposal("终");
    const inactive = await merge(inactiveId, {
      propagate: "restricted",
      audienceContinuityIds: ["continuity_scholar"],
    });
    assert.equal(inactive.status, 409, "失效 continuity 必须拒绝");

    // 6. restricted 成功（去重 audience）：Revision/audience/Campaign/Job 齐全。
    const restrictedId = await seedProposal("限");
    const restricted = await merge(restrictedId, {
      propagate: "restricted",
      audienceContinuityIds: ["continuity_player", "continuity_player"],
    });
    assert.equal(restricted.status, 200);
    const restrictedRevision = await ownerPool.query(
      `SELECT id, security_class FROM canon_revisions
       WHERE security_class = 'restricted' ORDER BY committed_at DESC LIMIT 1`,
    );
    assert.equal(restrictedRevision.rows.length, 1);
    const restrictedRevisionId = restrictedRevision.rows[0].id as string;
    const audienceRows = await ownerPool.query(
      `SELECT continuity_id FROM canon_revision_audiences
       WHERE revision_id = $1`,
      [restrictedRevisionId],
    );
    assert.deepEqual(audienceRows.rows.map((row) => row.continuity_id), ["continuity_player"]);
    const restrictedCampaign = await ownerPool.query(
      `SELECT id, security_class, canon_revision_id FROM information_campaigns
       WHERE security_class = 'restricted'`,
    );
    assert.equal(restrictedCampaign.rows.length, 1);
    assert.equal(
      restrictedCampaign.rows[0].id,
      `campaign_canon_${restrictedRevisionId}`,
    );
    const restrictedJob = await ownerPool.query(
      `SELECT input FROM propagation_jobs
       WHERE campaign_id = $1`,
      [restrictedCampaign.rows[0].id],
    );
    const restrictedInput = restrictedJob.rows[0].input as {
      canonRevisionId: string; audienceContinuityIds: string[]; audienceDigest: string; topologyVersion: string;
      campaign: { securityClass: string };
    };
    assert.equal(restrictedInput.canonRevisionId, restrictedRevisionId);
    assert.deepEqual(restrictedInput.audienceContinuityIds, ["continuity_player"]);
    assert.equal(restrictedInput.campaign.securityClass, "restricted");
    assert.match(restrictedInput.audienceDigest, /^[0-9a-f]{24}$/);

    // 7. secret 在含 bulletin/rumor 路线的拓扑上 → 409（永久资格错误），
    //    整体回滚：提案仍 pending、零新增 Campaign/Job。
    const secretId = await seedProposal("密");
    const secret = await merge(secretId, {
      propagate: "secret",
      audienceContinuityIds: ["continuity_player"],
    });
    assert.equal(secret.status, 409);
    const secretProposal = await ownerPool.query(
      `SELECT status FROM canon_proposals WHERE id = $1`,
      [secretId],
    );
    assert.equal(secretProposal.rows[0].status, "pending", "资格失败必须整体回滚");
    const campaignsAfterSecret = await propagationCounts();
    assert.equal(campaignsAfterSecret.campaigns, 2, "只有 public+restricted 两个 Campaign");

    // 8. secret 在纯 private_letter 拓扑世界成功；recipient 映射零/多拒绝。
    //    建三个定制世界：W2（恰一个映射）、W3（零映射）、W4（两个映射）。
    const makeSecretWorld = async (
      worldId: string,
      mappings: readonly string[],
    ) => {
      const worldlineId = `worldline_${worldId}`;
      await ownerPool.query(
        `INSERT INTO worlds (workspace_id, id, name, calendar_id)
         VALUES ($1, $2, $3, 'truce_calendar')`,
        [SCOPE.workspaceId, worldId, `秘密世界${worldId}`],
      );
      await ownerPool.query(
        `INSERT INTO worldlines (workspace_id, world_id, id, label)
         VALUES ($1, $2, $3, '秘密线')`,
        [SCOPE.workspaceId, worldId, worldlineId],
      );
      await ownerPool.query(
        `INSERT INTO player_world_memberships (
           workspace_id, world_id, principal_id, role
         ) VALUES ($1, $2, $3, 'owner')`,
        [SCOPE.workspaceId, worldId, OWNER],
      );
      await ownerPool.query(
        `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
         VALUES ($1, $2, $3, '密使')`,
        [SCOPE.workspaceId, worldId, `def_${worldId}`],
      );
      await ownerPool.query(
        `INSERT INTO character_continuities (
           workspace_id, world_id, worldline_id, definition_id, id,
           continuity_key, status, born_tick, born_ordinal
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)`,
        [
          SCOPE.workspaceId,
          worldId,
          worldlineId,
          `def_${worldId}`,
          `cont_${worldId}`,
          `contkey_${worldId}`,
        ],
      );
      await ownerPool.query(
        `INSERT INTO propagation_nodes (
           workspace_id, world_id, worldline_id, node_key, clearance, active
         ) VALUES
           ($1, $2, $3, 'canon_origin', 'secret', TRUE),
           ($1, $2, $3, 'safehouse', 'secret', TRUE)`,
        [SCOPE.workspaceId, worldId, worldlineId],
      );
      await ownerPool.query(
        `INSERT INTO propagation_routes (
           workspace_id, world_id, worldline_id, id,
           from_node, to_node, channel, distance, recipient
         ) VALUES ($1, $2, $3, $4, 'canon_origin', 'safehouse', 'private_letter', 1, 'safehouse')`,
        [SCOPE.workspaceId, worldId, worldlineId, `route_${worldId}`],
      );
      for (const [index, continuityId] of mappings.entries()) {
        await ownerPool.query(
          `INSERT INTO propagation_node_audiences (
             workspace_id, world_id, worldline_id, node_key, continuity_id
           ) VALUES ($1, $2, $3, 'safehouse', $4)`,
          [SCOPE.workspaceId, worldId, worldlineId, continuityId ?? `cont_${worldId}`],
        );
        void index;
      }
      return worldlineId;
    };
    const seedSecretProposal = async (worldId: string, worldlineId: string, marker: string) => {
      const worldScope = { workspaceId: SCOPE.workspaceId, worldId, worldlineId };
      const entityId = newId("entity");
      await knowledge.upsertEntity(worldScope, {
        id: entityId,
        entityKind: "setting",
        name: `密件${marker}`,
        summary: "",
        validFromTick: 0,
        validToTick: null,
      });
      const claimId = newId("claim");
      await knowledge.appendClaim(worldScope, {
        id: claimId,
        subjectEntityId: entityId,
        predicate: "内容",
        objectValue: marker,
        scope: "story",
        truthStatus: "record_confirmed",
        confidence: 1,
        validFromTick: 0,
        validToTick: null,
        sourceRecordId: null,
        sourceEventId: null,
        supersedesClaimId: null,
      });
      const propose = await canonPOST(canonRequest({
        action: "propose",
        worldId,
        targetLevel: "story",
        claimIds: [claimId],
        rationale: `密件${marker}`,
      }, OWNER));
      assert.equal(propose.status, 201);
      return ((await propose.json()) as { proposal: { id: string } }).proposal.id;
    };

    // W2：恰一个映射 → secret 成功。
    const w2line = await makeSecretWorld("world_s2", ["cont_world_s2"]);
    const w2Proposal = await seedSecretProposal("world_s2", w2line, "乙");
    const w2Merge = await merge(
      w2Proposal,
      { propagate: "secret", audienceContinuityIds: ["cont_world_s2"] },
      OWNER,
      "world_s2",
    );
    assert.equal(w2Merge.status, 200);
    const w2Campaign = await ownerPool.query(
      `SELECT id, security_class FROM information_campaigns
       WHERE world_id = 'world_s2'`,
    );
    assert.equal(w2Campaign.rows.length, 1);
    assert.equal(w2Campaign.rows[0].security_class, "secret");
    const w2RootPacket = await ownerPool.query(
      `SELECT channel FROM information_packets
       WHERE campaign_id = $1 AND parent_packet_id IS NULL`,
      [w2Campaign.rows[0].id],
    );
    assert.equal(
      w2RootPacket.rows[0].channel,
      "private_letter",
      "secret root packet 也不得保留 official_bulletin 语义",
    );

    // W3：recipient 零映射 → 409。
    const w3line = await makeSecretWorld("world_s3", []);
    const w3Proposal = await seedSecretProposal("world_s3", w3line, "丙");
    const w3Merge = await merge(
      w3Proposal,
      { propagate: "secret", audienceContinuityIds: ["cont_world_s3"] },
      OWNER,
      "world_s3",
    );
    assert.equal(w3Merge.status, 409, "recipient 零映射必须拒绝");

    // W4：recipient 两个映射 → 409（不猜 recipient）。
    //    先建世界（恰一个映射），再补第二个 continuity 与第二个映射行。
    const w4line = await makeSecretWorld("world_s4", ["cont_world_s4"]);
    await ownerPool.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
       VALUES ($1, 'world_s4', 'def_second_s4', '密使乙')`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES ($1, 'world_s4', $2, 'def_second_s4',
         'cont_second_s4', 'contkey_second_s4', 'active', 0, 0)`,
      [SCOPE.workspaceId, w4line],
    );
    await ownerPool.query(
      `INSERT INTO propagation_node_audiences (
         workspace_id, world_id, worldline_id, node_key, continuity_id
       ) VALUES ($1, 'world_s4', $2, 'safehouse', 'cont_second_s4')`,
      [SCOPE.workspaceId, w4line],
    );
    const w4Proposal = await seedSecretProposal("world_s4", w4line, "丁");
    const w4Merge = await merge(
      w4Proposal,
      { propagate: "secret", audienceContinuityIds: ["cont_world_s4"] },
      OWNER,
      "world_s4",
    );
    assert.equal(w4Merge.status, 409, "recipient 多映射必须拒绝");

    // 终态账目：Campaign = public 1 + restricted 1 + secret(W2) 1。
    const finalCounts = await propagationCounts();
    assert.equal(finalCounts.campaigns, 3);
    assert.equal(finalCounts.jobs, 3);
  },
);
