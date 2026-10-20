import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import {
  createRealmWorldDefinitionResolver,
  RealmWorldDefinitionResolutionError,
} from "../modules/world-transfer/realmworld-definition-resolver.ts";
import type { RealmWorldManifestV1 } from "../modules/world-transfer/realmworld-manifest.ts";

const manifest: RealmWorldManifestV1 = {
  format: "realmworld",
  formatVersion: 1,
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  engineCompat: {
    schemaLatest: "0055_goal_runtime.sql",
    requiresMigrations: ["0055_goal_runtime.sql"],
    baseRange: ">=1.0.0 <2.0.0",
  },
  contentHash: "a".repeat(64),
  signature: { algorithm: "ed25519", keyId: "fixture", value: "trusted" },
};

const goals = Buffer.from(JSON.stringify({
  format: "realmworld-goals",
  schemaVersion: 1,
  goals: [{
    goalKey: "harbor-letter",
    policyVersion: "v1",
    mode: "deterministic",
    visible: true,
    rubric: { kind: "event_count", eventKind: "letter.sent", progressKey: "letters", threshold: 1 },
    outcome: { ending: "open" },
  }],
}));

test("RealmWorld definition resolver revalidates the exact WorldBinding on every request", async () => {
  let mountCount = 0, revoked = false;
  let mountedGoals = goals;
  const revocation = new Error("fixture-trust-revoked");
  const resolver = createRealmWorldDefinitionResolver({
    mount: async () => {
      mountCount += 1;
      if (revoked) throw revocation;
      return {
        manifest,
        files: new Map([["content/goals.json", mountedGoals]]),
      };
    },
  });
  const job = { worldId: "world-harbor", worldVersion: "1.2.0", goalKey: "harbor-letter" };
  assert.equal((await resolver(job))?.goalKey, "harbor-letter");
  assert.equal((await resolver(job))?.policyVersion, "v1");
  assert.equal(mountCount, 2);
  assert.equal(await resolver({ ...job, goalKey: "missing" }), null);
  assert.equal(mountCount, 3);
  revoked = true;
  await assert.rejects(resolver(job), error => error === revocation);
  assert.equal(mountCount, 4, "same identity must not bypass revoked mount trust");
  revoked = false; mountedGoals = Buffer.from("{");
  await assert.rejects(resolver(job), { code: "GOALS_INVALID" });
  assert.equal(mountCount, 5, "same identity must not reuse old valid definition bytes");
  mountedGoals = goals;
  assert.equal((await resolver(job))?.goalKey, "harbor-letter");
  assert.equal(mountCount, 6);
});

test("RealmWorld definition resolver rejects a mounted identity mismatch and isolates base mode", async () => {
  let mounted = 0;
  const resolver = createRealmWorldDefinitionResolver({
    mount: async () => {
      mounted += 1;
      return {
        manifest: { ...manifest, worldVersion: "9.9.9" },
        files: new Map([["content/goals.json", goals]]),
      };
    },
    baseResolver: () => ({
      goalKey: "base-goal",
      policyVersion: "base-v1",
      mode: "deterministic",
      visible: true,
      rubric: { kind: "event_count", eventKind: "x", progressKey: "x", threshold: 1 },
      outcome: {},
    }),
  });
  await assert.rejects(
    () => resolver({ worldId: "world-harbor", worldVersion: "1.2.0", goalKey: "harbor-letter" }),
    (error: unknown) => error instanceof RealmWorldDefinitionResolutionError
      && error.code === "REALMWORLD_IDENTITY_MISMATCH",
  );
  assert.equal(mounted, 1);
  assert.equal(
    (await resolver({ worldId: "local-world", worldVersion: LOCAL_WORLD_VERSION, goalKey: "base-goal" }))?.goalKey,
    "base-goal",
  );
  assert.equal(mounted, 1);
});
