/**
 * F4 回归：canon/revision/exposure 的 fail-closed（T11-F §二/§5.3）。
 * security class 以同 scope 的真实 CanonRevision 为准（campaign 快照必须与
 * revision 匹配）；NULL/悬空/跨 scope revision、class 错配一律 fail-closed
 * （绝不 fallback public、不返回空壳 exposure）。public 不需要 audience 行。
 *
 * 矩阵覆盖：public 无 audience、restricted/secret 无/有 viewer audience、
 * 公开快照链接 NULL/dangling/cross-scope/restricted/secret revision、
 * secret 快照链接 public revision（双向 class 错配）、真实公开 revision；
 * 每个 case 在三个读取面同时断言确切可见性：
 * A. record-scope brief.canon（CANON_ELIGIBILITY_WHERE，真实生产 SQL；
 *    只有真实 public revision 支撑的 claim 可见）；
 * B. propagation exposure 角色视角（listAuthorizedExposures，真实生产
 *    SQL；public 或 audience 命中）；
 * C. propagation exposure 控制面（真实匹配的 restricted/secret 对 owner
 *    可见，但 NULL/悬空/跨 scope/错配同样过滤）。
 * 全链 disposable PG17（自建自拆库），fixture 直接 SQL 构造各 revision
 * 形态；0026 deferred trigger 在 fixture COMMIT 点校验 non-public
 * revision 的 audience 合法性。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRecordRuntimeScopeRepository,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import {
  listAuthorizedExposures,
  resolveRecordViewerContext,
} from "../database/postgres/propagation-exposure-read.ts";

const adminConnectionString = process.env.DATABASE_URL;
const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
const RECORD = POSTGRES_DEMO_IDS.record;
const VIEWER_CONTINUITY = POSTGRES_DEMO_IDS.playerContinuity;
const OTHER_CONTINUITY = POSTGRES_DEMO_IDS.scoutContinuity;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("F4 tests require a loopback PostgreSQL host.");
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
  "F4: canon readback and exposure reads fail closed on NULL/dangling/cross-scope/mismatched revisions",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_f4fence_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await maintenance.end();
    });

    const { readdir, readFile } = await import("node:fs/promises");
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    await seedPostgresDemoPropagationTopology(ownerPool);

    // ---- fixture：每个 case 一组 (entity+claim+proposal+revision+campaign+packet+exposure)。
    // revision 形态：null / dangling / cross-scope / 真实 public|restricted|secret。
    // 三个读取面分别断言：brief.canon（仅 public revision）、角色视角
    // exposure（public 或 audience 命中）、控制面 exposure（真实匹配 revision，
    // 不按 audience 过滤但同样拒绝无效/错配）。
    const cases: Array<{
      marker: string;
      snapshotClass: "public" | "restricted" | "secret";
      revision: "public" | "restricted" | "secret" | "null" | "dangling" | "cross-scope";
      audienceForViewer: boolean;
      expectCanonVisible: boolean;
      expectRoleExposure: boolean;
      expectControlExposure: boolean;
    }> = [
      { marker: "F4A合法公开", snapshotClass: "public", revision: "public", audienceForViewer: false, expectCanonVisible: true, expectRoleExposure: true, expectControlExposure: true },
      { marker: "F4B快照公开无修订", snapshotClass: "public", revision: "null", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
      { marker: "F4C快照公开悬空修订", snapshotClass: "public", revision: "dangling", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
      { marker: "F4D快照公开跨域修订", snapshotClass: "public", revision: "cross-scope", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
      { marker: "F4E快照公开修订受限", snapshotClass: "public", revision: "restricted", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
      { marker: "F4F受限受众不含本人", snapshotClass: "restricted", revision: "restricted", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: true },
      { marker: "F4G受限有受众", snapshotClass: "restricted", revision: "restricted", audienceForViewer: true, expectCanonVisible: false, expectRoleExposure: true, expectControlExposure: true },
      { marker: "F4H秘密受众不含本人", snapshotClass: "secret", revision: "secret", audienceForViewer: false, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: true },
      { marker: "F4I秘密有受众", snapshotClass: "secret", revision: "secret", audienceForViewer: true, expectCanonVisible: false, expectRoleExposure: true, expectControlExposure: true },
      { marker: "F4J快照公开修订秘密", snapshotClass: "public", revision: "secret", audienceForViewer: true, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
      { marker: "F4K快照秘密修订公开", snapshotClass: "secret", revision: "public", audienceForViewer: true, expectCanonVisible: false, expectRoleExposure: false, expectControlExposure: false },
    ];

    // 0026 的 audience-required trigger 是 DEFERRED（提交时校验）：
    // 全部 fixture 写入放进一个显式事务。
    const fixtureClient = await ownerPool.connect();
    try {
      await fixtureClient.query("BEGIN");
    // 跨 scope revision 放在 demo 世界线之外的一条 worldline。
    const otherWorldline = newId("worldline_other");
    await fixtureClient.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, '其他世界线', 'active', 0, 0)`,
      [WS, WORLD, otherWorldline],
    );

    for (const entry of cases) {
      const entityId = newId("entity");
      await fixtureClient.query(
        `INSERT INTO world_entities (workspace_id, world_id, worldline_id, id, entity_kind, name, summary)
         VALUES ($1, $2, $3, $4, 'setting', $5, '')`,
        [WS, WORLD, WORLDLINE, entityId, entry.marker],
      );
      const claimId = newId("claim");
      await fixtureClient.query(
        `INSERT INTO world_claims (
           workspace_id, world_id, worldline_id, id, subject_entity_id,
           predicate, object_value, scope, truth_status, confidence,
           valid_from_tick, valid_to_tick
         ) VALUES ($1, $2, $3, $4, $5, '状态', $6, 'story', 'story_canon', 1, 0, NULL)`,
        [WS, WORLD, WORLDLINE, claimId, entityId, `可见标记-${entry.marker}`],
      );
      const proposalId = newId("proposal");
      await fixtureClient.query(
        `INSERT INTO canon_proposals (
           workspace_id, world_id, worldline_id, id, target_level, claim_ids, rationale
         ) VALUES ($1, $2, $3, $4, 'story', $5, $6)`,
        [WS, WORLD, WORLDLINE, proposalId, [claimId], `F4 ${entry.marker}`],
      );

      let revisionId: string | null = null;
      let revisionScope: { worldId: string; worldlineId: string } = { worldId: WORLD, worldlineId: WORLDLINE };
      const revisionClass = entry.revision === "restricted" || entry.revision === "secret"
        ? entry.revision
        : "public";
      if (entry.revision !== "null") {
        if (entry.revision === "cross-scope") {
          revisionScope = { worldId: WORLD, worldlineId: otherWorldline };
          // 跨 scope 的 revision 需要其世界线上的 proposal。
          await fixtureClient.query(
            `INSERT INTO canon_proposals (
               workspace_id, world_id, worldline_id, id, target_level, claim_ids, rationale
             ) VALUES ($1, $2, $3, $4, 'story', $5, 'cross-scope')`,
            [WS, revisionScope.worldId, revisionScope.worldlineId, `${proposalId}_x`, []],
          );
        }
        revisionId = entry.revision === "dangling" ? newId("revision_dangling") : newId("revision");
        if (entry.revision !== "dangling") {
          await fixtureClient.query(
            `INSERT INTO canon_revisions (
               workspace_id, world_id, worldline_id, id, parent_revision_id,
               effective_tick, effective_ordinal, accepted_proposal_id, content_hash, security_class
             ) VALUES ($1, $2, $3, $4, NULL, 1, 1, $5, $6, $7)`,
            [
              WS,
              revisionScope.worldId,
              revisionScope.worldlineId,
              revisionId,
              entry.revision === "cross-scope" ? `${proposalId}_x` : proposalId,
              `hash-${entry.marker}`,
              revisionClass,
            ],
          );
        }
      }

      const campaignId = newId("campaign");
      await fixtureClient.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, root_claim_ids,
           effective_tick, security_class, algorithm_version, canon_revision_id
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, 'realm-propagate-v1', $7)`,
        [WS, WORLD, WORLDLINE, campaignId, [claimId], entry.snapshotClass, revisionId],
      );
      const packetId = newId("packet");
      await fixtureClient.query(
        `INSERT INTO information_packets (
           workspace_id, world_id, worldline_id, id, campaign_id, channel, claim_ids, content_hash
         ) VALUES ($1, $2, $3, $4, $5, 'official_bulletin', $6, $7)`,
        [WS, WORLD, WORLDLINE, packetId, campaignId, [claimId], `ph-${entry.marker}`],
      );
      await fixtureClient.query(
        `INSERT INTO propagation_exposures (
           workspace_id, world_id, worldline_id, id, campaign_id, packet_id,
           node_key, channel, arrival_tick, fidelity, algorithm_version
         ) VALUES ($1, $2, $3, $4, $5, $6, 'harbor_tavern', 'official_bulletin', 1, 0.9, 'realm-propagate-v1')`,
        [WS, WORLD, WORLDLINE, newId("exposure"), campaignId, packetId],
      );
      if (revisionClass !== "public" && revisionId) {
        // 0026 deferred trigger：non-public revision 必须至少一行 audience
        // （给「他人」continuity；viewer 命中行在后面按 case 追加）。
        await fixtureClient.query(
          `INSERT INTO canon_revision_audiences (
             workspace_id, world_id, worldline_id, revision_id, continuity_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [WS, WORLD, WORLDLINE, revisionId, OTHER_CONTINUITY],
        );
        // 非 public 的 node→continuity 映射（读取链路必需；多次去重）。
        await fixtureClient.query(
          `INSERT INTO propagation_node_audiences (
             workspace_id, world_id, worldline_id, node_key, continuity_id
           ) VALUES ($1, $2, $3, 'harbor_tavern', $4)
           ON CONFLICT DO NOTHING`,
          [WS, WORLD, WORLDLINE, OTHER_CONTINUITY],
        );
      }
      if (entry.audienceForViewer && revisionId) {
        await fixtureClient.query(
          `INSERT INTO canon_revision_audiences (
             workspace_id, world_id, worldline_id, revision_id, continuity_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [WS, WORLD, WORLDLINE, revisionId, VIEWER_CONTINUITY],
        );
        await fixtureClient.query(
          `INSERT INTO propagation_node_audiences (
             workspace_id, world_id, worldline_id, node_key, continuity_id
           ) VALUES ($1, $2, $3, 'harbor_tavern', $4)
           ON CONFLICT DO NOTHING`,
          [WS, WORLD, WORLDLINE, VIEWER_CONTINUITY],
        );
      }
      (entry as Record<string, unknown>).claimId = claimId;
      (entry as Record<string, unknown>).campaignId = campaignId;
    }

      // 0026 的 audience-required trigger 是 DEFERRABLE INITIALLY DEFERRED：
      // 此 COMMIT 统一校验每个 restricted/secret revision 的 audience
      // fixture 合法性——缺 audience 的 non-public revision 会在此直接失败
      // （即 secret/restricted fixture 合法提交的自检点）。
      await fixtureClient.query("COMMIT");
    } catch (error) {
      await fixtureClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      fixtureClient.release();
    }

    // ---- A. brief.canon（生产 record-scope SQL）。
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const scope = await scopeRepository.resolve({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: RECORD,
    });
    assert.ok(scope);
    for (const entry of cases) {
      const visible = scope!.brief.canon.includes(`可见标记-${entry.marker}`);
      assert.equal(
        visible,
        entry.expectCanonVisible,
        `brief.canon 可见性错误：${entry.marker}（expect ${entry.expectCanonVisible}）`,
      );
    }

    // ---- B. exposure 授权读取（生产 SQL；角色视角 + 控制面）。
    const viewer = await resolveRecordViewerContext(ownerPool, {
      workspaceId: WS,
      recordId: RECORD,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.ok(viewer);
    assert.ok(
      viewer!.controlledContinuityIds.includes(VIEWER_CONTINUITY),
      "fixture：viewer 必须控制 demo player continuity",
    );
    const worldScope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE };
    const roleView = await listAuthorizedExposures(ownerPool, worldScope, viewer!, {
      controlPlane: false,
    });
    const controlView = await listAuthorizedExposures(ownerPool, worldScope, viewer!, {
      controlPlane: true,
    });
    for (const entry of cases) {
      const campaignId = (entry as Record<string, unknown>).campaignId as string;
      const roleVisible = roleView.some((exposure) => exposure.campaignId === campaignId);
      assert.equal(
        roleVisible,
        entry.expectRoleExposure,
        `exposure 角色视角错误：${entry.marker}（expect ${entry.expectRoleExposure}）`,
      );
      // 控制面同样不得显示不可解析/错配的 exposure（fail-closed 无例外面），
      // 但真实匹配的 restricted/secret revision 对 owner 控制面可见。
      const controlVisible = controlView.some((exposure) => exposure.campaignId === campaignId);
      assert.equal(
        controlVisible,
        entry.expectControlExposure,
        `exposure 控制面错误：${entry.marker}（expect ${entry.expectControlExposure}）`,
      );
    }
  },
);
