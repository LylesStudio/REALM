/**
 * 批次 T4 判定参数推导——应用层用例
 * （public documentation §2.2/§5/§7.3）。
 *
 * 规则引擎数据驱动：判定形态与参数全部来自定义 metadata——
 * check 有效走检定（modifier/target 原样取自数据）、无 check 自动成功、
 * 非法 check 与未知骰系 fail-closed、targets 覆盖 outcomes、未定义能力
 * 保持既有 SKILL/ASSET/STANCE_NOT_AVAILABLE 形态。全程真实规则引擎，
 * 不新增 mock。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicActionResolver,
  renderDiscoveryDialogue,
  type DynamicDiscoveryContext,
  type DynamicDiscoveryRequest,
  type ActionActor,
} from "../modules/actions/public.ts";
import {
  createDataDrivenRulePack,
  type RuleDefinitionProvider,
  type SkillDefinitionRecord,
} from "../modules/actions/rule-pack.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

const actor: ActionActor = {
  characterInstanceId: "char_inst_probe",
  participantId: "participant_probe",
  displayName: "探针",
};

const dynamicContext: DynamicDiscoveryContext = {
  worldName: "雾港",
  era: "停战纪元",
  summary: "港口在冷雾中维持脆弱秩序。",
  storyTitle: "无声钟的来客",
  premise: "灯塔在无风夜自行点亮。",
  location: "北防波堤",
  weather: "冷雾，无风",
  tension: "钟声已经响过三次",
  objective: "确认灯塔异常的来源",
  canon: "- 灯塔属于北岸守望会。",
  recentPublicEvents: ["雾笛在远处响过一次。"],
};

function providerWithSkill(
  metadata: Record<string, unknown>,
  overrides: Partial<SkillDefinitionRecord> = {},
): RuleDefinitionProvider {
  const skill: SkillDefinitionRecord = {
    definitionId: "skill_probe",
    skillKey: "probe",
    title: "探查",
    description: "用于推导测试的探针技能。",
    metadata,
    ...overrides,
  };
  return {
    async loadSkill(skillKey) {
      return skillKey === skill.skillKey ? structuredClone(skill) : null;
    },
    async loadAsset() {
      return null;
    },
    async loadStance() {
      return null;
    },
  };
}

function skillCall(callId: string, targetId: string | null = null) {
  return {
    callId,
    name: "use_skill",
    arguments: { skillId: "probe", targetId, intent: "探查眼前的情况。" },
  } as const;
}

test("metadata.check drives the check resolution with data-defined parameters", async () => {
  const resolver = createDeterministicActionResolver({
    rulePack: createDataDrivenRulePack(
      providerWithSkill({ check: { system: "d20", modifier: 3, target: 15 } }),
    ),
  });
  const transaction = await resolver.resolve({ actor, call: skillCall("t4-check-1") });
  assert.equal(transaction.receipt.resolution, "check");
  const mechanic = transaction.receipt.mechanic;
  assert.ok(mechanic, "check receipts must expose the internal mechanic");
  assert.equal(mechanic!.system, "d20");
  assert.equal(mechanic!.modifier, 3);
  assert.equal(mechanic!.target, 15);
  assert.equal(mechanic!.rolls.length, 1);
  assert.ok(mechanic!.rolls[0]! >= 1 && mechanic!.rolls[0]! <= 20);
  assert.equal(mechanic!.total, mechanic!.rolls[0]! + 3);
  assert.equal(
    transaction.receipt.outcome,
    mechanic!.success ? "success" : "failure",
  );

  // 重放幂等：同一 Call ID 重放同一判定（解析器指纹缓存，不重掷）。
  const replay = await resolver.resolve({ actor, call: skillCall("t4-check-1") });
  assert.deepEqual(replay.receipt.mechanic, mechanic);
});

test("an explicit partial margin yields a partial discovery without claiming success", async () => {
  const resolver = createDeterministicActionResolver({
    randomInt: () => 8,
    rulePack: createDataDrivenRulePack(
      providerWithSkill({
        check: { system: "d20", modifier: 1, target: 10, partialMargin: 2 },
        outcomes: {
          success: "{actor}确认了线索。",
          partial: "{actor}只确认了线索的一部分。",
          failure: "{actor}没有找到可靠线索。",
          privateObservation: "你知道这条线索还不足以确认来源。",
          discovery: {
            subject: "北侧接缝",
            feature: "水痕横切连续木纹，边缘整齐",
            nextCheck: "检查接缝与栏杆外侧",
          },
        },
      }),
    ),
  });
  const transaction = await resolver.resolve({ actor, call: skillCall("t4-partial") });
  assert.equal(transaction.receipt.outcome, "partial");
  assert.equal(transaction.receipt.mechanic?.success, false);
  assert.equal(transaction.receipt.summary, "探针只确认了线索的一部分。");
  assert.deepEqual(transaction.receipt.privateObservations, [{
    characterInstanceId: actor.characterInstanceId,
    content: "你知道这条线索还不足以确认来源。",
    discovery: {
      subject: "北侧接缝",
      feature: "水痕横切连续木纹，边缘整齐",
      nextCheck: "检查接缝与栏杆外侧",
      certainty: "partial",
    },
  }]);
});

test("structured discovery becomes actionable dialogue without quoting private observation prose", () => {
  assert.equal(
    renderDiscoveryDialogue({
      subject: "北侧接缝",
      feature: "水痕横切连续木纹，边缘整齐",
      nextCheck: "检查接缝与栏杆外侧",
      certainty: "partial",
    }),
    "“北侧接缝有点不对劲：水痕横切连续木纹，边缘整齐。我还不能下结论，先检查接缝与栏杆外侧。”",
  );
});

test("structured discovery survives receipt materialization without legacy prose", async () => {
  const resolver = createDeterministicActionResolver({
    randomInt: () => 19,
    rulePack: createDataDrivenRulePack(
      providerWithSkill({
        check: { system: "d20", modifier: 1, target: 10 },
        outcomes: {
          success: "{actor}确认了一条具体线索。",
          partial: "{actor}只确认了线索的一部分。",
          failure: "{actor}没有找到可靠线索。",
          discovery: {
            subject: "北侧接缝",
            feature: "水痕横切连续木纹",
            nextCheck: "检查接缝与栏杆外侧",
          },
        },
      }),
    ),
  });
  const transaction = await resolver.resolve({ actor, call: skillCall("t4-discovery-only") });
  assert.equal(
    transaction.receipt.privateObservations[0]?.content,
    "对象：北侧接缝；特征：水痕横切连续木纹；下一步：检查接缝与栏杆外侧",
  );
  assert.equal(transaction.receipt.privateObservations[0]?.discovery?.certainty, "confirmed");
});

test("dynamic discovery uses the current intent for any skill and replaces static fallback", async () => {
  const requests: DynamicDiscoveryRequest[] = [];
  const resolver = createDeterministicActionResolver({
    randomInt: () => 19,
    dynamicDiscoveryContext: dynamicContext,
    dynamicDiscoveryGenerator: {
      async generate(input) {
        requests.push(input);
        return {
          subject: input.call.arguments.intent.includes("浓雾") ? "浓雾" : "甲板",
          feature: "雾层边缘出现了周期性变薄的窄带",
          nextCheck: "等待下一次变薄并与钟声的时间对照",
        };
      },
    },
    rulePack: createDataDrivenRulePack(
      providerWithSkill({
        check: { system: "d20", modifier: 1, target: 10 },
        outcomes: {
          success: "{actor}完成了动态技能判断。",
          partial: "{actor}只完成了部分判断。",
          failure: "{actor}没有得到可靠结果。",
          privateObservation: "旧的静态 clue 不应进入动态路径。",
          discovery: {
            subject: "甲板",
            feature: "静态 fallback",
            nextCheck: "静态 fallback",
          },
        },
      }),
    ),
  });
  const call = skillCall("t4-dynamic-intent");
  const transaction = await resolver.resolve({
    actor,
    call: {
      ...call,
      arguments: { ...call.arguments, intent: "仔细观察浓雾" },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.call.arguments.intent, "仔细观察浓雾");
  assert.equal(requests[0]?.context.location, "北防波堤");
  assert.deepEqual(transaction.receipt.privateObservations[0]?.discovery, {
    subject: "浓雾",
    feature: "雾层边缘出现了周期性变薄的窄带",
    nextCheck: "等待下一次变薄并与钟声的时间对照",
    certainty: "confirmed",
  });
  assert.doesNotMatch(transaction.receipt.privateObservations[0]?.content ?? "", /旧的静态/);
});

test("dynamic discovery failure is fail-closed and replay does not call the generator twice", async () => {
  let calls = 0;
  const resolver = createDeterministicActionResolver({
    randomInt: () => 19,
    dynamicDiscoveryGenerator: {
      async generate() {
        calls += 1;
        throw new Error("provider unavailable");
      },
    },
    rulePack: createDataDrivenRulePack(
      providerWithSkill({
        check: { system: "d20", modifier: 1, target: 10 },
        outcomes: {
          success: "{actor}确认了公开结果。",
          partial: "{actor}只确认了部分公开结果。",
          failure: "{actor}没有确认公开结果。",
          privateObservation: "不应在动态 provider 失败时回退到旧观察。",
          discovery: {
            subject: "旧对象",
            feature: "旧特征",
            nextCheck: "旧下一步",
          },
        },
      }),
    ),
  });
  const call = skillCall("t4-dynamic-replay");
  const first = await resolver.resolve({ actor, call });
  const replay = await resolver.resolve({ actor, call: structuredClone(call) });
  assert.equal(calls, 1);
  assert.deepEqual(replay, first);
  assert.equal(first.receipt.privateObservations.length, 0);
});

test("failure outcome never invokes dynamic discovery", async () => {
  let calls = 0;
  const resolver = createDeterministicActionResolver({
    randomInt: () => 1,
    dynamicDiscoveryGenerator: {
      async generate() {
        calls += 1;
        return { subject: "不应出现", feature: "不应出现", nextCheck: "不应出现" };
      },
    },
    rulePack: createDataDrivenRulePack(providerWithSkill({
      check: { system: "d20", modifier: 0, target: 20 },
      outcomes: {
        success: "{actor}成功。",
        partial: "{actor}部分成功。",
        failure: "{actor}失败。",
        impossible: "不可行。",
      },
    })),
  });
  const transaction = await resolver.resolve({ actor, call: skillCall("t4-dynamic-failure") });
  assert.equal(transaction.receipt.outcome, "failure");
  assert.equal(calls, 0);
  assert.equal(transaction.receipt.privateObservations.length, 0);
});

test("skills without metadata.check resolve automatically without a mechanic", async () => {
  const resolver = createDeterministicActionResolver({
    rulePack: createDataDrivenRulePack(providerWithSkill({})),
  });
  const transaction = await resolver.resolve({ actor, call: skillCall("t4-auto") });
  assert.equal(transaction.receipt.resolution, "automatic");
  assert.equal(transaction.receipt.outcome, "success");
  assert.equal(transaction.receipt.mechanic, undefined);
  assert.equal(transaction.receipt.privateObservations.length, 0);
  // 缺省 outcomes 走通用模板（含技能 title 与行动者替换）。
  assert.match(transaction.receipt.summary, /探针/);
  assert.match(transaction.receipt.summary, /探查/);
});

test("targets metadata overrides outcome facts for the selected target", async () => {
  const resolver = createDeterministicActionResolver({
    rulePack: createDataDrivenRulePack(
      providerWithSkill({
        outcomes: { success: "{actor}完成了基础探查。" },
        targets: {
          sealed_letter: { success: "{actor}确认蜡封存在重新压合的细痕。" },
        },
      }),
    ),
  });
  const targeted = await resolver.resolve({
    actor,
    call: skillCall("t4-target", "sealed_letter"),
  });
  assert.equal(targeted.receipt.summary, "探针确认蜡封存在重新压合的细痕。");

  const untargeted = await resolver.resolve({
    actor,
    call: skillCall("t4-target-other", "other_target"),
  });
  assert.equal(untargeted.receipt.summary, "探针完成了基础探查。");
});

test("invalid check metadata fails closed with RULE_DECISION_INVALID", async () => {
  const invalidSpecs: unknown[] = [
    { system: "d20", modifier: 1.5, target: 10 },
    { system: "d20", modifier: 1, target: 0 },
    { system: "d20", modifier: "2", target: 10 },
    // 批次 T5：2d6/percentile/pool/draw 已实现，非法样例换成非法骰系参数。
    { system: "pool", modifier: 0, target: 2, dice: 0 },
    { system: "percentile", modifier: 0, target: 101 },
    { system: "draw", deck: ["a", "b"], successCards: ["c"] },
    { system: "draw", deck: ["a", "b"], successCards: ["a"], partialMargin: 2 },
    { system: "d20", modifier: 0, target: 10, partialMargin: 11 },
    { system: "unknown_dice", modifier: 1, target: 10 },
    "not-an-object",
  ];
  for (const [index, check] of invalidSpecs.entries()) {
    const resolver = createDeterministicActionResolver({
      rulePack: createDataDrivenRulePack(providerWithSkill({ check })),
    });
    await assert.rejects(
      resolver.resolve({ actor, call: skillCall(`t4-invalid-${index}`) }),
      (error: unknown) =>
        error instanceof FatalTurnError
        && error.code === "RULE_DECISION_INVALID",
      `check spec #${index} must fail closed`,
    );
  }
});

test("undefined capabilities keep the established NOT_AVAILABLE error shapes", async () => {
  const resolver = createDeterministicActionResolver({
    rulePack: createDataDrivenRulePack(providerWithSkill({})),
    // stateful 工具需放行到规则包，才能断言未定义的 NOT_AVAILABLE 形态。
    allowStatefulReceipts: true,
  });
  await assert.rejects(
    resolver.resolve({
      actor,
      call: {
        callId: "t4-missing-skill",
        name: "use_skill",
        arguments: { skillId: "ghost_skill", targetId: null, intent: "x" },
      },
    }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "SKILL_NOT_AVAILABLE",
  );
  await assert.rejects(
    resolver.resolve({
      actor,
      call: {
        callId: "t4-missing-asset",
        name: "use_asset",
        arguments: { assetId: "ghost_asset", targetId: null, intent: "x" },
      },
    }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "ASSET_NOT_AVAILABLE",
  );
  await assert.rejects(
    resolver.resolve({
      actor,
      call: {
        callId: "t4-missing-stance",
        name: "take_stance",
        arguments: { stanceId: "ghost_stance", intent: "x" },
      },
    }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "STANCE_NOT_AVAILABLE",
  );
});

test("demo rule pack keeps the careful_observation check parameters", async () => {
  const { createLocalRulePack } = await import("../modules/actions/public.ts");
  const decision = await createLocalRulePack().decide({
    actor,
    call: {
      callId: "t4-demo-check",
      name: "use_skill",
      arguments: { skillId: "careful_observation", targetId: "letter_seal", intent: "x" },
    },
  });
  assert.equal(decision.resolution, "check");
  assert.deepEqual(decision.check, { system: "d20", modifier: 2, target: 12 });
  // 蜡封仍是演示世界的公开规则事实；私有隐藏结果不再由技能定义预置。
  assert.match(decision.facts.success, /蜡封/);
  assert.equal(decision.privateObservation, undefined);
  assert.equal(decision.privateObservationDetail, undefined);
});
