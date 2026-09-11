import type { Pool } from "pg";
import type { SemanticConflictEvidenceStore } from "../../modules/worldline/semantic-conflict.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

/**
 * 批次 T11-B：evidence 写入携带 workspace/world/worldline/request 关联
 * （迁移 0025 新增可空列）；append-only 守卫与 FORCE RLS 不变。
 * evidence 写失败抛错——调用方（semantic review 路由）据此返回
 * unavailable，绝不把未持久化的结果声称成已完成复审。
 */
export function createPostgresSemanticConflictEvidenceStore(
  pool: Pool,
  workspaceId: string,
): SemanticConflictEvidenceStore {
  return {
    async append(evidence) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        // v37 §D.0：C 面——scope.worldId 存在时 gateWorldWrite
        //（worlds KEY SHARE + active）；archived 拒绝。
        if (evidence.scope?.worldId) {
          await gateWorldWrite(client, {
            workspaceId,
            worldId: evidence.scope.worldId,
          });
        }
        await client.query(
          `INSERT INTO semantic_conflict_evaluations (
             workspace_id, id, source, model, prompt_version,
             input_digest, result, world_id, worldline_id, request_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            workspaceId,
            `sce_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`,
            evidence.source,
            evidence.model,
            evidence.promptVersion,
            evidence.inputDigest,
            JSON.stringify(evidence.result),
            evidence.scope?.worldId ?? null,
            evidence.scope?.worldlineId ?? null,
            evidence.requestId ?? null,
          ],
        );
      });
    },
  };
}
