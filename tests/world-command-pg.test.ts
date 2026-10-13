/**
 * Slice 5 World Command / 跨 Record 领域事务：真实 disposable PostgreSQL
 * 验收（docs/development/CROSS-RECORD-DOMAIN-TRANSACTION.md §10.2）。
 *
 * 覆盖：两/三 Record 正向原子提交、第二 Record 写入前故障注入整体回滚
 * 零残留、同 key 同 fingerprint replay 零增长、同 key 不同 fingerprint
 * fail-closed、A↔B 竞争无死锁、共享账本冲突不静默 last-write-wins、
 * 跨 scope 写入前拒绝、serialization 有界重试、Outbox group correlation
 * 与 committed-event 唤醒、commitRelease 与 World Command 并发无死锁
 * （统一锁序回归）、稳定领域拒绝台账化与 replay。
 *
 * 运行条件：DATABASE_URL 指向 disposable scratch 集群（scratch runner
 * 负责提供）；缺省跳过。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import pg from "pg";

import {
  createPostgresRuntimeRepository,
  createPostgresWorldCommandRepository,
  type PostgresWorldCommandRepository,
  type PostgresWorldCommandRepositoryHooks,
} from "../database/postgres/public.ts";
import { listenRecordCommitted } from "../database/postgres/record-events.ts";
import { createWorldCommandService } from "../modules/application/world-command-service.ts";
import {
  createCommandFingerprint,
  createReleaseFingerprint,
  type RuntimeCommand,
  type RuntimeReleaseBundle,
} from "../modules/runtime/public.ts";
import {
  buildCommandPlan,
  WorldCommandError,
  type CommandPlan,
  type WorldCommandRequest,
  type WorldCommandScope,
} from "../modules/worldline/world-command.ts";

const adminConnectionString = process.env.DATABASE_URL;

interface FixtureIds {
  world: string;
  worldline: string;
  story: string;
  records: string[];
  scenes: Map<string, string>;
  policies: Map<string, string>;
  instances: Map<string, string>;
}

interface Fixture {
  pool: pg.Pool;
  owner: pg.Client;
  runtimeUrl: URL;
  workspaceId: string;
  ids: FixtureIds;
  scope: WorldCommandScope;
}

/** 每个 test 一个一次性数据库 + 全量迁移链（证明链可组合）。 */
async function createFixture(
  t: TestContext,
  recordCount = 3,
): Promise<Fixture> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_world_command_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const pool = new pg.Pool({ connectionString: runtimeUrl.href, max: 8 });
  pool.on("error", () => undefined);

  t.after(async () => {
    await pool.end();
    await owner.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  await owner.connect();
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    const sql = await readFile(new URL(filename, migrationDir), "utf8");
    await owner.query("BEGIN");
    try {
      await owner.query(sql);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  }

  const workspaceId = `workspace_${randomUUID()}`;
  const ids: FixtureIds = {
    world: `world_${randomUUID()}`,
    worldline: `worldline_${randomUUID()}`,
    story: `story_${randomUUID()}`,
    records: [],
    scenes: new Map(),
    policies: new Map(),
    instances: new Map(),
  };
  for (let index = 0; index < recordCount; index += 1) {
    const recordId = `record_${String.fromCharCode(97 + index)}_${randomUUID().slice(0, 8)}`;
    ids.records.push(recordId);
    ids.scenes.set(recordId, `scene_${randomUUID().slice(0, 8)}`);
    ids.policies.set(recordId, `policy_${randomUUID().slice(0, 8)}`);
    ids.instances.set(recordId, `instance_${randomUUID().slice(0, 8)}`);
  }
  // 种子经 owner（superuser，绕 RLS）；完整迁移链已把 realm_runtime
  // 收敛为最小授权，不能再经 runtime 角色建拓扑。
  await seedWorldCommandScope(owner, workspaceId, ids);
  return {
    pool,
    owner,
    runtimeUrl,
    workspaceId,
    ids,
    scope: {
      workspaceId,
      worldId: ids.world,
      worldlineId: ids.worldline,
    },
  };
}

function makeRepository(
  fixture: Fixture,
  hooks?: PostgresWorldCommandRepositoryHooks,
): PostgresWorldCommandRepository {
  return createPostgresWorldCommandRepository({
    pool: fixture.pool,
    workspaceId: fixture.workspaceId,
    hooks,
  });
}

function makeService(
  fixture: Fixture,
  hooks?: PostgresWorldCommandRepositoryHooks,
) {
  const repository = makeRepository(fixture, hooks);
  return createWorldCommandService({
    store: repository,
    planEffects: (context) => context.request.touchedRecords.map((touched) => ({
      recordId: touched.recordId,
      events: [{
        eventId: `event_${touched.recordId}_${context.request.idempotencyKey}`,
        kind: "narration.committed" as const,
        sceneId: fixture.ids.scenes.get(touched.recordId)!,
        visibilityPolicyId: fixture.ids.policies.get(touched.recordId)!,
        content: `跨 Record 提交事实：${context.request.idempotencyKey}`,
        payload: { intent: context.request.payload },
        observations: [{
          observationId: `observation_${touched.recordId}_${context.request.idempotencyKey}`,
          observerCharacterInstanceId: fixture.ids.instances.get(touched.recordId)!,
          dedupeKey: `${context.request.idempotencyKey}:${touched.recordId}:direct`,
          kind: "direct" as const,
          content: `确认知悉：${context.request.idempotencyKey}`,
        }],
        characterStateUpdates: [{
          characterInstanceId: fixture.ids.instances.get(touched.recordId)!,
          statePatch: { lastCommandKey: context.request.idempotencyKey },
        }],
      }],
      outbox: [{
        messageId: `outbox_${touched.recordId}_${context.request.idempotencyKey}`,
        dedupeKey: `${context.request.idempotencyKey}:${touched.recordId}`,
        topic: "record.event.committed",
        payload: { recordId: touched.recordId },
      }],
    })),
    clock: () => "2026-10-11T00:00:00.000Z",
  });
}

function requestFor(
  fixture: Fixture,
  key: string,
  recordIds: readonly string[],
  expectedVersion = 0,
): WorldCommandRequest {
  return {
    scope: fixture.scope,
    primaryRecordId: recordIds[0]!,
    touchedRecords: recordIds.map((recordId) => ({
      recordId,
      expectedRecordVersion: expectedVersion,
    })),
    idempotencyKey: key,
    payload: { intent: `confirm:${key}` },
  };
}

test(
  "two-Record World Command commits atomically with group correlation, heads, cursor and Outbox",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const service = makeService(fixture);

    const result = await service.executeWorldCommand(
      requestFor(fixture, "atomic-2", [recordA!, recordB!]),
    );
    assert.equal(result.state, "committed");
    assert.deepEqual(
      result.records.map((record) => record.recordId),
      [recordA, recordB].sort(),
    );

    const rows = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      groups: (await client.query("SELECT state, primary_record_id FROM world_command_groups")).rows,
      links: (await client.query(
        "SELECT record_id, record_role, expected_record_version, final_record_version FROM world_command_records ORDER BY record_id",
      )).rows,
      events: (await client.query(
        `SELECT record_id, record_version, record_ordinal, world_tick, world_ordinal,
                command_group_id, causation_command_id, turn_run_id
         FROM events ORDER BY world_ordinal`,
      )).rows,
      heads: (await client.query(
        "SELECT record_id, record_version::text, next_record_ordinal::text FROM record_heads ORDER BY record_id",
      )).rows,
      worldline: (await client.query(
        "SELECT head_tick::text, head_ordinal::text FROM worldlines",
      )).rows[0],
      outbox: (await client.query(
        "SELECT record_id, command_group_id, state FROM outbox ORDER BY record_id",
      )).rows,
      subCommands: (await client.query(
        "SELECT record_id, state, command_kind FROM command_inbox ORDER BY record_id",
      )).rows,
      subRuns: (await client.query(
        "SELECT record_id, state FROM turn_runs ORDER BY record_id",
      )).rows,
      observations: (await client.query(
        "SELECT record_id, command_group_id FROM observations ORDER BY record_id",
      )).rows,
      instanceStates: (await client.query(
        "SELECT record_id, state FROM character_instances ORDER BY record_id",
      )).rows,
    }));

    assert.equal(rows.groups.length, 1);
    assert.equal(rows.groups[0]!.state, "committed");
    assert.equal(rows.links.length, 2);
    assert.deepEqual(
      rows.links.map((link) => [link.record_role, Number(link.expected_record_version), Number(link.final_record_version)]),
      [["primary", 0, 1], ["touched", 0, 1]],
    );
    // 每 Record 一条事件；世界游标跨 Record 连续（worldline head 100/0 起）。
    assert.equal(rows.events.length, 2);
    assert.deepEqual(
      rows.events.map((event) => [event.world_ordinal, event.command_group_id !== null]),
      [["1", true], ["2", true]],
    );
    for (const event of rows.events) {
      assert.ok(event.causation_command_id, "事件必须关联 per-Record 子命令");
      assert.equal(event.turn_run_id, event.causation_command_id);
    }
    assert.deepEqual(
      rows.heads.map((head) => [head.record_version, head.next_record_ordinal]),
      [["1", "8"], ["1", "8"]],
    );
    assert.deepEqual(rows.worldline, { head_tick: "100", head_ordinal: "2" });
    assert.equal(rows.outbox.length, 2);
    assert.ok(rows.outbox.every((message) => message.command_group_id !== null));
    assert.deepEqual(
      rows.subCommands.map((row) => [row.state, row.command_kind]),
      [["completed", "world.command"], ["completed", "world.command"]],
    );
    assert.deepEqual(
      rows.subRuns.map((row) => row.state),
      ["completed", "completed"],
    );
    // Observations 与 character state 随同一事务落库并携带 group correlation。
    assert.equal(rows.observations.length, 2);
    assert.ok(rows.observations.every((row) => row.command_group_id !== null));
    assert.ok(
      rows.instanceStates.every(
        (row) => (row.state as { lastCommandKey?: string }).lastCommandKey === "atomic-2",
      ),
    );
    // player-safe 结果不含内部身份。
    assert.equal(JSON.stringify(result).includes("wcs_"), false);
  },
);

