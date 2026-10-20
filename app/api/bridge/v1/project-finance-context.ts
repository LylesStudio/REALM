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
  StoryGraphRepositoryError,
  type StoryGraphRepositoryErrorCode,
} from "../../../../database/postgres/story-graph-repository.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveBridgeWorldScopeForMember,
  type BridgeWorldScopeAccess,
} from "../../world-scope.ts";
import type { PoolClient } from "pg";
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
  principalId: string;
}

/**
 * F1a：读写分离。读路由缺省 access="read" 保持既有省略 worldlineId 的
 * 行为；三条命令路由必须显式传 access="write"——observer 403、非成员 404、
 * 匿名 401，写缺省选择只在可写世界线恰好一条时成立，多条必须显式
 * worldlineId（SCOPE_REQUIRED），绝不静默写入最早世界线。
 * 命令回调还必须在同一 outer transaction 内调用 authorizeProjectFinanceWrite。
 */
export async function resolveProjectFinanceContext(
  request: Request,
  options?: { access?: BridgeWorldScopeAccess },
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
  const worldlineId = optionalBoundedQueryIdentifier(
    url.searchParams.get("worldlineId"),
    "worldlineId",
  );
  const database = getSharedRuntimePool(connectionString);
  const resolution = await resolveBridgeWorldScopeForMember(database, {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId,
    worldId,
    worldlineId,
    access: options?.access ?? "read",
  });
  if (resolution.status === "ok") {
    return { database, scope: resolution.scope, principalId };
  }
  if (resolution.status === "forbidden") {
    throw new ProjectFinanceRouteError(
      "FORBIDDEN",
      "当前角色只有读取权限，不能提交写入命令。",
      403,
    );
  }
  if (resolution.status === "scope_required") {
    throw new ProjectFinanceRouteError(
      "SCOPE_REQUIRED",
      "这个世界存在多条可写世界线，请显式指定 worldlineId。",
      409,
    );
  }
  if (resolution.status === "not_writable") {
    throw new ProjectFinanceRouteError(
      "WORLDLINE_NOT_WRITABLE",
      "目标世界线已冻结或归档，不能写入。",
      409,
    );
  }
  throw new ProjectFinanceRouteError(
    "WORLD_NOT_FOUND",
    "世界不存在或当前用户无权访问。",
    404,
  );
}

/** World → membership → worldline; separate statements define acquisition order.
 * The principal comes only from resolveRequestPrincipal, never request body/query.
 * Keep locks through the command AND Story continuation outer COMMIT/ROLLBACK.
 */
export async function authorizeProjectFinanceWrite(
  client: PoolClient,
  context: Pick<ProjectFinanceRequestContext, "scope" | "principalId">,
): Promise<void> {
  const { workspaceId, worldId, worldlineId } = context.scope;
  const world = await client.query<{ status: string }>(
    `SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE`,
    [workspaceId, worldId],
  );
  if (!world.rows[0]) throw new ProjectFinanceRouteError("WORLD_NOT_FOUND", "世界不存在。", 404);
  if (world.rows[0].status !== "active") throw new ProjectFinanceRouteError("WORLD_ARCHIVED", "世界已归档。", 409);
  const membership = await client.query<{ role: string | null }>(
    `SELECT public.bridge_command_membership_role($1, $2, $3) AS role`,
    [workspaceId, worldId, context.principalId],
  );
  const role = membership.rows[0]?.role;
  if (!role) throw new ProjectFinanceRouteError("WORLD_NOT_FOUND", "世界不存在或当前用户无权访问。", 404);
  if (role !== "owner" && role !== "player") throw new ProjectFinanceRouteError("FORBIDDEN", "当前角色只有读取权限。", 403);
  const line = await client.query<{ status: string }>(
    `SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE`,
    [workspaceId, worldId, worldlineId],
  );
  if (!line.rows[0]) throw new ProjectFinanceRouteError("WORLD_NOT_FOUND", "世界线不存在。", 404);
  if (line.rows[0].status !== "active") throw new ProjectFinanceRouteError("WORLDLINE_NOT_WRITABLE", "世界线不可写。", 409);
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
  if (error instanceof StoryGraphRepositoryError) {
    return Response.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: safeStoryErrorMessage(error.code),
        },
      },
      {
        status: storyErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" },
      },
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

function optionalBoundedQueryIdentifier(
  value: string | null,
  field: string,
): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
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
  if (code === "BUSINESS_POLICY_MISSING") return 422;
  if (code === "BUSINESS_PRECONDITION_FAILED") return 409;
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
  if (code === "BUSINESS_POLICY_MISSING") return "业务政策不可用。";
  if (code === "BUSINESS_PRECONDITION_FAILED") return "业务前提未满足。";
  if (code === "AMOUNT_INVALID" || code === "COMMAND_INVALID" || code === "DATE_INVALID") return "命令参数无效。";
  return "暂时无法提交财务命令。";
}

function storyErrorStatus(code: StoryGraphRepositoryErrorCode): number {
  if (code === "STORY_NOT_FOUND") return 404;
  return 503;
}

function safeStoryErrorMessage(code: StoryGraphRepositoryErrorCode): string {
  if (code === "STORY_DEFINITION_NOT_FOUND") {
    return "这个故事缺少服务端持久化的定义绑定，暂时无法继续剧情。";
  }
  if (code === "STORY_DEFINITION_CONFLICT") {
    return "故事定义与已持久化的内容冲突，暂时无法继续剧情。";
  }
  if (code === "STORY_NOT_WRITABLE") {
    return "这个故事当前不可写，暂时无法继续剧情。";
  }
  return "暂时无法继续故事剧情。";
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
