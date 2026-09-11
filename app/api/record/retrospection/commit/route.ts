import { createPostgresWorldlineMergeRepository } from "../../../../../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../../../../../database/postgres/workspace-transaction.ts";
import {
  LOCAL_RECORD_SCOPE,
} from "../../../../../modules/application/local-record-service.ts";
import {
  WorldlineMergeError,
  createWorldlineMergeService,
} from "../../../../../modules/worldline/merge.ts";
import { getSharedRuntimePool, resolveWorldScopeForMember } from "../../../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../../auth-context.ts";

export const runtime = "nodejs";

/**
 * Retrospection 的唯一正史入口：confirm=true 后才做冲突核查与 worldline merge。
 * 源 Record 与副本 Record 都保持不可变；merge 产出新的 merged worldline。
 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    if (!recordId || body.confirm !== true) {
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "请在二次警告后确认将回溯记录记入正史。",
          },
        },
        { status: 400 },
      );
    }
    const pool = getSharedRuntimePool(connectionString);
    const membership = await resolveWorldScopeForMember(pool, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId: typeof body.worldId === "string" ? body.worldId.trim() : "",
    });
    if (!membership) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const source = await withWorkspaceTransaction(
      pool,
      LOCAL_RECORD_SCOPE.workspaceId,
      async (client) => {
        const result = await client.query<{
          world_id: string;
          source_worldline_id: string;
          duplicate_worldline_id: string;
          duplicate_event_count: number;
        }>(
          `SELECT
             duplicate.world_id,
             source.worldline_id AS source_worldline_id,
             duplicate.worldline_id AS duplicate_worldline_id,
             (
               SELECT count(*)::int FROM events
               WHERE events.workspace_id = duplicate.workspace_id
                 AND events.record_id = duplicate.id
             ) AS duplicate_event_count
           FROM records AS duplicate
           JOIN records AS source
             ON source.workspace_id = duplicate.workspace_id
            AND source.id = duplicate.linked_record_id
           WHERE duplicate.workspace_id = $1
             AND duplicate.id = $2
             AND duplicate.timeline_kind = 'retrospection'`,
          [LOCAL_RECORD_SCOPE.workspaceId, recordId],
        );
        return result.rows[0] ?? null;
      },
      { readOnly: true },
    );
    if (!source || source.world_id !== membership.worldId) {
      return Response.json(
        { ok: false as const, error: { code: "RETROSPECTION_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (source.duplicate_event_count < 1) {
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "RETROSPECTION_EMPTY",
            message: "请先在回溯副本中完成至少一条行动，再提交正史。",
          },
        },
        { status: 409 },
      );
    }

    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(pool),
    });
    const idempotencyKey = `retrospection:${recordId}:canon-v1`;
    const preview = await service.merge({
      workspaceId: membership.workspaceId,
      worldId: source.world_id,
      sourceA: source.source_worldline_id,
      sourceB: source.duplicate_worldline_id,
      idempotencyKey,
      operator: principalId,
      dryRun: true,
    });
    if (preview.status !== "preview") {
      return Response.json({ ok: true as const, ...preview }, { status: 200 });
    }
    const merged = await service.merge({
      workspaceId: membership.workspaceId,
      worldId: source.world_id,
      sourceA: source.source_worldline_id,
      sourceB: source.duplicate_worldline_id,
      idempotencyKey,
      operator: principalId,
    });
    return Response.json(
      { ok: true as const, factCheck: preview.report, ...merged },
      { status: merged.status === "rejected" ? 409 : 200 },
    );
  } catch (error) {
    if (error instanceof WorldlineMergeError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "RETROSPECTION_COMMIT_FAILED" } },
      { status: 500 },
    );
  }
}
