import {
  toFinanceSummaryEnvelope,
} from "../../../../../../modules/application/project-finance-api-v1.ts";
import {
  createProjectFinanceReadService,
} from "../../../../../../modules/application/project-finance-read.ts";
import {
  createPostgresWorkbenchProjection,
} from "../../../../../../database/postgres/workbench-projection.ts";
import {
  projectFinanceRouteError,
  resolveProjectFinanceContext,
} from "../../project-finance-context.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await resolveProjectFinanceContext(request);
    const service = createProjectFinanceReadService({
      projection: createPostgresWorkbenchProjection(context.database),
    });
    const snapshot = await service.loadWorkbench(context.scope);
    return Response.json(toFinanceSummaryEnvelope(snapshot), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return projectFinanceRouteError(error);
  }
}
