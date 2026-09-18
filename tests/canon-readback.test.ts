/**
 * 批次 T9 Canon 回读——Core 纯函数契约（public documentation §4.1）。
 * 覆盖：晶化入图白名单谓词/空值与超长整条丢弃/顺序确定；世界本体实体 id 确定性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYSTALLIZATION_CLAIM_VALUE_LIMIT,
  buildCrystallizationClaimDrafts,
  crystallizationWorldEntityId,
} from "../modules/application/scene-crystallization.ts";

test("crystallization graph drafts cover only the five whitelisted predicates", () => {
  const drafts = buildCrystallizationClaimDrafts({
    location: "灯塔值房",
    weather: "浓雾",
    tension: "岗哨加倍",
    displayTime: "雾月12日 · 深夜",
    objective: "守住渡口",
  });
  assert.deepEqual(
    drafts.map((draft) => draft.predicate).sort(),
    [
      "scene.location",
      "scene.objective",
      "world.displayTime",
      "world.tension",
      "world.weather",
    ],
  );
  assert.ok(drafts.every((draft) => draft.objectValue.length > 0));
});

test("empty and oversized values are dropped per-field (fail-closed)", () => {
  const drafts = buildCrystallizationClaimDrafts({
    location: "",
    weather: "   ",
    tension: "岗哨加倍",
    objective: "超".repeat(CRYSTALLIZATION_CLAIM_VALUE_LIMIT + 1),
  });
  assert.deepEqual(drafts, [
    { predicate: "world.tension", objectValue: "岗哨加倍" },
  ]);
  assert.deepEqual(buildCrystallizationClaimDrafts({}), []);
});

test("world entity id is deterministic per world", () => {
  const first = crystallizationWorldEntityId("world_abc123def456");
  const second = crystallizationWorldEntityId("world_abc123def456");
  assert.equal(first, second);
  assert.ok(first.startsWith("entity_world_"));
  assert.notEqual(
    crystallizationWorldEntityId("world_abc123def456"),
    crystallizationWorldEntityId("world_zzz999yyy888"),
  );
});

/* ======================= 消费侧：brief.canon → buildSceneCanon ======================= */

import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import type {
  ModelChatRequest,
  ModelGateway,
} from "../modules/inference/public.ts";

test("canon readout enters the DM plan prompt only when present (backward compatible)", async () => {
  for (const canon of ["", "- 北岸灯塔 状态：无风夜自行点亮"]) {
    const prompts: ModelChatRequest[] = [];
    const fakeGateway: ModelGateway = {
      async discoverModels() {
        return [];
      },
      async chat(request) {
        prompts.push(request);
        return {
          model: "fake",
          content: JSON.stringify({
            goal: "推进一幕",
            activatedCharacterInstanceIds: [],
            narratorEnabled: true,
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    };
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [],
      getGateway: async () => fakeGateway,
      brief: {
        worldName: "烬海诸国",
        era: "停战纪元 17 年",
        summary: "人魔停战十七年后。",
        storyTitle: "无声钟的来客",
        premise: "一封密函被送上岸。",
        location: "灰鲸港",
        weather: "冷雾",
        tension: "钟声三响",
        objective: "拆信",
        canon,
        worldLore: "",
      },
    });
    await orchestrator.plan({ turnId: "turn-canon", playerText: "我抬头看灯。" });
    // Prompt System v2：canon 权威语义由 system 的静态 English 规则表达；
    // canon 原文（动态世界资料）进入 user 的 [World and scene] context block。
    const system = prompts[0]?.messages[0]?.content ?? "";
    const user = prompts[0]?.messages[1]?.content ?? "";
    assert.match(system, /binding established history/);
    if (canon) {
      assert.ok(user.includes("[World and scene]"), "世界资料块必须在 user 侧");
      assert.ok(user.includes(canon), "canon 原文进入 user context block");
      assert.ok(!system.includes(canon), "canon 动态内容不得进入 system");
    } else {
      assert.ok(!user.includes('"canon"'), "无 canon 时字段缺席");
    }
  }
});
