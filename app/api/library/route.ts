import {
  LOCAL_RECORD_SCOPE,
} from "../../../modules/application/local-record-service.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
  type LibraryCreateCommand,
  type LibraryService,
} from "../../../modules/application/library-service.ts";

import { getSharedRuntimePool } from "../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../auth-context.ts";

export const runtime = "nodejs";

type LibraryRequest = {
  kind?: unknown;
  name?: unknown;
  era?: unknown;
  summary?: unknown;
  role?: unknown;
  worldId?: unknown;
  title?: unknown;
  premise?: unknown;
  storyId?: unknown;
  label?: unknown;
  /** branch 命令：分叉来源 record（空 worldline 幽灵路径已废弃）。 */
  sourceRecordId?: unknown;
  style?: unknown;
  retrospection?: unknown;
  mergeTargetRecordId?: unknown;
  /** 批次 S：character 命令——同事务装配进该记录阵容。 */
  attachRecordId?: unknown;
  /** 批次 S：player-stance 命令——入局 / 观察者。 */
  stance?: unknown;
  /** 批次 T6：attach-character 命令——既有角色挂入既有记录。 */
  recordId?: unknown;
  /** 批次 T8：world-archive 命令——归档/恢复。 */
  archived?: unknown;
  definitionId?: unknown;
};

export async function GET(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const service = await getLibraryService();
    return Response.json(
      {
        ok: true as const,
        ...(await service.list({
          workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
          principalId,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return libraryRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const parsed: unknown = await request.json();
    const command = parseLibraryCommand(parsed);
    const service = await getLibraryService();
    const result = await service.create({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
    }, command);
    return Response.json(
      { ok: true as const, ...(result ?? {}) },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return libraryRouteError(error);
  }
}

function parseLibraryCommand(value: unknown): LibraryCreateCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Library command must be an object.");
  }
  const body = value as LibraryRequest;
  const kind = body.kind;
  if (kind === "world") {
    return {
      kind,
      name: requiredString(body.name, "name", 80),
      era: optionalString(body.era, 80),
      summary: optionalString(body.summary, 300),
    };
  }
  if (kind === "story") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      title: requiredString(body.title, "title", 80),
      premise: optionalString(body.premise, 300),
    };
  }
  if (kind === "record") {
    return {
      kind,
      storyId: requiredString(body.storyId, "storyId", 120),
      title: requiredString(body.title, "title", 80),
      retrospection: body.retrospection === true,
      mergeTargetRecordId: typeof body.mergeTargetRecordId === "string"
        ? body.mergeTargetRecordId.trim()
        : undefined,
    };
  }
  if (kind === "character") {
    const attachRecordId = body.attachRecordId === undefined
      || body.attachRecordId === null
      ? undefined
      : requiredString(body.attachRecordId, "attachRecordId", 120);
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      name: requiredString(body.name, "name", 80),
      role: optionalString(body.role, 120),
      summary: optionalString(body.summary, 300),
      attachRecordId,
    };
  }
  if (kind === "player-stance") {
    const stance = body.stance === "player" || body.stance === "observer"
      ? body.stance
      : null;
    if (!stance) {
      throw new RequestError("stance must be 'player' or 'observer'.");
    }
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      stance,
    };
  }
  if (kind === "attach-character") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      recordId: requiredString(body.recordId, "recordId", 120),
      definitionId: requiredString(body.definitionId, "definitionId", 160),
    };
  }
  if (kind === "branch") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      label: requiredString(body.label, "label", 80),
      sourceRecordId: requiredString(body.sourceRecordId, "sourceRecordId", 120),
    };
  }
  if (kind === "world-style") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      style: requiredString(body.style, "style", 40),
    };
  }
  // 批次 T8：世界管理台命令（owner-only 在服务层裁决）。
  if (kind === "world-archive") {
    if (typeof body.archived !== "boolean") {
      throw new RequestError("archived must be a boolean.");
    }
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      archived: body.archived,
    };
  }
  if (kind === "delete-record") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
      recordId: requiredString(body.recordId, "recordId", 120),
    };
  }
  if (kind === "delete-world") {
    return {
      kind,
      worldId: requiredString(body.worldId, "worldId", 120),
    };
  }
  throw new RequestError("Unknown library command kind.");
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new RequestError(`${field} is required and too long.`);
  }
  return value.trim();
}

function optionalString(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new RequestError("Optional text is invalid.");
  }
  return value.trim();
}

class RequestError extends Error {
  readonly code = "INVALID_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

function libraryRouteError(error: unknown): Response {
  if (error instanceof LibraryRouteConfigError) {
    return Response.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: "本机运行库未配置，暂时无法处理世界库请求。",
        },
      },
      { status: 503 },
    );
  }
  if (error instanceof RequestError || error instanceof LibraryServiceError) {
    // 批次 T8：管理命令权限与封存语义分出 403/409，其余沿用 404/400。
    const status = !(error instanceof LibraryServiceError)
      ? 400
      : error.code === "WORLD_NOT_OWNED"
        ? 403
        : error.code === "RECORD_NOT_FOUND"
          ? 404
        : error.code === "WORLD_ARCHIVED"
            || error.code === "WORLD_NOT_EMPTY"
            || error.code === "WORLD_SELF_PLAY_ACTIVE"
            || error.code === "RECORD_SELF_PLAY_ACTIVE"
            || error.code === "RECORD_TURN_ACTIVE"
          ? 409
          : 404;
    return Response.json(
      {
        ok: false as const,
        error: { code: error.code, message: error.message },
      },
      { status },
    );
  }
  return Response.json(
    {
      ok: false as const,
      error: {
        code: "INTERNAL_ERROR",
        message: "The local library could not complete this request.",
      },
    },
    { status: 500 },
  );
}

/**
 * 批次 T10-B7：library 服务全量下沉受限角色——迁移 0023 补齐最小授权后，
 * 全部命令走 REALM_RUNTIME_DATABASE_URL 共享池；owner pool 已移除
 *（T10-B6 的 GRANT_BLOCKED_OWNER_COMMANDS 例外随 0023 清空）。
 */
let runtimeLibraryService: LibraryService | undefined;

class LibraryRouteConfigError extends Error {
  readonly code = "LOCAL_RUNTIME_NOT_INITIALIZED";
}

async function getLibraryService(): Promise<LibraryService> {
  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl) {
    throw new LibraryRouteConfigError("REALM_RUNTIME_DATABASE_URL is required.");
  }
  runtimeLibraryService ??= createPostgresLibraryService(
    getSharedRuntimePool(runtimeUrl),
  );
  return runtimeLibraryService;
}
