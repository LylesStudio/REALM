import type { PoolClient } from "pg";
import {
  compareReplay, decodeReplayContext, decodeStoredReplayBinding, REPLAY_LINEAGE_MAX_BYTES,
  type FactKind, type ReplayContextV1,
} from "../../modules/application/command-replay-lineage.ts";

import {
  CommittedFactCommandError,
  evidenceHash,
  committedFactRequestFingerprintFor,
  type CommittedFactCommandStore,
  type InventoryAdjustmentResult,
  type InventoryGrantResult,
  type PerformanceAssessmentResult,
  type RelationshipRevisionResult,
} from "../../modules/application/committed-fact-command.ts";
import type { ProjectScope } from "../../modules/projects/public.ts";
import { lockWorkspaceCommandKey, withWorkspaceTransaction, type WorkspaceDatabase } from "./workspace-transaction.ts";
import { requirePerformanceWriteAdmission, validatePerformanceStoreInput } from "./performance-evidence-admission.ts";
import { validatePerformanceEvidenceReceipt } from "../../modules/application/performance-evidence-receipt.ts";
import { readPerformanceTransport } from "./performance-evidence-transport-repository.ts";

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
        await lockWorkspaceCommandKey(client, "fact", input.scope, input.idempotencyKey);
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input, "inventory.adjusted") as InventoryAdjustmentResult;
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
        await lockWorkspaceCommandKey(client, "fact", input.scope, input.idempotencyKey);
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input, "inventory.granted") as InventoryGrantResult;
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
        await lockWorkspaceCommandKey(client, "fact", input.scope, input.idempotencyKey);
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input, "relationship.revised") as RelationshipRevisionResult;
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
        validatePerformanceStoreInput(input);
        await lockWorkspaceCommandKey(client, "fact", input.scope, input.idempotencyKey);
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) return replay(existing, input, "performance.assessed") as PerformanceAssessmentResult;
        const witness = requirePerformanceWriteAdmission(client, input);
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
        await insertCommand(client, input, "performance_assessed", result, { version: 1, manifestHash: witness.hash });
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
        const sidecar = await client.query(
          `INSERT INTO performance_evidence_snapshots (workspace_id, world_id, worldline_id, record_id, assessment_id, command_id, version, manifest_canonical, manifest_hash)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.recordId, assessmentId, input.commandId, witness.canonical, witness.hash],
        );
        if (sidecar.rowCount !== 1) throw new CommittedFactCommandError("COMMAND_INVALID", "The performance witness was not appended.");
        return result;
      });
    },
  };
}

type LoadedFactReceipt = NonNullable<Awaited<ReturnType<CommittedFactCommandStore["loadCommand"]>>>;

function replay(
  existing: LoadedFactReceipt,
  input: { scope: ProjectScope; requestFingerprint: string; request: Readonly<Record<string, unknown>> },
  expectedOperation: string,
): StoredResult {
  const { result, ...receipt } = existing;
  if (!compareReplay({
    family: "fact", trustedScope: input.scope, candidate: input.request, expectedOperation,
    existing: receipt, factFingerprint: committedFactRequestFingerprintFor,
    suppliedTargetFingerprint: input.requestFingerprint,
  })) invalidReceipt();
  return { ...result, status: "replayed" };
}

/** Internal receipt projection shared by the ordinary store and bulk save reader. */
export interface ScopedFactReceiptRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  request_fingerprint: string;
  kind: FactKind;
  result_manifest: unknown;
  receipt_oversized: boolean;
}

function invalidReceipt(): never {
  throw new CommittedFactCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key has no valid replay proof for this command.");
}

function receiptObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidReceipt();
  return value as Record<string, unknown>;
}

function scopedReceipt(scope: ProjectScope, row: ScopedFactReceiptRow): Record<string, unknown> {
  if (row.workspace_id !== scope.workspaceId || row.world_id !== scope.worldId
    || row.worldline_id !== scope.worldlineId || row.receipt_oversized
    || !["inventory_adjusted", "inventory_granted", "relationship_revised", "performance_assessed"].includes(row.kind)) invalidReceipt();
  const manifest = receiptObject(row.result_manifest);
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > REPLAY_LINEAGE_MAX_BYTES) invalidReceipt();
  return manifest;
}

function legacyBinding(row: ScopedFactReceiptRow, manifest: Record<string, unknown>) {
  if (Object.keys(manifest).some((key) => !["provenance", "result", "request", "replayLineage", "replayContext"].includes(key))
    || manifest.provenance !== "legacy-result-v1" || manifest.request !== null
    || receiptObject(manifest.result).commandId !== row.id) invalidReceipt();
  const binding = decodeStoredReplayBinding(manifest.replayLineage);
  if (binding.originalRequestFingerprint !== row.request_fingerprint) invalidReceipt();
  return binding;
}

export function decodeScopedFactCommandReceipt(
  scope: ProjectScope,
  row: ScopedFactReceiptRow,
  anchorFor: (id: string) => ScopedFactReceiptRow | undefined,
  contexts = new Map<string, { row: ScopedFactReceiptRow; context: ReplayContextV1 }>(),
): LoadedFactReceipt {
  try {
    const manifest = scopedReceipt(scope, row);
    const base = { requestFingerprint: row.request_fingerprint, kind: row.kind };
    if (Object.hasOwn(manifest, "replayLineage") || Object.hasOwn(manifest, "replayContext")) {
      const binding = legacyBinding(row, manifest);
      const anchor = binding.anchorCommandId === row.id ? row : anchorFor(binding.anchorCommandId);
      if (!anchor || anchor.id !== binding.anchorCommandId) invalidReceipt();
      if (row.id !== anchor.id && Object.hasOwn(manifest, "replayContext")) invalidReceipt();
      const cached = contexts.get(anchor.id);
      let context: ReplayContextV1;
      if (cached?.row === anchor) {
        context = cached.context;
      } else {
        const anchorManifest = anchor === row ? manifest : scopedReceipt(scope, anchor);
        const anchorBinding = legacyBinding(anchor, anchorManifest);
        if (anchorBinding.anchorCommandId !== anchor.id || anchorBinding.contextId !== binding.contextId) invalidReceipt();
        context = decodeReplayContext(anchorManifest.replayContext);
        if (context.family !== "fact" || context.currentScope.workspaceId !== scope.workspaceId
          || context.currentScope.worldId !== scope.worldId || context.currentScope.worldlineId !== scope.worldlineId) invalidReceipt();
        contexts.set(anchor.id, { row: anchor, context });
      }
      if (context.id !== binding.contextId) invalidReceipt();
      const archiveBinding = { version: binding.version, contextId: binding.contextId,
        originalRequestFingerprint: binding.originalRequestFingerprint };
      return { ...base, result: manifest.result as StoredResult, request: null, provenance: "legacy-result-v1",
        replayProof: { binding: archiveBinding, context } };
    }
    if (manifest.provenance === "legacy-result-v1") {
      if (manifest.request !== undefined && manifest.request !== null) invalidReceipt();
      return { ...base, result: receiptObject(manifest.result) as unknown as StoredResult,
        request: null, provenance: "legacy-result-v1" };
    }
    if (Object.hasOwn(manifest, "provenance") && manifest.provenance !== "request-result-v1") invalidReceipt();
    if (Object.hasOwn(manifest, "result") || Object.hasOwn(manifest, "request")) {
      return { ...base, result: receiptObject(manifest.result) as unknown as StoredResult,
        request: receiptObject(manifest.request), provenance: "request-result-v1" };
    }
    return { ...base, result: manifest as unknown as StoredResult, request: null, provenance: "legacy-result-v1" };
  } catch {
    return invalidReceipt();
  }
}

async function readCommand(
  client: PoolClient,
  scope: ProjectScope,
  idempotencyKey: string,
): Promise<LoadedFactReceipt | null> {
  // One scoped table hop only. Neither the SQL scope nor a table name comes from metadata.
  const result = await client.query<ScopedFactReceiptRow & { anchor_row: ScopedFactReceiptRow | null }>(
    `SELECT command.workspace_id, command.world_id, command.worldline_id, command.id,
            command.request_fingerprint, command.kind,
            CASE WHEN octet_length(command.result_manifest::text) <= $5
              THEN command.result_manifest ELSE NULL END AS result_manifest,
            octet_length(command.result_manifest::text) > $5 AS receipt_oversized,
            CASE WHEN anchor.id IS NULL THEN NULL ELSE jsonb_build_object(
              'workspace_id', anchor.workspace_id, 'world_id', anchor.world_id, 'worldline_id', anchor.worldline_id,
              'id', anchor.id, 'request_fingerprint', anchor.request_fingerprint, 'kind', anchor.kind,
              'result_manifest', CASE WHEN octet_length(anchor.result_manifest::text) <= $5
                THEN anchor.result_manifest ELSE NULL END,
              'receipt_oversized', octet_length(anchor.result_manifest::text) > $5) END AS anchor_row
     FROM committed_fact_commands AS command
     LEFT JOIN committed_fact_commands AS anchor
       ON anchor.workspace_id = command.workspace_id AND anchor.world_id = command.world_id
      AND anchor.worldline_id = command.worldline_id
      AND anchor.id = command.result_manifest #>> '{replayLineage,anchorCommandId}'
     WHERE command.workspace_id = $1 AND command.world_id = $2 AND command.worldline_id = $3
       AND command.idempotency_key = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, idempotencyKey, REPLAY_LINEAGE_MAX_BYTES * 2],
  );
  const row = result.rows[0];
  if (!row) return null;
  const receipt = decodeScopedFactCommandReceipt(scope, row, (id) => row.anchor_row?.id === id ? row.anchor_row : undefined);
  const manifest = receiptObject(row.result_manifest);
  if (Object.hasOwn(manifest, "performanceTransport")) {
    try { await readPerformanceTransport(client,scope,row.id,row); } catch { invalidReceipt(); }
  }
  if (Object.hasOwn(manifest, "performanceWitness")) {
    const marker = receiptObject(manifest.performanceWitness);
    if (row.kind !== "performance_assessed" || Object.keys(marker).sort().join(",") !== "manifestHash,version"
      || marker.version !== 1 || typeof marker.manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(marker.manifestHash)
      || receipt.provenance !== "request-result-v1" || !receipt.request) invalidReceipt();
    const assessment = receipt.result as PerformanceAssessmentResult;
    const witness = await client.query<{ record_id: string; assessment_id: string; command_id: string; version: number; manifest_canonical: string | null; manifest_hash: string; policy_version: string; score: number; evidence_event_ids: string[]; evidence_snapshot_hash: string; assessment_record_id: string; assessment_command_id: string }>(
      `SELECT snapshot.record_id, snapshot.assessment_id, snapshot.command_id, snapshot.version,
              CASE WHEN octet_length(snapshot.manifest_canonical) <= 262144 THEN snapshot.manifest_canonical ELSE NULL END AS manifest_canonical,
              snapshot.manifest_hash, assessment.policy_version, assessment.score, assessment.evidence_event_ids, assessment.evidence_snapshot_hash,
              assessment.record_id AS assessment_record_id, assessment.command_id AS assessment_command_id
       FROM performance_evidence_snapshots AS snapshot
       JOIN performance_assessments AS assessment ON (assessment.workspace_id, assessment.world_id, assessment.worldline_id, assessment.id) = (snapshot.workspace_id, snapshot.world_id, snapshot.worldline_id, snapshot.assessment_id)
       WHERE snapshot.workspace_id = $1 AND snapshot.world_id = $2 AND snapshot.worldline_id = $3 AND snapshot.assessment_id = $4 AND snapshot.command_id = $5`,
      [scope.workspaceId, scope.worldId, scope.worldlineId, assessment.assessmentId, row.id],
    );
    const w = witness.rows[0];
    if (witness.rowCount !== 1 || !w || w.version !== 1 || typeof w.manifest_canonical !== "string") invalidReceipt();
    try {
      validatePerformanceEvidenceReceipt({
        scope, commandId: row.id, requestFingerprint: row.request_fingerprint,
        request: receipt.request, result: assessment, marker,
        witness: { recordId: w.record_id, assessmentId: w.assessment_id, commandId: w.command_id,
          version: w.version, manifestCanonical: w.manifest_canonical, manifestHash: w.manifest_hash },
        assessment: { id: w.assessment_id, recordId: w.assessment_record_id, commandId: w.assessment_command_id,
          policyVersion: w.policy_version, score: w.score, evidenceEventIds: w.evidence_event_ids,
          evidenceSnapshotHash: w.evidence_snapshot_hash },
      });
    } catch { invalidReceipt(); }
  }
  return receipt;
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
    request: Readonly<Record<string, unknown>>;
  },
  kind: "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed",
  result: StoredResult,
  performanceWitness?: { version: 1; manifestHash: string },
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
      JSON.stringify({ result, request: input.request, ...(performanceWitness ? { performanceWitness } : {}) }),
    ],
  );
}
