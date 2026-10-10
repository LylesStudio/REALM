import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_BASE_GOAL_DEFINITIONS,
  BaseContentError,
  createBaseInstantiationPlan,
  resolveBaseGoalDefinition,
  type BaseGenesisParameters,
  type BaseInstantiationPlan,
} from "../modules/world-transfer/base-content.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import { createRealmWorldDefinitionResolver } from "../modules/world-transfer/realmworld-definition-resolver.ts";
import type { RealmWorldRuntimeInstantiationPlan } from "../modules/world-transfer/realmworld-runtime-content.ts";
import {
  baseGenesisParametersFromDraft,
  baseInstantiationPlanToGenesisDraft,
  instantiationPlanToGenesisDraft,
} from "../modules/application/genesis-instantiation.ts";
import {
  PRESET_WORLD_KEYS,
  getPresetWorldDraft,
} from "../modules/application/preset-worlds.ts";
import { GENESIS_LANGUAGES } from "../modules/application/world-genesis-contract.ts";

const FULL_PARAMETERS = {
  world: { name: "雾港", era: "长雾纪元 7 年", summary: "灯塔熄灭的港口。" },
  language: "zh-CN",
  style: "classical",
  story: { title: "熄灯之夜", premise: "守灯人失踪了。" },
  record: { title: "第一夜" },
  playerRole: "新任守灯人",
  playerStance: "player",
  characters: [
    { displayName: "阿汐", role: "潮汐记录员", summary: "记得每一次涨潮。" },
  ],
  scene: {
    title: "旧灯塔",
    location: "灯塔顶层",
    weather: "浓雾",
    tension: "灯油将尽",
    displayTime: "子时",
    objective: "重新点灯",
  },
  opening: "雾把灯塔吞到只剩一圈昏黄。",
} as const;

test("base instantiation plan pins an exact base binding and covers all genesis content fields", () => {
  // 纯内存、无 install root/trust-store/网络——base 内容层 persistence-neutral。
  const plan = createBaseInstantiationPlan({
    ...FULL_PARAMETERS,
    goals: ["base.first-narration"],
  });
  assert.deepEqual(plan.binding, { kind: "base" });
  assert.equal(plan.world.name, "雾港");
  assert.equal(plan.world.era, "长雾纪元 7 年");
  assert.equal(plan.world.summary, "灯塔熄灭的港口。");
  assert.deepEqual(plan.world.settings, {
    era: "长雾纪元 7 年",
    summary: "灯塔熄灭的港口。",
    weather: "浓雾",
    tension: "灯油将尽",
    language: "zh-CN",
    style: "classical",
    displayTime: "子时",
  });
  assert.deepEqual(plan.story, { title: "熄灯之夜", premise: "守灯人失踪了。" });
  assert.deepEqual(plan.record, { title: "第一夜" });
  assert.deepEqual(plan.scene, {
    title: "旧灯塔",
    location: "灯塔顶层",
    objective: "重新点灯",
    tension: "灯油将尽",
    weather: "浓雾",
    displayTime: "子时",
  });
  assert.equal(plan.playerRole, "新任守灯人");
  assert.equal(plan.playerStance, "player");
  assert.deepEqual(plan.characters, [{
    displayName: "阿汐",
    role: "潮汐记录员",
    summary: "记得每一次涨潮。",
  }]);
  assert.equal(plan.opening, "雾把灯塔吞到只剩一圈昏黄。");
  // engine-owned Goal 定义在 plan 构建时全量解析（内容层持有 rubric/文案）。
  assert.equal(plan.goals.length, 1);
  assert.equal(plan.goals[0]?.goalKey, "base.first-narration");
  assert.equal(plan.goals[0]?.policyVersion, "base-v1");
});

