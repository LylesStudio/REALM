import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASELINE_TABLES,
  InventoryError,
  buildInventoryReport,
  collectBaselineCounts,
  latestMigration,
  listTemporaryDatabases,
  planDropTargets,
} from "../scripts/db-maintenance-inventory.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/db-maintenance-inventory.mjs", import.meta.url),
);

/** 按 SQL 形态路由的内存 query 替身（测试不触真实数据库）。 */
function fakeQuery({ databases = [], existingTables = [], migration = null }) {
  const calls = [];
  const query = async (text, params) => {
    calls.push(text);
    if (text.includes("FROM pg_database")) {
      return { rows: databases.map((datname) => ({ datname })) };
    }
    if (text.includes("to_regclass")) {
      const name = params[0].replace(/^public\./, "");
      const present =
        name === "realm_schema_migrations"
          ? migration !== null
          : existingTables.includes(name);
      return { rows: [{ reg: present ? name : null }] };
    }
    if (text.includes("FROM realm_schema_migrations")) {
      return { rows: [{ latest: migration }] };
    }
    const countMatch = text.match(/FROM "public"\."([a-z0-9_]+)"/);
    if (countMatch) {
      return { rows: [{ n: existingTables.indexOf(countMatch[1]) }] };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return { query, calls };
}

test("report: empty inventory lists zero temporary databases", async () => {
  const { query } = fakeQuery({ databases: [] });
  const report = await buildInventoryReport(query, "realm_dev");
  assert.deepEqual(report.temporaryDatabases, []);
  assert.equal(report.temporaryDatabaseCount, 0);
  assert.equal(report.database, "realm_dev");
});

test("report: leftover realm_t% databases are listed in stable order", async () => {
  const leftovers = ["realm_t11b_a1", "realm_t10b7_post_x", "realm_t11bwk_b2"];
  const { query } = fakeQuery({ databases: leftovers });
  const names = await listTemporaryDatabases(query);
  assert.deepEqual(names, leftovers);
  const report = await buildInventoryReport(query, "realm_dev");
  assert.equal(report.temporaryDatabaseCount, 3);
});

test("baseline: missing tables report null instead of throwing", async () => {
  const { query } = fakeQuery({ existingTables: ["worlds", "accounts"] });
  const counts = await collectBaselineCounts(query);
  assert.equal(counts.worlds, 0);
  assert.equal(counts.accounts, 1);
  assert.equal(counts.propagation_nodes, null);
  assert.deepEqual(Object.keys(counts), [...BASELINE_TABLES]);
});

test("baseline: migration ledger reports latest filename or null", async () => {
  const withLedger = fakeQuery({ migration: "0025_propagation_topology_semantic_scope.sql" });
  assert.equal(
    await latestMigration(withLedger.query),
    "0025_propagation_topology_semantic_scope.sql",
  );
  const withoutLedger = fakeQuery({ migration: null });
  assert.equal(await latestMigration(withoutLedger.query), null);
});

test("drop gate: exact names must hit the inventory and keep stable order", () => {
  const temporaryDatabases = ["realm_t11b_a1", "realm_t11b_a2"];
  assert.deepEqual(
    planDropTargets({ temporaryDatabases, names: ["realm_t11b_a2", "realm_t11b_a1"] }),
    ["realm_t11b_a1", "realm_t11b_a2"],
  );
});

test("drop gate: realm_dev and system databases are refused", () => {
  const temporaryDatabases = ["realm_t11b_a1"];
  for (const name of ["realm_dev", "postgres", "template0", "template1"]) {
    assert.throws(
      () => planDropTargets({ temporaryDatabases, names: [name] }),
      InventoryError,
    );
  }
});

test("drop gate: unknown, bare, and non-convention targets are refused", () => {
  const temporaryDatabases = ["realm_t11b_a1", "realm_t"];
  for (const name of ["realm_t", "realm_t_unknown", "realm_prod", "otherdb"]) {
    assert.throws(
      () => planDropTargets({ temporaryDatabases, names: [name] }),
      InventoryError,
    );
  }
});

test("drop gate: bare prefix and unmatched prefix are refused", () => {
  const temporaryDatabases = ["realm_t11b_a1", "realm_t11bwk_b2"];
  assert.throws(
    () => planDropTargets({ temporaryDatabases, prefix: "realm_t" }),
    InventoryError,
  );
  assert.throws(
    () => planDropTargets({ temporaryDatabases, prefix: "realm_t99_" }),
    InventoryError,
  );
  assert.throws(
    () => planDropTargets({ temporaryDatabases, prefix: "realm_" }),
    InventoryError,
  );
  assert.deepEqual(
    planDropTargets({ temporaryDatabases, prefix: "realm_t11b_" }),
    ["realm_t11b_a1"],
  );
});

test("drop gate: prefix rejects malformed inventory matches", () => {
  assert.throws(
    () => planDropTargets({
      temporaryDatabases: ["realm_t11b_a1", "realm_t11b-unsafe"],
      prefix: "realm_t11b",
    }),
    InventoryError,
  );
});

test("drop gate: drop without any selector is refused", () => {
  assert.throws(
    () => planDropTargets({ temporaryDatabases: ["realm_t11b_a1"] }),
    InventoryError,
  );
});

test("cli: missing credentials exits non-zero and never leaks secrets", () => {
  const env = { PATH: process.env.PATH };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [scriptPath], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /DATABASE_URL is required/);
  assert.doesNotMatch(output, /postgres(?:ql)?:\/\/[^ ]*@/);
  assert.doesNotMatch(output, /password/i);
});
