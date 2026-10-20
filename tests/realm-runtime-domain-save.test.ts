import { createHash } from "node:crypto";
import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { PERFORMANCE_EVIDENCE_SOURCE_SQL } from "../database/postgres/performance-evidence-transport-repository.ts";
import { performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1 } from "../modules/application/performance-evidence-snapshot.ts";
import * as replayContract from "../modules/application/command-replay-lineage.ts";
import type { ReplayContextV1, ReplayClosure, ReplayForwardMaps, ReplayIdentityKind, FactKind } from "../modules/application/command-replay-lineage.ts";
import { committedFactCommandIdFor, committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { projectFinanceCommandFingerprintFor, projectFinanceCommandGroupIdFor } from "../modules/projects/public.ts";
import { storyDefinitionHashFor, storyUnlockEvidenceHashFor, storyUnlockIdempotencyKeyFor, storyUnlockLedgerIdFor, storyNodeInstanceIdFor, normalizeStoryDefinition } from "../modules/story-graph/public.ts";
import { parseRealmRuntimeSaveDomainV1, serializeRealmRuntimeSaveDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { runtimeFinanceReplayClosure, runtimeFactReplayClosure, runtimeReplaySourceSceneIds } from "../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveWholeDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
  realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveRecordV1,
} from "../modules/world-transfer/realm-runtime-save.ts";
import {
  normalizeRealmRuntimeSaveDomainV1,
  type RealmRuntimeSaveDomainV1,
} from "../modules/world-transfer/realm-runtime-domain-save.ts";

const record: RealmRuntimeSaveRecordV1 = {
  format: "realm-runtime-record",
  schemaVersion: 1,
  scope: { worldId: "world-demo", worldlineId: "worldline-source", recordId: "record-demo" },
  head: { recordVersion: 0, nextRecordOrdinal: 0 },
  events: [],
};

const goals: RealmRuntimeSaveGoalsV1 = {
  format: "realm-runtime-goals",
  schemaVersion: 1,
  instances: [],
  assessments: [],
};

const domain: RealmRuntimeSaveDomainV1 = {
  format: "realm-runtime-domain",
  schemaVersion: 1,
  source: {
    worldId: "world-demo",
    worldlineId: "worldline-source",
    storyId: "story-demo",
    recordId: "record-demo",
  },
  projects: [],
  milestones: [],
  projectStoryLinks: [],
  budgetAllocations: [],
  financeAccounts: [],
  ledgerEntries: [],
  financeCommandGroups: [],
  obligations: [],
  obligationSettlements: [],
  storyNodes: [],
  storyUnlockLedger: [],
  committedFactCommands: [],
  performanceAssessments: [],
  memberRelationshipRevisions: [],
  characterAssets: [],
};

function manifestForDomain() {
  return realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "base",
    world: null,
    scope: {
      workspaceId: "workspace-demo",
      worldlineId: "worldline-source",
      recordId: "record-demo",
    },
    record,
    goals,
    domain,
  });
}

test("runtime-save domain archive round-trips server-owned finance/story/fact state", () => {
  const manifest = manifestForDomain();
  const bytes = buildRealmRuntimeSaveArchive({ manifest, record, goals, domain });
  const parsed = parseRealmRuntimeSaveArchive(bytes);
  assert.deepEqual(parsed.domain, domain);
  assert.equal(parsed.manifest.snapshot.runtimeHash, manifest.snapshot.runtimeHash);
});

test("runtime-save domain contract rejects a client-derived balance", () => {
  assert.throws(
    () => buildRealmRuntimeSaveArchive({
      manifest: manifestForDomain(),
      record,
      goals,
      domain: { ...domain, financeAccounts: [{ id: "account-1", currency: "JPY", status: "active", openingBalanceMinor: 1, balanceMinor: 1 }] },
    } as never),
    /balanceMinor|unknownKey/,
  );
});

test("domain assets preserve optional stable keys without rewriting legacy documents", () => {
  const asset = {
    recordId: "record-demo", characterInstanceId: "character-demo",
    assetDefinitionId: "definition-source", quantity: 2, revision: 1, metadata: {},
  };
  const legacy = { ...domain, characterAssets: [asset] };
  assert.deepEqual(normalizeRealmRuntimeSaveDomainV1(legacy), legacy);
  const portable = { ...domain, characterAssets: [{ ...asset, assetKey: "travel-kit" }] };
  assert.deepEqual(normalizeRealmRuntimeSaveDomainV1(portable), portable);
  for (const assetKey of [null, "", 17, {}, []]) {
    assert.throws(() => normalizeRealmRuntimeSaveDomainV1({
      ...domain, characterAssets: [{ ...asset, assetKey }],
    }), /assetKey/);
  }
});

test("A4-T historical domain shape refuses witness keys before open JSON normalization", () => {
  const command = { id: "historical-performance", idempotencyKey: "historical-performance", requestFingerprint: "c".repeat(64),
    kind: "performance_assessed" as const, resultManifest: { recordId: "record-demo", score: 10 } };
  const source = { ...domain, committedFactCommands: [command] };
  assert.deepEqual(normalizeRealmRuntimeSaveDomainV1(source), source);
  for (const marker of [{ version: 1, manifestHash: "d".repeat(64) }, { version: 99 }, null]) {
    assert.throws(() => normalizeRealmRuntimeSaveDomainV1({ ...source, committedFactCommands: [{ ...command,
      resultManifest: { ...command.resultManifest, performanceWitness: marker },
    }] }), /performance witness transport is unsupported/);
  }
  const hidden = { ...command };
  Object.defineProperty(hidden, "performanceWitness", { value: null, enumerable: false });
  assert.throws(() => normalizeRealmRuntimeSaveDomainV1({ ...source, committedFactCommands: [hidden] }), /performance witness transport is unsupported/);
});

// Frozen whole-domain contracts retain their independent fixtures and assertions.
{
type RealmRuntimeSaveDomainV1 = RealmRuntimeSaveWholeDomainV1;


const SCOPE = { workspaceId: "workspace-demo", worldId: "world-demo", worldlineId: "worldline-demo" };
const STORY_ID = "story-demo";
const RECORD_ID = "record-demo";

const definition = normalizeStoryDefinition({
  storyKey: "story.closure.unit",
  title: "Closure unit story",
  premise: "Unit fixture.",
  policyVersion: "story-graph-v1",
  nodes: [
    { kind: "record", nodeKey: "opening", recordKey: "opening-record", title: "Opening", sequence: 1, initial: true },
    {
      kind: "record",
      nodeKey: "finale",
      recordKey: "finale-record",
      title: "Finale",
      sequence: 2,
      unlock: { kind: "milestone_status", milestoneId: "milestone-1", status: "completed" },
    },
  ],
});
const definitionHash = storyDefinitionHashFor(definition);
const nodeScope = { ...SCOPE, storyId: STORY_ID };
const finaleNodeId = storyNodeInstanceIdFor(nodeScope, "finale");
const finaleEvidence = {
  eventIds: [] as string[],
  goalKeys: [] as string[],
  nodeKeys: [] as string[],
  milestoneIds: ["milestone-1"],
};
const finaleEvidenceHash = storyUnlockEvidenceHashFor({
  definitionHash,
  nodeKey: "finale",
  evidence: finaleEvidence,
});
const finaleUnlockId = storyUnlockLedgerIdFor(finaleNodeId, "unlocked", finaleEvidenceHash);

const expenseRequest = {
  command: "finance.expense.recorded",
  accountId: "account-1",
  amountMinor: 3000,
  category: "studio",
  memo: "rehearsal fee",
  projectId: "project-1",
  recordId: RECORD_ID,
  occurredAt: "2026-10-16T00:00:00.000Z",
  expectedBalanceMinor: 10000,
  evidence: {
    recordId: RECORD_ID,
    sceneId: "scene-1",
    visibility: "public",
    worldTick: 0,
    worldOrdinal: 1,
  },
};
const expenseFingerprint = projectFinanceCommandFingerprintFor(SCOPE, expenseRequest);
const expenseGroupId = projectFinanceCommandGroupIdFor(SCOPE, "finance-expense-1", expenseFingerprint);

const grantRequest = {
  command: "inventory.granted",
  recordId: RECORD_ID,
  characterInstanceId: "character-1",
  assetDefinitionId: "asset-1",
  quantity: 3,
  sourceEventId: "event-1",
};
const grantFingerprint = committedFactRequestFingerprintFor(SCOPE, grantRequest);
const grantCommandId = committedFactCommandIdFor(SCOPE, "fact-grant-1", grantFingerprint);

const assessmentEventIds = ["event-1", "event-2"].sort((left, right) => left.localeCompare(right));
const assessmentHash = evidenceHash(assessmentEventIds);

function domainFixture(): RealmRuntimeSaveDomainV1 {
  return {
    format: "realm-runtime-domain",
    schemaVersion: 1,
    source: {
      worldId: SCOPE.worldId,
      worldlineId: SCOPE.worldlineId,
      storyId: STORY_ID,
      recordId: RECORD_ID,
    },
    projects: [{
      id: "project-1",
      kind: "production",
      status: "active",
      stage: "funding",
      title: "First production",
      currency: "JPY",
      deadline: null,
      version: 2,
    }],
    milestones: [{
      id: "milestone-1",
      projectId: "project-1",
      sequence: 1,
      title: "First rehearsal",
      status: "completed",
      dueOn: null,
      completionRecordId: RECORD_ID,
      completionEventId: "event-2",
    }],
    projectStoryLinks: [{
      id: "link-1",
      projectId: "project-1",
      storyId: STORY_ID,
      linkKind: "primary",
    }],
    budgetAllocations: [{
      id: `${expenseGroupId}:budget`,
      projectId: "project-1",
      category: "studio",
      amountMinor: 9000,
      currency: "JPY",
      version: 1,
    }],
    financeAccounts: [{
      id: "account-1",
      currency: "JPY",
      status: "active",
      openingBalanceMinor: 10000,
    }],
    ledgerEntries: [{
      id: `${expenseGroupId}:entry`,
      accountId: "account-1",
      kind: "expense",
      direction: "expense",
      amountMinor: 3000,
      currency: "JPY",
      category: "studio",
      memo: "rehearsal fee",
      projectId: "project-1",
      sourceRecordId: RECORD_ID,
      sourceEventId: "event-2",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: "finance-expense-1",
    }],
    financeCommandGroups: [{
      id: expenseGroupId,
      idempotencyKey: "finance-expense-1",
      requestFingerprint: expenseFingerprint,
      state: "committed",
      resultManifest: {
        status: "committed",
        commandGroupId: expenseGroupId,
        entry: {
          workspaceId: SCOPE.workspaceId,
          worldId: SCOPE.worldId,
          worldlineId: SCOPE.worldlineId,
          id: `${expenseGroupId}:entry`,
          accountId: "account-1",
          kind: "expense",
          direction: "expense",
          amountMinor: 3000,
          currency: "JPY",
          category: "studio",
          memo: "rehearsal fee",
          projectId: "project-1",
          recordId: RECORD_ID,
          sourceEventId: "event-2",
          occurredAt: "2026-10-16T00:00:00.000Z",
          idempotencyKey: "finance-expense-1",
        },
        cash: {
          currency: "JPY",
          openingBalanceMinor: 10000,
          incomeMinor: 0,
          expenseMinor: 3000,
          adjustmentMinor: 0,
          balanceMinor: 7000,
        },
        eventKind: "finance.expense.recorded",
        worldCursor: { worldTick: 0, worldOrdinal: 2 },
      },
      rejectionCode: null,
      policyVersion: "project-finance-command:v1",
      sourceRecordId: RECORD_ID,
      provenance: "request-result-v1",
      request: expenseRequest,
    }],
    obligations: [{
      id: `${expenseGroupId}:obligation`,
      projectId: "project-1",
      kind: "loan",
      status: "open",
      principalMinor: 5000,
      outstandingMinor: 3000,
      shareBps: null,
      undeliveredCount: 0,
      dueOn: null,
      version: 2,
    }],
    obligationSettlements: [{
      id: `${expenseGroupId}:settlement`,
      obligationId: `${expenseGroupId}:obligation`,
      ledgerEntryId: `${expenseGroupId}:entry`,
      kind: "repayment",
      amountMinor: 2000,
    }],
    storyNodes: [{
      id: finaleNodeId,
      storyId: STORY_ID,
      nodeKey: "finale",
      state: "active",
      revision: 1,
      recordId: "record-evidence-1",
      definitionHash,
      unlockEvidenceEventIds: [],
      unlockEvidence: finaleEvidence,
    }],
    storyUnlockLedger: [{
      id: finaleUnlockId,
      storyId: STORY_ID,
      storyNodeInstanceId: finaleNodeId,
      nodeKey: "finale",
      transition: "unlocked",
      idempotencyKey: storyUnlockIdempotencyKeyFor(finaleNodeId, "unlocked", finaleEvidenceHash),
      recordId: "record-evidence-1",
      evidenceEventIds: [],
      evidenceHash: finaleEvidenceHash,
      evidence: finaleEvidence,
    }],
    committedFactCommands: [{
      id: grantCommandId,
      idempotencyKey: "fact-grant-1",
      requestFingerprint: grantFingerprint,
      kind: "inventory_granted",
      resultManifest: {
        status: "committed",
        commandId: grantCommandId,
        quantity: 3,
        revision: 0,
      },
      provenance: "request-result-v1",
      request: grantRequest,
    }],
    performanceAssessments: [],
    memberRelationshipRevisions: [],
    characterAssets: [{
      recordId: RECORD_ID,
      characterInstanceId: "character-1",
      assetDefinitionId: "asset-1",
      quantity: 3,
      revision: 0,
      metadata: {},
    }],
    stories: [{
      id: STORY_ID,
      title: "Closure unit story",
      status: "active",
      premise: "Unit fixture.",
    }],
    storyDefinitions: [{
      storyId: STORY_ID,
      definitionHash,
      definition: definition as unknown as RealmRuntimeSaveDomainV1["storyDefinitions"][number]["definition"],
    }],
    records: [{
      recordId: "record-evidence-1",
      storyId: STORY_ID,
      title: "Finale",
      status: "closed",
      worldVersion: "base",
      startTick: 0,
      startOrdinal: 0,
      timelineKind: "primary",
      linkedRecordId: null,
      lastEventId: null,
      lastWorldTick: null,
      lastWorldOrdinal: null,
      bundle: {
        record: {
          format: "realm-runtime-record",
          schemaVersion: 1,
          scope: { worldId: SCOPE.worldId, worldlineId: SCOPE.worldlineId, recordId: "record-evidence-1" },
          head: { recordVersion: 0, nextRecordOrdinal: 0 },
          events: [],
        },
        goals: { format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [] },
      },
    }],
  };
}

const record: RealmRuntimeSaveRecordV1 = {
  format: "realm-runtime-record",
  schemaVersion: 1,
  scope: { worldId: SCOPE.worldId, worldlineId: SCOPE.worldlineId, recordId: RECORD_ID },
  head: { recordVersion: 2, nextRecordOrdinal: 3 },
  events: [
    {
      eventId: "event-1",
      recordVersion: 1,
      ordinal: 1,
      kind: "narration.committed",
      payload: {
        content: "The lantern is lit.",
        speakerName: "",
        actorParticipantId: null,
        sceneId: "scene-1",
        visibilityPolicyId: "policy-1",
        worldTick: 0,
        worldOrdinal: 1,
        calendarId: "native_calendar",
        displayTime: "",
        eventPayload: {},
      },
    },
    {
      eventId: "event-2",
      recordVersion: 2,
      ordinal: 2,
      kind: "project.milestone.confirmed",
      payload: {
        content: "",
        speakerName: "",
        actorParticipantId: null,
        sceneId: "scene-1",
        visibilityPolicyId: "policy-1",
        worldTick: 0,
        worldOrdinal: 2,
        calendarId: "native_calendar",
        displayTime: "",
        eventPayload: { projectId: "project-1", milestoneId: "milestone-1" },
      },
    },
  ],
};

const goals: RealmRuntimeSaveGoalsV1 = {
  format: "realm-runtime-goals",
  schemaVersion: 1,
  instances: [],
  assessments: [],
};

// Character assets resolve their instance against the owning Record's
// topology; carry one participant whose instance owns the inventory.
const topology = {
  format: "realm-runtime-topology" as const,
  schemaVersion: 1 as const,
  participants: [{
    sourceParticipantId: "participant-1",
    participantKind: "character" as const,
    sourcePrincipalId: null,
    controllerMode: "ai" as const,
    isActive: true,
    speakingOrder: 0,
    sharedControlEnabled: false,
    character: {
      sourceCharacterInstanceId: "character-1",
      sourceContinuityId: "continuity-1",
      sourcePredecessorInstanceId: null,
      sourceDefinitionId: "definition-1",
      definition: {
        displayName: "Archivist",
        sourceFormat: "native" as const,
        profile: {},
      },
      continuity: {
        continuityKey: "archivist",
        status: "active" as const,
        bornTick: 0,
        bornOrdinal: 0,
        endedTick: null,
        endedOrdinal: null,
      },
      instance: {
        controllerMode: "ai" as const,
        status: "present" as const,
        instantiatedTick: 0,
        instantiatedOrdinal: 0,
        inheritanceCutoffTick: 0,
        inheritanceCutoffOrdinal: 0,
        retiredTick: null,
        retiredOrdinal: null,
        state: {},
      },
    },
  }],
  scenes: [],
  visibilityPolicies: [],
};

function manifestFor(domain: RealmRuntimeSaveDomainV1) {
  return realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "base",
    world: null,
    scope: {
      workspaceId: SCOPE.workspaceId,
      worldlineId: SCOPE.worldlineId,
      recordId: RECORD_ID,
    },
    record,
    goals,
    topology,
    domain,
  });
}

