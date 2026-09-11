/**
 * v37 Y4：H.1 六路由真实 PG 测试（隔离库 finally DROP）。
 * export 200/403/404/401/400；dry-run 200/422/413；execute 全链 200 +
 * archive 422 + PACK_MISMATCH 409；cancel 200/404/409；status operator/
 * 目标 owner/404；jobs operator 边界 + limit/offset；全部 no-store。
 * 前端零身份字段（body 身份字段忽略——只从 session 解析）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { endTransferPool } from "../app/api/world/transfer-shared.ts";
import { POST as exportPOST } from "../app/api/world/export/route.ts";
import { POST as dryRunPOST } from "../app/api/world/import/dry-run/route.ts";
import { POST as executePOST } from "../app/api/world/import/execute/route.ts";
import { POST as cancelPOST } from "../app/api/world/import/cancel/route.ts";
import { GET as statusGET } from "../app/api/world/import/status/route.ts";
import { GET as jobsGET } from "../app/api/world/import/jobs/route.ts";
import { validateRealmPack } from "../modules/world-transfer/realm-pack.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const OWNER = POSTGRES_DEMO_IDS.principal;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function multipartBody(
  fields: Record<string, string>,
  fileBytes: Buffer,
  filename = "pack.realm",
): { body: Buffer; contentType: string } {
  const boundary = "----realmtestboundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.realm.world+zip\r\n\r\n`,
    "utf8",
  ));
  chunks.push(fileBytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function jsonRequest(body: unknown, principalId: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principalId) {
    headers.cookie = `realm_session=${createSessionValue(principalId)}`;
  }
  return new Request("http://local.test/api", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function uploadRequest(
  fields: Record<string, string>,
  fileBytes: Buffer,
  principalId: string | null,
  url = "http://local.test/api",
): Request {
  const { body, contentType } = multipartBody(fields, fileBytes);
  const headers: Record<string, string> = { "content-type": contentType };
  if (principalId) {
    headers.cookie = `realm_session=${createSessionValue(principalId)}`;
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: new Blob([new Uint8Array(body)], { type: "application/octet-stream" }),
  });
}

test(
  "Y4 six routes: full matrix on real PG",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_routes_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3, idleTimeoutMillis: 0 });
    ownerPool.on("error", () => undefined);
    const transferUrl = new URL(adminUrl);
    transferUrl.pathname = `/${databaseName}`;
    transferUrl.username = "realm_transfer";
    transferUrl.password = "";
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.pathname = `/${databaseName}`;
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";

    const previousRuntime = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousTransfer = process.env.REALM_TRANSFER_DATABASE_URL;
    const previousToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_TRANSFER_DATABASE_URL = transferUrl.href;
    process.env.REALM_ACCESS_TOKEN = "y4-gate-token";
    t.after(async () => {
      if (previousRuntime === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = previousRuntime;
      if (previousTransfer === undefined) delete process.env.REALM_TRANSFER_DATABASE_URL;
      else process.env.REALM_TRANSFER_DATABASE_URL = previousTransfer;
      if (previousToken === undefined) delete process.env.REALM_ACCESS_TOKEN;
      else process.env.REALM_ACCESS_TOKEN = previousToken;
      await endTransferPool();
      await endSharedRuntimePools();
      await ownerPool.end().catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    await ownerPool.query("SELECT set_config('realm.workspace_id', $1, false)", [WS]);
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '演示玩家'), ($1, 'principal_member', '成员甲'), ($1, 'principal_stranger', '路人')
       ON CONFLICT DO NOTHING`,
      [WS, OWNER],
    );
    await ownerPool.query(
      `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
       VALUES ($1, $2, 'principal_member', 'player')`,
      [WS, WORLD],
    );

    // ---- export route ----
    const noSession = await exportPOST(jsonRequest({ worldId: WORLD, mode: "full" }, null));
    assert.equal(noSession.status, 401);
    const badBody = await exportPOST(jsonRequest({ worldId: WORLD, mode: "nope" }, OWNER));
    assert.equal(badBody.status, 400);
    const notOwner = await exportPOST(jsonRequest({ worldId: WORLD, mode: "full" }, "principal_member"));
    assert.equal(notOwner.status, 403);
    const stranger = await exportPOST(jsonRequest({ worldId: WORLD, mode: "full" }, "principal_stranger"));
    assert.equal(stranger.status, 404);
    const exported = await exportPOST(jsonRequest({ worldId: WORLD, mode: "template" }, OWNER));
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/vnd.realm.world+zip");
    assert.match(exported.headers.get("content-disposition") ?? "", /\.realm/);
    assert.equal(exported.headers.get("cache-control"), "no-store");
    const packBytes = Buffer.from(await exported.arrayBuffer());
    const validated = validateRealmPack(new Uint8Array(packBytes));
    assert.equal(validated.manifest.scope.kind, "template");

    // ---- dry-run route ----（copy 模式：demo 世界在同库已存在，preserve
    // 会 WORLD_EXISTS；copy 生成重映射副本——execute 全链用 copy。）
    const dry = await dryRunPOST(uploadRequest(
      { importMode: "copy", copyKey: "y4main" },
      packBytes,
      OWNER,
    ));
    assert.equal(dry.status, 200);
    const dryBody = await dry.json() as { ok: boolean; jobId: string; report: { kind: string } };
    assert.equal(dryBody.ok, true);
    assert.equal(dryBody.report.kind, "template");

    // 篡改包 → 422（CRC/hash 链）。
    const tampered = Buffer.from(packBytes);
    tampered[tampered.length - 40] ^= 0xff;
    const tamperedResponse = await dryRunPOST(
      uploadRequest({ importMode: "preserve" }, tampered, OWNER),
    );
    assert.equal(tamperedResponse.status, 422);

    // Content-Length 超限 → 不读体 413。
    const oversized = new Request("http://local.test/api", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": "71303169",
        cookie: `realm_session=${createSessionValue(OWNER)}`,
      },
      body: Buffer.alloc(1024),
    });
    const oversizedResponse = await dryRunPOST(oversized);
    assert.equal(oversizedResponse.status, 413);

    // 多余字段 → 400。
    const extraField = await dryRunPOST(
      uploadRequest({ importMode: "preserve", hacker: "x" }, packBytes, OWNER),
    );
    assert.equal(extraField.status, 400);

    // ---- execute route ----
    // confirm 缺失 → 400。
    const noConfirm = await executePOST(
      uploadRequest({ jobId: dryBody.jobId }, packBytes, OWNER),
    );
    assert.equal(noConfirm.status, 400);
    const executed = await executePOST(
      uploadRequest({ jobId: dryBody.jobId, confirm: "true" }, packBytes, OWNER),
    );
    assert.equal(executed.status, 200);
    const executedBody = await executed.json() as {
      ok: boolean;
      worldId: string;
      alreadyImported: boolean;
    };
    assert.equal(executedBody.ok, true);
    assert.match(executedBody.worldId, /^world_[0-9a-f]{18}$/);
    assert.notEqual(executedBody.worldId, WORLD);
    assert.equal(executedBody.alreadyImported, false);

    // 重复 execute → alreadyImported。
    const reexecuted = await executePOST(
      uploadRequest({ jobId: dryBody.jobId, confirm: "true" }, packBytes, OWNER),
    );
    assert.equal((await reexecuted.json() as { alreadyImported: boolean }).alreadyImported, true);

    // PACK_MISMATCH：他包 + 新 jobId（未完成的 job；completed 幂等读回先行）
    // → 409 不动 job。
    const freshDry = await dryRunPOST(uploadRequest(
      { importMode: "copy", copyKey: "y4mismatch" },
      packBytes,
      OWNER,
    ));
    const freshJobId = (await freshDry.json() as { jobId: string }).jobId;
    const other = await exportPOST(jsonRequest({ worldId: WORLD, mode: "full" }, OWNER));
    const otherBytes = Buffer.from(await other.arrayBuffer());
    const mismatch = await executePOST(
      uploadRequest({ jobId: freshJobId, confirm: "true" }, otherBytes, OWNER),
    );
    assert.equal(mismatch.status, 409);
    const mismatchBody = await mismatch.json() as { error: { code: string } };
    assert.equal(mismatchBody.error.code, "PACK_MISMATCH");

    // archive 包 execute → 422（dry-run 正常）。
    const archiveExport = await exportPOST(jsonRequest({
      worldId: WORLD,
      mode: "selection",
      recordIds: [POSTGRES_DEMO_IDS.record],
    }, OWNER));
    const archiveBytes = Buffer.from(await archiveExport.arrayBuffer());
    const archiveDry = await dryRunPOST(
      uploadRequest({ importMode: "preserve" }, archiveBytes, OWNER),
    );
    const archiveDryBody = await archiveDry.json() as { jobId: string };
    const archiveExec = await executePOST(
      uploadRequest({ jobId: archiveDryBody.jobId, confirm: "true" }, archiveBytes, OWNER),
    );
    assert.equal(archiveExec.status, 422);
    assert.equal(
      (await archiveExec.json() as { error: { code: string } }).error.code,
      "ARCHIVE_PACK_NOT_IMPORTABLE",
    );

    // ---- cancel route ----
    const cancelDry = await dryRunPOST(
      uploadRequest({ importMode: "copy", copyKey: "cancelkey" }, packBytes, OWNER),
    );
    const cancelDryBody = await cancelDry.json() as { jobId: string };
    const cancel404 = await cancelPOST(jsonRequest({ jobId: cancelDryBody.jobId }, "principal_member"));
    assert.equal(cancel404.status, 404, "非 operator 404");
    const cancelled = await cancelPOST(jsonRequest({ jobId: cancelDryBody.jobId }, OWNER));
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json() as { status: string; idempotent: boolean };
    assert.equal(cancelledBody.status, "cancelled");
    assert.equal(cancelledBody.idempotent, false);
    const cancelledAgain = await cancelPOST(jsonRequest({ jobId: cancelDryBody.jobId }, OWNER));
    assert.equal((await cancelledAgain.json() as { idempotent: boolean }).idempotent, true);
    // completed job cancel → 409。
    const cancelCompleted = await cancelPOST(jsonRequest({ jobId: dryBody.jobId }, OWNER));
    assert.equal(cancelCompleted.status, 409);

    // ---- status route ----
    const status = await statusGET(
      new Request(`http://local.test/api?jobId=${dryBody.jobId}`, {
        headers: { cookie: `realm_session=${createSessionValue(OWNER)}` },
      }),
    );
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { job: { status: string; events: unknown[] } };
    assert.equal(statusBody.job.status, "completed");
    assert.ok(statusBody.job.events.length >= 4);
    // 非 operator 非目标 owner → 404。
    const status404 = await statusGET(
      new Request(`http://local.test/api?jobId=${dryBody.jobId}`, {
        headers: { cookie: `realm_session=${createSessionValue("principal_stranger")}` },
      }),
    );
    assert.equal(status404.status, 404);
    // 目标 world owner（导入后 operator 即 owner）→ 200。
    const statusOwner = await statusGET(
      new Request(`http://local.test/api?jobId=${dryBody.jobId}`, {
        headers: { cookie: `realm_session=${createSessionValue(OWNER)}` },
      }),
    );
    assert.equal(statusOwner.status, 200);

    // ---- jobs route ----
    const jobs = await jobsGET(
      new Request("http://local.test/api?limit=50&offset=0", {
        headers: { cookie: `realm_session=${createSessionValue(OWNER)}` },
      }),
    );
    assert.equal(jobs.status, 200);
    const jobsBody = await jobs.json() as { jobs: { id: string; direction: string }[] };
    assert.ok(jobsBody.jobs.length >= 3);
    assert.ok(jobsBody.jobs.some((job) => job.direction === "export"));
    assert.ok(jobsBody.jobs.some((job) => job.direction === "import"));
    // limit 边界 + 超界 offset 空数组 + 非 operator 空。
    const badLimit = await jobsGET(
      new Request("http://local.test/api?limit=99", {
        headers: { cookie: `realm_session=${createSessionValue(OWNER)}` },
      }),
    );
    assert.equal(badLimit.status, 400);
    const emptyPage = await jobsGET(
      new Request("http://local.test/api?offset=999", {
        headers: { cookie: `realm_session=${createSessionValue(OWNER)}` },
      }),
    );
    assert.deepEqual((await emptyPage.json() as { jobs: unknown[] }).jobs, []);
    const nobody = await jobsGET(
      new Request("http://local.test/api", {
        headers: { cookie: `realm_session=${createSessionValue("principal_stranger")}` },
      }),
    );
    assert.deepEqual((await nobody.json() as { jobs: unknown[] }).jobs, []);
  },
);