test(
  "three-Record command is deterministic regardless of touched input order",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 3);
    const [a, b, c] = fixture.ids.records;
    const service = makeService(fixture);

    const shuffled = requestFor(fixture, "atomic-3", [c!, a!, b!]);
    const result = await service.executeWorldCommand(shuffled);
    assert.equal(result.state, "committed");

    const events = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => (
      await client.query(
        "SELECT record_id, world_ordinal::text FROM events ORDER BY world_ordinal",
      )
    ).rows);
    // 游标按 record_id 升序分配——与请求输入顺序无关。
    const sorted = [a!, b!, c!].sort();
    assert.deepEqual(
      events.map((event) => event.record_id),
      sorted,
    );
    assert.deepEqual(
      events.map((event) => event.world_ordinal),
      ["1", "2", "3"],
    );
    // player-safe 结果同样按排序后的 Record 顺序。
    assert.deepEqual(
      result.records.map((record) => record.recordId),
      sorted,
    );
  },
);

test(
  "failure injection before the second Record rolls back everything with zero residue",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const repository = makeRepository(fixture, {
      async beforeRecordEventsWrite(_client, recordId, index) {
        if (index === 1) {
          throw new Error(`injected failure before ${recordId}`);
        }
      },
    });
    const request = requestFor(fixture, "rollback-1", [recordA!, recordB!]);
    const scopes = await repository.readRecordScopes([recordA!, recordB!]);
    const cursor = await repository.readWorldlineCursor(fixture.scope.worldlineId);
    const plan = buildCommandPlan({
      request,
      effects: scopes.map((scope) => ({
        recordId: scope.recordId,
        events: [{
          eventId: `event_${scope.recordId}_rollback`,
          kind: "narration.committed" as const,
          sceneId: fixture.ids.scenes.get(scope.recordId)!,
          visibilityPolicyId: fixture.ids.policies.get(scope.recordId)!,
          payload: { intent: "rollback" },
        }],
        outbox: [{
          messageId: `outbox_${scope.recordId}_rollback`,
          dedupeKey: `rollback:${scope.recordId}`,
          topic: "record.event.committed",
          payload: {},
        }],
      })),
      expectedWorldCursor: cursor!,
    });
    await assert.rejects(() => repository.commitWorldCommand(plan, "2026-10-11T00:00:00.000Z"), /injected failure/);

    const residue = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      groups: (await client.query("SELECT count(*)::int AS n FROM world_command_groups")).rows[0]!.n,
      links: (await client.query("SELECT count(*)::int AS n FROM world_command_records")).rows[0]!.n,
      commands: (await client.query("SELECT count(*)::int AS n FROM command_inbox")).rows[0]!.n,
      runs: (await client.query("SELECT count(*)::int AS n FROM turn_runs")).rows[0]!.n,
      events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
      observations: (await client.query("SELECT count(*)::int AS n FROM observations")).rows[0]!.n,
      receipts: (await client.query("SELECT count(*)::int AS n FROM action_receipts")).rows[0]!.n,
      outbox: (await client.query("SELECT count(*)::int AS n FROM outbox")).rows[0]!.n,
      heads: (await client.query(
        "SELECT record_version::text AS version, next_record_ordinal::text AS ordinal FROM record_heads ORDER BY record_id",
      )).rows,
      worldline: (await client.query("SELECT head_ordinal::text AS ordinal FROM worldlines")).rows[0],
    }));
    assert.deepEqual(
      residue,
      {
        groups: 0,
        links: 0,
        commands: 0,
        runs: 0,
        events: 0,
        observations: 0,
        receipts: 0,
        outbox: 0,
        heads: [{ version: "0", ordinal: "7" }, { version: "0", ordinal: "7" }],
        worldline: { ordinal: "0" },
      },
      "任何一步失败必须整体回滚、零残留",
    );
  },
);