test("runtime-save domain archive round-trips a fully populated domain with real hash identities", () => {
  const domain = domainFixture();
  const bytes = buildRealmRuntimeSaveArchive({ manifest: manifestFor(domain), record, goals, topology, domain });
  const parsed = parseRealmRuntimeSaveArchive(bytes);
  assert.deepEqual(parsed.domain, domain);
});

test("domain parser rejects duplicate identities, unsafe keys, and unbounded values", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as RealmRuntimeSaveDomainV1;

  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(serializeRealmRuntimeSaveDomainV1(domain).replace(
      '"financeAccounts"',
      '"projectsExtra": [], "financeAccounts"',
    )),
    /unknownKey/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      projects: [domain.projects[0]!, domain.projects[0]!],
    }))),
    /domain\.projects\.duplicate/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      projects: [{ ...domain.projects[0]!, id: "x".repeat(300) }],
    }))),
    /projects\[0\]\.id/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      budgetAllocations: [{ ...domain.budgetAllocations[0]!, projectId: "project-missing" }],
    }))),
    /domain\.budgetAllocations\.projectId/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      ledgerEntries: [{ ...domain.ledgerEntries[0]!, amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    }))),
    /ledgerEntries\[0\]\.amountMinor/,
  );
  // Prototype-polluting keys are rejected even though JSON.parse owns them.
  const poisoned = JSON.parse(JSON.stringify(domain)) as Record<string, unknown>;
  poisoned.characterAssets = [JSON.parse(
    `{"recordId":"${RECORD_ID}","characterInstanceId":"character-1","assetDefinitionId":"asset-1","quantity":1,"revision":0,"metadata":{"__proto__":{"polluted":true}}}`,
  )];
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(poisoned)),
    /__proto__/,
  );
  // Deeply nested payloads beyond the bounded depth fail closed.
  const deep: unknown = Array.from({ length: 40 }, () => 0)
    .reduce<unknown>((acc) => [acc], 0);
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      committedFactCommands: [{ ...domain.committedFactCommands[0]!, request: { command: "inventory.granted", nested: deep } }],
    }))),
    /depth|request/,
  );
});

test("domain parser closes Story/Record scope references and definition coverage", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  // Links may target any carried Story, but never an un-carried one.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      projectStoryLinks: [{ ...domain.projectStoryLinks[0]!, storyId: "story-other" }],
    }))),
    /projectStoryLinks\.storyId/,
  );
  // A node-bearing Story must carry the exact definition it was materialized
  // from; otherwise its remaining nodes could never unlock after a restore.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      storyDefinitions: [],
    }))),
    /storyDefinitions\.missing/,
  );
  // Assessments belong to the saved Record or a carried sibling Record only.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      performanceAssessments: [{
        id: `${grantCommandId}:assessment`,
        recordId: "record-not-carried",
        policyVersion: "structured-factors:v1",
        score: 40,
        evidenceEventIds: assessmentEventIds,
        evidenceSnapshotHash: assessmentHash,
        commandId: grantCommandId,
      }],
    }))),
    /performanceAssessments\.recordId/,
  );
  // Assessments referencing an un-carried command fail closed as well.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      performanceAssessments: [{
        id: "assessment-x",
        recordId: RECORD_ID,
        policyVersion: "structured-factors:v1",
        score: 40,
        evidenceEventIds: assessmentEventIds,
        evidenceSnapshotHash: assessmentHash,
        commandId: "fact_not_carried",
      }],
    }))),
    /performanceAssessments\.commandId/,
  );
});

test("domain closure rejects dangling sibling Record references", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  // A Story node bound to an un-carried Record.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      storyNodes: [{ ...domain.storyNodes[0]!, recordId: "record-not-carried" }],
    }))),
    /storyNodes\.recordId/,
  );
  // The saved Record itself must not reappear as a sibling snapshot.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      records: [{
        ...domain.records[0]!,
        recordId: RECORD_ID,
        bundle: {
          record: {
            ...domain.records[0]!.bundle.record,
            scope: { worldId: SCOPE.worldId, worldlineId: SCOPE.worldlineId, recordId: RECORD_ID },
          },
          goals: domain.records[0]!.bundle.goals,
        },
      }],
    }))),
    /records\.sourceRecord/,
  );
  // A sibling snapshot whose bundle scope disagrees with its snapshot id.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      records: [{
        ...domain.records[0]!,
        bundle: {
          record: {
            ...domain.records[0]!.bundle.record,
            scope: { worldId: SCOPE.worldId, worldlineId: SCOPE.worldlineId, recordId: "record-other" },
          },
          goals: domain.records[0]!.bundle.goals,
        },
      }],
    }))),
    /records|bundle|scope/,
  );
  // A sibling linked to an un-carried Record.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      records: [{ ...domain.records[0]!, linkedRecordId: "record-not-carried" }],
    }))),
    /records\.linkedRecordId/,
  );
});

test("archive build fails closed when domain evidence references escape the saved Record", () => {
  const domain = domainFixture();
  // Milestone completion event that exists neither in record.events nor in
  // evidenceEvents must be rejected before any bytes are produced.
  const dangling: RealmRuntimeSaveDomainV1 = {
    ...domain,
    milestones: [{ ...domain.milestones[0]!, completionEventId: "event-not-saved" }],
  };
  assert.throws(
    () => buildRealmRuntimeSaveArchive({ manifest: manifestFor(dangling), record, goals, topology, domain: dangling }),
    /INVALID_SAVE|unknown event/,
  );
  // Character assets belong to the saved Record; sibling Record inventory is
  // outside this archive scope.
  const crossRecordAsset: RealmRuntimeSaveDomainV1 = {
    ...domain,
    characterAssets: [{ ...domain.characterAssets[0]!, recordId: "record-evidence-1" }],
  };
  assert.throws(
    () => buildRealmRuntimeSaveArchive({ manifest: manifestFor(crossRecordAsset), record, goals, topology, domain: crossRecordAsset }),
    /INVALID_SAVE|character assets/,
  );
});

test("runtime-save domain contract rejects a client-derived balance", () => {
  const domain = domainFixture();
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(JSON.parse(JSON.stringify({
      ...domain,
      financeAccounts: [{ ...domain.financeAccounts[0]!, balanceMinor: 1 }],
    })))),
    /balanceMinor|unknownKey/,
  );
});

test("domain parser carries locked Story nodes with empty evidence and rejects invented evidence", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const openingNodeId = storyNodeInstanceIdFor(nodeScope, "opening");
  const withLocked = viaJson({
    ...domain,
    storyNodes: [
      { ...domain.storyNodes[0]! },
      {
        id: openingNodeId,
        storyId: STORY_ID,
        nodeKey: "opening",
        state: "locked",
        revision: 0,
        recordId: null,
        definitionHash,
        unlockEvidenceEventIds: [],
        unlockEvidence: {},
      },
    ],
  });
  const parsed = parseRealmRuntimeSaveDomainV1(JSON.stringify(withLocked));
  const locked = parsed.storyNodes.find((node) => node.nodeKey === "opening");
  assert.equal(locked?.state, "locked");
  assert.equal(locked?.recordId, null);
  assert.deepEqual(locked?.unlockEvidence, {});
  assert.deepEqual(locked?.unlockEvidenceEventIds, []);
  // A locked node must never carry invented evidence.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      storyNodes: [{
        ...domain.storyNodes[0]!,
        state: "locked",
        recordId: null,
      }],
    }))),
    /unlockEvidence|stateShape/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      storyNodes: [{
        id: openingNodeId,
        storyId: STORY_ID,
        nodeKey: "opening",
        state: "locked",
        revision: 0,
        recordId: null,
        definitionHash,
        unlockEvidenceEventIds: ["event-1"],
        unlockEvidence: {},
      }],
    }))),
    /unlockEvidence/,
  );
});

test("domain parser accepts legacy command provenance and rejects unknown provenance", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const legacy = viaJson({
    ...domain,
    financeCommandGroups: [{
      ...domain.financeCommandGroups[0]!,
      provenance: "legacy-result-v1",
      request: null,
    }],
    committedFactCommands: [{
      ...domain.committedFactCommands[0]!,
      provenance: "legacy-result-v1",
      request: null,
    }],
  });
  const parsed = parseRealmRuntimeSaveDomainV1(JSON.stringify(legacy));
  assert.equal(parsed.financeCommandGroups[0]?.provenance, "legacy-result-v1");
  assert.equal(parsed.financeCommandGroups[0]?.request, null);
  assert.equal(parsed.committedFactCommands[0]?.provenance, "legacy-result-v1");
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      financeCommandGroups: [{
        ...domain.financeCommandGroups[0]!,
        provenance: "restored-v9",
      }],
    }))),
    /provenance/,
  );
});

test("story definition sourceBinding provenance round-trips byte-identically; old archives omit it", () => {
  const domain = domainFixture();
  // Native materialization / pre-F1c archive: the key stays absent entirely.
  const legacySerialized = serializeRealmRuntimeSaveDomainV1(domain);
  assert.ok(!legacySerialized.includes('"sourceBinding"'));
  const legacyParsed = parseRealmRuntimeSaveDomainV1(legacySerialized);
  assert.equal(legacyParsed.storyDefinitions![0]?.sourceBinding, undefined);
  assert.equal(serializeRealmRuntimeSaveDomainV1(legacyParsed), legacySerialized);

  // A restore-origin binding carries its first-known provenance literally,
  // including a source workspace different from the archive scope, and the
  // parse/serialize cycle is byte-identical.
  const origin = {
    workspaceId: "workspace-origin",
    storyId: "story-origin",
    definitionHash: "0123456789abcdef".repeat(4),
  };
  const withOrigin = {
    ...domain,
    storyDefinitions: [{ ...domain.storyDefinitions[0]!, sourceBinding: origin }],
  };
  const serialized = serializeRealmRuntimeSaveDomainV1(withOrigin);
  const parsed = parseRealmRuntimeSaveDomainV1(serialized);
  assert.deepEqual(parsed.storyDefinitions![0]?.sourceBinding, origin);
  assert.equal(serializeRealmRuntimeSaveDomainV1(parsed), serialized);
});

test("domain parser rejects malformed story definition sourceBinding provenance", () => {
  const domain = domainFixture();
  const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const base = domain.storyDefinitions[0]!;
  const valid = {
    workspaceId: "workspace-origin",
    storyId: "story-origin",
    definitionHash: "0123456789abcdef".repeat(4),
  };
  const withBinding = (sourceBinding: unknown) => JSON.stringify(viaJson({
    ...domain,
    storyDefinitions: [{ ...base, sourceBinding }],
  }));

  // Non-object / null provenance fails closed.
  assert.throws(() => parseRealmRuntimeSaveDomainV1(withBinding(null)), /sourceBinding/);
  assert.throws(() => parseRealmRuntimeSaveDomainV1(withBinding("ws_origin")), /sourceBinding/);
  // Partial provenance (missing definitionHash) fails closed.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ workspaceId: valid.workspaceId, storyId: valid.storyId })),
    /sourceBinding\]\.definitionHash|sourceBinding/,
  );
  // Unknown keys inside the provenance object fail closed.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ ...valid, signature: "forged" })),
    /unknownKey/,
  );
  // Unknown keys alongside the provenance key fail closed.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(JSON.stringify(viaJson({
      ...domain,
      storyDefinitions: [{ ...base, sourceBinding: valid, recovered: true }],
    }))),
    /unknownKey/,
  );
  // Invalid hash shapes fail closed.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ ...valid, definitionHash: "not-a-hash" })),
    /sourceBinding/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ ...valid, definitionHash: "A".repeat(64) })),
    /sourceBinding/,
  );
  // Oversized or wrongly typed identities fail closed.
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ ...valid, workspaceId: "w".repeat(300) })),
    /sourceBinding/,
  );
  assert.throws(
    () => parseRealmRuntimeSaveDomainV1(withBinding({ ...valid, storyId: 42 })),
    /sourceBinding/,
  );
});

