import assert from "node:assert/strict";
import test from "node:test";
import {
  createSceneCrystallizer,
  normalizeSceneDelta,
  normalizeSceneVerdict,
  type SceneStateSnapshot,
} from "../modules/application/scene-crystallization.ts";
import { composeCrystallizationContent } from "../database/postgres/scene-crystallization-repository.ts";
import type { ModelGateway } from "../modules/inference/public.ts";
import {
  sanitizeObservationErrorCode,
  setModelCallObserver,
  type ModelCallObservation,
} from "../modules/inference/model-call-observer.ts";

const CURRENT: SceneStateSnapshot = {
  worldName: "烬海诸国",
  era: "停战纪元 17 年",
  displayTime: "停战纪元17年 · 雾月12日 · 入夜",
  location: "鸦港北侧防波堤",
  weather: "冷雾，无风",
  tension: "港卫戒备",
  objective: "决定是否拆开密函",
};

function fakeGateway(content: string | (() => string)): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat() {
      return {
        model: "fake-model",
        content: typeof content === "function" ? content() : content,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

test("normalizeSceneDelta keeps only non-empty fields and clamps length", () => {
  assert.equal(normalizeSceneDelta(null), null);
  assert.equal(normalizeSceneDelta("location"), null);
  assert.equal(normalizeSceneDelta({}), null);
  assert.equal(normalizeSceneDelta({ location: "   ", weather: "" }), null);

  const delta = normalizeSceneDelta({
    location: "  灯塔值房  ",
    weather: "雪",
    tension: 42,
    objective: "守".repeat(200),
  });
  assert.deepEqual(delta, {
    location: "灯塔值房",
    weather: "雪",
    objective: "守".repeat(120),
  });
});

test("normalizeSceneVerdict covers approved / adjusted / rejected and fail-closed", () => {
  // approved 原样通过
  const approved = normalizeSceneVerdict(
    { approved: true, reason: "相容" },
    "fake-model",
  );
  assert.deepEqual(approved, {
    approved: true,
    reason: "相容",
    adjusted: null,
    model: "fake-model",
  });

  // approved + adjusted：以裁决修正值为准
  const adjusted = normalizeSceneVerdict(
    { approved: true, reason: "修正措辞", adjusted: { weather: "小雪" } },
    "fake-model",
  );
  assert.deepEqual(adjusted?.adjusted, { weather: "小雪" });

  // rejected
  const rejected = normalizeSceneVerdict(
    { approved: false, reason: "时间倒退且非回溯叙事" },
    "fake-model",
  );
  assert.equal(rejected?.approved, false);

  // fail-closed 各分支
  assert.equal(normalizeSceneVerdict(null, "m"), null);
  assert.equal(normalizeSceneVerdict({ reason: "缺 approved" }, "m"), null);
  assert.equal(normalizeSceneVerdict({ approved: "yes" }, "m"), null);
  assert.equal(
    normalizeSceneVerdict({ approved: true, adjusted: "不是对象" }, "m"),
    null,
  );
  assert.equal(
    normalizeSceneVerdict({ approved: true, adjusted: {} }, "m"),
    null,
  );
});

test("crystallizer extracts deltas and adjudicates through the gateway", async () => {
  const replies = [
    JSON.stringify({ location: "灯塔值房", weather: "雪" }),
    JSON.stringify({ approved: true, reason: "动线相容" }),
  ];
  let call = 0;
  const crystallizer = createSceneCrystallizer({
    getGateway: async () => fakeGateway(() => replies[call++ % replies.length]!),
  });
  const extraction = await crystallizer.extract({
    playerText: "我们离开防波堤，走进灯塔值房。",
    turnSummary: "旁白：你们推开木门。",
    current: CURRENT,
  });
  assert.ok(extraction);
  const delta = extraction!.delta;
  assert.deepEqual(delta, { location: "灯塔值房", weather: "雪" });
  // growth 字段缺省为空（同一提取调用，不新增模型轮次）。
  assert.deepEqual(extraction!.worldClaims, []);
  assert.deepEqual(extraction!.characterNotes, []);

  const verdict = await crystallizer.adjudicate({
    playerText: "我们离开防波堤，走进灯塔值房。",
    turnSummary: "旁白：你们推开木门。",
    current: CURRENT,
    delta: delta!,
  });
  assert.ok(verdict);
  assert.equal(verdict.approved, true);
  assert.equal(verdict.model, "fake-model");

  // 非法 JSON 一律 fail-closed
  const broken = createSceneCrystallizer({
    getGateway: async () => fakeGateway("这不是 JSON"),
  });
  assert.equal(
    await broken.extract({ playerText: "x", turnSummary: "", current: CURRENT }),
    null,
  );
  assert.equal(
    await broken.adjudicate({
      playerText: "x",
      turnSummary: "",
      current: CURRENT,
      delta: { location: "y" },
    }),
    null,
  );

  // 网关错误向上抛，由服务层捕获（fail-closed 不中断回合）
  const failing = createSceneCrystallizer({
    getGateway: async () => {
      throw new Error("MODEL_API_KEY_MISSING");
    },
  });
  await assert.rejects(
    failing.extract({ playerText: "x", turnSummary: "", current: CURRENT }),
  );
});

test("composeCrystallizationContent renders only present fields", () => {
  // 缺省（modern）
  assert.equal(
    composeCrystallizationContent({ location: "灯塔值房", weather: "雪" }),
    "场景定格 — 场景转至灯塔值房；天气变为雪",
  );
  assert.equal(
    composeCrystallizationContent({ displayTime: "深夜" }),
    "场景定格 — 时间推进至深夜",
  );
  // classical / anime 措辞分流
  assert.equal(
    composeCrystallizationContent({ location: "灯塔值房", weather: "雪" }, "classical"),
    "场景定格 — 场景移至灯塔值房；天气转作雪",
  );
  assert.equal(
    composeCrystallizationContent({ displayTime: "深夜" }, "classical"),
    "场景定格 — 更次推移至深夜",
  );
  assert.equal(
    composeCrystallizationContent({ weather: "雪" }, "anime"),
    "场景锁定 — 天气变成雪了呢",
  );
});

/* ========== Batch 2B-P0：crystallization 模型调用观测接线 ========== */

test("sanitizeObservationErrorCode rejects unbounded runtime codes", () => {
  assert.equal(
    sanitizeObservationErrorCode({ code: "MODEL_TIMEOUT" }),
    "MODEL_TIMEOUT",
  );
  assert.equal(
    sanitizeObservationErrorCode({ code: "provider message with secret" }),
    "MODEL_PROVIDER_STEP_FAILED",
  );
  assert.equal(
    sanitizeObservationErrorCode({ code: "x".repeat(257) }),
    "MODEL_PROVIDER_STEP_FAILED",
  );
});

type CapturedRequest = Record<string, unknown>;

function scriptedGateway(
  script: readonly ({ content: string } | { error: Error })[],
  capture: { requests: CapturedRequest[] },
): { gateway: ModelGateway; callCount: () => number } {
  let calls = 0;
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      capture.requests.push(request as unknown as CapturedRequest);
      const step = script[Math.min(calls, script.length - 1)]!;
      calls += 1;
      if ("error" in step) throw step.error;
      return {
        model: "fake-model",
        content: step.content,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
  return { gateway, callCount: () => calls };
}

function captureObservations(): {
  events: ModelCallObservation[];
  restore: () => void;
} {
  const events: ModelCallObservation[] = [];
  setModelCallObserver((event) => events.push(event));
  return { events, restore: () => setModelCallObserver(null) };
}

test("extract 观测：正常一次调用记 success（attempts=1, repairs=0）", async () => {
  const capture = { requests: [] as CapturedRequest[] };
  const { gateway, callCount } = scriptedGateway(
    [{ content: JSON.stringify({ location: "灯塔值房" }) }],
    capture,
  );
  const { events, restore } = captureObservations();
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => gateway,
    });
    const extraction = await crystallizer.extract({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: CURRENT,
    });
    assert.ok(extraction?.delta);
    assert.equal(callCount(), 1, "观测接线不得新增模型调用");
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.stage, "crystallization-extract");
    assert.equal(event.providerId, "unknown");
    assert.equal(event.transport, "chat");
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 1);
    assert.equal(event.structuredRepairs, 0);
    assert.deepEqual(event.structuredFailureKinds, []);
    assert.equal(event.model, "fake-model");
    assert.deepEqual(event.usage, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    assert.equal(event.finishReason, "stop");
    assert.ok(event.requestId);
    assert.ok(typeof event.elapsedMs === "number");
    // 观测字段不得进入模型请求：chat 入参形状与修复前一致。
    assert.deepEqual(Object.keys(capture.requests[0]!).sort(), [
      "messages",
      "responseFormat",
      "temperature",
    ]);
    // 观测事件不含消息/prompt/正文。
    assert.equal(JSON.stringify(event).includes("灯塔值房"), false);
  } finally {
    restore();
  }
});