test(
  "same key + same fingerprint replays without new writes; same key + different fingerprint fails closed",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const service = makeService(fixture);
    const request = requestFor(fixture, "replay-1", [recordA!, recordB!]);

    const first = await service.executeWorldCommand(request);
    assert.equal(first.state, "committed");
    const countsAfterFirst = await writeCounts(fixture);

    // replay：head 已推进（请求仍声明 expected 0）——台账短路返回同一结果。
    const replay = await service.executeWorldCommand(request);
    assert.deepEqual(replay, first);
    assert.deepEqual(await writeCounts(fixture), countsAfterFirst, "replay 零新写入");

    // 同 key 不同 payload → IDEMPOTENCY_KEY_REUSE，旧结果不变。
    await assert.rejects(
      () => service.executeWorldCommand({ ...request, payload: { intent: "tampered" } }),
      (error: unknown) => error instanceof WorldCommandError
        && error.code === "IDEMPOTENCY_KEY_REUSE",
    );
    assert.deepEqual(await writeCounts(fixture), countsAfterFirst, "key 复用拒绝零写入");

    // 台账读回与 replay 结果一致（审计面）。
    const repository = makeRepository(fixture);
    const ledger = await repository.loadCommandGroup({
      worldlineId: fixture.scope.worldlineId,
      key: "replay-1",
    });
    assert.equal(ledger?.result.state, "committed");
    assert.equal(ledger?.result.commandGroupId, first.commandGroupId);
  },
);

