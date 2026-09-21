import assert from "node:assert/strict";
import test from "node:test";
import { generateFirstNightPack, type FirstNightContext } from "../modules/application/first-night.ts";
import { generateGenesisChatReply } from "../modules/application/genesis-chat.ts";
import type { ModelGateway } from "../modules/inference/public.ts";
import {
  setModelCallObserver,
  type ModelCallObservation,
} from "../modules/inference/model-call-observer.ts";

/**
 * Batch 2B-P1：first-night / genesis-chat 模型调用观测接线。
 * 每个逻辑 structured call 恰好一条观测；providerAttempts 如实记录
 * 该逻辑调用内的真实 gateway 请求次数（genesis-chat 退化阶梯不合并、
 * 不拆分）；行为（调用次数/降级/fallback）零变化。
 */

type Step = { content: string; model?: string } | { error: Error };

function scriptedGateway(script: readonly Step[]) {
  const requests: Record<string, unknown>[] = [];
  let calls = 0;
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      requests.push(request as unknown as Record<string, unknown>);
      const step = script[Math.min(calls, script.length - 1)]!;
      calls += 1;
      if ("error" in step) throw step.error;
      return {
        model: step.model ?? "fake-model",
        content: step.content,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
  return { gateway, requests, callCount: () => calls };
}

function captureObservations() {
  const events: ModelCallObservation[] = [];
  setModelCallObserver((event) => events.push(event));
  return { events, restore: () => setModelCallObserver(null) };
}

const FIRST_NIGHT_CONTEXT: FirstNightContext = {
  world: { name: "烬海诸国", era: "停战纪元 17 年", summary: "人魔停战后。" },
  style: "classical",
  language: "zh-CN",
  story: { title: "无声钟的来客", premise: "密函上岸。" },
  playerRole: "人类使节",
  playerName: "洛川",
  playerStance: "player",
  companions: [],
  scene: { location: "灰鲸港", weather: "冷雾", tension: "钟声三响", objective: "拆信" },
  opening: "",
};

const FIRST_NIGHT_VALID = JSON.stringify({
  scene: { environment: "雾漫防波堤", story: "钟又响了", fact: "灯室已亮" },
  characters: [],
  hook: { content: "蜡封完好。", suggestions: ["拆开密函", "询问守灯人"] },
});

const GENESIS_VALID = JSON.stringify({
  reply: "雾从何来？",
  phase: "exploring",
  draftPatch: null,
});

test("first-night 观测：正常一次调用记 success（attempts=1, repairs=0）", async () => {
  const { gateway, requests, callCount } = scriptedGateway([
    { content: FIRST_NIGHT_VALID },
  ]);
  const { events, restore } = captureObservations();
  try {
    const pack = await generateFirstNightPack(gateway, FIRST_NIGHT_CONTEXT);
    assert.ok(pack);
    assert.equal(callCount(), 1, "观测接线不得新增模型调用");
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.stage, "first-night");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    assert.equal(event.structuredRepairs, 0);
    assert.equal(event.model, "fake-model");
    assert.deepEqual(event.usage, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    assert.equal(event.finishReason, "stop");
    // chat 入参形状与修复前一致（观测 metadata 不进模型请求）。
    assert.deepEqual(Object.keys(requests[0]!).sort(), [
      "messages",
      "responseFormat",
      "temperature",
    ]);
    assert.equal(JSON.stringify(event).includes("雾漫防波堤"), false);
  } finally {
    restore();
  }
});

test("first-night 观测：初次 invalid + repair valid → success（attempts=2, repairs=1）", async () => {
  const { gateway, callCount } = scriptedGateway([
    { content: "这不是 JSON" },
    { content: FIRST_NIGHT_VALID },
  ]);
  const { events, restore } = captureObservations();
  try {
    const pack = await generateFirstNightPack(gateway, FIRST_NIGHT_CONTEXT);
    assert.ok(pack);
    assert.equal(callCount(), 2, "单次初试 + 恰好一次 repair（不按注释改 3 次）");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, "success");
    assert.equal(events[0]!.providerAttempts, 2);
    assert.equal(events[0]!.structuredRepairs, 1);
    assert.deepEqual(events[0]!.structuredFailureKinds, ["unparseable"]);
  } finally {
    restore();
  }
});

test("first-night 观测：双失败与 provider error 的终态（降级语义不变）", async () => {
  // 双结构化失败 → null（降级包由调度方落），observation 记 error。
  const failing = scriptedGateway([
    { content: "这不是 JSON" },
    { content: "仍然不是 JSON" },
  ]);
  const first = captureObservations();
  try {
    const pack = await generateFirstNightPack(failing.gateway, FIRST_NIGHT_CONTEXT);
    assert.equal(pack, null, "双失败仍 fail-closed null（降级语义不变）");
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]!.outcome, "error");
    assert.equal(first.events[0]!.errorCode, "FIRST_NIGHT_INVALID");
    assert.equal(first.events[0]!.providerAttempts, 2);
    assert.equal(first.events[0]!.structuredRepairs, 1);
  } finally {
    first.restore();
  }

  // provider/network/timeout error → 函数内部吞掉返回 null；观测记 error。
  const timeoutError = Object.assign(new Error("timeout"), {
    code: "MODEL_TIMEOUT",
  });
  const erroring = scriptedGateway([{ error: timeoutError }]);
  const second = captureObservations();
  try {
    const pack = await generateFirstNightPack(
      erroring.gateway,
      FIRST_NIGHT_CONTEXT,
    );
    assert.equal(pack, null, "provider error 仍按既有语义降级 null");
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]!.outcome, "error");
    assert.equal(second.events[0]!.errorCode, "MODEL_TIMEOUT");
    assert.equal(second.events[0]!.providerAttempts, 1);
    assert.equal(second.events[0]!.structuredRepairs, 0);
  } finally {
    second.restore();
  }
});

