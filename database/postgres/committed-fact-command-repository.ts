import type { PoolClient } from "pg";

import {
  CommittedFactCommandError,
  evidenceHash,
  type CommittedFactCommandStore,
  type InventoryAdjustmentResult,
  type InventoryGrantResult,
  type PerformanceAssessmentResult,
  type RelationshipRevisionResult,
} from "../../modules/application/committed-fact-command.ts";
import type { ProjectScope } from "../../modules/projects/public.ts";
import { withWorkspaceTransaction, type WorkspaceDatabase } from "./workspace-transaction.ts";

type StoredResult = InventoryAdjustmentResult | InventoryGrantResult | RelationshipRevisionResult | PerformanceAssessmentResult;

export function createPostgresCommittedFactCommandStore(
  database: WorkspaceDatabase,
): CommittedFactCommandStore {
  return {
    async loadCommand(scope, idempotencyKey) {
      return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
        return readCommand(client, scope, idempotencyKey);
      }, { readOnly: true });
    },
    async adjustInventory(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input.requestFingerprint) as InventoryAdjustmentResult;
        await requireEvent(client, input.scope, input.recordId, input.sourceEventId);
        const updated = await client.query<{ quantity: string; revision: string }>(
          `UPDATE character_assets
           SET quantity = quantity + $6,
               revision = revision + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND character_instance_id = $5
             AND asset_definition_id = $7 AND revision = $8
             AND quantity + $6 >= 0
           RETURNING quantity::text, revision::text`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.recordId,
            input.characterInstanceId,
            input.delta,
            input.assetDefinitionId,
            input.expectedRevision,
          ],
        );
        const row = updated.rows[0];
        if (!row) {
          const present = await client.query(
            `SELECT revision, quantity FROM character_assets
             WHERE workspace_id = $1 AND record_id = $2
               AND character_instance_id = $3 AND asset_definition_id = $4`,
            [input.scope.workspaceId, input.recordId, input.characterInstanceId, input.assetDefinitionId],
          );
          if (present.rowCount !== 1) {
            throw new CommittedFactCommandError("ASSET_NOT_FOUND", "The asset holding is not available.");
          }
          const holding = present.rows[0] as { revision: string; quantity: string };
          if (Number(holding.revision) !== input.expectedRevision) {
            throw new CommittedFactCommandError("WRITE_CONFLICT", "The asset holding changed. Read it again before retrying.");
          }
          throw new CommittedFactCommandError("INSUFFICIENT_QUANTITY", "The asset holding cannot cover this delta.");
        }
        const result: InventoryAdjustmentResult = {
          status: "committed",
          commandId: input.commandId,
          quantity: Number(row.quantity),
          revision: Number(row.revision),
        };
        await insertCommand(client, input, "inventory_adjusted", result);
        return result;
      });
    },
    async grantInventory(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input.requestFingerprint) as InventoryGrantResult;
        await requireEvent(client, input.scope, input.recordId, input.sourceEventId);
        const definition = await client.query(
          `SELECT id FROM asset_definitions
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [input.scope.workspaceId, input.scope.worldId, input.assetDefinitionId],
        );
        const instance = await client.query(
          `SELECT id FROM character_instances
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.recordId,
            input.characterInstanceId,
          ],
        );
        if (definition.rowCount !== 1 || instance.rowCount !== 1) {
          throw new CommittedFactCommandError("ASSET_NOT_FOUND", "The asset holding is not available.");
        }
        const inserted = await client.query<{ quantity: string; revision: string }>(
          `INSERT INTO character_assets (
             workspace_id, world_id, worldline_id, record_id,
             character_instance_id, asset_definition_id, quantity, revision
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
           ON CONFLICT (workspace_id, record_id, character_instance_id, asset_definition_id)
           DO NOTHING
           RETURNING quantity::text, revision::text`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.recordId,
            input.characterInstanceId,
            input.assetDefinitionId,
            input.quantity,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new CommittedFactCommandError("ASSET_ALREADY_HELD", "The asset holding already exists.");
        }
        const result: InventoryGrantResult = {
          status: "committed",
          commandId: input.commandId,
          quantity: Number(row.quantity),
          revision: Number(row.revision),
        };
        await insertCommand(client, input, "inventory_granted", result);
        return result;
      });
    },
    async reviseRelationship(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input.requestFingerprint) as RelationshipRevisionResult;
        const event = await requireEvent(client, input.scope, null, input.sourceEventId);
        const ordinal = await client.query<{ next_ordinal: string }>(
          `SELECT (count(*) + 1)::text AS next_ordinal
           FROM member_relationship_revisions
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND subject_entity_key = $4 AND object_entity_key = $5
             AND relation_kind = $6`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.subjectEntityKey,
            input.objectEntityKey,
            input.relationKind,
          ],
        );
        const revisionOrdinal = Number(ordinal.rows[0]?.next_ordinal ?? "1");
        const result: RelationshipRevisionResult = {
          status: "committed",
          commandId: input.commandId,
          relationKind: input.relationKind,
          revisionOrdinal,
          occurred: { worldTick: event.worldTick, worldOrdinal: event.worldOrdinal },
        };
        await insertCommand(client, input, "relationship_revised", result);
        await client.query(
          `INSERT INTO member_relationship_revisions (
             workspace_id, world_id, worldline_id, id,
             subject_entity_key, object_entity_key, relation_kind, revision_ordinal,
             source_event_id, source_record_id, occurred_tick, occurred_ordinal, command_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.commandId,
            input.subjectEntityKey,
            input.objectEntityKey,
            input.relationKind,
            revisionOrdinal,
            input.sourceEventId,
            event.recordId,
            event.worldTick,
            event.worldOrdinal,
            input.commandId,
          ],
        );
        return result;
      });
    },
    async loadPerformanceFacts(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const found = await client.query<{ id: string }>(
          `SELECT id FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = ANY($5::text[])`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.recordId,
            input.evidenceEventIds,
          ],
        );
        if (found.rowCount !== input.evidenceEventIds.length) {
          throw new CommittedFactCommandError("EVENT_NOT_FOUND", "Performance evidence does not match committed events.");
        }
        const milestone = await client.query(
          `SELECT id FROM project_milestones
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND completion_record_id = $4 AND status = 'completed'
           LIMIT 1`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.recordId],
        );
        return {
          evidenceCount: input.evidenceEventIds.length,
          milestoneCompleted: milestone.rowCount === 1,
        };
      }, { readOnly: true });
    },
    async recordPerformanceAssessment(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input.requestFingerprint) as PerformanceAssessmentResult;
        const found = await client.query<{ id: string }>(
          `SELECT id FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = ANY($5::text[])`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.recordId, input.evidenceEventIds],
        );
        if (found.rowCount !== input.evidenceEventIds.length) {
          throw new CommittedFactCommandError("EVENT_NOT_FOUND", "Performance evidence does not match committed events.");
        }
        const hash = evidenceHash(input.evidenceEventIds);
        if (hash !== input.evidenceSnapshotHash) {
          throw new CommittedFactCommandError("COMMAND_INVALID", "Performance evidence hash does not match.");
        }
        const assessmentId = `${input.commandId}:assessment`;
        const result: PerformanceAssessmentResult = {
          status: "committed",
          commandId: input.commandId,
          assessmentId,
          score: input.score,
          evidenceSnapshotHash: hash,
          goalTransition: null,
        };
        await insertCommand(client, input, "performance_assessed", result);
        await client.query(
          `INSERT INTO performance_assessments (
             workspace_id, world_id, worldline_id, record_id, id,
             policy_version, score, evidence_event_ids, evidence_snapshot_hash, command_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.recordId,
            assessmentId,
            input.policyVersion,
            input.score,
            input.evidenceEventIds,
            hash,
            input.commandId,
          ],
        );
        return result;
      });
    },
  };
}

