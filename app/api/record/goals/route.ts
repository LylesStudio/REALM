/**
 * GET /api/record/goals?recordId=... — player-safe Goal projection.
 *
 * Runtime evidence, assessment jobs and Judge output never cross this boundary.
 * Definitions are resolved from the exact installed RealmWorld identity before
 * visibility is applied.
 */
import { createProjectionDefinitionResolver } from "../../../../modules/application/record-goal-content.ts";
export { createProjectionDefinitionResolver } from "../../../../modules/application/record-goal-content.ts";
import {
  createPostgresRecordRuntimeScopeRepository,
  GoalProjectionRepositoryError,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool, resolveMembershipRole } from "../../world-scope.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { loadRecordGoalProjection } from "../../../../modules/application/record-goal-projection.ts";
import { RuntimeInvariantError } from "../../../../modules/runtime/public.ts";
import {
  RealmWorldDefinitionResolutionError,
} from "../../../../modules/world-transfer/realmworld-definition-resolver.ts";
import { LOCAL_WORLD_VERSION } from "../../../../modules/world-transfer/realm-save.ts";
import { resolveBaseGoalDefinition } from "../../../../modules/world-transfer/base-content.ts";

import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const recordId = new URL(request.url).searchParams.get("recordId");
  if (!recordId || recordId.trim() !== recordId || recordId.length === 0) {
    return jsonError("INVALID_REQUEST", "recordId is required.", 400);
  }
  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl) return jsonError("RUNTIME_NOT_PROVISIONED", "The runtime database is not provisioned.", 503);
  try {
    const pool = getSharedRuntimePool(runtimeUrl);
    const scope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId,
    });
    if (!scope) return jsonError("NOT_FOUND", "Record not found.", 404);
    if (!await resolveMembershipRole(pool, { workspaceId: scope.workspaceId, worldId: scope.worldId, principalId })) {
      return jsonError("NOT_FOUND", "Record not found.", 404);
    }
    const installedResolver = await createProjectionDefinitionResolver();
    const { goals } = await loadRecordGoalProjection(pool, { scope,
      resolveContentDefinition: async (binding) => {
        const resolver = installedResolver ?? (binding.worldVersion === LOCAL_WORLD_VERSION ? resolveBaseGoalDefinition : null);
        if (!resolver) throw new RuntimeInvariantError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.");
        return resolver(binding);
      },
    });
    return Response.json(
      { ok: true as const, recordId, goals },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RuntimeInvariantError && ["GOAL_CONTENT_UNAVAILABLE", "GOAL_DEFINITION_UNAVAILABLE", "GOAL_DEFINITION_INVALID"].includes(error.code)) {
      return jsonError(error.code, "Goal definition is unavailable.", 503);
    }
    if (error instanceof GoalProjectionRepositoryError) {
      return jsonError(error.code, "Goal projection could not be read.", 500);
    }
    if (error instanceof RealmWorldDefinitionResolutionError) {
      return jsonError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.", 503);
    }
    return jsonError("GOAL_PROJECTION_FAILED", "Goal projection could not be created.", 500);
  }
}
