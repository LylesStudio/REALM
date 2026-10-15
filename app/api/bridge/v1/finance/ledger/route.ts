import {
  toLedgerPageApi,
} from "../../../../../../modules/application/project-finance-api-v1.ts";
import {
  createProjectFinanceReadService,
  WORKBENCH_PROJECTION_VERSION,
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
    const params = new URL(request.url).searchParams;
    const rawLimit = params.get("limit");
    const rawProjectId = params.get("projectId");
    const rawDirection = params.get("direction");
    const rawCursor = params.get("cursor");
    const result = await createProjectFinanceReadService({
      projection: createPostgresWorkbenchProjection(context.database),
    }).loadLedger(context.scope, {
      projectId: rawProjectId ?? undefined,
      direction: rawDirection ?? undefined,
      after: rawCursor ?? undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    return Response.json(
      toLedgerPageApi(
        {
          scope: context.scope,
          readCursor: result.readCursor,
          projectionVersion: WORKBENCH_PROJECTION_VERSION,
        },
        result.page,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return projectFinanceRouteError(error);
  }
}