// F2b1 PURE contract only: no database/archive/service wiring is exercised.
const LINEAGE_SOURCE = { workspaceId: "ws0", worldId: "w0", worldlineId: "l0" };
const LINEAGE_TARGET = { workspaceId: "ws1", worldId: "w1", worldlineId: "l1" };
const LINEAGE_KINDS = ["record", "event", "scene", "characterInstance", "assetDefinition", "project", "financeAccount", "milestone", "obligation"] as const;
function lineageBody(): {
  format: string; version: number; family: string; originScope: typeof LINEAGE_SOURCE;
  currentScope: typeof LINEAGE_TARGET; identities: Record<ReplayIdentityKind, string[][]>;
} {
  return {
    format: "realm-command-lineage-context", version: 1, family: "fact",
    originScope: LINEAGE_SOURCE, currentScope: LINEAGE_TARGET,
    identities: { record: [["r1", "r0"]], event: [["e1", "e0"]], scene: [], characterInstance: [], assetDefinition: [], project: [], financeAccount: [], milestone: [], obligation: [] },
  };
}
// Independent oracle: no contract serializer or digest function is used.
function lineageOracleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(lineageOracleJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${lineageOracleJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function lineageOracleContext(body = lineageBody()) {
  const id = createHash("sha256").update(`realm-command-lineage-context:v1\0${lineageOracleJson(body)}`).digest("hex");
  return { ...body, id };
}

test("F2b1 strict context codec verifies an independent full digest and rejects forged metadata", () => {
  assert.equal(typeof (replayContract as Record<string, unknown>).decodeReplayContext, "function", "strict context decoder must exist");
  const api = replayContract;
  const context = lineageOracleContext();
  assert.equal(context.id, "9c0029c61b1c7f5d83916f1e9daf662d420e97d7f244a0c43ce5a9cf8728a3da");
  assert.deepEqual(api.decodeReplayContext(context), context);
  for (const value of [
    { ...context, id: "0".repeat(64) }, { ...context, version: 2 },
    { ...context, family: "story" }, { ...context, signature: "untrusted" },
    { ...context, originScope: { ...LINEAGE_SOURCE, workspaceId: " ws0" } },
  ]) assert.throws(() => api.decodeReplayContext(value), { code: "REPLAY_LINEAGE_INVALID" });
});

function lineageRecord<T>(get: (kind: ReplayIdentityKind) => T): Record<ReplayIdentityKind, T> {
  return { record: get("record"), event: get("event"), scene: get("scene"), characterInstance: get("characterInstance"),
    assetDefinition: get("assetDefinition"), project: get("project"), financeAccount: get("financeAccount"), milestone: get("milestone"), obligation: get("obligation") };
}
function lineageClosure(context: ReplayContextV1): ReplayClosure {
  return lineageRecord((kind) => context.identities[kind].map(([current]) => current));
}
function lineagePlan(closure: ReplayClosure, suffix: string): ReplayForwardMaps {
  return lineageRecord((kind) => closure[kind].map((id) => [id, `${id}${suffix}`] as const));
}

test("F2b1 rejects property attacks without invoking getters and permits Map-safe identity values", () => {
  const api = replayContract;
  const context = lineageOracleContext();
  let reads = 0;
  const accessor = { ...context };
  Object.defineProperty(accessor, "originScope", { enumerable: true, get() { reads++; return LINEAGE_SOURCE; } });
  const scopeAccessor = { ...LINEAGE_SOURCE };
  Object.defineProperty(scopeAccessor, "workspaceId", { enumerable: true, get() { reads++; return "ws0"; } });
  const pairAccessor = ["e1", "e0"];
  Object.defineProperty(pairAccessor, "0", { enumerable: true, get() { reads++; return "e1"; } });
  const hiddenPair = ["e1", "e0"];
  Object.defineProperty(hiddenPair, "extra", { value: "hidden" });
  const symbolPair = Object.assign(["e1", "e0"], { [Symbol("bad")]: true });
  for (const value of [
    accessor, { ...context, originScope: scopeAccessor },
    Object.create(context), Object.assign(Object.create({ inherited: true }), context),
    Object.assign({ ...context }, { [Symbol("unknown")]: true }),
    Object.defineProperty({ ...context }, "hidden", { value: 1 }),
    JSON.parse(JSON.stringify(context).replace('"family":"fact"', '"family":"fact","__proto__":{}')),
    ...[pairAccessor, hiddenPair, symbolPair, Object.assign(Array(2), { 0: "e1" }), ["e1", "e0", "extra"], ["e1"], ["e1", undefined]]
      .map((pair) => ({ ...context, identities: { ...context.identities, event: [pair] } })),
    ...[
      [["b", "o2"], ["a", "o1"]], [["a", "o1"], ["a", "o2"]], [["a", "o1"], ["b", "o1"]],
    ].map((event) => ({ ...context, identities: { ...context.identities, event } })),
    { ...context, identities: { ...context.identities, scene: [["s", "s"]] } },
  ]) assert.throws(() => api.decodeReplayContext(value));
  assert.equal(reads, 0, "no getter may run, including nested arrays/scopes");
  const body = lineageBody();
  body.identities.event = ["__proto__", "constructor", "prototype"].map((id) => [id, id]);
  const safe = lineageOracleContext(body);
  assert.deepEqual(api.decodeReplayContext(safe), safe);
  const nullPrototype = Object.assign(Object.create(null), context);
  nullPrototype.originScope = Object.assign(Object.create(null), LINEAGE_SOURCE);
  assert.deepEqual(api.decodeReplayContext(nullPrototype), context);
});

test("F2b1 PURE changed-primary projection restricts only the archive and composes stable origins", () => {
  assert.equal(typeof (replayContract as Record<string, unknown>).projectReplayContext, "function", "archive-only projection must exist");
  const api = replayContract;
  const body = lineageBody();
  body.identities.record = [["A", "OA"], ["B", "OB"]];
  body.identities.event = [["A-opening", "OA-opening"], ["B-evidence", "OB-evidence"]];
  const original = api.createReplayContext(body);
  const saved = JSON.stringify(original);
  const B = { ...lineageClosure(original), record: ["B"], event: ["B-evidence"] };
  const projected = api.projectReplayContext(original, LINEAGE_TARGET, B);
  assert.deepEqual(projected.identities.record, [["B", "OB"]]);
  assert.deepEqual(projected.identities.event, [["B-evidence", "OB-evidence"]]);
  assert.deepEqual(projected.originScope, LINEAGE_SOURCE);
  assert.equal(JSON.stringify(original), saved, "source context/receipt knowledge is never mutated");
  const C = { ...B, record: ["B", "C"], event: ["B-evidence", "C-opening"] };
  const withC = api.projectReplayContext(original, LINEAGE_TARGET, C);
  assert.deepEqual(withC.identities.event, [["B-evidence", "OB-evidence"], ["C-opening", null]]);
  assert.throws(() => api.projectReplayContext(original, LINEAGE_SOURCE, B));
  let current = withC;
  for (const hop of ["second", "third"]) {
    const closure = lineageClosure(current);
    const nextScope = { ...LINEAGE_TARGET, worldlineId: hop };
    const next = api.composeReplayContext(current, current.currentScope, closure, nextScope, lineagePlan(closure, `-${hop}`));
    assert.deepEqual(next.originScope, LINEAGE_SOURCE);
    assert.deepEqual(next.identities.event.map(([, origin]) => origin), ["OB-evidence", null]);
    assert.notEqual(next.id, current.id);
    current = next;
  }
  assert.equal(JSON.stringify(original), saved);
  const maps = lineagePlan(C, "-target");
  for (const event of [[], [["B-evidence", "collapse"], ["C-opening", "collapse"]], [["B-evidence", "ok"], ["unrelated", "bad"]]]) {
    assert.throws(() => api.composeReplayContext(withC, LINEAGE_TARGET, C, LINEAGE_SOURCE, { ...maps, event }));
  }
});

test("F2b1 shared references validate complete imported closure and >1024 IDs without receipt map copies", (t) => {
  assert.equal(typeof (replayContract as Record<string, unknown>).validateReplayBundle, "function", "shared context/reference validation must exist");
  const api = replayContract;
  for (const count of [1025, 10000]) {
    const body = lineageBody();
    body.identities.event = Array.from({ length: count }, (_, i) => [`e${String(i).padStart(5, "0")}`, `o${String(i).padStart(5, "0")}`]);
    const context = api.createReplayContext(body);
    const refs = Array.from({ length: 128 }, (_, i) => ({
      id: `receipt-${i}`, family: "fact", requestFingerprint: createHash("sha256").update(`original-${i}`).digest("hex"),
      replayLineage: { version: 1, contextId: context.id, originalRequestFingerprint: createHash("sha256").update(`original-${i}`).digest("hex") },
    }));
    const bundle = api.validateReplayBundle([context], refs, LINEAGE_TARGET, lineageClosure(context));
    assert.equal(bundle.contexts.length, 1); assert.equal(bundle.receipts.length, 128);
    assert.equal(bundle.contexts[0]?.identities.event.length, count);
    assert.ok(bundle.receipts.every((ref) => !Object.hasOwn(ref as object, "identities")), "receipts hold refs only");
    assert.equal(bundle.byteLength, Buffer.byteLength(lineageOracleJson({ contexts: bundle.contexts, receipts: bundle.receipts }), "utf8"));
    t.diagnostic(`PURE codec measurement: ${count} IDs, 128 bindings, ${Buffer.byteLength(lineageOracleJson(context), "utf8")} context bytes, ${bundle.byteLength} total bundle bytes; no PG claim`);
    assert.deepEqual(api.deduplicateReplayContexts(Array(128).fill(context)), [context]);
    assert.equal((replayContract as Record<string, unknown>).REPLAY_LINEAGE_MAX_BYTES, 64 * 1024 * 1024);
    // A deliberately injected smaller budget tests the mechanism, NOT a 64MiB boundary.
    assert.throws(() => api.validateReplayBundle([context], refs, LINEAGE_TARGET, lineageClosure(context), { maxBytes: bundle.byteLength - 1 }), { code: "REPLAY_LINEAGE_LIMIT" });
    assert.equal(api.validateReplayBundle([context], refs, LINEAGE_TARGET, lineageClosure(context), { maxBytes: bundle.byteLength }).byteLength, bundle.byteLength);
    const encodedBytes = Buffer.byteLength(lineageOracleJson(context), "utf8");
    assert.equal(api.decodeReplayContext(context, { maxBytes: encodedBytes }).id, context.id);
    assert.throws(() => api.decodeReplayContext(context, { maxBytes: encodedBytes - 1 }), { code: "REPLAY_LINEAGE_LIMIT" });
    if (count !== 1025) continue;
    for (const [contexts, references, closure, actualScope] of [
      [[context, context], refs, lineageClosure(context), LINEAGE_TARGET],
      [[context], [refs[0], refs[0]], lineageClosure(context), LINEAGE_TARGET],
      [[context], [], lineageClosure(context), LINEAGE_TARGET],
      [[], refs, lineageClosure(context), LINEAGE_TARGET],
      [[context], [{ ...refs[0], family: "finance" }], lineageClosure(context), LINEAGE_TARGET],
      [[context], [{ ...refs[0], requestFingerprint: "0".repeat(64) }], lineageClosure(context), LINEAGE_TARGET],
      [[context], [{ ...refs[0], metadata: "unrecognized" }], lineageClosure(context), LINEAGE_TARGET],
      [[context], refs, { ...lineageClosure(context), event: [] }, LINEAGE_TARGET],
      [[context], refs, { ...lineageClosure(context), event: [...lineageClosure(context).event, "unrelated"] }, LINEAGE_TARGET],
      [[context], refs, lineageClosure(context), LINEAGE_SOURCE],
    ] as const) assert.throws(() => api.validateReplayBundle(contexts, references, actualScope, closure as ReplayClosure));
    const binding = refs[0]!.replayLineage;
    assert.deepEqual(api.decodeReplayBinding(binding), binding);
    assert.deepEqual(api.decodeStoredReplayBinding({ ...binding, anchorCommandId: "constructor" }), { ...binding, anchorCommandId: "constructor" });
    for (const bad of [{ ...binding, version: 2 }, { ...binding, contextId: "bad" }, { ...binding, originalRequestFingerprint: "A".repeat(64) }, { ...binding, anchorCommandId: "extra" }]) {
      assert.throws(() => api.decodeReplayBinding(bad));
    }
  }
});

type LineageCase = { family: "fact" | "finance"; kind?: FactKind; source: Record<string, unknown>; target: Record<string, unknown> };
const LINEAGE_PAIRS: Record<string, readonly (readonly [string, string])[]> = {
  record: [["r0", "r1"]], event: [["e0", "z1"], ["e2", "a1"]], scene: [["s0", "s1"]],
  characterInstance: [["c0", "c1"]], assetDefinition: [["a0", "asset1"]], project: [["p0", "p1"]],
  financeAccount: [["f0", "f1"]], milestone: [["m0", "m1"]], obligation: [["o0", "o1"]],
};
function lineageResolver(reverse: boolean) {
  return (kind: string, id: string): string => {
    const pair = LINEAGE_PAIRS[kind]?.find((pair) => pair[reverse ? 1 : 0] === id);
    assert.ok(pair, `independent fixture has ${kind}/${id}`);
    return pair[reverse ? 0 : 1];
  };
}
function lineageCases(): LineageCase[] {
  const evidence0 = { recordId: "r0", sceneId: "s0", visibility: "restricted", worldTick: 3, worldOrdinal: 7 };
  const evidence1 = { ...evidence0, recordId: "r1", sceneId: "s1" };
  const ledger0 = { accountId: "f0", projectId: "p0", recordId: null, amountMinor: 12, category: "e0", memo: "e0 中文 memo", occurredAt: "2026-10-16T00:00:00Z", expectedBalanceMinor: 100, evidence: evidence0 };
  const ledger1 = { ...ledger0, accountId: "f1", projectId: "p1", evidence: evidence1 };
  const cases: LineageCase[] = [
    { family: "fact", kind: "inventory_granted", source: { command: "inventory.granted", recordId: "r0", characterInstanceId: "c0", assetDefinitionId: "a0", sourceEventId: "e0", quantity: 3 }, target: { command: "inventory.granted", recordId: "r1", characterInstanceId: "c1", assetDefinitionId: "asset1", sourceEventId: "z1", quantity: 3 } },
    { family: "fact", kind: "inventory_adjusted", source: { command: "inventory.adjusted", recordId: "r0", characterInstanceId: "c0", assetDefinitionId: "a0", sourceEventId: "e0", delta: -1, expectedRevision: 0 }, target: { command: "inventory.adjusted", recordId: "r1", characterInstanceId: "c1", assetDefinitionId: "asset1", sourceEventId: "z1", delta: -1, expectedRevision: 0 } },
    { family: "fact", kind: "relationship_revised", source: { command: "relationship.revised", subjectEntityKey: "e0", objectEntityKey: "c0", relationKind: "trust", sourceEventId: "e0" }, target: { command: "relationship.revised", subjectEntityKey: "e0", objectEntityKey: "c0", relationKind: "trust", sourceEventId: "z1" } },
    { family: "fact", kind: "performance_assessed", source: { command: "performance.assessed", recordId: "r0", policyVersion: "structured-factors:v1", score: 20, evidenceEventIds: ["e0", "e2"] }, target: { command: "performance.assessed", recordId: "r1", policyVersion: "structured-factors:v1", score: 20, evidenceEventIds: ["a1", "z1"] } },
    { family: "finance", source: { command: "finance.expense.recorded", ...ledger0 }, target: { command: "finance.expense.recorded", ...ledger1 } },
    { family: "finance", source: { command: "finance.income.recorded", ...ledger0, direction: "income" }, target: { command: "finance.income.recorded", ...ledger1, direction: "income" } },
    ...["income", "expense"].map((direction): LineageCase => ({ family: "finance", source: { command: "finance.adjustment.recorded", ...ledger0, direction }, target: { command: "finance.adjustment.recorded", ...ledger1, direction } })),
    { family: "finance", source: { command: "finance.expense.recorded", ...ledger0, accountId: null, projectId: null, recordId: "r0", evidence: null }, target: { command: "finance.expense.recorded", ...ledger1, accountId: null, projectId: null, recordId: "r1", evidence: null } },
    { family: "finance", source: { command: "project.milestone.confirmed", projectId: "p0", milestoneId: "m0", expectedProjectVersion: 2, evidence: evidence0, semanticEventKey: "e0" }, target: { command: "project.milestone.confirmed", projectId: "p1", milestoneId: "m1", expectedProjectVersion: 2, evidence: evidence1, semanticEventKey: "e0" } },
    { family: "finance", source: { command: "project.milestone.confirmed", projectId: "p0", milestoneId: "m0", expectedProjectVersion: 2, evidence: null }, target: { command: "project.milestone.confirmed", projectId: "p1", milestoneId: "m1", expectedProjectVersion: 2, evidence: null } },
    { family: "finance", source: { command: "project.stage.changed", projectId: "p0", stage: "production", expectedProjectVersion: 3, evidence: evidence0 }, target: { command: "project.stage.changed", projectId: "p1", stage: "production", expectedProjectVersion: 3, evidence: evidence1 } },
    { family: "finance", source: { command: "finance.budget.allocated", projectId: "p0", category: "e0", amountMinor: 500, expectedVersion: 0 }, target: { command: "finance.budget.allocated", projectId: "p1", category: "e0", amountMinor: 500, expectedVersion: 0 } },
    ...["loan", "presale", "revenue_share"].map((kind): LineageCase => ({ family: "finance", source: { command: "finance.obligation.created", projectId: "p0", kind, principalMinor: 200, shareBps: kind === "revenue_share" ? 2500 : null, undeliveredCount: kind === "presale" ? 4 : 0 }, target: { command: "finance.obligation.created", projectId: "p1", kind, principalMinor: 200, shareBps: kind === "revenue_share" ? 2500 : null, undeliveredCount: kind === "presale" ? 4 : 0 } })),
    { family: "finance", source: { command: "finance.obligation.created", projectId: null, kind: "loan", principalMinor: 200, shareBps: null, undeliveredCount: 0 }, target: { command: "finance.obligation.created", projectId: null, kind: "loan", principalMinor: 200, shareBps: null, undeliveredCount: 0 } },
    ...["repayment", "draw", "share"].map((settlementKind): LineageCase => ({ family: "finance", source: { command: "finance.obligation.settled", obligationId: "o0", accountId: "f0", amountMinor: 1, expectedOutstandingMinor: 200, expectedBalanceMinor: 99, category: "e0", occurredAt: ledger0.occurredAt, settlementKind }, target: { command: "finance.obligation.settled", obligationId: "o1", accountId: "f1", amountMinor: 1, expectedOutstandingMinor: 200, expectedBalanceMinor: 99, category: "e0", occurredAt: ledger0.occurredAt, settlementKind } })),
    { family: "finance", source: { command: "record.apply_project_finance", evidence: evidence0, actions: [
      { command: "change_stage", projectId: "p0", stage: "delivery", expectedProjectVersion: 4 },
      { command: "confirm_milestone", projectId: "p0", milestoneId: "m0", expectedProjectVersion: 5 },
      { command: "record_expense", accountId: "f0", projectId: "p0", amountMinor: 3, expectedBalanceMinor: 99, category: "e0", memo: "c0", occurredAt: ledger0.occurredAt },
    ] }, target: { command: "record.apply_project_finance", evidence: evidence1, actions: [
      { command: "change_stage", projectId: "p1", stage: "delivery", expectedProjectVersion: 4 },
      { command: "confirm_milestone", projectId: "p1", milestoneId: "m1", expectedProjectVersion: 5 },
      { command: "record_expense", accountId: "f1", projectId: "p1", amountMinor: 3, expectedBalanceMinor: 99, category: "e0", memo: "c0", occurredAt: ledger0.occurredAt },
    ] } },
  ];
  cases.push(
    { family: "finance", source: { command: "finance.obligation.settled", obligationId: "o0", accountId: null, amountMinor: 1, expectedOutstandingMinor: 200, expectedBalanceMinor: 99, category: "e0", occurredAt: ledger0.occurredAt, settlementKind: "repayment" },
      target: { command: "finance.obligation.settled", obligationId: "o1", accountId: null, amountMinor: 1, expectedOutstandingMinor: 200, expectedBalanceMinor: 99, category: "e0", occurredAt: ledger0.occurredAt, settlementKind: "repayment" } },
    { family: "finance", source: { command: "record.apply_project_finance", evidence: null, actions: [
      { command: "record_expense", accountId: null, projectId: null, amountMinor: 3, expectedBalanceMinor: 99, category: "e0", memo: "c0", occurredAt: ledger0.occurredAt },
    ] }, target: { command: "record.apply_project_finance", evidence: null, actions: [
      { command: "record_expense", accountId: null, projectId: null, amountMinor: 3, expectedBalanceMinor: 99, category: "e0", memo: "c0", occurredAt: ledger0.occurredAt },
    ] } },
  );
  return cases;
}

test("F2b1 explicit walkers match independent expected requests for ALL4 fact and ALL9 finance operations", () => {
  assert.equal(typeof (replayContract as Record<string, unknown>).walkFactReplayRequest, "function", "typed candidate walkers must exist");
  const api = replayContract;
  const cases = lineageCases();
  assert.equal(new Set(cases.filter((c) => c.family === "fact").map((c) => c.source.command)).size, 4);
  assert.equal(new Set(cases.filter((c) => c.family === "finance").map((c) => c.source.command)).size, 9);
  for (const c of cases) {
    const before = JSON.stringify(c);
    const forward = c.family === "fact" ? api.walkFactReplayRequest(c.kind!, c.source, lineageResolver(false)) : api.walkFinanceReplayRequest(c.source, lineageResolver(false));
    const reverse = c.family === "fact" ? api.walkFactReplayRequest(c.kind!, c.target, lineageResolver(true)) : api.walkFinanceReplayRequest(c.target, lineageResolver(true));
    assert.deepEqual(forward, c.target, `${c.source.command} exact independent forward fields`);
    assert.deepEqual(reverse, c.source, `${c.source.command} origin evidence sorting and literal/scalar preservation`);
    assert.equal(JSON.stringify(c), before);
    for (const invalid of [{ ...c.source, unknown: "e0" }, { ...c.source, command: "unknown" }]) {
      assert.throws(() => c.family === "fact" ? api.walkFactReplayRequest(c.kind!, invalid, lineageResolver(false)) : api.walkFinanceReplayRequest(invalid, lineageResolver(false)));
    }
  }
});

function lineageFixtureContext(family: "fact" | "finance"): ReplayContextV1 {
  const eligible = new Set(family === "fact" ? ["record", "event", "characterInstance", "assetDefinition"] : ["record", "scene", "project", "financeAccount", "milestone", "obligation"]);
  const identities = Object.fromEntries(LINEAGE_KINDS.map((kind) => [kind, eligible.has(kind)
    ? LINEAGE_PAIRS[kind]!.map(([origin, current]) => [current, origin]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0) : []]));
  return replayContract.createReplayContext({ format: "realm-command-lineage-context", version: 1, family, originScope: LINEAGE_SOURCE, currentScope: LINEAGE_TARGET, identities });
}
function lineageFingerprint(family: "fact" | "finance", scope: typeof LINEAGE_SOURCE, request: Record<string, unknown>): string {
  return family === "fact" ? committedFactRequestFingerprintFor(scope, request)
    : projectFinanceCommandFingerprintFor(scope, request as { command: string });
}
// Mutate every leaf/presence in test oracle data, not a production identity walk.
function lineageMutations(value: Record<string, unknown>): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") output.push({ ...value, [key]: item + 1 });
    else if (typeof item === "string") output.push({ ...value, [key]: item + "changed" });
    else if (item === null) output.push({ ...value, [key]: "non-null" });
    else if (Array.isArray(item)) {
      output.push({ ...value, [key]: [...item].reverse() }, { ...value, [key]: [] });
      for (let i = 0; i < item.length; i++) {
        if (typeof item[i] === "string") output.push({ ...value, [key]: item.map((x, j) => i === j ? x + "changed" : x) });
        else for (const changed of lineageMutations(item[i] as Record<string, unknown>)) output.push({ ...value, [key]: item.map((x, j) => i === j ? changed : x) });
      }
    } else if (typeof item === "object") {
      output.push({ ...value, [key]: null });
      for (const changed of lineageMutations(item as Record<string, unknown>)) output.push({ ...value, [key]: changed });
    }
    const removed = { ...value }; delete removed[key]; output.push(removed);
  }
  return output.filter((candidate) => lineageOracleJson(candidate) !== lineageOracleJson(value));
}

