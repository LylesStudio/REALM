/**
 * Phase 4D PG 验收：Record 级 RealmWorld binding 与版本切换。
 * 规范：docs/development/REALMWORLD-VERSION-LIFECYCLE.md。
 * 覆盖：0057 回填、instantiate/duplicate/branch/restore 精确版本、record-scope
 * 绑定解析、upgrade/downgrade/同版本 no-op/幂等重放、目标未安装/签名无效/
 * identity 不符/非 semver/方向错误、归档与外部 Record、非 owner、幂等冲突、
 * 事务失败零残留、历史事件/head/拓扑不变、同一世界多 Record 独立 binding、
 * Goal 队列 claim 以 Record binding 取版本。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import {
  createPostgresRecordRuntimeScopeRepository,
} from "../database/postgres/public.ts";
import {
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  createPostgresGoalAssessmentJobQueue,
} from "../database/postgres/goal-assessment-job-queue.ts";
import {
  LOCAL_WORLD_VERSION,
} from "../modules/world-transfer/realm-save.ts";
import { POST as instantiateRealmWorld } from "../app/api/realmworld/instantiate/route.ts";
import { POST as switchVersion } from "../app/api/realmworld/switch-version/route.ts";
import { POST as saveRuntimeRecord } from "../app/api/record/save/route.ts";
import { POST as restoreRuntimeRecord } from "../app/api/record/restore/route.ts";
import {
  parseRealmRuntimeSaveArchive,
} from "../modules/world-transfer/realm-runtime-save.ts";
import { sessionProofFor } from "./helpers/session-proof.ts";
import { installSignedRealmWorldFixture } from "./helpers/realmworld-package-fixture.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = LOCAL_RECORD_SCOPE.workspaceId;
const FIXTURE_WORLD = "world_version_fixture";
const FIXTURE_RECORD_TITLE = "Version Fixture";

test(
  "Phase 4D：Record 级 binding 与显式版本切换全链验收",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    ownerPool.on("error", () => {});
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 4 });
    runtimePool.on("error", () => {});
    const dataHome = await mkdtemp(join(tmpdir(), "realm-p4d-"));
    const installRoot = join(dataHome, "installed");
    const trustStorePath = join(dataHome, "trust-store.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyPair = {
      privateKey,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const previousInstallRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT;
    const previousTrustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
    t.after(async () => {
      if (previousInstallRoot === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      else process.env.REALM_REALMWORLD_INSTALL_ROOT = previousInstallRoot;
      if (previousTrustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
      else process.env.REALM_REALMWORLD_TRUST_STORE = previousTrustStore;
      await rm(dataHome, { recursive: true, force: true });
      // events 是 append-only（guard_event_append_only），fixture 世界的 records/worlds
      // 行无法物理删除；但 pending outbox 必须清掉——本套件共享同一个 disposable
      // realm_dev，后续 outbox-worker 测试的真实 worker 会认领任意 pending 行。
      // 其余残留行均以 fixture Record/World id 为键，不影响其他用例。
      await ownerPool.query(`DELETE FROM outbox WHERE workspace_id = $1 AND world_id = $2`, [WS, FIXTURE_WORLD]);
      await runtimePool.end();
      await ownerPool.end();
    });
    await mkdir(installRoot, { recursive: true });
    await writeFile(trustStorePath, JSON.stringify({
      format: "realmworld-trust-store",
      version: 1,
      keys: [{
        keyId: "version-fixture-key",
        publicKey: keyPair.publicKeyPem,
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
      }],
    }));
    for (const version of ["1.2.0", "1.3.0"]) {
      await installSignedRealmWorldFixture({
        installRoot,
        worldId: FIXTURE_WORLD,
        version,
        recordTitle: FIXTURE_RECORD_TITLE,
        keyId: "version-fixture-key",
        keyPair,
      });
    }
    process.env.REALM_REALMWORLD_INSTALL_ROOT = installRoot;
    process.env.REALM_REALMWORLD_TRUST_STORE = trustStorePath;
    const cookie = `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`;

    // A. 0057 回填：demo 世界与记录都是 base 哨兵（绝不伪装成 RealmWorld）。
    const seeded = await ownerPool.query(
      `SELECT (SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2) AS world_version,
              (SELECT world_version FROM records WHERE workspace_id = $1 AND id = $3) AS record_version`,
      [WS, "world_ember_coast", "record_first_watch"],
    );
    assert.equal(seeded.rows[0]!.world_version, LOCAL_WORLD_VERSION);
    assert.equal(seeded.rows[0]!.record_version, LOCAL_WORLD_VERSION);

    // C. instantiate v1.2.0：Record 携带世界版本（写路径矩阵第一行）。
    const instantiate = async (key: string) => instantiateRealmWorld(new Request(
      "http://127.0.0.1/api/realmworld/instantiate",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key, cookie },
        body: JSON.stringify({ worldId: FIXTURE_WORLD, worldVersion: "1.2.0", locale: "en" }),
      },
    ));
    const instantiateResponse = await instantiate("p4d-fixture-1");
    assert.equal(instantiateResponse.status, 201);
    const created = await instantiateResponse.json() as { recordId: string };
    const recordId = created.recordId;
    const bindingRows = async () => (await ownerPool.query(
      `SELECT (SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2) AS world_version,
              (SELECT world_version FROM records WHERE workspace_id = $1 AND id = $3) AS record_version,
              (SELECT count(*)::int FROM events WHERE workspace_id = $1 AND record_id = $3) AS event_count,
              (SELECT record_version FROM record_heads WHERE workspace_id = $1 AND record_id = $3) AS head_version,
              (SELECT count(*)::int FROM scenes WHERE workspace_id = $1 AND record_id = $3) AS scene_count`,
      [WS, FIXTURE_WORLD, recordId],
    )).rows[0]!;
    const before = await bindingRows();
    assert.equal(before.world_version, "1.2.0");
    assert.equal(before.record_version, "1.2.0");

    // D. record-scope 以 Record binding 解析（不再读 worlds）。
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(runtimePool);
    const scopeBefore = await scopeRepository.resolve({
      workspaceId: WS,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId,
    });
    assert.deepEqual(scopeBefore?.worldBinding, {
      kind: "world",
      worldId: FIXTURE_WORLD,
      worldVersion: "1.2.0",
    });

    const callSwitch = (body: Record<string, unknown>, key: string, cookieHeader = cookie) =>
      switchVersion(new Request("http://127.0.0.1/api/realmworld/switch-version", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key, cookie: cookieHeader },
        body: JSON.stringify(body),
      }));

    // E. upgrade：显式、事务化；历史事件/head/拓扑不变，worlds 行不改写。
    const upgradeResponse = await callSwitch(
      { recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-switch-up",
    );
    assert.equal(
      upgradeResponse.status,
      200,
      `upgrade: ${JSON.stringify(await upgradeResponse.clone().json())}`,
    );
    const upgraded = await upgradeResponse.json() as {
      fromVersion: string; toVersion: string; switched: boolean; replayed: boolean;
    };
    assert.deepEqual(
      {
        fromVersion: upgraded.fromVersion,
        toVersion: upgraded.toVersion,
        switched: upgraded.switched,
        replayed: upgraded.replayed,
      },
      { fromVersion: "1.2.0", toVersion: "1.3.0", switched: true, replayed: false },
    );
    const afterUpgrade = await bindingRows();
    assert.equal(afterUpgrade.record_version, "1.3.0");
    assert.equal(afterUpgrade.world_version, "1.2.0", "worlds 创建身份不得被切换改写");
    assert.equal(afterUpgrade.event_count, before.event_count, "历史事件数不变");
    assert.equal(afterUpgrade.head_version, before.head_version, "record head 不变");
    assert.equal(afterUpgrade.scene_count, before.scene_count, "拓扑不变");
    const auditRows = async () => (await ownerPool.query(
      `SELECT count(*)::int AS count FROM realmworld_version_switches
       WHERE workspace_id = $1 AND record_id = $2`,
      [WS, recordId],
    )).rows[0]!.count as number;
    assert.equal(await auditRows(), 1, "审计台账一行");

    // F. 同幂等键重放：replayed:true，不再产生台账行。
    const replayResponse = await callSwitch(
      { recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-switch-up",
    );
    assert.equal(replayResponse.status, 200);
    const replayBody = await replayResponse.json() as { switched: boolean; replayed: boolean };
    assert.deepEqual(
      { switched: replayBody.switched, replayed: replayBody.replayed },
      { switched: false, replayed: true },
    );
    assert.equal(await auditRows(), 1);

    // G. 同版本 no-op（新幂等键）：switched:false，不写台账。
    const noopResponse = await callSwitch(
      { recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-switch-noop",
    );
    assert.equal(noopResponse.status, 200);
    assert.equal((await noopResponse.json() as { switched: boolean }).switched, false);
    assert.equal(await auditRows(), 1, "no-op 不产生台账行");

    // H. downgrade 回 1.2.0；record-scope 跟随。
    const downgradeResponse = await callSwitch(
      { recordId, targetWorldVersion: "1.2.0", operation: "downgrade" },
      "p4d-switch-down",
    );
    assert.equal(downgradeResponse.status, 200);
    assert.equal((await bindingRows()).record_version, "1.2.0");
    const scopeAfter = await scopeRepository.resolve({
      workspaceId: WS,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      recordId,
    });
    const bindingAfter = scopeAfter?.worldBinding as
      | { kind: string; worldVersion?: string }
      | undefined;
    assert.ok(bindingAfter && bindingAfter.kind === "world", "world-bound binding");
    assert.equal(bindingAfter.worldVersion, "1.2.0");

    // J. branch 保留源 Record 当前 binding；同世界另一 Record 互不影响。
    const service = createPostgresLibraryService(runtimePool);
    const branched = await service.branchRecord(
      {
        workspaceId: WS,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        sessionProof: sessionProofFor(LOCAL_RECORD_SCOPE.principalId),
      },
      { sourceRecordId: recordId, recordTitle: "Branch of version fixture" },
    );
    const branchBinding = await ownerPool.query(
      `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, branched.recordId],
    );
    assert.equal(branchBinding.rows[0]?.world_version, "1.2.0", "branch 携带源版本");
    // 同世界第二个 Record 走 duplicate（instantiate 的 genesis_creator
    // capability 只允许新世界零 membership，重复 instantiate 同世界不适用）。
    const duplicatedForIsolation = await service.duplicateRecord(
      {
        workspaceId: WS,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        sessionProof: sessionProofFor(LOCAL_RECORD_SCOPE.principalId),
      },
      recordId,
    );
    const secondRecordId = duplicatedForIsolation.recordId;
    // 切换 branch 到 1.3.0：源 Record 与第二个 Record 都不被牵连。
    const branchSwitch = await callSwitch(
      { recordId: branched.recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-switch-branch",
    );
    assert.equal(branchSwitch.status, 200);
    const independent = await ownerPool.query(
      `SELECT id, world_version FROM records
       WHERE workspace_id = $1 AND world_id = $2 ORDER BY id`,
      [WS, FIXTURE_WORLD],
    );
    const byId = new Map(independent.rows.map((row) => [row.id, row.world_version]));
    assert.equal(byId.get(recordId), "1.2.0", "源 Record 不被牵连");
    assert.equal(byId.get(branched.recordId), "1.3.0");
    assert.equal(byId.get(secondRecordId), "1.2.0", "同世界另一 Record 独立 binding");

    // K. duplicate 保留源 Record 当前 binding。
    const duplicated = await service.duplicateRecord(
      {
        workspaceId: WS,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        sessionProof: sessionProofFor(LOCAL_RECORD_SCOPE.principalId),
      },
      recordId,
    );
    const dupBinding = await ownerPool.query(
      `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, duplicated.recordId],
    );
    assert.equal(dupBinding.rows[0]?.world_version, "1.2.0", "duplicate 携带源版本");

    // L. .realm 存档保真：先切到 1.3.0 → save → 源切回 1.2.0 → restore
    // 出来的新 Record 保留存档版本（1.3.0），源不被改写。
    const upAgain = await callSwitch(
      { recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-switch-up2",
    );
    assert.equal(upAgain.status, 200);
    const saveResponse = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ recordId }),
      },
    ));
    assert.equal(saveResponse.status, 200, `save: ${JSON.stringify(await saveResponse.clone().json().catch(()=>null))}`);
    const saveBytes = new Uint8Array(await saveResponse.arrayBuffer());
    const saveArchive = parseRealmRuntimeSaveArchive(saveBytes);
    assert.equal(saveArchive.manifest.world?.worldVersion, "1.3.0", "存档记录当前 binding");
    const downAgain = await callSwitch(
      { recordId, targetWorldVersion: "1.2.0", operation: "downgrade" },
      "p4d-switch-down2",
    );
    assert.equal(downAgain.status, 200);
    const restoreResponse = await restoreRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/restore",
      {
        method: "POST",
        headers: {
          "content-type": "application/vnd.realm.save+zip",
          "idempotency-key": "p4d-restore-1",
          "x-realm-target-world": FIXTURE_WORLD,
          cookie,
        },
        body: Buffer.from(saveBytes),
      },
    ));
    assert.equal(restoreResponse.status, 201, JSON.stringify(await restoreResponse.clone().json()));
    const restored = await restoreResponse.json() as {
      recordId: string; replayed: boolean; warnings?: string[];
    };
    assert.equal(restored.replayed, false);
    assert.ok(
      restored.warnings?.includes("WORLD_VERSION_MISMATCH"),
      "目标世界当前版本与存档不同 → 显式 warning（不静默）",
    );
    const restoredBinding = await ownerPool.query(
      `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
      [WS, restored.recordId],
    );
    assert.equal(restoredBinding.rows[0]?.world_version, "1.3.0", "restore 保留存档制作版本");
    assert.equal(
      (await ownerPool.query(
        `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
        [WS, recordId],
      )).rows[0]?.world_version,
      "1.2.0",
      "源 Record binding 不被 restore 改写",
    );

    // M. 错误矩阵。
    const expectStatus = async (
      body: Record<string, unknown>,
      key: string,
      status: number,
      code: string,
      cookieHeader = cookie,
    ) => {
      const response = await callSwitch(body, key, cookieHeader);
      assert.equal(response.status, status, `${code}: ${JSON.stringify(await response.clone().json())}`);
      const payload = await response.json() as { ok: boolean; error?: { code: string } };
      assert.equal(payload.ok, false);
      assert.equal(payload.error?.code, code);
    };
    await expectStatus(
      { recordId, targetWorldVersion: "9.9.9", operation: "upgrade" },
      "p4d-err-uninstalled", 503, "WORLD_NOT_INSTALLED",
    );
    // 签名无效：安装目录下手工放一个验签失败的版本（直接复制合法目录后
    // 篡改内容文件——mount 重验签必须拒绝）。
    const tampered = join(installRoot, FIXTURE_WORLD, "9.9.8");
    await mkdir(tampered, { recursive: true });
    const legitDir = join(installRoot, FIXTURE_WORLD, "1.2.0");
    const { cp, readFile, writeFile: writeFileFs } = await import("node:fs/promises");
    await cp(legitDir, tampered, { recursive: true });
    const worldJsonPath = join(tampered, "content", "world.json");
    const tamperedWorld = JSON.parse(await readFile(worldJsonPath, "utf8")) as { title: Record<string, string> };
    tamperedWorld.title.en = "tampered";
    await writeFileFs(worldJsonPath, JSON.stringify(tamperedWorld));
    await expectStatus(
      { recordId, targetWorldVersion: "9.9.8", operation: "upgrade" },
      "p4d-err-contenthash", 503, "CONTENT_HASH_MISMATCH",
    );
    // 真·签名无效：内容不动，篡改 manifest 的 signature 值（contentHash 完好，
    // 验签必须失败）。
    const badSig = join(installRoot, FIXTURE_WORLD, "9.9.6");
    await cp(legitDir, badSig, { recursive: true });
    const manifestPath = join(badSig, "realmworld-manifest.json");
    const manifestText = await readFile(manifestPath, "utf8");
    await writeFileFs(
      manifestPath,
      manifestText.replace(/"value":"?([A-Za-z0-9-_])/, (whole, first: string) =>
        `"value":"${first === "A" ? "B" : "A"}`),
    );
    await expectStatus(
      { recordId, targetWorldVersion: "9.9.6", operation: "upgrade" },
      "p4d-err-signature", 503, "SIGNATURE_INVALID",
    );
    // identity 不符：把 1.2.0 目录复制为 9.9.7 名字（manifest 仍是 1.2.0）。
    const mismatched = join(installRoot, FIXTURE_WORLD, "9.9.7");
    await cp(legitDir, mismatched, { recursive: true });
    await expectStatus(
      { recordId, targetWorldVersion: "9.9.7", operation: "upgrade" },
      "p4d-err-identity", 409, "REALMWORLD_IDENTITY_MISMATCH",
    );
    await expectStatus(
      { recordId, targetWorldVersion: "latest", operation: "upgrade" },
      "p4d-err-semver", 400, "INVALID_VERSION",
    );
    await expectStatus(
      { recordId, targetWorldVersion: "1.3.0", operation: "downgrade" },
      "p4d-err-direction", 400, "INVALID_VERSION_DIRECTION",
    );
    await expectStatus(
      { recordId: "record_missing_p4d", targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-err-record", 404, "RECORD_NOT_FOUND",
    );
    // 归档 Record：封存后拒绝。
    await ownerPool.query(
      `UPDATE records SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [WS, duplicated.recordId],
    );
    await expectStatus(
      { recordId: duplicated.recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-err-archived", 409, "RECORD_ARCHIVED",
    );
    // 非 owner：把 fixture 世界的创建者降为 player 后拒绝。
    await ownerPool.query(
      `UPDATE player_world_memberships SET role = 'player'
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, FIXTURE_WORLD, LOCAL_RECORD_SCOPE.principalId],
    );
    await expectStatus(
      { recordId, targetWorldVersion: "1.3.0", operation: "upgrade" },
      "p4d-err-not-owner", 403, "NOT_OWNER",
    );
    await ownerPool.query(
      `UPDATE player_world_memberships SET role = 'owner'
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, FIXTURE_WORLD, LOCAL_RECORD_SCOPE.principalId],
    );
    // 幂等冲突：同键不同目标。
    await expectStatus(
      { recordId, targetWorldVersion: "1.2.0", operation: "downgrade" },
      "p4d-switch-up", 409, "REALMWORLD_SWITCH_CONFLICT",
    );
    // 事务失败零残留：上述全部负路径后，binding 仍是 1.2.0、台账无新增。
    assert.equal((await bindingRows()).record_version, "1.2.0", "负路径零副作用");
    assert.equal(await auditRows(), 4, "台账=up/branch/up2/down2 四条");

    // O. Goal 队列 claim 以 Record binding 取版本（不再读 worlds 默认）。
    const goalInstanceId = `goal_p4d_${recordId.slice(-8)}`;
    const jobId = `goal_job_p4d_${recordId.slice(-8)}`;
    await ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, policy_version
       ) SELECT workspace_id, world_id, worldline_id, id, $2, 'goal.p4d', 'active', 'policy-test'
         FROM records WHERE workspace_id = $1 AND id = $3`,
      [WS, goalInstanceId, recordId],
    );
    await ownerPool.query(
      `INSERT INTO goal_assessment_jobs (
         workspace_id, world_id, worldline_id, record_id, id,
         goal_instance_id, source_event_id
       ) SELECT record.workspace_id, record.world_id, record.worldline_id,
                record.id, $2, $3,
                (SELECT event.id FROM events AS event
                  WHERE event.workspace_id = $1 AND event.record_id = $4
                  ORDER BY event.record_ordinal ASC LIMIT 1)
         FROM records AS record
         WHERE record.workspace_id = $1 AND record.id = $4`,
      [WS, jobId, goalInstanceId, recordId],
    );
    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: WS,
      leaseOwner: "p4d-test-worker",
      leaseDurationMs: 30_000,
    });
    const claimed = await queue.claimNext({ now: new Date().toISOString() });
    assert.ok(claimed);
    assert.equal(claimed.worldVersion, "1.2.0", "claim 取 Record binding 版本");
    await queue.fail({ job: claimed, code: "P4D_DONE", now: new Date().toISOString() });
    await ownerPool.query(
      `DELETE FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [WS, jobId],
    );
    await ownerPool.query(
      `DELETE FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
      [WS, goalInstanceId],
    );
  },
);
