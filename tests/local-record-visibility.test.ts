import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as visibilityModule from "../modules/application/local-record-visibility.ts";
import {
  LocalRecordServiceError,
  createMemoryVisibilityProposalRegistry,
} from "../modules/application/local-record-service.ts";
import {
  demoRecordRuntimeScope,
  type WriteScope,
} from "../modules/application/local-record-read-model.ts";
import {
  FatalTurnError,
  RetryableTurnError,
  RuntimeInvariantError,
} from "../modules/runtime/public.ts";
import type { TurnVisibilityAssessment } from "../modules/orchestration/public.ts";

/**
 * Phase 2D：visibility resolution（assessor → plan/proposal）已从 facade 拆入
 * modules/application/local-record-visibility.ts。本文件是拆分边界测试：
 * ① seam——facade 真实接线到新模块（import + 调用 + re-export），不再自带
 *    resolution/诊断实现，新模块不反向 import facade；
 * ② behavior——无 assessor 默认 public、assessor public 直返、restricted 签发
 *    提案并抛 VISIBILITY_CONFIRMATION_REQUIRED（原文案/字段）、public/restricted
 *    confirmation 走 registry authorize、signal 原样传递、assessor 失败的
 *    TURN_FAILED + 诊断分类，全部与拆分前逐行一致。
 */

const SCOPE: WriteScope = {
  workspaceId: "workspace-local",
  recordId: "record-local",
  principalId: "principal-local",
  characterInstanceId: "char_inst_player",
};

const RUNTIME_SCOPE = demoRecordRuntimeScope();

const RESTRICTED_ASSESSMENT: TurnVisibilityAssessment = {
  visibility: {
    kind: "restricted",
    domainId: "domain_private",
    audienceCharacterInstanceIds: [
      RUNTIME_SCOPE.playerActor.characterInstanceId,
      RUNTIME_SCOPE.aiCharacters[0]!.characterInstanceId,
    ],
  },
  reason: "密函内容只宜让在场者知晓。",
};

function resolve(
  overrides: Partial<Parameters<typeof visibilityModule.resolveTurnVisibility>[0]> = {},
) {
  return visibilityModule.resolveTurnVisibility({
    input: { content: "我悄悄拆开密函。", idempotencyKey: "cmd-1" },
    scope: SCOPE,
    runtimeScope: RUNTIME_SCOPE,
    canonicalVersion: 7,
    proposals: createMemoryVisibilityProposalRegistry({ randomToken: () => "proposal-1" }),
    ...overrides,
  });
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: string,
): Promise<LocalRecordServiceError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof LocalRecordServiceError,
    `expected LocalRecordServiceError, got ${String(caught)}`,
  );
  assert.equal(caught.code, code);
  return caught;
}

