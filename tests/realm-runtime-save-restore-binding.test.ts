/**
 * `.realm` restore 的 RealmWorld 信任闸（纯测试，无 DB）：
 * - restorer seam：world-bound 无 validator → fail-closed；validator 收到
 *   精确 archive binding 且在任何 DB 写入前执行；validator 异常不外泄；
 *   base 存档绕过且不触碰 validator。
 * - 路由接线：world-bound + 缺 install/trust 配置 → 503 稳定 code；
 *   validator 工厂对缺包/篡改/identity 不符映射稳定 code（真实临时包）。
 * 正路径与 PG 写入断言在 tests/postgres-realmworld-restore-trust.test.ts。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createPostgresRealmRuntimeSaveRestorer,
  RealmRuntimeSaveRepositoryError,
} from "../database/postgres/public.ts";
import type { WorkspaceDatabase } from "../database/postgres/workspace-transaction.ts";
import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveRecordV1,
} from "../modules/world-transfer/realm-runtime-save.ts";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifest,
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import {
  computeRealmWorldContentHash,
  installRealmWorldDirectory,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  createRealmRuntimeSaveWorldBindingValidator,
  POST as restoreRuntimeRecord,
} from "../app/api/record/restore/route.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { installTestSessionSecret, sessionProofFor } from "./helpers/session-proof.ts";

const WORLD_ID = "world-harbor";
const WORLD_VERSION = "1.2.0";

function recordFor(worldId: string): RealmRuntimeSaveRecordV1 {
  return {
    format: "realm-runtime-record",
    schemaVersion: 1,
    scope: { worldId, worldlineId: "worldline-main", recordId: "record-harbor" },
    head: { recordVersion: 0, nextRecordOrdinal: 0 },
    events: [],
  };
}

const goals: RealmRuntimeSaveGoalsV1 = {
  format: "realm-runtime-goals",
  schemaVersion: 1,
  instances: [],
  assessments: [],
};

function worldBoundArchive(): RealmRuntimeSaveArchive {
  const record = recordFor(WORLD_ID);
  const manifest = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: { worldId: WORLD_ID, worldVersion: WORLD_VERSION },
    scope: {
      workspaceId: "workspace-main",
      worldlineId: "worldline-main",
      recordId: "record-harbor",
    },
    record,
    goals,
  });
  return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ manifest, record, goals }));
}

function baseArchive(): RealmRuntimeSaveArchive {
  const record = recordFor("world-base");
  const manifest = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "base",
    world: null,
    scope: {
      workspaceId: "workspace-main",
      worldlineId: "worldline-main",
      recordId: "record-harbor",
    },
    record,
    goals,
  });
  return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ manifest, record, goals }));
}

/** 任何 connect/query 都计数的伪 WorkspaceDatabase（证明闸在 DB 之前）。 */
function trackingDatabase(): { database: WorkspaceDatabase; touched: () => number } {
  let touches = 0;
  const database = {
    connect: async () => {
      touches += 1;
      throw new Error("db-touched-sentinel");
    },
    query: async () => {
      touches += 1;
      throw new Error("db-touched-sentinel");
    },
  } as unknown as WorkspaceDatabase;
  return { database, touched: () => touches };
}

const restoreInput = (archive: RealmRuntimeSaveArchive) => ({
  workspaceId: "workspace-main",
  principalId: "principal-local",
  archive,
  targetWorldId: archive.manifest.world?.worldId ?? "world-base",
  idempotencyKey: "pure-binding-test",
});

test("world-bound restore 无 validator → REALMWORLD_VALIDATION_UNAVAILABLE，DB 零触碰", async () => {
  const { database, touched } = trackingDatabase();
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database).restore(restoreInput(worldBoundArchive())),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_VALIDATION_UNAVAILABLE",
  );
  assert.equal(touched(), 0);
});

