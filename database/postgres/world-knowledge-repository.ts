import type { Pool } from "pg";
import type {
  CausalEdge,
  ClaimScope,
  TruthStatus,
  WorldArticle,
  WorldClaim,
  WorldEntity,
  WorldEntityKind,
  WorldKnowledgeRepository,
  WorldRelation,
} from "../../modules/world-knowledge/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";
import { appendGraphInvalidation } from "./graph-invalidation.ts";

export function createPostgresWorldKnowledgeRepository(
  pool: Pool,
): WorldKnowledgeRepository {
  return {
    async upsertEntity(scope, entity) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO world_entities (
             workspace_id, world_id, worldline_id, id, entity_kind, name,
             summary, valid_from_tick, valid_to_tick
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, id) DO UPDATE SET
             name = EXCLUDED.name,
             summary = EXCLUDED.summary,
             valid_from_tick = EXCLUDED.valid_from_tick,
             valid_to_tick = EXCLUDED.valid_to_tick,
             updated_at = CURRENT_TIMESTAMP`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            entity.id,
            entity.entityKind,
            entity.name,
            entity.summary,
            entity.validFromTick,
            entity.validToTick,
          ],
        );
        // 批次 T11-A2：同事务追加失效事件（图谱 SSE 自动刷新事件源 W1）。
        await appendGraphInvalidation(client, scope, "entity", "upsertEntity");
      });
    },

    async appendClaim(scope, claim) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO world_claims (
             workspace_id, world_id, worldline_id, id, subject_entity_id,
             predicate, object_value, scope, truth_status, confidence,
             valid_from_tick, valid_to_tick,
             source_record_id, source_event_id, supersedes_claim_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            claim.id,
            claim.subjectEntityId,
            claim.predicate,
            claim.objectValue,
            claim.scope,
            claim.truthStatus,
            claim.confidence,
            claim.validFromTick,
            claim.validToTick,
            claim.sourceRecordId,
            claim.sourceEventId,
            claim.supersedesClaimId,
          ],
        );
        // 批次 T11-A2：同事务追加失效事件（W2；晶化入图谱 W8 经此方法覆盖）。
        await appendGraphInvalidation(client, scope, "claim", "appendClaim");
      });
    },

    // Clean-up Phase 2：同一来源的成批 claim（晶化入图谱）单事务写入，
    // 替代逐 claim 独立事务（N+1）；失效事件仍逐 claim 追加（账本语义不变，
    // 只合并事务）。批内任一失败整批回滚——调用方（晶化 best-effort 入
    // 图谱）接受 all-or-nothing。
    async appendClaims(scope, claims) {
      if (claims.length === 0) return;
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        for (const claim of claims) {
          await client.query(
            `INSERT INTO world_claims (
               workspace_id, world_id, worldline_id, id, subject_entity_id,
               predicate, object_value, scope, truth_status, confidence,
               valid_from_tick, valid_to_tick,
               source_record_id, source_event_id, supersedes_claim_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              claim.id,
              claim.subjectEntityId,
              claim.predicate,
              claim.objectValue,
              claim.scope,
              claim.truthStatus,
              claim.confidence,
              claim.validFromTick,
              claim.validToTick,
              claim.sourceRecordId,
              claim.sourceEventId,
              claim.supersedesClaimId,
            ],
          );
          await appendGraphInvalidation(client, scope, "claim", "appendClaims");
        }
      });
    },

    // 对话 growth 幂等批量：claim id 由调用方确定性生成，ON CONFLICT 静默
    // 跳过——重复调度同一来源不产生重复 claim；单事务批量（非逐 claim 事务）。
    async appendClaimsIdempotent(scope, claims) {
      if (claims.length === 0) return;
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        let inserted = 0;
        for (const claim of claims) {
          const result = await client.query(
            `INSERT INTO world_claims (
               workspace_id, world_id, worldline_id, id, subject_entity_id,
               predicate, object_value, scope, truth_status, confidence,
               valid_from_tick, valid_to_tick,
               source_record_id, source_event_id, supersedes_claim_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              claim.id,
              claim.subjectEntityId,
              claim.predicate,
              claim.objectValue,
              claim.scope,
              claim.truthStatus,
              claim.confidence,
              claim.validFromTick,
              claim.validToTick,
              claim.sourceRecordId,
              claim.sourceEventId,
              claim.supersedesClaimId,
            ],
          );
          inserted += result.rowCount ?? 0;
        }
        // 批次 T11-A2 账本语义沿用：至少一条真实插入才追加失效事件。
        if (inserted > 0) {
          await appendGraphInvalidation(client, scope, "claim", "appendClaimsIdempotent");
        }
      });
    },

    // Batch 4A：对话 growth 单事务写入。entity/claim 的 valid_from_tick
    // 由写事务内已验证的来源 Event 派生（events.world_tick），调用方无法
    // 注入假时序；来源事件不存在或跨 scope（workspace/world/worldline/
    // record 任一不匹配）→ 返回 false 且零写入，绝不回退 0。
    async appendDialogueGrowth(scope, input) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        const source = await client.query<{ world_tick: string | number }>(
          `SELECT world_tick
           FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            input.recordId,
            input.sourceEventId,
          ],
        );
        const sourceRow = source.rows[0];
        if (!sourceRow) return false;
        const validFromTick = Number(sourceRow.world_tick);
        for (const entity of input.entities) {
          await client.query(
            `INSERT INTO world_entities (
               workspace_id, world_id, worldline_id, id, entity_kind, name,
               summary, valid_from_tick, valid_to_tick
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
             ON CONFLICT (workspace_id, id) DO UPDATE SET
               name = EXCLUDED.name,
               summary = EXCLUDED.summary,
               valid_from_tick = EXCLUDED.valid_from_tick,
               valid_to_tick = EXCLUDED.valid_to_tick,
               updated_at = CURRENT_TIMESTAMP`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              entity.id,
              entity.entityKind,
              entity.name,
              entity.summary,
              validFromTick,
            ],
          );
          await appendGraphInvalidation(client, scope, "entity", "upsertEntity");
        }
        let inserted = 0;
        for (const claim of input.claims) {
          const result = await client.query(
            `INSERT INTO world_claims (
               workspace_id, world_id, worldline_id, id, subject_entity_id,
               predicate, object_value, scope, truth_status, confidence,
               valid_from_tick, valid_to_tick,
               source_record_id, source_event_id, supersedes_claim_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13, $14)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              claim.id,
              claim.subjectEntityId,
              claim.predicate,
              claim.objectValue,
              claim.scope,
              claim.truthStatus,
              claim.confidence,
              validFromTick,
              input.recordId,
              input.sourceEventId,
              claim.supersedesClaimId,
            ],
          );
          inserted += result.rowCount ?? 0;
        }
        // 批次 T11-A2 账本语义沿用：至少一条真实插入才追加失效事件。
        if (inserted > 0) {
          await appendGraphInvalidation(client, scope, "claim", "appendClaimsIdempotent");
        }
        return true;
      });
    },

    async getClaim(scope, claimId) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(CLAIM_SELECT, [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          claimId,
        ]);
        return result.rows[0] ? mapClaim(result.rows[0]) : null;
      });
    },

    async listClaims(scope, filter = {}) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM world_claims
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND ($4::text IS NULL OR subject_entity_id = $4)
             AND ($5::text IS NULL OR truth_status = $5)
             AND ($6::text IS NULL OR scope = $6)
           ORDER BY valid_from_tick, id`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            filter.subjectEntityId ?? null,
            filter.truthStatus ?? null,
            filter.scope ?? null,
          ],
        );
        return result.rows.map(mapClaim);
      });
    },

    async appendRelation(scope, relation) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        const inserted = await client.query(
          `INSERT INTO world_relations (
             workspace_id, world_id, worldline_id, id,
             subject_entity_id, predicate, object_entity_id, source_claim_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (
             workspace_id, worldline_id, subject_entity_id, predicate,
             object_entity_id, source_claim_id
           ) DO NOTHING`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            relation.id,
            relation.subjectEntityId,
            relation.predicate,
            relation.objectEntityId,
            relation.sourceClaimId,
          ],
        );
        // 批次 T11-A2：W3——ON CONFLICT DO NOTHING 命中（无实际变化）不发事件。
        if (inserted.rowCount && inserted.rowCount > 0) {
          await appendGraphInvalidation(client, scope, "relation", "appendRelation");
        }
      });
    },

    async listRelations(scope, filter = {}) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM world_relations
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND ($4::text IS NULL OR subject_entity_id = $4)
           ORDER BY created_at, id`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            filter.subjectEntityId ?? null,
          ],
        );
        return result.rows.map((row): WorldRelation => ({
          id: row.id,
          subjectEntityId: row.subject_entity_id,
          predicate: row.predicate,
          objectEntityId: row.object_entity_id,
          sourceClaimId: row.source_claim_id,
        }));
      });
    },

    async createArticle(scope, article) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO world_articles (
             workspace_id, world_id, worldline_id, id, title, body,
             claim_ids, source_event_ids
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[])`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            article.id,
            article.title,
            article.body,
            [...article.claimIds],
            [...article.sourceEventIds],
          ],
        );
        // 批次 T11-A2：同事务追加失效事件（W4）。
        await appendGraphInvalidation(client, scope, "article", "createArticle");
      });
    },

    async listArticles(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM world_articles
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows.map((row): WorldArticle => ({
          id: row.id,
          title: row.title,
          body: row.body,
          claimIds: row.claim_ids,
          sourceEventIds: row.source_event_ids,
        }));
      });
    },

    async appendCausalEdge(scope, edge) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO causal_edges (
             workspace_id, world_id, worldline_id, id,
             from_claim_id, to_claim_id, edge_kind
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (
             workspace_id, worldline_id, from_claim_id, to_claim_id, edge_kind
           ) DO NOTHING`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            edge.id,
            edge.fromClaimId,
            edge.toClaimId,
            edge.edgeKind,
          ],
        );
      });
    },

    async listCausalEdges(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM causal_edges
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows.map((row): CausalEdge => ({
          id: row.id,
          fromClaimId: row.from_claim_id,
          toClaimId: row.to_claim_id,
          edgeKind: row.edge_kind,
        }));
      });
    },

    async listEntities(scope, filter = {}) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM world_entities
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND ($4::text IS NULL OR entity_kind = $4)
           ORDER BY created_at, id`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            filter.entityKind ?? null,
          ],
        );
        return result.rows.map((row): WorldEntity => ({
          id: row.id,
          entityKind: row.entity_kind as WorldEntityKind,
          name: row.name,
          summary: row.summary,
          validFromTick: Number(row.valid_from_tick),
          validToTick: row.valid_to_tick === null ? null : Number(row.valid_to_tick),
        }));
      });
    },
  };
}

const CLAIM_SELECT = `
  SELECT * FROM world_claims
  WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
`;

function mapClaim(row: Record<string, unknown>): WorldClaim {
  return {
    id: row.id as string,
    subjectEntityId: row.subject_entity_id as string,
    predicate: row.predicate as string,
    objectValue: row.object_value as string,
    scope: row.scope as ClaimScope,
    truthStatus: row.truth_status as TruthStatus,
    confidence: Number(row.confidence),
    validFromTick: Number(row.valid_from_tick),
    validToTick: row.valid_to_tick === null ? null : Number(row.valid_to_tick),
    sourceRecordId: (row.source_record_id as string | null) ?? null,
    sourceEventId: (row.source_event_id as string | null) ?? null,
    supersedesClaimId: (row.supersedes_claim_id as string | null) ?? null,
  };
}
