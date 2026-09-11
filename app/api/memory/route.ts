import {
  createPostgresCharacterMemoryRepository,
  createPostgresRecordRuntimeScopeRepository,
} from "../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../world-scope.ts";
import { createCharacterMemoryService } from "../../../modules/memory/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../auth-context.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const recordId = url.searchParams.get("recordId") ?? LOCAL_RECORD_SCOPE.recordId;
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const depth = parseDepth(url.searchParams.get("depth"));
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    // 批次 T10-B4：共享池（此前每请求新建 Pool 从不回收）。
    const pool = getSharedRuntimePool(connectionString);
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(pool);
    const scope = await scopeRepository.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    const memory = createCharacterMemoryService({
      repository: createPostgresCharacterMemoryRepository(pool),
    });
    const representation = await memory.representation({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      recordId: scope.recordId,
      characterInstanceId: scope.playerActor.characterInstanceId,
    }, depth);
    const relationships = await memory.relationships({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      recordId: scope.recordId,
      characterInstanceId: scope.playerActor.characterInstanceId,
    });
    return Response.json(
      { ok: true as const, representation, relationships },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "暂时无法读取角色记忆。" },
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const recordId = url.searchParams.get("recordId") ?? LOCAL_RECORD_SCOPE.recordId;
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const domain = parseSummaryDomain(url.searchParams.get("domain"));
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    // 批次 T10-B4：共享池（此前每请求新建 Pool 从不回收）。
    const pool = getSharedRuntimePool(connectionString);
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(pool);
    const scope = await scopeRepository.resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    const memory = createCharacterMemoryService({
      repository: createPostgresCharacterMemoryRepository(pool),
    });
    const summary = await (domain
      ? memory.summarizeDomain({
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
          worldlineId: scope.worldlineId,
          recordId: scope.recordId,
          characterInstanceId: scope.playerActor.characterInstanceId,
        }, domain)
      : memory.summarize({
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
          worldlineId: scope.worldlineId,
          recordId: scope.recordId,
          characterInstanceId: scope.playerActor.characterInstanceId,
        }));
    return Response.json(
      { ok: true as const, summary },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "暂时无法整理角色记忆。" },
      },
      { status: 500 },
    );
  }
}

function parseDepth(value: string | null): "simple" | "balanced" | "immersive" {
  return value === "simple" || value === "immersive" ? value : "balanced";
}

function parseSummaryDomain(
  value: string | null,
): "episodic" | "semantic" | "decision" | null {
  return value === "episodic" || value === "semantic" || value === "decision"
    ? value
    : null;
}
