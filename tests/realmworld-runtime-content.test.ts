import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealmWorldInstantiationPlan,
  createRealmWorldInstantiationResolver,
  RealmWorldRuntimeContentError,
} from "../modules/world-transfer/realmworld-runtime-content.ts";
import type { RealmWorldManifestV1 } from "../modules/world-transfer/realmworld-manifest.ts";
import { realmWorldPlanToGenesisDraft } from "../modules/application/realmworld-genesis.ts";
import {
  goalAssessmentJobIdFor,
  goalInstanceIdFor,
} from "../modules/goals/public.ts";

const GOAL_FIXTURES = [
  {
    goalKey: "ack-tide",
    policyVersion: "v1",
    mode: "deterministic",
    visible: true,
    rubric: {
      kind: "event_count",
      eventKind: "narration.committed",
      progressKey: "narrations",
      threshold: 3,
    },
    outcome: { result: "tide acknowledged" },
  },
  {
    goalKey: "harbor-omen",
    policyVersion: "v2",
    mode: "semantic",
    visible: false,
    rubric: { kind: "semantic", promptKey: "harbor-omen" },
    outcome: { result: "omen resolved" },
  },
] as const;

const manifest: RealmWorldManifestV1 = {
  format: "realmworld",
  formatVersion: 1,
  worldId: "world-harbor",
  worldVersion: "1.2.0",
  engineCompat: {
    schemaLatest: "0057_realmworld_record_binding.sql",
    requiresMigrations: ["0055_goal_runtime.sql"],
  },
  contentHash: "a".repeat(64),
  signature: { algorithm: "ed25519", keyId: "fixture", value: "trusted" },
};

function files(runtime: unknown | null = {
  format: "realmworld-runtime",
  schemaVersion: 1,
  story: { title: { en: "The Harbor", "zh-CN": "港湾" }, premise: { en: "A sealed tide returns.", "zh-CN": "封潮归来。" } },
  record: { title: { en: "First Watch", "zh-CN": "第一夜" } },
  scene: {
    title: { en: "North Pier", "zh-CN": "北码头" },
    location: { en: "North pier", "zh-CN": "北码头" },
    objective: { en: "Wait for the tide", "zh-CN": "等待潮汐" },
    tension: { en: "A storm approaches", "zh-CN": "风暴逼近" },
    weather: { en: "Salt rain", "zh-CN": "盐雨" },
    displayTime: { en: "Night watch", "zh-CN": "夜哨" },
  },
  playerRole: { en: "Keeper", "zh-CN": "守潮人" },
  playerStance: "player",
  characters: [{
    characterKey: "scout",
    displayName: { en: "Mara", "zh-CN": "玛拉" },
    role: { en: "Scout", "zh-CN": "斥候" },
    summary: { en: "Reads the tide marks.", "zh-CN": "读懂潮痕。" },
    profile: { temperament: "careful" },
  }],
}, goals?: readonly unknown[]) {
  const entries: [string, Uint8Array][] = [
    ["content/world.json", Buffer.from(JSON.stringify({
      worldId: "world-harbor",
      title: { en: "Harbor of Ash", "zh-CN": "灰烬港" },
      settings: {
        era: "After the Long Storm",
        language: "en",
        weather: "salt rain",
        tension: "quiet pressure",
      },
    }))],
    ["content/goals.json", Buffer.from(JSON.stringify({
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: goals ?? [],
    }))],
  ];
  if (runtime !== null) entries.push(["content/runtime.json", Buffer.from(JSON.stringify(runtime))]);
  return new Map(entries);
}

test("RealmWorld runtime content resolves a locale-aware instantiation plan", () => {
  const plan = createRealmWorldInstantiationPlan({
    manifest,
    files: files(),
    locale: "zh-CN",
  });
  const draft = realmWorldPlanToGenesisDraft(plan, {
    worldlineId: "worldline_realm_fixture",
    storyId: "story_realm_fixture",
    recordId: "record_realm_fixture",
  });
  assert.deepEqual(draft.worldIdentity, plan.binding);
  assert.deepEqual(draft.runtimeIdentity, {
    worldlineId: "worldline_realm_fixture",
    storyId: "story_realm_fixture",
    recordId: "record_realm_fixture",
  });
  assert.equal(draft.scene.title, "北码头");
  assert.equal(draft.scene.displayTime, "夜哨");
  assert.deepEqual(plan.binding, {
    kind: "world",
    worldId: "world-harbor",
    worldVersion: "1.2.0",
  });
  assert.deepEqual(plan.world, {
    name: "灰烬港",
    era: "After the Long Storm",
    summary: "",
    settings: {
      era: "After the Long Storm",
      language: "en",
      weather: "salt rain",
      tension: "quiet pressure",
    },
  });
  assert.deepEqual(plan.story, { title: "港湾", premise: "封潮归来。" });
  assert.deepEqual(plan.scene, {
    title: "北码头",
    location: "北码头",
    objective: "等待潮汐",
    tension: "风暴逼近",
    weather: "盐雨",
    displayTime: "夜哨",
  });
  assert.deepEqual(plan.characters, [{
    characterKey: "scout",
    displayName: "玛拉",
    role: "斥候",
    summary: "读懂潮痕。",
    profile: { temperament: "careful" },
  }]);
  assert.equal(plan.goals.length, 0);
  // 无 Goals 的 RealmWorld 计划保持旧 genesis 草稿形态：不携带 goals 键。
  assert.equal(draft.goals, undefined);
});

