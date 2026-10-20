/**
 * F1a — Bridge 命令路由的显式世界线选择与读写分离授权。
 *
 * Against disposable scratch PostgreSQL (full migration chain):
 * - 显式 worldlineId 在 finance/projects/facts 三条命令路由上命中目标
 *   世界线（DB 写入落在目标，源世界线零写入）；
 * - 写缺省选择只在可写世界线恰好一条时成立；多条 → 409 SCOPE_REQUIRED
 *   且零写入；目标 frozen/archived → 409 WORLDLINE_NOT_WRITABLE；
 * - observer 403 / 非成员 404 / 匿名 401，全部零写入（实际 DB 计数）；
 *   observer 的读路由仍可用；
 * - 跨世界/不存在的 worldlineId → 404；非法/超长标识符 → 400。
 * 路由门禁仅覆盖请求入口；A3 事务内权限/撤销安全仍为待办。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { POST as financeCommandsPOST } from "../app/api/bridge/v1/finance/commands/route.ts";
import { POST as projectCommandsPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { POST as factsCommandsPOST } from "../app/api/bridge/v1/facts/commands/route.ts";
import { GET as projectsGET } from "../app/api/bridge/v1/projects/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { installTestSessionSecret } from "./helpers/session-proof.ts";

installTestSessionSecret();

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const WS = POSTGRES_DEMO_IDS.workspace;
const OWNER = POSTGRES_DEMO_IDS.principal;

function adminPool() {
  const pool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
  pool.on("error", () => {});
  return pool;
}

function authedJson(
  principal: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `realm_session=${createSessionValue(principal)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authedGet(principal: string, url: string): Request {
  return new Request(url, {
    method: "GET",
    headers: { cookie: `realm_session=${createSessionValue(principal)}` },
  });
}

interface SeededWorld {
  worldId: string;
  lineA: string;
  lineB: string;
  observer: string;
  player: string;
}

async function seedWorld(
  admin: pg.Pool,
  suffix: string,
  options: { secondLineStatus?: "active" | "frozen" | "archived" } = {},
): Promise<SeededWorld> {
  const worldId = `world_scope_${suffix}`;
  const lineA = `wl_scope_a_${suffix}`;
  const lineB = `wl_scope_b_${suffix}`;
  const observer = `principal_scope_observer_${suffix}`;
  const player = `principal_scope_player_${suffix}`;
  await admin.query(
    `INSERT INTO worlds (workspace_id, id, name, status, calendar_id, settings)
     VALUES ($1, $2, 'Scope gate rehearsal', 'active', 'native_calendar', '{}'::jsonb)`,
    [WS, worldId],
  );
  await admin.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal, created_at)
     VALUES ($1, $2, $3, 'Line A', 'active', 0, 0, '2026-01-01T00:00:00Z')`,
    [WS, worldId, lineA],
  );
  await admin.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal, created_at)
     VALUES ($1, $2, $3, 'Line B', $4, 0, 0, '2026-01-02T00:00:00Z')`,
    [WS, worldId, lineB, options.secondLineStatus ?? "active"],
  );
  await admin.query(
    `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
     VALUES ($1, $2, $3, 'owner'), ($1, $2, $4, 'observer'), ($1, $2, $5, 'player')`,
    [WS, worldId, OWNER, observer, player],
  );
  return { worldId, lineA, lineB, observer, player };
}

async function seedFinanceTarget(
  admin: pg.Pool,
  ids: { worldId: string; worldlineId: string },
  suffix: string,
): Promise<{ projectId: string; milestoneId: string }> {
  const projectId = `proj_scope_${suffix}`;
  const milestoneId = `mile_scope_${suffix}`;
  await admin.query(
    `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
     VALUES ($1, $2, $3, $4, 'production', 'active', 'funding', 'Scope production', 'JPY', NULL, NULL, 1)`,
    [WS, ids.worldId, ids.worldlineId, projectId],
  );
  await admin.query(
    `INSERT INTO project_milestones (workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
     VALUES ($1, $2, $3, $4, $5, 1, 'Scope gate', 'planned', NULL, NULL, NULL)`,
    [WS, ids.worldId, ids.worldlineId, milestoneId, projectId],
  );
  return { projectId, milestoneId };
}

async function seedFactTarget(
  admin: pg.Pool,
  ids: { worldId: string; worldlineId: string },
  suffix: string,
): Promise<{ recordId: string; instanceId: string; assetId: string; eventId: string }> {
  const storyId = `story_scope_${suffix}`;
  const recordId = `record_scope_${suffix}`;
  const sceneId = `scene_scope_${suffix}`;
  const policyId = `policy_scope_${suffix}`;
  const continuityId = `continuity_scope_${suffix}`;
  const instanceId = `instance_scope_${suffix}`;
  const assetId = `asset_scope_${suffix}`;
  const eventId = `event_scope_${suffix}`;
  await admin.query(
    `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, 'Scope story', 'active', '', 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, storyId],
  );
  await admin.query(
    `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, $5, 'Scope record', 'active', 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, storyId, recordId],
  );
  await admin.query(
    `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, location, objective, start_tick, start_ordinal)
     VALUES ($1, $2, $3, $4, $5, 'Scope scene', 'active', '', '', 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, recordId, sceneId],
  );
  await admin.query(
    `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
     VALUES ($1, $2, $3, $4, $5, 'scope', 1, 'public')`,
    [WS, ids.worldId, ids.worldlineId, recordId, policyId],
  );
  await admin.query(
    `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal)
     VALUES ($1, $2, $3, $4, 1, 2)`,
    [WS, ids.worldId, ids.worldlineId, recordId],
  );
  await admin.query(
    `INSERT INTO character_definitions (workspace_id, world_id, id, display_name)
     VALUES ($1, $2, $3, 'Scope character')`,
    [WS, ids.worldId, `chardef_scope_${suffix}`],
  );
  await admin.query(
    `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, status, born_tick, born_ordinal)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, `chardef_scope_${suffix}`, continuityId, `scope_${suffix}`],
  );
  await admin.query(
    `INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal)
     VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)`,
    [WS, ids.worldId, ids.worldlineId, recordId, continuityId, instanceId],
  );
  await admin.query(
    `INSERT INTO asset_definitions (workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable)
     VALUES ($1, $2, $3, $4, 'Scope asset', 'test-pack', false)`,
    [WS, ids.worldId, assetId, `scope_${suffix}`],
  );
  await admin.query(
    `INSERT INTO events (workspace_id, world_id, worldline_id, record_id, scene_id, id, record_version, record_ordinal, batch_index, event_kind, speaker_name, content, payload, visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed', '', 'scope', '{}'::jsonb, $7, 9, 1, 'native_calendar', '')`,
    [WS, ids.worldId, ids.worldlineId, recordId, sceneId, eventId, policyId],
  );
  return { recordId, instanceId, assetId, eventId };
}

async function worldWriteCounts(admin: pg.Pool, worldId: string) {
  const counts = await admin.query<{
    command_groups: string;
    fact_commands: string;
    obligations: string;
    ledger: string;
    holdings: string;
    completed_milestones: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM project_finance_command_groups
         WHERE workspace_id = $1 AND world_id = $2) AS command_groups,
       (SELECT count(*)::text FROM committed_fact_commands
         WHERE workspace_id = $1 AND world_id = $2) AS fact_commands,
       (SELECT count(*)::text FROM obligations
         WHERE workspace_id = $1 AND world_id = $2) AS obligations,
       (SELECT count(*)::text FROM ledger_entries
         WHERE workspace_id = $1 AND world_id = $2) AS ledger,
       (SELECT count(*)::text FROM character_assets
         WHERE workspace_id = $1 AND world_id = $2) AS holdings,
       (SELECT count(*)::text FROM project_milestones
         WHERE workspace_id = $1 AND world_id = $2 AND status = 'completed') AS completed_milestones`,
    [WS, worldId],
  );
  return counts.rows[0]!;
}

/**
 * Scratch 清理：整树删除本文件种下的 world（全部子表经 FK CASCADE 随
 * world 删除）。ledger/bindings 等 append-only/immutable 触发器只在
 * disposable 测试库的清理事务里临时关闭，绝不进入生产写路径。
 */
