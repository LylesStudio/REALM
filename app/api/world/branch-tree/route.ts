import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { loadBranchTree } from "../../../../modules/application/branch-tree.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 分支树只读投影（BRANCH-TREE-RESEARCH P0）。
 * GET /api/world/branch-tree?worldId=…[&recordId=…]
 * worldId 必填；recordId 可选（声明当前 record，服务端校验归属后回显）。
 * 世界不存在/非成员 404；游标只来自服务端行，客户端不可注入时间事实。
 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const url = new URL(request.url);
  const worldId = url.searchParams.get("worldId")?.trim() ?? "";
  if (!worldId) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "worldId is required." } },
      { status: 400 },
    );
  }
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const tree = await loadBranchTree(getSharedRuntimePool(connectionString), {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId,
      currentRecordId: url.searchParams.get("recordId")?.trim() || undefined,
    });
    if (!tree) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: true as const, tree },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "BRANCH_TREE_FAILED", message: "暂时无法读取分支树，请稍后重试。" },
      },
      { status: 500 },
    );
  }
}
