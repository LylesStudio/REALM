import {
  createPostgresWorldKnowledgeRepository,
} from "../../../../database/postgres/public.ts";
import { createWorldKnowledgeService } from "../../../../modules/world-knowledge/public.ts";
import { classifyWorldlineConflict } from "../../../../modules/worldline/branching.ts";
import {
  detectCausalConflicts,
  type CausalChange,
} from "../../../../modules/worldline/conflict-detection.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { logRouteInternalError } from "../../route-observability.ts";

export const runtime = "nodejs";

/**
 * M5 世界线冲突预判。双分支（批次 T10-B2）：
 * - legacy（无 mode 字段）：classifyWorldlineConflict 纯游标分类，零改动；
 * - causal（mode="causal"）：detectCausalConflicts 三层因果检测——
 *   claims/edges 只从解析出的 WorldScope 读库（客户端无法注入事实），
 *   changeSet 严格解析，只读零写库。
 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalid();
    }
    const body = parsed as Record<string, unknown>;
    if (body.mode === "causal") {
      return await causalPreview(body, principalId);
    }
    const pastChange = parseCursor(body.pastChange);
    const existingFuture = parseCursor(body.existingFuture);
    if (!pastChange || !existingFuture) return invalid();
    const result = classifyWorldlineConflict({
      pastChange,
      existingFuture,
      hardCausalAnchors: stringArray(body.hardCausalAnchors),
      softContinuityAnchors: stringArray(body.softContinuityAnchors),
    });
    return Response.json(
      { ok: true as const, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CausalInputError) return invalid(error.message);
    return invalid();
  }
}

export class CausalInputError extends Error {}

/**
 * causal 预览分支：membership 校验 + DB 事实读取 + 确定性检测。
 * 零写库；读失败返回安全 500，绝不返回半真报告。
 */
async function causalPreview(
  body: Record<string, unknown>,
  principalId: string,
): Promise<Response> {
  const worldId = typeof body.worldId === "string" ? body.worldId.trim() : "";
  if (!worldId) throw new CausalInputError("worldId is required.");
  const existingFuture = parseCursor(body.existingFuture);
  if (!existingFuture) throw new CausalInputError("existingFuture is required.");
  const changeSet = parseChangeSet(body.changeSet);

  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const pool = getSharedRuntimePool(connectionString);
    const scope = await resolveWorldScopeForMember(pool, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(pool),
    );
    const [existingClaims, causalEdges] = await Promise.all([
      knowledge.listClaims(scope),
      knowledge.listCausalEdges(scope),
    ]);
    const report = detectCausalConflicts({
      changeSet,
      existingClaims,
      causalEdges,
      existingFutureCursor: existingFuture,
    });
    return Response.json(
      {
        ok: true as const,
        mode: "causal" as const,
        scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
        algorithm: "realm-causal-conflict/v1",
        report,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // 批次 T10-B3：读库/内部失败脱敏结构化诊断（500 契约不变）。
    logRouteInternalError({
      route: "worldline/conflict",
      stage: "causal-preview",
      error,
    });
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}

const CAUSAL_CHANGE_KINDS = new Set(["assert", "terminate", "supersede"]);

export function parseChangeSet(value: unknown): { changes: readonly CausalChange[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CausalInputError("changeSet must be an object.");
  }
  const changes = (value as Record<string, unknown>).changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new CausalInputError("changeSet.changes must be a non-empty array.");
  }
  return { changes: changes.map(parseChange) };
}

function parseChange(value: unknown): CausalChange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CausalInputError("change must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!CAUSAL_CHANGE_KINDS.has(kind)) {
    throw new CausalInputError("change.kind must be assert/terminate/supersede.");
  }
  const subjectEntityId = parseText(raw.subjectEntityId, 160, "subjectEntityId");
  const predicate = parseText(raw.predicate, 120, "predicate");
  const objectValue = typeof raw.objectValue === "string"
    ? raw.objectValue.trim().slice(0, 160)
    : "";
  const targetClaimId = raw.targetClaimId === undefined
    || raw.targetClaimId === null
    ? undefined
    : parseText(raw.targetClaimId, 160, "targetClaimId");
  if (
    (kind === "terminate" || kind === "supersede")
    && !targetClaimId
  ) {
    throw new CausalInputError(
      "terminate/supersede changes require targetClaimId.",
    );
  }
  const effectiveCursor = parseCursor(raw.effectiveCursor);
  if (!effectiveCursor) {
    throw new CausalInputError("change.effectiveCursor is required.");
  }
  return {
    kind: kind as CausalChange["kind"],
    subjectEntityId,
    predicate,
    objectValue,
    ...(targetClaimId ? { targetClaimId } : {}),
    effectiveCursor,
  };
}

function parseText(value: unknown, maxLength: number, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > maxLength
  ) {
    throw new CausalInputError(`${field} is required and too long.`);
  }
  return value.trim();
}

export function parseCursor(value: unknown) {
  if (value === null || typeof value !== "object") return null;
  const cursor = value as Record<string, unknown>;
  const tick = typeof cursor.tick === "number" ? cursor.tick : Number(cursor.tick);
  const ordinal = typeof cursor.ordinal === "number" ? cursor.ordinal : Number(cursor.ordinal);
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(ordinal)) return null;
  return {
    tick,
    ordinal,
    calendarId: typeof cursor.calendarId === "string" ? cursor.calendarId : "native",
    display: typeof cursor.display === "string" ? cursor.display : "",
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function invalid(message = "Invalid conflict preview input."): Response {
  return Response.json(
    { ok: false as const, error: { code: "INVALID_CONFLICT_INPUT", message } },
    { status: 400 },
  );
}
