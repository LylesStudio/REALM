import type { PoolClient } from "pg";
import { performanceWitnessEnvelopeCanonical, type RuntimePerformanceWitnessesV1 } from "../../modules/world-transfer/runtime-performance-witness-transport.ts";
import { readPerformanceTransport } from "./performance-evidence-transport-repository.ts";

export const INSERT_PERFORMANCE_TRANSPORT_SQL = `INSERT INTO performance_evidence_transport_provenance (
  workspace_id,world_id,worldline_id,record_id,command_id,assessment_id,
  source_workspace_id,source_world_id,source_worldline_id,source_record_id,source_command_id,source_assessment_id,
  version,envelope_canonical,envelope_hash,source_manifest_hash
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15)`;

/** Called after the real command and assessment INSERTs on their same client. */
export async function writePerformanceTransport(client: PoolClient, family: RuntimePerformanceWitnessesV1): Promise<void> {
  for (const entry of family.witnesses) {
    const p=entry.projection,o=entry.origin;
    const inserted=await client.query(INSERT_PERFORMANCE_TRANSPORT_SQL,[p.scope.workspaceId,p.scope.worldId,p.scope.worldlineId,p.recordId,p.commandId,p.assessmentId,
      o.scope.workspaceId,o.scope.worldId,o.scope.worldlineId,o.request.recordId,o.commandId,o.assessment.id,
      performanceWitnessEnvelopeCanonical(entry),entry.digest,o.witness.manifestHash]);
    if(inserted.rowCount!==1) throw new Error("Performance provenance append failed.");
  }
  await verifyPerformanceTransport(client,family);
}
export async function verifyPerformanceTransport(client: PoolClient, family: RuntimePerformanceWitnessesV1): Promise<void> {
  for(const entry of family.witnesses) {
    const actual=await readPerformanceTransport(client,entry.projection.scope,entry.projection.commandId);
    if(performanceWitnessEnvelopeCanonical(actual)!==performanceWitnessEnvelopeCanonical(entry)) throw new Error("Performance provenance readback failed.");
  }
}