test("base instantiation plan is fail-closed on identity masquerade and unknown content", () => {
  // base 绝不伪装成 RealmWorld package：任何身份/安装字段一律拒绝。
  for (const key of ["binding", "worldIdentity", "runtimeIdentity", "worldId", "worldVersion"]) {
    assert.throws(
      () => createBaseInstantiationPlan({ ...FULL_PARAMETERS, [key]: "world_x" }),
      (error: unknown) => error instanceof BaseContentError
        && error.code === "BASE_CONTENT_IDENTITY",
      `identity key ${key} must be rejected`,
    );
  }
  // 非哨兵版本伪装同样拒绝（即便字段值本身合法）。
  assert.throws(
    () => createBaseInstantiationPlan({
      ...FULL_PARAMETERS,
      worldVersion: LOCAL_WORLD_VERSION,
    } as unknown as BaseGenesisParameters),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_IDENTITY",
  );
  assert.throws(
    () => createBaseInstantiationPlan(
      { ...FULL_PARAMETERS, plugin: {} } as unknown as BaseGenesisParameters,
    ),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_INVALID",
  );
  assert.throws(
    () => createBaseInstantiationPlan({ ...FULL_PARAMETERS, world: { name: "  " } }),
    /world\.name/,
  );
  assert.throws(
    () => createBaseInstantiationPlan(
      { ...FULL_PARAMETERS, playerStance: "gm" } as unknown as BaseGenesisParameters,
    ),
    /playerStance/,
  );
});

test("base instantiation plan is fail-closed on nested unknown and identity keys", () => {
  // 嵌套身份键绝不静默丢弃降级为 base（BASE_CONTENT_IDENTITY）。
  const identityKeys = ["worldIdentity", "runtimeIdentity", "worldId", "worldVersion"];
  const nestedCarriers: Record<string, unknown>[] = [
    { world: { ...FULL_PARAMETERS.world } },
    { story: { ...FULL_PARAMETERS.story } },
    { record: { ...FULL_PARAMETERS.record } },
    { scene: { ...FULL_PARAMETERS.scene } },
    { characters: [{ displayName: "阿汐" }] },
  ];
  for (const carrier of nestedCarriers) {
    const [slot, value] = Object.entries(carrier)[0]!;
    for (const key of identityKeys) {
      const forged = slot === "characters"
        ? { ...FULL_PARAMETERS, characters: [{ ...(value as object[])[0]!, [key]: "world_x" }] }
        : { ...FULL_PARAMETERS, [slot]: { ...(value as object), [key]: "world_x" } };
      assert.throws(
        () => createBaseInstantiationPlan(forged as unknown as BaseGenesisParameters),
        (error: unknown) => error instanceof BaseContentError
          && error.code === "BASE_CONTENT_IDENTITY",
        `${slot}.${key} must be rejected as identity`,
      );
    }
  }
  // 嵌套未知键 fail-closed（BASE_CONTENT_INVALID），绝不静默丢弃语义。
  const unknownCarriers: [string, Record<string, unknown>][] = [
    ["world", { name: "雾港", climate: "wet" }],
    ["story", { title: "熄灯之夜", chapter: 1 }],
    ["record", { title: "第一夜", extra: "x" }],
    ["scene", { location: "灯塔顶层", mood: "dark" }],
  ];
  for (const [slot, value] of unknownCarriers) {
    assert.throws(
      () => createBaseInstantiationPlan(
        { ...FULL_PARAMETERS, [slot]: value } as unknown as BaseGenesisParameters,
      ),
      (error: unknown) => error instanceof BaseContentError
        && error.code === "BASE_CONTENT_INVALID",
      `unknown ${slot} key must be rejected`,
    );
  }
  assert.throws(
    () => createBaseInstantiationPlan({
      ...FULL_PARAMETERS,
      characters: [{ displayName: "阿汐", characterKey: "preset_x" }],
    } as unknown as BaseGenesisParameters),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_INVALID",
    "unknown character key must be rejected",
  );
});

