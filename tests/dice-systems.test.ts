/**
 * 批次 T5 多骰系——引擎语义与 metadata.check 推导（确定性注入随机源）。
 * （docs/development/T5-DICE-RANDOMNESS.md §2.2/§4）
 *
 * 覆盖：五骰系边界语义（暴击/大失败/夹取）、parseCheckSpecification
 * 推导与 fail-closed、抽牌不放回（内存 provider 历史排除与抽空）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveUncertainty, type RandomIntSource } from "../modules/actions/engine.ts";
import {
  createDataDrivenRulePack,
  parseCheckSpecification,
  type RuleDefinitionProvider,
} from "../modules/actions/rule-pack.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

/** 固定序列随机源（含边界自检）。 */
function from(script: readonly number[]): RandomIntSource {
  const queue = [...script];
  return (min, max) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next < min || next > max) throw new Error(`script ${next} out of [${min}, ${max}]`);
    return next;
  };
}

// ── d20 / 2d6 暴击与大失败 ──

test("d20 natural 20 is a critical success regardless of target", () => {
  const { outcome, mechanic } = resolveUncertainty({
    check: { system: "d20", modifier: 0, target: 20 },
    randomInt: from([20]),
  });
  assert.equal(outcome, "success");
  assert.equal(mechanic.critical, true);
  assert.equal(mechanic.success, true);
});

test("d20 natural 1 is a fumble failure regardless of modifier", () => {
  const { outcome, mechanic } = resolveUncertainty({
    check: { system: "d20", modifier: 30, target: 5 },
    randomInt: from([1]),
  });
  assert.equal(outcome, "failure");
  assert.equal(mechanic.fumble, true);
});

test("2d6 boxcars critical and snake-eyes fumble", () => {
  const boxcars = resolveUncertainty({
    check: { system: "2d6", modifier: 0, target: 12 },
    randomInt: from([6, 6]),
  });
  assert.equal(boxcars.outcome, "success");
  assert.equal(boxcars.mechanic.critical, true);
  const snakeEyes = resolveUncertainty({
    check: { system: "2d6", modifier: 20, target: 3 },
    randomInt: from([1, 1]),
  });
  assert.equal(snakeEyes.outcome, "failure");
  assert.equal(snakeEyes.mechanic.fumble, true);
});

// ── percentile ──

test("percentile resolves by success rate with modifier clamp", () => {
  const hit = resolveUncertainty({
    check: { system: "percentile", modifier: 10, target: 40 },
    randomInt: from([50]),
  });
  assert.equal(hit.outcome, "success"); // 50 ≤ 40+10
  const miss = resolveUncertainty({
    check: { system: "percentile", modifier: 0, target: 40 },
    randomInt: from([41]),
  });
  assert.equal(miss.outcome, "failure");
  const clamped = resolveUncertainty({
    check: { system: "percentile", modifier: 500, target: 40 },
    randomInt: from([95]),
  });
  assert.equal(clamped.outcome, "success"); // clamp 到 100
  const critical = resolveUncertainty({
    check: { system: "percentile", modifier: 0, target: 5 },
    randomInt: from([5]),
  });
  assert.equal(critical.mechanic.critical, true);
  const fumble = resolveUncertainty({
    check: { system: "percentile", modifier: 0, target: 100 },
    randomInt: from([96]),
  });
  assert.equal(fumble.outcome, "failure");
  assert.equal(fumble.mechanic.fumble, true);
});

// ── pool ──

test("pool counts successes at or above successOn with crit/fumble", () => {
  const resolved = resolveUncertainty({
    check: { system: "pool", modifier: 1, target: 3, dice: 4, sides: 6, successOn: 5 },
    randomInt: from([6, 5, 4, 1]),
  });
  assert.equal(resolved.mechanic.total, 3); // 2 成功 + 修正 1
  assert.equal(resolved.outcome, "success");
  const allSuccess = resolveUncertainty({
    check: { system: "pool", modifier: 0, target: 5, dice: 3, sides: 6, successOn: 6 },
    randomInt: from([6, 6, 6]),
  });
  assert.equal(allSuccess.mechanic.critical, true);
  assert.equal(allSuccess.outcome, "success"); // 全骰成功即便 target 更大
  const none = resolveUncertainty({
    check: { system: "pool", modifier: 0, target: 1, dice: 3, sides: 6, successOn: 5 },
    randomInt: from([1, 2, 3]),
  });
  assert.equal(none.mechanic.fumble, true);
  assert.equal(none.outcome, "failure");
});

// ── draw ──