async function cleanupScopeWorlds(admin: pg.Pool, worldIds: string[]): Promise<void> {
  // session_replication_role=replica 会同时关闭 FK 级联触发器，所以必须
  // 显式逐表删除（子表优先），不能依赖 DELETE FROM worlds 级联。
  const tables = [
    "obligation_settlements",
    "obligations",
    "project_finance_command_groups",
    "committed_fact_commands",
    "character_assets",
    "project_story_links",
    "project_milestones",
    "budget_allocations",
    "projects",
    "events",
    "record_heads",
    "visibility_policies",
    "scenes",
    "participants",
    "records",
    "stories",
    "character_instances",
    "character_continuities",
    "asset_definitions",
    "player_world_memberships",
    "worldlines",
    "character_definitions",
  ];
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of tables) {
      await client.query(
        `DELETE FROM ${table} WHERE workspace_id = $1 AND world_id = ANY($2::text[])`,
        [WS, worldIds],
      );
    }
    await client.query(
      `DELETE FROM worlds WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [WS, worldIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const ZERO_WRITES = {
  command_groups: "0",
  fact_commands: "0",
  obligations: "0",
  ledger: "0",
  holdings: "0",
  completed_milestones: "0",
} as const;

function obligationBody() {
  return { command: "create_obligation", kind: "loan", principalMinor: 1000 };
}

function factBody(ids: { recordId: string; instanceId: string; assetId: string; eventId: string }) {
  return {
    command: "grant_inventory",
    recordId: ids.recordId,
    characterInstanceId: ids.instanceId,
    assetDefinitionId: ids.assetId,
    quantity: 1,
    sourceEventId: ids.eventId,
  };
}

function milestoneBody(ids: { projectId: string; milestoneId: string }) {
  return {
    command: "confirm_milestone",
    projectId: ids.projectId,
    milestoneId: ids.milestoneId,
    expectedProjectVersion: 1,
  };
}

const financeUrl = (worldId: string, worldlineId?: string) =>
  `http://localhost/api/bridge/v1/finance/commands?worldId=${worldId}${worldlineId ? `&worldlineId=${worldlineId}` : ""}`;
const projectsUrl = (worldId: string, worldlineId?: string) =>
  `http://localhost/api/bridge/v1/projects/commands?worldId=${worldId}${worldlineId ? `&worldlineId=${worldlineId}` : ""}`;
const factsUrl = (worldId: string, worldlineId?: string) =>
  `http://localhost/api/bridge/v1/facts/commands?worldId=${worldId}${worldlineId ? `&worldlineId=${worldlineId}` : ""}`;

test(
  "explicit worldlineId targets the selected worldline on finance, projects, and facts routes",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const seeded = await seedWorld(admin, suffix);
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [seeded.worldId]);
      await admin.end();
    });
    const finance = await seedFinanceTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineB }, suffix);
    const facts = await seedFactTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineB }, suffix);
    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);

    // Pool reset before route calls (shared-route-pool boundary, NOT a
    // process restart claim).
    await endSharedRuntimePools();

    const financeResponse = await financeCommandsPOST(authedJson(
      OWNER,
      financeUrl(seeded.worldId, seeded.lineB),
      obligationBody(),
      { "idempotency-key": `scope-fin-${suffix}` },
    ));
    assert.equal(financeResponse.status, 200);
    const financeJson = await financeResponse.json() as { meta: { worldlineId: string } };
    assert.equal(financeJson.meta.worldlineId, seeded.lineB);

    const projectResponse = await projectCommandsPOST(authedJson(
      OWNER,
      projectsUrl(seeded.worldId, seeded.lineB),
      milestoneBody(finance),
      { "idempotency-key": `scope-proj-${suffix}` },
    ));
    assert.equal(projectResponse.status, 200);
    const projectJson = await projectResponse.json() as { meta: { worldlineId: string } };
    assert.equal(projectJson.meta.worldlineId, seeded.lineB);

    const factsResponse = await factsCommandsPOST(authedJson(
      OWNER,
      factsUrl(seeded.worldId, seeded.lineB),
      factBody(facts),
      { "idempotency-key": `scope-fact-${suffix}` },
    ));
    assert.equal(factsResponse.status, 200);
    const factsJson = await factsResponse.json() as { meta: { worldlineId: string } };
    assert.equal(factsJson.meta.worldlineId, seeded.lineB);

    // All writes landed on line B; line A stayed empty.
    const perLine = await admin.query<{
      obligations_b: string; obligations_a: string; holdings_b: string; holdings_a: string;
      milestone_b: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM obligations
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3) AS obligations_b,
         (SELECT count(*)::text FROM obligations
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $4) AS obligations_a,
         (SELECT count(*)::text FROM character_assets
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3) AS holdings_b,
         (SELECT count(*)::text FROM character_assets
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $4) AS holdings_a,
         (SELECT status FROM project_milestones
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $5) AS milestone_b`,
      [WS, seeded.worldId, seeded.lineB, seeded.lineA, finance.milestoneId],
    );
    assert.deepEqual(perLine.rows[0], {
      obligations_b: "1",
      obligations_a: "0",
      holdings_b: "1",
      holdings_a: "0",
      milestone_b: "completed",
    });

    // Player role is writable too.
    const playerResponse = await financeCommandsPOST(authedJson(
      seeded.player,
      financeUrl(seeded.worldId, seeded.lineB),
      obligationBody(),
      { "idempotency-key": `scope-player-${suffix}` },
    ));
    assert.equal(playerResponse.status, 200);
  },
);

test(
  "write without selection resolves only when exactly one writable worldline exists",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    // Second line archived: exactly one writable candidate remains.
    const seeded = await seedWorld(admin, suffix, { secondLineStatus: "archived" });
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [seeded.worldId]);
      await admin.end();
    });
    await endSharedRuntimePools();
    const response = await financeCommandsPOST(authedJson(
      OWNER,
      financeUrl(seeded.worldId),
      obligationBody(),
      { "idempotency-key": `scope-single-${suffix}` },
    ));
    assert.equal(response.status, 200);
    const json = await response.json() as { meta: { worldlineId: string } };
    assert.equal(json.meta.worldlineId, seeded.lineA);
    const written = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM obligations
       WHERE workspace_id = $1 AND worldline_id = $2`,
      [WS, seeded.lineA],
    );
    assert.equal(written.rows[0]?.n, "1");
  },
);