test(
  "A→B and B→A concurrent commands serialize without deadlock; loser gets WRITE_CONFLICT",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const repository = makeRepository(fixture);

    const buildFor = async (key: string, recordIds: readonly string[]): Promise<CommandPlan> => {
      const request = requestFor(fixture, key, recordIds);
      const cursor = await repository.readWorldlineCursor(fixture.scope.worldlineId);
      return buildCommandPlan({
        request,
        effects: recordIds.map((recordId) => ({
          recordId,
          events: [{
            eventId: `event_${recordId}_${key}`,
            kind: "narration.committed" as const,
            sceneId: fixture.ids.scenes.get(recordId)!,
            visibilityPolicyId: fixture.ids.policies.get(recordId)!,
            payload: { intent: key },
          }],
        })),
        expectedWorldCursor: cursor!,
      });
    };

    // 输入顺序相反；排序归一后锁序相同，竞争只产生成功+冲突，不死锁。
    const [planAB, planBA] = await Promise.all([
      buildFor("race-ab", [recordA!, recordB!]),
      buildFor("race-ba", [recordB!, recordA!]),
    ]);
    const settled = await Promise.allSettled([
      repository.commitWorldCommand(planAB, "2026-10-11T00:00:00.000Z"),
      repository.commitWorldCommand(planBA, "2026-10-11T00:00:01.000Z"),
    ]);

    const committed = settled.filter((outcome) => outcome.status === "fulfilled");
    const conflicts = settled.filter((outcome) => outcome.status === "rejected");
    assert.equal(committed.length, 1, "恰好一个命令提交成功");
    assert.equal(conflicts.length, 1, "另一个命令必须冲突而非死锁/双写");
    const rejection = (conflicts[0] as PromiseRejectedResult).reason;
    assert.ok(rejection instanceof WorldCommandError);
    assert.equal(rejection.code, "WRITE_CONFLICT");
    assert.equal(rejection.retryable, true);

    const state = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      groups: (await client.query("SELECT count(*)::int AS n FROM world_command_groups")).rows[0]!.n,
      events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
      worldline: (await client.query("SELECT head_ordinal::text AS ordinal FROM worldlines")).rows[0],
      heads: (await client.query(
        "SELECT record_version::text AS version FROM record_heads ORDER BY record_id",
      )).rows,
    }));
    assert.equal(state.groups, 1);
    assert.equal(state.events, 2);
    assert.deepEqual(state.worldline, { ordinal: "2" });
    assert.deepEqual(state.heads, [{ version: "1" }, { version: "1" }]);
  },
);

test(
  "two commands competing for one ledger resource never last-write-wins",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const repository = makeRepository(fixture);

    // 共享资金：recordA 的 instance 持有 5 枚 coin；两条命令各扣 3。
    await seedCoin(fixture, recordA!, 5);

    const buildSpend = async (key: string): Promise<CommandPlan> => {
      const cursor = await repository.readWorldlineCursor(fixture.scope.worldlineId);
      const scopes = await repository.readRecordScopes([recordA!, recordB!]);
      const headOf = (recordId: string) =>
        scopes.find((scope) => scope.recordId === recordId)!.recordVersion;
      return buildCommandPlan({
        request: {
          scope: fixture.scope,
          primaryRecordId: recordA!,
          touchedRecords: [
            { recordId: recordA!, expectedRecordVersion: headOf(recordA!) },
            { recordId: recordB!, expectedRecordVersion: headOf(recordB!) },
          ],
          idempotencyKey: key,
          payload: { spend: 3 },
        },
        effects: [
          {
            recordId: recordA!,
            events: [{
              eventId: `event_${key}_spend`,
              kind: "action.transaction.committed",
              sceneId: fixture.ids.scenes.get(recordA!)!,
              visibilityPolicyId: fixture.ids.policies.get(recordA!)!,
              payload: { spend: 3 },
              actionState: {
                receiptId: `receipt_${key}`,
                transactionId: `txn_${key}`,
                actorCharacterInstanceId: fixture.ids.instances.get(recordA!)!,
                callFingerprint: `call_${key}`,
                receipt: { kind: "spend", amount: 3 },
                costs: [{ resourceId: "asset:asset_coin", amount: 3 }],
                effects: [],
              },
            }],
          },
          {
            recordId: recordB!,
            events: [{
              eventId: `event_${key}_notice`,
              kind: "narration.committed",
              sceneId: fixture.ids.scenes.get(recordB!)!,
              visibilityPolicyId: fixture.ids.policies.get(recordB!)!,
              payload: { notice: key },
            }],
          },
        ],
        expectedWorldCursor: cursor!,
      });
    };

    const first = await repository.commitWorldCommand(
      await buildSpend("spend-1"),
      "2026-10-11T00:00:00.000Z",
    );
    assert.equal(first.state, "committed");

    // 第二条命令重读 head/cursor 后重建计划（无 WRITE_CONFLICT），但余额
    // 不足——锁内领域守卫 fail-closed，整体回滚，零部分写入。
    const replanned = await buildSpend("spend-2");
    await assert.rejects(
      () => repository.commitWorldCommand(replanned, "2026-10-11T00:00:01.000Z"),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === "RESOURCE_UNAVAILABLE",
    );

    const state = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      balance: (await client.query(
        "SELECT quantity::text AS quantity FROM character_assets WHERE record_id = $1",
        [recordA],
      )).rows[0],
      groups: (await client.query("SELECT count(*)::int AS n FROM world_command_groups")).rows[0]!.n,
      receipts: (await client.query("SELECT count(*)::int AS n FROM action_receipts")).rows[0]!.n,
      events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
    }));
    assert.deepEqual(state.balance, { quantity: "2" }, "恰好扣减一次");
    assert.equal(state.groups, 1);
    assert.equal(state.receipts, 1);
    assert.equal(state.events, 2);
  },
);

