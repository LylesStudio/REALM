import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
  type LocalRecordService,
} from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

type CreateMessageBody = {
  content?: unknown;
  clientMessageId?: unknown;
  recordId?: unknown;
  writeToken?: unknown;
  actionSelection?: unknown;
  visibilityConfirmation?: unknown;
};

export async function POST(request: Request) {
  try {
    return await handleMessagePost(request, await getLocalRecordService());
  } catch (error) {
    return messageRouteError(error);
  }
}

export async function handleMessagePost(
  request: Request,
  service: LocalRecordService,
): Promise<Response> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RequestError("INVALID_BODY", "Request body must be an object.");
    }
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const input = parseMessage(
      parsed as CreateMessageBody,
      request.headers.get("Idempotency-Key"),
    );
    const result = await service.submitMessage({ ...input, principalId });
    return Response.json(
      { ok: true as const, ...result },
      {
        status: result.disposition === "committed" ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return messageRouteError(error);
  }
}

function parseMessage(
  body: CreateMessageBody,
  headerIdempotencyKey: string | null,
) {
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const clientMessageId =
    typeof body.clientMessageId === "string"
      ? body.clientMessageId.trim()
      : headerIdempotencyKey?.trim() ?? "";
  const recordId =
    typeof body.recordId === "string" && body.recordId.trim()
      ? body.recordId.trim()
      : LOCAL_RECORD_SCOPE.recordId;
  const writeToken =
    typeof body.writeToken === "string" ? body.writeToken.trim() : "";
  const actionSelection = parseActionSelection(body.actionSelection);
  const visibilityConfirmation = parseVisibilityConfirmation(
    body.visibilityConfirmation,
  );

  if (!content) throw new RequestError("INVALID_CONTENT", "content is required.");
  if (content.length > 2_000) {
    throw new RequestError(
      "INVALID_CONTENT",
      "content must be 2,000 characters or fewer.",
    );
  }
  if (!clientMessageId || clientMessageId.length > 128) {
    throw new RequestError(
      "INVALID_IDEMPOTENCY_KEY",
      "clientMessageId or Idempotency-Key is required and must be at most 128 characters.",
    );
  }
  if (!writeToken || writeToken.length > 256) {
    throw new RequestError(
      "INVALID_WRITE_TOKEN",
      "writeToken from the latest Record response is required.",
    );
  }

  return {
    content,
    idempotencyKey: clientMessageId,
    recordId,
    writeToken,
    ...(actionSelection ? { actionSelection } : {}),
    ...(visibilityConfirmation ? { visibilityConfirmation } : {}),
  };
}

function parseActionSelection(value: unknown): { affordanceId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("INVALID_ACTION_SELECTION", "actionSelection must be an object.");
  }
  const affordanceId = "affordanceId" in value && typeof value.affordanceId === "string"
    ? value.affordanceId.trim()
    : "";
  if (!affordanceId || affordanceId.length > 160) {
    throw new RequestError(
      "INVALID_ACTION_SELECTION",
      "actionSelection.affordanceId is required and must be at most 160 characters.",
    );
  }
  return { affordanceId };
}

function parseVisibilityConfirmation(
  value: unknown,
): { proposalId: string; decision: "public" | "restricted" } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      "INVALID_VISIBILITY_CONFIRMATION",
      "visibilityConfirmation must be an object.",
    );
  }
  const proposalId = "proposalId" in value && typeof value.proposalId === "string"
    ? value.proposalId.trim()
    : "";
  const decision = "decision" in value ? value.decision : undefined;
  if (
    !proposalId
    || proposalId.length > 160
    || (decision !== "public" && decision !== "restricted")
  ) {
    throw new RequestError(
      "INVALID_VISIBILITY_CONFIRMATION",
      "visibilityConfirmation requires a proposalId and a public/restricted decision.",
    );
  }
  return { proposalId, decision };
}

class RequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

function messageRouteError(error: unknown): Response {
  if (error instanceof SyntaxError) {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
      },
      { status: 400 },
    );
  }
  if (error instanceof RequestError) {
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status: 400 },
    );
  }
  if (error instanceof LocalRecordServiceError) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "INVALID_ACTION_SELECTION"
        ? 400
      : error.code === "VISIBILITY_CONFIRMATION_REQUIRED"
        ? 428
      : error.code === "INVALID_VISIBILITY_CONFIRMATION"
        ? 409
      : error.code === "LOCAL_RUNTIME_NOT_INITIALIZED"
        ? 503
        : error.code === "TURN_FAILED"
          ? 422
          : 409;
    return Response.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          ...(error.currentVersion === undefined
            ? {}
            : { currentVersion: error.currentVersion }),
        },
        ...(error.visibilityProposal
          ? { visibilityProposal: error.visibilityProposal }
          : {}),
      },
      { status },
    );
  }

  return Response.json(
    {
      ok: false as const,
      error: {
        code: "INTERNAL_ERROR",
        message: "The local runtime could not complete this request.",
      },
    },
    { status: 500 },
  );
}