test(
  "ambiguous writable worldlines without selection fail closed with zero writes",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const seeded = await seedWorld(admin, suffix);
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [seeded.worldId]);
      await admin.end();
    });
    const facts = await seedFactTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineB }, suffix);
    const finance = await seedFinanceTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineB }, suffix);
    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);
    await endSharedRuntimePools();

    const financeResponse = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(seeded.worldId), obligationBody(), { "idempotency-key": `amb-fin-${suffix}` },
    ));
    assert.equal(financeResponse.status, 409);
    assert.equal((await financeResponse.json() as { error: { code: string } }).error.code, "SCOPE_REQUIRED");

    const projectResponse = await projectCommandsPOST(authedJson(
      OWNER, projectsUrl(seeded.worldId), milestoneBody(finance), { "idempotency-key": `amb-proj-${suffix}` },
    ));
    assert.equal(projectResponse.status, 409);
    assert.equal((await projectResponse.json() as { error: { code: string } }).error.code, "SCOPE_REQUIRED");

    const factsResponse = await factsCommandsPOST(authedJson(
      OWNER, factsUrl(seeded.worldId), factBody(facts), { "idempotency-key": `amb-fact-${suffix}` },
    ));
    assert.equal(factsResponse.status, 409);
    assert.equal((await factsResponse.json() as { error: { code: string } }).error.code, "SCOPE_REQUIRED");

    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);
  },
);

