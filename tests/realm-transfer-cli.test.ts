/**
 * v37 Y6：realm-export/realm-import CLI 真实 PG 回归（双隔离库 finally
 * DROP）。export → 文件（0600）+ JSON 摘要零凭据；import dry-run/execute/
 * cancel/幂等；USAGE 与未 provisioning 的退出码；输出不含连接串。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

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

test(
  "Y6 CLI: realm-export → realm-import dry-run/execute/cancel round-trip, credential-free output",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    // 单 t.after 收口（FIFO 噪声归零）：池关闭 → DROP → maintenance 断连。
    const createdPools: pg.Pool[] = [];
    const createdDbs: string[] = [];
    t.after(async () => {
      for (const pool of createdPools) {
        await pool.end().catch(() => undefined);
      }
      for (const name of createdDbs) {
        await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
          .catch(() => undefined);
      }
      await maintenance.end();
    });

    const makeDb = async (label: string) => {
      const name = `realm_cli_${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      await maintenance.query(`CREATE DATABASE "${name}"`);
      createdDbs.push(name);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      return url;
    };
    const applyAll = async (url: URL) => {
      const pool = new pg.Pool({ connectionString: url.href, max: 2, idleTimeoutMillis: 0 });
      pool.on("error", () => undefined);
      const dir = new URL("../database/postgres/migrations/", import.meta.url);
      for (const filename of (await readdir(dir)).sort()) {
        if (!filename.endsWith(".sql")) continue;
        await pool.query(await readFile(new URL(filename, dir), "utf8"));
      }
      return pool;
    };

    const srcUrl = await makeDb("src");
    const srcPool = await applyAll(srcUrl);
    createdPools.push(srcPool);
    await seedPostgresDemo(srcPool);
    await srcPool.query("SELECT set_config('realm.workspace_id', $1, false)", [WS]);
    await srcPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '演示玩家') ON CONFLICT DO NOTHING`,
      [WS, OWNER],
    );
    const dstUrl = await makeDb("dst");
    const dstPool = await applyAll(dstUrl);
    createdPools.push(dstPool);
    await dstPool.query("INSERT INTO workspaces (id, name) VALUES ($1, '目标')", [WS]);
    await dstPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '演示玩家') ON CONFLICT DO NOTHING`,
      [WS, OWNER],
    );

    const roleUrl = (base: URL, role: string) => {
      const url = new URL(base.href);
      url.username = role;
      url.password = "";
      return url.href;
    };
    const outPath = `/tmp/realm-cli-${randomUUID().replaceAll("-", "").slice(0, 10)}.realm`;
    t.after(async () => {
      await unlink(outPath).catch(() => undefined);
    });

    const runCli = (script: string, argv: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", script, ...argv],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: {
              REALM_TRANSFER_DATABASE_URL: roleUrl(dstUrl, "realm_transfer"),
              REALM_RUNTIME_DATABASE_URL: roleUrl(srcUrl, "realm_runtime"),
              ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
              ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
            } as unknown as NodeJS.ProcessEnv,
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });

    const exportScript = fileURLToPath(new URL("../scripts/realm-export.mjs", import.meta.url));
    const importScript = fileURLToPath(new URL("../scripts/realm-import.mjs", import.meta.url));

    // export（源库 transfer URL）——runCli 的 transfer env 指向 dst；export
    // 需要源库：单独一次以 src 为 transfer 目标。
    const exportRun = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", exportScript, "--world", WORLD, "--mode", "template", "--out", outPath],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            REALM_TRANSFER_DATABASE_URL: roleUrl(srcUrl, "realm_transfer"),
            REALM_RUNTIME_DATABASE_URL: roleUrl(srcUrl, "realm_runtime"),
            ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
            ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          } as unknown as NodeJS.ProcessEnv,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(exportRun.code, 0, exportRun.stderr);
    const exportBody = JSON.parse(exportRun.stdout);
    assert.equal(exportBody.ok, true);
    assert.match(exportBody.contentHash, /^[0-9a-f]{64}$/);
    assert.match(exportBody.archiveBytesHash, /^[0-9a-f]{64}$/);
    // 输出零凭据（无连接串形态）。
    assert.ok(!exportRun.stdout.includes("postgresql://"));
    // 文件 0600。
    const fileStat = await stat(outPath);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // import dry-run（目标库）。
    const dry = await runCli(importScript, ["--file", outPath, "--mode", "preserve"]);
    assert.equal(dry.code, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    assert.equal(dryBody.ok, true);
    assert.ok(dryBody.jobId);
    assert.equal(dryBody.report.kind, "template");

    // execute。
    const executed = await runCli(importScript, ["--file", outPath, "--execute", dryBody.jobId]);
    assert.equal(executed.code, 0, executed.stderr);
    const executedBody = JSON.parse(executed.stdout);
    assert.equal(executedBody.ok, true);
    assert.equal(executedBody.worldId, WORLD);
    const imported = await dstPool.query(
      `SELECT count(*)::int AS c FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [WS, WORLD],
    );
    assert.equal(imported.rows[0].c, 1);

    // 幂等重放（execute 同 jobId）。
    const replay = await runCli(importScript, ["--file", outPath, "--execute", dryBody.jobId]);
    assert.equal(JSON.parse(replay.stdout).alreadyImported, true);

    // cancel（新 dry-run 后取消）。
    const dry2 = await runCli(importScript, ["--file", outPath, "--mode", "copy", "--copy-key", "cli-copy"]);
    const dry2Body = JSON.parse(dry2.stdout);
    const cancelled = await runCli(importScript, ["--cancel", dry2Body.jobId]);
    assert.equal(cancelled.code, 0);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

    // USAGE：缺参数非零退出。
    const usage = await runCli(importScript, []);
    assert.notEqual(usage.code, 0);
    assert.equal(JSON.parse(usage.stdout).error.code, "USAGE");
  },
);