test("base plan adapter is fail-closed on forged plans carrying identity keys", () => {
  const plan = createBaseInstantiationPlan(FULL_PARAMETERS);
  // binding 合法但 plan 本体夹带身份：绝不静默丢弃身份降级为 base。
  for (const key of ["worldIdentity", "runtimeIdentity", "worldId", "worldVersion"]) {
    assert.throws(
      () => baseInstantiationPlanToGenesisDraft(
        { ...plan, [key]: "world_x" } as unknown as BaseInstantiationPlan,
      ),
      (error: unknown) => error instanceof BaseContentError
        && error.code === "BASE_CONTENT_IDENTITY",
      `plan.${key} must be rejected`,
    );
  }
  // 嵌套内容对象夹带身份同样拒绝。
  const nestedForged: [string, Record<string, unknown>][] = [
    ["world", { ...plan.world, worldId: "world_x" }],
    ["story", { ...plan.story, worldId: "world_x" }],
    ["record", { ...plan.record, worldId: "world_x" }],
    ["scene", { ...plan.scene, worldId: "world_x" }],
  ];
  for (const [slot, value] of nestedForged) {
    assert.throws(
      () => baseInstantiationPlanToGenesisDraft(
        { ...plan, [slot]: value } as unknown as BaseInstantiationPlan,
      ),
      (error: unknown) => error instanceof BaseContentError
        && error.code === "BASE_CONTENT_IDENTITY",
      `plan.${slot}.worldId must be rejected`,
    );
  }
  assert.throws(
    () => baseInstantiationPlanToGenesisDraft({
      ...plan,
      characters: [{ ...plan.characters[0]!, worldId: "world_x" }],
    } as unknown as BaseInstantiationPlan),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_IDENTITY",
    "plan.characters[].worldId must be rejected",
  );
  // 合法 plan 不受影响：恒可适配且不携带身份键。
  const draft = baseInstantiationPlanToGenesisDraft(plan);
  assert.equal(draft.worldIdentity, undefined);
  assert.equal(draft.runtimeIdentity, undefined);
});

test("base instantiation plan resolves engine-owned Goals fail-closed", () => {
  assert.throws(
    () => createBaseInstantiationPlan({ ...FULL_PARAMETERS, goals: ["missing.goal"] }),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_GOAL_UNKNOWN",
  );
  assert.throws(
    () => createBaseInstantiationPlan({
      ...FULL_PARAMETERS,
      goals: ["base.first-narration", "base.first-narration"],
    }),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_INVALID",
  );
  // 自定义 engine-owned 定义集同样可注入（测试 seam，不是第二套 client）。
  const plan = createBaseInstantiationPlan(
    { ...FULL_PARAMETERS, goals: ["custom.goal"] },
    {
      resolveGoalDefinition: (request) =>
        request.worldVersion === LOCAL_WORLD_VERSION && request.goalKey === "custom.goal"
          ? {
            goalKey: "custom.goal",
            policyVersion: "custom-v1",
            mode: "deterministic",
            visible: true,
            rubric: {
              kind: "event_count",
              eventKind: "custom.event",
              progressKey: "custom",
              threshold: 1,
            },
            outcome: { result: "ok" },
          }
          : null,
    },
  );
  assert.equal(plan.goals[0]?.policyVersion, "custom-v1");
});

test("base plan adapts into the shared genesis draft without any identity keys", () => {
  const plan = createBaseInstantiationPlan({
    ...FULL_PARAMETERS,
    goals: ["base.first-narration"],
  });
  const draft = baseInstantiationPlanToGenesisDraft(plan);
  assert.equal(draft.worldIdentity, undefined);
  assert.equal(draft.runtimeIdentity, undefined);
  assert.equal(draft.language, "zh-CN");
  assert.equal(draft.style, "classical");
  assert.equal(draft.opening, "雾把灯塔吞到只剩一圈昏黄。");
  assert.deepEqual(draft.companions, [{
    name: "阿汐",
    role: "潮汐记录员",
    summary: "记得每一次涨潮。",
  }]);
  assert.deepEqual(draft.scene, {
    title: "旧灯塔",
    location: "灯塔顶层",
    weather: "浓雾",
    tension: "灯油将尽",
    displayTime: "子时",
    objective: "重新点灯",
  });
  // 与 world-bound 相同的物化形态：仅 goalKey/policyVersion 进入草稿。
  assert.deepEqual(draft.goals, [{
    goalKey: "base.first-narration",
    policyVersion: "base-v1",
  }]);
  // 无 Goals 的 base 计划保持旧草稿形态：不携带 goals 键。
  const noGoalDraft = baseInstantiationPlanToGenesisDraft(
    createBaseInstantiationPlan(FULL_PARAMETERS),
  );
  assert.equal(noGoalDraft.goals, undefined);
});

