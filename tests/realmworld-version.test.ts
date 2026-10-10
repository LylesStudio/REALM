/**
 * RealmWorld 版本比较契约（Phase 4D）：严格 semver 三段数字，
 * 禁止字典序（1.10.0 > 1.9.0），非法形态 fail-closed（null）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareRealmWorldVersions,
  parseRealmWorldVersion,
} from "../modules/world-transfer/realmworld-version.ts";

test("realmworld version: strict semver parse rejects loose forms", () => {
  assert.deepEqual(parseRealmWorldVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseRealmWorldVersion("0.0.0"), { major: 0, minor: 0, patch: 0 });
  for (const bad of [
    "1.2", "1.2.3.4", "v1.2.3", "1.2.3-alpha", "1.2.3+build", "1.02.3",
    "latest", "", "1.2.x", " 1.2.3\n",
  ]) {
    assert.equal(parseRealmWorldVersion(bad), null, bad);
  }
});

test("realmworld version: numeric compare, never lexicographic", () => {
  assert.equal(compareRealmWorldVersions("1.10.0", "1.9.0"), 1, "1.10.0 > 1.9.0");
  assert.equal(compareRealmWorldVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareRealmWorldVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareRealmWorldVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareRealmWorldVersions("0.9.9", "0.10.0"), -1);
  assert.equal(compareRealmWorldVersions("1.2.3", "bad"), null);
  assert.equal(compareRealmWorldVersions("bad", "1.2.3"), null);
});