test("extract 观测：初次 invalid + repair valid → success，attempts=2 repairs=1", async () => {
  const capture = { requests: [] as CapturedRequest[] };
  const { gateway, callCount } = scriptedGateway(
    [
      { content: "这不是 JSON" },
      { content: JSON.stringify({ location: "灯塔值房" }) },
    ],
    capture,
  );
  const { events, restore } = captureObservations();
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => gateway,
    });
    const extraction = await crystallizer.extract({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: CURRENT,
    });
    assert.ok(extraction?.delta);
    assert.equal(callCount(), 2, "初次 + 恰好一次 repair，与修复前契约一致");
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, "success");
    assert.equal(event.providerAttempts, 2);
    assert.equal(event.structuredRepairs, 1);
    assert.deepEqual(event.structuredFailureKinds, ["unparseable"]);
  } finally {
    restore();
  }
});

test("extract 观测：初次与 repair 都 invalid → outcome=error 且返回 null", async () => {
  const capture = { requests: [] as CapturedRequest[] };
  const { gateway, callCount } = scriptedGateway(
    [{ content: "这不是 JSON" }, { content: "仍然不是 JSON" }],
    capture,
  );
  const { events, restore } = captureObservations();
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => gateway,
    });
    const extraction = await crystallizer.extract({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: CURRENT,
    });
    assert.equal(extraction, null, "双结构化失败仍 fail-closed null");
    assert.equal(callCount(), 2);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, "error");
    assert.equal(event.errorCode, "SCENE_EXTRACTION_INVALID");
    assert.equal(event.providerAttempts, 2);
    assert.equal(event.structuredRepairs, 1);
    assert.deepEqual(event.structuredFailureKinds, [
      "unparseable",
      "unparseable",
    ]);
  } finally {
    restore();
  }
});

