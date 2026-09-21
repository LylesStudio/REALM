/**
 * v37 测试入口：在一次性 host-network loopback PG17 scratch cluster 中运行
 * 完整 postgres-runtime 套件（含 v37 transfer/export/import/route 新套件）。
 *
 * 自包含隔离契约：
 * - realm_transfer / realm_runtime / realm_control 只在本集群 provision
 *   （绝不写共享 realm_dev 或任何长期实例）；
 * - host-network + 动态 loopback 端口——真实 runner 的 inet_server_addr
 *   检查通过（不用 published-port）；
 * - realm_dev 在集群内新建、应用 0001–0044 全链、seed demo；
 * - 结束时销毁容器（含全部临时库），零残留。
 *
 * 用法：node scripts/test-postgres-runtime-with-scratch.mjs
 * （package.json test:postgres-runtime 的唯一入口；子进程继承
 * DATABASE_URL / REALM_RUNTIME_DATABASE_URL / REALM_TRANSFER_DATABASE_URL）。
 */
import { spawn, spawnSync as spawnSync0 } from "node:child_process";
import { createRequire } from "node:module";
import {
  dockerAvailable,
  startScratchPgCluster,
} from "../tests/helpers/v37-test-cluster.mjs";

const require0 = createRequire(import.meta.url);
const pg = require0("pg");

const TEST_FILES = [
  "tests/postgres-runtime-migration-hardening.test.ts",
  "tests/postgres-runtime-repository.test.ts",
  "tests/postgres-runtime-repository-failures.test.ts",
  "tests/postgres-delivery-projection.test.ts",
  "tests/postgres-local-record-application.test.ts",
  "tests/postgres-library-service.test.ts",
  "tests/postgres-m3-memory.test.ts",
  "tests/postgres-memory-pipeline.test.ts",
  "tests/postgres-m4-interjection.test.ts",
  "tests/postgres-m5-world-governance.test.ts",
  "tests/postgres-m5-batch2.test.ts",
  "tests/postgres-accounts.test.ts",
  "tests/postgres-scene-crystallization.test.ts",
  "tests/postgres-world-growth.test.ts",
  "tests/postgres-first-night.test.ts",
  "tests/postgres-tavern-import.test.ts",
  "tests/postgres-presence.test.ts",
  "tests/postgres-rule-realization.test.ts",
  "tests/postgres-dice-randomness.test.ts",
  "tests/postgres-tavern-import-play.test.ts",
  "tests/postgres-self-play.test.ts",
  "tests/postgres-world-admin.test.ts",
  "tests/postgres-canon-readback.test.ts",
  "tests/postgres-worldline-merge-route.test.ts",
  "tests/postgres-branch-lineage.test.ts",
  "tests/postgres-lobby.test.ts",
  "tests/postgres-scene-image.test.ts",
  "tests/postgres-scene-image-store.test.ts",
  "tests/postgres-scene-image-flow.test.ts",
  "tests/postgres-scene-image-queue.test.ts",
  "tests/scene-image-worker-runtime.test.ts",
  "tests/postgres-account-password.test.ts",
  "tests/postgres-preview-authorization.test.ts",
  "tests/postgres-conflict-route.test.ts",
  "tests/postgres-memory-snapshot-route.test.ts",
  "tests/postgres-library-runtime-grants.test.ts",
  "tests/postgres-runtime-read-routes.test.ts",
  "tests/postgres-canon-security-propagation.test.ts",
  "tests/postgres-propagation-exposures-route.test.ts",
  "tests/postgres-propagation-worker.test.ts",
  "tests/postgres-propagation-worker-runtime-acceptance.test.ts",
  "tests/postgres-graph-invalidation.test.ts",
  "tests/postgres-canon-propagation.test.ts",
  "tests/postgres-semantic-review-route.test.ts",
  "tests/postgres-canon-qualification.test.ts",
  "tests/postgres-propagation-worker-nonpublic-acceptance.test.ts",
  "tests/postgres-turn-efficiency.test.ts",
  "tests/postgres-canon-security-lore-gate.test.ts",
  "tests/postgres-world-lore.test.ts",
  "tests/propagation-node-audiences-cli.test.ts",
  "tests/postgres-article-qualification.test.ts",
  "tests/postgres-article-qualification-parallel.test.ts",
  "tests/postgres-archived-write-gate.test.ts",
  "tests/postgres-propagation-lease.test.ts",
  "tests/postgres-world-export.test.ts",
  "tests/postgres-realm-transfer-migration.test.mjs",
  "tests/local-bootstrap.test.mjs",
  "tests/postgres-world-import.test.ts",
  "tests/postgres-world-transfer-routes.test.ts",
  "tests/realm-transfer-cli.test.ts",
  "tests/postgres-article-qualification-migration.test.mjs",
  "tests/article-qualification-design.test.mjs",
];

function fail(message) {
  console.error(`test-postgres-runtime-with-scratch: ${message}`);
  process.exit(1);
}

if (!(await dockerAvailable())) {
  fail("docker is required for the isolated PG17 scratch cluster (no fallback to shared databases).");
}

const cluster = await startScratchPgCluster({
  label: "runtime",
  roles: ["realm_runtime", "realm_control", "realm_transfer"],
});

// 信号兜底：Ctrl+C/SIGTERM 也销毁集群（execFileSync 同步清理）。
const killClusterSync = () => {
  try {
    spawnSync0("docker", ["rm", "-f", cluster.name], { stdio: "ignore" });
  } catch { /* best effort */ }
};
process.on("SIGINT", () => {
  killClusterSync();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killClusterSync();
  process.exit(143);
});

const withDb = (base, database) =>
  `${base.replace(/\/postgres$/, "")}/${database}`;

async function runNode(scriptArgs, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ...envExtra },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}`));
    });
    child.on("error", reject);
  });
}

let exitCode = 0;
try {
  // realm_dev：建库 → 全链迁移（0001–0044）→ seed demo。
  const adminClient = new pg.Client({ connectionString: cluster.adminUrl });
  await adminClient.connect();
  await adminClient.query("CREATE DATABASE realm_dev");
  await adminClient.end();

  const adminDbUrl = withDb(cluster.adminUrl, "realm_dev");
  console.error("[scratch] applying migrations 0001–0044 to realm_dev …");
  await runNode(["scripts/postgres-migrate.mjs"], { DATABASE_URL: adminDbUrl });
  console.error("[scratch] seeding demo world …");
  await runNode(
    ["--experimental-strip-types", "scripts/postgres-seed-demo.mjs"],
    { DATABASE_URL: adminDbUrl },
  );

  console.error(`[scratch] running ${TEST_FILES.length} postgres-runtime files …`);
  await runNode(
    [
      "--experimental-strip-types",
      "--test",
      "--test-concurrency=1",
      ...TEST_FILES,
    ],
    {
      DATABASE_URL: adminDbUrl,
      REALM_RUNTIME_DATABASE_URL: withDb(cluster.runtimeUrl, "realm_dev"),
      REALM_TRANSFER_DATABASE_URL: withDb(cluster.transferUrl, "realm_dev"),
    },
  );
} catch (error) {
  console.error(`[scratch] FAILED: ${error instanceof Error ? error.message : error}`);
  exitCode = 1;
} finally {
  await cluster.stop();
  console.error("[scratch] cluster destroyed (container and all temp databases).");
}
process.exit(exitCode);
