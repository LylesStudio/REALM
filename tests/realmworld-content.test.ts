import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealmWorldContentStore,
  RealmWorldContentError,
} from "../modules/world-transfer/realmworld-content.ts";
import type { RealmWorldManifestV1 } from "../modules/world-transfer/realmworld-manifest.ts";
import { normalizeGoalDefinition, goalDefinitionHash } from "../modules/goals/content-binding.ts";

// Existing runtime failure rules must survive the signed-content decoder too.
test("RealmWorld production decoding preserves deterministic failure rules through binding normalization", () => {
  const definition = {
    goalKey: "terminal-failure", policyVersion: "v1", mode: "deterministic" as const, visible: true,
    rubric: { kind: "event_count" as const, eventKind: "utterance.committed", progressKey: "successes", threshold: 99,
      failure: { eventKind: "action.transaction.committed", progressKey: "failures", threshold: 1 } },
    terminals: ["failed" as const, "settled" as const], outcome: { ending: "failure" },
  };
  const decoded = createRealmWorldContentStore({ manifest, files: files({
    format: "realmworld-goals", schemaVersion: 1, goals: [definition],
  }) }).resolveGoalDefinition(definition.goalKey);
  assert.deepEqual(decoded, definition);
  assert.deepEqual(normalizeGoalDefinition(definition), definition);
  const withoutFailure = { ...definition, rubric: {
    kind: "event_count", eventKind: "utterance.committed", progressKey: "successes", threshold: 99,
  } };
  assert.notEqual(goalDefinitionHash(definition), goalDefinitionHash(withoutFailure));
});

test("RealmWorld production decoding rejects malformed deterministic failure rules", () => {
  const failure = { eventKind: "action.transaction.committed", progressKey: "failures", threshold: 1 };
  const rubric = { kind: "event_count", eventKind: "utterance.committed", progressKey: "successes", threshold: 99 };
  for (const value of [null, [], "failure", {}, { ...failure, extra: true },
    { ...failure, eventKind: "" }, { ...failure, eventKind: " action.transaction.committed" },
    { ...failure, eventKind: rubric.eventKind }, { ...failure, progressKey: "" },
    { ...failure, progressKey: " failures" }, { ...failure, progressKey: rubric.progressKey },
    { ...failure, threshold: 0 }, { ...failure, threshold: -1 },
    { ...failure, threshold: 1.5 }, { ...failure, threshold: "1" },
    { ...failure, threshold: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const store = createRealmWorldContentStore({ manifest, files: files({
      format: "realmworld-goals", schemaVersion: 1, goals: [{
        goalKey: "failure", policyVersion: "v1", mode: "deterministic", visible: true,
        rubric: { ...rubric, failure: value }, outcome: {},
      }],
    }) });
    assert.throws(() => store.listGoalDefinitions(), (error: unknown) =>
      error instanceof RealmWorldContentError && error.code === "GOALS_INVALID");
  }
});

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

test('RealmWorld content preserves bounded semantic criteria and rejects executable overrides', () => {
  const criteria={objective:'Deliver the sealed letter',successConditions:['The recipient receives it'],failureConditions:[],settlementConditions:[]};
  const doc=(value:unknown)=>({format:'realmworld-goals',schemaVersion:1,goals:[{goalKey:'letter',policyVersion:'v1',mode:'semantic',visible:true,
    rubric:{kind:'semantic',promptKey:'letter',criteria:value},outcome:{}}]});
  const store=createRealmWorldContentStore({manifest,files:files(doc(criteria))});
  const rubric=store.resolveGoalDefinition('letter')!.rubric;
  assert.equal(rubric.kind,'semantic');
  assert.deepEqual('criteria' in rubric?rubric.criteria:null,criteria);
  for(const value of [{...criteria,systemPrompt:'override'}, {...criteria,successConditions:[]}, {...criteria,objective:'x'.repeat(4001)}]) {
    assert.throws(()=>createRealmWorldContentStore({manifest,files:files(doc(value))}).listGoalDefinitions(),RealmWorldContentError);
  }
});

test("RealmWorld production decoding preserves explicit Goal terminal and retry settings", () => {
  const core = {
    goalKey: "deliver", policyVersion: "v1", mode: "deterministic" as const, visible: true,
    rubric: { kind: "event_count" as const, eventKind: "delivered", progressKey: "count", threshold: 1 },
    outcome: { title: "Delivered" },
  };
  for (const extensions of [{}, { retryable: false }, { retryable: true },
    { terminals: ["settled", "completed"] }, { terminals: ["failed"], retryable: false }]) {
    const expected = { ...core, ...extensions };
    const store = createRealmWorldContentStore({ manifest, files: files({
      format: "realmworld-goals", schemaVersion: 1, goals: [expected],
    }) });
    const actual = store.resolveGoalDefinition(core.goalKey)!;
    assert.deepEqual(actual, expected);
    assert.equal(Object.hasOwn(actual, "terminals"), Object.hasOwn(expected, "terminals"));
    assert.equal(Object.hasOwn(actual, "retryable"), Object.hasOwn(expected, "retryable"));
    assert.deepEqual(store.listGoalDefinitions(), [expected]);
  }
  const semantic = { ...core, mode: "semantic" as const,
    rubric: { kind: "semantic" as const, promptKey: "delivery", criteria: {
      objective: "Deliver the letter", successConditions: ["The recipient receives it"],
      failureConditions: [], settlementConditions: [],
    } }, terminals: ["completed", "settled"], retryable: true };
  assert.deepEqual(createRealmWorldContentStore({ manifest, files: files({
    format: "realmworld-goals", schemaVersion: 1, goals: [semantic],
  }) }).resolveGoalDefinition(core.goalKey), semantic);
});

test("RealmWorld production decoding rejects malformed Goal terminal and retry settings", () => {
  const core = { goalKey: "deliver", policyVersion: "v1", mode: "deterministic", visible: true,
    rubric: { kind: "event_count", eventKind: "delivered", progressKey: "count", threshold: 1 }, outcome: {} };
  for (const extensions of [
    { terminals: [] }, { terminals: null }, { terminals: "completed" },
    { terminals: ["completed", "completed"] }, { terminals: ["active"] },
    { terminals: ["withdrawn"] }, { terminals: ["superseded"] }, { terminals: [1] },
    { retryable: null }, { retryable: "false" }, { retryable: 0 },
    { terminals: ["completed"], retryable: false, source: "self-asserted" },
  ]) {
    const store = createRealmWorldContentStore({ manifest, files: files({
      format: "realmworld-goals", schemaVersion: 1, goals: [{ ...core, ...extensions }],
    }) });
    assert.throws(() => store.listGoalDefinitions(), (error: unknown) =>
      error instanceof RealmWorldContentError && error.code === "GOALS_INVALID");
  }
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
