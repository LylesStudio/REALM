import { walkFactReplayRequest, compareReplay, type ReplayClosure } from "../application/command-replay-lineage.ts";
import { committedFactRequestFingerprintFor, evidenceHash } from "../application/committed-fact-command.ts";
import type { RealmRuntimeSaveRecordV1 } from "./realm-runtime-save.ts";
import type { RealmRuntimeSaveDomainV1 } from "./realm-runtime-domain-save.ts";
import type { RuntimePerformanceWitnessesV1 } from "./runtime-performance-witness-transport.ts";

type DomainAssessment = RealmRuntimeSaveDomainV1["performanceAssessments"][number];

/** Source-only gate: never remap identities, replace historical hashes or infer scores. */
export function validatePerformanceSourceConsistency(
  record: RealmRuntimeSaveRecordV1,
  domain: RealmRuntimeSaveDomainV1,
  closure: ReplayClosure,
  workspaceId: string | undefined,
  performanceWitnesses?: RuntimePerformanceWitnessesV1,
): void {
  let field = "performanceAssessments.commandId";
  try {
    const scope = { workspaceId: workspaceId ?? "", worldId: record.scope.worldId, worldlineId: record.scope.worldlineId };
    const records = new Set(closure.record);
    const eventOwners = new Map([record, ...(domain.records ?? []).map((row) => row.bundle.record)]
      .flatMap((record) => record.events.map((event) => [event.eventId, record.scope.recordId] as const)));
    const contexts = new Map((domain.commandReplayContexts ?? []).map((context) => [context.id, context]));
    const commands = new Map(domain.committedFactCommands.map((command) => [command.id, command]));
    const linked = new Map<string, DomainAssessment[]>();
    for (const assessment of domain.performanceAssessments) {
      field = `performanceAssessments.${assessment.id}.commandId`;
      if (commands.get(assessment.commandId)?.kind !== "performance_assessed") throw Error();
      const rows = linked.get(assessment.commandId) ?? [];
      rows.push(assessment); linked.set(assessment.commandId, rows);
    }
    for (const command of domain.committedFactCommands) {
      if (command.kind !== "performance_assessed") continue;
      // Historical opaque transport remains outside this batch's accepted
      // full-receipt contract. Explicit metadata can never take this branch.
      if (domain.stories === undefined && command.provenance === undefined && command.request === undefined
        && Object.keys(command.resultManifest).length === 2
        && Object.hasOwn(command.resultManifest, "recordId") && Object.hasOwn(command.resultManifest, "score")) continue;
      field = `committedFactCommands.${command.id}.sourceTuple`;
      if (!workspaceId) throw Error();
      const assessments = linked.get(command.id) ?? [];
      if (assessments.length !== 1) throw Error();
      const assessment = assessments[0]!;
      const candidate = command.provenance === "request-result-v1" ? command.request : {
        command: "performance.assessed", recordId: assessment.recordId, policyVersion: assessment.policyVersion,
        score: assessment.score, evidenceEventIds: assessment.evidenceEventIds,
      };
      field = `committedFactCommands.${command.id}.request`;
      const request = walkFactReplayRequest(command.kind, candidate, (kind, id) => {
        if (kind === "record" ? !records.has(id) : kind !== "event" || !eventOwners.has(id)) throw Error();
        return id;
      });
      if (request.command !== "performance.assessed"
        || request.evidenceEventIds.some((id) => eventOwners.get(id) !== request.recordId)) throw Error();
      const proof = command.replayLineage ? {
        binding: command.replayLineage, context: contexts.get(command.replayLineage.contextId),
      } : undefined;
      if (!compareReplay({ family: "fact", trustedScope: scope, candidate,
        expectedOperation: "performance.assessed", factFingerprint: committedFactRequestFingerprintFor,
        existing: { requestFingerprint: command.requestFingerprint, request: command.request ?? null,
          provenance: command.provenance ?? "legacy-result-v1", kind: command.kind,
          ...(proof ? { replayProof: proof } : {}) } })) throw Error();
      field = `committedFactCommands.${command.id}.resultManifest`;
      const result = { ...command.resultManifest };
      if (performanceWitnesses?.witnesses.some(w => w.projection.commandId === command.id)) delete result.performanceTransport;
      const keys = ["status", "commandId", "assessmentId", "score", "evidenceSnapshotHash", "goalTransition"];
      if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw Error();
      if ((result.status !== "committed" && result.status !== "replayed") || result.goalTransition !== null
        || result.commandId !== command.id || result.assessmentId !== assessment.id
        || assessment.id !== `${command.id}:assessment`) throw Error();
      field = `performanceAssessments.${assessment.id}.evidenceSnapshotHash`;
      const hash = evidenceHash(assessment.evidenceEventIds);
      if (assessment.evidenceSnapshotHash !== hash || result.evidenceSnapshotHash !== hash) throw Error();
      field = `committedFactCommands.${command.id}.request/result/assessment`;
      if (result.score !== request.score || assessment.recordId !== request.recordId
        || assessment.policyVersion !== request.policyVersion || assessment.score !== request.score
        || JSON.stringify(assessment.evidenceEventIds) !== JSON.stringify(request.evidenceEventIds)) throw Error();
    }
  } catch { throw new Error(`Runtime performance source facts are inconsistent at ${field}.`); }
}