test("F2b1 ONE full original fingerprint comparator proves PURE remapped requests and refuses every critical mutation", async (t) => {
  assert.equal(typeof (replayContract as Record<string, unknown>).compareReplay, "function", "shared full-fingerprint comparator must exist");
  const api = replayContract;
  for (const [index, c] of lineageCases().entries()) await t.test(`${c.source.command}/${index}`, () => {
    const original = lineageFingerprint(c.family, LINEAGE_SOURCE, c.source);
    if (index === 0) assert.equal(original, "5523bf2846fea0ef673c326032c3d8a1c54e27a6cd2f5fc95d2c8ec547c0121a");
    // Independent request hash oracle also checks prefixes and whole scope.
    const oracle = createHash("sha256").update(`${c.family === "fact" ? "committed-fact-command" : "project-finance-command"}:v1\0${lineageOracleJson({ scope: LINEAGE_SOURCE, request: c.source })}`).digest("hex");
    assert.equal(original, oracle);
    const context = lineageFixtureContext(c.family);
    const existing = { requestFingerprint: original, request: null, provenance: "legacy-result-v1",
      ...(c.family === "fact" ? { kind: c.kind } : { state: "committed", policyVersion: "project-finance-command.v1" }),
      replayProof: { context, binding: { version: 1, contextId: context.id, originalRequestFingerprint: original } },
    };
    const input = { family: c.family, trustedScope: LINEAGE_TARGET, expectedOperation: c.source.command, candidate: c.target, existing,
      ...(c.family === "fact" ? { factFingerprint: committedFactRequestFingerprintFor } : {}),
    };
    assert.equal(api.compareReplay(input), true, "PURE helper exact reverse proof; runtime remains RED");
    const targetHash = lineageFingerprint(c.family, LINEAGE_TARGET, c.target);
    assert.equal(api.compareReplay({ ...input, suppliedTargetFingerprint: targetHash }), true);
    assert.equal(api.compareReplay({ ...input, suppliedTargetFingerprint: original }), false, "source hash is not a target hash guard");
    for (const candidate of lineageMutations(c.target)) {
      assert.equal(api.compareReplay({ ...input, candidate }), false, `${c.source.command} changed ${JSON.stringify(candidate)}`);
      assert.equal(api.compareReplay({ ...input, candidate, suppliedTargetFingerprint: original }), false);
    }
    for (const changed of [
      { ...input, trustedScope: LINEAGE_SOURCE }, { ...input, family: c.family === "fact" ? "finance" : "fact" },
      { ...input, expectedOperation: "other" }, { ...input, unknown: true },
      { ...input, existing: { ...existing, provenance: "request-result-v1" } },
      { ...input, existing: { ...existing, requestFingerprint: "0".repeat(64) } },
      { ...input, existing: { ...existing, request: c.source } },
      { ...input, existing: { ...existing, replayProof: null } },
      { ...input, existing: { ...existing, kind: "wrong", policyVersion: "wrong", state: "rejected" } },
      { ...input, existing: { ...existing, replayProof: { ...existing.replayProof, binding: { ...existing.replayProof.binding, contextId: "0".repeat(64) } } } },
    ]) assert.equal(api.compareReplay(changed), false);
    const nativeExisting = { ...existing };
    Reflect.deleteProperty(nativeExisting, "replayProof");
    const nativeInput = { ...input, trustedScope: LINEAGE_SOURCE, candidate: c.source, existing: nativeExisting };
    assert.equal(api.compareReplay(nativeInput), true, "native bare/tagged exact full hash");
    assert.equal(api.compareReplay({ ...nativeInput, candidate: c.target }), lineageFingerprint(c.family, LINEAGE_SOURCE, c.target) === original,
      "absence of lineage uses exact native hash (null-project creation has no remapped IDs)");
    assert.equal(api.compareReplay({ ...nativeInput, existing: { requestFingerprint: original, request: c.source, provenance: "request-result-v1" } }), true, "modern current request follows the unchanged full hash");
  });
});

test("F2b1 typed walkers refuse noninjective or inconsistent same-namespace resolver results", () => {
  const request = { command: "record.apply_project_finance", evidence: null, actions: [
    { command: "change_stage", projectId: "p0", stage: "production", expectedProjectVersion: 1 },
    { command: "change_stage", projectId: "other-p0", stage: "production", expectedProjectVersion: 1 },
  ] };
  assert.throws(() => replayContract.walkFinanceReplayRequest(request, (kind, id) => kind === "project" ? "collapsed" : id), { code: "REPLAY_LINEAGE_INVALID" });
  let calls = 0;
  const repeated = { ...request, actions: [request.actions[0], request.actions[0]] };
  assert.throws(() => replayContract.walkFinanceReplayRequest(repeated, (kind, id) => kind === "project" ? `changing-${calls++}` : id), { code: "REPLAY_LINEAGE_INVALID" });
  assert.throws(() => replayContract.walkFinanceReplayRequest(request, () => { throw new Error("untrusted-origin-details"); }), { code: "REPLAY_LINEAGE_INVALID", message: "Replay lineage is invalid." });
});

test("F2b1 PURE retained B proof replays after projection and later compositions; unknown C never does", () => {
  const body = lineageBody();
  body.identities.record = [["A", "OA"], ["B", "OB"]];
  body.identities.event = [["A-opening", "OA-opening"], ["B-evidence", "OB-evidence"]];
  const sourceContext = replayContract.createReplayContext(body);
  const frozenSource = JSON.stringify(sourceContext);
  const originalRequest = { command: "relationship.revised", subjectEntityKey: "constructor", objectEntityKey: "prototype", relationKind: "trust", sourceEventId: "OB-evidence" };
  const originalFingerprint = committedFactRequestFingerprintFor(LINEAGE_SOURCE, originalRequest);
  let current = replayContract.projectReplayContext(sourceContext, LINEAGE_TARGET, { ...lineageClosure(sourceContext), record: ["B", "C"], event: ["B-evidence", "C-opening"] });
  let eventId = "B-evidence"; let unknownId = "C-opening";
  for (const hop of ["initial", "second", "third"]) {
    if (hop !== "initial") {
      const closure = lineageClosure(current);
      const plan = lineagePlan(closure, `-${hop}`);
      current = replayContract.composeReplayContext(current, current.currentScope, closure, { ...LINEAGE_TARGET, worldlineId: hop }, plan);
      eventId += `-${hop}`; unknownId += `-${hop}`;
    }
    const existing = { provenance: "legacy-result-v1", request: null, kind: "relationship_revised", requestFingerprint: originalFingerprint,
      replayProof: { context: current, binding: { version: 1, contextId: current.id, originalRequestFingerprint: originalFingerprint } } };
    const input = { family: "fact", trustedScope: current.currentScope, expectedOperation: "relationship.revised", existing, factFingerprint: committedFactRequestFingerprintFor };
    assert.equal(replayContract.compareReplay({ ...input, candidate: { ...originalRequest, sourceEventId: eventId } }), true);
    assert.equal(replayContract.compareReplay({ ...input, candidate: { ...originalRequest, sourceEventId: unknownId } }), false);
    assert.equal(replayContract.compareReplay({ ...input, candidate: { ...originalRequest, sourceEventId: "A-opening" } }), false);
    assert.equal(replayContract.compareReplay({ ...input, candidate: { ...originalRequest, sourceEventId: eventId, subjectEntityKey: "changed" } }), false);
    assert.deepEqual(current.originScope, LINEAGE_SOURCE);
  }
  assert.equal(JSON.stringify(sourceContext), frozenSource);
});

