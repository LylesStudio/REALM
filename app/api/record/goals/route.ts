/**
 * GET /api/record/goals?recordId=... — player-safe Goal projection.
 *
 * Runtime evidence, assessment jobs and Judge output never cross this boundary.
 * Definitions are resolved from the exact installed RealmWorld identity before
 * visibility is applied.
 */
import { readFile } from "node:fs/promises";
import {
  createPostgresGoalProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  GoalProjectionRepositoryError,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { projectGoal } from "../../../../modules/goals/projection.ts";
import {
  createInstalledRealmWorldDefinitionResolver,
  RealmWorldDefinitionResolutionError,
} from "../../../../modules/world-transfer/realmworld-definition-resolver.ts";
import { LOCAL_WORLD_VERSION } from "../../../../modules/world-transfer/realm-save.ts";
import { resolveBaseGoalDefinition } from "../../../../modules/world-transfer/base-content.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreDocument,
  validateRealmWorldTrustStoreDocument,
  type RealmWorldTrustStoreDocumentV1,
} from "../../../../modules/world-transfer/realmworld-signature.ts";
import { resolveEngineBaseActiveVersion } from "../../../../modules/world-transfer/realmworld-trust-store.ts";
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
    const projection = await createPostgresGoalProjectionRepository(pool).load({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId,
    });
    if (projection.instances.length === 0) {
      return Response.json(
        { ok: true as const, recordId, goals: [] },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    const resolver = await createProjectionDefinitionResolver()
      ?? (projection.worldVersion === LOCAL_WORLD_VERSION ? resolveBaseGoalDefinition : null);
    if (!resolver) {
      return jsonError(
        "GOAL_CONTENT_UNAVAILABLE",
        "Goal content is not installed for this runtime.",
        503,
      );
    }
    const goals = [];
    for (const instance of projection.instances) {
      const definition = await resolver({
        worldId: projection.worldId,
        worldVersion: projection.worldVersion,
        goalKey: instance.goalKey,
      });
      if (!definition) {
        return jsonError("GOAL_DEFINITION_UNAVAILABLE", "Goal content is unavailable.", 503);
      }
      const projected = projectGoal({ definition, instance });
      if (projected) goals.push(projected);
    }
    return Response.json(
      { ok: true as const, recordId, goals },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GoalProjectionRepositoryError) {
      return jsonError(error.code, "Goal projection could not be read.", 500);
    }
    if (error instanceof RealmWorldDefinitionResolutionError) {
      return jsonError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.", 503);
    }
    return jsonError("GOAL_PROJECTION_FAILED", "Goal projection could not be created.", 500);
  }
}

export async function createProjectionDefinitionResolver() {
  const installRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const trustStorePath = process.env.REALM_REALMWORLD_TRUST_STORE;
  if (!installRoot || !trustStorePath) return null;
  let document: unknown;
  try {
    document = JSON.parse(await readFile(trustStorePath, "utf8"));
  } catch {
    return null;
  }
  let verifySignature;
  let engineBaseVersion;
  try {
    const validDocument = validateRealmWorldTrustStoreDocument(
      document as RealmWorldTrustStoreDocumentV1,
    );
    verifySignature = createRealmWorldSignatureVerifierFromTrustStoreDocument({
      document: validDocument,
      now: new Date(),
    });
    engineBaseVersion = resolveEngineBaseActiveVersion(validDocument);
  } catch {
    return null;
  }
  return createInstalledRealmWorldDefinitionResolver({
    installRoot,
    verifySignature,
    baseResolver: resolveBaseGoalDefinition,
    engineBaseVersion,
  });
}
