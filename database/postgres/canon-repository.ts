import type { Pool } from "pg";
import type {
  CanonProposal,
  CanonProposalStatus,
  CanonRepository,
  CanonRevision,
} from "../../modules/worldline/canon.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { appendGraphInvalidation } from "./graph-invalidation.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

export function createPostgresCanonRepository(pool: Pool): CanonRepository {
  return {
    async createProposal(scope, proposal) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO canon_proposals (
             workspace_id, world_id, worldline_id, id, target_level,
             article_id, claim_ids, rationale, status, proposed_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10)`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            proposal.id,
            proposal.targetLevel,
            proposal.articleId,
            [...proposal.claimIds],
            proposal.rationale,
            proposal.status,
            proposal.proposedBy,
          ],
        );
        // 批次 T11-A2：同事务追加失效事件（W5）。
        await appendGraphInvalidation(client, scope, "canon_proposal", "propose");
      });
    },

    async getProposal(scope, proposalId) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM canon_proposals
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
          [scope.workspaceId, scope.worldId, scope.worldlineId, proposalId],
        );
        return result.rows[0] ? mapProposal(result.rows[0]) : null;
      });
    },

    async listProposals(scope, status) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM canon_proposals
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND ($4::text IS NULL OR status = $4)
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId, status ?? null],
        );
        return result.rows.map(mapProposal);
      });
    },

    async mergeProposal(scope, input) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        const decided = await client.query(
          `UPDATE canon_proposals
           SET status = 'merged', decided_by = $5, decided_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND id = $4 AND status = 'pending'`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            input.proposalId,
            input.decidedBy,
          ],
        );
        if (decided.rowCount !== 1) {
          throw new Error(`Proposal ${input.proposalId} is not pending.`);
        }
        for (const claim of input.promotedClaims) {
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
        }
        if (input.article) {
          await client.query(
            `INSERT INTO world_articles (
               workspace_id, world_id, worldline_id, id, title, body,
               claim_ids, source_event_ids
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[])`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              input.article.id,
              input.article.title,
              input.article.body,
              [...input.article.claimIds],
              [...input.article.sourceEventIds],
            ],
          );
        }
        await client.query(
          `INSERT INTO canon_revisions (
             workspace_id, world_id, worldline_id, id, parent_revision_id,
             effective_tick, effective_ordinal, accepted_proposal_id,
             content_hash, security_class
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            input.revision.id,
            input.revision.parentRevisionId,
            input.revision.effectiveTick,
            input.revision.effectiveOrdinal,
            input.revision.acceptedProposalId,
            input.revision.contentHash,
            // 批次 T11-G：安全分类随 Revision 落库（缺省 public）。
            input.revision.securityClass ?? "public",
          ],
        );
        // 批次 T11-A2：W7——merge 单事务多写合并为一个 canon_merge 事件。
        await appendGraphInvalidation(client, scope, "canon_merge", "merge");
        // 批次 T11-B：传播原子入队钩子（同事务；抛出即整体回滚）。
        if (input.propagation) {
          await input.propagation.enqueue(client);
        }
      });
    },

    async markDecided(scope, input) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `UPDATE canon_proposals
           SET status = $5, decided_by = $6, decided_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND id = $4 AND status = 'pending'`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            input.proposalId,
            input.status,
            input.decidedBy,
          ],
        );
        if (result.rowCount !== 1) {
          throw new Error(`Proposal ${input.proposalId} is not pending.`);
        }
        // 批次 T11-A2：同事务追加失效事件（W6）。
        await appendGraphInvalidation(client, scope, "canon_decision", input.status);
      });
    },

    async latestRevision(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM canon_revisions
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY committed_at DESC, id DESC
           LIMIT 1`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows[0] ? mapRevision(result.rows[0]) : null;
      });
    },
  };
}

function mapProposal(row: Record<string, unknown>): CanonProposal {
  return {
    id: row.id as string,
    targetLevel: row.target_level as CanonProposal["targetLevel"],
    articleId: (row.article_id as string | null) ?? null,
    claimIds: row.claim_ids as readonly string[],
    rationale: row.rationale as string,
    status: row.status as CanonProposalStatus,
    proposedBy: row.proposed_by as string,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: mapTimestamp(row.decided_at),
    createdAt: mapTimestamp(row.created_at) ?? new Date().toISOString(),
  };
}

function mapTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRevision(row: Record<string, unknown>): CanonRevision {
  return {
    id: row.id as string,
    parentRevisionId: (row.parent_revision_id as string | null) ?? null,
    effectiveTick: Number(row.effective_tick),
    effectiveOrdinal: Number(row.effective_ordinal),
    acceptedProposalId: row.accepted_proposal_id as string,
    contentHash: row.content_hash as string,
    committedAt: row.committed_at instanceof Date
      ? row.committed_at.toISOString()
      : String(row.committed_at),
    // 批次 T11-G：0026 起必有列；DEFAULT 兼容读旧库。
    securityClass: (row.security_class as CanonRevision["securityClass"] | null) ?? "public",
  };
}
