/**
 * world-bound `.realm` restore 的 RealmWorld 信任闸 PG 验收（disposable
 * scratch PG 套件；共享 runner 注入的 realm_dev）。
 *
 * 覆盖：精确已安装可信包正路径（无 warning）与幂等重放、缺包、篡改
 * content、篡改签名、manifest identity 不符、trust-store/config 缺失与
 * 无效、base 存档无 RealmWorld 配置仍可用、所有负路径零残留、重放同样
 * 经过信任闸（包被移除后重放 fail-closed）。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/demo-seed.ts";
import { POST as instantiateRealmWorld } from "../app/api/realmworld/instantiate/route.ts";
import { POST as saveRuntimeRecord } from "../app/api/record/save/route.ts";
import { POST as restoreRuntimeRecord } from "../app/api/record/restore/route.ts";
import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
} from "../modules/world-transfer/realm-runtime-save.ts";
import { sessionProofFor } from "./helpers/session-proof.ts";
import { installSignedRealmWorldFixture } from "./helpers/realmworld-package-fixture.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = LOCAL_RECORD_SCOPE.workspaceId;
const FIXTURE_WORLD = "world_restore_trust_fixture";
const FIXTURE_VERSION = "2.0.0";

test(
  "world-bound .realm restore：精确 RealmWorld 包信任闸 fail-closed 全链验收",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    ownerPool.on("error", () => {});
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 4 });
    runtimePool.on("error", () => {});
    const dataHome = await mkdtemp(join(tmpdir(), "realm-prt-"));
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
    t.after(async () => {
      if (previousInstallRoot === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      else process.env.REALM_REALMWORLD_INSTALL_ROOT = previousInstallRoot;
      if (previousWorkerInstallRoot === undefined) delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
      else process.env.REALM_GOAL_WORKER_INSTALL_ROOT = previousWorkerInstallRoot;
      if (previousTrustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
      else process.env.REALM_REALMWORLD_TRUST_STORE = previousTrustStore;
      await rm(dataHome, { recursive: true, force: true });
      await ownerPool.query(`DELETE FROM outbox WHERE workspace_id = $1 AND world_id = $2`, [WS, FIXTURE_WORLD]);
      await runtimePool.end();
      await ownerPool.end();
    });
    await mkdir(installRoot, { recursive: true });
    const trustStoreBody = JSON.stringify({
      format: "realmworld-trust-store",
      version: 1,
      keys: [{
        keyId: "restore-trust-key",
        publicKey: keyPair.publicKeyPem,
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
      }],
    });
    await writeFile(trustStorePath, trustStoreBody);
    await installSignedRealmWorldFixture({
      installRoot,
      worldId: FIXTURE_WORLD,
      version: FIXTURE_VERSION,
      recordTitle: "Restore Trust Fixture",
      keyId: "restore-trust-key",
      keyPair,
    });
    restoreEnv();
    const cookie = `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`;

    // instantiate 精确版本世界 + Record（binding=2.0.0），再 save 出
    // world-bound `.realm` 存档。
    const instantiateResponse = await instantiateRealmWorld(new Request(
      "http://127.0.0.1/api/realmworld/instantiate",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "prt-instantiate", cookie },
        body: JSON.stringify({ worldId: FIXTURE_WORLD, worldVersion: FIXTURE_VERSION, locale: "en" }),
      },
    ));
    assert.equal(instantiateResponse.status, 201, JSON.stringify(await instantiateResponse.clone().json()));
    const { recordId } = await instantiateResponse.json() as { recordId: string };
    const saveResponse = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ recordId }),
      },
    ));
    assert.equal(saveResponse.status, 200, JSON.stringify(await saveResponse.clone().json().catch(() => null)));
    const saveBytes = new Uint8Array(await saveResponse.arrayBuffer());
    const saveArchive = parseRealmRuntimeSaveArchive(saveBytes);
    assert.equal(saveArchive.manifest.mode, "world-bound");
    assert.deepEqual(saveArchive.manifest.world, { worldId: FIXTURE_WORLD, worldVersion: FIXTURE_VERSION });

    const restore = (bytes: Uint8Array, key: string, targetWorld = FIXTURE_WORLD) =>
      restoreRuntimeRecord(new Request("http://127.0.0.1/api/record/restore", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.realm.save+zip",
          "idempotency-key": key,
          "x-realm-target-world": targetWorld,
          cookie,
        },
        body: Buffer.from(bytes),
      }));
    /** 同一存档内容改写 manifest binding 版本（runtimeHash 不覆盖 manifest）。 */
    const archiveAt = (version: string): Uint8Array => {
      const parsed = parseRealmRuntimeSaveArchive(saveBytes);
      return buildRealmRuntimeSaveArchive({
        manifest: {
          ...parsed.manifest,
          world: { worldId: FIXTURE_WORLD, worldVersion: version },
        },
        record: parsed.record,
        goals: parsed.goals,
        topology: parsed.topology,
        actionReceipts: parsed.actionReceipts,
        characterEffects: parsed.characterEffects,
        observations: parsed.observations,
        memory: parsed.memory,
        outbox: parsed.outbox,
        firstNight: parsed.firstNight,
        selfPlay: parsed.selfPlay,
      });
    };
    const restoreRowCounts = async () => (await ownerPool.query<{
      records: string; worldlines: string; stories: string; events: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM records WHERE workspace_id = $1 AND id LIKE 'record_restore_%') AS records,
         (SELECT count(*)::text FROM worldlines WHERE workspace_id = $1 AND id LIKE 'worldline_restore_%') AS worldlines,
         (SELECT count(*)::text FROM stories WHERE workspace_id = $1 AND id LIKE 'story_restore_%') AS stories,
         (SELECT count(*)::text FROM events WHERE workspace_id = $1 AND id LIKE 'restore_event_%') AS events`,
      [WS],
    )).rows[0]!;
    const expectFailure = async (
      bytes: Uint8Array,
      key: string,
      status: number,
      code: string,
    ) => {
      const response = await restore(bytes, key);
      assert.equal(response.status, status, `${code}: ${JSON.stringify(await response.clone().json())}`);
      const payload = await response.json() as { ok: boolean; error?: { code: string; message?: string } };
      assert.equal(payload.ok, false);
      assert.equal(payload.error?.code, code);
      assert.ok(!payload.error?.message?.includes(installRoot), "不得泄露 installRoot");
    };

    // A. 精确已安装可信包 → 201，目标版本一致 → 无 warning。
    const okResponse = await restore(saveBytes, "prt-restore-ok");
    assert.equal(okResponse.status, 201, JSON.stringify(await okResponse.clone().json()));
    const okBody = await okResponse.json() as {
      recordId: string; replayed: boolean; warnings: string[];
    };
    assert.equal(okBody.replayed, false);
    assert.deepEqual(okBody.warnings, [], "目标世界当前版本=存档版本 → 无 warning");
    assert.equal(
      (await ownerPool.query(
        `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`,
        [WS, okBody.recordId],
      )).rows[0]?.world_version,
      FIXTURE_VERSION,
      "restore 保留存档制作版本",
    );

    // B. 相同幂等键重放：200 replayed:true，同 Record。
    const replayResponse = await restore(saveBytes, "prt-restore-ok");
    assert.equal(replayResponse.status, 200);
    const replayBody = await replayResponse.json() as { recordId: string; replayed: boolean };
    assert.deepEqual(
      { recordId: replayBody.recordId, replayed: replayBody.replayed },
      { recordId: okBody.recordId, replayed: true },
    );

    const baseline = await restoreRowCounts();

    // C. 缺包（archive binding 版本未安装）→ 503 REALMWORLD_PACKAGE_MISSING。
    await expectFailure(archiveAt("9.9.9"), "prt-missing", 503, "REALMWORLD_PACKAGE_MISSING");

    // D. 篡改 content → content hash 失效 → 503 REALMWORLD_PACKAGE_UNTRUSTED。
    const legitDir = join(installRoot, FIXTURE_WORLD, FIXTURE_VERSION);
    const tampered = join(installRoot, FIXTURE_WORLD, "9.9.8");
    await cp(legitDir, tampered, { recursive: true });
    const worldJsonPath = join(tampered, "content", "world.json");
    const tamperedWorld = JSON.parse(await readFile(worldJsonPath, "utf8")) as {
      title: Record<string, string>;
    };
    tamperedWorld.title.en = "tampered";
    await writeFile(worldJsonPath, JSON.stringify(tamperedWorld));
    await expectFailure(archiveAt("9.9.8"), "prt-tampered", 503, "REALMWORLD_PACKAGE_UNTRUSTED");

    // E. 篡改签名（content 完好）→ 503 REALMWORLD_PACKAGE_UNTRUSTED。
    const badSignature = join(installRoot, FIXTURE_WORLD, "9.9.6");
    await cp(legitDir, badSignature, { recursive: true });
    const manifestPath = join(badSignature, "realmworld-manifest.json");
    const manifestText = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifestText.replace(/"value":"?([A-Za-z0-9-_])/, (whole, first: string) =>
        `"value":"${first === "A" ? "B" : "A"}`),
    );
    await expectFailure(archiveAt("9.9.6"), "prt-badsig", 503, "REALMWORLD_PACKAGE_UNTRUSTED");

    // F. 目录名=archive 版本但 manifest identity 不符 → 409。
    const mismatched = join(installRoot, FIXTURE_WORLD, "9.9.7");
    await cp(legitDir, mismatched, { recursive: true });
    await expectFailure(archiveAt("9.9.7"), "prt-identity", 409, "REALMWORLD_IDENTITY_MISMATCH");

    // G. trust-store/config 缺失或无效 → 503 REALMWORLD_VALIDATION_UNAVAILABLE。
    clearEnv();
    await expectFailure(saveBytes, "prt-config-missing", 503, "REALMWORLD_VALIDATION_UNAVAILABLE");
    restoreEnv();
    await writeFile(trustStorePath, "{not-a-trust-store");
    await expectFailure(saveBytes, "prt-config-invalid", 503, "REALMWORLD_VALIDATION_UNAVAILABLE");
    await writeFile(trustStorePath, trustStoreBody);

    // 全部负路径零残留。
    assert.deepEqual(await restoreRowCounts(), baseline, "负路径不得留下任何 restore 行");

    // H. base 存档：完全无 RealmWorld install/trust 配置也必须可用。
    const baseSaveResponse = await saveRuntimeRecord(new Request(
      "http://127.0.0.1/api/record/save",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ recordId: POSTGRES_DEMO_IDS.record }),
      },
    ));
    assert.equal(baseSaveResponse.status, 200);
    const baseSaveBytes = new Uint8Array(await baseSaveResponse.arrayBuffer());
    const baseSave = parseRealmRuntimeSaveArchive(baseSaveBytes);
    assert.equal(baseSave.manifest.mode, "base", "base World 的存档不得伪装成 RealmWorld binding");
    assert.equal(baseSave.manifest.world, null);
    clearEnv();
    const baseRestoreResponse = await restore(baseSaveBytes, "prt-base-restore", POSTGRES_DEMO_IDS.world);
    assert.equal(
      baseRestoreResponse.status,
      201,
      JSON.stringify(await baseRestoreResponse.clone().json()),
    );
    restoreEnv();
    const afterBase = await restoreRowCounts();
    assert.equal(
      Number(afterBase.records),
      Number(baseline.records) + 1,
      "base restore 正常写入（且只多一组 restore 行）",
    );

    // J. 重放同样过信任闸：包被移除后，相同幂等键重放 fail-closed 且零残留。
    await rm(join(installRoot, FIXTURE_WORLD, FIXTURE_VERSION), { recursive: true, force: true });
    await expectFailure(saveBytes, "prt-restore-ok", 503, "REALMWORLD_PACKAGE_MISSING");
    assert.deepEqual(await restoreRowCounts(), afterBase, "失败重放不得留下任何 restore 行");
  },
);