test("F2b1 coincident typed IDs retain separate namespaces and mapped changed actors still refuse", () => {
  const originalRequest = { command: "inventory.granted", recordId: "r0", characterInstanceId: "c0", assetDefinitionId: "a0", sourceEventId: "e0", quantity: 3 };
  const original = committedFactRequestFingerprintFor(LINEAGE_SOURCE, originalRequest);
  for (const safeId of ["constructor", "prototype", "__proto__"]) {
    const body = lineageBody();
    body.identities.record = [["another-record", "another-record-origin"], [safeId, "r0"]].sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    body.identities.event = [["another-event", "another-event-origin"], [safeId, "e0"]].sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    body.identities.characterInstance = [["another-actor", "another-origin"], [safeId, "c0"]].sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    body.identities.assetDefinition = [["another-asset", "another-asset-origin"], [safeId, "a0"]].sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    const context = replayContract.createReplayContext(body);
    const candidate = { ...originalRequest, recordId: safeId, characterInstanceId: safeId, assetDefinitionId: safeId, sourceEventId: safeId };
    const input = { family: "fact", trustedScope: LINEAGE_TARGET, expectedOperation: "inventory.granted", candidate, factFingerprint: committedFactRequestFingerprintFor,
      existing: { requestFingerprint: original, request: null, provenance: "legacy-result-v1", kind: "inventory_granted", replayProof: { context, binding: { version: 1, contextId: context.id, originalRequestFingerprint: original } } } };
    assert.equal(replayContract.compareReplay(input), true);
    for (const change of [{ characterInstanceId: "another-actor" }, { recordId: "another-record" }, { assetDefinitionId: "another-asset" }, { sourceEventId: "another-event" }]) {
      assert.equal(replayContract.compareReplay({ ...input, candidate: { ...candidate, ...change } }), false, "known other typed identities are not aliases");
    }
  }
});

test("F2b1 recognized provenance cannot hide malformed request/proof metadata even on the native hash path", () => {
  const c = lineageCases()[0]!;
  const requestFingerprint = committedFactRequestFingerprintFor(LINEAGE_SOURCE, c.source);
  const input = { family: "fact", trustedScope: LINEAGE_SOURCE, expectedOperation: c.source.command, candidate: c.source, factFingerprint: committedFactRequestFingerprintFor };
  for (const existing of [
    { requestFingerprint, request: c.source, provenance: "legacy-result-v1" },
    { requestFingerprint, request: null, provenance: "request-result-v1" },
    { requestFingerprint, request: null, replayProof: undefined },
  ]) assert.equal(replayContract.compareReplay({ ...input, existing }), false);
});

test("F2b1 imported coverage, every namespace, safe scalar boundaries and nested accessors fail closed", () => {
  const context = lineageFixtureContext("fact");
  const closure = lineageClosure(context);
  const fp = "0123456789abcdef".repeat(4);
  const ref = { id: "constructor", family: "fact", requestFingerprint: fp, replayLineage: { version: 1, contextId: context.id, originalRequestFingerprint: fp } };
  const body = { format: context.format, version: context.version, family: context.family,
    originScope: context.originScope, currentScope: context.currentScope, identities: context.identities };
  const missing = replayContract.createReplayContext({ ...body, identities: { ...body.identities, event: body.identities.event.slice(1) } });
  const missingRef = { ...ref, replayLineage: { ...ref.replayLineage, contextId: missing.id } };
  assert.throws(() => replayContract.validateReplayBundle([missing], [missingRef], LINEAGE_TARGET, closure), { code: "REPLAY_LINEAGE_INVALID" });
  for (const namespace of LINEAGE_KINDS) {
    const missingNamespace: Record<string, unknown> = { ...context.identities }; delete missingNamespace[namespace];
    assert.throws(() => replayContract.decodeReplayContext({ ...context, identities: missingNamespace }));
  }
  for (const value of ["", ".", "..", " spaced", "x/y", "x\0y", "x".repeat(257), 1, null]) {
    assert.throws(() => replayContract.createReplayContext({ ...body, currentScope: { ...LINEAGE_TARGET, workspaceId: value } }));
  }
  for (const maxBytes of [0, -1, NaN, Infinity, 64 * 1024 * 1024 + 1]) assert.throws(() => replayContract.decodeReplayContext(context, { maxBytes }));
  let reads = 0;
  const badRef = { ...ref };
  Object.defineProperty(badRef, "replayLineage", { enumerable: true, get() { reads++; return ref.replayLineage; } });
  assert.throws(() => replayContract.validateReplayBundle([context], [badRef], LINEAGE_TARGET, closure));
  const finance = lineageCases().find((c) => c.source.command === "record.apply_project_finance")!;
  const candidate = structuredClone(finance.source);
  const actions = candidate.actions as Record<string, unknown>[];
  Object.defineProperty(actions[1]!, "projectId", { enumerable: true, get() { reads++; return "p0"; } });
  assert.throws(() => replayContract.walkFinanceReplayRequest(candidate, lineageResolver(false)));
  const grant = lineageCases()[0]!.source;
  const hostile = { ...grant };
  Object.defineProperty(hostile, "quantity", { enumerable: true, get() { reads++; return 3; } });
  assert.equal(replayContract.compareReplay({ family: "fact", trustedScope: LINEAGE_SOURCE, expectedOperation: grant.command, candidate: hostile,
    factFingerprint: committedFactRequestFingerprintFor, existing: { requestFingerprint: committedFactRequestFingerprintFor(LINEAGE_SOURCE, grant), request: null } }), false);
  assert.equal(reads, 0);
  const noMap = () => undefined as unknown as string;
  assert.throws(() => replayContract.walkFactReplayRequest("inventory_granted", grant, noMap));
  assert.throws(() => replayContract.walkFactReplayRequest("inventory_adjusted", { ...lineageCases()[1]!.source, delta: 0 }, lineageResolver(false)));
  assert.throws(() => replayContract.walkFactReplayRequest("performance_assessed", { ...lineageCases()[3]!.source, policyVersion: "other" }, lineageResolver(false)));
  assert.throws(() => replayContract.walkFinanceReplayRequest({ ...lineageCases()[4]!.source, direction: "expense" }, lineageResolver(false)), "expense direction is an unknown canonical key");
  assert.throws(() => replayContract.walkFinanceReplayRequest({ ...lineageCases()[9]!.source, semanticEventKey: null }, lineageResolver(false)), "absent semantic key is distinct from null");
  assert.throws(() => replayContract.walkFinanceReplayRequest({ ...lineageCases()[17]!.source, memo: "unhashed" }, lineageResolver(false)), "settlement memo is not invented in canonical requests");
  for (const row of lineageCases()) {
    for (const key of ["expectedRevision", "expectedVersion", "expectedProjectVersion", "expectedBalanceMinor", "expectedOutstandingMinor", "quantity", "amountMinor", "principalMinor"]) {
      if (!Object.hasOwn(row.source, key)) continue;
      assert.throws(() => row.family === "fact"
        ? replayContract.walkFactReplayRequest(row.kind!, { ...row.source, [key]: Number.MAX_SAFE_INTEGER + 1 }, lineageResolver(false))
        : replayContract.walkFinanceReplayRequest({ ...row.source, [key]: Number.MAX_SAFE_INTEGER + 1 }, lineageResolver(false)));
    }
  }
  const financeContext = lineageFixtureContext("finance");
  const both = replayContract.deduplicateReplayContexts([financeContext, context, context]);
  assert.equal(both.length, 2, "family/relations are distinct, no result resemblance is consulted");
  const changedOrigin = replayContract.createReplayContext({ ...body, originScope: { ...LINEAGE_SOURCE, worldId: "other-origin" } });
  assert.equal(replayContract.deduplicateReplayContexts([context, changedOrigin]).length, 2);
});

test("F2b1 finance metadata fields and origin scope are checked independently without permissions", () => {
  const c = lineageCases()[9]!;
  const context = lineageFixtureContext("finance");
  const fp = lineageFingerprint("finance", LINEAGE_SOURCE, c.source);
  const existing = { requestFingerprint: fp, request: null, provenance: "legacy-result-v1", state: "committed", policyVersion: "project-finance-command.v1",
    replayProof: { context, binding: { version: 1, contextId: context.id, originalRequestFingerprint: fp } } };
  const input = { family: "finance", trustedScope: LINEAGE_TARGET, expectedOperation: c.source.command, candidate: c.target, existing };
  assert.equal(replayContract.compareReplay(input), true);
  for (const metadata of [{ state: "rejected" }, { policyVersion: "other" }, { kind: "inventory_granted" }]) {
    assert.equal(replayContract.compareReplay({ ...input, existing: { ...existing, ...metadata } }), false);
  }
  const body = { format: context.format, version: context.version, family: context.family, originScope: context.originScope, currentScope: context.currentScope, identities: context.identities };
  for (const field of ["workspaceId", "worldId", "worldlineId"] as const) {
    const wrongOrigin = replayContract.createReplayContext({ ...body, originScope: { ...context.originScope, [field]: "different" } });
    assert.equal(replayContract.compareReplay({ ...input, existing: { ...existing, replayProof: { context: wrongOrigin, binding: { ...existing.replayProof.binding, contextId: wrongOrigin.id } } } }), false);
    assert.equal(replayContract.compareReplay({ ...input, trustedScope: { ...LINEAGE_TARGET, [field]: "different" } }), false);
  }
  let reads = 0;
  const malformed = { ...existing.replayProof.binding };
  Object.defineProperty(malformed, "contextId", { enumerable: true, get() { reads++; return context.id; } });
  assert.equal(replayContract.compareReplay({ ...input, existing: { ...existing, replayProof: { context, binding: malformed } } }), false);
  assert.equal(reads, 0);
});

test("F2b1 projection/composition enforce an injected exact UTF8 budget without claiming the real 64MiB boundary", () => {
  const context = lineageFixtureContext("fact");
  const maximum = Buffer.byteLength(lineageOracleJson(context), "utf8");
  const closure = lineageClosure(context);
  assert.throws(() => replayContract.composeReplayContext(context, LINEAGE_TARGET, closure, LINEAGE_TARGET, lineagePlan(closure, "-longer-target"), { maxBytes: maximum }), { code: "REPLAY_LINEAGE_LIMIT" });
  assert.throws(() => replayContract.projectReplayContext(context, LINEAGE_TARGET, { ...closure, event: [...closure.event, "new-event"] }, { maxBytes: maximum }), { code: "REPLAY_LINEAGE_LIMIT" });
  assert.equal(replayContract.decodeReplayContext(context).id, context.id);
});

test("F2b1 unrelated closure namespaces do not consume a family's lineage byte budget", () => {
  const context = lineageFixtureContext("finance");
  const selectedClosure = lineageClosure(context);
  const actualClosure = { ...selectedClosure,
    event: Array.from({ length: 1025 }, (_, i) => `unrelated-event-${i}`),
    characterInstance: ["unrelated-actor"], assetDefinition: ["unrelated-asset"],
  };
  const contextBytes = Buffer.byteLength(lineageOracleJson(context), "utf8");
  assert.equal(replayContract.projectReplayContext(context, LINEAGE_TARGET, actualClosure, { maxBytes: contextBytes }).id, context.id,
    "finance proof must not charge unrelated event/actor/asset closure bytes");
  const fp = "0123456789abcdef".repeat(4);
  const refs = [{ id: "receipt", family: "finance", requestFingerprint: fp, replayLineage: { version: 1, contextId: context.id, originalRequestFingerprint: fp } }];
  const expectedBytes = Buffer.byteLength(lineageOracleJson({ contexts: [context], receipts: refs }), "utf8");
  assert.equal(replayContract.validateReplayBundle([context], refs, LINEAGE_TARGET, actualClosure, { maxBytes: expectedBytes }).byteLength, expectedBytes);
});

test("F2b2 domain codec carries dedicated fact lineage and rejects malformed recognized metadata", () => {
  const domain = domainFixture();
  const context = replayContract.createReplayContext({
    format: "realm-command-lineage-context", version: 1, family: "fact",
    originScope: SCOPE, currentScope: SCOPE,
    identities: { record: [[RECORD_ID, RECORD_ID]], event: Array.from({ length: 1025 }, (_, i) => {
      const id = `event-${String(i).padStart(4, "0")}`; return [id, id];
    }), scene: [], characterInstance: [], assetDefinition: [], project: [], financeAccount: [], milestone: [], obligation: [] },
  });
  const original = domain.committedFactCommands[0]!;
  const bound = { ...domain, commandReplayContexts: [context], committedFactCommands: [{
    ...original, provenance: "legacy-result-v1" as const, request: null,
    replayLineage: { version: 1 as const, contextId: context.id, originalRequestFingerprint: original.requestFingerprint },
  }, ...domain.committedFactCommands.slice(1)] };
  const parsed = parseRealmRuntimeSaveDomainV1(serializeRealmRuntimeSaveDomainV1(bound));
  assert.deepEqual(parsed.commandReplayContexts, [context]);
  for (const bad of [
    { ...bound, commandReplayContexts: [] },
    { ...bound, commandReplayContexts: [context, context] },
    { ...bound, committedFactCommands: [{ ...bound.committedFactCommands[0], replayLineage: null }] },
    { ...bound, committedFactCommands: [{ ...bound.committedFactCommands[0], provenance: "request-result-v1", request: original.request }] },
    { ...bound, commandReplayContexts: [{ ...context, id: "0".repeat(64) }] },
  ]) assert.throws(() => serializeRealmRuntimeSaveDomainV1(bad as RealmRuntimeSaveDomainV1));
});


