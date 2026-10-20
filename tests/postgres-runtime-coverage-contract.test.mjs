import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const runner = readFileSync(
  new URL("../scripts/test-postgres-runtime-with-scratch.mjs", import.meta.url),
  "utf8",
);
const defaultList = runner.match(/const DEFAULT_TEST_FILES = \[([\s\S]*?)\];/)?.[1];
assert.ok(defaultList, "scratch PostgreSQL runner must declare its default test list");
const registered = new Set(
  [...defaultList.matchAll(/"(tests\/[^"]+)"/g)].map((match) => match[1]),
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const contractScript = packageJson.scripts["test:contracts"];
assert.ok(contractScript, "npm test must define test:contracts");

const testsDirectory = new URL("./", import.meta.url);
const testFiles = readdirSync(testsDirectory).filter((file) => /\.test\.(?:mjs|ts)$/.test(file));
function usesPgAtRuntime(source, filename = "fixture.ts") {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const isPg = node => node && ts.isStringLiteral(node) && node.text === "pg";
  const visit = node => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && isPg(node.moduleSpecifier)) found = true;
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && isPg(node.moduleReference.expression)) found = true;
    if (ts.isCallExpression(node) && isPg(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
const pgWiredTests = new Set(
  testFiles
    .filter((file) => {
      const source = readFileSync(new URL(file, testsDirectory), "utf8");
      return usesPgAtRuntime(source, file);
    })
    .map((file) => `tests/${file}`),
);

const explicitlyManualPgTests = new Set([
  "tests/postgres-article-qualification-benchmark.test.ts",
  // 真实 provider opt-in 验收：自举独立 scratch 集群，仅在
  // REALM_TEST_PROVIDER_API_KEY 存在时运行，不进默认 scratch 套件。
  "tests/goal-semantic-judge-real-provider.test.ts",
  // Explicit external-network opt-in; still uses the official disposable runner.
  "tests/postgres-record-goals-real-provider.test.ts",
]);

// These import the real module solely to intercept its constructors/connect.
// Their actual boundary is a strict SQL double, not a PostgreSQL connection.
const explicitlyProtocolOnlyPgTests = new Set([
  "tests/goal-scoped-export-closure.test.ts",
  "tests/outbox-delivery-repository.test.ts",
  "tests/realmworld-instantiation-route.test.ts",
]);

const requiredScratchIntegrations = [
  "tests/postgres-library-permissions.test.ts",
  "tests/postgres-propagation-node-audiences-governance.test.ts",
  "tests/postgres-retrospection-origin.test.ts",
  "tests/postgres-semantic-review-context.test.ts",
];

test("default scratch PostgreSQL suite includes the required authorization and state-boundary integrations", () => {
  const missing = requiredScratchIntegrations.filter((file) => !registered.has(file));
  assert.deepEqual(missing, []);
});

test("every direct PostgreSQL test is in scratch runtime coverage or explicitly manual", () => {
  assert.equal(usesPgAtRuntime('import type { PoolClient } from "pg";'), false);
  assert.equal(usesPgAtRuntime('type Client = import("pg").PoolClient;'), false);
  assert.equal(usesPgAtRuntime('// import pg from "pg";'), false);
  assert.equal(usesPgAtRuntime('import pg from "pg";'), true);
  assert.equal(usesPgAtRuntime('import "pg";'), true);
  assert.equal(usesPgAtRuntime('const pg = require("pg");'), true);
  assert.equal(usesPgAtRuntime('const pg = await import("pg");'), true);
  const unclassified = [...pgWiredTests]
    .filter((file) => !registered.has(file) && !explicitlyManualPgTests.has(file) && !explicitlyProtocolOnlyPgTests.has(file))
    .sort();
  assert.deepEqual(unclassified, []);
  for (const file of explicitlyManualPgTests) {
    assert.ok(pgWiredTests.has(file), `${file} must remain a real PostgreSQL benchmark`);
    assert.ok(!registered.has(file), `${file} must stay out of the default runtime suite`);
  }
  for (const file of explicitlyProtocolOnlyPgTests) {
    assert.ok(pgWiredTests.has(file), `${file} must still exercise its real driver seam`);
    assert.ok(packageJson.scripts["test:core"].split(/\s+/).includes(file), `${file} must run as a maintained protocol test`);
    assert.ok(!registered.has(file), `${file} must not be misreported as live PostgreSQL evidence`);
  }
});

test("database safety and schema contracts are part of the regular contract suite", () => {
  const requiredContracts = [
    "tests/db-maintenance-inventory.test.mjs",
    "tests/postgres-migration-runner.test.mjs",
    "tests/postgres-runtime-repository-contract.test.mjs",
    "tests/postgres-schema-contract.test.mjs",
  ];
  const missing = requiredContracts.filter((file) => !contractScript.includes(file));
  assert.deepEqual(missing, []);
});

test('native Goal real-provider acceptance is maintained, explicit opt-in and bound to the disposable runner',()=>{
  const script=packageJson.scripts['test:goals:real-provider'];
  assert.match(script,/REALM_ENABLE_RECORD_GOAL_REAL_PROVIDER=1/);
  assert.match(script,/scripts\/test-postgres-runtime-with-scratch\.mjs tests\/postgres-record-goals-real-provider\.test\.ts/);
  assert.match(runner,/REALM_SCRATCH_POSTGRES_CONTAINER:\s*cluster\.name/);
  assert.ok(!registered.has('tests/postgres-record-goals-real-provider.test.ts'),'default regressions must not call an external provider');
});
