import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

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
const pgWiredTests = new Set(
  testFiles
    .filter((file) => {
      const source = readFileSync(new URL(file, testsDirectory), "utf8");
      return /(?:from\s+["']pg["']|require\(["']pg["']\))/.test(source);
    })
    .map((file) => `tests/${file}`),
);

const explicitlyManualPgTests = new Set([
  "tests/postgres-article-qualification-benchmark.test.ts",
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
  const unclassified = [...pgWiredTests]
    .filter((file) => !registered.has(file) && !explicitlyManualPgTests.has(file))
    .sort();
  assert.deepEqual(unclassified, []);
  for (const file of explicitlyManualPgTests) {
    assert.ok(pgWiredTests.has(file), `${file} must remain a real PostgreSQL benchmark`);
    assert.ok(!registered.has(file), `${file} must stay out of the default runtime suite`);
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