test("F2b3 mixed-family archive contexts use actual Finance closure and preserve Fact coverage", () => {
  const domain = domainFixture();
  const financeClosure = runtimeFinanceReplayClosure(record, domain, topology);
  const factClosure = runtimeFactReplayClosure(record, domain, topology);
  const context = (family: "fact" | "finance", closure: ReplayClosure) => replayContract.createReplayContext({
    format: "realm-command-lineage-context", version: 1, family, originScope: SCOPE, currentScope: SCOPE,
    identities: Object.fromEntries(Object.entries(closure).map(([kind, ids]) => [kind, ids.map((id) => [id, id])])),
  });
  const finance = context("finance", financeClosure), fact = context("fact", factClosure);
  const group = domain.financeCommandGroups[0]!;
  const command = domain.committedFactCommands[0]!;
  const mixed: RealmRuntimeSaveDomainV1 = { ...domain, commandReplayContexts: [finance, fact].sort((a, b) => a.id < b.id ? -1 : 1),
    financeCommandGroups: [{ ...group, policyVersion: "project-finance-command.v1", provenance: "legacy-result-v1", request: null,
      replayLineage: { version: 1, contextId: finance.id, originalRequestFingerprint: group.requestFingerprint } }, ...domain.financeCommandGroups.slice(1)],
    committedFactCommands: [{ ...command, provenance: "legacy-result-v1", request: null,
      replayLineage: { version: 1, contextId: fact.id, originalRequestFingerprint: command.requestFingerprint } }, ...domain.committedFactCommands.slice(1)],
  };
  const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ manifest: manifestFor(mixed), record, goals, topology, domain: mixed }));
  assert.deepEqual(parsed.domain!.commandReplayContexts, mixed.commandReplayContexts);
  assert.deepEqual(financeClosure.scene, ["legacy-scene", "scene-1"], "all carried Records use actual event scenes or the existing empty-Record fallback");
  assert.deepEqual(runtimeReplaySourceSceneIds(undefined, []), ["legacy-scene"]);
  assert.deepEqual(runtimeReplaySourceSceneIds([{ sourceSceneId: "explicit-scene" }], ["event-scene"]), ["explicit-scene"]);
  for (const patch of [{ state: "rejected", rejectionCode: "TEST" }, { policyVersion: "unsupported" },
    { provenance: "request-result-v1", request: group.request }, { replayLineage: { ...mixed.financeCommandGroups[0]!.replayLineage, contextId: fact.id } },
    { replayLineage: null }]) {
    assert.throws(() => serializeRealmRuntimeSaveDomainV1({ ...mixed, financeCommandGroups: [{ ...mixed.financeCommandGroups[0]!, ...patch } as never] }));
  }
  const extraScene = replayContract.createReplayContext({ ...(() => { const body = { ...finance }; Reflect.deleteProperty(body, "id"); return body; })(),
    identities: { ...finance.identities, scene: [...finance.identities.scene, ["unrelated-scene", "unrelated-scene"]] } });
  const bad = { ...mixed, commandReplayContexts: [fact, extraScene].sort((a, b) => a.id < b.id ? -1 : 1),
    financeCommandGroups: [{ ...mixed.financeCommandGroups[0]!, replayLineage: { ...mixed.financeCommandGroups[0]!.replayLineage!, contextId: extraScene.id } }] };
  assert.throws(() => buildRealmRuntimeSaveArchive({ manifest: manifestFor(bad), record, goals, topology, domain: bad }), "rehashed extra map cannot expand actual closure");
});

test("R1 bounded restorer composes actual empty memory-anchor Finance target maps", async () => {
  // This materialized closure isolates restore; it does not simulate memory
  // discovery, PostgreSQL constraints, or a completed restore.
  const { readFileSync } = await import("node:fs");
  const { createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
  const fixture = domainFixture(), memoryId = "record-memory-anchor", historicalC = "record-history-C";
  const scene = (sourceSceneId: string) => ({ sourceSceneId, title: "Scene", status: "active" as const, location: "", objective: "", tension: "", weather: "", displayTime: "", startTick: 0, startOrdinal: 0, endTick: null, endOrdinal: null });
  const sibling = fixture.records[0]!;
  const memoryTopology = structuredClone(topology);
  const character = memoryTopology.participants[0]!.character;
  memoryTopology.participants[0]!.sourceParticipantId = "participant-memory";
  character.sourceCharacterInstanceId = "instance-memory";
  character.sourceContinuityId = "continuity-memory";
  character.sourceDefinitionId = "definition-memory";
  character.continuity.continuityKey = "memory";
  character.instance.state = { literalRecordId: historicalC };
  const source = { ...fixture, stories: [...fixture.stories, { id: "story-memory", title: "Memory Story", status: "active" as const, premise: "" }],
    records: [{ ...sibling, bundle: { ...sibling.bundle, topology: { ...topology, participants: [], scenes: [scene("scene-sibling")] } } },
      { ...sibling, recordId: memoryId, storyId: "story-memory", bundle: { ...sibling.bundle,
        record: { ...sibling.bundle.record, scope: { ...sibling.bundle.record.scope, recordId: memoryId } }, topology: memoryTopology } }],
  };
  const contextual = (value: typeof source) => {
    const contexts = (["fact", "finance"] as const).map(family => {
      const closure = family === "fact" ? runtimeFactReplayClosure(record, value, topology) : runtimeFinanceReplayClosure(record, value, topology);
      assert.ok(closure.record.includes(memoryId)); assert.ok(!closure.record.includes(historicalC));
      return replayContract.createReplayContext({ format: "realm-command-lineage-context", version: 1, family,
        originScope: SCOPE, currentScope: SCOPE,
        identities: Object.fromEntries(Object.entries(closure).map(([kind, ids]) => [kind, ids.map(id => [id, id])])),
      });
    });
    return { ...value, commandReplayContexts: contexts.sort((a, b) => a.id < b.id ? -1 : 1),
      committedFactCommands: value.committedFactCommands.map(command => ({ ...command, provenance: "legacy-result-v1" as const, request: null,
        replayLineage: { version: 1 as const, contextId: contexts.find(c => c.family === "fact")!.id, originalRequestFingerprint: command.requestFingerprint } })),
      financeCommandGroups: value.financeCommandGroups.map(group => ({ ...group, provenance: "legacy-result-v1" as const, request: null, policyVersion: "project-finance-command.v1",
        replayLineage: { version: 1 as const, contextId: contexts.find(c => c.family === "finance")!.id, originalRequestFingerprint: group.requestFingerprint } })),
    };
  };
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const known = new Set<string>(["BEGIN", "COMMIT", "ROLLBACK",
    // Exact dynamic-template branch, already modeled by the handler below.
    "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE"]);
  for (const file of ["realm-runtime-save-repository.ts", "workspace-transaction.ts"])
    for (const m of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g))
      if (!m[1].includes("${")) known.add(norm(m[1]));
  const boundary = new Error("AFTER_TYPED_NORMALIZATION_BOUNDARY");
  for (const emptyCount of [1, 0, 2]) {
    const value = structuredClone(source);
    if (emptyCount === 0) value.records[1]!.bundle.topology!.scenes = [scene("scene-memory")];
    if (emptyCount === 2) value.records[0]!.bundle.topology!.scenes = [];
    const domain = contextual(value);
    const manifest = { ...manifestFor(domain), mode: "world-bound" as const, world: { worldId: SCOPE.worldId, worldVersion: "1.2.0" } };
    const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ record, goals, topology, domain, manifest }));
    const before = structuredClone(archive), calls: string[] = [];
    let financeReceipt: Record<string, unknown> | undefined;
    const client = { release() {}, async query(raw: string, values: unknown[] = []) {
      const sql = norm(raw); calls.push(sql);
      if (!known.has(sql)) throw Error("UNKNOWN_R1_RESTORE_SQL:" + sql);
      let rows: Record<string, unknown>[];
      if (["BEGIN", "COMMIT", "ROLLBACK", "SELECT set_config('realm.workspace_id', $1, true)"].includes(sql)) rows = [];
      else if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE") {
        assert.deepEqual(values, ["target-ws", SCOPE.worldId]); rows = [{ world_version: "1.2.0", status: "active", settings: {} }];
      } else if (sql === "SELECT role FROM player_world_memberships WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3") {
        assert.deepEqual(values, ["target-ws", SCOPE.worldId, "owner"]); rows = [{ role: "owner" }];
      } else if (sql === "SELECT id, asset_key, rule_pack_key FROM asset_definitions WHERE workspace_id = $1 AND world_id = $2 AND id = $3") {
        assert.deepEqual(values, ["target-ws", SCOPE.worldId, "asset-1"]); rows = [{ id: "asset-1", asset_key: "asset", rule_pack_key: "native" }];
      } else if (sql === "SELECT octet_length($1::jsonb::text) AS bytes") {
        assert.equal(values.length, 1); financeReceipt = JSON.parse(String(values[0])); throw boundary;
      } else throw Error("UNHANDLED_R1_RESTORE_SQL:" + sql);
      return { rows, rowCount: rows.length };
    } };
    const restore = () => createPostgresRealmRuntimeSaveRestorer({ connect: async () => client } as never, { validateWorldBinding: async () => {} })
      .restore({ workspaceId: "target-ws", principalId: "owner", targetWorldId: SCOPE.worldId, archive, idempotencyKey: "r1-bounded" });
    if (emptyCount === 2) {
      await assert.rejects(restore, { code: "RUNTIME_SAVE_INVALID", message: "Runtime Finance lineage cannot be composed with the actual target maps." });
      assert.equal(financeReceipt, undefined);
    } else {
      await assert.rejects(restore, error => error === boundary);
      const context = financeReceipt!.replayContext as ReplayContextV1;
      assert.ok(context.identities.record.some(([target, origin]) => target !== memoryId && origin === memoryId));
      assert.ok(!context.identities.record.some(([target, origin]) => target === historicalC || origin === historicalC));
      if (emptyCount === 1) {
        assert.ok(runtimeFinanceReplayClosure(record, domain, topology).scene.includes("legacy-scene"));
        assert.ok(context.identities.scene.some(([target, origin]) => origin === "legacy-scene" && target.startsWith("scene_restore_")));
      }
    }
    assert.deepEqual(archive, before);
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.ok(!calls.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)));
    const fact = domain.commandReplayContexts.find(c => c.family === "fact")!;
    const factBody = { ...fact }; Reflect.deleteProperty(factBody, "id");
    const bogus = replayContract.createReplayContext({ ...factBody, identities: { ...fact.identities,
      record: [...fact.identities.record, [historicalC, historicalC] as const].sort(([a], [b]) => a < b ? -1 : 1) } });
    const forged = { ...domain, commandReplayContexts: domain.commandReplayContexts.map(c => c === fact ? bogus : c).sort((a, b) => a.id < b.id ? -1 : 1),
      committedFactCommands: domain.committedFactCommands.map(c => ({ ...c, replayLineage: { ...c.replayLineage, contextId: bogus.id } })),
    };
    assert.throws(() => buildRealmRuntimeSaveArchive({ record, goals, topology, domain: forged, manifest: manifestFor(forged) }));
  }
});

test("A4-T direct archive refuses witness in open result objects for modern and proven legacy receipts", async () => {
  const fixture = domainFixture();
  const request = { command: "performance.assessed", recordId: RECORD_ID, policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event-1"] };
  const fingerprint = committedFactRequestFingerprintFor(SCOPE, request);
  const id = committedFactCommandIdFor(SCOPE, "transport-performance", fingerprint);
  const assessmentId = `${id}:assessment`, snapshotHash = evidenceHash(request.evidenceEventIds);
  const original = { ...fixture, committedFactCommands: [...fixture.committedFactCommands, {
    id, idempotencyKey: "transport-performance", requestFingerprint: fingerprint, kind: "performance_assessed" as const,
    provenance: "request-result-v1" as const, request,
    resultManifest: { status: "committed", commandId: id, assessmentId, score: 10, evidenceSnapshotHash: snapshotHash, goalTransition: null },
  }], performanceAssessments: [...fixture.performanceAssessments, {
    id: assessmentId, recordId: RECORD_ID, policyVersion: request.policyVersion, score: 10,
    evidenceEventIds: request.evidenceEventIds, evidenceSnapshotHash: snapshotHash, commandId: id,
  }] };
  const closure = runtimeFactReplayClosure(record, original, topology);
  const context = replayContract.createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "fact",
    originScope: SCOPE, currentScope: SCOPE,
    identities: Object.fromEntries(Object.entries(closure).map(([kind, ids]) => [kind, ids.map(id => [id, id])])),
  });
  for (const legacy of [false, true]) {
    const source = { ...original, ...(legacy ? { commandReplayContexts: [context] } : {}),
      committedFactCommands: original.committedFactCommands.map(command => command.kind !== "performance_assessed" || !legacy ? command : {
        ...command, provenance: "legacy-result-v1" as const, request: null,
        replayLineage: { version: 1 as const, contextId: context.id, originalRequestFingerprint: command.requestFingerprint },
      }),
    };
    const data = { record, goals, topology, domain: source, manifest: manifestFor(source) };
    const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(data));
    assert.deepEqual(archive.domain, source, "markerless modern and fully proven legacy remain supported");
    for (const marker of [{ version: 1, manifestHash: "b".repeat(64) }, { version: 900 }, null]) {
      const altered = structuredClone(archive);
      const command = altered.domain!.committedFactCommands.find(command => command.kind === "performance_assessed")!;
      (command.resultManifest as Record<string, unknown>).performanceWitness = marker;
      assert.throws(() => normalizeRealmRuntimeSaveDomainV1(altered.domain), /performance witness transport is unsupported/);
      let connects = 0;
      const { createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
      await assert.rejects(createPostgresRealmRuntimeSaveRestorer({ connect: async () => { connects++; throw Error("UNEXPECTED_DATABASE_ACCESS"); } } as never)
        .restore({ workspaceId: SCOPE.workspaceId, principalId: "owner", targetWorldId: SCOPE.worldId, idempotencyKey: "unsupported-witness", archive: altered }),
      { code: "RUNTIME_SAVE_INVALID" });
      assert.equal(connects, 0);
    }
  }
});

}

