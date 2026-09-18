import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
  type RecordBranchInput,
} from "../../../../modules/application/library-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 创建可玩分支（BRANCH-TREE-RESEARCH P1）。
 * POST /api/record/branch
 * body: {
 *   recordId: string,                    // 分叉来源 record（必填）
 *   fork?: { eventId } | { worldTick, worldOrdinal },  // 缺省 = 当前 head
 *   label?/storyTitle?/recordTitle?: string,
 *   idempotencyKey: string,              // 必填：重复提交/网络重试不重复建拓扑
 * }
 * 成功 201（幂等重放 200 + replayed:true）。
 */
function parseFork(body: Record<string, unknown>): RecordBranchInput["fork"] | "invalid" | undefined {
  if (body.fork === undefined || body.fork === null) return undefined;
  if (typeof body.fork !== "object") return "invalid";
  const fork = body.fork as Record<string, unknown>;
  if (typeof fork.eventId === "string" && fork.eventId.trim()) {
    return { eventId: fork.eventId.trim() };
  }
  if (typeof fork.worldTick === "number" && typeof fork.worldOrdinal === "number") {
    return { worldTick: fork.worldTick, worldOrdinal: fork.worldOrdinal };
  }
  return "invalid";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }
  const sourceRecordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const fork = parseFork(body);
  if (!sourceRecordId || !idempotencyKey || fork === "invalid") {
    return Response.json(
      {
        ok: false as const,
        error: {
          code: "INVALID_REQUEST",
          message: "recordId and idempotencyKey are required; fork must be an eventId or a world cursor.",
        },
      },
      { status: 400 },
    );
  }
  try {
    const service = createPostgresLibraryService(getSharedRuntimePool(connectionString));
    const result = await service.branchRecord(
      { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId },
      {
        sourceRecordId,
        fork,
        label: optionalText(body.label),
        storyTitle: optionalText(body.storyTitle),
        recordTitle: optionalText(body.recordTitle),
        idempotencyKey,
      },
    );
    return Response.json(
      { ok: true as const, ...result },
      {
        status: result.replayed ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof LibraryServiceError) {
      const status = error.code === "RECORD_NOT_FOUND" || error.code === "WORLD_NOT_FOUND"
        ? 404
        : error.code === "WORLD_READ_ONLY"
          ? 403
          : error.code === "INVALID_COMMAND"
            ? 400
            : 409; // RECORD_ARCHIVED / WORLD_ARCHIVED / INVALID_FORK 等状态冲突
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status },
      );
    }
    return Response.json(
      {
        ok: false as const,
        error: { code: "RECORD_BRANCH_FAILED", message: "无法创建分支，请稍后重试。" },
      },
      { status: 500 },
    );
  }
}