test("validator 收到精确 archive binding 且先于任何 DB 写入", async () => {
  const { database, touched } = trackingDatabase();
  const seen: { worldId: string; worldVersion: string; touchesAtCall: number }[] = [];
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database, {
      validateWorldBinding: async (binding) => {
        seen.push({ ...binding, touchesAtCall: touched() });
      },
    }).restore(restoreInput(worldBoundArchive())),
    (error: unknown) => error instanceof Error && error.message === "db-touched-sentinel",
  );
  assert.deepEqual(seen, [{ worldId: WORLD_ID, worldVersion: WORLD_VERSION, touchesAtCall: 0 }]);
});

test("validator 的 RealmRuntimeSaveRepositoryError 原样上抛，DB 零触碰", async () => {
  const { database, touched } = trackingDatabase();
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database, {
      validateWorldBinding: async () => {
        throw new RealmRuntimeSaveRepositoryError("REALMWORLD_PACKAGE_MISSING", "not installed");
      },
    }).restore(restoreInput(worldBoundArchive())),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_PACKAGE_MISSING",
  );
  assert.equal(touched(), 0);
});

test("validator 原始异常映射为 REALMWORLD_PACKAGE_UNTRUSTED，不泄露细节", async () => {
  const { database, touched } = trackingDatabase();
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database, {
      validateWorldBinding: async () => {
        throw new Error("raw /secret/installRoot keyId=abc signature=def");
      },
    }).restore(restoreInput(worldBoundArchive())),
    (error: unknown) => {
      assert.ok(error instanceof RealmRuntimeSaveRepositoryError);
      assert.equal(error.code, "REALMWORLD_PACKAGE_UNTRUSTED");
      assert.ok(!error.message.includes("/secret"), "不得泄露原始路径");
      assert.ok(!error.message.includes("keyId"), "不得泄露 keyId");
      return true;
    },
  );
  assert.equal(touched(), 0);
});

test("base 存档无 validator 也可进入 DB 阶段（绕过 RealmWorld 闸）", async () => {
  const { database, touched } = trackingDatabase();
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database).restore(restoreInput(baseArchive())),
    (error: unknown) => error instanceof Error && error.message === "db-touched-sentinel",
  );
  assert.ok(touched() > 0, "base 存档不得要求 RealmWorld validator");
});

/**
 * base→world-bound 升级路径（Slice 5）：目标 World 非 base 版本时，restore
 * 必须先经 validateUpgradeTarget 证明目标精确 binding 已安装/可信/兼容
 * 活动 base 版本；缺 seam 或验证失败一律 fail-closed，绝不静默升级。
 */
function fakeDatabaseWithWorldVersion(worldVersion: string): WorkspaceDatabase {
  const client = {
    query: async (sql: string) => {
      if (
        sql.startsWith("BEGIN")
        || sql === "COMMIT"
        || sql === "ROLLBACK"
        || sql.includes("set_config")
        || sql.includes("current_setting")
      ) {
        return { rows: [{ workspace_id: null }], rowCount: 0 };
      }
      if (sql.includes("FROM worlds")) {
        return { rows: [{ world_version: worldVersion, status: "active" }], rowCount: 1 };
      }
      throw new Error("db-touched-sentinel");
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    query: client.query,
  } as unknown as WorkspaceDatabase;
}

test("base→world-bound 升级：缺 validateUpgradeTarget seam → REALMWORLD_VALIDATION_UNAVAILABLE", async () => {
  const database = fakeDatabaseWithWorldVersion(WORLD_VERSION);
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database).restore({
      ...restoreInput(baseArchive()),
      targetWorldId: WORLD_ID,
    }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_VALIDATION_UNAVAILABLE",
  );
});

test("base→world-bound 升级：validator 收到精确目标 binding；其错误原样上抛", async () => {
  const database = fakeDatabaseWithWorldVersion(WORLD_VERSION);
  const seen: { worldId: string; worldVersion: string }[] = [];
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database, {
      validateUpgradeTarget: async (binding) => {
        seen.push({ ...binding });
        throw new RealmRuntimeSaveRepositoryError(
          "BASE_VERSION_INCOMPATIBLE",
          "The bound RealmWorld package is not compatible with the active engine base version.",
        );
      },
    }).restore({ ...restoreInput(baseArchive()), targetWorldId: WORLD_ID }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "BASE_VERSION_INCOMPATIBLE",
  );
  // 精确目标 binding = 目标 worldId + 目标 World 当前版本（绝非 base 哨兵）。
  assert.deepEqual(seen, [{ worldId: WORLD_ID, worldVersion: WORLD_VERSION }]);
});