// Public reader compatibility: a world-bound identity is not a schema capability.
const A2_MAP_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const A2_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
async function a2ReaderProtocol(schema: boolean, purpose: "record-export" | "whole-closure-backup", mapRows: Record<string, unknown>[] = [], factRows: Record<string, unknown>[] = [], observedCalls?: { sql: string; values: unknown[] }[], witnessRows: Record<string, unknown>[] = []) {
  const { readFileSync } = await import("node:fs");
  const { topologyHeaderSql } = await import("../database/postgres/runtime-topology-resource-reader.ts");
  const { evidenceHeaderSql, evidenceFields } = await import("../database/postgres/runtime-evidence-resource-reader.ts");
  const { createPostgresRealmRuntimeSaveReader } = await import("../database/postgres/realm-runtime-save-repository.ts");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const known = new Set([A2_MAP_SQL, A2_CAPABILITY_SQL, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK", "SELECT set_config('realm.workspace_id', $1, true)"]);
  for (const m of readFileSync(new URL("../database/postgres/realm-runtime-save-repository.ts", import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) if (!m[1].includes("${")) known.add(norm(m[1]));
  for (const family of ["participants", "scenes", "visibility"] as const) known.add(norm(topologyHeaderSql(family)));
  known.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
  const empty = new Set(["events", "goal_instances", "goal_assessments", "record_goal_definitions", "participants", "scenes", "visibility_policies", "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "outbox", "record_first_nights", "record_self_play_sessions", "projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "story_node_instances", "story_unlock_ledger", "committed_fact_commands", "performance_assessments", "member_relationship_revisions", "character_assets", "story_definition_bindings", "record_archives", "worldlines", "records"]);
  const calls: { sql: string; values: unknown[] }[] = observedCalls ?? [];
  const evidenceCursors = new Set<string>();
  const client = { release() {}, async query(raw: string, values: unknown[] = []) {
    const sql = norm(raw); calls.push({ sql, values });
    if (sql === norm(GOAL_TRANSPORT_CAPABILITY_SQL)) {
      assert.deepEqual(values, []);
      return { rows: [{ available: false }], rowCount: 1 };
    }
    if (sql === norm(PERFORMANCE_EVIDENCE_SOURCE_SQL)) {
      const command = factRows[0]!;
      const manifest = command.result_manifest as { request: { recordId: string }; result: { assessmentId: string } };
      assert.deepEqual(values, ["a2-ws", "world-demo", "worldline-source", manifest.request.recordId, command.id, manifest.result.assessmentId]);
      return { rows: structuredClone(witnessRows), rowCount: witnessRows.length };
    }
    const cursor = / DECLARE (realm_evidence_[a-f0-9]{32}) NO SCROLL CURSOR FOR /.exec(sql)?.[1];
    if (cursor && (Object.keys(evidenceFields) as (keyof typeof evidenceFields)[]).some(family => sql === norm(evidenceHeaderSql(family, cursor)))) {
      assert.deepEqual(values, ["a2-ws", "world-demo", "worldline-source", "record-demo"]);
      evidenceCursors.add(cursor); return { rows: [], rowCount: 0 };
    }
    const fetch = /^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]{32})$/.exec(sql);
    const close = /^CLOSE (realm_evidence_[a-f0-9]{32})$/.exec(sql);
    if ((fetch || close) && evidenceCursors.has((fetch || close)![1])) {
      assert.deepEqual(values, []);
      if (close) evidenceCursors.delete(close[1]);
      return { rows: [], rowCount: 0 };
    }
    if (sql === A2_CAPABILITY_SQL) { assert.deepEqual(values, []); return { rows: [{ command_materializations_available: schema }], rowCount: 1 }; }
    if (sql === A2_MAP_SQL) {
      assert.deepEqual(values, ["a2-ws", "world-demo", "worldline-source"]);
      if (!schema) throw Error("LEGACY_TABLE_MISSING_SENTINEL");
      return { rows: mapRows, rowCount: mapRows.length };
    }
    const root = sql.includes("record.id AS record_id");
    if (!known.has(sql) && !(root && sql.includes("backup_membership")) && !sql.startsWith("/* runtime event headers */") && !sql.startsWith("/* runtime outbox headers;") && !sql.startsWith("/* memory resource")) throw Error("UNKNOWN_A2_READER_SQL:" + sql);
    let rows: Record<string, unknown>[];
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql)) rows = [];
    else if (root) rows = [{ world_id: "world-demo", worldline_id: "worldline-source", record_id: "record-demo", story_id: "story-demo", world_version: "1.2.0", record_version: 0, next_record_ordinal: 0 }];
    else if (sql.includes("FROM player_world_memberships")) rows = [{ role: "owner" }];
    else if (sql.startsWith("SELECT status FROM records")) rows = [{ status: "active" }];
    else if (sql.endsWith("AS mixed")) rows = [{ mixed: false }];
    else if (sql.endsWith("AS bound")) rows = [{ bound: false }];
    else if (sql.includes("unsupported_scoped_goal")) rows = [];
    else if (sql.startsWith("/* runtime event headers */") || sql.startsWith("/* runtime outbox headers;") || sql.startsWith("/* memory resource")) rows = [];
    else if (sql.includes("FROM stories")) rows = [{ id: "story-demo", title: "Story", status: "active", premise: "" }];
    else if (sql.includes("FROM committed_fact_commands")) rows = factRows;
    else if (empty.has(/\bFROM (\w+)/.exec(sql)?.[1] ?? "")) rows = [];
    else throw Error("UNHANDLED_A2_READER_SQL:" + sql);
    return { rows, rowCount: rows.length };
  } };
  const previous = process.env.REALM_OPERATOR_PRINCIPALS;
  process.env.REALM_OPERATOR_PRINCIPALS = "a2-owner";
  let archive;
  // This protocol fixture models a pre-witness consumer; the production reader
  // now opts in by default, so explicitly override that capability here.
  try { archive = await createPostgresRealmRuntimeSaveReader({ connect: async () => client } as never, { performanceWitnessesSchemaVersion: undefined }).load({ workspaceId: "a2-ws", recordId: "record-demo", principalId: "a2-owner", purpose }); }
  finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
  assert.ok(archive);
  return { archive: parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)), calls };
}
for (const purpose of ["record-export", "whole-closure-backup"] as const) {
  test(`A4-T ${purpose} verifies the original source then explicitly refuses unsupported witness capability`, async () => {
    const scope = { workspaceId: "a2-ws", worldId: "world-demo", worldlineId: "worldline-source" };
    const request = { command: "performance.assessed", recordId: "record-demo", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event-evidence"] };
    const fingerprint = committedFactRequestFingerprintFor(scope, request);
    const commandId = committedFactCommandIdFor(scope, "witness-export", fingerprint), assessmentId = `${commandId}:assessment`;
    const header = { id: "event-evidence", sceneId: "historical-scene", visibilityPolicyId: "private-policy", policyVersion: "1", policyKind: "private", recordVersion: "1", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
    const snapshot: PerformanceEvidenceSnapshotV1 = {
      version: 1, scope: { ...scope, recordId: "record-demo" }, commandId, assessmentId, requestFingerprint: fingerprint,
      policyVersion: "structured-factors:v1", admission: { principalId: "historical-player", role: "player", evidencePolicyId: "approved-fixture", evidenceMode: "engine-authoritative-v1" },
      binding: { storyId: "story-demo", worldVersion: "1.2.0" },
      head: { recordVersion: "1", nextRecordOrdinal: "2", lastEventId: header.id, lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" },
      worldlineHead: { tick: "3", ordinal: "0" }, currentScene: { id: header.sceneId, startTick: "0", startOrdinal: "0", status: "active" },
      headEvent: header, evidence: [{ ...header, sceneStartTick: "0", sceneStartOrdinal: "0" }],
      factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null,
    };
    const hash = evidenceHash(request.evidenceEventIds), manifestHash = performanceEvidenceSnapshotHash(snapshot);
    const row = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId,
      id: commandId, idempotency_key: "witness-export", request_fingerprint: fingerprint, kind: "performance_assessed", receipt_oversized: false,
      result_manifest: { request, result: { status: "committed", commandId, assessmentId, score: 10, evidenceSnapshotHash: hash, goalTransition: null }, performanceWitness: { version: 1, manifestHash } } };
    const sidecar = { record_id: "record-demo", assessment_id: assessmentId, command_id: commandId, version: 1,
      manifest_canonical: performanceEvidenceSnapshotCanonical(snapshot), manifest_hash: manifestHash,
      policy_version: "structured-factors:v1", score: 10, evidence_event_ids: request.evidenceEventIds, evidence_snapshot_hash: hash,
      assessment_record_id: "record-demo", assessment_command_id: commandId };
    const before = structuredClone({ row, sidecar });
    const calls: { sql: string; values: unknown[] }[] = [];
    await assert.rejects(a2ReaderProtocol(false, purpose, [], [row], calls, [sidecar]), {
      code: "PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED", message: "The consumer does not support complete performance witness transport.",
    });
    assert.equal(calls.filter(call => call.sql === PERFORMANCE_EVIDENCE_SOURCE_SQL.replace(/\s+/g, " ").trim()).length, 1);
    assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(calls.at(-1)?.sql, "ROLLBACK");
    assert.ok(!calls.some(call => /^(INSERT|UPDATE|DELETE|COMMIT)/.test(call.sql)));
    assert.deepEqual({ row, sidecar }, before);
    assert.ok(!JSON.stringify(calls).includes("historical-player"), "source principal is never a SQL authorization input");
  });

  test(`A4-T ${purpose} refuses invalid raw witness source before receipt projection`, async () => {
    const request = { command: "performance.assessed", recordId: "record-demo", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event-evidence"] };
    const scope = { workspaceId: "a2-ws", worldId: "world-demo", worldlineId: "worldline-source" };
    const fingerprint = committedFactRequestFingerprintFor(scope, request);
    const id = committedFactCommandIdFor(scope, "witness-export", fingerprint);
    const receipt = { request, result: { status: "committed", commandId: id, assessmentId: `${id}:assessment`, score: 10, evidenceSnapshotHash: evidenceHash(request.evidenceEventIds), goalTransition: null } };
    for (const marker of [{ version: 1, manifestHash: "a".repeat(64) }, { version: 99 }, null, false]) {
      for (const envelope of [receipt, { provenance: "request-result-v1", ...receipt }, { provenance: "legacy-result-v1", result: receipt.result }, receipt.result]) {
        const calls: { sql: string; values: unknown[] }[] = [];
        const row = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id,
          idempotency_key: "witness-export", request_fingerprint: fingerprint, kind: "performance_assessed", receipt_oversized: false,
          result_manifest: { ...envelope, performanceWitness: marker } };
        const before = structuredClone(row);
        await assert.rejects(a2ReaderProtocol(false, purpose, [], [row], calls), {
          code: "RUNTIME_SAVE_INVALID", message: "Performance source proof is invalid.",
        });
        assert.deepEqual(row, before);
        assert.equal(calls.at(-1)?.sql, "ROLLBACK");
        assert.ok(!calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)));
        const sourceReads = calls.filter(c => c.sql === PERFORMANCE_EVIDENCE_SOURCE_SQL.replace(/\s+/g, " ").trim());
        const completeEnvelope = "request" in envelope;
        assert.equal(sourceReads.length, marker !== null && typeof marker === "object" && marker.version === 1 && completeEnvelope ? 1 : 0);
      }
    }
  });
}
for (const purpose of ["record-export", "whole-closure-backup"] as const) {
  test(`A2 public ${purpose} reader preserves legacy schema without assuming map table`, async () => {
    const f = await a2ReaderProtocol(false, purpose);
    assert.equal(f.archive.domain?.commandMaterializations, undefined);
    assert.equal(f.calls.filter(c => c.sql === A2_CAPABILITY_SQL).length, 1);
    assert.equal(f.calls.filter(c => c.sql === A2_MAP_SQL).length, 0);
    assert.equal(f.calls.at(-1)?.sql, "COMMIT");
  });
  test(`A2 public ${purpose} reader reads explicitly empty installed schema map`, async () => {
    const f = await a2ReaderProtocol(true, purpose);
    assert.equal(f.archive.domain?.commandMaterializations, undefined);
    assert.equal(f.calls.filter(c => c.sql === A2_CAPABILITY_SQL).length, 1);
    assert.equal(f.calls.filter(c => c.sql === A2_MAP_SQL).length, 1);
  });
}

test("A2 public restore refuses map on legacy target before writes", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { installSignedRealmWorldFixture, syntheticCommandPolicyFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  const { createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
  const directory = await mkdtemp(join(tmpdir(), "a2-target-schema-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  await installSignedRealmWorldFixture({ installRoot: directory, worldId: "world-demo", version: "1.2.0", recordTitle: "Synthetic", keyId: "test", keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() }, commandPolicy: syntheticCommandPolicyFixture(), declaredEvents: ["synthetic.ready"] });
  const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver({ installRoot: directory, verifySignature: ({ manifest }) => verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) });
  const policy = (await resolveCommandPolicy({ worldId: "world-demo", worldVersion: "1.2.0" }))!;
  const source = (await a2ReaderProtocol(true, "record-export")).archive;
  const domain = { ...source.domain!, projects: [{ id: "project-a2", kind: "production" as const, status: "planned" as const, stage: "planning" as const, title: "Synthetic", currency: "JPY" as const, deadline: null, version: 1 }],
    milestones: ["prior", "target"].map((key, i) => ({ id: `milestone-${key}`, projectId: "project-a2", sequence: i + 1, title: key, status: "planned" as const, dueOn: null, completionRecordId: null, completionEventId: null })),
    projectStoryLinks: [{ id: "link-a2", projectId: "project-a2", storyId: "story-demo", linkKind: "primary" as const }],
    commandMaterializations: { format: "realmworld-command-materializations" as const, schemaVersion: 1 as const, worldVersion: "1.2.0", contentHash: policy.contentHash, policyVersion: policy.policyVersion,
      rows: ["prior", "target"].map(key => ({ projectKey: "p", milestoneKey: key, projectId: "project-a2", milestoneId: `milestone-${key}`, storyId: "story-demo", recordId: "record-demo" })) } };
  const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ ...source, domain, manifest: realmRuntimeSaveManifestFromData({ ...source, domain, engineApi: "1.x", mode: "world-bound", world: { worldId: "world-demo", worldVersion: "1.2.0" }, scope: source.manifest.scope }) }));
  const calls: string[] = [];
  const client = { release() {}, async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); calls.push(sql);
    if (sql === A2_CAPABILITY_SQL) { assert.deepEqual(values, []); return { rows: [{ command_materializations_available: false }], rowCount: 1 }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT world_version, status, settings FROM worlds")) return { rows: [{ world_version: "1.2.0", status: "active", settings: { declaredEvents: ["synthetic.ready"] } }], rowCount: 1 };
    if (sql.startsWith("SELECT role FROM player_world_memberships")) return { rows: [{ role: "owner" }], rowCount: 1 };
    throw Error("UNHANDLED_A2_RESTORE_SQL:" + sql);
  } };
  await assert.rejects(createPostgresRealmRuntimeSaveRestorer({ connect: async () => client } as never, { validateWorldBinding: async () => {}, resolveCommandPolicy }).restore({ workspaceId: "target-ws", principalId: "target-owner", targetWorldId: "world-demo", archive, idempotencyKey: "legacy-map" }), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(calls.filter(sql => sql === A2_CAPABILITY_SQL).length, 1);
  assert.equal(calls.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});

function a2PrimaryPolicyClosureFixture() {
  return {
    ...domain,
    stories: [
      { id: "story-demo", title: "Source Story", status: "active", premise: "" },
      { id: "story-existing-other", title: "Other existing Story", status: "active", premise: "" },
    ],
    storyDefinitions: [], records: [],
    projects: [{ id: "project-closure", kind: "production", status: "planned", stage: "planning", title: "Closure", currency: "JPY", deadline: null, version: 1 }],
    milestones: [{ id: "milestone-closure", projectId: "project-closure", sequence: 1, title: "Closure", status: "planned", dueOn: null, completionRecordId: null, completionEventId: null }],
    projectStoryLinks: [{ id: "link-closure", projectId: "project-closure", storyId: "story-demo", linkKind: "primary" }],
    commandMaterializations: {
      format: "realmworld-command-materializations", schemaVersion: 1, worldVersion: "1.2.0",
      // A normalizer fixture digest, not signed-package or historical authority.
      contentHash: createHash("sha256").update("Synthetic primary Record closure fixture").digest("hex"),
      policyVersion: "closure.v1",
      rows: [{ projectKey: "p", milestoneKey: "m", projectId: "project-closure", milestoneId: "milestone-closure", storyId: "story-demo", recordId: "record-demo" }],
    },
  };
}

test("A2 primary policy Record retains its exact source Story binding", () => {
  const result = normalizeRealmRuntimeSaveDomainV1(a2PrimaryPolicyClosureFixture());
  assert.equal(result.commandMaterializations!.rows[0]!.storyId, result.source.storyId);
});

test("A2 primary policy Record rejects an existing but incorrectly paired Story", () => {
  const value = a2PrimaryPolicyClosureFixture();
  value.projectStoryLinks[0]!.storyId = "story-existing-other";
  value.commandMaterializations.rows[0]!.storyId = "story-existing-other";
  assert.throws(() => normalizeRealmRuntimeSaveDomainV1(value), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "INVALID_DOMAIN_SAVE"
      && /commandMaterializations\.closure/.test(error.message));
});

