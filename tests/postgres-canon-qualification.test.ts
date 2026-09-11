/**
 * 批次 T11-H——Canon 资格预检与审计主体（T11-H §三）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0027 全链，门禁开启）：
 * view=qualification 返回角色/continuity 选项/拓扑/readiness；非成员 404；
 * secretReady 在纯 private_letter + 唯一映射世界为 true、demo 拓扑为 false；
 * decide 的审计主体只取会话 principalId（body.decidedBy 伪造不生效）；
 * public merge 向后兼容。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { GET as audienceGET, POST as audiencePOST } from "../app/api/propagation/node-audiences/route.ts";
import { GET as canonGET, POST as canonPOST } from "../app/api/canon/route.ts";
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
const OUTSIDER = "principal_t11h_outside";

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

function authed(url: string, principalId: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: `realm_session=${createSessionValue(principalId)}`,
    },
  });
}

test(
  "T11-H: canon qualification preflight and principal-bound audit identity",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11h_${randomUUID().replaceAll("-", "")}`;
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
    process.env.REALM_ACCESS_TOKEN = "t11h-test-token";

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

    // 1. 成员预检：角色/continuity 选项/拓扑/readiness。
    const qualificationResponse = await canonGET(authed(
      `/api/canon?view=qualification&worldId=${SCOPE.worldId}`,
      OWNER,
    ));
    assert.equal(qualificationResponse.status, 200);
    const { qualification } = await qualificationResponse.json() as {
      qualification: {
        membershipRole: string;
        scope: { worldId: string; worldlineId: string };
        continuities: readonly { id: string; displayName: string }[];
        topology: {
          nodes: readonly { key: string; clearance: string }[];
          routes: readonly { channel: string; recipient: string | null }[];
          nodeAudiences: readonly unknown[];
          secretReady: boolean;
        };
      };
    };
    assert.equal(qualification.membershipRole, "owner");
    assert.equal(qualification.scope.worldlineId, SCOPE.worldlineId);
    assert.deepEqual(
      qualification.continuities.map((continuity) => continuity.id).sort(),
      ["continuity_player", "continuity_scholar", "continuity_scout"].sort(),
    );
    assert.deepEqual(
      qualification.topology.nodes.map((node) => node.key).sort(),
      ["canon_origin", "harbor_tavern", "market_square"].sort(),
    );
    assert.equal(
      qualification.topology.secretReady,
      false,
      "demo 拓扑含 bulletin/rumor 路线，secret 不就绪",
    );

    // 2. 非成员 404（不泄露）；缺 worldId 400。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '局外人')`,
      [SCOPE.workspaceId, OUTSIDER],
    );
    const outsider = await canonGET(authed(
      `/api/canon?view=qualification&worldId=${SCOPE.worldId}`,
      OUTSIDER,
    ));
    assert.equal(outsider.status, 404);
    const missingWorld = await canonGET(authed(
      "/api/canon?view=qualification",
      OWNER,
    ));
    assert.equal(missingWorld.status, 400);

    // 3. secretReady=true：纯 private_letter + 唯一映射的世界。
    await ownerPool.query(
      `INSERT INTO worlds (workspace_id, id, name, calendar_id)
       VALUES ($1, 'world_secret', '密信世界', 'truce_calendar')`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label)
       VALUES ($1, 'world_secret', 'worldline_secret', '密信线')`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (
         workspace_id, world_id, principal_id, role
       ) VALUES ($1, 'world_secret', $2, 'owner')`,
      [SCOPE.workspaceId, OWNER],
    );
    await ownerPool.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
       VALUES ($1, 'world_secret', 'def_secret', '密使')`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES ($1, 'world_secret', 'worldline_secret', 'def_secret',
         'cont_secret', 'contkey_secret', 'active', 0, 0)`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO propagation_nodes (
         workspace_id, world_id, worldline_id, node_key, clearance, active
       ) VALUES
         ($1, 'world_secret', 'worldline_secret', 'canon_origin', 'secret', TRUE),
         ($1, 'world_secret', 'worldline_secret', 'safehouse', 'secret', TRUE)`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO propagation_routes (
         workspace_id, world_id, worldline_id, id,
         from_node, to_node, channel, distance, recipient
       ) VALUES (
         $1, 'world_secret', 'worldline_secret', 'route_secret',
         'canon_origin', 'safehouse', 'private_letter', 1, 'safehouse'
       )`,
      [SCOPE.workspaceId],
    );
    await ownerPool.query(
      `INSERT INTO propagation_node_audiences (
         workspace_id, world_id, worldline_id, node_key, continuity_id
       ) VALUES ($1, 'world_secret', 'worldline_secret', 'safehouse', 'cont_secret')`,
      [SCOPE.workspaceId],
    );
    const secretWorldQualification = await canonGET(authed(
      "/api/canon?view=qualification&worldId=world_secret",
      OWNER,
    ));
    assert.equal(secretWorldQualification.status, 200);
    const secretBody = await secretWorldQualification.json() as {
      qualification: { topology: { secretReady: boolean } };
    };
    assert.equal(secretBody.qualification.topology.secretReady, true);

    // 3b. T11-I-A mapping product API：owner 可追加且重复幂等；player 只能读。
    const audienceList = await audienceGET(authed(
      `/api/propagation/node-audiences?worldId=${SCOPE.worldId}`,
      OWNER,
    ));
    assert.equal(audienceList.status, 200);
    const audienceListBody = await audienceList.json() as {
      qualification: { topology: { nodeAudiences: readonly unknown[] } };
    };
    assert.deepEqual(audienceListBody.qualification.topology.nodeAudiences, []);
    const audienceAdd = await audiencePOST(authed("/api/propagation/node-audiences", OWNER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worldId: SCOPE.worldId,
        nodeKey: "harbor_tavern",
        continuityId: "continuity_scout",
      }),
    }));
    assert.equal(audienceAdd.status, 200);
    assert.deepEqual(await audienceAdd.json(), {
      ok: true,
      added: true,
      nodeKey: "harbor_tavern",
      continuityId: "continuity_scout",
    });
    const audienceDuplicate = await audiencePOST(authed("/api/propagation/node-audiences", OWNER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worldId: SCOPE.worldId,
        nodeKey: "harbor_tavern",
        continuityId: "continuity_scout",
      }),
    }));
    assert.equal(audienceDuplicate.status, 200);
    assert.equal((await audienceDuplicate.json()).added, false);
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_t11i_player', 'player')`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    const playerAdd = await audiencePOST(authed("/api/propagation/node-audiences", "principal_t11i_player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worldId: SCOPE.worldId,
        nodeKey: "market_square",
        continuityId: "continuity_scholar",
      }),
    }));
    assert.equal(playerAdd.status, 403);
    assert.equal((await playerAdd.json()).error.code, "PROPAGATION_AUDIENCE_OWNER_REQUIRED");
    const malformedAudience = await audiencePOST(authed("/api/propagation/node-audiences", OWNER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldId: SCOPE.worldId, nodeKey: ["bad"] }),
    }));
    assert.equal(malformedAudience.status, 400);

    // 4. 审计主体：body.decidedBy 伪造不生效——decided_by 恒为会话 principal。
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    const entityId = newId("entity");
    await knowledge.upsertEntity(SCOPE, {
      id: entityId,
      entityKind: "setting",
      name: "审计样本",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    const claimId = newId("claim");
    await knowledge.appendClaim(SCOPE, {
      id: claimId,
      subjectEntityId: entityId,
      predicate: "状态",
      objectValue: "记录",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 0,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const propose = await canonPOST(authed("/api/canon", OWNER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "propose",
        worldId: SCOPE.worldId,
        targetLevel: "story",
        claimIds: [claimId],
        rationale: "审计主体样本",
      }),
    }));
    assert.equal(propose.status, 201);
    const proposalId = ((await propose.json()) as { proposal: { id: string } })
      .proposal.id;
    const decide = await canonPOST(authed("/api/canon", OWNER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "decide",
        worldId: SCOPE.worldId,
        proposalId,
        decision: "merge",
        decidedBy: "attacker_forged",
        propagate: "public",
      }),
    }));
    assert.equal(decide.status, 200, "public merge 向后兼容");
    const decided = await ownerPool.query(
      `SELECT decided_by FROM canon_proposals WHERE id = $1`,
      [proposalId],
    );
    assert.equal(
      decided.rows[0].decided_by,
      OWNER,
      "审计主体必须是会话 principalId，body.decidedBy 伪造不得生效",
    );
  },
);
