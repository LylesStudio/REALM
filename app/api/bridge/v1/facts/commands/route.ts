import { createPostgresCommittedFactCommandStore } from "../../../../../../database/postgres/committed-fact-command-repository.ts";
import {
  CommittedFactCommandError,
  createCommittedFactCommandService,
} from "../../../../../../modules/application/committed-fact-command.ts";
import {
  projectFinanceRouteError,
  resolveProjectFinanceContext,
} from "../../project-finance-context.ts";

export const runtime = "nodejs";

const MAX_TEXT = 256;

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await resolveProjectFinanceContext(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new CommittedFactCommandError("COMMAND_INVALID", "Idempotency-Key is required.");
    }
    const body = await readBody(request);
    const service = createCommittedFactCommandService({
      store: createPostgresCommittedFactCommandStore(context.database),
    });
    if (body.command === "adjust_inventory") {
      const result = await service.adjustInventory({
        scope: context.scope,
        recordId: requiredText(body.recordId, "recordId"),
        characterInstanceId: requiredText(body.characterInstanceId, "characterInstanceId"),
        assetDefinitionId: requiredText(body.assetDefinitionId, "assetDefinitionId"),
        delta: requiredInteger(body.delta, "delta"),
        sourceEventId: requiredText(body.sourceEventId, "sourceEventId"),
        expectedRevision: nonNegativeInteger(body.expectedRevision, "expectedRevision"),
        idempotencyKey,
        possession: body.possession,
        quantity: body.quantity,
        owned: body.owned,
      });
      return json(context.scope, result);
    }
    if (body.command === "grant_inventory") {
      const result = await service.grantInventory({
        scope: context.scope,
        recordId: requiredText(body.recordId, "recordId"),
        characterInstanceId: requiredText(body.characterInstanceId, "characterInstanceId"),
        assetDefinitionId: requiredText(body.assetDefinitionId, "assetDefinitionId"),
        quantity: requiredInteger(body.quantity, "quantity"),
        sourceEventId: requiredText(body.sourceEventId, "sourceEventId"),
        idempotencyKey,
        possession: body.possession,
        owned: body.owned,
        delta: body.delta,
      });
      return json(context.scope, result);
    }
    if (body.command === "revise_relationship") {
      const result = await service.reviseRelationship({
        scope: context.scope,
        subjectEntityKey: requiredText(body.subjectEntityKey, "subjectEntityKey"),
        objectEntityKey: requiredText(body.objectEntityKey, "objectEntityKey"),
        relationKind: requiredText(body.relationKind, "relationKind"),
        sourceEventId: requiredText(body.sourceEventId, "sourceEventId"),
        idempotencyKey,
        relationshipDelta: body.relationshipDelta,
        delta: body.delta,
        fidelity: body.fidelity,
        observerContinuityId: body.observerContinuityId,
        content: body.content,
      });
      return json(context.scope, result);
    }
    if (body.command === "record_performance_assessment") {
      const result = await service.recordPerformanceAssessment({
        scope: context.scope,
        recordId: requiredText(body.recordId, "recordId"),
        policyVersion: requiredText(body.policyVersion, "policyVersion"),
        evidenceEventIds: readEvidenceIds(body.evidenceEventIds),
        idempotencyKey,
        score: body.score,
        factors: body.factors,
        unlocked: body.unlocked,
        goalCompleted: body.goalCompleted,
        decision: body.decision,
        failed: body.failed,
      });
      return json(context.scope, result);
    }
    throw new CommittedFactCommandError("COMMAND_INVALID", "Unsupported fact command.");
  } catch (error) {
    if (error instanceof CommittedFactCommandError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: safeMessage(error.code) } },
        { status: statusFor(error.code), headers: { "Cache-Control": "no-store" } },
      );
    }
    return projectFinanceRouteError(error);
  }
}

function json(scope: { worldId: string; worldlineId: string }, data: unknown): Response {
  return Response.json({
    ok: true as const,
    data,
    meta: { worldId: scope.worldId, worldlineId: scope.worldlineId, projectionVersion: 1 },
  }, { headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CommittedFactCommandError("COMMAND_INVALID", "Command body must be JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "Command body must be an object.");
  }
  return body as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MAX_TEXT) {
    throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return value.trim();
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const integer = requiredInteger(value, field);
  if (integer < 0) throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  return integer;
}

function readEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "evidenceEventIds are invalid.");
  }
  return value.map((item) => requiredText(item, "evidenceEventIds"));
}

function statusFor(code: CommittedFactCommandError["code"]): number {
  if (code === "EVENT_NOT_FOUND" || code === "ASSET_NOT_FOUND") return 404;
  if (code === "WRITE_CONFLICT" || code === "IDEMPOTENCY_KEY_REUSE" || code === "INSUFFICIENT_QUANTITY" || code === "ASSET_ALREADY_HELD") return 409;
  if (code === "COMMAND_INVALID" || code === "FACTORS_MISSING") return 422;
  return 400;
}

function safeMessage(code: CommittedFactCommandError["code"]): string {
  if (code === "EVENT_NOT_FOUND") return "证据事件不存在。";
  if (code === "ASSET_NOT_FOUND") return "资产持有不存在。";
  if (code === "ASSET_ALREADY_HELD") return "这份持有已经存在，请改数量而不是重新授予。";
  if (code === "WRITE_CONFLICT") return "状态已更新，请重新读取后重试。";
  if (code === "IDEMPOTENCY_KEY_REUSE") return "这个幂等键已经用于另一条命令。";
  if (code === "INSUFFICIENT_QUANTITY") return "持有数量不足，没有改动库存。";
  if (code === "FACTORS_MISSING") return "演出证据里没有可计算的结构化因素。";
  if (code === "COMMAND_INVALID") return "命令参数无效。";
  return "暂时无法提交这条命令。";
}