test("RealmWorld instantiation plan materializes declarative Goals into the genesis draft", () => {
  const plan = createRealmWorldInstantiationPlan({
    manifest,
    files: files(undefined, GOAL_FIXTURES),
    locale: "en",
  });
  assert.equal(plan.goals.length, 2);
  const draft = realmWorldPlanToGenesisDraft(plan, {
    worldlineId: "worldline_realm_fixture",
    storyId: "story_realm_fixture",
    recordId: "record_realm_fixture",
  });
  // 草稿只携带 Record-scoped 物化所需的键；rubric/outcome/文案仍留在
  // RealmWorld 内容层（§2.2 硬边界），绝不随草稿落库。
  assert.deepEqual(draft.goals, [
    { goalKey: "ack-tide", policyVersion: "v1" },
    { goalKey: "harbor-omen", policyVersion: "v2" },
  ]);
  for (const goal of draft.goals ?? []) {
    assert.deepEqual(Object.keys(goal).sort(), ["goalKey", "policyVersion"]);
  }
});

test("Goal runtime identifiers are deterministic, scoped and collision-safe", () => {
  const scope = {
    workspaceId: "workspace_fixture",
    worldId: "world-harbor",
    worldlineId: "worldline_realm_fixture",
    recordId: "record_realm_fixture",
  };
  // 同一 Record + 同一 goalKey 永远得到同一 instance id（幂等重放稳定）。
  const first = goalInstanceIdFor(scope, "ack-tide");
  assert.equal(goalInstanceIdFor(scope, "ack-tide"), first);
  assert.match(first, /^goal_[0-9a-f]{24}$/);
  // 不同 goalKey / 不同 Record 作用域必得不同 id（digest  scoped 派生）。
  assert.notEqual(goalInstanceIdFor(scope, "harbor-omen"), first);
  assert.notEqual(
    goalInstanceIdFor({ ...scope, recordId: "record_other" }, "ack-tide"),
    first,
  );
  // 同一 (goal instance, source event) 永远得到同一 job id——dedupe 由
  // UNIQUE(workspace_id, goal_instance_id, source_event_id) 兜底；
  // 不同逻辑对的 digest 碰撞会令 PK 冲突直接中止事务（fail-closed），
  // 绝不静默合并两个 job。
  const job = goalAssessmentJobIdFor(scope.workspaceId, first, "event_opening");
  assert.equal(goalAssessmentJobIdFor(scope.workspaceId, first, "event_opening"), job);
  assert.match(job, /^goal_job_[0-9a-f]{24}$/);
  assert.notEqual(
    goalAssessmentJobIdFor(scope.workspaceId, first, "event_other"),
    job,
  );
  assert.notEqual(
    goalAssessmentJobIdFor(scope.workspaceId, goalInstanceIdFor(scope, "harbor-omen"), "event_opening"),
    job,
  );
});

test("RealmWorld runtime content resolves through an exact WorldBinding mount", async () => {
  const requested: unknown[] = [];
  const resolver = createRealmWorldInstantiationResolver({
    locale: "en",
    mount: {
      mount: async (binding) => {
        requested.push(binding);
        return { manifest, files: files() };
      },
    },
  });
  const plan = await resolver({ kind: "world", worldId: "world-harbor", worldVersion: "1.2.0" });
  assert.equal(plan?.binding.worldVersion, "1.2.0");
  assert.deepEqual(requested, [{ worldId: "world-harbor", worldVersion: "1.2.0" }]);
  assert.equal(await resolver({ kind: "base" }), null);

  await assert.rejects(
    () => resolver({ kind: "world", worldId: "world-harbor", worldVersion: "9.9.9" }),
    (error: unknown) => error instanceof RealmWorldRuntimeContentError
      && error.code === "RUNTIME_IDENTITY_MISMATCH",
  );
});
test("RealmWorld runtime content fails closed for missing or malformed runtime documents", () => {
  assert.throws(
    () => createRealmWorldInstantiationPlan({ manifest, files: files(null), locale: "en" }),
    (error: unknown) => error instanceof RealmWorldRuntimeContentError
      && error.code === "RUNTIME_UNAVAILABLE",
  );
  assert.throws(
    () => createRealmWorldInstantiationPlan({
      manifest,
      files: files({ format: "realmworld-runtime", schemaVersion: 1, unknown: true }),
      locale: "en",
    }),
    (error: unknown) => error instanceof RealmWorldRuntimeContentError
      && error.code === "RUNTIME_INVALID",
  );
});
