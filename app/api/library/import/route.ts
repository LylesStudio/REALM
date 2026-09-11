import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import { importTavernBundle } from "../../../../modules/application/tavern-import-service.ts";
import {
  TavernImportError,
  TAVERN_IMPORT_MAX_BYTES,
} from "../../../../modules/import/tavern-parser.ts";
import { withWorkspaceTransaction } from "../../../../database/postgres/workspace-transaction.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/** 酒馆角色卡/世界书导入：multipart（file + worldId）。 */
export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();

    const form = await request.formData();
    const file = form.get("file");
    const worldId = typeof form.get("worldId") === "string"
      ? (form.get("worldId") as string).trim()
      : "";
    if (!worldId || !(file instanceof File)) {
      return importError(400, "TAVERN_IMPORT_UNKNOWN_FORMAT", "file 与 worldId 均为必填。");
    }
    if (file.size > TAVERN_IMPORT_MAX_BYTES) {
      return importError(413, "TAVERN_IMPORT_TOO_LARGE", "文件超过 10MB 上限。");
    }
    const bytes = Buffer.from(await file.arrayBuffer());

    // 批次 T10-B6：导入=内容写——membership role ∈ owner/player 才放行；
    // 非成员 404（不泄露存在性），observer 403。读走受限角色共享池。
    const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!runtimeUrl) {
      return importError(503, "LOCAL_RUNTIME_NOT_INITIALIZED", "本机运行库未配置。");
    }
    const role = await withWorkspaceTransaction(
      getSharedRuntimePool(runtimeUrl),
      LOCAL_RECORD_SCOPE.workspaceId,
      async (client) => {
        const membership = await client.query<{ role: string }>(
          `SELECT role
           FROM player_world_memberships
           WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
          [LOCAL_RECORD_SCOPE.workspaceId, worldId, principalId],
        );
        return membership.rows[0]?.role ?? null;
      },
      { readOnly: true },
    );
    if (role === null) {
      return importError(404, "WORLD_NOT_FOUND", "World not found.");
    }
    if (role === "observer") {
      return importError(403, "WORLD_READ_ONLY", "Observers are read-only in this world.");
    }

    // 批次 T10-B7：迁移 0023 补齐 character_definitions INSERT——导入
    // 全量走受限角色共享池（membership 门禁在上方已完成）。
    const report = await importTavernBundle(
      getSharedRuntimePool(runtimeUrl),
      { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, worldId },
      bytes,
      file.name || null,
    );
    return Response.json(
      { ok: true as const, ...report },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TavernImportError) {
      const status = error.code === "TAVERN_IMPORT_TOO_LARGE" ? 413 : 400;
      return importError(status, error.code, error.message);
    }
    return importError(500, "INTERNAL_ERROR", "The import could not complete.");
  }
}

function importError(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