test(
  "cross-scope commands are rejected before any write with zero topology residue",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA] = fixture.ids.records;

    // 另一 worldline 的 Record。
    const foreign = await seedForeignRecord(fixture);
    const service = makeService(fixture);

    await assert.rejects(
      () => service.executeWorldCommand({
        scope: fixture.scope,
        primaryRecordId: recordA!,
        touchedRecords: [
          { recordId: recordA!, expectedRecordVersion: 0 },
          { recordId: foreign.recordId, expectedRecordVersion: 0 },
        ],
        idempotencyKey: "cross-scope-1",
        payload: {},
      }),
      (error: unknown) => error instanceof WorldCommandError
        && error.code === "WORLD_COMMAND_SCOPE_MISMATCH",
    );

    // repository 层同样 fail-closed（绕过 service 的伪造计划）。
    const repository = makeRepository(fixture);
    const cursor = await repository.readWorldlineCursor(fixture.scope.worldlineId);
    const forged = buildCommandPlan({
      request: {
        scope: fixture.scope,
        primaryRecordId: recordA!,
        touchedRecords: [
          { recordId: recordA!, expectedRecordVersion: 0 },
          { recordId: foreign.recordId, expectedRecordVersion: 0 },
        ],
        idempotencyKey: "cross-scope-2",
        payload: {},
      },
      effects: [recordA!, foreign.recordId].map((recordId) => ({
        recordId,
        events: [{
          eventId: `event_${recordId}_forged`,
          kind: "narration.committed" as const,
          sceneId: fixture.ids.scenes.get(recordId) ?? foreign.sceneId,
          visibilityPolicyId: fixture.ids.policies.get(recordId) ?? foreign.policyId,
          payload: {},
        }],
      })),
      expectedWorldCursor: cursor!,
    });
    await assert.rejects(
      () => repository.commitWorldCommand(forged, "2026-10-11T00:00:00.000Z"),
      (error: unknown) => error instanceof WorldCommandError
        && error.code === "WORLD_COMMAND_SCOPE_MISMATCH",
    );

    const residue = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      groups: (await client.query("SELECT count(*)::int AS n FROM world_command_groups")).rows[0]!.n,
      links: (await client.query("SELECT count(*)::int AS n FROM world_command_records")).rows[0]!.n,
      events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
    }));
    assert.deepEqual(residue, { groups: 0, links: 0, events: 0 }, "跨 scope 拒绝零拓扑残留");
  },
);

test(
  "serialization failure retries the whole transaction bounded and commits at most once",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    let injected = 0;
    const repository = makeRepository(fixture, {
      async beforeRecordEventsWrite() {
        injected += 1;
        if (injected === 1) {
          const error = new Error("simulated serialization failure");
          (error as { code?: string }).code = "40001";
          throw error;
        }
      },
    });
    const service = createWorldCommandService({
      store: repository,
      planEffects: (context) => context.request.touchedRecords.map((touched) => ({
        recordId: touched.recordId,
        events: [{
          eventId: `event_${touched.recordId}_retry`,
          kind: "narration.committed" as const,
          sceneId: fixture.ids.scenes.get(touched.recordId)!,
          visibilityPolicyId: fixture.ids.policies.get(touched.recordId)!,
          content: "重试后恰好提交一次。",
          payload: {},
        }],
      })),
      clock: () => "2026-10-11T00:00:00.000Z",
    });
    const result = await service.executeWorldCommand(
      requestFor(fixture, "retry-1", [recordA!, recordB!]),
    );
    assert.equal(result.state, "committed");
    assert.ok(injected >= 2, "第一次尝试注入失败，重试完整事务后成功");

    const counts = await writeCounts(fixture);
    assert.equal(counts.groups, 1);
    assert.equal(counts.events, 2);

    // 持续 serialization 失败超过上限 → 稳定可重试错误，零写入。
    const alwaysFails = makeRepository(fixture, {
      async beforeRecordEventsWrite() {
        const error = new Error("permanent serialization failure");
        (error as { code?: string }).code = "40P01";
        throw error;
      },
    });
    const failingService = createWorldCommandService({
      store: alwaysFails,
      planEffects: (context) => context.request.touchedRecords.map((touched) => ({
        recordId: touched.recordId,
        events: [{
          eventId: `event_${touched.recordId}_retry_fail`,
          kind: "narration.committed" as const,
          sceneId: fixture.ids.scenes.get(touched.recordId)!,
          visibilityPolicyId: fixture.ids.policies.get(touched.recordId)!,
          payload: {},
        }],
      })),
      clock: () => "2026-10-11T00:00:00.000Z",
    });
    await assert.rejects(
      () => failingService.executeWorldCommand(
        // 第一条命令已推进 head——按真实状态声明 expected（重读后重试）。
        requestFor(fixture, "retry-exhausted", [recordA!, recordB!], 1),
      ),
      (error: unknown) => error instanceof WorldCommandError
        && error.code === "WORLD_COMMAND_COMMIT_UNAVAILABLE"
        && error.retryable === true,
    );
    const after = await writeCounts(fixture);
    assert.equal(after.groups, 1, "重试耗尽不得留下第二条台账");
    assert.equal(after.events, 2);
  },
);