test(
  "observer is read-only: stable 403 with zero writes on all command routes; reads stay open",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const seeded = await seedWorld(admin, suffix);
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [seeded.worldId]);
      await admin.end();
    });
    const finance = await seedFinanceTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineA }, suffix);
    const facts = await seedFactTarget(admin, { worldId: seeded.worldId, worldlineId: seeded.lineA }, suffix);
    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);
    await endSharedRuntimePools();

    const routes: [string, unknown][] = [
      [financeUrl(seeded.worldId, seeded.lineA), obligationBody()],
      [projectsUrl(seeded.worldId, seeded.lineA), milestoneBody(finance)],
      [factsUrl(seeded.worldId, seeded.lineA), factBody(facts)],
    ];
    for (const [index, [url, body]] of routes.entries()) {
      const response = await (
        index === 0 ? financeCommandsPOST : index === 1 ? projectCommandsPOST : factsCommandsPOST
      )(authedJson(seeded.observer, url, body, { "idempotency-key": `obs-${index}-${suffix}` }));
      assert.equal(response.status, 403, `observer command ${index} must be forbidden`);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "FORBIDDEN");
    }
    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);

    // Read snapshot stays available to the observer.
    const read = await projectsGET(authedGet(
      seeded.observer,
      `http://localhost/api/bridge/v1/projects?worldId=${seeded.worldId}&worldlineId=${seeded.lineA}`,
    ));
    assert.equal(read.status, 200);
  },
);

