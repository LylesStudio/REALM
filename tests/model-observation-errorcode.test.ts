/**
 * P1-13 观测 errorCode 统一：所有 model-call observation 共用脱敏白名单
 * （sanitizeObservationErrorCode）；未知 code 坍缩为通用分类，允许的模型
 * 枚举码（MODEL_AUTH_FAILED 等）透传。不泄漏 provider 原文/URL/凭据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelPoweredM2TurnOrchestrator,
} from "../modules/orchestration/model-powered.ts";
import {
  ModelProviderError,
  sanitizeObservationErrorCode,
  setModelCallObserver,
  type ModelCallObservation,
  type ModelGateway,
} from "../modules/inference/public.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

const SCOUT = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
} as const;

function gatewayThrowing(error: Error): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat(): Promise<never> {
      throw error;
    },
  };
}

async function observedPlanError(gateway: ModelGateway) {
  const observed: ModelCallObservation[] = [];
  setModelCallObserver((event) => observed.push(event));
  try {
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => gateway,
    });
    await orchestrator
      .plan({ turnId: "turn-observe", playerText: "拆开密函。" })
      .catch(() => undefined);
    return observed;
  } finally {
    setModelCallObserver(null);
  }
}

test("observation: 未知/恶意 code 统一坍缩为安全通用分类", async () => {
  const evil = Object.assign(
    new Error("synthetic provider detail: SHOULD_NOT_LEAK"),
    { code: "UNTRUSTED_INTERNAL_CODE_SHOULD_NOT_LEAK" },
  );
  const observed = await observedPlanError(gatewayThrowing(evil));
  assert.ok(observed.length > 0, "必须产生观测事件");
  const last = observed.at(-1)!;
  assert.equal(last.outcome, "error");
  assert.equal(
    last.errorCode,
    "MODEL_PROVIDER_STEP_FAILED",
    "未知 code 必须坍缩为通用安全分类",
  );
  const raw = JSON.stringify(last);
  assert.ok(!raw.includes("SHOULD_NOT_LEAK"), "观测不得透传原始错误细节");
  assert.ok(!raw.includes("UNTRUSTED_INTERNAL_CODE"), "观测不得透传任意内部 code");
});

test("observation: 允许的模型枚举码透传不被抹掉", async () => {
  const observed = await observedPlanError(
    gatewayThrowing(new ModelProviderError("MODEL_AUTH_FAILED", "HTTP 401", 401)),
  );
  assert.ok(observed.length > 0);
  const last = observed.at(-1)!;
  assert.equal(
    last.errorCode,
    "MODEL_AUTH_FAILED",
    "白名单内的 code 必须保留",
  );
  assert.ok(!JSON.stringify(last).includes("401"), "观测不得带原始错误文本");
});

test("sanitizeObservationErrorCode: 白名单纯函数边界", () => {
  const evil = Object.assign(new Error("synthetic detail"), {
    code: "UNTRUSTED_INTERNAL_CODE_SHOULD_NOT_LEAK",
  });
  assert.equal(
    sanitizeObservationErrorCode(evil),
    "MODEL_PROVIDER_STEP_FAILED",
    "任意运行时 code 必须坍缩",
  );
  assert.equal(
    sanitizeObservationErrorCode(new ModelProviderError("MODEL_AUTH_FAILED", "x", 401)),
    "MODEL_AUTH_FAILED",
    "模型枚举码保留",
  );
  assert.equal(
    sanitizeObservationErrorCode(new FatalTurnError("CHARACTER_ACTION_INVALID", "x")),
    "CHARACTER_ACTION_INVALID",
    "合法结构化业务码保留",
  );
  assert.equal(
    sanitizeObservationErrorCode(new FatalTurnError("RAW_UPSTREAM_ECHO", "x")),
    "MODEL_PROVIDER_STEP_FAILED",
    "非白名单 Fatal code 同样坍缩",
  );
  assert.equal(
    sanitizeObservationErrorCode(new Error("plain")),
    "MODEL_PROVIDER_STEP_FAILED",
    "无 code 错误坍缩",
  );
});
