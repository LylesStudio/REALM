import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);

test("every test:core file reference exists", () => {
  const script = packageJson.scripts["test:core"];
  assert.equal(typeof script, "string", "test:core must be configured");

  const referencedFiles = script.match(/tests\/[^\s"']+/g) ?? [];
  assert.ok(referencedFiles.length > 0, "test:core must list test files");

  const missingFiles = [...new Set(referencedFiles)].filter(
    (file) => !existsSync(new URL(file, root)),
  );
  assert.deepEqual(missingFiles, []);
});