test(
  "nonmember gets 404, anonymous 401, cross-world and invalid identifiers rejected before any write",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const seeded = await seedWorld(admin, suffix);
    const other = await seedWorld(admin, `other_${suffix}`);
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [seeded.worldId, other.worldId]);
      await admin.end();
    });
    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);
    await endSharedRuntimePools();

    // Nonmember principal (valid session, no membership) → 404, no leak.
    const nonmember = `principal_scope_stranger_${suffix}`;
    const nonmemberResponse = await financeCommandsPOST(authedJson(
      nonmember, financeUrl(seeded.worldId, seeded.lineA), obligationBody(),
      { "idempotency-key": `nm-${suffix}` },
    ));
    assert.equal(nonmemberResponse.status, 404);
    assert.equal((await nonmemberResponse.json() as { error: { code: string } }).error.code, "WORLD_NOT_FOUND");

    // Anonymous → 401.
    const anonymous = await financeCommandsPOST(new Request(financeUrl(seeded.worldId, seeded.lineA), {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `anon-${suffix}` },
      body: JSON.stringify(obligationBody()),
    }));
    assert.equal(anonymous.status, 401);

    // Worldline of ANOTHER world → 404 (no cross-world authority).
    const crossWorld = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(seeded.worldId, other.lineA), obligationBody(),
      { "idempotency-key": `cross-${suffix}` },
    ));
    assert.equal(crossWorld.status, 404);
    assert.equal((await crossWorld.json() as { error: { code: string } }).error.code, "WORLD_NOT_FOUND");

    // Nonexistent worldline → 404.
    const missing = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(seeded.worldId, `wl_missing_${suffix}`), obligationBody(),
      { "idempotency-key": `missing-${suffix}` },
    ));
    assert.equal(missing.status, 404);

    // Nonexistent world → 404.
    const missingWorld = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(`world_missing_${suffix}`, seeded.lineA), obligationBody(),
      { "idempotency-key": `mw-${suffix}` },
    ));
    assert.equal(missingWorld.status, 404);

    // Oversized / empty identifiers → 400 before any resolution or write.
    const oversizedWorldline = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(seeded.worldId, "x".repeat(257)), obligationBody(),
      { "idempotency-key": `oversized-${suffix}` },
    ));
    assert.equal(oversizedWorldline.status, 400);
    assert.equal((await oversizedWorldline.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
    const oversizedWorld = await financeCommandsPOST(authedJson(
      OWNER, financeUrl("x".repeat(257), seeded.lineA), obligationBody(),
      { "idempotency-key": `oversizedw-${suffix}` },
    ));
    assert.equal(oversizedWorld.status, 400);
    const emptyWorldline = await financeCommandsPOST(authedJson(
      OWNER, `${financeUrl(seeded.worldId)}&worldlineId=%20`, obligationBody(),
      { "idempotency-key": `empty-${suffix}` },
    ));
    assert.equal(emptyWorldline.status, 400);

    assert.deepEqual(await worldWriteCounts(admin, seeded.worldId), ZERO_WRITES);
    assert.deepEqual(await worldWriteCounts(admin, other.worldId), ZERO_WRITES);
  },
);

test(
  "frozen or archived explicit targets are not writable and accept zero writes",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = adminPool();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const frozenWorld = await seedWorld(admin, suffix, { secondLineStatus: "frozen" });
    const archivedWorld = await seedWorld(admin, `arch_${suffix}`, { secondLineStatus: "archived" });
    t.after(async () => {
      await endSharedRuntimePools();
      await cleanupScopeWorlds(admin, [frozenWorld.worldId, archivedWorld.worldId]);
      await admin.end();
    });
    await endSharedRuntimePools();

    const frozen = await financeCommandsPOST(authedJson(
      OWNER, financeUrl(frozenWorld.worldId, frozenWorld.lineB), obligationBody(),
      { "idempotency-key": `frozen-${suffix}` },
    ));
    assert.equal(frozen.status, 409);
    assert.equal((await frozen.json() as { error: { code: string } }).error.code, "WORLDLINE_NOT_WRITABLE");

    const archived = await projectCommandsPOST(authedJson(
      OWNER, projectsUrl(archivedWorld.worldId, archivedWorld.lineB),
      { command: "confirm_milestone", projectId: "p", milestoneId: "m", expectedProjectVersion: 1 },
      { "idempotency-key": `archived-${suffix}` },
    ));
    assert.equal(archived.status, 409);
    assert.equal((await archived.json() as { error: { code: string } }).error.code, "WORLDLINE_NOT_WRITABLE");

    // Facts route honours the same gate.
    const archivedFacts = await factsCommandsPOST(authedJson(
      OWNER, factsUrl(archivedWorld.worldId, archivedWorld.lineB),
      { command: "grant_inventory", recordId: "r", characterInstanceId: "c", assetDefinitionId: "a", quantity: 1, sourceEventId: "e" },
      { "idempotency-key": `archivedf-${suffix}` },
    ));
    assert.equal(archivedFacts.status, 409);
    assert.equal((await archivedFacts.json() as { error: { code: string } }).error.code, "WORLDLINE_NOT_WRITABLE");

    assert.deepEqual(await worldWriteCounts(admin, frozenWorld.worldId), ZERO_WRITES);
    assert.deepEqual(await worldWriteCounts(admin, archivedWorld.worldId), ZERO_WRITES);
  },
);