function replay(
  existing: { requestFingerprint: string; result: StoredResult },
  requestFingerprint: string,
): StoredResult {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new CommittedFactCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
  }
  return { ...existing.result, status: "replayed" };
}

async function readCommand(
  client: PoolClient,
  scope: ProjectScope,
  idempotencyKey: string,
): Promise<{ requestFingerprint: string; result: StoredResult } | null> {
  const result = await client.query<{ request_fingerprint: string; result_manifest: StoredResult }>(
    `SELECT request_fingerprint, result_manifest
     FROM committed_fact_commands
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND idempotency_key = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { requestFingerprint: row.request_fingerprint, result: row.result_manifest };
}

async function requireEvent(
  client: PoolClient,
  scope: ProjectScope,
  recordId: string | null,
  eventId: string,
): Promise<{ recordId: string; worldTick: number; worldOrdinal: number }> {
  const result = await client.query<{ record_id: string; world_tick: string; world_ordinal: string }>(
    `SELECT record_id, world_tick::text, world_ordinal::text
     FROM events
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
       AND ($5::text IS NULL OR record_id = $5)`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, eventId, recordId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommittedFactCommandError("EVENT_NOT_FOUND", "The source event is not available.");
  }
  return {
    recordId: row.record_id,
    worldTick: Number(row.world_tick),
    worldOrdinal: Number(row.world_ordinal),
  };
}

async function insertCommand(
  client: PoolClient,
  input: {
    scope: ProjectScope;
    commandId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
  kind: "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed",
  result: StoredResult,
): Promise<void> {
  await client.query(
    `INSERT INTO committed_fact_commands (
       workspace_id, world_id, worldline_id, id, idempotency_key,
       request_fingerprint, kind, result_manifest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.scope.workspaceId,
      input.scope.worldId,
      input.scope.worldlineId,
      input.commandId,
      input.idempotencyKey,
      input.requestFingerprint,
      kind,
      JSON.stringify(result),
    ],
  );
}
