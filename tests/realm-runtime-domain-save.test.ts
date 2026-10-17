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
