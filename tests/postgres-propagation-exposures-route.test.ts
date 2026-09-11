/**
 * 批次 T11-G——Exposure 服务端授权读取（T11-F §四/§5.3）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0027 全链）：
 * GET /api/propagation/exposures 按 principal/record 服务端解析——
 * Character 视角：public 可见、audience 内 restricted 可见、audience 外
 * secret 过滤；owner 控制面（view=control）全类可见且显式标记；
 * observer 仅 public；非 owner 控制面 403；未知世界/记录 404；
 * 绝不 fallback public。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { GET as exposuresGET } from "../app/api/propagation/exposures/route.ts";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

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
const OBSERVER = "principal_t11g_observer";
const OBSERVER_WORLD = "world_t11g_obs";
const OBSERVER_RECORD = "record_t11g_obs";

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

function getExposures(query: string, principalId: string): Promise<Response> {
  return exposuresGET(new Request(
    `http://localhost/api/propagation/exposures?${query}`,
    { headers: { cookie: `realm_session=${createSessionValue(principalId)}` } },
  ));
}

test(
  "T11-G: propagation exposure reads are server-side authorized per class",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11gr_${randomUUID().replaceAll("-", "")}`;
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
    process.env.REALM_ACCESS_TOKEN = "t11g-read-token";

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

    // 读取 scope 回归：同一 World 另有更早创建的 decoy Worldline 时，
    // record 必须仍解析到自身的 record.worldline_id。
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, created_at)
       VALUES ($1, $2, 'worldline_t11g_decoy', '错误候选线', CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );

    // non-public 读取还必须经过 node→continuity 映射；public topology
    // 不要求配置该映射。
    await ownerPool.query(
      `INSERT INTO propagation_node_audiences (
         workspace_id, world_id, worldline_id, node_key, continuity_id
       ) VALUES ($1, $2, $3, 'harbor_tavern', 'continuity_player')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );

    // 传播事实 fixture：同一 worldline 下 public/restricted/secret 三组
    // Campaign+Packet+Exposure（Revision 关联与 audience 快照齐备）。
    const seedExposure = async (
      suffix: string,
      securityClass: "public" | "restricted" | "secret",
      audienceContinuity: string | null,
    ) => {
      const proposalId = `canon_${suffix}`;
      const revisionId = `revision_${suffix}`;
      const campaignId = `campaign_canon_${revisionId}`;
      const packetId = `packet_${suffix}`;
      // Revision + audience 必须同事务（0026 deferred trigger 提交时校验）。
      const fixture = await ownerPool.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query(
          `SELECT set_config('realm.workspace_id', $1, true)`,
          [SCOPE.workspaceId],
        );
        await fixture.query(
          `INSERT INTO canon_proposals (
             workspace_id, world_id, worldline_id, id, target_level,
             claim_ids, rationale, status, proposed_by, decided_by, decided_at
           ) VALUES (
             $1, $2, $3, $4, 'story', '{}', $5, 'merged', 'dm', 'user',
             CURRENT_TIMESTAMP
           )`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, proposalId, `提案${suffix}`],
        );
        await fixture.query(
          `INSERT INTO canon_revisions (
             workspace_id, world_id, worldline_id, id, effective_tick,
             effective_ordinal, accepted_proposal_id, content_hash, security_class
           ) VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7)`,
          [
            SCOPE.workspaceId,
            SCOPE.worldId,
            SCOPE.worldlineId,
            revisionId,
            proposalId,
            `hash_${suffix}`,
            securityClass,
          ],
        );
        if (audienceContinuity) {
          await fixture.query(
            `INSERT INTO canon_revision_audiences (
               workspace_id, world_id, worldline_id, revision_id, continuity_id
             ) VALUES ($1, $2, $3, $4, $5)`,
            [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, revisionId, audienceContinuity],
          );
        }
        await fixture.query("COMMIT");
      } catch (error) {
        await fixture.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        fixture.release();
      }
      await ownerPool.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, effective_tick,
           security_class, algorithm_version, canon_revision_id
         ) VALUES ($1, $2, $3, $4, 1, $5, 'realm-propagate-v1', $6)`,
        [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, campaignId, securityClass, revisionId],
      );
      await ownerPool.query(
        `INSERT INTO information_packets (
           workspace_id, world_id, worldline_id, id, campaign_id, channel,
           claim_ids, content_hash
         ) VALUES ($1, $2, $3, $4, $5, 'official_bulletin', '{}', $6)`,
        [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, packetId, campaignId, `ph_${suffix}`],
      );
      await ownerPool.query(
        `INSERT INTO propagation_exposures (
           workspace_id, world_id, worldline_id, id, campaign_id, packet_id,
           node_key, channel, arrival_tick, fidelity, algorithm_version
         ) VALUES ($1, $2, $3, $4, $5, $6, 'harbor_tavern', 'official_bulletin', 12, 0.95, 'realm-propagate-v1')`,
        [
          SCOPE.workspaceId,
          SCOPE.worldId,
          SCOPE.worldlineId,
          `exposure_${suffix}`,
          campaignId,
          packetId,
        ],
      );
      return campaignId;
    };

    // public（无 audience）、restricted（audience=continuity_player，即
    // demo principal 在 demo record 控制的角色）、secret（audience=
    // continuity_scout，principal 不控制）。
    const publicCampaign = await seedExposure("pub", "public", null);
    const restrictedCampaign = await seedExposure("res", "restricted", "continuity_player");
    await seedExposure("sec", "secret", "continuity_scout");

    // observer 世界：observer 角色、一条 public 与一条 restricted Exposure。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, 'T11G 观察者')`,
      [SCOPE.workspaceId, OBSERVER],
    );
    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id)
       VALUES ($1, $2, '观察世界', 'truce_calendar')`,
      [SCOPE.workspaceId, OBSERVER_WORLD],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label)
       VALUES ($1, $2, 'worldline_obs', '观察线')`,
      [SCOPE.workspaceId, OBSERVER_WORLD],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, world_id, principal_id, role
       ) VALUES ($1, $2, $3, 'observer')`,
      [SCOPE.workspaceId, OBSERVER_WORLD, OBSERVER],
    );
    await ownerPool.query(
      `INSERT INTO stories (
         workspace_id, world_id, worldline_id, id, title, start_tick, start_ordinal
       ) VALUES ($1, $2, 'worldline_obs', 'story_obs', '观察故事', 0, 0)`,
      [SCOPE.workspaceId, OBSERVER_WORLD],
    );
    await ownerPool.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title,
         start_tick, start_ordinal
       ) VALUES ($1, $2, 'worldline_obs', 'story_obs', $3, '观察记录', 0, 0)`,
      [SCOPE.workspaceId, OBSERVER_WORLD, OBSERVER_RECORD],
    );
    // observer 世界的 public + restricted（audience=cont_obs，observer
    // 在该 record 无任何控制角色）传播事实。Revision+audience 必须同事务
    // （0026 deferred constraint trigger 在提交时校验）。
    {
      const worldlineId = "worldline_obs";
      const proposalId = "canon_obs";
      const revisionId = "revision_obs";
      const campaignId = `campaign_canon_${revisionId}`;
      await ownerPool.query(
        `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
         VALUES ($1, $2, 'def_obs', '观察者角色')`,
        [SCOPE.workspaceId, OBSERVER_WORLD],
      );
      await ownerPool.query(
        `INSERT INTO character_continuities (
           workspace_id, world_id, worldline_id, definition_id, id,
           continuity_key, status, born_tick, born_ordinal
         ) VALUES ($1, $2, $3, 'def_obs', 'cont_obs', 'contkey_obs', 'active', 0, 0)`,
        [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId],
      );
      const fixture = await ownerPool.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query(
          `SELECT set_config('realm.workspace_id', $1, true)`,
          [SCOPE.workspaceId],
        );
        await fixture.query(
          `INSERT INTO canon_proposals (
             workspace_id, world_id, worldline_id, id, target_level,
             claim_ids, rationale, status, proposed_by, decided_by, decided_at
           ) VALUES (
             $1, $2, $3, $4, 'story', '{}', '观察提案', 'merged', 'dm', 'user',
             CURRENT_TIMESTAMP
           )`,
          [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, proposalId],
        );
        await fixture.query(
          `INSERT INTO canon_revisions (
             workspace_id, world_id, worldline_id, id, effective_tick,
             effective_ordinal, accepted_proposal_id, content_hash, security_class
           ) VALUES ($1, $2, $3, $4, 1, 1, $5, 'hash_obs', 'restricted')`,
          [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, revisionId, proposalId],
        );
        await fixture.query(
          `INSERT INTO canon_revision_audiences (
             workspace_id, world_id, worldline_id, revision_id, continuity_id
           ) VALUES ($1, $2, $3, $4, 'cont_obs')`,
          [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, revisionId],
        );
        await fixture.query("COMMIT");
      } catch (error) {
        await fixture.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        fixture.release();
      }
      await ownerPool.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, effective_tick,
           security_class, algorithm_version, canon_revision_id
         ) VALUES ($1, $2, $3, $4, 1, 'restricted', 'realm-propagate-v1', $5)`,
        [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, campaignId, revisionId],
      );
      await ownerPool.query(
        `INSERT INTO information_packets (
           workspace_id, world_id, worldline_id, id, campaign_id, channel,
           claim_ids, content_hash
         ) VALUES ($1, $2, $3, 'packet_obs', $4, 'official_bulletin', '{}', 'ph_obs')`,
        [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, campaignId],
      );
      await ownerPool.query(
        `INSERT INTO propagation_exposures (
           workspace_id, world_id, worldline_id, id, campaign_id, packet_id,
           node_key, channel, arrival_tick, fidelity, algorithm_version
         ) VALUES ($1, $2, $3, 'exposure_obs', $4, 'packet_obs', 'harbor_tavern', 'official_bulletin', 12, 0.95, 'realm-propagate-v1')`,
        [SCOPE.workspaceId, OBSERVER_WORLD, worldlineId, campaignId],
      );
    }

    // 1. Character 视角（owner 默认视图）：public + restricted（audience
    //    内含 continuity_player）可见，secret（audience 外）被过滤。
    const characterView = await getExposures(
      `worldId=${SCOPE.worldId}&recordId=${POSTGRES_DEMO_IDS.record}`,
      OWNER,
    );
    assert.equal(characterView.status, 200);
    const characterBody = await characterView.json() as {
      controlPlane: boolean;
      exposures: readonly { campaignId: string; securityClass: string }[];
    };
    assert.equal(characterBody.controlPlane, false);
    assert.deepEqual(
      characterBody.exposures.map((exposure) => exposure.campaignId).sort(),
      [publicCampaign, restrictedCampaign].sort(),
      "角色视角只含 public + audience 内 restricted，绝不 fallback secret",
    );

    await ownerPool.query(
      `UPDATE character_instances
       SET status = 'absent'
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
         AND record_id = $4 AND continuity_id = 'continuity_player'`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, POSTGRES_DEMO_IDS.record],
    );
    const absentCharacterView = await getExposures(
      `worldId=${SCOPE.worldId}&recordId=${POSTGRES_DEMO_IDS.record}`,
      OWNER,
    );
    assert.equal(absentCharacterView.status, 200);
    const absentCharacterBody = await absentCharacterView.json() as {
      exposures: readonly { campaignId: string }[];
    };
    assert.deepEqual(
      absentCharacterBody.exposures.map((exposure) => exposure.campaignId),
      [publicCampaign],
      "absent character instance 不得继续读取 restricted",
    );
    await ownerPool.query(
      `UPDATE character_instances
       SET status = 'present'
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
         AND record_id = $4 AND continuity_id = 'continuity_player'`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, POSTGRES_DEMO_IDS.record],
    );

    // 2. owner 控制面：三类全见，显式 controlPlane 标记。
    const controlView = await getExposures(
      `worldId=${SCOPE.worldId}&recordId=${POSTGRES_DEMO_IDS.record}&view=control`,
      OWNER,
    );
    assert.equal(controlView.status, 200);
    const controlBody = await controlView.json() as {
      controlPlane: boolean;
      exposures: readonly { securityClass: string }[];
    };
    assert.equal(controlBody.controlPlane, true);
    assert.deepEqual(
      controlBody.exposures.map((exposure) => exposure.securityClass).sort(),
      ["public", "restricted", "secret"],
    );

    // 3. observer：只读 public；非 owner 控制面 403。
    const observerView = await getExposures(
      `worldId=${OBSERVER_WORLD}&recordId=${OBSERVER_RECORD}`,
      OBSERVER,
    );
    assert.equal(observerView.status, 200);
    const observerBody = await observerView.json() as {
      exposures: readonly { securityClass: string }[];
    };
    assert.ok(
      observerBody.exposures.every((exposure) => exposure.securityClass === "public"),
      "observer 只能看到 public",
    );
    const observerControl = await getExposures(
      `worldId=${OBSERVER_WORLD}&recordId=${OBSERVER_RECORD}&view=control`,
      OBSERVER,
    );
    assert.equal(observerControl.status, 403, "非 owner 控制面必须 403");

    // 4. 未知世界/记录 404（不泄露存在性）。
    assert.equal(
      (await getExposures(`worldId=world_nope&recordId=${OBSERVER_RECORD}`, OWNER)).status,
      404,
    );
    assert.equal(
      (await getExposures(`worldId=${SCOPE.worldId}&recordId=record_nope`, OWNER)).status,
      404,
    );
    // 5. 缺参数 400。
    assert.equal((await getExposures(`recordId=${OBSERVER_RECORD}`, OWNER)).status, 400);
    assert.equal((await getExposures(`worldId=${SCOPE.worldId}`, OWNER)).status, 400);
  },
);
