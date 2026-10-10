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

test("RealmWorld definition resolver consumes WorldBinding and caches the exact mounted identity", async () => {
  let mountCount = 0;
  const resolver = createRealmWorldDefinitionResolver({
    mount: async () => {
      mountCount += 1;
      return {
        manifest,
        files: new Map([["content/goals.json", goals]]),
      };
    },
  });
  const job = { worldId: "world-harbor", worldVersion: "1.2.0", goalKey: "harbor-letter" };
  assert.equal((await resolver(job))?.goalKey, "harbor-letter");
  assert.equal((await resolver(job))?.policyVersion, "v1");
  assert.equal(mountCount, 1);
  assert.equal(await resolver({ ...job, goalKey: "missing" }), null);
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