// F2b4 default-budget controls: pure codecs and persisted-row decoders only.
// No PostgreSQL, SQL wire-size, full restore or historical authenticity claim.
const F2_CAPACITY_SOURCE = { workspaceId: "ws0", worldId: "w0", worldlineId: "l0" };
const F2_CAPACITY_TARGET = { workspaceId: "ws1", worldId: "w1", worldlineId: "l1" };
const F2_CAPACITY_KINDS = ["record", "event", "scene", "characterInstance", "assetDefinition", "project", "financeAccount", "milestone", "obligation"] as const;
function f2CapacityBase(family: "fact" | "finance") {
  const identities: Record<ReplayIdentityKind, string[][]> = { record: [], event: [], scene: [], characterInstance: [], assetDefinition: [], project: [], financeAccount: [], milestone: [], obligation: [] };
  const body = { format: "realm-command-lineage-context", version: 1, family,
    originScope: F2_CAPACITY_SOURCE, currentScope: F2_CAPACITY_TARGET, identities };
  body.identities.record = [["r1", "r0"]];
  if (family === "fact") {
    body.identities.event = [["e1", "e0"]];
    body.identities.characterInstance = [["c1", "c0"]];
    body.identities.assetDefinition = [["a1", "a0"]];
  } else {
    body.identities.scene = [["s1", "s0"]];
    body.identities.project = [["p1", "p0"]];
  }
  return body;
}

function f2CapacityContextBody(targetBytes: number, family: "fact" | "finance") {
  const body = f2CapacityBase(family);
  const kind = family === "fact" ? "event" : "scene";
  body.identities[kind] = [];
  const empty = replayContract.createReplayContext(body);
  const emptyBytes = Buffer.byteLength(JSON.stringify(empty));
  const tagBytes = emptyBytes - Buffer.byteLength(JSON.stringify(body));
  const prefix = (index: number, side: string) => side + String(index).padStart(8, "0");
  const fullPairBytes = Buffer.byteLength(JSON.stringify([prefix(0, "c").padEnd(256, "c"), prefix(0, "o").padEnd(256, "o")]));
  const count = Math.ceil((targetBytes - emptyBytes + 1) / (fullPairBytes + 1));
  assert.ok(count > 1024);
  const pairs = Array.from({ length: count }, (_, index) => [prefix(index, "c").padEnd(256, "c"), prefix(index, "o").padEnd(256, "o")]);
  let excess = emptyBytes + count * (fullPairBytes + 1) - 1 - targetBytes;
  for (let index = pairs.length - 1; excess > 0 && index >= 0; index--) {
    for (const side of [1, 0]) {
      const removable = pairs[index]![side]!.length - prefix(index, side === 0 ? "c" : "o").length;
      const remove = Math.min(removable, excess);
      pairs[index]![side] = pairs[index]![side]!.slice(0, pairs[index]![side]!.length - remove);
      excess -= remove;
    }
  }
  assert.equal(excess, 0);
  body.identities[kind] = pairs;
  assert.equal(Buffer.byteLength(JSON.stringify(body)) + tagBytes, targetBytes);
  return body;
}

function f2CapacityReference(context: ReplayContextV1, index: number) {
  const family = context.family;
  const request = family === "fact"
    ? { command: "inventory.granted", recordId: "r0", characterInstanceId: "c0", assetDefinitionId: "a0", sourceEventId: context.identities.event[0]![1]!, quantity: 1 }
    : { command: "project.stage.changed", projectId: "p0", stage: "production", expectedProjectVersion: 0, evidence: null };
  const requestFingerprint = family === "fact" ? committedFactRequestFingerprintFor(context.originScope, request)
    : projectFinanceCommandFingerprintFor(context.originScope, request as { command: string });
  const key = `f2-capacity-${String(index).padStart(3, "0")}`;
  const id = family === "fact"
    ? committedFactCommandIdFor(context.currentScope, key, requestFingerprint)
    : projectFinanceCommandGroupIdFor(context.currentScope, key, requestFingerprint);
  return { id, family, requestFingerprint, replayLineage: { version: 1 as const, contextId: context.id, originalRequestFingerprint: requestFingerprint } };
}

function f2CapacityClosure(contexts: readonly ReplayContextV1[]): ReplayClosure {
  return Object.fromEntries(F2_CAPACITY_KINDS.map(kind => [kind, [...new Set(contexts.flatMap(context => context.identities[kind].map(([id]) => id)))].sort()])) as Record<ReplayIdentityKind, string[]>;
}

function f2CapacityBundle(contexts: readonly ReplayContextV1[], referencesPerContext: number) {
  const sorted = [...contexts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const receipts = sorted.flatMap(context => Array.from({ length: referencesPerContext }, (_, index) => f2CapacityReference(context, index)));
  return { contexts: sorted, receipts };
}

test("F2b4 default context accepts exact 64MiB and production creator refuses +1", t => {
  const maximum = replayContract.REPLAY_LINEAGE_MAX_BYTES;
  const context = replayContract.createReplayContext(f2CapacityContextBody(maximum, "fact"));
  assert.equal(Buffer.byteLength(JSON.stringify(context)), maximum);
  assert.equal(replayContract.decodeReplayContext(context).id, context.id);
  assert.ok(Object.isFrozen(context.identities.event));
  assert.throws(() => replayContract.createReplayContext(f2CapacityContextBody(maximum + 1, "fact")), { code: "REPLAY_LINEAGE_LIMIT" });
  t.diagnostic(`PURE default context bytes=${maximum}; legal 256-character typed identities; no injected maxBytes and no PG claim`);
});

for (const mixed of [false, true]) test(`F2b4 default ${mixed ? "mixed-family" : "same-family"} bundle accepts exact64MiB and refuses enclosing +1`, t => {
  const maximum = replayContract.REPLAY_LINEAGE_MAX_BYTES;
  const small = [replayContract.createReplayContext(f2CapacityBase("fact")), ...(mixed ? [replayContract.createReplayContext(f2CapacityBase("finance"))] : [])];
  const referencesPerContext = 128;
  const smallBundle = f2CapacityBundle(small, referencesPerContext);
  const overhead = Buffer.byteLength(JSON.stringify(smallBundle)) - small.reduce((sum, context) => sum + Buffer.byteLength(JSON.stringify(context)), 0);
  const contextBytes = maximum - overhead;
  const firstBytes = mixed ? Math.floor(contextBytes / 2) : contextBytes;
  const contexts = [replayContract.createReplayContext(f2CapacityContextBody(firstBytes, "fact")),
    ...(mixed ? [replayContract.createReplayContext(f2CapacityContextBody(contextBytes - firstBytes, "finance"))] : [])];
  const bundle = f2CapacityBundle(contexts, referencesPerContext);
  assert.equal(Buffer.byteLength(JSON.stringify(bundle)), maximum);
  const admitted = replayContract.validateReplayBundle(bundle.contexts, bundle.receipts, F2_CAPACITY_TARGET, f2CapacityClosure(contexts));
  assert.equal(admitted.byteLength, maximum);
  assert.equal(admitted.receipts.length, mixed ? 256 : 128);
  assert.equal(admitted.contexts.length, mixed ? 2 : 1);
  const larger = [replayContract.createReplayContext(f2CapacityContextBody(firstBytes + 1, "fact")), ...contexts.slice(1)];
  const over = f2CapacityBundle(larger, referencesPerContext);
  assert.equal(Buffer.byteLength(JSON.stringify(over)), maximum + 1);
  assert.ok(larger.every(context => Buffer.byteLength(JSON.stringify(context)) < maximum), "each contained context is legal; only enclosing bundle exceeds the default allowance");
  assert.throws(() => replayContract.validateReplayBundle(over.contexts, over.receipts, F2_CAPACITY_TARGET, f2CapacityClosure(larger)), { code: "REPLAY_LINEAGE_LIMIT" });
  t.diagnostic(`PURE ${mixed ? "mixed" : "same"} family: ${admitted.receipts.length} real-hash bindings, bundle bytes=${admitted.byteLength}; contained contexts remain below default limit`);
});

function f2CapacityStoredRow(context: ReplayContextV1, index: number, anchorId?: string) {
  const reference = f2CapacityReference(context, index);
  return {
    workspace_id: context.currentScope.workspaceId, world_id: context.currentScope.worldId, worldline_id: context.currentScope.worldlineId,
    id: reference.id, request_fingerprint: reference.requestFingerprint, kind: "inventory_granted" as const,
    state: "committed" as const, policy_version: "project-finance-command.v1", receipt_oversized: false,
    result_manifest: {
      provenance: "legacy-result-v1", request: null,
      result: context.family === "fact"
        ? { status: "committed", commandId: reference.id, quantity: 1, revision: 0 }
        : { status: "committed", commandGroupId: reference.id, projectId: "p1", stage: "production", projectVersion: 1, eventKind: "project.stage.changed", worldCursor: null },
      replayLineage: { ...reference.replayLineage, anchorCommandId: anchorId ?? reference.id },
      ...(anchorId ? {} : { replayContext: context }),
    },
  };
}

for (const family of ["fact", "finance"] as const) test(`F2b4 default ${family} stored wrapper exact64MiB shares decoded anchor and rejects wrapper +1`, async t => {
  const fact = await import("../database/postgres/committed-fact-command-repository.ts");
  const finance = await import("../database/postgres/project-finance-command-repository.ts");
  const maximum = replayContract.REPLAY_LINEAGE_MAX_BYTES;
  const small = replayContract.createReplayContext(f2CapacityBase(family));
  const overhead = Buffer.byteLength(JSON.stringify(f2CapacityStoredRow(small, 0).result_manifest)) - Buffer.byteLength(JSON.stringify(small));
  const contextBytes = maximum - overhead;
  const context = replayContract.createReplayContext(f2CapacityContextBody(contextBytes, family));
  const anchor = f2CapacityStoredRow(context, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(context)), contextBytes);
  assert.ok(contextBytes < maximum);
  assert.equal(Buffer.byteLength(JSON.stringify(anchor.result_manifest)), maximum);
  const rows = [anchor, f2CapacityStoredRow(context, 1, anchor.id), f2CapacityStoredRow(context, 2, anchor.id)];
  const byId = new Map(rows.map(row => [row.id, row]));
  const cache = new Map<string, { row: typeof anchor; context: ReplayContextV1 }>();
  const decode = (row: typeof anchor) => family === "fact"
    ? fact.decodeScopedFactCommandReceipt(F2_CAPACITY_TARGET, row, id => byId.get(id), cache)
    : finance.decodeScopedFinanceCommandReceipt(F2_CAPACITY_TARGET, row, id => byId.get(id), cache);
  const decoded = rows.map(decode);
  assert.ok(decoded[0]!.replayProof);
  assert.notStrictEqual(decoded[0]!.replayProof.context, context, "the decoder actually creates a validated detached context");
  for (const receipt of decoded) {
    assert.equal(receipt.provenance, "legacy-result-v1");
    assert.equal(receipt.request, null);
    assert.equal(receipt.replayProof!.context.id, context.id);
    assert.strictEqual(receipt.replayProof!.context, decoded[0]!.replayProof.context, "non-anchor receipts share the exact decoded context, not merely equal copies");
  }
  assert.equal(cache.size, 1);
  assert.ok(rows.slice(1).every(row => !Object.hasOwn(row.result_manifest, "replayContext")));
  const overContext = replayContract.createReplayContext(f2CapacityContextBody(contextBytes + 1, family));
  assert.ok(Buffer.byteLength(JSON.stringify(overContext)) < maximum, "adjacent negative keeps the nested context valid");
  const over = f2CapacityStoredRow(overContext, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(over.result_manifest)), maximum + 1);
  assert.throws(() => decode(over), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(cache.size, 1, "refused wrapper must not populate a new decoded context");
  t.diagnostic(`PURE stored ${family} row decoder: wrapper=${maximum}, context=${contextBytes}, shared decoded anchor across ${decoded.length} receipts; no SQL/PG persistence claim`);
});

test("F6 approved legacy policy refuses unproved opaque performance before any target write", async t => {
  // A historical inventory shape, NOT a claimed genuinely accepted request.
  // Its supplied hash cannot establish missing historical request/body facts.
  const opaque = { id: "historical-performance", idempotencyKey: "historical-performance", requestFingerprint: "c".repeat(64),
    kind: "performance_assessed" as const, resultManifest: { recordId: "record-demo", score: 0 } };
  const source = { ...domain, committedFactCommands: [opaque], performanceAssessments: [{
    id: `${opaque.id}:assessment`, recordId: "record-demo", policyVersion: "structured-factors:v1", score: 0,
    evidenceEventIds: [], evidenceSnapshotHash: evidenceHash([]), commandId: opaque.id,
  }] };
  const input = { record, goals, domain: source,
    manifest: realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null,
      scope: { workspaceId: "workspace-demo", worldlineId: "worldline-source", recordId: "record-demo" }, record, goals, domain: source }) };
  const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(input));
  assert.deepEqual(archive.domain, source, "read-only legacy codec remains distinct from playable restore authorization");
  const original = JSON.stringify(archive);
  const { createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
  let acquisitions = 0, releases = 0, writes = 0;
  const unknownSql: string[] = [];
  const existingSql = "SELECT record.world_id, record.worldline_id, record.story_id, record.status, story.premise AS story_premise FROM records AS record JOIN stories AS story ON story.workspace_id = record.workspace_id AND story.world_id = record.world_id AND story.worldline_id = record.worldline_id AND story.id = record.story_id WHERE record.workspace_id = $1 AND record.id = $2";
  const client = { release() { releases++; }, async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) { writes++; throw Error("UNPROVED_LEGACY_REACHED_TARGET_WRITE"); }
    let rows: Record<string, unknown>[] = [];
    if (["BEGIN", "BEGIN READ ONLY", "COMMIT", "ROLLBACK"].includes(sql)) assert.deepEqual(values, []);
    else if (sql === "SELECT set_config('realm.workspace_id', $1, true)") assert.deepEqual(values, ["target-ws"]);
    else if (sql === "SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2") {
      assert.deepEqual(values, ["target-ws", "world-demo"]); rows = [{ world_version: "0.0.0-local" }];
    } else if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE") {
      assert.deepEqual(values, ["target-ws", "world-demo"]); rows = [{ world_version: "0.0.0-local", status: "active", settings: {} }];
    } else if (sql === "SELECT role FROM player_world_memberships WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3") {
      assert.deepEqual(values, ["target-ws", "world-demo", "target-owner"]); rows = [{ role: "owner" }];
    } else if (sql === existingSql) {
      assert.equal(values[0], "target-ws"); assert.equal(typeof values[1], "string"); assert.ok(String(values[1]).length > 0);
    } else if (sql === "SELECT restore_delivery_kind FROM public.outbox WHERE false") assert.deepEqual(values, []);
    else { unknownSql.push(sql); throw Error("UNKNOWN_LEGACY_POLICY_SQL"); }
    return { rows, rowCount: rows.length };
  } };
  const database = { connect: async () => { acquisitions++; return client; } };
  let refusal: unknown;
  try {
    await createPostgresRealmRuntimeSaveRestorer(database as never).restore({ workspaceId: "target-ws", principalId: "target-owner",
      targetWorldId: "world-demo", idempotencyKey: "unproved-legacy-refusal", archive });
  } catch (error) { refusal = error; }
  assert.equal(JSON.stringify(archive), original, "rejected legacy files and their supplied history remain unchanged");
  assert.deepEqual(unknownSql, [], "unknown SQL cannot masquerade as the expected product refusal");
  assert.equal(releases, acquisitions);
  t.diagnostic(`PROTOCOL target write attempts=${writes}; client acquisitions=${acquisitions}; no real database/network; historical request intentionally unproved`);
  assert.equal(writes, 0, "approved policy must reject unproved historical performance before any target write, not necessarily before authorized read-only checks");
  assert.ok(refusal instanceof Error && "code" in refusal && refusal.code === "RUNTIME_SAVE_INVALID", "playable legacy refusal must use the safe runtime-save boundary");
});