test(
  "touched Records receive committed-event wakes and Outbox rows stay worker-claimable with group correlation",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const service = makeService(fixture);

    // 被影响 Record 的 LISTEN 唤醒源（commit 前建立）。
    const wakeA = await listenRecordCommitted(fixture.runtimeUrl.href, {
      workspaceId: fixture.workspaceId,
      recordId: recordA!,
    });
    const wakeB = await listenRecordCommitted(fixture.runtimeUrl.href, {
      workspaceId: fixture.workspaceId,
      recordId: recordB!,
    });
    t.after(async () => {
      await wakeA.close();
      await wakeB.close();
    });

    const result = await service.executeWorldCommand(
      requestFor(fixture, "wake-1", [recordA!, recordB!]),
    );
    assert.equal(result.state, "committed");
    assert.equal(
      await withTimeout(wakeA.wait(), 5_000),
      true,
      "primary Record 必须收到 committed-event 唤醒",
    );
    assert.equal(
      await withTimeout(wakeB.wait(), 5_000),
      true,
      "被触及的非 primary Record 必须收到唤醒",
    );

    // 既有 Outbox worker 路径可见并可 claim/settle（turn_run_id 关联
    // 子命令台账），group correlation 可查询。
    const runtime = createPostgresRuntimeRepository({
      pool: fixture.pool,
      workspaceId: fixture.workspaceId,
      mapFormalEvent() {
        throw new Error("not needed for outbox settlement");
      },
    });
    const messages = await runtime.listOutboxMessages();
    assert.equal(messages.length, 2);
    const claimed = await runtime.claimOutbox({
      messageId: messages[0]!.messageId,
      expectedRevision: messages[0]!.revision,
      now: "2026-10-11T00:01:00.000Z",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-10-11T00:01:30.000Z",
    });
    assert.equal(claimed.state, "delivering");
    const delivered = await runtime.settleOutbox({
      messageId: claimed.messageId,
      expectedRevision: claimed.revision,
      leaseOwner: "worker-1",
      now: "2026-10-11T00:01:05.000Z",
      outcome: "delivered",
    });
    assert.equal(delivered.state, "delivered");

    const correlation = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => (
      await client.query(
        "SELECT count(*)::int AS n FROM outbox WHERE command_group_id = $1",
        [result.commandGroupId],
      )
    ).rows[0]);
    assert.equal(correlation!.n, 2, "Outbox 行可按 Command Group correlation 追溯");
  },
);

