/**
 * Local Record visibility resolution（Phase 2D）：从 local-record-service.ts
 * 拆出的「assessor → plan/proposal」裁决边界。行为保持——confirmation 走
 * proposal registry authorize、无 assessor 默认 public、restricted 签发提案并
 * 抛 VISIBILITY_CONFIRMATION_REQUIRED、signal 原样传递、assessor 失败的
 * TURN_FAILED + 诊断分类与文案，全部与拆分前逐行一致。
 *
 * 依赖方向硬边界：本模块只依赖 read-model 的共享类型/错误、Phase 2C 的
 * proposal registry、orchestration 可见性类型与 runtime 错误分类，绝不
 * import local-record-service.ts（反向依赖由 facade 以 import/re-export
 * 维持公开 API 与类型路径不变）。
 */
import {
  LocalRecordServiceError,
  type LocalTurnFailureDiagnostic,
  type WriteScope,
} from "./local-record-read-model.ts";
import type { VisibilityProposalRegistry } from "./local-record-visibility-proposals.ts";
import type { RecordRuntimeScope } from "../../database/postgres/public.ts";
import {
  FatalTurnError,
  RetryableTurnError,
  RuntimeInvariantError,
} from "../runtime/public.ts";
import type {
  TurnVisibilityAssessment,
  TurnVisibilityPlan,
} from "../orchestration/public.ts";

export interface LocalVisibilityAssessor {
  assess(input: {
    playerText: string;
  }): Promise<TurnVisibilityAssessment>;
}

export type LocalVisibilityConfirmation = {
  proposalId: string;
  decision: "public" | "restricted";
};

/** resolveTurnVisibility 的产物：回合可见性 plan + 已授权的提案 id。 */
export type TurnVisibilityResolution = {
  plan: TurnVisibilityPlan;
  proposalId: string | null;
};

/** resolution 所需的消息字段子集（facade 的 SubmitLocalMessageInput 结构化兼容）。 */
export interface ResolveTurnVisibilityMessage {
  content: string;
  idempotencyKey: string;
  visibilityConfirmation?: LocalVisibilityConfirmation;
}

export async function resolveTurnVisibility(input: {
  input: ResolveTurnVisibilityMessage;
  scope: WriteScope;
  runtimeScope: RecordRuntimeScope;
  canonicalVersion: number;
  assessor?: LocalVisibilityAssessor;
  assessorFactory?: (scope: RecordRuntimeScope) => LocalVisibilityAssessor;
  proposals: VisibilityProposalRegistry;
  /** Batch 2D：本 Turn 的取消信号（可选；取消即停可见性模型调用）。 */
  signal?: AbortSignal;
}): Promise<TurnVisibilityResolution> {
  if (input.input.visibilityConfirmation) {
    const confirmation = input.input.visibilityConfirmation;
    const proposal = input.proposals.authorize({
      proposalId: confirmation.proposalId,
      scope: input.scope,
      canonicalVersion: input.canonicalVersion,
      content: input.input.content,
      idempotencyKey: input.input.idempotencyKey,
    });
    return {
      plan: confirmation.decision === "restricted"
        ? proposal.assessment
        : { kind: "public" },
      proposalId: confirmation.proposalId,
    };
  }
  const assessor = input.assessorFactory
    ? input.assessorFactory(input.runtimeScope)
    : input.assessor;
  if (!assessor) {
    return { plan: { kind: "public" }, proposalId: null };
  }

  let assessment: TurnVisibilityAssessment;
  try {
    assessment = await assessor.assess({
      playerText: input.input.content,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const diagnostic = diagnosticFromError(error, "visibility");
    throw new LocalRecordServiceError(
      "TURN_FAILED",
      formatTurnFailureMessage(diagnostic),
      undefined,
      undefined,
      diagnostic,
    );
  }
  if (assessment.visibility.kind === "public") {
    return { plan: assessment.visibility, proposalId: null };
  }
  const proposal = input.proposals.issue({
    scope: input.scope,
    canonicalVersion: input.canonicalVersion,
    content: input.input.content,
    assessment,
    audienceNames: runtimeActorNames(
      input.runtimeScope,
      assessment.visibility.audienceCharacterInstanceIds,
    ),
  });
  throw new LocalRecordServiceError(
    "VISIBILITY_CONFIRMATION_REQUIRED",
    "DM 判断这条内容可能只适合部分角色知道；请确认可见范围后再提交。",
    undefined,
    proposal,
  );
}

function runtimeActorNames(
  scope: RecordRuntimeScope,
  characterInstanceIds: readonly string[],
): readonly string[] {
  const actors = [scope.playerActor, ...scope.aiCharacters];
  return characterInstanceIds.map((id) =>
    actors.find((actor) => actor.characterInstanceId === id)?.displayName
    ?? "未知角色"
  );
}

export function diagnosticFromError(
  error: unknown,
  stage: LocalTurnFailureDiagnostic["stage"],
): LocalTurnFailureDiagnostic {
  if (error instanceof LocalRecordServiceError && error.diagnostic) {
    return error.diagnostic;
  }
  if (error instanceof RetryableTurnError) {
    return {
      stage,
      code: error.code,
      message: error.safeMessage,
      disposition: "retryable",
    };
  }
  if (error instanceof FatalTurnError) {
    return {
      stage,
      code: error.code,
      message: error.safeMessage,
      disposition: "failed",
    };
  }
  if (error instanceof RuntimeInvariantError) {
    return {
      stage,
      code: error.code,
      message: "运行时约束未满足；底层错误已脱敏。",
      disposition: "failed",
    };
  }
  return {
    stage,
    code: "TURN_STEP_FAILED",
    message: "该阶段没有返回可安全展示的结构化结果。",
    disposition: "failed",
  };
}

export function formatTurnFailureMessage(diagnostic: LocalTurnFailureDiagnostic): string {
  const labels: Record<LocalTurnFailureDiagnostic["stage"], string> = {
    visibility: "可见性判断",
    planning: "回合规划",
    drafting: "内容生成",
    validating: "结构化验证",
    releasing: "写入提交",
  };
  const attempt = diagnostic.attempt === undefined ? "" : `，第 ${diagnostic.attempt} 次尝试`;
  return `本轮在「${labels[diagnostic.stage]}」阶段未完成${attempt}（${diagnostic.code}）：${diagnostic.message}`;
}
