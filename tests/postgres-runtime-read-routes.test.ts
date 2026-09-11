/**
 * 批次 T10-B8-A——残余 owner-pool 读路由下沉（files/[id]、settings/language、
 * auth/me）focused 测试（docs/development/T10-B8-A-RUNTIME-READ-ROUTES.md §五）。
 * 真实临时 PG（库名 realm_t10b8_*，t.after 强制 DROP）：文件成员隔离与
 * immutable 响应头、语言写回、auth/me gate 两态与 best-effort 回落；
 * 全程 REALM_RUNTIME_DATABASE_URL 受限角色池，零 owner 引用。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo } from "../database/postgres/public.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { GET as fileGET } from "../app/api/files/[id]/route.ts";
import { POST as languagePOST } from "../app/api/settings/language/route.ts";
import { GET as meGET } from "../app/api/auth/me/route.ts";

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
];

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

function requestWithSession(path: string, principalId: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `realm_session=${createSessionValue(principalId)}` },
  });
}

test(
  "T10-B8-A: files/language/auth-me run on the shared runtime pool with membership gates intact",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b8_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    // 门禁开启：会话 cookie 决定 principal（成员/陌生人分流）。
    process.env.REALM_ACCESS_TOKEN = "t10b8-gate-token";

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
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name, ui_language)
       VALUES ('ws_demo', $1, $2, 'zh-CN') ON CONFLICT DO NOTHING`,
      ["principal_demo_player", "演示旅人"],
    );
    // 文件：demo 世界成员可读、陌生人 403、未知/畸形 id 404。
    await ownerPool.query(
      `INSERT INTO world_files (
         workspace_id, world_id, id, kind, filename, content_type,
         data, sha256, size_bytes
       ) VALUES ('ws_demo', 'world_ember_coast', 'file_a10b8c',
         'character_avatar', 'a.png', 'image/png', $1, 'x', 4)`,
      [Buffer.from([1, 2, 3, 4])],
    );

    const memberFile = await fileGET(
      requestWithSession("/api/files/file_a10b8c", "principal_demo_player"),
      { params: Promise.resolve({ id: "file_a10b8c" }) },
    );
    assert.equal(memberFile.status, 200);
    assert.equal(
      memberFile.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(memberFile.headers.get("Content-Type"), "image/png");

    const strangerFile = await fileGET(
      requestWithSession("/api/files/file_a10b8c", "principal_stranger"),
      { params: Promise.resolve({ id: "file_a10b8c" }) },
    );
    assert.equal(strangerFile.status, 403, "非成员读文件 403");
    const unknownFile = await fileGET(
      requestWithSession("/api/files/file_a10b8d", "principal_demo_player"),
      { params: Promise.resolve({ id: "file_a10b8d" }) },
    );
    assert.equal(unknownFile.status, 404);
    const malformed = await fileGET(
      requestWithSession("/api/files/not-a-file", "principal_demo_player"),
      { params: Promise.resolve({ id: "not-a-file" }) },
    );
    assert.equal(malformed.status, 404);

    // 语言写回：合法值落库、非法值回落 zh-CN；陌生人账号不存在不炸。
    const saved = await languagePOST(
      new Request("http://localhost/api/settings/language", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: `realm_session=${createSessionValue("principal_demo_player")}`,
        },
        body: JSON.stringify({ language: "en" }),
      }),
    );
    assert.equal(saved.status, 200);
    const account = await ownerPool.query(
      `SELECT ui_language FROM accounts
       WHERE workspace_id = 'ws_demo' AND principal_id = 'principal_demo_player'`,
    );
    assert.equal(account.rows[0].ui_language, "en");
    // auth/me：gate 开启——会话 principal + best-effort 反查成功
    //（须在语言回退写之前读——非法值回落会真实写回 zh-CN）。
    const me = await meGET(
      requestWithSession("/api/auth/me", "principal_demo_player"),
    );
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as {
      gated: boolean;
      principalId: string;
      displayName: string | null;
      uiLanguage: string;
    };
    assert.equal(meBody.gated, true);
    assert.equal(meBody.principalId, "principal_demo_player");
    assert.equal(meBody.displayName, "演示旅人");
    assert.equal(meBody.uiLanguage, "en");
    // 无会话 → 401。
    const anon = await meGET(new Request("http://localhost/api/auth/me"));
    assert.equal(anon.status, 401);

    const fallback = await languagePOST(
      new Request("http://localhost/api/settings/language", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: `realm_session=${createSessionValue("principal_demo_player")}`,
        },
        body: JSON.stringify({ language: "klingon" }),
      }),
    );
    assert.equal(fallback.status, 200);
    assert.equal(
      ((await fallback.json()) as { language: string }).language,
      "zh-CN",
      "非法语言值回落默认中文",
    );

    // gate 关闭：本地单用户应答，不触 DB。
    delete process.env.REALM_ACCESS_TOKEN;
    const local = await meGET(new Request("http://localhost/api/auth/me"));
    assert.equal(local.status, 200);
    const localBody = (await local.json()) as {
      gated: boolean;
      principalId: string;
    };
    assert.equal(localBody.gated, false);
    assert.equal(localBody.principalId, "principal_demo_player");
    process.env.REALM_ACCESS_TOKEN = "t10b8-gate-token";
  },
);
