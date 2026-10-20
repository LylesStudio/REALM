/**
 * Base provider operator lifecycle · 端到端 disposable PostgreSQL 验收
 *（Slice 5 最终 vertical slice；共享 runner 注入的 realm_dev scratch 集群）。
 *
 * 覆盖（引擎升级计划 Slice 5 验收项）：
 * 1. base genesis：engine-owned 内容、无安装任何 RealmWorld、无 trust
 *    配置要求——binding 恒为 base 哨兵；
 * 2. 一个真实玩家回合（executeTurn → 正式事件落库）；
 * 3. save Record 为 `.realm` v2（mode=base、world=null）；
 * 4. 安装签名 RealmWorld 包（engineCompat.baseRange 兼容活动 base 版本）；
 * 5. base→world-bound 升级路径：把 base 存档 restore 到已安装世界，
 *    兼容 → 201 且 Record 绑定升级为目标版本；活动 base 版本变化
 *   （operator switch）后包不再兼容 → restore fail-closed 稳定码
 *    BASE_VERSION_INCOMPATIBLE 且零残留；rollback 后 restore 恢复可用；
 *    base 记录全程可继续游玩/存档（continue 语义不受包兼容闸影响）。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { createBaseInstantiationPlan } from "../modules/world-transfer/base-content.ts";
import { ENGINE_BASE_CONTENT_VERSION } from "../modules/world-transfer/engine-base.ts";
import {
  parseRealmRuntimeSaveArchive,
} from "../modules/world-transfer/realm-runtime-save.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import {
  readRealmWorldTrustStoreFile,
  resolveEngineBaseActiveVersion,
  rollbackRealmWorldTrustStoreBase,
  switchRealmWorldTrustStoreBase,
  writeRealmWorldTrustStoreFileAtomic,
  activateRealmWorldTrustStoreBase,
} from "../modules/world-transfer/realmworld-trust-store.ts";
import {
  createPostgresRuntimeRepository,
} from "../database/postgres/public.ts";
import {
  executeTurn,
  type JsonValue,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { POST as instantiateRealmWorld } from "../app/api/realmworld/instantiate/route.ts";
import { POST as saveRuntimeRecord } from "../app/api/record/save/route.ts";
import { POST as restoreRuntimeRecord } from "../app/api/record/restore/route.ts";
import { GET as baseProviderStatus } from "../app/api/base-provider/status/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { sessionProofFor } from "./helpers/session-proof.ts";
import { installSignedRealmWorldFixture } from "./helpers/realmworld-package-fixture.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = LOCAL_RECORD_SCOPE.workspaceId;
const PRINCIPAL = LOCAL_RECORD_SCOPE.principalId;
const FIXTURE_WORLD = "world_base_lifecycle_fixture";
const FIXTURE_VERSION = "1.0.0";

const BASE_PARAMETERS = {
  world: { name: "Slice5 雾港", era: "长雾纪元 9 年", summary: "灯塔再次熄灭。" },
  language: "zh-CN",
  style: "classical",
  story: { title: "再熄之夜", premise: "守灯人又回来了。" },
  record: { title: "回归第一夜" },
  playerRole: "归来的守灯人",
  playerStance: "player",
  characters: [
    { displayName: "阿汐", role: "潮汐记录员", summary: "仍在记录涨潮。" },
  ],
  scene: {
    title: "旧灯塔",
    location: "灯塔顶层",
    weather: "浓雾",
    tension: "灯油将尽",
    displayTime: "子时",
    objective: "再次点灯",
  },
  opening: "雾又把灯塔吞到只剩一圈昏黄。",
  goals: ["base.first-narration"],
} as const;

function tickingClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 9, 11, 6, 0, second++)).toISOString();
}

test(
  "base provider lifecycle: base genesis → turn → save → install world → upgrade restore → base change fail-closed → rollback continue",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    // Explicit server backup capability for this isolated fixture only.
    const previousBackupOperators = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = PRINCIPAL;
    try {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    ownerPool.on("error", () => {});
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 4 });
    runtimePool.on("error", () => {});
    // Imported route handlers own an additional cached pool, not runtimePool.
    t.after(endSharedRuntimePools);
    const dataHome = await mkdtemp(join(tmpdir(), "realm-base-lifecycle-"));
    const installRoot = join(dataHome, "installed");
    const trustStorePath = join(dataHome, "trust-store.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyPair = {
      privateKey,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const previousInstallRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT;
    const previousWorkerInstallRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    const previousTrustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
    const restoreEnv = () => {
      process.env.REALM_REALMWORLD_INSTALL_ROOT = installRoot;
      process.env.REALM_REALMWORLD_TRUST_STORE = trustStorePath;
    };
    const clearEnv = () => {
      delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
      delete process.env.REALM_REALMWORLD_TRUST_STORE;
    };
    let createdWorldId: string | null = null;
    let createdRecordId: string | null = null;
    t.after(async () => {
      if (previousInstallRoot === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      else process.env.REALM_REALMWORLD_INSTALL_ROOT = previousInstallRoot;
      if (previousWorkerInstallRoot === undefined) delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
      else process.env.REALM_GOAL_WORKER_INSTALL_ROOT = previousWorkerInstallRoot;
      if (previousTrustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
      else process.env.REALM_REALMWORLD_TRUST_STORE = previousTrustStore;
      await rm(dataHome, { recursive: true, force: true });
      // 定向清理由本测试引入的可跨套件可见行（集群本身一次性销毁）。
      if (createdRecordId !== null) {
        await ownerPool.query(
          `DELETE FROM goal_assessment_jobs WHERE workspace_id = $1 AND record_id = $2`,
          [WS, createdRecordId],
        );
        // Bound Goal history belongs to disposable cluster teardown, not DELETE.
        await ownerPool.query(
          `DELETE FROM realm_durable_jobs WHERE workspace_id = $1 AND record_id = $2`,
          [WS, createdRecordId],
        );
      }
      // first-night 行（genesis 物化）对本测试的世界做定向清理。
      await ownerPool.query(
        `DELETE FROM record_first_nights
         WHERE workspace_id = $1 AND world_id = ANY ($2)`,
        [WS, [FIXTURE_WORLD, createdWorldId].filter((id): id is string => id !== null)],
      );
      await ownerPool.query(
        `DELETE FROM outbox WHERE workspace_id = $1 AND world_id = ANY ($2)`,
        [WS, [FIXTURE_WORLD, createdWorldId].filter((id): id is string => id !== null)],
      );
      await runtimePool.end();
      await ownerPool.end();
    });
    await mkdir(installRoot, { recursive: true });
    await writeFile(trustStorePath, JSON.stringify({
      format: "realmworld-trust-store",
      version: 1,
      keys: [{
        keyId: "base-lifecycle-key",
        publicKey: keyPair.publicKeyPem,
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
      }],
    }));
    const cookie = `realm_session=${sessionProofFor(PRINCIPAL)}`;

    // ===== 1. base genesis：engine-owned 内容，无任何 RealmWorld 安装/信任配置 =====
    clearEnv();
    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: WS,
      principalId: PRINCIPAL,
      sessionProof: sessionProofFor(PRINCIPAL),
    };
    const genesis = await service.instantiateBaseWorld(
      scope,
      createBaseInstantiationPlan(BASE_PARAMETERS),
    );
    createdWorldId = genesis.worldId;
    createdRecordId = genesis.recordId;
    const baseWorldRow = await ownerPool.query<{ world_version: string }>(
      `SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [WS, genesis.worldId],
    );
    assert.equal(baseWorldRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);
    const baseRecordRow = await ownerPool.query<{ world_version: string }>(
      `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, genesis.recordId],
    );
    assert.equal(baseRecordRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);

    // ===== 2. 一个真实玩家回合（player.utterance + narration 正式事件落库） =====
    const sceneRow = await ownerPool.query<{ id: string }>(
      `SELECT id FROM scenes WHERE workspace_id = $1 AND record_id = $2 LIMIT 1`,
      [WS, genesis.recordId],
    );
    const policyRow = await ownerPool.query<{ id: string }>(
      `SELECT id FROM visibility_policies
       WHERE workspace_id = $1 AND record_id = $2 ORDER BY id LIMIT 1`,
      [WS, genesis.recordId],
    );
    assert.ok(sceneRow.rows[0]?.id, "genesis must materialize a scene");
    assert.ok(policyRow.rows[0]?.id, "genesis must materialize a visibility policy");
    const repository = createPostgresRuntimeRepository<
      readonly JsonValue[],
      { objective: string },
      { text: string },
      { accepted: boolean },
      { content: string },
      Record<string, never>
    >({
      pool: runtimePool,
      workspaceId: WS,
      mapFormalEvent({ draft }) {
        return {
          sceneId: sceneRow.rows[0]!.id,
          visibilityPolicyId: policyRow.rows[0]!.id,
          eventKind: "narration.committed",
          speakerName: "旁白",
          content: draft.payload.content,
        };
      },
    });
    const dependencies: TurnRuntimeDependencies<
      readonly JsonValue[],
      { objective: string },
      { text: string },
      { accepted: boolean },
      { content: string },
      Record<string, never>
    > = {
      repository,
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft() { return { text: "灯芯还温着。" }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context) {
          return {
            formalEvents: [
              {
                eventId: `${context.turnId}-utterance`,
                kind: "utterance.committed",
                payload: { content: "我重新点亮灯塔。" },
              },
              {
                eventId: `${context.turnId}-narration`,
                kind: "narration.committed",
                payload: { content: context.candidate.body.text },
              },
            ],
            outbox: [],
          };
        },
      },
      idFactory: (() => {
        let sequence = 0;
        return () => `base-lifecycle-${++sequence}`;
      })(),
      clock: tickingClock(),
    };
    const command: RuntimeCommand<readonly JsonValue[]> = {
      commandType: "player.utterance",
      recordId: genesis.recordId,
      expectedRecordVersion: Number((
        await ownerPool.query<{ record_version: string }>(
          `SELECT record_version FROM record_heads
           WHERE workspace_id = $1 AND record_id = $2`,
          [WS, genesis.recordId],
        )
      ).rows[0]?.record_version ?? "0"),
      idempotencyKey: "base-lifecycle-turn-1",
      actorId: null,
      payload: ["我重新点亮灯塔。"],
    };
    const completed = await executeTurn(command, dependencies);
    if (completed.state !== "completed") {
      console.error("TURN FAILED", JSON.stringify(completed.currentFailure ?? completed, null, 2));
    }
    assert.equal(completed.state, "completed");
    const turnEvents = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE workspace_id = $1 AND record_id = $2 AND id LIKE 'base-lifecycle-%'`,
      [WS, genesis.recordId],
    );
    assert.equal(turnEvents.rows[0]?.count, "2", "one player turn commits two formal events");

    // ===== 3. save Record 为 .realm v2（base mode）=====
    restoreEnv();
    const saveResponse = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ recordId: genesis.recordId }),
      },
    ));
    assert.equal(saveResponse.status, 200, JSON.stringify(await saveResponse.clone().json().catch(() => null)));
    const saveBytes = new Uint8Array(await saveResponse.arrayBuffer());
    const saveArchive = parseRealmRuntimeSaveArchive(saveBytes, { goalsSchemaVersion: 2 });
    assert.equal(saveArchive.manifest.format, "realm-save");
    assert.equal(saveArchive.manifest.formatVersion, 2);
    assert.equal(saveArchive.manifest.mode, "base");
    assert.equal(saveArchive.manifest.world, null);
    assert.ok(saveArchive.record.events.length >= 3, "opening + one player turn persisted");
    assert.ok(saveArchive.domain && saveArchive.domain.characterAssets.length > 0,
      "new saves preserve the base characters' inventory");
    for (const asset of saveArchive.domain.characterAssets) {
      assert.ok(Object.hasOwn(asset, "assetKey"),
        "portable saves carry a stable asset key, not only the source World's database id");
    }

    // ===== 4. 安装签名 RealmWorld 包并 instantiate =====
    await installSignedRealmWorldFixture({
      installRoot,
      worldId: FIXTURE_WORLD,
      version: FIXTURE_VERSION,
      recordTitle: "Base Lifecycle Fixture",
      keyId: "base-lifecycle-key",
      keyPair,
      baseRange: ">=1.0.0 <2.0.0",
    });
    const instantiateResponse = await instantiateRealmWorld(new Request(
      "http://127.0.0.1/api/realmworld/instantiate",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "bli-instantiate", cookie },
        body: JSON.stringify({
          worldId: FIXTURE_WORLD,
          worldVersion: FIXTURE_VERSION,
          locale: "en",
        }),
      },
    ));
    assert.equal(instantiateResponse.status, 201, JSON.stringify(await instantiateResponse.clone().json()));

    const restore = (key: string) =>
      restoreRuntimeRecord(new Request("http://127.0.0.1/api/record/restore", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.realm.save+zip",
          "idempotency-key": key,
          "x-realm-target-world": FIXTURE_WORLD,
          cookie,
        },
        body: Buffer.from(saveBytes),
      }));
    const restoredRowsFor = async () => (await ownerPool.query<{ id: string; world_version: string }>(
      `SELECT id, world_version FROM records
       WHERE workspace_id = $1 AND world_id = $2 AND id LIKE 'record_restore_%'`,
      [WS, FIXTURE_WORLD],
    )).rows;

    // New saves bind the target's own definition by stable content key.
    const sourceAsset = saveArchive.domain.characterAssets[0]!;
    assert.equal(typeof sourceAsset.assetKey, "string");
    const targetAssets = await ownerPool.query<{ id: string }>(
      `SELECT id FROM asset_definitions
       WHERE workspace_id = $1 AND world_id = $2 AND asset_key = $3`,
      [WS, FIXTURE_WORLD, sourceAsset.assetKey],
    );
    assert.equal(targetAssets.rowCount, 1);
    assert.notEqual(targetAssets.rows[0]!.id, sourceAsset.assetDefinitionId);
    const absentKey = `${sourceAsset.assetKey}.temporarily-absent`;
    await ownerPool.query(
      `UPDATE asset_definitions SET asset_key = $3 WHERE workspace_id = $1 AND id = $2`,
      [WS, targetAssets.rows[0]!.id, absentKey],
    );
    try {
      const missingDefinition = await restore("bli-missing-asset-definition");
      assert.equal(missingDefinition.status, 422);
      assert.equal((await missingDefinition.json()).error?.code, "RESTORE_INVALID_TARGET");
      assert.equal((await restoredRowsFor()).length, 0,
        "missing target asset rolls back all restored topology");
    } finally {
      await ownerPool.query(
        `UPDATE asset_definitions SET asset_key = $3 WHERE workspace_id = $1 AND id = $2`,
        [WS, targetAssets.rows[0]!.id, sourceAsset.assetKey],
      );
    }

    // ===== 5. 升级路径：兼容 → restore 成功且绑定升级为目标世界版本 =====
    const upgraded = await restore("bli-upgrade-ok");
    assert.equal(upgraded.status, 201, JSON.stringify({
      response: await upgraded.clone().json(),
      savedEffectKeys: saveArchive.characterEffects?.effects.map((effect) => effect.effectKey),
      savedAssetDefinitionIds: saveArchive.domain?.characterAssets.map((asset) => asset.assetDefinitionId),
    }));
    const upgradedBody = await upgraded.json() as { recordId: string; replayed: boolean };
    assert.equal(upgradedBody.replayed, false);
    const restoredAssets = await ownerPool.query<{ asset_definition_id: string; quantity: string }>(
      `SELECT asset_definition_id, quantity::text FROM character_assets
       WHERE workspace_id = $1 AND world_id = $2 AND record_id = $3`,
      [WS, FIXTURE_WORLD, upgradedBody.recordId],
    );
    assert.equal(restoredAssets.rowCount, saveArchive.domain.characterAssets.length);
    assert.ok(restoredAssets.rows.every((asset) => asset.asset_definition_id === targetAssets.rows[0]!.id));
    assert.deepEqual(restoredAssets.rows.map((asset) => Number(asset.quantity)).sort(),
      saveArchive.domain.characterAssets.map((asset) => asset.quantity).sort());
    const upgradedRow = await ownerPool.query<{ world_id: string; world_version: string }>(
      `SELECT world_id, world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, upgradedBody.recordId],
    );
    assert.equal(upgradedRow.rows[0]?.world_id, FIXTURE_WORLD);
    assert.equal(
      upgradedRow.rows[0]?.world_version,
      FIXTURE_VERSION,
      "升级路径：Record 绑定 = 已验证的目标世界版本（不再是 base 哨兵）",
    );
    // 幂等重放同键 → 200 replay。
    const replay = await restore("bli-upgrade-ok");
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);

    // ===== 6. 活动 base 版本变化（operator activate → switch）→ 不兼容 fail-closed =====
    // 模拟引擎 base 版本升级：可用集合扩为 [1.0.0, 2.0.0] 并切换到 2.0.0。
    let document = await readRealmWorldTrustStoreFile(trustStorePath);
    document = activateRealmWorldTrustStoreBase({
      document,
      version: "1.0.0",
      availableVersions: ["1.0.0", "2.0.0"],
    });
    document = switchRealmWorldTrustStoreBase({
      document,
      targetVersion: "2.0.0",
      availableVersions: ["1.0.0", "2.0.0"],
    });
    await writeRealmWorldTrustStoreFileAtomic({ path: trustStorePath, document });
    assert.equal(resolveEngineBaseActiveVersion(document), "2.0.0");

    // operator 状态路由反映活动版本（无路径/密钥泄露）。
    const statusResponse = await baseProviderStatus(new Request(
      "http://127.0.0.1/api/base-provider/status",
      { headers: { cookie } },
    ));
    assert.equal(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    assert.ok(statusText.includes("\"activeVersion\":\"2.0.0\""));
    assert.ok(!statusText.includes(installRoot) && !statusText.includes(trustStorePath));

    // 包区间 >=1.0.0 <2.0.0 不含 2.0.0 → restore 升级路径 fail-closed。
    const incompatible = await restore("bli-upgrade-incompatible");
    assert.equal(incompatible.status, 409, JSON.stringify(await incompatible.clone().json()));
    const incompatibleBody = await incompatible.json() as { ok: boolean; error?: { code: string } };
    assert.equal(incompatibleBody.ok, false);
    assert.equal(incompatibleBody.error?.code, "BASE_VERSION_INCOMPATIBLE");
    assert.equal(
      (await restoredRowsFor()).length,
      1,
      "fail-closed restore 零残留（只有第一次成功升级的 Record）",
    );

    // continue 语义：base 记录的继续游玩/存档不受包兼容闸影响。
    const continueSave = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ recordId: genesis.recordId }),
      },
    ));
    assert.equal(continueSave.status, 200, "base 存档在活动 base 版本变化后仍可用");

    // ===== 7. rollback：活动 base 回滚 → 兼容恢复，restore 再次成功 =====
    document = await readRealmWorldTrustStoreFile(trustStorePath);
    document = rollbackRealmWorldTrustStoreBase({
      document,
      availableVersions: ["1.0.0", "2.0.0"],
    });
    await writeRealmWorldTrustStoreFileAtomic({ path: trustStorePath, document });
    assert.equal(resolveEngineBaseActiveVersion(document), "1.0.0");

    const afterRollback = await restore("bli-upgrade-after-rollback");
    assert.equal(afterRollback.status, 201, JSON.stringify(await afterRollback.clone().json()));
    const rollbackBody = await afterRollback.json() as { recordId: string };
    const rollbackRow = await ownerPool.query<{ world_version: string }>(
      `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, rollbackBody.recordId],
    );
    assert.equal(rollbackRow.rows[0]?.world_version, FIXTURE_VERSION);

    // 引擎常量不变：当前构建 base 版本仍是规范声明值。
    assert.equal(ENGINE_BASE_CONTENT_VERSION, "1.0.0");
    } finally {
      if (previousBackupOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
      else process.env.REALM_OPERATOR_PRINCIPALS = previousBackupOperators;
    }
  },
);