test("draw picks from the remaining deck and reports deckRemaining", () => {
  const { outcome, mechanic } = resolveUncertainty({
    check: { system: "draw", skillKey: "fate", deck: ["铜币", "金币"], successCards: ["金币"] },
    randomInt: from([1]),
  });
  assert.equal(outcome, "success");
  assert.equal(mechanic.drawnCard, "金币");
  assert.equal(mechanic.deckRemaining, 1);
  assert.equal(mechanic.skillKey, "fate");
  const miss = resolveUncertainty({
    check: { system: "draw", skillKey: "fate", deck: ["铜币"], successCards: ["金币"] },
    randomInt: from([0]),
  });
  assert.equal(miss.outcome, "failure");
  assert.equal(miss.mechanic.deckRemaining, 0);
});

// ── metadata.check 推导（数据驱动） ──

test("parseCheckSpecification derives each dice system from metadata", () => {
  assert.deepEqual(
    parseCheckSpecification({ system: "2d6", modifier: 1, target: 8 }),
    { system: "2d6", modifier: 1, target: 8 },
  );
  assert.deepEqual(
    parseCheckSpecification({ system: "percentile", target: 40 }),
    { system: "percentile", modifier: 0, target: 40 },
  );
  assert.deepEqual(
    parseCheckSpecification({ system: "pool", target: 2, dice: 3 }),
    { system: "pool", modifier: 0, target: 2, dice: 3, sides: 6, successOn: 6 },
  );
  assert.deepEqual(
    parseCheckSpecification({ system: "draw", deck: ["a", "b"], successCards: ["b"] }),
    { system: "draw", skillKey: "", deck: ["a", "b"], successCards: ["b"] },
  );
});

test("parseCheckSpecification fails closed on invalid dice metadata", () => {
  const invalid: unknown[] = [
    { system: "pool", target: 1, dice: 0 },
    { system: "pool", target: 1, dice: 51 },
    { system: "pool", target: 1, dice: 2, sides: 1 },
    { system: "pool", target: 1, dice: 2, sides: 6, successOn: 7 },
    { system: "percentile", target: 0 },
    { system: "percentile", target: 101 },
    { system: "draw", deck: [], successCards: ["a"] },
    { system: "draw", deck: ["a", "a"], successCards: ["a"] },
    { system: "draw", deck: ["a"], successCards: ["b"] },
    { system: "draw", deck: ["a"], successCards: ["a"], modifier: 1 },
  ];
  for (const spec of invalid) {
    assert.throws(
      () => parseCheckSpecification(spec),
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "RULE_DECISION_INVALID",
      `spec must fail closed: ${JSON.stringify(spec)}`,
    );
  }
});

// ── 抽牌不放回（内存 provider 历史排除与抽空） ──

function providerWithDrawSkill(drawn: readonly string[]): RuleDefinitionProvider {
  return {
    async loadSkill(skillKey) {
      if (skillKey !== "fate_cards") return null;
      return {
        definitionId: "def_fate",
        skillKey: "fate_cards",
        title: "命运牌",
        description: "抽一张牌决定走向。",
        metadata: {
          check: {
            system: "draw",
            deck: ["铜币", "银币", "金币"],
            successCards: ["金币"],
          },
        },
      };
    },
    async loadAsset() {
      return null;
    },
    async loadStance() {
      return null;
    },
    async listDrawnCards() {
      return drawn;
    },
  };
}

const ACTOR = {
  characterInstanceId: "char_inst_player",
  participantId: "participant_player",
  displayName: "玩家",
} as const;

function drawCall(callId: string) {
  return {
    callId,
    name: "use_skill" as const,
    arguments: { skillId: "fate_cards", targetId: null, intent: "抽牌" },
  };
}

test("draw decision excludes already-drawn cards from the deck", async () => {
  const rulePack = createDataDrivenRulePack(providerWithDrawSkill(["金币", "银币"]));
  const decision = await rulePack.decide({ actor: ACTOR, call: drawCall("t5-draw-1") });
  assert.equal(decision.resolution, "check");
  assert.equal(decision.check?.system, "draw");
  if (decision.check?.system !== "draw") throw new Error("unreachable");
  assert.deepEqual(decision.check.deck, ["铜币"]); // 不放回：已抽两张被排除
  assert.equal(decision.check.skillKey, "fate_cards");
});

test("draw decision fails closed with DECK_EXHAUSTED when the deck is empty", async () => {
  const rulePack = createDataDrivenRulePack(
    providerWithDrawSkill(["铜币", "银币", "金币"]),
  );
  await assert.rejects(
    rulePack.decide({ actor: ACTOR, call: drawCall("t5-draw-2") }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "DECK_EXHAUSTED",
  );
});

test("draw decision uses the full deck when the provider has no history", async () => {
  const provider = providerWithDrawSkill([]);
  delete provider.listDrawnCards; // 纯内存组合：无历史可查 → 完整牌堆
  const rulePack = createDataDrivenRulePack(provider);
  const decision = await rulePack.decide({ actor: ACTOR, call: drawCall("t5-draw-3") });
  if (decision.check?.system !== "draw") throw new Error("unreachable");
  assert.deepEqual(decision.check.deck, ["铜币", "银币", "金币"]);
});
