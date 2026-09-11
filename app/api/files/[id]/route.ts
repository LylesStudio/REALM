import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  withWorkspaceTransaction,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/** 世界文件（角色卡头像等）：会话鉴权 + workspace 校验。 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const principalId = resolveRequestPrincipal(
    request,
    LOCAL_RECORD_SCOPE.principalId,
  );
  if (!principalId) return unauthorizedResponse();
  const { id } = await context.params;
  if (!id || !/^file_[a-f0-9]+$/.test(id)) {
    return Response.json(
      { ok: false as const, error: { code: "NOT_FOUND" } },
      { status: 404 },
    );
  }
  // 批次 T10-B8-A：只读路径下沉受限角色共享池（world_files SELECT 0016 已授）。
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const file = await withWorkspaceTransaction(
    getSharedRuntimePool(connectionString),
    LOCAL_RECORD_SCOPE.workspaceId,
    async (client) => {
      // 会话 principal 必须是该文件所在世界的成员，否则视为越权。
      const result = await client.query<{
        content_type: string;
        data: Buffer;
        member: string | null;
      }>(
        `SELECT file.content_type, file.data,
           (
             SELECT membership.principal_id
             FROM player_world_memberships AS membership
             WHERE membership.workspace_id = file.workspace_id
               AND membership.world_id = file.world_id
               AND membership.principal_id = $3
           ) AS member
         FROM world_files AS file
         WHERE file.workspace_id = $1 AND file.id = $2`,
        [LOCAL_RECORD_SCOPE.workspaceId, id, principalId],
      );
      return result.rows[0] ?? null;
    },
    { readOnly: true },
  );
  if (!file) {
    return Response.json(
      { ok: false as const, error: { code: "NOT_FOUND" } },
      { status: 404 },
    );
  }
  if (!file.member) {
    return Response.json(
      { ok: false as const, error: { code: "FORBIDDEN" } },
      { status: 403 },
    );
  }
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.content_type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
