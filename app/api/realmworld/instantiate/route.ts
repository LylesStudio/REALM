import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../../../../modules/application/library-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  createInstalledRealmWorldInstantiationResolver,
  RealmWorldRuntimeContentError,
} from "../../../../modules/world-transfer/realmworld-runtime-content.ts";
import { readRealmWorldVerifier } from "../env.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  sessionProofFromRequest,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new RequestError("INVALID_REQUEST", `${field} is invalid.`);
  }
  return value;
}

function parseLocale(value: unknown): string {
  if (value === undefined) return "zh-CN";
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 32
    || value.trim() !== value
    || !/^[A-Za-z0-9-]+$/.test(value)
  ) {
    throw new RequestError("INVALID_REQUEST", "locale is invalid.");
  }
  return value;
}

class RequestError extends Error {
  readonly code: "INVALID_REQUEST";

  constructor(code: "INVALID_REQUEST", message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}



export async function POST(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return errorResponse("INVALID_IDEMPOTENCY_KEY", "idempotency-key is required.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "A JSON request body is required.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("INVALID_REQUEST", "The request body is invalid.", 400);
  }

  let worldId: string;
  let worldVersion: string;
  let locale: string;
  try {
    const input = body as Record<string, unknown>;
    worldId = requiredIdentity(input.worldId, "worldId");
    worldVersion = requiredIdentity(input.worldVersion, "worldVersion");
    locale = parseLocale(input.locale);
  } catch (error) {
    if (error instanceof RequestError) return errorResponse(error.code, error.message, 400);
    return errorResponse("INVALID_REQUEST", "The request body is invalid.", 400);
  }

  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl) {
    return errorResponse("RUNTIME_NOT_PROVISIONED", "The runtime database is not provisioned.", 503);
  }
  const verifier = await readRealmWorldVerifier();
  if (!verifier) {
    return errorResponse("REALMWORLD_CONTENT_UNAVAILABLE", "RealmWorld content is not installed or trusted.", 503);
  }

  try {
    const resolver = createInstalledRealmWorldInstantiationResolver({
      installRoot: verifier.installRoot,
      verifySignature: verifier.verifySignature,
      locale,
    });
    const plan = await resolver({ kind: "world", worldId, worldVersion });
    if (!plan) {
      return errorResponse("REALMWORLD_CONTENT_UNAVAILABLE", "RealmWorld content is unavailable.", 503);
    }
    const service = createPostgresLibraryService(getSharedRuntimePool(runtimeUrl));
    const result = await service.instantiateRealmWorld(
      {
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        principalId,
        sessionProof: sessionProofFromRequest(request) ?? "",
      },
      plan,
      idempotencyKey,
    );
    return Response.json(
      { ok: true as const, ...result },
      {
        status: result.replayed ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof RealmWorldRuntimeContentError) {
      if (error.code === "RUNTIME_IDENTITY_MISMATCH") {
        return errorResponse("REALMWORLD_IDENTITY_MISMATCH", "RealmWorld identity does not match the requested binding.", 409);
      }
      if (error.code === "RUNTIME_INVALID") {
        return errorResponse("REALMWORLD_CONTENT_INVALID", "RealmWorld content is invalid.", 422);
      }
      return errorResponse("REALMWORLD_CONTENT_UNAVAILABLE", "RealmWorld content is unavailable.", 503);
    }
    if (error instanceof LibraryServiceError) {
      if (error.code === "REALMWORLD_IDENTITY_CONFLICT" || error.code === "REALMWORLD_INSTANCE_CONFLICT") {
        return errorResponse(error.code, "RealmWorld instance identity conflicts with persisted runtime state.", 409);
      }
      if (error.code === "WORLD_ARCHIVED") {
        return errorResponse(error.code, "The target world is archived.", 409);
      }
      if (error.code === "INVALID_COMMAND") {
        return errorResponse(error.code, "The RealmWorld request is invalid.", 400);
      }
    }
    return errorResponse("REALMWORLD_INSTANTIATION_FAILED", "RealmWorld instantiation failed.", 500);
  }
}
