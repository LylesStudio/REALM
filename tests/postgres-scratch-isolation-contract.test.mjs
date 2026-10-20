import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/test-postgres-runtime-with-scratch.mjs', import.meta.url), 'utf8');

test('PostgreSQL scratch files each receive a fresh provisioned database rather than shared mutable demo state', () => {
  assert.match(source, /for\s*\(const\s*\[index,\s*testFile\]\s*of\s*TEST_FILES\.entries\(\)\)/);
  assert.match(source, /CREATE DATABASE.*TEMPLATE realm_dev/);
  assert.match(source, /const suiteDatabase = `realm_suite_\$\{index\}`/);
  assert.match(source, /DATABASE_URL: withDb\(cluster\.adminUrl, suiteDatabase\)/);
  assert.match(source, /REALM_RUNTIME_DATABASE_URL: withDb\(cluster\.runtimeUrl, suiteDatabase\)/);
  assert.match(source, /REALM_TRANSFER_DATABASE_URL: withDb\(cluster\.transferUrl, suiteDatabase\)/);
  assert.match(source, /["']--test-concurrency=1["']/);
  assert.match(source, /\btestFile,/);
  assert.doesNotMatch(source, /\.\.\.TEST_FILES/);
});

test('PostgreSQL scratch entry supplies and cleans a task-owned default evidence directory', () => {
  assert.match(source, /mkdtemp\(join\(tmpdir\(\), ["']realm-runtime-evidence-["']\)\)/);
  assert.match(source, /REALM_R1_EVIDENCE_DIR: evidenceDir/);
  assert.match(source, /if \(!providedEvidenceDir\).*rm\(evidenceDir, \{ recursive: true, force: true \}\)/);
  assert.match(source, /await cluster\.stop\(\)/);
});