test("base→base 恢复绝不调用 validateUpgradeTarget", async () => {
  const database = fakeDatabaseWithWorldVersion("0.0.0-local");
  let calls = 0;
  await assert.rejects(
    () => createPostgresRealmRuntimeSaveRestorer(database, {
      validateUpgradeTarget: async () => {
        calls += 1;
      },
    }).restore({ ...restoreInput(baseArchive()), targetWorldId: "world-base" }),
    // base 目标 → 跳过升级闸，进入后续 DB 阶段（sentinel）。
    (error: unknown) => error instanceof Error && error.message === "db-touched-sentinel",
  );
  assert.equal(calls, 0);
});

test('snapshot branch verifies the pinned signed package and observes trust-store revocation without restart',async t=>{
  const {validateRecordBranchWorldBinding:validate}=await import('../modules/application/record-branch-world-binding.ts');
  const keys=['REALM_REALMWORLD_INSTALL_ROOT','REALM_GOAL_WORKER_INSTALL_ROOT','REALM_REALMWORLD_TRUST_STORE'];
  const prior=new Map(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  for(const key of keys)delete process.env[key];
  const binding={worldId:WORLD_ID,worldVersion:WORLD_VERSION};
  await assert.rejects(()=>validate(binding),(error:unknown)=>error instanceof RealmRuntimeSaveRepositoryError&&error.code==='REALMWORLD_VALIDATION_UNAVAILABLE');
  const directory=await mkdtemp(join(tmpdir(),'realm-branch-trust-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const installRoot=join(directory,'installed'),path=join(directory,'trust.json');
  const pair=generateKeyPairSync('ed25519');
  const fixture=await installFixturePackage({installRoot,worldId:WORLD_ID,version:WORLD_VERSION,privateKey:pair.privateKey});
  t.after(()=>rm(fixture.sourceDir,{recursive:true,force:true}));
  const document={format:'realmworld-trust-store',version:1,base:{activeVersion:'1.0.0'},keys:[{keyId:'pure-fixture-key',
    publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString(),status:'active'}]};
  await writeFile(path,JSON.stringify(document),{mode:0o600});
  process.env.REALM_REALMWORLD_INSTALL_ROOT=installRoot;process.env.REALM_REALMWORLD_TRUST_STORE=path;
  await validate(binding);
  await assert.rejects(()=>validate({...binding,worldVersion:'9.9.9'}),(error:unknown)=>error instanceof RealmRuntimeSaveRepositoryError&&error.code==='REALMWORLD_PACKAGE_MISSING');
  document.keys[0].status='revoked';await writeFile(path,JSON.stringify(document));
  await assert.rejects(()=>validate(binding),(error:unknown)=>error instanceof RealmRuntimeSaveRepositoryError&&error.code==='REALMWORLD_PACKAGE_UNTRUSTED');
  document.keys[0].status='active';document.base.activeVersion='2.0.0';await writeFile(path,JSON.stringify(document));
  await assert.rejects(()=>validate(binding),(error:unknown)=>error instanceof RealmRuntimeSaveRepositoryError&&error.code==='BASE_VERSION_INCOMPATIBLE');
  document.base.activeVersion='1.0.0';await writeFile(path,JSON.stringify(document));
  await writeFile(join(installRoot,WORLD_ID,WORLD_VERSION,'content','world.json'),'{}');
  await assert.rejects(()=>validate(binding),(error:unknown)=>error instanceof RealmRuntimeSaveRepositoryError&&error.code==='REALMWORLD_PACKAGE_UNTRUSTED');
});

async function installFixturePackage(input: {
  installRoot: string;
  worldId: string;
  version: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}): Promise<{ signature: string; sourceDir: string }> {
  const sourceDir = await mkdtemp(join(tmpdir(), "realm-pure-src-"));
  const files = new Map<string, Uint8Array>([
    ["content/index.json", Buffer.from(JSON.stringify({
      format: "realmworld-content",
      schemaVersion: 1,
      modules: ["content/world.json"],
    }))],
    ["content/world.json", Buffer.from(JSON.stringify({
      worldId: input.worldId,
      title: { en: `Harbor ${input.version}` },
      settings: {},
    }))],
  ]);
  const unsigned: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: input.worldId,
    worldVersion: input.version,
    engineCompat: { schemaLatest: "0057_realmworld_record_binding.sql", requiresMigrations: [], baseRange: ">=1.0.0 <2.0.0" },
    contentHash: computeRealmWorldContentHash(files),
    signature: { algorithm: "ed25519", keyId: "pure-fixture-key", value: "placeholder" },
  };
  const signature = sign(
    null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(unsigned), "utf8"),
    input.privateKey,
  ).toString("base64url");
  const manifest: RealmWorldManifestV1 = {
    ...unsigned,
    signature: { ...unsigned.signature, value: signature },
  };
  for (const [relativePath, bytes] of files) {
    const destination = join(sourceDir, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await writeFile(join(sourceDir, "realmworld-manifest.json"), serializeRealmWorldManifest(manifest));
  await installRealmWorldDirectory({
    sourceDir,
    installRoot: input.installRoot,
    verifySignature: ({ manifest: candidate }) => candidate.signature.value === signature,
  });
  return { signature, sourceDir };
}

test("validator 工厂：精确包通过；缺包/篡改/签名/identity 失败映射稳定 code", async (t) => {
  const dataHome = await mkdtemp(join(tmpdir(), "realm-pure-mount-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const installRoot = join(dataHome, "installed");
  const { privateKey } = generateKeyPairSync("ed25519");
  const { signature, sourceDir } = await installFixturePackage({
    installRoot,
    worldId: WORLD_ID,
    version: WORLD_VERSION,
    privateKey,
  });
  await rm(sourceDir, { recursive: true, force: true });
  const validator = createRealmRuntimeSaveWorldBindingValidator({
    installRoot,
    verifySignature: ({ manifest }) => manifest.signature.value === signature,
    engineBaseVersion: "1.0.0",
  });

  // 精确 identity 的已安装可信包 → 通过。
  await validator({ worldId: WORLD_ID, worldVersion: WORLD_VERSION });

  // 缺包 → REALMWORLD_PACKAGE_MISSING。
  await assert.rejects(
    () => validator({ worldId: WORLD_ID, worldVersion: "9.9.9" }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_PACKAGE_MISSING",
  );

  // 篡改 content → content hash 失效 → REALMWORLD_PACKAGE_UNTRUSTED。
  const legitDir = join(installRoot, WORLD_ID, WORLD_VERSION);
  const tampered = join(installRoot, WORLD_ID, "9.9.8");
  await cp(legitDir, tampered, { recursive: true });
  await writeFile(join(tampered, "content", "world.json"), JSON.stringify({
    worldId: WORLD_ID,
    title: { en: "tampered" },
    settings: {},
  }));
  await assert.rejects(
    () => validator({ worldId: WORLD_ID, worldVersion: "9.9.8" }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_PACKAGE_UNTRUSTED",
  );

  // 篡改签名（content 完好）→ REALMWORLD_PACKAGE_UNTRUSTED。
  const badSignature = join(installRoot, WORLD_ID, "9.9.6");
  await cp(legitDir, badSignature, { recursive: true });
  const manifestPath = join(badSignature, "realmworld-manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifestText.replace(/"value":"?([A-Za-z0-9-_])/, (whole, first: string) =>
      `"value":"${first === "A" ? "B" : "A"}`),
  );
  await assert.rejects(
    () => validator({ worldId: WORLD_ID, worldVersion: "9.9.6" }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_PACKAGE_UNTRUSTED",
  );

  // 目录名=请求版本但 manifest identity 不符 → REALMWORLD_IDENTITY_MISMATCH。
  const mismatched = join(installRoot, WORLD_ID, "9.9.7");
  await cp(legitDir, mismatched, { recursive: true });
  await assert.rejects(
    () => validator({ worldId: WORLD_ID, worldVersion: "9.9.7" }),
    (error: unknown) => error instanceof RealmRuntimeSaveRepositoryError
      && error.code === "REALMWORLD_IDENTITY_MISMATCH",
  );
});

test("validator 工厂：活动 base 版本不兼容 → BASE_VERSION_INCOMPATIBLE，不泄露路径/签名", async (t) => {
  const dataHome = await mkdtemp(join(tmpdir(), "realm-pure-compat-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const installRoot = join(dataHome, "installed");
  const { privateKey } = generateKeyPairSync("ed25519");
  const { signature, sourceDir } = await installFixturePackage({
    installRoot,
    worldId: WORLD_ID,
    version: WORLD_VERSION,
    privateKey,
  });
  await rm(sourceDir, { recursive: true, force: true });
  // 包声明 baseRange ">=1.0.0 <2.0.0"；活动 base 版本 2.0.0 → fail-closed。
  const validator = createRealmRuntimeSaveWorldBindingValidator({
    installRoot,
    verifySignature: ({ manifest }) => manifest.signature.value === signature,
    engineBaseVersion: "2.0.0",
  });
  await assert.rejects(
    () => validator({ worldId: WORLD_ID, worldVersion: WORLD_VERSION }),
    (error: unknown) => {
      assert.ok(error instanceof RealmRuntimeSaveRepositoryError);
      assert.equal(error.code, "BASE_VERSION_INCOMPATIBLE");
      assert.ok(!error.message.includes(installRoot), "不得泄露 installRoot");
      assert.ok(!error.message.includes("signature"), "不得泄露签名细节");
      return true;
    },
  );
  // 匹配的活动 base 版本 → 同一包恢复可用（rollback 恢复兼容基线语义）。
  const compatible = createRealmRuntimeSaveWorldBindingValidator({
    installRoot,
    verifySignature: ({ manifest }) => manifest.signature.value === signature,
    engineBaseVersion: "1.0.0",
  });
  await compatible({ worldId: WORLD_ID, worldVersion: WORLD_VERSION });
});

test("restore 路由：world-bound 缺 install/trust 配置 → 503 REALMWORLD_VALIDATION_UNAVAILABLE", async (t) => {
  const saved = {
    runtime: process.env.REALM_RUNTIME_DATABASE_URL,
    installRoot: process.env.REALM_REALMWORLD_INSTALL_ROOT,
    workerInstallRoot: process.env.REALM_GOAL_WORKER_INSTALL_ROOT,
    trustStore: process.env.REALM_REALMWORLD_TRUST_STORE,
  };
  t.after(() => {
    for (const [key, value] of [
      ["REALM_RUNTIME_DATABASE_URL", saved.runtime],
      ["REALM_REALMWORLD_INSTALL_ROOT", saved.installRoot],
      ["REALM_GOAL_WORKER_INSTALL_ROOT", saved.workerInstallRoot],
      ["REALM_REALMWORLD_TRUST_STORE", saved.trustStore],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.REALM_RUNTIME_DATABASE_URL = "postgres://realm_runtime@127.0.0.1:1/realm_dev";
  delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
  delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  delete process.env.REALM_REALMWORLD_TRUST_STORE;
  installTestSessionSecret();

  const archive = worldBoundArchive();
  const bytes = buildRealmRuntimeSaveArchive({
    manifest: archive.manifest,
    record: archive.record,
    goals: archive.goals,
  });
  const response = await restoreRuntimeRecord(new Request("http://127.0.0.1/api/record/restore", {
    method: "POST",
    headers: {
      "content-type": "application/vnd.realm.save+zip",
      "idempotency-key": "pure-route-binding",
      cookie: `realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`,
    },
    body: Buffer.from(bytes),
  }));
  assert.equal(response.status, 503);
  const payload = await response.json() as { ok: boolean; error?: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, "REALMWORLD_VALIDATION_UNAVAILABLE");
});
