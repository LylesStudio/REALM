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
    baseRange: ">=1.0.0 <2.0.0",
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

// Synthetic policy fixture; these authored conditions do not define any World rules.
function policyFiles(policy: unknown = syntheticCommandPolicy()) {
  const result = files();
  const world = JSON.parse(Buffer.from(result.get("content/world.json")!).toString());
  world.settings.declaredEvents = ["synthetic.ready"];
  result.set("content/world.json", Buffer.from(JSON.stringify(world)));
  result.set("content/command-policy.json", Buffer.from(typeof policy === "string" ? policy : JSON.stringify(policy)));
  return result;
}
function syntheticCommandPolicy() {
  return {
    format: "realmworld-command-policy", schemaVersion: 1, policyVersion: "synthetic.v1",
    projects: [{ projectKey: "p", kind: "production", title: { en: "Synthetic" }, milestones: [
      { milestoneKey: "prior", title: { en: "Prior" } }, { milestoneKey: "target", title: { en: "Target" } },
    ] }],
    bindings: [{ bindingKey: "target.ready", command: "confirm_milestone", projectKey: "p", milestoneKey: "target",
      semanticEventKey: "synthetic.ready", storySelector: "genesis", recordSelector: "genesis",
      all: [{ kind: "milestone_status", milestoneKey: "prior", status: "completed" }] }],
  };
}
test("A2 plan carries explicit package hash and strictly decoded authored policy without adding a draft injection channel", () => {
  const plan = createRealmWorldInstantiationPlan({ manifest, files: policyFiles(), locale: "en" });
  assert.equal(plan.contentHash, manifest.contentHash);
  assert.deepEqual(plan.commandPolicy, syntheticCommandPolicy());
  const draft = realmWorldPlanToGenesisDraft(plan, { worldlineId: "wl", storyId: "st", recordId: "re" });
  assert.equal("commandPolicy" in draft, false);
  assert.equal(createRealmWorldInstantiationPlan({ manifest, files: files(), locale: "en" }).commandPolicy, undefined);
});
test("A2 decoder refuses unknown keys, duplicate JSON members, refs, selectors, versions, self predicates and undeclared events", () => {
  const bad: unknown[] = [];
  bad.push({ ...syntheticCommandPolicy(), schemaVersion: 2 });
  bad.push({ ...syntheticCommandPolicy(), sql: "SELECT 1" });
  bad.push(JSON.stringify(syntheticCommandPolicy()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  for (const change of [ { all: undefined }, { all: [{ kind: "milestone_status", milestoneKey: "target", status: "completed" }] },
    { all: [{ kind: "milestone_status", milestoneKey: "foreign", status: "completed" }] }, { storySelector: "current" },
    { semanticEventKey: "synthetic.undeclared" }, { bindingKey: ".." } ]) {
    const p = syntheticCommandPolicy(); Object.assign(p.bindings[0]!, change); bad.push(p);
  }
  const duplicate = syntheticCommandPolicy(); duplicate.bindings.push(duplicate.bindings[0]!); bad.push(duplicate);
  for (const policy of bad) assert.throws(() => createRealmWorldInstantiationPlan({ manifest, files: policyFiles(policy), locale: "en" }));
});


test("A2 strict decoder negative matrix at public plan boundary", async t => {
  const variants: [string, (p: ReturnType<typeof syntheticCommandPolicy>) => void][] = [
    ["unknown project member", p => Object.assign(p.projects[0]!, { script: "return true" })],
    ["unknown milestone member", p => Object.assign(p.projects[0]!.milestones[0]!, { sql: "SELECT 1" })],
    ["unknown predicate member", p => Object.assign(p.bindings[0]!.all[0]!, { expression: "true" })],
    ["duplicate project", p => p.projects.push(structuredClone(p.projects[0]!))],
    ["duplicate milestone", p => p.projects[0]!.milestones.push(structuredClone(p.projects[0]!.milestones[0]!))],
    ["unknown project reference", p => { p.bindings[0]!.projectKey = "foreign"; }],
    ["unknown target reference", p => { p.bindings[0]!.milestoneKey = "foreign"; }],
    ["cross project prerequisite", p => { p.projects.push({ projectKey: "other", kind: "production", title: { en: "Other" }, milestones: [{ milestoneKey: "foreign", title: { en: "Foreign" } }] }); p.bindings[0]!.all[0]!.milestoneKey = "foreign"; }],
    ["ambiguous selector tuple", p => p.bindings.push({ ...structuredClone(p.bindings[0]!), bindingKey: "other" })],
    ["invalid policy version", p => { p.policyVersion = "../invalid"; }],
    ["empty localized title", p => { p.projects[0]!.title.en = ""; }],
    ["noncanonical localized title", p => { p.projects[0]!.milestones[0]!.title.en = " Prior"; }],
    ["unknown kind", p => Object.assign(p.projects[0]!, { kind: "script" })],
    ["unknown command", p => Object.assign(p.bindings[0]!, { command: "record_income" })],
    ["current record selector", p => { p.bindings[0]!.recordSelector = "current"; }],
    ["recursive predicate", p => Object.assign(p.bindings[0]!.all[0]!, { kind: "all", all: [] })],
    ["unsupported status", p => { p.bindings[0]!.all[0]!.status = "planned"; }],
    ["missing all", p => { Reflect.deleteProperty(p.bindings[0]!, "all"); }],
    ["null all", p => Object.assign(p.bindings[0]!, { all: null })],
    ["too many predicates", p => { p.bindings[0]!.all = Array.from({ length: 9 }, () => structuredClone(p.bindings[0]!.all[0]!)); }],
    ["too many bindings", p => { p.bindings = Array.from({ length: 65 }, (_, i) => ({ ...structuredClone(p.bindings[0]!), bindingKey: `b${i}` })); }],
    ["too many projects", p => { p.projects = Array.from({ length: 65 }, (_, i) => ({ ...structuredClone(p.projects[0]!), projectKey: `p${i}` })); }],
    ["total milestone budget", p => { for (let i = 0; i < 4; i++) p.projects.push({ projectKey: `extra${i}`, kind: "production", title: { en: "Extra" }, milestones: Array.from({ length: 64 }, (_, j) => ({ milestoneKey: `m${j}`, title: { en: "M" } })) }); }],
    ["canonical byte budget", p => { p.projects[0]!.title = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`locale${i}`, "x".repeat(512)])) as { en: string }; }],
    ["too many milestones", p => { p.projects[0]!.milestones = Array.from({ length: 65 }, (_, i) => ({ milestoneKey: `m${i}`, title: { en: "M" } })); }],
  ];
  for (const [name, mutate] of variants) await t.test(name, () => {
    const policy = syntheticCommandPolicy(); mutate(policy);
    assert.throws(() => createRealmWorldInstantiationPlan({ manifest, files: policyFiles(policy), locale: "en" }), { code: "BUSINESS_POLICY_MISSING" });
  });
  for (const [name, raw] of [
    ["escaped duplicate member", JSON.stringify(syntheticCommandPolicy()).replace('"projectKey":"p"', '"projectKey":"p","project\\u004bey":"p"')],
    ["nested duplicate localized member", JSON.stringify(syntheticCommandPolicy()).replace('"en":"Prior"', '"en":"Prior","en":"Prior"')],
    ["invalid UTF8", new Uint8Array([0xc3, 0x28])],
  ] as const) await t.test(name, () => {
    const input = policyFiles(); input.set("content/command-policy.json", typeof raw === "string" ? Buffer.from(raw) : raw);
    assert.throws(() => createRealmWorldInstantiationPlan({ manifest, files: input, locale: "en" }), { code: "BUSINESS_POLICY_MISSING" });
  });
  await t.test("explicit empty all and locale changes keep selectors", () => {
    const p = syntheticCommandPolicy(); p.bindings[0]!.all = []; Object.assign(p.projects[0]!.title, { "zh-CN": "不同标题" });
    const en = createRealmWorldInstantiationPlan({ manifest, files: policyFiles(p), locale: "en" });
    const zh = createRealmWorldInstantiationPlan({ manifest, files: policyFiles(p), locale: "zh-CN" });
    assert.deepEqual(en.commandPolicy, zh.commandPolicy); assert.deepEqual(en.commandPolicy!.bindings[0]!.all, []);
    assert.equal(en.commandPolicy!.projects[0]!.projectKey, "p");
  });
  await t.test("settings cannot synthesize a policy file", () => {
    const input = files(), world = JSON.parse(Buffer.from(input.get("content/world.json")!).toString());
    world.settings.commandPolicy = syntheticCommandPolicy(); world.settings.trusted = true;
    input.set("content/world.json", Buffer.from(JSON.stringify(world)));
    assert.equal(createRealmWorldInstantiationPlan({ manifest, files: input, locale: "en" }).commandPolicy, undefined);
  });
});


