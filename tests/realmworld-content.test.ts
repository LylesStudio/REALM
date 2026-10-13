import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealmWorldContentStore,
  RealmWorldContentError,
} from "../modules/world-transfer/realmworld-content.ts";
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

function files(value: unknown): ReadonlyMap<string, Uint8Array> {
  return new Map([["content/goals.json", Buffer.from(JSON.stringify(value))]]);
}

test("RealmWorld content store resolves strict deterministic and semantic Goal definitions", () => {
  const store = createRealmWorldContentStore({
    manifest,
    files: files({
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: [
        {
          goalKey: "harbor-letter",
          policyVersion: "goals-v1",
          mode: "deterministic",
          visible: true,
          rubric: {
            kind: "event_count",
            eventKind: "utterance.committed",
            progressKey: "letters",
            threshold: 2,
          },
          outcome: { ending: "open" },
        },
        {
          goalKey: "trust-the-guide",
          policyVersion: "goals-v1",
          mode: "semantic",
          visible: false,
          rubric: { kind: "semantic", promptKey: "goal.trust_the_guide" },
          outcome: { ending: "trust" },
        },
      ],
    }),
  });
  assert.deepEqual(store.resolveGoalDefinition("harbor-letter"), {
    goalKey: "harbor-letter",
    policyVersion: "goals-v1",
    mode: "deterministic",
    visible: true,
    rubric: {
      kind: "event_count",
      eventKind: "utterance.committed",
      progressKey: "letters",
      threshold: 2,
    },
    outcome: { ending: "open" },
  });
  assert.equal(store.resolveGoalDefinition("missing"), null);
  assert.deepEqual(
    store.listGoalDefinitions().map((goal) => goal.goalKey),
    ["harbor-letter", "trust-the-guide"],
  );
});

test("RealmWorld content store fails closed for missing, duplicate, and malformed Goals", () => {
  const missing = createRealmWorldContentStore({ manifest, files: new Map() });
  assert.throws(
    () => missing.listGoalDefinitions(),
    (error: unknown) => error instanceof RealmWorldContentError
      && error.code === "GOALS_UNAVAILABLE",
  );
  for (const value of [
    {
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: [],
      extra: true,
    },
    {
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: [
        {
          goalKey: "duplicate",
          policyVersion: "v1",
          mode: "semantic",
          visible: true,
          rubric: { kind: "semantic", promptKey: "p" },
          outcome: {},
        },
        {
          goalKey: "duplicate",
          policyVersion: "v1",
          mode: "semantic",
          visible: true,
          rubric: { kind: "semantic", promptKey: "p" },
          outcome: {},
        },
      ],
    },
    {
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: [{
        goalKey: "bad",
        policyVersion: "v1",
        mode: "deterministic",
        visible: true,
        rubric: { kind: "event_count", eventKind: "x", progressKey: "p", threshold: 0 },
        outcome: {},
      }],
    },
  ]) {
    const store = createRealmWorldContentStore({ manifest, files: files(value) });
    assert.throws(
      () => store.listGoalDefinitions(),
      (error: unknown) => error instanceof RealmWorldContentError
        && error.code === "GOALS_INVALID",
    );
  }
});