test("genesis-chat 观测：正常一次调用记 success（attempts=1）", async () => {
  const { gateway, requests, callCount } = scriptedGateway([
    { content: GENESIS_VALID },
  ]);
  const { events, restore } = captureObservations();
  try {
    const outcome = await generateGenesisChatReply(gateway, {
      message: "一座雾港",
      transcript: [],
      draft: null,
    });
    assert.ok(outcome);
    assert.equal(callCount(), 1);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.stage, "genesis-chat");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    assert.equal(event.structuredRepairs, 0);
    assert.deepEqual(Object.keys(requests[0]!).sort(), [
      "messages",
      "responseFormat",
      "temperature",
    ]);
    assert.equal(JSON.stringify(event).includes("雾从何来"), false);
  } finally {
    restore();
  }
});

test("genesis-chat 观测：退化阶梯如实计数（一条观测 attempts=3，不合并不拆分）", async () => {
  const { gateway, callCount } = scriptedGateway([
    { content: "   " }, // ① 纯空白退化
    { content: "" }, // ② 关思考仍空
    { content: GENESIS_VALID, model: "deepseek-v4-pro" }, // ③ 备选模型成功
  ]);
  const { events, restore } = captureObservations();
  try {
    const outcome = await generateGenesisChatReply(gateway, {
      message: "一座雾港",
      transcript: [],
      draft: null,
      fallbackModel: "deepseek-v4-pro",
    });
    assert.ok(outcome);
    assert.equal(callCount(), 3, "阶梯实际调用次数不变");
    assert.equal(events.length, 1, "一个逻辑 structured call 恰好一条观测");
    const event = events[0]!;
    assert.equal(event.stage, "genesis-chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 3, "阶梯真实请求数如实记录");
    assert.equal(event.structuredRepairs, 0);
    assert.equal(event.model, "deepseek-v4-pro");
  } finally {
    restore();
  }
});

test("genesis-chat 观测：全阶梯退化 → error（attempts=4=阶梯3+repair1，业务 null 不变）", async () => {
  const { gateway, callCount } = scriptedGateway([
    { content: "" },
    { content: "  " },
    { content: "{" },
    { content: "still-not-json" },
  ]);
  const { events, restore } = captureObservations();
  try {
    const outcome = await generateGenesisChatReply(gateway, {
      message: "一座雾港",
      transcript: [],
      draft: null,
      fallbackModel: "deepseek-v4-pro",
    });
    assert.equal(outcome, null, "全退化 fail-closed null 语义不变");
    assert.equal(callCount(), 4, "阶梯 3 次 + repair 1 次，与修复前契约一致");
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, "error");
    assert.equal(event.errorCode, "GENESIS_CHAT_INVALID");
    assert.equal(event.providerAttempts, 4);
    assert.equal(event.structuredRepairs, 1);
    assert.deepEqual(event.structuredFailureKinds, [
      "unparseable",
      "unparseable",
    ]);
  } finally {
    restore();
  }
});

test("genesis-chat 观测：阶梯中途 provider error 也计入已发出的失败请求", async () => {
  const providerError = Object.assign(new Error("provider down"), {
    code: "MODEL_REQUEST_FAILED",
  });
  const erroring = scriptedGateway([
    { content: "" }, // ① 空响应，进入阶梯 ②
    { error: providerError }, // ② 请求已发出但失败
  ]);
  const { events, restore } = captureObservations();
  try {
    await assert.rejects(
      generateGenesisChatReply(erroring.gateway, {
        message: "一座雾港",
        transcript: [],
        draft: null,
        fallbackModel: "deepseek-v4-pro",
      }),
      /provider down/,
    );
    assert.equal(erroring.callCount(), 2);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, "error");
    assert.equal(events[0]!.providerAttempts, 2);
    assert.equal(events[0]!.errorCode, "MODEL_REQUEST_FAILED");
    assert.equal(events[0]!.structuredRepairs, 0);
  } finally {
    restore();
  }
});

test("genesis-chat 观测：provider error 记 error 且不新增后续请求；observer 抛错不改业务", async () => {
  const providerError = Object.assign(new Error("provider down"), {
    code: "MODEL_RATE_LIMITED",
  });
  const erroring = scriptedGateway([{ error: providerError }]);
  const first = captureObservations();
  try {
    await assert.rejects(
      generateGenesisChatReply(erroring.gateway, {
        message: "一座雾港",
        transcript: [],
        draft: null,
      }),
      /provider down/,
    );
    assert.equal(erroring.callCount(), 1, "provider error 后不发起后续请求");
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]!.outcome, "error");
    assert.equal(first.events[0]!.errorCode, "MODEL_RATE_LIMITED");
    assert.equal(first.events[0]!.structuredRepairs, 0);
  } finally {
    first.restore();
  }

  // observer 回调抛错：业务结果与调用次数不变。
  const { gateway, callCount } = scriptedGateway([{ content: GENESIS_VALID }]);
  setModelCallObserver(() => {
    throw new Error("observer exploded");
  });
  try {
    const outcome = await generateGenesisChatReply(gateway, {
      message: "一座雾港",
      transcript: [],
      draft: null,
    });
    assert.ok(outcome, "observer 抛错不得改变业务返回值");
    assert.equal(callCount(), 1);
  } finally {
    setModelCallObserver(null);
  }
});
