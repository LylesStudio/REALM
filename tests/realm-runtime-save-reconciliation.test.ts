import assert from "node:assert/strict";
import test from "node:test";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { serializeRealmRuntimeSaveGoalsV1, buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData } from "../modules/world-transfer/realm-runtime-save.ts";

const scope = { workspaceId: "ws_r1", worldId: "world_r1", worldlineId: "line_r1", recordId: "record_r1" };
const draft = { title: "Preserved direction", description: "R1 native contract", successConditions: ["A formal result"], failureConditions: [], changePolicy: "fixed" as const, visible: true };

test("R1 native definition count keeps the 10000 contract independently of generic JSON arrays", () => {
  const nativeDefinitions = Array.from({ length: 10000 }, (_, index) => createRecordGoalDefinition({ scope, goalId: `r1-${index}`, activationHead: { recordVersion: 0, ordinal: 0 }, draft }));
  const definitions = JSON.parse(JSON.stringify(nativeDefinitions)) as import("../modules/runtime/public.ts").JsonValue[];
  const goals = { format: "realm-runtime-goals" as const, schemaVersion: 1 as const, definitions, instances: nativeDefinitions.map(definition => ({ id: definition.goalInstanceId, goalKey: definition.goalKey, policyVersion: definition.policyVersion, state: "active", revision: 1, progress: {}, outcome: null, definitionSource: "record", definitionId: definition.definitionId, resolutionKind: "natural", evidenceStartVersion: 0, evidenceStartOrdinal: 0 })), assessments: [] };
  const serialized = serializeRealmRuntimeSaveGoalsV1(goals);
  assert.equal(JSON.parse(serialized).definitions.length, 10000);
  assert.throws(() => serializeRealmRuntimeSaveGoalsV1({ ...goals, definitions: [...definitions, JSON.parse(JSON.stringify(createRecordGoalDefinition({ scope, goalId: "over-limit", activationHead: { recordVersion: 0, ordinal: 0 }, draft })))] }), /definition|limit|invalid/i);
  const record = { format: "realm-runtime-record" as const, schemaVersion: 1 as const, scope: { worldId: scope.worldId, worldlineId: scope.worldlineId, recordId: scope.recordId }, head: { recordVersion: 0, nextRecordOrdinal: 0 }, events: [] };
  const manifest = realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: scope.recordId }, record, goals });
  assert.equal(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ manifest, record, goals })).goals.definitions?.length, 10000);
  assert.throws(() => buildRealmRuntimeSaveArchive({ manifest: { ...manifest, scope: { ...manifest.scope, workspaceId: "foreign_ws" } }, record, goals }), /scope|binding/i);
});

test("R1 server reader rejects caller authority, accessors and omitted identity before pool acquire", async () => {
  let acquired = 0;
  const database = { async connect() { acquired++; throw new Error("unexpected acquire"); } };
  const reader = createPostgresRealmRuntimeSaveReader(database as never);
  const input = { workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner_r1", purpose: "record-export" };
  const invalid: unknown[] = [null, {}, { ...input, principalId: undefined }, { ...input, purpose: "trusted" }, { ...input, backupAuthorization: true }, { ...input, purpose: "native-record-branch" }, { ...input, principalId: " owner_r1" }, Object.defineProperty({ ...input }, "recordId", { enumerable: true, get() { throw new Error("accessor executed"); } })];
  for (const value of invalid) await assert.rejects(reader.load(value as never), /explicit server-side export authority/);
  const previous = process.env.REALM_OPERATOR_PRINCIPALS;
  delete process.env.REALM_OPERATOR_PRINCIPALS;
  try { await assert.rejects(reader.load({ ...input, purpose: "whole-closure-backup" }), /not permitted/); }
  finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
  assert.equal(acquired, 0);
});
