import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  ProjectFinanceReadError,
  type ProjectFinanceReadErrorCode,
} from "../../../../modules/application/project-finance-read.ts";
import { ProjectFinanceCommandError } from "../../../../modules/application/project-finance-command.ts";
import { ProjectFinanceError } from "../../../../modules/projects/public.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../world-scope.ts";
import type { WorkspaceDatabase } from "../../../../database/postgres/workspace-transaction.ts";
import type { ProjectScope } from "../../../../modules/projects/public.ts";

export class ProjectFinanceRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ProjectFinanceRouteError";
    this.code = code;
    this.status = status;
  }
}

export interface ProjectFinanceRequestContext {
  database: WorkspaceDatabase;
  scope: ProjectScope;
}

export async function resolveProjectFinanceContext(
  request: Request,
): Promise<ProjectFinanceRequestContext> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) {
    throw new ProjectFinanceRouteError("UNAUTHORIZED", "需要登录。", 401);
  }
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    throw new ProjectFinanceRouteError(
      "LOCAL_RUNTIME_NOT_INITIALIZED",
      "本机运行库未配置，暂时无法读取工作台。",
      503,
    );
  }
  const url = new URL(request.url);
  const worldId = boundedQueryIdentifier(url.searchParams.get("worldId"), "worldId");
  const database = getSharedRuntimePool(connectionString);
  const scope = await resolveWorldScopeForMember(database, {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId,
    worldId,
  });
  if (!scope) {
    throw new ProjectFinanceRouteError(
      "WORLD_NOT_FOUND",
      "世界不存在或当前用户无权访问。",
      404,
    );
  }
  return { database, scope };
}

export function projectFinanceRouteError(error: unknown): Response {
  if (error instanceof ProjectFinanceRouteError) {
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ProjectFinanceCommandError || error instanceof ProjectFinanceError) {
    return Response.json(
      { ok: false as const, error: { code: error.code, message: safeCommandMessage(error.code) } },
      { status: commandErrorStatus(error.code), headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ProjectFinanceReadError) {
    return Response.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: safeReadErrorMessage(error.code),
        },
      },
      {
        status: readErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return Response.json(
    {
      ok: false as const,
      error: {
        code: "PROJECT_FINANCE_READ_FAILED",
        message: "暂时无法读取项目与财务数据。",
      },
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function unauthorizedProjectFinanceResponse(): Response {
  return unauthorizedResponse();
}

function boundedQueryIdentifier(value: string | null, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 256) {
    throw new ProjectFinanceRouteError(
      "INVALID_REQUEST",
      `${field} 参数无效。`,
      400,
    );
  }
  return normalized;
}

function commandErrorStatus(code: string): number {
  if (code === "WRITE_CONFLICT" || code === "INSUFFICIENT_FUNDS" || code === "IDEMPOTENCY_KEY_REUSE" || code === "MILESTONE_NOT_OPEN" || code === "PROJECT_NOT_ACTIVE" || code === "OBLIGATION_NOT_OPEN") return 409;
  if (code === "FINANCE_ACCOUNT_NOT_FOUND" || code === "PROJECT_NOT_FOUND" || code === "MILESTONE_NOT_FOUND" || code === "OBLIGATION_NOT_FOUND") return 404;
  if (code === "AMOUNT_INVALID" || code === "COMMAND_INVALID" || code === "DATE_INVALID") return 422;
  return 400;
}

function safeCommandMessage(code: string): string {
  if (code === "WRITE_CONFLICT") return "状态已更新，请重新读取后重试。";
  if (code === "INSUFFICIENT_FUNDS") return "可用余额不足，没有记录这笔账。";
  if (code === "PROJECT_NOT_FOUND") return "项目不存在。";
  if (code === "MILESTONE_NOT_FOUND") return "里程碑不存在。";
  if (code === "MILESTONE_NOT_OPEN") return "这个里程碑现在不能确认。";
  if (code === "PROJECT_NOT_ACTIVE") return "项目当前不能接受这次写入。";
  if (code === "IDEMPOTENCY_KEY_REUSE") return "这个幂等键已经用于另一条命令。";
  if (code === "FINANCE_ACCOUNT_NOT_FOUND") return "财务账户不存在。";
  if (code === "OBLIGATION_NOT_FOUND") return "筹资义务不存在。";
  if (code === "OBLIGATION_NOT_OPEN") return "这笔义务现在不能结算。";
  if (code === "AMOUNT_INVALID" || code === "COMMAND_INVALID" || code === "DATE_INVALID") return "命令参数无效。";
  return "暂时无法提交财务命令。";
}

function readErrorStatus(code: ProjectFinanceReadErrorCode): number {
  if (code === "INVALID_REQUEST" || code === "SCOPE_INVALID" || code === "CURSOR_INVALID") return 400;
  if (code === "PROJECT_NOT_FOUND" || code === "FINANCE_NOT_FOUND") return 404;
  return 503;
}

function safeReadErrorMessage(code: ProjectFinanceReadErrorCode): string {
  if (code === "INVALID_REQUEST") return "请求参数无效。";
  if (code === "SCOPE_INVALID") return "世界作用域无效。";
  if (code === "CURSOR_INVALID") return "账本游标无效。";
  if (code === "PROJECT_NOT_FOUND") return "项目不存在。";
  if (code === "FINANCE_NOT_FOUND") return "财务数据不存在。";
  return "暂时无法读取项目与财务数据。";
}