test("A2 command boundary exposes stable safe policy refusal responses", async () => {
  const { projectFinanceRouteError } = await import("../app/api/bridge/v1/project-finance-context.ts");
  const { ProjectFinanceCommandError } = await import("../modules/application/project-finance-command.ts");
  for (const [code, status] of [["BUSINESS_POLICY_MISSING", 422], ["BUSINESS_PRECONDITION_FAILED", 409], ["IDEMPOTENCY_KEY_REUSE", 409], ["COMMAND_INVALID", 422]] as const) {
    const response = projectFinanceRouteError(new ProjectFinanceCommandError(code, "private-file-location-and-policy-detail"));
    assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, code); assert.equal(body.error.message.includes("private-file-location"), false);
  }
});


test("A2 materialization decoder rejects malformed identities, aliases, topology splits and resource excess", async t => {
  const { normalizeCommandMaterializations } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const fixture = () => normalizeCommandMaterializations({ format: "realmworld-command-materializations", schemaVersion: 1, worldVersion: "1.2.0", contentHash: "a".repeat(64), policyVersion: "synthetic.v1", rows: ["prior", "target"].map(key => ({ projectKey: "p", milestoneKey: key, projectId: "project", milestoneId: `milestone-${key}`, storyId: "story", recordId: "record" })) });
  const cases: [string, (m: ReturnType<typeof fixture>) => void][] = [
    ["unknown document field", m => Object.assign(m, { trusted: true })],
    ["unsupported version", m => Object.assign(m, { schemaVersion: 2 })],
    ["unknown format", m => Object.assign(m, { format: "policy-map" })],
    ["empty world version", m => { m.worldVersion = ""; }],
    ["oversized world version", m => { m.worldVersion = "v".repeat(257); }],
    ["malformed hash", m => { m.contentHash = "A".repeat(64); }],
    ["invalid policy version", m => { m.policyVersion = ".."; }],
    ["empty map", m => { m.rows = []; }],
    ["unknown row field", m => Object.assign(m.rows[0]!, { sql: "SELECT 1" })],
    ["invalid authored key", m => { m.rows[0]!.milestoneKey = "../key"; }],
    ["empty runtime id", m => { m.rows[0]!.projectId = ""; }],
    ["whitespace runtime id", m => { m.rows[0]!.recordId = " record"; }],
    ["oversized runtime id", m => { m.rows[0]!.milestoneId = "m".repeat(257); }],
    ["duplicate authored tuple", m => { m.rows[1]!.milestoneKey = m.rows[0]!.milestoneKey; }],
    ["duplicate milestone id", m => { m.rows[1]!.milestoneId = m.rows[0]!.milestoneId; }],
    ["same key aliases two projects", m => { m.rows[1]!.projectId = "another-project"; }],
    ["two keys alias one project", m => { m.rows[1]!.projectKey = "another-key"; }],
    ["split genesis Story", m => { m.rows[1]!.storyId = "another-story"; }],
    ["split genesis Record", m => { m.rows[1]!.recordId = "another-record"; }],
    ["row count budget", m => { m.rows = Array.from({ length: 257 }, (_, i) => ({ ...m.rows[0]!, milestoneKey: `k${i}`, milestoneId: `milestone-${i}` })); }],
    ["canonical byte budget", m => { m.rows = Array.from({ length: 256 }, (_, i) => ({ projectKey: "p".repeat(128), milestoneKey: String(i).padEnd(128, "k"), projectId: "p".repeat(256), milestoneId: String(i).padEnd(256, "m"), storyId: "s".repeat(256), recordId: "r".repeat(256) })); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => normalizeCommandMaterializations(value), { code: "BUSINESS_POLICY_MISSING" }); });
});