test(
  "single-Record commitRelease and a multi-Record World Command never deadlock (unified lock order)",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;

    // 单 Record 回合推进到 releasing。
    const runtime = createPostgresRuntimeRepository({
      pool: fixture.pool,
      workspaceId: fixture.workspaceId,
      mapFormalEvent({ draft }) {
        return {
          sceneId: fixture.ids.scenes.get(recordA!)!,
          visibilityPolicyId: fixture.ids.policies.get(recordA!)!,
          eventKind: "utterance.committed" as const,
          content: (draft.payload as { content: string }).content,
        };
      },
    });
    const command: RuntimeCommand<{ content: string }> = {
      commandType: "player.utterance",
      recordId: recordA!,
      expectedRecordVersion: 0,
      idempotencyKey: "turn-vs-command",
      actorId: null,
      payload: { content: "单 Record 回合。" },
    };
    const accepted = await runtime.acceptCommand({
      turnId: "turn-vs-command",
      command,
      commandFingerprint: createCommandFingerprint(command),
      now: "2026-10-11T00:00:00.000Z",
    });
    let run = await runtime.advanceTurn({
      turnId: accepted.run.turnId,
      expectedRevision: accepted.run.revision,
      expectedState: "accepted",
      nextState: "planning",
      now: "2026-10-11T00:00:01.000Z",
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "planning",
      nextState: "drafting",
      plan: { planId: "plan-1", body: {}, createdAt: "2026-10-11T00:00:01.000Z" },
      now: "2026-10-11T00:00:02.000Z",
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "drafting",
      nextState: "validating",
      candidate: {
        candidateId: "candidate-1",
        body: {},
        createdAt: "2026-10-11T00:00:02.000Z",
        draftingAttempt: 1,
      },
      now: "2026-10-11T00:00:03.000Z",
    });
    run = await runtime.advanceTurn({
      turnId: run.turnId,
      expectedRevision: run.revision,
      expectedState: "validating",
      nextState: "releasing",
      validation: {
        validationId: "validation-1",
        body: {},
        createdAt: "2026-10-11T00:00:03.000Z",
      },
      now: "2026-10-11T00:00:04.000Z",
    });
    const bundle: RuntimeReleaseBundle<{ content: string }, never> = {
      formalEvents: [{
        eventId: "event_turn_single",
        kind: "utterance.committed",
        payload: { content: "单 Record 回合。" },
      }],
      outbox: [],
    };

    // 并发：单 Record commitRelease × 跨 Record World Command（同 worldline、
    // 共享 recordA）。统一锁序（worldlines → record_heads）下二者串行，
    // 恰好一方成功，另一方稳定冲突，绝不死锁。
    const repository = makeRepository(fixture);
    const cursor = await repository.readWorldlineCursor(fixture.scope.worldlineId);
    const worldPlan = buildCommandPlan({
      request: requestFor(fixture, "turn-race", [recordA!, recordB!]),
      effects: [recordA!, recordB!].map((recordId) => ({
        recordId,
        events: [{
          eventId: `event_${recordId}_turn_race`,
          kind: "narration.committed" as const,
          sceneId: fixture.ids.scenes.get(recordId)!,
          visibilityPolicyId: fixture.ids.policies.get(recordId)!,
          payload: { intent: "turn-race" },
        }],
      })),
      expectedWorldCursor: cursor!,
    });

    const settled = await Promise.allSettled([
      runtime.commitRelease({
        turnId: run.turnId,
        expectedRevision: run.revision,
        releaseFingerprint: createReleaseFingerprint(bundle),
        bundle,
        now: "2026-10-11T00:00:05.000Z",
      }),
      repository.commitWorldCommand(worldPlan, "2026-10-11T00:00:05.000Z"),
    ]);

    const succeeded = settled.filter((outcome) => outcome.status === "fulfilled");
    const failed = settled.filter((outcome) => outcome.status === "rejected");
    assert.equal(succeeded.length, 1, "恰好一条路径提交成功");
    assert.equal(failed.length, 1, "另一条路径稳定冲突（无死锁、无双写）");
    const reason = (failed[0] as PromiseRejectedResult).reason as { code?: string };
    assert.ok(
      reason.code === "WRITE_CONFLICT" || reason.code === "RECORD_VERSION_CONFLICT",
      `冲突码必须是 WRITE_CONFLICT 或 RECORD_VERSION_CONFLICT，实际 ${reason.code}`,
    );

    const state = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      headA: (await client.query(
        "SELECT record_version::text AS version FROM record_heads WHERE record_id = $1",
        [recordA],
      )).rows[0],
      worldline: (await client.query("SELECT head_ordinal::text AS ordinal FROM worldlines")).rows[0],
    }));
    assert.deepEqual(state.headA, { version: "1" });
    assert.ok(
      state.worldline!.ordinal === "1" || state.worldline!.ordinal === "2",
      "worldline head 必须与唯一胜者一致",
    );
  },
);

test(
  "stable domain rejections are persisted once and replay the same rejection",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const fixture = await createFixture(t, 2);
    const [recordA, recordB] = fixture.ids.records;
    const repository = makeRepository(fixture);
    const service = createWorldCommandService({
      store: repository,
      planEffects() {
        throw new WorldCommandError("WORLD_COMMAND_DOMAIN_RULE", "预算不足。");
      },
      clock: () => "2026-10-11T00:00:00.000Z",
    });
    const request = requestFor(fixture, "reject-1", [recordA!, recordB!]);

    const rejected = await service.executeWorldCommand(request);
    assert.deepEqual(rejected, {
      commandGroupId: rejected.commandGroupId,
      state: "rejected",
      records: [],
      rejection: { code: "WORLD_COMMAND_DOMAIN_RULE", message: "预算不足。" },
    });

    // replay：同一拒绝结果，台账不增长。
    const replay = await service.executeWorldCommand(request);
    assert.deepEqual(replay, rejected);

    // 同 key 不同 fingerprint → fail-closed。
    await assert.rejects(
      () => service.executeWorldCommand({ ...request, payload: { intent: "other" } }),
      (error: unknown) => error instanceof WorldCommandError
        && error.code === "IDEMPOTENCY_KEY_REUSE",
    );

    const state = await inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
      groups: (await client.query(
        "SELECT state, rejection_code FROM world_command_groups",
      )).rows,
      events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
      links: (await client.query("SELECT count(*)::int AS n FROM world_command_records")).rows[0]!.n,
    }));
    assert.deepEqual(state.groups, [{ state: "rejected", rejection_code: "WORLD_COMMAND_DOMAIN_RULE" }]);
    assert.equal(state.events, 0);
    assert.equal(state.links, 0);
  },
);

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

async function writeCounts(fixture: Fixture) {
  return inWorkspace(fixture.pool, fixture.workspaceId, async (client) => ({
    groups: (await client.query("SELECT count(*)::int AS n FROM world_command_groups")).rows[0]!.n,
    links: (await client.query("SELECT count(*)::int AS n FROM world_command_records")).rows[0]!.n,
    commands: (await client.query("SELECT count(*)::int AS n FROM command_inbox")).rows[0]!.n,
    runs: (await client.query("SELECT count(*)::int AS n FROM turn_runs")).rows[0]!.n,
    events: (await client.query("SELECT count(*)::int AS n FROM events")).rows[0]!.n,
    observations: (await client.query("SELECT count(*)::int AS n FROM observations")).rows[0]!.n,
    receipts: (await client.query("SELECT count(*)::int AS n FROM action_receipts")).rows[0]!.n,
    outbox: (await client.query("SELECT count(*)::int AS n FROM outbox")).rows[0]!.n,
  }));
}