test("adjudicate 观测：独立 stage；provider error 记 error；observer 抛错不改业务", async () => {
  const capture = { requests: [] as CapturedRequest[] };
  const { gateway } = scriptedGateway(
    [{ content: JSON.stringify({ approved: true, reason: "相容" }) }],
    capture,
  );
  const { events, restore } = captureObservations();
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => gateway,
    });
    const verdict = await crystallizer.adjudicate({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: CURRENT,
      delta: { location: "灯塔值房" },
    });
    assert.equal(verdict?.approved, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.stage, "crystallization-adjudicate");
    assert.equal(events[0]!.outcome, "success");
    assert.equal(events[0]!.providerAttempts, 1);
  } finally {
    restore();
  }

  // provider/network/timeout error：脱敏 errorCode 直通，observation 记 error。
  const failingCapture = { requests: [] as CapturedRequest[] };
  const timeoutError = Object.assign(new Error("timeout"), {
    code: "MODEL_TIMEOUT",
  });
  const failing = scriptedGateway([{ error: timeoutError }], failingCapture);
  const second = captureObservations();
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => failing.gateway,
    });
    await assert.rejects(
      crystallizer.adjudicate({
        playerText: "x",
        turnSummary: "",
        current: CURRENT,
        delta: { location: "y" },
      }),
      /timeout/,
    );
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]!.stage, "crystallization-adjudicate");
    assert.equal(second.events[0]!.outcome, "error");
    assert.equal(second.events[0]!.errorCode, "MODEL_TIMEOUT");
    assert.equal(second.events[0]!.structuredRepairs, 0);
  } finally {
    second.restore();
  }

  // observer 回调抛错：业务结果与调用次数不变。
  const third = { requests: [] as CapturedRequest[] };
  const { gateway: throwingGatewayObserved, callCount } = scriptedGateway(
    [{ content: JSON.stringify({ location: "灯塔值房" }) }],
    third,
  );
  setModelCallObserver(() => {
    throw new Error("observer exploded");
  });
  try {
    const crystallizer = createSceneCrystallizer({
      getGateway: async () => throwingGatewayObserved,
    });
    const extraction = await crystallizer.extract({
      playerText: "我们走进灯塔值房。",
      turnSummary: "旁白：门开了。",
      current: CURRENT,
    });
    assert.ok(extraction?.delta, "observer 抛错不得改变 crystallizer 返回值");
    assert.equal(callCount(), 1);
  } finally {
    setModelCallObserver(null);
  }
});
