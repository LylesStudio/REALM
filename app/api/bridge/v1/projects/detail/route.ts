import {
  toProjectDetailApi,
} from "../../../../../../modules/application/project-finance-api-v1.ts";
import {
  createProjectFinanceReadService,
} from "../../../../../../modules/application/project-finance-read.ts";
import {
  createPostgresWorkbenchProjection,
} from "../../../../../../database/postgres/workbench-projection.ts";
import {
  projectFinanceRouteError,
  ProjectFinanceRouteError,
  resolveProjectFinanceContext,
} from "../../project-finance-context.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await resolveProjectFinanceContext(request);
    const projectId = new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
    if (!projectId || projectId.length > 256) {
      throw new ProjectFinanceRouteError("INVALID_REQUEST", "projectId 参数无效。", 400);
    }
    const service = createProjectFinanceReadService({
      projection: createPostgresWorkbenchProjection(context.database),
    });
    const snapshot = await service.loadWorkbench(context.scope);
    const project = snapshot.projectDetails.get(projectId);
    if (!project) {
      throw new ProjectFinanceRouteError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    }
    return Response.json(toProjectDetailApi(snapshot, project), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return projectFinanceRouteError(error);
  }
}