async function seedCoin(
  fixture: Fixture,
  recordId: string,
  quantity: number,
): Promise<void> {
  const client = fixture.owner;
  await client.query(
    `INSERT INTO asset_definitions (
       workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable
     ) VALUES ($1, $2, 'asset_coin', 'coin', 'Coin', 'test-pack', true)
     ON CONFLICT DO NOTHING`,
    [fixture.workspaceId, fixture.ids.world],
  );
  await client.query(
    `INSERT INTO character_assets (
       workspace_id, world_id, worldline_id, record_id,
       character_instance_id, asset_definition_id, quantity
     ) VALUES ($1, $2, $3, $4, $5, 'asset_coin', $6)`,
    [
      fixture.workspaceId,
      fixture.ids.world,
      fixture.ids.worldline,
      recordId,
      fixture.ids.instances.get(recordId)!,
      quantity,
    ],
  );
}

async function seedForeignRecord(
  fixture: Fixture,
): Promise<{ recordId: string; sceneId: string; policyId: string }> {
  const recordId = `record_foreign_${randomUUID().slice(0, 8)}`;
  const sceneId = `scene_foreign_${randomUUID().slice(0, 8)}`;
  const policyId = `policy_foreign_${randomUUID().slice(0, 8)}`;
  const worldlineId = `worldline_foreign_${randomUUID().slice(0, 8)}`;
  const storyId = `story_foreign_${randomUUID().slice(0, 8)}`;
  const client = fixture.owner;
  {
    await client.query(
      "INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Foreign', 100, 0)",
      [fixture.workspaceId, fixture.ids.world, worldlineId],
    );
    await client.query(
      "INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Foreign', 'active', 0, 0)",
      [fixture.workspaceId, fixture.ids.world, worldlineId, storyId],
    );
    await client.query(
      "INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Foreign', 'active', 0, 0)",
      [fixture.workspaceId, fixture.ids.world, worldlineId, storyId, recordId],
    );
    await client.query(
      "INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Foreign', 'active', 0, 0)",
      [fixture.workspaceId, fixture.ids.world, worldlineId, recordId, sceneId],
    );
    await client.query(
      "INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind) VALUES ($1, $2, $3, $4, $5, 'public', 'public')",
      [fixture.workspaceId, fixture.ids.world, worldlineId, recordId, policyId],
    );
    await client.query(
      "INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal) VALUES ($1, $2, $3, $4, 0, 7)",
      [fixture.workspaceId, fixture.ids.world, worldlineId, recordId],
    );
  }
  return { recordId, sceneId, policyId };
}

async function seedWorldCommandScope(
  client: pg.Client,
  workspaceId: string,
  ids: FixtureIds,
): Promise<void> {
  {
    await client.query(
      "INSERT INTO workspaces (id, name) VALUES ($1, 'World Command Test') ON CONFLICT (id) DO NOTHING",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, 'Test World', 'test-calendar')",
      [workspaceId, ids.world],
    );
    await client.query(
      "INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Origin', 100, 0)",
      [workspaceId, ids.world, ids.worldline],
    );
    await client.query(
      "INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Story', 'active', 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.story],
    );
    for (const recordId of ids.records) {
      await client.query(
        "INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Record', 'active', 0, 0)",
        [workspaceId, ids.world, ids.worldline, ids.story, recordId],
      );
      await client.query(
        "INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Scene', 'active', 0, 0)",
        [workspaceId, ids.world, ids.worldline, recordId, ids.scenes.get(recordId)],
      );
      const definitionId = `definition_${recordId}`;
      const continuityId = `continuity_${recordId}`;
      await client.query(
        "INSERT INTO character_definitions (workspace_id, world_id, id, display_name) VALUES ($1, $2, $3, 'Witness')",
        [workspaceId, ids.world, definitionId],
      );
      await client.query(
        "INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 0, 0)",
        [workspaceId, ids.world, ids.worldline, definitionId, continuityId, `witness_${recordId}`],
      );
      await client.query(
        "INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)",
        [workspaceId, ids.world, ids.worldline, recordId, continuityId, ids.instances.get(recordId)],
      );
      await client.query(
        "INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind) VALUES ($1, $2, $3, $4, $5, 'public', 'public')",
        [workspaceId, ids.world, ids.worldline, recordId, ids.policies.get(recordId)],
      );
      await client.query(
        "INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal) VALUES ($1, $2, $3, $4, 0, 7)",
        [workspaceId, ids.world, ids.worldline, recordId],
      );
    }
  }
}

async function inWorkspace<T>(
  pool: pg.Pool,
  workspaceId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | false> {
  return Promise.race([
    promise,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("World Command tests require a loopback PostgreSQL URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