test("every preset draft round-trips losslessly through the base content provider", () => {
  // 证明 provider 覆盖现有 preset/base genesis 所需全部字段（§6 统一接线）。
  for (const key of PRESET_WORLD_KEYS) {
    for (const language of GENESIS_LANGUAGES) {
      const draft = getPresetWorldDraft(key, language);
      assert.ok(draft, `${key}/${language} preset draft must exist`);
      const plan = createBaseInstantiationPlan(baseGenesisParametersFromDraft(draft));
      assert.deepEqual(plan.binding, { kind: "base" });
      assert.deepEqual(
        baseInstantiationPlanToGenesisDraft(plan),
        draft,
        `${key}/${language} must round-trip losslessly`,
      );
    }
  }
});

const WORLD_BOUND_PLAN: RealmWorldRuntimeInstantiationPlan = {
  binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
  world: {
    name: "灰烬港",
    era: "长风暴之后",
    summary: "潮线重现。",
    settings: { era: "长风暴之后", language: "zh-CN", style: "classical" },
  },
  story: { title: "港湾故事", premise: "潮线重新出现。" },
  record: { title: "第一夜" },
  scene: {
    title: "北码头",
    location: "北码头",
    objective: "等待潮汐",
    tension: "风暴逼近",
    weather: "盐雨",
    displayTime: "夜哨",
  },
  playerRole: "守潮人",
  playerStance: "player",
  characters: [],
  goals: [],
};

test("the unified adapter never routes world-bound content through the base path", () => {
  const runtimeIdentity = {
    worldlineId: "worldline_realm_x",
    storyId: "story_realm_x",
    recordId: "record_realm_x",
  };
  const draft = instantiationPlanToGenesisDraft(WORLD_BOUND_PLAN, runtimeIdentity);
  // world-bound 计划保留精确身份，opening 恒为空（不由 base 内容补缺）。
  assert.deepEqual(draft.worldIdentity, WORLD_BOUND_PLAN.binding);
  assert.deepEqual(draft.runtimeIdentity, runtimeIdentity);
  assert.equal(draft.opening, "");
  // world-bound 缺 runtimeIdentity fail-closed，绝不回退 base 随机身份。
  assert.throws(
    () => instantiationPlanToGenesisDraft(WORLD_BOUND_PLAN),
    /runtime identity/,
  );
  // 携带 RealmWorld 身份的草稿绝不进入 base 内容层（不静默丢弃身份）。
  assert.throws(
    () => baseGenesisParametersFromDraft(draft),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_IDENTITY",
  );
  // 夹带身份键的伪 base binding 同样 fail-closed。
  const forged = {
    ...WORLD_BOUND_PLAN,
    opening: "",
    binding: { kind: "base", worldId: "world_harbor" },
  } as unknown as BaseInstantiationPlan;
  assert.throws(
    () => baseInstantiationPlanToGenesisDraft(forged),
    (error: unknown) => error instanceof BaseContentError
      && error.code === "BASE_CONTENT_IDENTITY",
  );
});

test("the Goal definition provider still resolves base without any mount", async () => {
  // mount 若被调用即失败——base 路径绝不触碰安装层。
  const resolver = createRealmWorldDefinitionResolver({
    mount: async () => {
      throw new Error("mount must never be called for base bindings");
    },
    baseResolver: resolveBaseGoalDefinition,
  });
  const definition = await resolver({
    worldId: "",
    worldVersion: LOCAL_WORLD_VERSION,
    goalKey: BUILTIN_BASE_GOAL_DEFINITIONS[0]!.goalKey,
  });
  assert.equal(definition?.goalKey, "base.first-narration");
  // 未知 key 在 base 下解析为 null（由 assessment 层按既有语义处理）。
  assert.equal(await resolver({
    worldId: "",
    worldVersion: LOCAL_WORLD_VERSION,
    goalKey: "missing.goal",
  }), null);
});
