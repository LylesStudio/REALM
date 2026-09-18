import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import { getFirstNightRuntime } from "../../../../modules/application/first-night-runtime.ts";
import {
  createPostgresLibraryService,
  type LibraryService,
} from "../../../../modules/application/library-service.ts";
import { getModelSettingsService } from "../../../../modules/application/model-settings-service.ts";
import {
  fallbackGenesisDraft,
  generateGenesisDraft,
  normalizeGenesisDraft,
  type WorldGenesisSource,
} from "../../../../modules/application/world-genesis.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 2_000;

/**
 * 创建世界：
 * - POST { prompt }  → 生成世界草稿（模型优先，失败时本地降级）；
 * - POST { draft }   → 手稿确认后单事务原子落库，返回新记录入口。
 */
export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();

    const parsed: unknown = await request.json();
    if (!isObject(parsed)) {
      return genesisError(400, "INVALID_COMMAND", "World genesis request must be an object.");
    }

    if (typeof parsed.prompt === "string") {
      const prompt = parsed.prompt.trim().slice(0, MAX_PROMPT_LENGTH);
      if (prompt.length < 4) {
        return genesisError(400, "INVALID_COMMAND", "Prompt is too short.");
      }
      const { draft, source } = await draftFromPrompt(prompt);
      return Response.json(
        { ok: true as const, draft, source },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if ("draft" in parsed) {
      const draft = normalizeGenesisDraft(parsed.draft);
      if (!draft) {
        return genesisError(400, "INVALID_COMMAND", "World name is required.");
      }
      const service = await getLibraryService();
      const ids = await service.createGenesis(
        { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId },
        draft,
      );
      scheduleFirstNight(ids.recordId);
      return Response.json(
        { ok: true as const, ...ids },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    return genesisError(400, "INVALID_COMMAND", "Provide either prompt or draft.");
  } catch {
    return genesisError(
      500,
      "INTERNAL_ERROR",
      "The local library could not complete this request.",
    );
  }
}

async function draftFromPrompt(
  prompt: string,
): Promise<{ draft: ReturnType<typeof fallbackGenesisDraft>; source: WorldGenesisSource }> {
  try {
    const gateway = await getModelSettingsService().gateway();
    const draft = await generateGenesisDraft(gateway, prompt);
    if (draft) return { draft, source: "model" };
  } catch (error) {
    // 模型未配置或调用失败不阻塞创世：降级为本地提炼，由用户在草稿上微调。
    void error;
    console.warn("[realm] world genesis fell back to local drafting");
  }
  return { draft: fallbackGenesisDraft(prompt), source: "fallback" };
}

/**
 * 批次 T1：创建事务提交后 fire-and-forget 触发初夜生成。
 * fail-closed——运行时未配置（缺 REALM_RUNTIME_DATABASE_URL）只留日志，
 * 记录打开时的懒重试会补跑。
 */
function scheduleFirstNight(recordId: string): void {
  try {
    getFirstNightRuntime(LOCAL_RECORD_SCOPE.workspaceId).schedule(recordId);
  } catch (error) {
    console.warn(
      `[realm] first night kickoff skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function genesisError(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

let defaultLibraryService: Promise<LibraryService> | undefined;

async function getLibraryService(): Promise<LibraryService> {
  defaultLibraryService ??= createDefaultLibraryService().catch((error) => {
    defaultLibraryService = undefined;
    throw error;
  });
  return defaultLibraryService;
}

async function createDefaultLibraryService(): Promise<LibraryService> {
  // 批次 T10-B7：迁移 0023 后创世全量下沉受限角色共享池。
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    throw new Error("REALM_RUNTIME_DATABASE_URL is required.");
  }
  return createPostgresLibraryService(getSharedRuntimePool(connectionString));
}
