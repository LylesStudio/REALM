/**
 * 批次 T11-H + v37 H.3——mapping 治理 CLI（scripts/propagation-node-audiences.mjs）
 * 真实临时 PG 回归（t.after 强制拆库，迁移 0001–0043 全链 + demo 拓扑种子）：
 * list 输出 nodes/routes/continuities/mappings；add 经 0043 capability
 * function（--principal 必填，函数内 owner/active/archived 校验为最终闸门；
 * admission lock 内建）；重复 add 幂等；未知 world/node/continuity、失效
 * continuity、非 owner、归档世界全非零退出；输出稳定 JSON 且零凭据。
 * 零开发库污染。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const MIGRATION_DIR = new URL("../database/postgres/migrations/", import.meta.url);

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  principalId: POSTGRES_DEMO_IDS.principal,
};

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

test(
  "T11-H: propagation-node-audiences CLI lists and appends mappings with governance guards",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11hcli_${randomUUID().replaceAll("-", "")}`;
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

    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    const { readdir } = await import("node:fs/promises");
    for (const filename of (await readdir(MIGRATION_DIR)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, MIGRATION_DIR), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    await seedPostgresDemoPropagationTopology(ownerPool);

    const script = fileURLToPath(
      new URL("../scripts/propagation-node-audiences.mjs", import.meta.url),
    );
    const runCli = (argv: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", script, ...argv],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: {
              REALM_RUNTIME_DATABASE_URL: runtimeUrl.href,
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

    // 1. list：nodes/routes/continuities/mappings 齐备且稳定。
    const listed = await runCli(["list", "--world", SCOPE.worldId]);
    assert.equal(listed.code, 0, listed.stderr);
    const listBody = JSON.parse(listed.stdout);
    assert.equal(listBody.ok, true);
    assert.equal(listBody.worldline, SCOPE.worldlineId);
    assert.deepEqual(
      listBody.nodes.map((node: { node_key: string }) => node.node_key),
      ["canon_origin", "harbor_tavern", "market_square"],
    );
    assert.equal(listBody.routes.length, 2);
    assert.deepEqual(listBody.continuities.map((row: { id: string }) => row.id).sort(), [
      "continuity_player",
      "continuity_scholar",
      "continuity_scout",
    ]);
    assert.deepEqual(listBody.mappings, []);
    assert.ok(!listed.stdout.includes(ownerUrl.href), "输出不得含连接串");

    // 2. add：合法映射插入；重复 add 幂等（added:false，行数不变）。
    const added = await runCli([
      "add",
      "--world", SCOPE.worldId,
      "--node", "harbor_tavern",
      "--continuity", "continuity_scout",
      "--principal", SCOPE.principalId,
    ]);
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(JSON.parse(added.stdout), {
      ok: true,
      world: SCOPE.worldId,
      worldline: SCOPE.worldlineId,
      node: "harbor_tavern",
      continuity: "continuity_scout",
      added: true,
    });
    const duplicate = await runCli([
      "add",
      "--world", SCOPE.worldId,
      "--node", "harbor_tavern",
      "--continuity", "continuity_scout",
      "--principal", SCOPE.principalId,
    ]);
    assert.equal(duplicate.code, 0);
    assert.equal(JSON.parse(duplicate.stdout).added, false, "重复 add 幂等");
    const mappingRows = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_node_audiences`,
    );
    assert.equal(mappingRows.rows[0].c, 1);

    // 3. 越界拒绝：未知 world/node/continuity 与失效 continuity 全非零退出。
    const unknownWorld = await runCli(["list", "--world", "world_nope"]);
    assert.notEqual(unknownWorld.code, 0);
    assert.equal(JSON.parse(unknownWorld.stdout).error.code, "WORLD_NOT_FOUND");
    const unknownNode = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "node_nope",
      "--continuity", "continuity_scout", "--principal", SCOPE.principalId,
    ]);
    assert.notEqual(unknownNode.code, 0);
    assert.equal(JSON.parse(unknownNode.stdout).error.code, "PROPAGATION_AUDIENCE_NODE_NOT_FOUND");
    const unknownContinuity = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "market_square",
      "--continuity", "continuity_nope", "--principal", SCOPE.principalId,
    ]);
    assert.notEqual(unknownContinuity.code, 0);
    assert.equal(
      JSON.parse(unknownContinuity.stdout).error.code,
      "PROPAGATION_AUDIENCE_CONTINUITY_NOT_FOUND",
    );
    await ownerPool.query(
      `UPDATE character_continuities SET status = 'ended'
       WHERE id = 'continuity_scholar'`,
    );
    const inactive = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "market_square",
      "--continuity", "continuity_scholar", "--principal", SCOPE.principalId,
    ]);
    assert.notEqual(inactive.code, 0);
    assert.equal(JSON.parse(inactive.stdout).error.code, "PROPAGATION_AUDIENCE_CONTINUITY_INACTIVE");
    // v37 H.3：--principal 必填；非 owner → OWNER_REQUIRED；归档世界 →
    // WORLD_ARCHIVED（0043 gate 真实生效）。
    const noPrincipal = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "market_square",
      "--continuity", "continuity_scout",
    ]);
    assert.notEqual(noPrincipal.code, 0);
    assert.equal(JSON.parse(noPrincipal.stdout).error.code, "USAGE");
    const notOwner = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "market_square",
      "--continuity", "continuity_scout", "--principal", "principal_stranger",
    ]);
    assert.notEqual(notOwner.code, 0);
    assert.equal(
      JSON.parse(notOwner.stdout).error.code,
      "PROPAGATION_AUDIENCE_OWNER_REQUIRED",
    );
    await ownerPool.query(
      `UPDATE worlds SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    const archived = await runCli([
      "add", "--world", SCOPE.worldId, "--node", "market_square",
      "--continuity", "continuity_scout", "--principal", SCOPE.principalId,
    ]);
    assert.notEqual(archived.code, 0);
    assert.equal(
      JSON.parse(archived.stdout).error.code,
      "PROPAGATION_AUDIENCE_WORLD_ARCHIVED",
    );

    const finalCount = await ownerPool.query(
      `SELECT count(*)::int AS c FROM propagation_node_audiences`,
    );
    assert.equal(finalCount.rows[0].c, 1, "拒绝路径零写入");
  },
);
