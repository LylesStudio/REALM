/**
 * 批次 T11-G——restricted/secret qualification gate（T11-F 冻结契约）。
 * 通过 test-postgres-runtime scratch cluster 运行；本测试另建独立数据库，
 * 应用 MIGRATIONS 列出的依赖集并由 t.after 强制拆库：不等同完整迁移链。
 * 覆盖：deferred constraint trigger（非 public Revision 无 audience 提交即败）；
 * public 向后兼容；unsupported propagate 值 400；非 owner 409；audience
 * 形状/未知/失效/跨世界线拒绝；secret 非 private_letter 拒绝；recipient
 * 映射零/多拒绝；成功路径同事务 Revision+audience+Campaign+Packet+Job
 * 且 Job input 冻结 securityClass/revision/audienceDigest；失败整体回滚。
 * REALM_RUNTIME_DATABASE_URL 门禁 + 登录签发的 HMAC session cookie 驱动角色矩阵。
 * 零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { POST as accountLoginPOST } from "../app/api/auth/login/route.ts";
import { POST as canonPOST } from "../app/api/canon/route.ts";
import { POST as worldKnowledgePOST } from "../app/api/world-knowledge/route.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresCanonRepository,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools, resolveMembershipRole } from "../app/api/world-scope.ts";
import { createSessionValue, principalIdForDisplayName } from "../modules/identity/auth.ts";
import { CanonError } from "../modules/worldline/canon.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { installTestSessionSecret, seedCapabilitySessionKey } from "./helpers/session-proof.ts";
installTestSessionSecret();

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
  "0051_account_password_hash.sql",
  "0053_membership_capability.sql",
];

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
};
const OWNER = POSTGRES_DEMO_IDS.principal;
const PLAYER = principalIdForDisplayName("T11G 玩家");
const sessionCookies = new Map<string, string>();

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

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canonRequest(body: Record<string, unknown>, principalId: string): Request {
  const cookie = sessionCookies.get(principalId)
    ?? `realm_session=${createSessionValue(principalId)}`;
  return new Request("http://localhost/api/canon", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
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
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_ACCESS_TOKEN = "t11g-test-token";

    t.after(async () => {
      await endSharedRuntimePools();
      await runtimePool.end();
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
    // 0053：HTTP 登录的 membership 写入要求库里已有会话密钥副本
    // （测试夹具以 admin 身份种子，与 installTestSessionSecret 同值）。
    await seedCapabilitySessionKey(ownerPool, SCOPE.workspaceId);
    // 真实首次登录建立账号 + 默认世界 membership + HttpOnly session。
    const playerLogin = await accountLoginPOST(new Request(
      "http://localhost/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "T11G 玩家", password: "" }),
      },
    ));
    const playerLoginBody = await playerLogin.clone().text();
    const accountRow = await ownerPool.query(
      `SELECT count(*)::int AS count FROM accounts WHERE workspace_id = $1 AND principal_id = $2`,
      [SCOPE.workspaceId, PLAYER],
    );
    const membershipRow = await ownerPool.query(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [SCOPE.workspaceId, SCOPE.worldId, PLAYER],
    );
    assert.equal(
      playerLogin.status,
      200,
      `login HTTP failed body=${playerLoginBody}; accountRows=${accountRow.rows[0]?.count}; membershipRole=${membershipRow.rows[0]?.role ?? "missing"}`,
    );
    const playerSession = playerLogin.headers.get("set-cookie");
    assert.ok(playerSession, "login must issue a signed session cookie");
    sessionCookies.set(PLAYER, playerSession.split(";", 1)[0]!);
    const playerMembership = await ownerPool.query(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [SCOPE.workspaceId, SCOPE.worldId, PLAYER],
    );
    assert.equal(playerMembership.rows[0]?.role, "player");

    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );

    const elevatedEntityId = newId("entity");
    await knowledge.upsertEntity(SCOPE, {
      id: elevatedEntityId,
      entityKind: "setting",
      name: "提权边界样本",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    for (const truthStatus of ["story_canon", "world_canon"]) {
      const response = await worldKnowledgePOST(new Request(
        "http://localhost/api/world-knowledge",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: sessionCookies.get(PLAYER)!,
          },
          body: JSON.stringify({
            action: "appendClaim",
            worldId: SCOPE.worldId,
            subjectEntityId: elevatedEntityId,
            predicate: "authorized",
            objectValue: truthStatus,
            scope: "world",
            truthStatus,
          }),
        },
      ));
      assert.equal(response.status, 400, `${truthStatus} must use the owner-gated canon decision path`);
    }
    const elevatedClaims = await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_claims
       WHERE workspace_id = $1 AND world_id = $2 AND subject_entity_id = $3
         AND truth_status IN ('story_canon', 'world_canon')`,
      [SCOPE.workspaceId, SCOPE.worldId, elevatedEntityId],
    );
    assert.equal(elevatedClaims.rows[0].count, 0, "rejected requests must not append elevated claims");

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

    // 3. 非 owner 即使在 body.decidedBy 伪造 owner principal，也不能 merge non-public Canon。
    const playerProposal = await seedProposal("玩");
    const playerMerge = await merge(
      playerProposal,
      {
        propagate: "restricted",
        audienceContinuityIds: ["continuity_player"],
        decidedBy: OWNER,
      },
      PLAYER,
    );
    assert.equal(playerMerge.status, 409);
    assert.equal(
      ((await playerMerge.json()) as { error: { code: string } }).error.code,
      "PROPAGATION_SECURITY_UNAVAILABLE",
    );
    const playerProposalState = await ownerPool.query(
      `SELECT status FROM canon_proposals WHERE id = $1`,
      [playerProposal],
    );
    assert.equal(playerProposalState.rows[0]?.status, "pending", "forged owner must not mutate the proposal");
    assert.deepEqual(await propagationCounts(), { campaigns: 1, packets: 1, jobs: 1 });

    // 3b. TOCTOU：真实 route preflight 曾读到 owner；role 随后被降级，
    //     runtime merge repository 必须在写事务内重验并锁定 membership。
    {
      const staleOwnerProposal = await seedProposal("owner-stale");
      assert.equal(
        await resolveMembershipRole(runtimePool, {
          workspaceId: SCOPE.workspaceId,
          worldId: SCOPE.worldId,
          principalId: OWNER,
        }),
        "owner",
      );
      await ownerPool.query(
        `UPDATE player_world_memberships SET role = 'player'
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [SCOPE.workspaceId, SCOPE.worldId, OWNER],
      );
      const revisionId = newId("revision");
      const canonRepository = createPostgresCanonRepository(runtimePool);
      try {
        await assert.rejects(
          canonRepository.mergeProposal(SCOPE, {
            proposalId: staleOwnerProposal,
            decidedBy: OWNER,
            promotedClaims: [],
            article: null,
            revision: {
              id: revisionId,
              parentRevisionId: null,
              effectiveTick: 1,
              effectiveOrdinal: 1,
              acceptedProposalId: staleOwnerProposal,
              contentHash: "stale-owner-check",
              committedAt: new Date().toISOString(),
              securityClass: "restricted",
            },
            propagation: {
              async enqueue(client) {
                const db = client as {
                  query(sql: string, values: unknown[]): Promise<unknown>;
                };
                await db.query(
                  `INSERT INTO canon_revision_audiences (
                     workspace_id, world_id, worldline_id, revision_id, continuity_id
                   ) VALUES ($1, $2, $3, $4, $5)`,
                  [
                    SCOPE.workspaceId,
                    SCOPE.worldId,
                    SCOPE.worldlineId,
                    revisionId,
                    "continuity_player",
                  ],
                );
              },
            },
          }),
          (error: unknown) => error instanceof CanonError
            && error.code === "PROPAGATION_SECURITY_UNAVAILABLE",
        );
        const staleProposalState = await ownerPool.query(
          `SELECT status FROM canon_proposals WHERE id = $1`,
          [staleOwnerProposal],
        );
        assert.equal(staleProposalState.rows[0]?.status, "pending");
        const staleRevisionCount = await ownerPool.query(
          `SELECT count(*)::int AS count FROM canon_revisions WHERE id = $1`,
          [revisionId],
        );
        assert.equal(staleRevisionCount.rows[0]?.count, 0);
      } finally {
        await ownerPool.query(
          `UPDATE player_world_memberships SET role = 'owner'
           WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
          [SCOPE.workspaceId, SCOPE.worldId, OWNER],
        );
      }
    }

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

    // 9. 并发 role change 必须等待同事务的 non-public merge 完成。
    const lockingProposal = await seedProposal("owner-lock");
    const lockingRevisionId = newId("revision");
    let enterEnqueue!: () => void;
    const enqueueEntered = new Promise<void>((resolve) => { enterEnqueue = resolve; });
    let releaseMerge!: () => void;
    const mergeBarrier = new Promise<void>((resolve) => { releaseMerge = resolve; });
    let mergeTask: Promise<void> | undefined;
    let roleChangeTask: Promise<unknown> | undefined;
    try {
      assert.equal(
        await resolveMembershipRole(runtimePool, {
          workspaceId: SCOPE.workspaceId,
          worldId: SCOPE.worldId,
          principalId: OWNER,
        }),
        "owner",
      );
      mergeTask = createPostgresCanonRepository(runtimePool).mergeProposal(SCOPE, {
        proposalId: lockingProposal,
        decidedBy: OWNER,
        promotedClaims: [],
        article: null,
        revision: {
          id: lockingRevisionId,
          parentRevisionId: null,
          effectiveTick: 2,
          effectiveOrdinal: 2,
          acceptedProposalId: lockingProposal,
          contentHash: "owner-lock-linearization",
          committedAt: new Date().toISOString(),
          securityClass: "restricted",
        },
        propagation: {
          async enqueue(client) {
            const db = client as { query(sql: string, values: unknown[]): Promise<unknown> };
            await db.query(
              `INSERT INTO canon_revision_audiences (
                 workspace_id, world_id, worldline_id, revision_id, continuity_id
               ) VALUES ($1, $2, $3, $4, $5)`,
              [
                SCOPE.workspaceId,
                SCOPE.worldId,
                SCOPE.worldlineId,
                lockingRevisionId,
                "continuity_player",
              ],
            );
            enterEnqueue();
            await mergeBarrier;
          },
        },
      });
      assert.equal(await settlesWithin(enqueueEntered, 5_000), true, "merge should reach its transaction barrier");
      roleChangeTask = ownerPool.query(
        `UPDATE player_world_memberships SET role = 'player'
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [SCOPE.workspaceId, SCOPE.worldId, OWNER],
      );
      assert.equal(
        await settlesWithin(roleChangeTask, 150),
        false,
        "concurrent demotion must wait for the protected merge transaction",
      );
      releaseMerge();
      await mergeTask;
      await roleChangeTask;
      const committedProposal = await ownerPool.query(
        `SELECT status FROM canon_proposals WHERE id = $1`,
        [lockingProposal],
      );
      assert.equal(committedProposal.rows[0]?.status, "merged");
      const committedRevision = await ownerPool.query(
        `SELECT security_class FROM canon_revisions WHERE id = $1`,
        [lockingRevisionId],
      );
      assert.equal(committedRevision.rows[0]?.security_class, "restricted");
    } finally {
      releaseMerge();
      await mergeTask?.catch(() => undefined);
      await roleChangeTask?.catch(() => undefined);
      await ownerPool.query(
        `UPDATE player_world_memberships SET role = 'owner'
         WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
        [SCOPE.workspaceId, SCOPE.worldId, OWNER],
      );
    }
  },
);