test("seam：facade 真实接线到新模块且无第二份实现/反向 import", () => {
  assert.equal(typeof visibilityModule.resolveTurnVisibility, "function");

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-visibility.ts"'),
    "facade 必须 import local-record-visibility.ts",
  );
  assert.ok(
    /export\s+type\s*\{[\s\S]*?\bLocalVisibilityAssessor\b[\s\S]*?\}\s*from\s*["']\.\/local-record-visibility\.ts["']/
      .test(facadeSource),
    "facade 必须 re-export LocalVisibilityAssessor 保持旧类型路径",
  );
  assert.ok(
    /export\s+type\s*\{[\s\S]*?\bLocalVisibilityConfirmation\b[\s\S]*?\}\s*from\s*["']\.\/local-record-visibility\.ts["']/
      .test(facadeSource),
    "facade 必须 re-export LocalVisibilityConfirmation 保持旧类型路径",
  );
  assert.ok(
    !/async function resolveTurnVisibility/.test(facadeSource),
    "facade 不得再自行定义 resolveTurnVisibility",
  );
  assert.ok(
    !/function diagnosticFromError/.test(facadeSource),
    "facade 不得再自行定义 diagnosticFromError",
  );
  assert.ok(
    !/function formatTurnFailureMessage/.test(facadeSource),
    "facade 不得再自行定义 formatTurnFailureMessage",
  );
  assert.ok(
    !/function runtimeActorNames/.test(facadeSource),
    "facade 不得再自行定义 runtimeActorNames",
  );
  assert.ok(
    !/interface LocalVisibilityAssessor/.test(facadeSource),
    "facade 不得再自行定义 LocalVisibilityAssessor",
  );
  // submitMessage 必须真实调用新模块的 resolution。
  assert.ok(
    /await resolveTurnVisibility\(\{/.test(facadeSource),
    "submitMessage 必须真实调用 resolveTurnVisibility",
  );

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-visibility.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "新模块不得反向 import local-record-service",
  );
});

test("无 assessor：默认 public，不签发提案", async () => {
  const result = await resolve();
  assert.deepEqual(result, { plan: { kind: "public" }, proposalId: null });
});

test("assessor 返回 public：直接返回 assessment 的 visibility", async () => {
  const result = await resolve({
    assessor: {
      assess: async () => ({
        visibility: { kind: "public" },
        reason: "",
      }),
    },
  });
  assert.deepEqual(result, { plan: { kind: "public" }, proposalId: null });
});

test("assessorFactory 优先于 assessor，并收到 runtimeScope", async () => {
  const seen: unknown[] = [];
  const result = await resolve({
    assessor: {
      assess: async () => {
        throw new Error("must not be called");
      },
    },
    assessorFactory: (scope) => {
      seen.push(scope);
      return {
        assess: async () => ({ visibility: { kind: "public" }, reason: "" }),
      };
    },
  });
  assert.deepEqual(result, { plan: { kind: "public" }, proposalId: null });
  assert.deepEqual(seen, [RUNTIME_SCOPE]);
});

test("restricted：签发提案并抛 VISIBILITY_CONFIRMATION_REQUIRED（文案/字段不变）", async () => {
  const error = await expectServiceError(
    resolve({
      assessor: { assess: async () => RESTRICTED_ASSESSMENT },
    }),
    "VISIBILITY_CONFIRMATION_REQUIRED",
  );
  assert.equal(
    error.message,
    "DM 判断这条内容可能只适合部分角色知道；请确认可见范围后再提交。",
  );
  assert.deepEqual(error.visibilityProposal, {
    proposalId: "proposal-1",
    kind: "restricted",
    audienceCharacterInstanceIds:
      RESTRICTED_ASSESSMENT.visibility.kind === "restricted"
        ? RESTRICTED_ASSESSMENT.visibility.audienceCharacterInstanceIds
        : [],
    audienceNames: ["洛川", "塞娜"],
    reason: "密函内容只宜让在场者知晓。",
  });
});

test("public confirmation：registry authorize 后返回 public plan，assessor 不被调用", async () => {
  const proposals = createMemoryVisibilityProposalRegistry({ randomToken: () => "proposal-2" });
  const proposal = proposals.issue({
    scope: SCOPE,
    canonicalVersion: 7,
    content: "我悄悄拆开密函。",
    assessment: RESTRICTED_ASSESSMENT,
  });
  const result = await resolve({
    input: {
      content: "我悄悄拆开密函。",
      idempotencyKey: "cmd-1",
      visibilityConfirmation: { proposalId: proposal.proposalId, decision: "public" },
    },
    proposals,
    assessor: {
      assess: async () => {
        throw new Error("assessor must not run when confirmation is present");
      },
    },
  });
  assert.deepEqual(result, {
    plan: { kind: "public" },
    proposalId: proposal.proposalId,
  });
});

test("restricted confirmation：返回原 assessment 的 visibility", async () => {
  const proposals = createMemoryVisibilityProposalRegistry({ randomToken: () => "proposal-3" });
  const proposal = proposals.issue({
    scope: SCOPE,
    canonicalVersion: 7,
    content: "我悄悄拆开密函。",
    assessment: RESTRICTED_ASSESSMENT,
  });
  const result = await resolve({
    input: {
      content: "我悄悄拆开密函。",
      idempotencyKey: "cmd-1",
      visibilityConfirmation: { proposalId: proposal.proposalId, decision: "restricted" },
    },
    proposals,
  });
  assert.deepEqual(result, {
    plan: RESTRICTED_ASSESSMENT.visibility,
    proposalId: proposal.proposalId,
  });
});

test("signal 原样传给 assessor；缺省时不附加 signal 字段", async () => {
  const controller = new AbortController();
  const seen: Array<Record<string, unknown>> = [];
  const capturing = {
    assess: async (input: { playerText: string; signal?: AbortSignal }) => {
      seen.push(input as Record<string, unknown>);
      return { visibility: { kind: "public" as const }, reason: "" };
    },
  };
  await resolve({ assessor: capturing, signal: controller.signal });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.playerText, "我悄悄拆开密函。");
  assert.equal(seen[0]!.signal, controller.signal, "signal 必须原样传递");

  seen.length = 0;
  await resolve({ assessor: capturing });
  assert.equal(seen.length, 1);
  assert.ok(!("signal" in seen[0]!), "无 signal 时不得附加 signal 字段");
});

test("assessor 抛 RetryableTurnError：TURN_FAILED + retryable 诊断（visibility 阶段）", async () => {
  const error = await expectServiceError(
    resolve({
      assessor: {
        assess: async () => {
          throw new RetryableTurnError("MODEL_TIMEOUT", "可见性模型超时。");
        },
      },
    }),
    "TURN_FAILED",
  );
  assert.deepEqual(error.diagnostic, {
    stage: "visibility",
    code: "MODEL_TIMEOUT",
    message: "可见性模型超时。",
    disposition: "retryable",
  });
  assert.equal(
    error.message,
    "本轮在「可见性判断」阶段未完成（MODEL_TIMEOUT）：可见性模型超时。",
  );
});

test("assessor 抛 FatalTurnError：TURN_FAILED + failed 诊断", async () => {
  const error = await expectServiceError(
    resolve({
      assessor: {
        assess: async () => {
          throw new FatalTurnError("PROVIDER_DOWN", "供应商不可用。");
        },
      },
    }),
    "TURN_FAILED",
  );
  assert.deepEqual(error.diagnostic, {
    stage: "visibility",
    code: "PROVIDER_DOWN",
    message: "供应商不可用。",
    disposition: "failed",
  });
});

test("assessor 抛 RuntimeInvariantError：诊断信息脱敏", async () => {
  const error = await expectServiceError(
    resolve({
      assessor: {
        assess: async () => {
          throw new RuntimeInvariantError("INVARIANT_BROKEN", "internal detail");
        },
      },
    }),
    "TURN_FAILED",
  );
  assert.deepEqual(error.diagnostic, {
    stage: "visibility",
    code: "INVARIANT_BROKEN",
    message: "运行时约束未满足；底层错误已脱敏。",
    disposition: "failed",
  });
});

test("assessor 抛未知错误：TURN_STEP_FAILED 兜底诊断", async () => {
  const error = await expectServiceError(
    resolve({
      assessor: {
        assess: async () => {
          throw new Error("boom");
        },
      },
    }),
    "TURN_FAILED",
  );
  assert.deepEqual(error.diagnostic, {
    stage: "visibility",
    code: "TURN_STEP_FAILED",
    message: "该阶段没有返回可安全展示的结构化结果。",
    disposition: "failed",
  });
});

test("assessor 抛带 diagnostic 的 LocalRecordServiceError：诊断原样透传", async () => {
  const diagnostic = {
    stage: "drafting" as const,
    code: "CUSTOM",
    message: "自定义诊断。",
    disposition: "failed" as const,
    attempt: 2,
  };
  const error = await expectServiceError(
    resolve({
      assessor: {
        assess: async () => {
          throw new LocalRecordServiceError(
            "TURN_FAILED",
            "inner",
            undefined,
            undefined,
            diagnostic,
          );
        },
      },
    }),
    "TURN_FAILED",
  );
  assert.deepEqual(error.diagnostic, diagnostic);
  // 诊断原样透传：message 按原 diagnostic 的 stage（drafting）格式化。
  assert.equal(
    error.message,
    "本轮在「内容生成」阶段未完成，第 2 次尝试（CUSTOM）：自定义诊断。",
  );
});
