/**
 * GET /api/record/goals/events?recordId=... — Goal projection SSE.
 *
 * PostgreSQL NOTIFY is only a wakeup. The transition ledger and the latest
 * content-bound projection are reread on every wake, with Last-Event-ID replay.
 */
import {
  createGoalProjectionStream,
} from "../../../../../modules/goals/projection-stream.ts";
import { loadRecordGoalProjection } from "../../../../../modules/application/record-goal-projection.ts";
import { RuntimeInvariantError } from "../../../../../modules/runtime/public.ts";
import {
  createPostgresGoalProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  GoalProjectionRepositoryError,
} from "../../../../../database/postgres/public.ts";
import { listenRecordCommitted } from "../../../../../database/postgres/record-events.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import { LOCAL_WORLD_VERSION } from "../../../../../modules/world-transfer/realm-save.ts";
import { resolveBaseGoalDefinition } from "../../../../../modules/world-transfer/base-content.ts";
import { getSharedRuntimePool, resolveMembershipRole } from "../../../world-scope.ts";
import {
  createProjectionDefinitionResolver,
} from "../route.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../../auth-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const url = new URL(request.url);
  const recordId = url.searchParams.get("recordId");
  if (!recordId || recordId.trim() !== recordId || recordId.length === 0) {
    return jsonError("INVALID_REQUEST", "recordId is required.", 400);
  }
  const cursorValue = request.headers.get("Last-Event-ID") ?? url.searchParams.get("afterOrdinal") ?? "0";
  if (!/^\d+$/.test(cursorValue)) {
    return jsonError("INVALID_CURSOR", "afterOrdinal must be a non-negative integer.", 400);
  }
  const initialCursor = Number(cursorValue);
  if (!Number.isSafeInteger(initialCursor)) {
    return jsonError("INVALID_CURSOR", "afterOrdinal is outside the safe range.", 400);
  }
  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl || !isLoopbackPostgresUrl(runtimeUrl)) {
    return jsonError(
      "LOCAL_RUNTIME_NOT_INITIALIZED",
      "The Goal projection stream requires the local PostgreSQL runtime.",
      503,
    );
  }

  let wakeup: Awaited<ReturnType<typeof listenRecordCommitted>> | undefined;
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
    const repository = createPostgresGoalProjectionRepository(pool);
    const installedResolver = await createProjectionDefinitionResolver();
    const load = async () => {
      // A stream is not a permanent authorization grant: recheck before every publication.
      const currentPrincipalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
      if (!currentPrincipalId) throw new RuntimeInvariantError("UNAUTHENTICATED", "Authentication is required.");
      const currentScope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({
        ...LOCAL_RECORD_SCOPE, principalId: currentPrincipalId, recordId,
      });
      if (!currentScope) throw new RuntimeInvariantError("NOT_FOUND", "Record not found.");
      if (!await resolveMembershipRole(pool, { workspaceId: currentScope.workspaceId, worldId: currentScope.worldId, principalId: currentPrincipalId })) {
        throw new RuntimeInvariantError("NOT_FOUND", "Record not found.");
      }
      return loadRecordGoalProjection(pool, { scope: currentScope,
        resolveContentDefinition: async (binding) => {
          const resolver = installedResolver ?? (binding.worldVersion === LOCAL_WORLD_VERSION ? resolveBaseGoalDefinition : null);
          if (!resolver) throw new RuntimeInvariantError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.");
          return resolver(binding);
        },
      });
    };
    // LISTEN is established before the initial load so a committed transition
    // cannot fall between the first snapshot and the wakeup subscription.
    wakeup = await listenRecordCommitted(runtimeUrl, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId,
    });
    await load();
    const body = createGoalProjectionStream({
      recordId,
      initialCursor,
      signal: request.signal,
      load,
      listGoalTransitionOrdinalsAfter: (cursor) => repository.listGoalTransitionOrdinalsAfter({
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        recordId,
        cursor,
      }),
      waitForWakeup: () => wakeup!.wait(),
      closeWakeup: () => wakeup!.close(),
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (wakeup) await wakeup.close().catch(() => undefined);
    if (error instanceof RuntimeInvariantError && ["UNAUTHENTICATED", "NOT_FOUND"].includes(error.code)) {
      return jsonError(error.code, error.code === "NOT_FOUND" ? "Record not found." : "Authentication is required.", error.code === "NOT_FOUND" ? 404 : 401);
    }
    if (error instanceof RuntimeInvariantError && ["GOAL_CONTENT_UNAVAILABLE", "GOAL_DEFINITION_UNAVAILABLE", "GOAL_DEFINITION_INVALID"].includes(error.code)) {
      return jsonError(error.code, "Goal definition is unavailable.", 503);
    }
    if (error instanceof GoalProjectionRepositoryError) {
      return jsonError(error.code, "Goal projection could not be read.", 500);
    }
    if (error instanceof Error && error.message === "GOAL_CONTENT_UNAVAILABLE") {
      return jsonError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.", 503);
    }
    if (error instanceof Error && error.message === "GOAL_DEFINITION_UNAVAILABLE") {
      return jsonError("GOAL_DEFINITION_UNAVAILABLE", "Goal content is unavailable.", 503);
    }
    return jsonError("GOAL_PROJECTION_STREAM_FAILED", "Goal projection stream could not be opened.", 500);
  }
}

function isLoopbackPostgresUrl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return false;
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}
