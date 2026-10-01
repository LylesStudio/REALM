/**
 * H1 回归：/api/record/scene-image 授权门禁（真实临时 PG + 真实 route）。
 *
 * 非成员（对他人世界的 Record 无 membership/viewer projection）调用
 * prepare 与 dispatch 都必须 fail-closed 404（不泄漏存在性），且：
 * 零台账写入（scene_image_generations 无行）、零 provider 接触
 * （ComfyUI 配置指向关闭的 loopback 端口，任何外呼都会报错）。
 * 授权 viewer（demo 玩家）的 prepare-only 既有路径必须仍可用。
 *
 * 运行：node scripts/test-postgres-runtime-with-scratch.mjs <本文件>
 * （scratch runner 提供一次性 PG 集群；本文件自建独立库并 finally 拆除）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { createSessionValue, SESSION_COOKIE } from "../modules/identity/auth.ts";
import { POST as sceneImagePost } from "../app/api/record/scene-image/route.ts";
import { closeDefaultLocalRecordService } from "../modules/application/local-record-service.ts";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const OUTSIDER_PRINCIPAL = "principal_scene_image_outsider";

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

function postSceneImage(body: unknown, principalId?: string): Request {
  return new Request("http://localhost/api/record/scene-image", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(principalId
        ? { cookie: `${SESSION_COOKIE}=${createSessionValue(principalId)}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

test(
  "scene-image route: non-member is rejected fail-closed with zero side effects; member prepare still works",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneimg_auth_${randomUUID().replaceAll("-", "")}`;
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

    // ComfyUI 配置启用但指向关闭的 loopback 端口：任何真实 provider
    // 接触都会以连接错误暴露（测试零外部调用）。
    const dataHome = await mkdtemp(join(tmpdir(), "realm-sceneimg-auth-"));
    await mkdir(join(dataHome, "settings"), { recursive: true });
    await writeFile(
      join(dataHome, "settings", "comfyui.json"),
      JSON.stringify({
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        requestTimeoutMs: 5_000,
        workflowId: "anima-scene-t2i-v0",
        apiKey: "",
        updatedAt: "2026-09-28T00:00:00.000Z",
      }),
    );

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousDataHome = process.env.REALM_DATA_HOME;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    process.env.REALM_DATA_HOME = dataHome;

    t.after(async () => {
      // 先释放 route 持有的连接（默认服务单例池 + 共享池），再拆库——
      // 否则 DROP FORCE 终止空闲客户端会抛出 pool error。
      await closeDefaultLocalRecordService();
      await endSharedRuntimePools();
      if (previousRuntimeUrl === undefined) {
        delete process.env.REALM_RUNTIME_DATABASE_URL;
      } else {
        process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      }
      if (previousDataHome === undefined) {
        delete process.env.REALM_DATA_HOME;
      } else {
        process.env.REALM_DATA_HOME = previousDataHome;
      }
      await rm(dataHome, { recursive: true, force: true });
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    // 非成员账号：存在于 accounts，但对演示世界无任何 membership。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3)`,
      [POSTGRES_DEMO_IDS.workspace, OUTSIDER_PRINCIPAL, "局外人"],
    );
    const outsiderMembership = await ownerPool.query(
      `SELECT count(*)::int AS count FROM player_world_memberships
       WHERE workspace_id = $1 AND principal_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, OUTSIDER_PRINCIPAL],
    );
    assert.equal(outsiderMembership.rows[0]!.count, 0, "fixture: outsider 必须是非成员");

    const generationCount = async (): Promise<number> => {
      const rows = await ownerPool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM scene_image_generations
         WHERE workspace_id = $1 AND record_id = $2`,
        [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
      );
      return rows.rows[0]!.count;
    };

    // 非成员 dispatch:true → 404 NOT_FOUND；零台账写入（若发生 provider
    // 接触，指向关闭端口的配置会让其显性失败而非静默成功）。
    const dispatchResponse = await sceneImagePost(
      postSceneImage(
        { recordId: POSTGRES_DEMO_IDS.record, dispatch: true },
        OUTSIDER_PRINCIPAL,
      ),
    );
    const dispatchBody = await dispatchResponse.json() as {
      ok: boolean;
      error?: { code?: string };
    };
    assert.equal(dispatchResponse.status, 404, "非成员 dispatch 必须 fail-closed 404");
    assert.equal(dispatchBody.ok, false);
    assert.equal(dispatchBody.error?.code, "NOT_FOUND", "不得泄漏 Record 存在性");
    assert.equal(await generationCount(), 0, "非成员 dispatch 不得写生成台账");

    // 非成员 prepare-only 同样拒绝（prompt 含世界/故事/场景数据）。
    const prepareResponse = await sceneImagePost(
      postSceneImage({ recordId: POSTGRES_DEMO_IDS.record }, OUTSIDER_PRINCIPAL),
    );
    assert.equal(prepareResponse.status, 404, "非成员 prepare 必须 fail-closed 404");
    assert.equal(await generationCount(), 0);

    // 无会话 → 401（门禁开启时）。
    const anonymous = await sceneImagePost(
      postSceneImage({ recordId: POSTGRES_DEMO_IDS.record, dispatch: true }),
    );
    assert.equal(anonymous.status, 401);
    assert.equal(await generationCount(), 0);

    // 授权 viewer（demo 玩家）prepare-only 既有路径仍可用：不触 provider、
    // 不写台账，返回 patched graph payload。
    const memberResponse = await sceneImagePost(
      postSceneImage(
        { recordId: POSTGRES_DEMO_IDS.record },
        POSTGRES_DEMO_IDS.principal,
      ),
    );
    const memberBody = await memberResponse.json() as {
      ok: boolean;
      dispatched?: boolean;
      positivePrompt?: string;
    };
    assert.equal(memberResponse.status, 200, "授权 viewer 的 prepare 路径不得被误伤");
    assert.equal(memberBody.ok, true);
    assert.equal(memberBody.dispatched, false);
    assert.ok(
      typeof memberBody.positivePrompt === "string" && memberBody.positivePrompt.length > 0,
      "prepare 应返回合成 prompt",
    );
    assert.equal(await generationCount(), 0, "prepare-only 不写台账");
  },
);
