import { createPostgresRealmRuntimeSaveReader as r1WholeReaderFactory } from "../database/postgres/realm-runtime-save-repository.ts";
import { parseRealmRuntimeSaveArchive as r1ParseArchive, type RealmRuntimeSaveArchive as R1NativeArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveWholeDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReplayContext } from "../modules/application/command-replay-lineage.ts";
import { unzipSync, zipSync } from "fflate";
import { createPostgresProjectFinanceCommandStore, createPostgresStoryGraphRepository, buildRealmRuntimeSaveBytes } from "../database/postgres/public.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createCommittedFactCommandService, committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { createProjectFinanceCommandService, type RecordEvidence, type ProjectFinanceCommandStore } from "../modules/application/project-finance-command.ts";
import { normalizeStoryDefinition, storyDefinitionHashFor, storyUnlockEvidenceHashFor, storyNodeInstanceIdFor, storyUnlockLedgerIdFor, storyUnlockIdempotencyKeyFor, storyRecordIdFor } from "../modules/story-graph/public.ts";
import { computeRealmRuntimeSaveContentHash, realmRuntimeSaveManifestFromData } from "../modules/world-transfer/realm-runtime-save.ts";
import { projectFinanceCommandFingerprintFor, projectFinanceCommandGroupIdFor, type ProjectScope } from "../modules/projects/public.ts";
import type { RealmRuntimeSaveDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { withWorkspaceTransaction, type WorkspaceTransactionOptions } from "../database/postgres/workspace-transaction.ts";
import { POST as whole_backupRoutePOST } from "../app/api/record/backup/route.ts";
import { endSharedRuntimePools, getSharedRuntimePool } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { createBaseInstantiationPlan } from "../modules/world-transfer/base-content.ts";
import { recordCommittedCalls, proveNativeLegacyReplay, commandAuthoritySnapshot } from "./helpers/native-legacy-replay.ts";
/**
 * Runtime domain save/restore integration: finance, Story Graph, facts and
 * inventory must survive a new worldline with every source identity remapped.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo } from "../database/postgres/demo-seed.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
} from "../database/postgres/public.ts";
import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
} from "../modules/world-transfer/realm-runtime-save.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const DOMAIN_DEMO_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  storyId: POSTGRES_DEMO_IDS.story,
  recordId: POSTGRES_DEMO_IDS.record,
};

test(
  "runtime domain save/restore preserves finance, Story unlocks, facts, relationships and inventory",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const owner = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString, max: 2 });
    owner.on("error", () => {});
    runtime.on("error", () => {});
    t.after(async () => {
      await runtime.end();
      await owner.end();
    });

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const SCOPE = { ...DOMAIN_DEMO_SCOPE, workspaceId: `workspace_domain_real_${suffix}` };
    await seedPostgresDemo(owner, { workspaceId: SCOPE.workspaceId });
    installTestSessionSecret();
    await seedCapabilitySessionKey(owner, SCOPE.workspaceId);
    const projectId = `domain_project_${suffix}`;
    const milestoneId = `domain_milestone_${suffix}`;
    const linkId = `domain_link_${suffix}`;
    const budgetId = `domain_budget_${suffix}`;
    const accountId = `domain_account_${suffix}`;
    const obligationId = `domain_obligation_${suffix}`;
    const settlementId = `domain_settlement_${suffix}`;
    const nodeId = `domain_node_${suffix}`;
    const unlockId = `domain_unlock_${suffix}`;
    const sourceEventId = POSTGRES_DEMO_IDS.openingEvent;

    // These are server-side facts in the source worldline. The test deliberately
    // does not construct runtime/domain.json by hand: the reader must project it.
    await owner.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage,
         title, currency, deadline, owner_id, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'funding',
                 'Domain restore rehearsal', 'JPY', NULL, NULL, 3)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (
         workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, linkId, projectId, SCOPE.storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence,
         title, status, due_on, completion_record_id, completion_event_id
       ) VALUES ($1, $2, $3, $4, $5, 1, 'First rehearsal', 'completed', NULL, NULL, NULL)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId],
    );
    await owner.query(
      `INSERT INTO budget_allocations (
         workspace_id, world_id, worldline_id, id, project_id, category,
         amount_minor, currency, version
       ) VALUES ($1, $2, $3, $4, $5, 'studio', 9000, 'JPY', 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, budgetId, projectId],
    );
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status,
         opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 10000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    const sourceEvidence = async (): Promise<RecordEvidence> => {
      const row = (await owner.query<{ scene_id: string; head_tick: string | number; head_ordinal: string | number }>(
        `SELECT scene.id AS scene_id, line.head_tick, line.head_ordinal FROM scenes AS scene
         JOIN worldlines AS line ON line.workspace_id = scene.workspace_id AND line.id = $2
         WHERE scene.workspace_id = $1 AND scene.record_id = $3`,
        [SCOPE.workspaceId, SCOPE.worldlineId, SCOPE.recordId])).rows[0]!;
      return { recordId: SCOPE.recordId, sceneId: row.scene_id, visibility: "public",
        expectedWorldCursor: { worldTick: Number(row.head_tick), worldOrdinal: Number(row.head_ordinal) } };
    };
    const finance = createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(runtime) });
    const expense = await finance.recordExpense({ scope: SCOPE, accountId, projectId, recordId: SCOPE.recordId,
      amountMinor: 3000, category: "studio", memo: "rehearsal fee", occurredAt: "2026-10-16T00:00:00.000Z",
      expectedBalanceMinor: 10000, evidence: await sourceEvidence(), idempotencyKey: `domain-expense-${suffix}` });
    const income = await finance.recordIncome({ scope: SCOPE, accountId, projectId, recordId: SCOPE.recordId,
      amountMinor: 5000, category: "presale", memo: "advance ticket sales", occurredAt: "2026-10-16T00:00:00.000Z",
      expectedBalanceMinor: 7000, evidence: await sourceEvidence(), idempotencyKey: `domain-income-${suffix}` });
    assert.equal(expense.status, "committed");
    assert.equal(income.status, "committed");
    const expenseId = expense.entry.id;
    await owner.query(
      `INSERT INTO obligations (
         workspace_id, world_id, worldline_id, id, project_id, kind,
         status, principal_minor, outstanding_minor, share_bps,
         undelivered_count, due_on, version
       ) VALUES ($1, $2, $3, $4, $5, 'loan', 'open', 5000, 3000,
                 NULL, 0, NULL, 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, obligationId, projectId],
    );
    await owner.query(
      `INSERT INTO obligation_settlements (
         workspace_id, world_id, worldline_id, id, obligation_id,
         ledger_entry_id, kind, amount_minor
       ) VALUES ($1, $2, $3, $4, $5, $6, 'repayment', 2000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, settlementId, obligationId, expenseId],
    );
    const nativeStory = await owner.query<{ title: string; premise: string }>(
      "SELECT title, premise FROM stories WHERE workspace_id = $1 AND id = $2", [SCOPE.workspaceId, SCOPE.storyId]);
    assert.equal(nativeStory.rowCount, 1);
    const sourceStoryDefinition = normalizeStoryDefinition({ storyKey: "story.domain.native",
      title: nativeStory.rows[0]!.title, premise: nativeStory.rows[0]!.premise, policyVersion: "story-graph-v1",
      nodes: [{ kind: "record", nodeKey: "first_rehearsal", recordKey: "first_rehearsal",
        title: "First rehearsal", sequence: 1, initial: true }] });
    const sourceUnlockEvidence = { eventIds: [sourceEventId], goalKeys: [], nodeKeys: [],
      milestoneIds: [milestoneId], obligationIds: [] };
    await owner.query(
      `INSERT INTO story_node_instances (
         workspace_id, world_id, worldline_id, story_id, node_key, id,
         state, revision, record_id, definition_hash,
         unlock_evidence_event_ids, unlock_evidence, unlocked_at, activated_at
       ) VALUES ($1, $2, $3, $4, 'first_rehearsal', $5, 'completed', 4, $6, $7,
                 $8::text[], $9::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.storyId,
        nodeId,
        SCOPE.recordId,
        storyDefinitionHashFor(sourceStoryDefinition),
        [sourceEventId],
        JSON.stringify(sourceUnlockEvidence),
      ],
    );
    await owner.query(
      `INSERT INTO story_unlock_ledger (
         workspace_id, world_id, worldline_id, story_id, id,
         story_node_instance_id, node_key, transition, idempotency_key,
         record_id, evidence_event_ids, evidence_hash, evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, 'first_rehearsal', 'unlocked', $7,
                 $8, $9::text[], $10, $11::jsonb)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.storyId,
        unlockId,
        nodeId,
        `domain-unlock-${suffix}`,
        SCOPE.recordId,
        [sourceEventId],
        storyUnlockEvidenceHashFor({ definitionHash: storyDefinitionHashFor(sourceStoryDefinition),
          nodeKey: "first_rehearsal", evidence: sourceUnlockEvidence }),
        JSON.stringify(sourceUnlockEvidence),
      ],
    );
    // Start this isolated fixture's holding empty, then let the real grant own
    // its first INSERT, accepted request, result and fingerprint together.
    await owner.query(`DELETE FROM character_assets WHERE workspace_id=$1 AND record_id=$2
      AND character_instance_id=$3 AND asset_definition_id=$4`, [SCOPE.workspaceId, SCOPE.recordId,
      POSTGRES_DEMO_IDS.playerInstance, POSTGRES_DEMO_IDS.signalLanternAsset]);
    const facts = createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(runtime) });
    const grant = await facts.grantInventory({ scope: SCOPE, recordId: SCOPE.recordId,
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance, assetDefinitionId: POSTGRES_DEMO_IDS.signalLanternAsset,
      quantity: 1, sourceEventId, idempotencyKey: `domain-grant-${suffix}` });
    const relationship = await facts.reviseRelationship({ scope: SCOPE, subjectEntityKey: "member:player",
      objectEntityKey: "member:scout", relationKind: "trust", sourceEventId, idempotencyKey: `domain-relation-${suffix}` });
    // Register the actual authored definition against the existing native node.
    // Do not invent a missing historical definition during export or restore.
    const boundStory = await createPostgresStoryGraphRepository(runtime).materialize({
      workspaceId: SCOPE.workspaceId, storyId: SCOPE.storyId, definition: sourceStoryDefinition });
    assert.equal(boundStory.nodes.length, 1);
    assert.equal(boundStory.nodes[0]!.recordId, SCOPE.recordId);
    const assessment = await executePerformanceAssessmentCommand(runtime, {
      ...createPerformanceCommandTrust(SCOPE, POSTGRES_DEMO_IDS.principal),
      enablement: { schema: true, durableTransport: true },
    }, { recordId: SCOPE.recordId, policyVersion: "structured-factors:v1",
      evidenceEventIds: [sourceEventId], idempotencyKey: `domain-assess-${suffix}` });
    assert.equal(grant.status, "committed");
    assert.equal(relationship.status, "committed");
    assert.equal(assessment.result.status, "committed");
    const consumer = { performanceWitnessesSchemaVersion: 1 as const };
    const reader = createPostgresRealmRuntimeSaveReader(runtime, consumer);
    const archive = await reader.load({ principalId: POSTGRES_DEMO_IDS.principal, purpose: "record-export", workspaceId: SCOPE.workspaceId, recordId: SCOPE.recordId });
    assert.ok(archive);
    assert.ok(archive.domain);
    assert.equal(archive.domain.projects.length, 1);
    assert.equal(archive.domain.projects[0]!.version, 3);
    assert.equal(archive.domain.ledgerEntries.length, 2);
    assert.equal(archive.domain.storyNodes.length, 1);
    assert.equal(archive.domain.storyUnlockLedger.length, 1);
    assert.equal(archive.domain.committedFactCommands.length, 3);
    assert.equal(archive.domain.performanceAssessments.length, 1);
    assert.equal(archive.domain.memberRelationshipRevisions.length, 1);
    assert.equal(archive.domain.characterAssets.length, 1);

    const reparsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive));
    assert.deepEqual(reparsed.domain, archive.domain);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, consumer);
    const restored = await restorer.restore({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: `domain-restore-${suffix}`,
    });
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedDomainProjectCount, 1);
    assert.equal(restored.importedDomainLedgerEntryCount, 2);
    assert.equal(restored.importedDomainStoryNodeCount, 1);
    assert.equal(restored.importedDomainUnlockCount, 1);
    assert.equal(restored.importedDomainFactCommandCount, 3);
    assert.equal(restored.importedDomainAssessmentCount, 1);
    assert.equal(restored.importedDomainRelationshipRevisionCount, 1);
    assert.equal(restored.importedDomainAssetCount, 1);

    const cash = await owner.query<{ balance: string }>(
      `SELECT (opening_balance_minor + COALESCE(SUM(
         CASE WHEN direction = 'income' THEN amount_minor ELSE -amount_minor END
       ), 0))::text AS balance
       FROM finance_accounts AS account
       LEFT JOIN ledger_entries AS entry
         ON entry.workspace_id = account.workspace_id
        AND entry.world_id = account.world_id
        AND entry.worldline_id = account.worldline_id
        AND entry.account_id = account.id
       WHERE account.workspace_id = $1 AND account.worldline_id = $2
         AND account.id LIKE 'finance_account_restore_%'
       GROUP BY account.opening_balance_minor`,
      [SCOPE.workspaceId, restored.worldlineId],
    );
    assert.equal(cash.rows[0]?.balance, "12000");

    const targetState = await owner.query<{
      projects: string;
      milestones: string;
      obligations: string;
      settlements: string;
      nodes: string;
      unlocks: string;
      facts: string;
      assessments: string;
      relationships: string;
      assets: string;
      ledger: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM projects WHERE worldline_id = $1) AS projects,
         (SELECT count(*)::text FROM project_milestones WHERE worldline_id = $1) AS milestones,
         (SELECT count(*)::text FROM obligations WHERE worldline_id = $1) AS obligations,
         (SELECT count(*)::text FROM obligation_settlements WHERE worldline_id = $1) AS settlements,
         (SELECT count(*)::text FROM story_node_instances WHERE worldline_id = $1) AS nodes,
         (SELECT count(*)::text FROM story_unlock_ledger WHERE worldline_id = $1) AS unlocks,
         (SELECT count(*)::text FROM committed_fact_commands WHERE worldline_id = $1) AS facts,
         (SELECT count(*)::text FROM performance_assessments WHERE worldline_id = $1) AS assessments,
         (SELECT count(*)::text FROM member_relationship_revisions WHERE worldline_id = $1) AS relationships,
         (SELECT count(*)::text FROM character_assets WHERE worldline_id = $1) AS assets,
         (SELECT count(*)::text FROM ledger_entries WHERE worldline_id = $1) AS ledger`,
      [restored.worldlineId],
    );
    assert.deepEqual(targetState.rows[0], {
      projects: "1",
      milestones: "1",
      obligations: "1",
      settlements: "1",
      nodes: "1",
      unlocks: "1",
      facts: "3",
      assessments: "1",
      relationships: "1",
      assets: "1",
      ledger: "2",
    });

    const replay = await restorer.restore({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: `domain-restore-${suffix}`,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries WHERE worldline_id = $1`,
        [restored.worldlineId],
      ).then((result) => result.rows[0]),
      { count: "2" },
    );

    // The source projection and idempotent replay are the acceptance boundary.
    assert.ok(restored.recordId.startsWith("record_restore_"));

    // D4a native relocation remains a real different-World round trip. A
    // signed World-bound save may not be relabelled native to obtain this.
    assert.equal(archive.manifest.mode, "base");
    const nativeWorldB = `world_domain_native_b_${suffix}`;
    const nativeAssetB = `asset_domain_native_b_${suffix}`;
    assert.notEqual(nativeWorldB, SCOPE.worldId);
    await owner.query(`INSERT INTO worlds(workspace_id,id,name,status,calendar_id,settings)
      VALUES ($1,$2,'Native relocation','active','native_calendar','{}'::jsonb)`, [SCOPE.workspaceId,nativeWorldB]);
    await owner.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role)
      VALUES ($1,$2,$3,'owner')`, [SCOPE.workspaceId,nativeWorldB,POSTGRES_DEMO_IDS.principal]);
    await owner.query(`INSERT INTO asset_definitions(workspace_id,world_id,id,asset_key,title,rule_pack_key,consumable,metadata)
      SELECT workspace_id,$2,$3,asset_key,title,rule_pack_key,consumable,metadata FROM asset_definitions
      WHERE workspace_id=$1 AND world_id=$4 AND id=$5`,
      [SCOPE.workspaceId,nativeWorldB,nativeAssetB,SCOPE.worldId,POSTGRES_DEMO_IDS.signalLanternAsset]);
    const relocated = await restorer.restore({ workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,
      sessionProof:sessionProofFor(POSTGRES_DEMO_IDS.principal),archive:reparsed,targetWorldId:nativeWorldB,idempotencyKey:`native-relocate-${suffix}` });
    assert.equal(relocated.replayed,false);
    const nativeHoldings = (await owner.query<{asset_definition_id:string;quantity:number;revision:number}>(
      `SELECT asset_definition_id,quantity::integer AS quantity,revision::integer AS revision FROM character_assets
       WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [SCOPE.workspaceId,nativeWorldB,relocated.worldlineId])).rows;
    assert.deepEqual(nativeHoldings,[{asset_definition_id:nativeAssetB,quantity:1,revision:0}]);
    const relocatedArchive = await reader.load({ workspaceId:SCOPE.workspaceId,recordId:relocated.recordId,
      principalId:POSTGRES_DEMO_IDS.principal,purpose:"record-export" });
    assert.ok(relocatedArchive?.domain);
    assert.equal(relocatedArchive.manifest.mode,"base");
    const nativeGrant = relocatedArchive.domain.committedFactCommands.find(row=>row.idempotencyKey===`domain-grant-${suffix}`)!;
    assert.ok(nativeGrant.request);
    assert.equal(nativeGrant.request.assetDefinitionId,nativeAssetB);
    const relocatedScope={workspaceId:SCOPE.workspaceId,worldId:nativeWorldB,worldlineId:relocated.worldlineId};
    const beforeNativeReplay=await commandAuthoritySnapshot(owner,relocatedScope);
    const relocatedGrant = await createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(runtime)}).grantInventory({
      ...nativeGrant.request,scope:relocatedScope,idempotencyKey:nativeGrant.idempotencyKey } as never);
    assert.equal(relocatedGrant.status,"replayed");
    assert.deepEqual(await commandAuthoritySnapshot(owner,relocatedScope),beforeNativeReplay);
    const returnedNative = await restorer.restore({ workspaceId:SCOPE.workspaceId,principalId:POSTGRES_DEMO_IDS.principal,
      sessionProof:sessionProofFor(POSTGRES_DEMO_IDS.principal),archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(relocatedArchive)),
      targetWorldId:SCOPE.worldId,idempotencyKey:`native-return-${suffix}` });
    assert.equal(returnedNative.replayed,false);
    const returnedHoldings=(await owner.query<{asset_definition_id:string;quantity:number;revision:number}>(
      `SELECT asset_definition_id,quantity::integer AS quantity,revision::integer AS revision FROM character_assets
       WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`,[SCOPE.workspaceId,SCOPE.worldId,returnedNative.worldlineId])).rows;
    assert.deepEqual(returnedHoldings,[{asset_definition_id:POSTGRES_DEMO_IDS.signalLanternAsset,quantity:1,revision:0}]);
  },
);

{
// This assertion only narrows the rich wire shape; authorization still goes
// through the actual reader and its explicit principal/purpose on every call.
type RealmRuntimeSaveArchive=Omit<R1NativeArchive,"domain"> & {domain?:RealmRuntimeSaveWholeDomainV1};
function r1AssertWholeArchive(archive:R1NativeArchive): RealmRuntimeSaveArchive {
  if(archive.domain)assert.ok(Array.isArray(archive.domain.records) && Array.isArray(archive.domain.stories) && Array.isArray(archive.domain.storyDefinitions));
  return archive as RealmRuntimeSaveArchive;
}
function createPostgresRealmRuntimeSaveReader(...args:Parameters<typeof r1WholeReaderFactory>) {
  const reader=r1WholeReaderFactory(...args);
  return {async load(input:Parameters<typeof reader.load>[0]) {const archive=await reader.load(input);return archive?r1AssertWholeArchive(archive):null;}};
}
function parseRealmRuntimeSaveArchive(...args:Parameters<typeof r1ParseArchive>) {return r1AssertWholeArchive(r1ParseArchive(...args));}


// Explicit operator fixture for the frozen whole-closure tests; HTTP and SQL
// still evaluate exact operator + current World owner on every request.
let wholePreviousOperators: string | undefined;
test.beforeEach(()=>{wholePreviousOperators=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;});
test.afterEach(()=>{if(wholePreviousOperators===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=wholePreviousOperators;});


const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const WS = POSTGRES_DEMO_IDS.workspace;

const OCCURRED_AT = "2026-10-16T00:00:00.000Z";

function evidenceFor(recordId: string, sceneId: string, cursor: { tick: number; ordinal: number }): RecordEvidence {
  return {
    recordId,
    sceneId,
    visibility: "public",
    expectedWorldCursor: { worldTick: cursor.tick, worldOrdinal: cursor.ordinal },
  };
}

async function cashBalance(owner: pg.Pool, worldlineId: string, workspaceId: string = WS): Promise<number> {
  const result = await owner.query<{ balance: string }>(
    `SELECT (account.opening_balance_minor + COALESCE(SUM(
       CASE WHEN entry.direction = 'income' THEN entry.amount_minor ELSE -entry.amount_minor END
     ), 0))::text AS balance
     FROM finance_accounts AS account
     LEFT JOIN ledger_entries AS entry
       ON entry.workspace_id = account.workspace_id
      AND entry.worldline_id = account.worldline_id
       AND entry.account_id = account.id
     WHERE account.workspace_id = $1 AND account.worldline_id = $2
     GROUP BY account.opening_balance_minor`,
    [workspaceId, worldlineId],
  );
  return Number(result.rows[0]?.balance);
}

const cashBalanceInWorkspace = cashBalance;

async function domainRowCounts(owner: pg.Pool, worldlineId: string) {
  const result = await owner.query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM projects WHERE worldline_id = $1) AS projects,
       (SELECT count(*)::text FROM project_milestones WHERE worldline_id = $1) AS milestones,
       (SELECT count(*)::text FROM project_story_links WHERE worldline_id = $1) AS links,
       (SELECT count(*)::text FROM budget_allocations WHERE worldline_id = $1) AS budgets,
       (SELECT count(*)::text FROM finance_accounts WHERE worldline_id = $1) AS accounts,
       (SELECT count(*)::text FROM ledger_entries WHERE worldline_id = $1) AS ledger,
       (SELECT count(*)::text FROM project_finance_command_groups WHERE worldline_id = $1) AS finance_groups,
       (SELECT count(*)::text FROM obligations WHERE worldline_id = $1) AS obligations,
       (SELECT count(*)::text FROM obligation_settlements WHERE worldline_id = $1) AS settlements,
       (SELECT count(*)::text FROM story_node_instances WHERE worldline_id = $1) AS nodes,
       (SELECT count(*)::text FROM story_unlock_ledger WHERE worldline_id = $1) AS unlocks,
       (SELECT count(*)::text FROM committed_fact_commands WHERE worldline_id = $1) AS facts,
       (SELECT count(*)::text FROM performance_assessments WHERE worldline_id = $1) AS assessments,
       (SELECT count(*)::text FROM member_relationship_revisions WHERE worldline_id = $1) AS revisions,
       (SELECT count(*)::text FROM character_assets WHERE worldline_id = $1) AS assets`,
    [worldlineId],
  );
  return result.rows[0]!;
}

test(
  "runtime domain save/restore replays real commands against remapped identities",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const owner = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString, max: 4 });
    owner.on("error", () => {});
    runtime.on("error", () => {});
    t.after(async () => {
      await runtime.end();
      await owner.end();
    });

    const { generateKeyPairSync, verify } = await import("node:crypto");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { installSignedRealmWorldFixture } = await import("./helpers/realmworld-package-fixture.ts");
    const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
    const { createInstalledRealmWorldInstantiationResolver } = await import("../modules/world-transfer/realmworld-runtime-content.ts");
    const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
    const s = randomUUID().replaceAll("-", "").slice(0, 12);
    const WS = `workspace_signed_closure_${s}`;
    const cashBalance = (pool: pg.Pool, line: string) => cashBalanceInWorkspace(pool, line, WS);
    const worldId = `world_closure_${s}`;
    const story2Id = `story_other_${s}`;
    const workspaceB = `workspace_signed_closure_b_${s}`;
    const directory = await mkdtemp(join(tmpdir(), "closure-signed-policy-"));
    t.after(async () => { await rm(directory, { recursive: true, force: true }); });
    const pair = generateKeyPairSync("ed25519");
    const commandPolicy = {
      format: "realmworld-command-policy", schemaVersion: 1, policyVersion: "closure-fixture.v1",
      projects: [{ projectKey: "main", kind: "production", title: { en: "First production" }, milestones: [
        { milestoneKey: "completion", title: { en: "First rehearsal" } },
        { milestoneKey: "encore", title: { en: "Encore rehearsal" } },
      ] }],
      bindings: [{ bindingKey: "festival.completed", command: "confirm_milestone", projectKey: "main", milestoneKey: "completion",
        semanticEventKey: "harbor.festival.completed", storySelector: "genesis", recordSelector: "genesis", all: [] }],
    };
    await installSignedRealmWorldFixture({ installRoot: directory, worldId, version: "1.2.0", recordTitle: "Opening",
      playerStance: "observer", commandPolicy, declaredEvents: ["harbor.festival.completed"], keyId: "closure-fixture",
      keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } });
    const verifier = { installRoot: directory, verifySignature: ({ manifest }: { manifest: import("../modules/world-transfer/realmworld-manifest.ts").RealmWorldManifestV1 }) =>
      verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) };
    const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver(verifier);
    const plan = (await createInstalledRealmWorldInstantiationResolver({ ...verifier, locale: "en" })({ kind: "world", worldId, worldVersion: "1.2.0" }))!;
    assert.ok(plan);
    const library = createPostgresLibraryService(runtime, undefined, { resolveCommandPolicy });
    installTestSessionSecret();
    for (const workspaceId of [WS, workspaceB]) {
      await owner.query(`INSERT INTO workspaces (id,name) VALUES ($1,'Signed closure')`, [workspaceId]);
      await owner.query(`INSERT INTO accounts (workspace_id,principal_id,display_name) VALUES ($1,$2,'Closure owner')`, [workspaceId,POSTGRES_DEMO_IDS.principal]);
      await seedCapabilitySessionKey(owner, workspaceId);
    }
    const source = await library.instantiateRealmWorld({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal) }, plan, "closure-source");
    // This test is explicitly an authenticated owner scenario. Seed its owner
    // membership using the disposable-cluster admin, not a forged runtime trust
    // object; observer genesis intentionally supplies no implicit player asset.
    const sourceOwner = await owner.query(`UPDATE player_world_memberships SET role='owner'
      WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3 AND role='observer' RETURNING role`, [WS,worldId,POSTGRES_DEMO_IDS.principal]);
    assert.equal(sourceOwner.rowCount,1);
    const { worldlineId, storyId, recordId } = source;
    const scope = { workspaceId: WS, worldId, worldlineId };
    const storyScope = { ...scope, storyId };
    const installed = (await owner.query<{ project_id: string; milestone_id: string; milestone_key: string; story_id: string; record_id: string }>(
      `SELECT project_id,milestone_id,milestone_key,story_id,record_id FROM realmworld_command_materializations
       WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND project_key='main' ORDER BY milestone_key DESC`,
      [WS,worldId,worldlineId])).rows;
    assert.equal(installed.length,2);
    assert.ok(installed.every(row=>row.story_id===storyId && row.record_id===recordId));
    const projectId = installed.find(row=>row.milestone_key==='completion')!.project_id;
    const milestoneId = installed.find(row=>row.milestone_key==='completion')!.milestone_id;
    const encoreMilestoneId = installed.find(row=>row.milestone_key==='encore')!.milestone_id;
    await owner.query(`UPDATE projects SET status='active',stage='funding' WHERE workspace_id=$1 AND id=$2`, [WS,projectId]);
    await owner.query(`INSERT INTO stories(workspace_id,world_id,worldline_id,id,title,status,premise,start_tick,start_ordinal)
      VALUES ($1,$2,$3,$4,'Other story','active','Other scope.',0,0)`, [WS,worldId,worldlineId,story2Id]);
    const opening = (await owner.query<{ id:string; scene_id:string; visibility_policy_id:string }>(
      `SELECT id,scene_id,visibility_policy_id FROM events WHERE workspace_id=$1 AND record_id=$2 AND record_ordinal=1`, [WS,recordId])).rows;
    assert.equal(opening.length,1);
    const sceneId = opening[0]!.scene_id;
    const openingEventId = opening[0]!.id;
    const storyDefinition = normalizeStoryDefinition({
      storyKey: "story.closure.pg",
      title: "T",
      premise: "P",
      policyVersion: "story-graph-v1",
      nodes: [
        { kind: "record", nodeKey: "opening", recordKey: "opening-record", title: "Opening", sequence: 1, initial: true },
        {
          kind: "record",
          nodeKey: "finale",
          recordKey: "finale-record",
          title: "Finale",
          sequence: 2,
          unlock: { kind: "milestone_status", milestoneId, status: "completed" },
        },
        {
          kind: "record",
          nodeKey: "epilogue",
          recordKey: "epilogue-record",
          title: "Epilogue",
          sequence: 3,
          unlock: { kind: "event_count", eventKind: "project.milestone.confirmed", threshold: 1 },
        },
        {
          // Locked at save time; unlocked post-restore by confirming the
          // remapped encore milestone against the remapped definition.
          kind: "record",
          nodeKey: "encore",
          recordKey: "encore-record",
          title: "Encore",
          sequence: 4,
          unlock: { kind: "milestone_status", milestoneId: encoreMilestoneId, status: "completed" },
        },
      ],
    });
    const storyGraph = createPostgresStoryGraphRepository(runtime);
    // Attach newly authored native graph state to the real genesis Record.
    // Package Project/Milestone/Record authority comes only from Library's map.
    const openingNodeId = storyNodeInstanceIdFor(storyScope, "opening");
    const openingEvidence = { eventIds: [], goalKeys: [], nodeKeys: [], milestoneIds: [], obligationIds: [] };
    const openingEvidenceHash = storyUnlockEvidenceHashFor({ definitionHash: storyDefinitionHashFor(storyDefinition),
      nodeKey: "opening", evidence: openingEvidence });
    await owner.query(`INSERT INTO story_node_instances(workspace_id,world_id,worldline_id,story_id,node_key,id,state,revision,record_id,definition_hash,unlock_evidence_event_ids,unlock_evidence,unlocked_at,activated_at)
      VALUES ($1,$2,$3,$4,'opening',$5,'active',1,$6,$7,'{}'::text[],$8::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [WS,worldId,worldlineId,storyId,openingNodeId,recordId,storyDefinitionHashFor(storyDefinition),JSON.stringify(openingEvidence)]);
    await owner.query(`INSERT INTO story_unlock_ledger(workspace_id,world_id,worldline_id,story_id,id,story_node_instance_id,node_key,transition,idempotency_key,record_id,evidence_event_ids,evidence_hash,evidence)
      VALUES ($1,$2,$3,$4,$5,$6,'opening','unlocked',$7,$8,'{}'::text[],$9,$10::jsonb)`,
      [WS,worldId,worldlineId,storyId,storyUnlockLedgerIdFor(openingNodeId,"unlocked",openingEvidenceHash),openingNodeId,
        storyUnlockIdempotencyKeyFor(openingNodeId,"unlocked",openingEvidenceHash),recordId,openingEvidenceHash,JSON.stringify(openingEvidence)]);
    const materialized = await storyGraph.materialize({ workspaceId: WS, storyId, definition: storyDefinition });
    const siblingRecordId = storyRecordIdFor(storyScope, "finale");
    assert.equal(materialized.nodes.find((node) => node.nodeKey === "opening")?.recordId, recordId);

    let cursor = { tick: 0, ordinal: 1 };

    // ----- character topology + asset definition for the inventory commands
    const characterDefinitionId = `chardef_${s}`;
    const continuityId = `cont_${s}`;
    const characterInstanceId = `char_${s}`;
    const assetDefinitionId = `asset_${s}`;
    await owner.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name, source_format, profile)
       VALUES ($1, $2, $3, 'Rehearsal lead', 'native', '{}'::jsonb)`,
      [WS, worldId, characterDefinitionId],
    );
    await owner.query(
      `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, status, born_tick, born_ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)`,
      [WS, worldId, worldlineId, characterDefinitionId, continuityId, `ck_${s}`],
    );
    await owner.query(
      `INSERT INTO character_instances (
         workspace_id, world_id, worldline_id, record_id, continuity_id,
         predecessor_instance_id, id, controller_mode, status,
         instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick,
         inheritance_cutoff_ordinal, retired_tick, retired_ordinal, state
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, 'human', 'present', 0, 0, 0, 0, NULL, NULL, '{}'::jsonb)`,
      [WS, worldId, worldlineId, recordId, continuityId, characterInstanceId],
    );
    await owner.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id, participant_kind,
         character_instance_id, principal_id, controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'character', $6, NULL, 'human', true, 0)`,
      [WS, worldId, worldlineId, recordId, `part_${s}`, characterInstanceId],
    );
    await owner.query(
      `INSERT INTO asset_definitions (workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable, metadata)
       VALUES ($1, $2, $3, $4, 'Signal lantern', 'core', false, '{}'::jsonb)`,
      [WS, worldId, assetDefinitionId, `lantern_${s}`],
    );

    // ----- finance/project fixtures: one linked project, one unlinked
    // project (must be carried), one project linked to another Story (must be
    // excluded from this Story's save).
    const accountId = `acct_${s}`;
    const unlinkedProjectId = `proj_unlinked_${s}`;
    const otherProjectId = `proj_other_${s}`;
    const sharedProjectId = `proj_shared_${s}`;
    await owner.query(
      `INSERT INTO finance_accounts (workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor)
       VALUES ($1, $2, $3, $4, 'JPY', 'active', 10000)`,
      [WS, worldId, worldlineId, accountId],
    );
    await owner.query(
      `INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
       VALUES ($1, $2, $3, $4, 'operation', 'planned', 'planning', 'Unlinked operation', 'JPY', NULL, NULL, 1),
              ($1, $2, $3, $5, 'campaign', 'planned', 'planning', 'Other story project', 'JPY', NULL, NULL, 1),
              ($1, $2, $3, $6, 'production', 'active', 'funding', 'Shared production', 'JPY', NULL, NULL, 1)`,
      [WS, worldId, worldlineId, unlinkedProjectId, otherProjectId, sharedProjectId],
    );
    // The whole worldline is carried: the linked Story project, the unlinked
    // project, the other Story's project, and one project shared by both
    // Stories (two links).
    await owner.query(`INSERT INTO project_story_links(workspace_id,world_id,worldline_id,id,project_id,story_id,link_kind)
      VALUES ($1,$2,$3,$4,$5,$6,'primary'),($1,$2,$3,$7,$8,$9,'related'),($1,$2,$3,$10,$8,$6,'related')`,
      [WS,worldId,worldlineId,`link_other_${s}`,otherProjectId,story2Id,`link_shared_a_${s}`,sharedProjectId,storyId,`link_shared_b_${s}`]);
    await owner.query(`INSERT INTO project_milestones(workspace_id,world_id,worldline_id,id,project_id,sequence,title,status,due_on,completion_record_id,completion_event_id)
      VALUES ($1,$2,$3,$4,$5,1,'Unlinked milestone','planned',NULL,NULL,NULL)`,
      [WS,worldId,worldlineId,`mile_unlinked_${s}`,unlinkedProjectId]);

    // ----- real finance commands against the source worldline
    const financeStoreCalls = recordCommittedCalls(createPostgresProjectFinanceCommandStore(runtime, { resolveCommandPolicy }));
    const financeCalls = recordCommittedCalls(createProjectFinanceCommandService({ store: financeStoreCalls.proxy }));
    const finance = financeCalls.proxy;
    const expense = await finance.recordExpense({
      scope,
      accountId,
      amountMinor: 3000,
      category: "studio",
      memo: "rehearsal fee",
      projectId,
      recordId,
      occurredAt: OCCURRED_AT,
      expectedBalanceMinor: 10000,
      evidence: evidenceFor(recordId, sceneId, cursor),
      idempotencyKey: `fin-expense-${s}`,
    });
    assert.equal(expense.status, "committed");
    cursor = { tick: 0, ordinal: 2 };
    const income = await finance.recordIncome({
      scope,
      accountId,
      amountMinor: 5000,
      category: "presale",
      memo: "advance ticket sales",
      projectId,
      recordId,
      occurredAt: OCCURRED_AT,
      expectedBalanceMinor: 7000,
      evidence: evidenceFor(recordId, sceneId, cursor),
      idempotencyKey: `fin-income-${s}`,
    });
    assert.equal(income.status, "committed");
    cursor = { tick: 0, ordinal: 3 };
    const milestoneConfirm = await finance.confirmMilestone({
      scope,
      projectId,
      milestoneId,
      expectedProjectVersion: 1,
      evidence: evidenceFor(recordId, sceneId, cursor),
      // Declared World-vocabulary semantic completion key: validated
      // generically, emitted once with the milestone completion event.
      semanticEventKey: "harbor.festival.completed",
      idempotencyKey: `fin-milestone-${s}`,
    });
    assert.equal(milestoneConfirm.status, "committed");
    assert.equal(milestoneConfirm.semanticEventKey, "harbor.festival.completed");
    const milestoneSemanticEvent = await owner.query<{ payload: { semanticEventKey?: string } }>(
      `SELECT payload FROM events
       WHERE workspace_id = $1 AND worldline_id = $2
         AND event_kind = 'project.milestone.confirmed'`,
      [WS, worldlineId],
    );
    assert.equal(milestoneSemanticEvent.rows.length, 1, "milestone completion event emitted exactly once");
    assert.equal(milestoneSemanticEvent.rows[0]?.payload.semanticEventKey, "harbor.festival.completed");
    // Undeclared semantic keys are not authorized by shape alone: the World
    // declaration is checked in the same transaction before any write; the installed policy is independently required.
    const groupsBefore = (await domainRowCounts(owner, worldlineId)).finance_groups;
    await assert.rejects(
      finance.confirmMilestone({
        scope,
        projectId: unlinkedProjectId,
        milestoneId: `mile_unlinked_${s}`,
        expectedProjectVersion: 1,
        semanticEventKey: "harbor.boycott.completed",
        idempotencyKey: `fin-undeclared-${s}`,
      }),
      (error: unknown) => (error as { code?: string }).code === "COMMAND_INVALID",
    );
    assert.equal(
      (await domainRowCounts(owner, worldlineId)).finance_groups,
      groupsBefore,
      "undeclared semanticEventKey leaves zero command rows",
    );
    cursor = { tick: 0, ordinal: 4 };
    const stageChange = await finance.changeStage({
      scope,
      projectId,
      stage: "production",
      expectedProjectVersion: 2,
      evidence: evidenceFor(recordId, sceneId, cursor),
      idempotencyKey: `fin-stage-${s}`,
    });
    assert.equal(stageChange.status, "committed");
    cursor = { tick: 0, ordinal: 5 };
    const budget = await finance.allocateBudget({
      scope,
      projectId,
      category: "studio",
      amountMinor: 9000,
      expectedVersion: 0,
      idempotencyKey: `fin-budget-${s}`,
    });
    assert.equal(budget.status, "committed");
    const loan = await finance.createObligation({
      scope,
      projectId,
      kind: "loan",
      principalMinor: 5000,
      idempotencyKey: `fin-loan-${s}`,
    });
    assert.equal(loan.status, "committed");
    const obligationId = loan.obligationId;
    const settle = await finance.settleObligation({
      scope,
      obligationId,
      settlementKind: "repayment",
      amountMinor: 2000,
      expectedOutstandingMinor: 5000,
      expectedBalanceMinor: 12000,
      accountId,
      category: "studio",
      memo: "first repayment",
      occurredAt: OCCURRED_AT,
      idempotencyKey: `fin-settle-${s}`,
    });
    assert.equal(settle.status, "committed");
    const balanceBeforeApply = await cashBalance(owner, worldlineId);
    const apply = await finance.applyRecordProjectFinance({
      scope,
      evidence: evidenceFor(recordId, sceneId, cursor),
      actions: [{
        command: "record_expense",
        accountId,
        amountMinor: 500,
        category: "props",
        memo: "props",
        projectId,
        occurredAt: OCCURRED_AT,
        expectedBalanceMinor: balanceBeforeApply,
      }],
      idempotencyKey: `fin-apply-${s}`,
    });
    assert.equal(apply.status, "committed");
    cursor = { tick: 0, ordinal: 6 };
    const adjustment = await finance.recordAdjustment({
      scope,
      accountId,
      amountMinor: 250,
      category: "correction",
      memo: "booking correction",
      direction: "income",
      projectId,
      recordId,
      occurredAt: OCCURRED_AT,
      expectedBalanceMinor: 9500,
      evidence: evidenceFor(recordId, sceneId, cursor),
      idempotencyKey: `fin-adjust-${s}`,
    });
    assert.equal(adjustment.status, "committed");
    cursor = { tick: 0, ordinal: 7 };
    // StoryB project + shared project carry real finance too (worldline-scoped
    // commands without Record evidence).
    const otherBudget = await finance.allocateBudget({
      scope,
      projectId: otherProjectId,
      category: "marketing",
      amountMinor: 4000,
      expectedVersion: 0,
      idempotencyKey: `fin-budget-other-${s}`,
    });
    assert.equal(otherBudget.status, "committed");
    const sharedBudget = await finance.allocateBudget({
      scope,
      projectId: sharedProjectId,
      category: "studio",
      amountMinor: 6000,
      expectedVersion: 0,
      idempotencyKey: `fin-budget-shared-${s}`,
    });
    assert.equal(sharedBudget.status, "committed");
    // StoryB's project carries a real obligation command too.
    const otherLoan = await finance.createObligation({
      scope,
      projectId: otherProjectId,
      kind: "presale",
      principalMinor: 3000,
      undeliveredCount: 2,
      idempotencyKey: `fin-loan-other-${s}`,
    });
    assert.equal(otherLoan.status, "committed");

    // ----- real committed-fact commands (inventory grant first, then adjust)
    const factStoreCalls = recordCommittedCalls(createPostgresCommittedFactCommandStore(runtime));
    const factCalls = recordCommittedCalls(createCommittedFactCommandService({ store: factStoreCalls.proxy,
      atomicPerformanceExecutor: async (trustedScope, intent) => {
        const accepted = (await executePerformanceAssessmentCommand(runtime, {
          ...createPerformanceCommandTrust(trustedScope, POSTGRES_DEMO_IDS.principal), enablement: { schema: true, durableTransport: true },
        }, intent)).result;
        if (accepted.status === "committed") {
          const receipt = await factStoreCalls.proxy.loadCommand(trustedScope, intent.idempotencyKey);
          assert.ok(receipt?.request);
          const input = { scope: trustedScope, commandId: accepted.commandId, idempotencyKey: intent.idempotencyKey,
            requestFingerprint: receipt.requestFingerprint, request: receipt.request,
            recordId: (receipt.request as { recordId: string }).recordId, policyVersion: (receipt.request as { policyVersion: string }).policyVersion, score: accepted.score,
            evidenceEventIds: (receipt.request as { evidenceEventIds: readonly string[] }).evidenceEventIds, evidenceSnapshotHash: accepted.evidenceSnapshotHash };
          factStoreCalls.calls.push({ method: "recordPerformanceAssessment", input: structuredClone(input), result: structuredClone(accepted),
            invoke: input => factStoreCalls.proxy.recordPerformanceAssessment(input as never) });
        }
        return accepted;
      } }));
    const facts = factCalls.proxy;
    const grant = await facts.grantInventory({
      scope,
      recordId,
      characterInstanceId,
      assetDefinitionId,
      quantity: 3,
      sourceEventId: openingEventId,
      idempotencyKey: `fact-grant-${s}`,
    });
    assert.equal(grant.status, "committed");
    const adjust = await facts.adjustInventory({
      scope,
      recordId,
      characterInstanceId,
      assetDefinitionId,
      delta: -1,
      sourceEventId: openingEventId,
      expectedRevision: 0,
      idempotencyKey: `fact-adjust-${s}`,
    });
    assert.equal(adjust.status, "committed");
    const milestoneEvent = await owner.query<{ id: string }>(
      `SELECT id FROM events
       WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3
         AND event_kind = 'project.milestone.confirmed'`,
      [WS, worldlineId, recordId],
    );
    assert.equal(milestoneEvent.rowCount, 1);
    const milestoneEventId = milestoneEvent.rows[0]!.id;
    const assessment = await facts.recordPerformanceAssessment({
      scope,
      recordId,
      policyVersion: "structured-factors:v1",
      evidenceEventIds: [milestoneEventId, openingEventId],
      idempotencyKey: `fact-assess-${s}`,
    });
    assert.equal(assessment.status, "committed");
    assert.equal(assessment.score, 40);

    // ----- Story reconcile: milestone completion + evidence event unlock the
    // two sibling Records in one pass (multi-Record Story topology).
    const reconciled = await storyGraph.reconcile({ workspaceId: WS, storyId, definition: storyDefinition });
    assert.deepEqual([...reconciled.unlockedNodeKeys].sort(), ["epilogue", "finale", "opening"]);
    assert.equal(
      reconciled.nodes.find((node) => node.nodeKey === "finale")?.state,
      "active",
    );
    assert.equal(
      reconciled.nodes.find((node) => node.nodeKey === "epilogue")?.state,
      "active",
    );
    const epilogueRecordId = storyRecordIdFor(storyScope, "epilogue");

    // Sibling Record (finale): a full second runtime — its own character
    // instance of the same continuity, a restricted visibility policy with a
    // typed audience, an actor-bearing dialogue event, relationship evidence,
    // inventory grant/adjust, a performance assessment, and a record-bound
    // finance command. The archive must carry the complete sibling bundle.
    const siblingSceneId = `scene_${s}_r2`;
    const siblingPolicyId = `policy_${s}_r2`;
    const siblingRestrictedPolicyId = `policy_${s}_r2r`;
    const siblingEventId = `evt_${s}_r2`;
    const siblingDialogueEventId = `evt_${s}_r2d`;
    const siblingInstanceId = `char_${s}_r2`;
    const siblingParticipantId = `part_${s}_r2`;
    await owner.query(
      `INSERT INTO character_instances (
         workspace_id, world_id, worldline_id, record_id, continuity_id,
         predecessor_instance_id, id, controller_mode, status,
         instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick,
         inheritance_cutoff_ordinal, retired_tick, retired_ordinal, state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', 'present', 0, 7, 0, 7, NULL, NULL, '{}'::jsonb)`,
      [WS, worldId, worldlineId, siblingRecordId, continuityId, characterInstanceId, siblingInstanceId],
    );
    await owner.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id, participant_kind,
         character_instance_id, principal_id, controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'character', $6, NULL, 'human', true, 0)`,
      [WS, worldId, worldlineId, siblingRecordId, siblingParticipantId, siblingInstanceId],
    );
    await owner.query(
      `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, $5, 'Finale scene', 'active', 0, 7)`,
      [WS, worldId, worldlineId, siblingRecordId, siblingSceneId],
    );
    await owner.query(
      `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
       VALUES ($1, $2, $3, $4, $5, 'finale', 1, 'public')`,
      [WS, worldId, worldlineId, siblingRecordId, siblingPolicyId],
    );
    await owner.query(
      `INSERT INTO visibility_policies (
         workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version,
         policy_kind, restricted_domain_id, audience_character_instance_ids
       ) VALUES ($1, $2, $3, $4, $5, 'finale_whisper', 1, 'restricted', 'domain_finale', $6::text[])`,
      [WS, worldId, worldlineId, siblingRecordId, siblingRestrictedPolicyId, [siblingInstanceId]],
    );
    await owner.query(
      `INSERT INTO events (
         workspace_id, world_id, worldline_id, record_id, scene_id, id,
         record_version, record_ordinal, batch_index, event_kind,
         actor_participant_id, speaker_name, content, payload,
         visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed',
                 NULL, '', 'The finale opens.', '{}'::jsonb, $7, 0, 8, 'native_calendar', '')`,
      [WS, worldId, worldlineId, siblingRecordId, siblingSceneId, siblingEventId, siblingPolicyId],
    );
    await owner.query(
      `INSERT INTO events (
         workspace_id, world_id, worldline_id, record_id, scene_id, id,
         record_version, record_ordinal, batch_index, event_kind,
         actor_participant_id, speaker_name, content, payload,
         visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
       ) VALUES ($1, $2, $3, $4, $5, $6, 2, 2, 0, 'utterance.committed',
                 $7, 'Rehearsal lead', 'Only the cast hears this.', '{}'::jsonb, $8, 0, 9, 'native_calendar', '')`,
      [WS, worldId, worldlineId, siblingRecordId, siblingSceneId, siblingDialogueEventId,
        siblingParticipantId, siblingRestrictedPolicyId],
    );
    await owner.query(
      `UPDATE record_heads
       SET record_version = 2, next_record_ordinal = 3, last_event_id = $5,
           last_world_tick = 0, last_world_ordinal = 9
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4`,
      [WS, worldId, worldlineId, siblingRecordId, siblingDialogueEventId],
    );
    await owner.query(
      `UPDATE worldlines SET head_tick = 0, head_ordinal = 9
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [WS, worldId, worldlineId],
    );
    const revision = await facts.reviseRelationship({
      scope,
      subjectEntityKey: `member_aira_${s}`,
      objectEntityKey: `member_kael_${s}`,
      relationKind: "trust",
      sourceEventId: siblingEventId,
      idempotencyKey: `fact-rel-${s}`,
    });
    assert.equal(revision.status, "committed");
    const siblingGrant = await facts.grantInventory({
      scope,
      recordId: siblingRecordId,
      characterInstanceId: siblingInstanceId,
      assetDefinitionId,
      quantity: 2,
      sourceEventId: siblingEventId,
      idempotencyKey: `fact-grant-r2-${s}`,
    });
    assert.equal(siblingGrant.status, "committed");
    const siblingAdjust = await facts.adjustInventory({
      scope,
      recordId: siblingRecordId,
      characterInstanceId: siblingInstanceId,
      assetDefinitionId,
      delta: -1,
      sourceEventId: siblingDialogueEventId,
      expectedRevision: 0,
      idempotencyKey: `fact-adjust-r2-${s}`,
    });
    assert.equal(siblingAdjust.status, "committed");
    const siblingAssessment = await facts.recordPerformanceAssessment({
      scope,
      recordId: siblingRecordId,
      policyVersion: "structured-factors:v1",
      evidenceEventIds: [siblingEventId, siblingDialogueEventId],
      idempotencyKey: `fact-assess-r2-${s}`,
    });
    assert.equal(siblingAssessment.status, "committed");
    assert.equal(siblingAssessment.score, 20);
    const siblingExpense = await finance.recordExpense({
      scope,
      accountId,
      amountMinor: 700,
      category: "props",
      memo: "finale props",
      projectId,
      occurredAt: OCCURRED_AT,
      expectedBalanceMinor: 9750,
      evidence: evidenceFor(siblingRecordId, siblingSceneId, { tick: 0, ordinal: 9 }),
      idempotencyKey: `fin-expense-r2-${s}`,
    });
    assert.equal(siblingExpense.status, "committed");

    await t.test("native bare-result all-family service replay and direct transaction recheck are exact and write nothing", async () => {
      await proveNativeLegacyReplay(owner, scope, [
        { table: "project_finance_command_groups", service: financeCalls, store: financeStoreCalls, fact: false },
        { table: "committed_fact_commands", service: factCalls, store: factStoreCalls, fact: true },
      ]);
    });

    // ----- legacy provenance fixtures: two rows predate request persistence
    // (bare result manifest), so the archive marks them legacy-result-v1 and
    // cross-restore replay without reverse lineage must fail closed (F2b pending).
    await owner.query(
      `UPDATE project_finance_command_groups
       SET result_manifest = result_manifest -> 'result'
       WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3`,
      [WS, worldlineId, `fin-expense-${s}`],
    );
    await owner.query(
      `UPDATE committed_fact_commands
       SET result_manifest = result_manifest -> 'result'
       WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3`,
      [WS, worldlineId, `fact-grant-${s}`],
    );

    // ----- reader must project the coherent whole-worldline domain scope
    const reader = createPostgresRealmRuntimeSaveReader(runtime, { performanceWitnessesSchemaVersion: 1 });
    // Production input shape: the reader resolves the persisted authoritative
    // Story definition bindings itself; no caller map is required.
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive);
    // A caller-supplied definition may only match the persisted binding;
    // a mismatched one fails closed.
    const compat = await reader.load({ workspaceId: WS, recordId, storyDefinitions: new Map([[storyId, storyDefinition]]), principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(compat);
    await assert.rejects(
      reader.load({ workspaceId: WS, recordId, storyDefinitions: new Map([[storyId, normalizeStoryDefinition({
          storyKey: "story.closure.forged",
          title: "Forged",
          premise: "Forged definition.",
          policyVersion: "story-graph-v1",
          nodes: [{ kind: "record", nodeKey: "opening", recordKey: "forged", title: "Forged", sequence: 1, initial: true }],
        })]]), principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }),
      (error: unknown) => error instanceof Error && error.name === "RealmRuntimeSaveRepositoryError",
    );
    const domain = archive.domain;
    assert.ok(domain);
    assert.deepEqual(
      domain.stories.map((story) => story.id).sort(),
      [storyId, story2Id].sort(),
      "every Story of the worldline is carried",
    );
    assert.deepEqual(
      domain.storyDefinitions.map((entry) => entry.storyId),
      [storyId],
      "the node-bearing Story carries its exact materialization definition",
    );
    assert.deepEqual(
      domain.projects.map((project) => project.id).sort(),
      [projectId, unlinkedProjectId, otherProjectId, sharedProjectId].sort(),
      "linked, unlinked, other-Story, and shared Projects are all carried",
    );
    assert.equal(domain.milestones.length, 3);
    assert.equal(domain.projectStoryLinks.length, 4);
    assert.equal(domain.budgetAllocations.length, 3);
    assert.equal(domain.financeAccounts.length, 1);
    assert.equal(domain.ledgerEntries.length, 6);
    assert.equal(domain.financeCommandGroups.length, 13);
    assert.equal(domain.obligations.length, 2);
    assert.equal(domain.obligationSettlements.length, 1);
    assert.equal(domain.storyNodes.length, 4);
    assert.equal(domain.storyUnlockLedger.length, 3);
    assert.equal(domain.committedFactCommands.length, 7);
    assert.equal(domain.performanceAssessments.length, 2);
    assert.equal(domain.memberRelationshipRevisions.length, 1);
    assert.equal(domain.characterAssets.length, 2);
    // The encore node is still locked: empty evidence, no invented rows.
    const encoreNode = domain.storyNodes.find((node) => node.nodeKey === "encore");
    assert.equal(encoreNode?.state, "locked");
    assert.equal(encoreNode?.recordId, null);
    assert.deepEqual(encoreNode?.unlockEvidence, {});
    assert.deepEqual(encoreNode?.unlockEvidenceEventIds, []);
    assert.deepEqual(
      domain.records.map((row) => row.recordId).sort(),
      [siblingRecordId, epilogueRecordId].sort(),
      "sibling Records bound by Story nodes / domain evidence are carried",
    );
    const siblingSnapshot = domain.records.find((row) => row.recordId === siblingRecordId);
    assert.deepEqual(
      siblingSnapshot?.bundle.record.events.map((event) => event.eventId).sort(),
      [siblingEventId, siblingDialogueEventId, `${siblingExpense.commandGroupId}:event`].sort(),
      "the sibling bundle carries its full event log including the record-bound finance event",
    );
    assert.equal(siblingSnapshot?.status, "active");
    const epilogueSnapshot = domain.records.find((row) => row.recordId === epilogueRecordId);
    assert.equal(epilogueSnapshot?.bundle.record.events.length, 0);
    assert.equal(epilogueSnapshot?.lastEventId, null);
    assert.equal(typeof epilogueSnapshot?.lastWorldOrdinal, "number",
      "a Story-graph-created Record carries its world cursor without events");
    // Real provenance: provenance rows carry the canonical fingerprinted
    // request; the two legacy rows carry none.
    const legacyGroups = domain.financeCommandGroups.filter((group) => group.provenance === "legacy-result-v1");
    assert.deepEqual(legacyGroups.map((group) => group.idempotencyKey), [`fin-expense-${s}`]);
    assert.equal(legacyGroups[0]?.request, null);
    assert.ok(domain.financeCommandGroups.every(
      (group) => group.provenance === "legacy-result-v1"
        ? group.request === null
        : (group.request as { command?: string } | null)?.command !== undefined,
    ));
    const legacyFacts = domain.committedFactCommands.filter((command) => command.provenance === "legacy-result-v1");
    assert.deepEqual(legacyFacts.map((command) => command.idempotencyKey), [`fact-grant-${s}`]);
    assert.equal(legacyFacts[0]?.request, null);
    assert.ok(domain.committedFactCommands.every(
      (command) => command.provenance === "legacy-result-v1"
        ? command.request === null
        : (command.request as { command?: string } | null)?.command !== undefined,
    ));
    assert.match(domain.financeCommandGroups[0]!.requestFingerprint, /^[0-9a-f]{64}$/);

    const bytes = buildRealmRuntimeSaveArchive(archive);
    const reparsed = parseRealmRuntimeSaveArchive(bytes);
    assert.deepEqual(reparsed.domain, domain);

    // ----- restore into a fresh worldline of the same World
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { performanceWitnessesSchemaVersion: 1, resolveCommandPolicy,
      validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const restoreKey = `domain-restore-${s}`;
    // A signed package cannot be moved to a different World identity, even
    // for an authenticated owner with a valid installed source package.
    const forbiddenWorldId = `world_signed_foreign_${s}`;
    await owner.query(`INSERT INTO worlds(workspace_id,id,name,status,calendar_id,settings)
      VALUES ($1,$2,'Different native World','active','native_calendar','{}'::jsonb)`,[WS,forbiddenWorldId]);
    await owner.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role)
      VALUES ($1,$2,$3,'owner')`,[WS,forbiddenWorldId,POSTGRES_DEMO_IDS.principal]);
    const foreignWorldRows = () => owner.query<{count:string}>(`SELECT count(*)::text AS count FROM worldlines WHERE workspace_id=$1 AND world_id=$2`,[WS,forbiddenWorldId]);
    assert.equal((await foreignWorldRows()).rows[0]!.count,"0");
    await assert.rejects(restorer.restore({ workspaceId:WS,principalId:POSTGRES_DEMO_IDS.principal,
      sessionProof:sessionProofFor(POSTGRES_DEMO_IDS.principal),archive:reparsed,targetWorldId:forbiddenWorldId,
      idempotencyKey:`${restoreKey}-foreign-world` }),{code:"RESTORE_INVALID_TARGET",message:"A world-bound save must restore into the same World identity."});
    assert.equal((await foreignWorldRows()).rows[0]!.count,"0","signed identity refusal creates zero target worldlines");
    // Presence in the worldline archive is not evidence ownership: an R1
    // assessment may not borrow an existing R2 event. Test both the archive
    // boundary and direct repository callers, before any target writes.
    const primaryAssessment = reparsed.domain!.performanceAssessments.find((row) => row.recordId === recordId)!;
    const foreignEvidenceDomain = {
      ...reparsed.domain!,
      performanceAssessments: reparsed.domain!.performanceAssessments.map((row) => row.id === primaryAssessment.id
        ? { ...row, evidenceEventIds: [siblingEventId] }
        : row),
    };
    const foreignEvidenceData = { ...reparsed, domain: foreignEvidenceDomain };
    // Keep malformed data raw until the actual public producer/restorer is
    // invoked by the negative control. A preflight producer must not throw
    // during fixture construction and masquerade as a tested rejection.
    const foreignEvidenceArchive = foreignEvidenceData;
    assert.throws(() => realmRuntimeSaveManifestFromData({ ...foreignEvidenceData, ...reparsed.manifest }),
      { code: "INVALID_SAVE", message: "Private performance witness family is invalid." });
    assert.throws(
      () => buildRealmRuntimeSaveArchive(foreignEvidenceArchive),
      (error: unknown) => (error as { code?: string }).code === "INVALID_SAVE",
      "archive build rejects an assessment whose evidence belongs to another Record",
    );
    const beforeRejectedRestore = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM worldlines WHERE workspace_id = $1 AND world_id = $2",
      [WS, worldId],
    );
    await assert.rejects(
      restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal,
        archive: foreignEvidenceArchive, targetWorldId: worldId, idempotencyKey: `${restoreKey}-foreign-evidence` }),
      (error: unknown) => (error as { code?: string }).code === "RUNTIME_SAVE_INVALID",
      "direct restore rejects the same cross-Record evidence without relying on ZIP parsing",
    );
    const afterRejectedRestore = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM worldlines WHERE workspace_id = $1 AND world_id = $2",
      [WS, worldId],
    );
    assert.deepEqual(afterRejectedRestore.rows, beforeRejectedRestore.rows, "invalid evidence creates no target worldline");
    const restored = await restorer.restore({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive: reparsed,
      targetWorldId: worldId,
      idempotencyKey: restoreKey,
    });
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedDomainProjectCount, 4);
    assert.equal(restored.importedDomainLedgerEntryCount, 6);
    assert.equal(restored.importedDomainStoryCount, 2);
    assert.equal(restored.importedDomainRecordCount, 2);
    assert.equal(restored.importedDomainStoryNodeCount, 4);
    assert.equal(restored.importedDomainUnlockCount, 3);
    assert.equal(restored.importedDomainFactCommandCount, 7);
    assert.equal(restored.importedDomainAssessmentCount, 2);
    assert.equal(restored.importedDomainRelationshipRevisionCount, 1);
    assert.equal(restored.importedDomainAssetCount, 2);
    const restoredDefinitionEntry = restored.storyDefinitions?.find((entry) => entry.storyId === restored.storyId);
    assert.ok(restoredDefinitionEntry, "restore exposes the remapped Story definition for continuation");

    const restoredScope = { workspaceId: WS, worldId, worldlineId: restored.worldlineId };
    const counts = await domainRowCounts(owner, restored.worldlineId);
    assert.deepEqual(counts, {
      projects: "4",
      milestones: "3",
      links: "4",
      budgets: "3",
      accounts: "1",
      ledger: "6",
      finance_groups: "13",
      obligations: "2",
      settlements: "1",
      nodes: "4",
      unlocks: "3",
      facts: "7",
      assessments: "2",
      revisions: "1",
      assets: "2",
    });
    // Ledger-derived balances survive the restore.
    assert.equal(await cashBalance(owner, restored.worldlineId), await cashBalance(owner, worldlineId));
    // Milestone completion evidence pair resolves inside the restored Record.
    const restoredMilestone = await owner.query<{
      status: string;
      completion_record_id: string | null;
      completion_event_id: string | null;
    }>(
      `SELECT milestone.status, milestone.completion_record_id, milestone.completion_event_id
       FROM project_milestones AS milestone
       JOIN projects AS project
         ON project.workspace_id = milestone.workspace_id
        AND project.worldline_id = milestone.worldline_id
        AND project.id = milestone.project_id
       WHERE milestone.workspace_id = $1 AND milestone.worldline_id = $2
         AND project.title = 'First production' AND milestone.sequence = 1`,
      [WS, restored.worldlineId],
    );
    assert.equal(restoredMilestone.rows[0]?.status, "completed");
    assert.equal(restoredMilestone.rows[0]?.completion_record_id, restored.recordId);
    const completionEvent = await owner.query<{ id: string }>(
      `SELECT id FROM events
       WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3 AND id = $4
         AND event_kind = 'project.milestone.confirmed'`,
      [WS, restored.worldlineId, restored.recordId, restoredMilestone.rows[0]?.completion_event_id],
    );
    assert.equal(completionEvent.rowCount, 1);
    // Worldline cursor covers restored evidence events too.
    const restoredWorldline = await owner.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [WS, worldId, restored.worldlineId],
    );
    assert.deepEqual(restoredWorldline.rows[0], { head_tick: "0", head_ordinal: "10" });
    // Obligation outstanding and settlement survive.
    const restoredObligation = await owner.query<{ outstanding: string }>(
      `SELECT outstanding_minor::text AS outstanding FROM obligations
       WHERE workspace_id = $1 AND worldline_id = $2 AND kind = 'loan'`,
      [WS, restored.worldlineId],
    );
    assert.equal(restoredObligation.rows[0]?.outstanding, "3000");
    const restoredPresale = await owner.query<{ outstanding: string; undelivered: string }>(
      `SELECT outstanding_minor::text AS outstanding, undelivered_count::text AS undelivered
       FROM obligations
       WHERE workspace_id = $1 AND worldline_id = $2 AND kind = 'presale'`,
      [WS, restored.worldlineId],
    );
    assert.deepEqual(restoredPresale.rows[0], { outstanding: "3000", undelivered: "2" },
      "the other Story's obligation survives the whole-worldline restore");

    // ----- actual production command replay against restored identities.
    // Read the restored domain back through the reader with the remapped
    // definitions the restore exposed: every persisted request/fingerprint is
    // the remapped target-scope provenance; the two legacy rows carry no
    // request and fail closed without reverse identity lineage (F2b pending).
    // The restored worldline carries persisted definition bindings, so the
    // reader needs no caller map after a fresh process/repository either.
    const restoredArchive = await reader.load({ workspaceId: WS, recordId: restored.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(restoredArchive?.domain);
    const restoredDomain = restoredArchive.domain;
    const restoredBeforeReplay = await commandAuthoritySnapshot(owner, restoredScope);
    const restoredFinance = createProjectFinanceCommandService({
      store: createPostgresProjectFinanceCommandStore(runtime),
    });
    const replayFinance = async (idempotencyKey: string) => {
      const group = restoredDomain.financeCommandGroups.find((row) => row.idempotencyKey === idempotencyKey);
      assert.ok(group, `restored finance group ${idempotencyKey}`);
      return group;
    };
    type RequestEvidence = {
      recordId: string;
      sceneId: string;
      visibility: "public" | "restricted";
      worldTick: number;
      worldOrdinal: number;
    } | null;
    const evidenceFromRequest = (evidence: RequestEvidence): RecordEvidence | null => evidence
      ? {
        recordId: evidence.recordId,
        sceneId: evidence.sceneId,
        visibility: evidence.visibility,
        expectedWorldCursor: { worldTick: evidence.worldTick, worldOrdinal: evidence.worldOrdinal },
      }
      : null;
    const financeRequest = <T extends Record<string, unknown>>(group: { request: unknown }): T => {
      assert.ok(group.request, "provenance row carries the canonical request");
      return group.request as T;
    };
    type LedgerRequest = {
      accountId: string | null;
      amountMinor: number;
      category: string;
      memo: string;
      projectId: string | null;
      recordId: string | null;
      occurredAt: string;
      expectedBalanceMinor: number;
      direction?: "income" | "expense";
      evidence: RequestEvidence;
    } & Record<string, unknown>;
    const replayLedger = async (idempotencyKey: string, kind: "expense" | "income" | "adjustment") => {
      const group = await replayFinance(idempotencyKey);
      const request = financeRequest<LedgerRequest>(group);
      const base = {
        scope: restoredScope,
        accountId: request.accountId,
        amountMinor: request.amountMinor,
        category: request.category,
        memo: request.memo,
        projectId: request.projectId,
        recordId: request.recordId,
        occurredAt: request.occurredAt,
        expectedBalanceMinor: request.expectedBalanceMinor,
        evidence: evidenceFromRequest(request.evidence),
        idempotencyKey: group.idempotencyKey,
      };
      if (kind === "income") return restoredFinance.recordIncome(base);
      if (kind === "adjustment") {
        return restoredFinance.recordAdjustment({ ...base, direction: request.direction ?? "expense" });
      }
      return restoredFinance.recordExpense(base);
    };

    // Restored identity lookups for the legacy rows (no stored request).
    const restoredAccountId = (await owner.query<{ id: string }>(
      `SELECT id FROM finance_accounts WHERE workspace_id = $1 AND worldline_id = $2`,
      [WS, restored.worldlineId],
    )).rows[0]!.id;
    const restoredProjectRow = (await owner.query<{ id: string; version: string }>(
      `SELECT id, version::text FROM projects
       WHERE workspace_id = $1 AND worldline_id = $2 AND title = 'First production'`,
      [WS, restored.worldlineId],
    )).rows[0]!;
    const restoredProjectId = restoredProjectRow.id;
    const restoredInstanceId = (await owner.query<{ id: string }>(
      `SELECT id FROM character_instances
       WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3`,
      [WS, restored.worldlineId, restored.recordId],
    )).rows[0]!.id;

    // The exact legacy expense uses its original hash and validated reverse lineage.
    const expenseGroup = await replayFinance(`fin-expense-${s}`);
    assert.equal(expenseGroup.provenance, "legacy-result-v1");
    assert.equal(expenseGroup.request, null);
    const originalExpenseInput = financeCalls.calls.find((call) => call.method === "recordExpense" && call.input.idempotencyKey === expenseGroup.idempotencyKey)!.input;
    const exactExpenseScene = (await owner.query<{ scene_id: string }>(
      `SELECT scene_id FROM events WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND record_ordinal=1`,
      [WS, worldId, restored.worldlineId, restored.recordId],
    )).rows[0]!.scene_id;
    const exactExpenseAccount = (await owner.query<{ id: string }>(
      `SELECT id FROM finance_accounts WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`,
      [WS, worldId, restored.worldlineId],
    )).rows[0]!.id;
    const exactExpenseProject = (await owner.query<{ id: string }>(
      `SELECT id FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND title='First production'`,
      [WS, worldId, restored.worldlineId],
    )).rows[0]!.id;
    const exactExpenseBefore = await commandAuthoritySnapshot(owner, restoredScope);
    assert.equal((await restoredFinance.recordExpense({
      ...originalExpenseInput, scope: restoredScope, accountId: exactExpenseAccount, projectId: exactExpenseProject,
      recordId: restored.recordId, evidence: evidenceFor(restored.recordId, exactExpenseScene, { tick: 0, ordinal: 1 }),
    } as never)).status, "replayed", "F2b3 genuine legacy expense with original scalar inputs and actual SQL target identities");
    assert.deepEqual(await commandAuthoritySnapshot(owner, restoredScope), exactExpenseBefore);
    assert.equal(expenseGroup.requestFingerprint, domain.financeCommandGroups.find((row) => row.idempotencyKey === expenseGroup.idempotencyKey)!.requestFingerprint);
    await assert.rejects(restoredFinance.recordExpense({
      scope: restoredScope,
      accountId: restoredAccountId,
      amountMinor: 3000,
      category: "studio",
      memo: "rehearsal fee",
      projectId: restoredProjectId,
      recordId: restored.recordId,
      occurredAt: OCCURRED_AT,
      expectedBalanceMinor: 10000,
      evidence: null,
      idempotencyKey: expenseGroup.idempotencyKey,
    }), { code: "IDEMPOTENCY_KEY_REUSE" });
    // A changed candidate under the same legacy key also writes nothing.
    await assert.rejects(
      restoredFinance.recordExpense({
        scope: restoredScope,
        accountId: restoredAccountId,
        amountMinor: 3001,
        category: "studio",
        memo: "rehearsal fee",
        projectId: restoredProjectId,
        recordId: restored.recordId,
        occurredAt: OCCURRED_AT,
        expectedBalanceMinor: 10000,
        evidence: null,
        idempotencyKey: expenseGroup.idempotencyKey,
      }),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_KEY_REUSE",
    );

    // Every other finance command kind replays from its remapped request.
    assert.equal((await replayLedger(`fin-income-${s}`, "income")).status, "replayed");
    assert.equal((await replayLedger(`fin-adjust-${s}`, "adjustment")).status, "replayed");
    assert.equal((await replayLedger(`fin-expense-r2-${s}`, "expense")).status, "replayed",
      "the sibling Record's record-bound expense replays");
    const milestoneGroup = await replayFinance(`fin-milestone-${s}`);
    const milestoneRequest = financeRequest<{
      projectId: string;
      milestoneId: string;
      expectedProjectVersion: number;
      evidence: RequestEvidence;
      semanticEventKey?: string;
    }>(milestoneGroup);
    assert.equal(milestoneRequest.semanticEventKey, "harbor.festival.completed",
      "restored request preserves the declared semantic event key");
    const milestoneReplay = await restoredFinance.confirmMilestone({
      scope: restoredScope,
      projectId: milestoneRequest.projectId,
      milestoneId: milestoneRequest.milestoneId,
      expectedProjectVersion: milestoneRequest.expectedProjectVersion,
      evidence: evidenceFromRequest(milestoneRequest.evidence),
      semanticEventKey: milestoneRequest.semanticEventKey,
      idempotencyKey: milestoneGroup.idempotencyKey,
    });
    assert.equal(milestoneReplay.status, "replayed");
    assert.equal(milestoneReplay.semanticEventKey, "harbor.festival.completed");
    const restoredMilestoneEvents = await owner.query<{ payload: { semanticEventKey?: string } }>(
      `SELECT payload FROM events
       WHERE workspace_id = $1 AND worldline_id = $2
         AND event_kind = 'project.milestone.confirmed'`,
      [WS, restored.worldlineId],
    );
    assert.equal(restoredMilestoneEvents.rows.length, 1,
      "replay emits no second milestone completion event");
    assert.equal(restoredMilestoneEvents.rows[0]?.payload.semanticEventKey, "harbor.festival.completed");
    // D4c: the restored engine event payload was remapped field-by-field to
    // the target rows, never string-rewritten prose.
    const restoredMilestoneRow = (await owner.query<{ id: string }>(
      `SELECT milestone.id
       FROM project_milestones AS milestone
       JOIN projects AS project
         ON project.workspace_id = milestone.workspace_id
        AND project.worldline_id = milestone.worldline_id
        AND project.id = milestone.project_id
       WHERE milestone.workspace_id = $1 AND milestone.worldline_id = $2
         AND project.title = 'First production' AND milestone.title = 'First rehearsal'`,
      [WS, restored.worldlineId],
    )).rows[0]!;
    const restoredMilestonePayload = restoredMilestoneEvents.rows[0]!.payload as unknown as {
      projectId: string;
      milestoneId: string;
    };
    assert.equal(restoredMilestonePayload.projectId, restoredProjectId);
    assert.equal(restoredMilestonePayload.milestoneId, restoredMilestoneRow.id);
    // A changed provenance command under the same key is key reuse.
    await assert.rejects(
      restoredFinance.confirmMilestone({
        scope: restoredScope,
        projectId: milestoneRequest.projectId,
        milestoneId: milestoneRequest.milestoneId,
        expectedProjectVersion: milestoneRequest.expectedProjectVersion + 1,
        evidence: null,
        idempotencyKey: milestoneGroup.idempotencyKey,
      }),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_KEY_REUSE",
    );
    const stageGroup = await replayFinance(`fin-stage-${s}`);
    const stageRequest = financeRequest<{
      projectId: string;
      stage: string;
      expectedProjectVersion: number;
      evidence: RequestEvidence;
    }>(stageGroup);
    assert.equal((await restoredFinance.changeStage({
      scope: restoredScope,
      projectId: stageRequest.projectId,
      stage: stageRequest.stage,
      expectedProjectVersion: stageRequest.expectedProjectVersion,
      evidence: evidenceFromRequest(stageRequest.evidence),
      idempotencyKey: stageGroup.idempotencyKey,
    })).status, "replayed");
    for (const key of [`fin-budget-${s}`, `fin-budget-other-${s}`, `fin-budget-shared-${s}`]) {
      const group = await replayFinance(key);
      const request = financeRequest<{
        projectId: string;
        category: string;
        amountMinor: number;
        expectedVersion: number;
      }>(group);
      assert.equal((await restoredFinance.allocateBudget({
        scope: restoredScope,
        projectId: request.projectId,
        category: request.category,
        amountMinor: request.amountMinor,
        expectedVersion: request.expectedVersion,
        idempotencyKey: group.idempotencyKey,
      })).status, "replayed", `${key} replays`);
    }
    for (const key of [`fin-loan-${s}`, `fin-loan-other-${s}`]) {
      const group = await replayFinance(key);
      const request = financeRequest<{
        projectId: string | null;
        kind: "loan" | "presale" | "revenue_share";
        principalMinor: number;
        shareBps: number | null;
        undeliveredCount: number;
      }>(group);
      assert.equal((await restoredFinance.createObligation({
        scope: restoredScope,
        projectId: request.projectId,
        kind: request.kind,
        principalMinor: request.principalMinor,
        shareBps: request.shareBps,
        undeliveredCount: request.undeliveredCount,
        idempotencyKey: group.idempotencyKey,
      })).status, "replayed", `${key} replays`);
    }
    const settleGroup = await replayFinance(`fin-settle-${s}`);
    const settleRequest = financeRequest<{
      obligationId: string;
      settlementKind: string;
      amountMinor: number;
      expectedOutstandingMinor: number;
      expectedBalanceMinor: number;
      accountId: string | null;
      category: string;
      memo: string;
      occurredAt: string;
    }>(settleGroup);
    assert.equal((await restoredFinance.settleObligation({
      scope: restoredScope,
      obligationId: settleRequest.obligationId,
      settlementKind: settleRequest.settlementKind,
      amountMinor: settleRequest.amountMinor,
      expectedOutstandingMinor: settleRequest.expectedOutstandingMinor,
      expectedBalanceMinor: settleRequest.expectedBalanceMinor,
      accountId: settleRequest.accountId,
      category: settleRequest.category,
      memo: settleRequest.memo,
      occurredAt: settleRequest.occurredAt,
      idempotencyKey: settleGroup.idempotencyKey,
    })).status, "replayed");
    const applyGroup = await replayFinance(`fin-apply-${s}`);
    const applyRequest = financeRequest<{
      evidence: RequestEvidence;
      actions: readonly unknown[];
    }>(applyGroup);
    assert.equal((await restoredFinance.applyRecordProjectFinance({
      scope: restoredScope,
      evidence: evidenceFromRequest(applyRequest.evidence),
      actions: applyRequest.actions as never,
      idempotencyKey: applyGroup.idempotencyKey,
    })).status, "replayed");
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).ledger, "6");
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).finance_groups, "13");

    // Legacy grant proves the full original hash through persisted lineage;
    // modern rows retain their exact remapped canonical requests.
    const restoredFacts = createCommittedFactCommandService({
      store: createPostgresCommittedFactCommandStore(runtime),
    });
    const factCommand = (idempotencyKey: string) => {
      const command = restoredDomain.committedFactCommands.find((row) => row.idempotencyKey === idempotencyKey);
      assert.ok(command, `restored fact command ${idempotencyKey}`);
      return command;
    };
    const grantCommand = factCommand(`fact-grant-${s}`);
    assert.equal(grantCommand.provenance, "legacy-result-v1");
    assert.equal(grantCommand.request, null);
    const targetOpeningEventId = (await owner.query<{ id: string }>(
      `SELECT id FROM events WHERE workspace_id = $1 AND record_id = $2 AND record_ordinal = 1`,
      [WS, restored.recordId],
    )).rows[0]!.id;
    const actualTargetAssetId = (await owner.query<{ asset_definition_id: string }>(
      `SELECT asset_definition_id FROM character_assets WHERE workspace_id = $1 AND record_id = $2 AND character_instance_id = $3`,
      [WS, restored.recordId, restoredInstanceId],
    )).rows[0]!.asset_definition_id;
    const beforeExactLegacy = await commandAuthoritySnapshot(owner, restoredScope);
    assert.equal((await restoredFacts.grantInventory({
      scope: restoredScope, recordId: restored.recordId, characterInstanceId: restoredInstanceId,
      assetDefinitionId: actualTargetAssetId, quantity: 3, sourceEventId: targetOpeningEventId,
      idempotencyKey: grantCommand.idempotencyKey,
    })).status, "replayed", "exact original legacy grant uses actual SQL target identities");
    assert.deepEqual(await commandAuthoritySnapshot(owner, restoredScope), beforeExactLegacy);
    assert.equal(grantCommand.requestFingerprint, domain.committedFactCommands.find((row) => row.idempotencyKey === grantCommand.idempotencyKey)!.requestFingerprint);
    await assert.rejects(restoredFacts.grantInventory({
      scope: restoredScope,
      recordId: restored.recordId,
      characterInstanceId: restoredInstanceId,
      assetDefinitionId,
      quantity: 3,
      sourceEventId: "evt_legacy_unknown",
      idempotencyKey: grantCommand.idempotencyKey,
    }), { code: "IDEMPOTENCY_KEY_REUSE" });
    await assert.rejects(
      restoredFacts.grantInventory({
        scope: restoredScope,
        recordId: restored.recordId,
        characterInstanceId: restoredInstanceId,
        assetDefinitionId,
        quantity: 4,
        sourceEventId: "evt_legacy_unknown",
        idempotencyKey: grantCommand.idempotencyKey,
      }),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_KEY_REUSE",
    );
    for (const key of [`fact-adjust-${s}`, `fact-grant-r2-${s}`, `fact-adjust-r2-${s}`]) {
      const command = factCommand(key);
      const request = command.request as unknown as {
        recordId: string;
        characterInstanceId: string;
        assetDefinitionId: string;
        quantity?: number;
        delta?: number;
        expectedRevision?: number;
        sourceEventId: string;
      };
      assert.ok(request);
      if (request.quantity !== undefined) {
        assert.equal((await restoredFacts.grantInventory({
          scope: restoredScope,
          recordId: request.recordId,
          characterInstanceId: request.characterInstanceId,
          assetDefinitionId: request.assetDefinitionId,
          quantity: request.quantity,
          sourceEventId: request.sourceEventId,
          idempotencyKey: command.idempotencyKey,
        })).status, "replayed", `${key} replays`);
      } else {
        assert.equal((await restoredFacts.adjustInventory({
          scope: restoredScope,
          recordId: request.recordId,
          characterInstanceId: request.characterInstanceId,
          assetDefinitionId: request.assetDefinitionId,
          delta: request.delta ?? 0,
          sourceEventId: request.sourceEventId,
          expectedRevision: request.expectedRevision ?? 0,
          idempotencyKey: command.idempotencyKey,
        })).status, "replayed", `${key} replays`);
      }
    }
    const revisionCommand = factCommand(`fact-rel-${s}`);
    const revisionRequest = revisionCommand.request as unknown as {
      subjectEntityKey: string;
      objectEntityKey: string;
      relationKind: string;
      sourceEventId: string;
    };
    assert.ok(revisionRequest);
    assert.equal((await restoredFacts.reviseRelationship({
      scope: restoredScope,
      subjectEntityKey: revisionRequest.subjectEntityKey,
      objectEntityKey: revisionRequest.objectEntityKey,
      relationKind: revisionRequest.relationKind,
      sourceEventId: revisionRequest.sourceEventId,
      idempotencyKey: revisionCommand.idempotencyKey,
    })).status, "replayed");
    for (const [key, expectedScore] of [[`fact-assess-${s}`, 40], [`fact-assess-r2-${s}`, 20]] as const) {
      const command = factCommand(key);
      const request = command.request as unknown as {
        recordId: string;
        policyVersion: string;
        evidenceEventIds: string[];
      };
      assert.ok(request);
      const assessmentReplay = await restoredFacts.recordPerformanceAssessment({
        scope: restoredScope,
        recordId: request.recordId,
        policyVersion: request.policyVersion,
        evidenceEventIds: request.evidenceEventIds,
        idempotencyKey: command.idempotencyKey,
      });
      assert.equal(assessmentReplay.status, "replayed");
      assert.equal(assessmentReplay.score, expectedScore, "restored evidence recomputes the same server score");
    }
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).facts, "7");
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).assessments, "2");
    assert.deepEqual(await commandAuthoritySnapshot(owner, restoredScope), restoredBeforeReplay,
      "modern restored replay and unprovable legacy refusals preserve all receipts, holdings, ledger, versions and cursors");

    // Story reconcile on the restored Story resolves the persisted remapped
    // binding server-side (no caller definition): no duplicated unlocks,
    // encore still locked.
    const reconcileAgain = await storyGraph.reconcile({
      workspaceId: WS,
      storyId: restored.storyId,
    });
    assert.equal(reconcileAgain.definitionHash, restoredDefinitionEntry!.definitionHash);
    // A forged caller definition conflicts against the persisted binding.
    await assert.rejects(
      storyGraph.reconcile({
        workspaceId: WS,
        storyId: restored.storyId,
        definition: storyDefinition,
      }),
      (error: unknown) => error instanceof Error && error.name === "StoryGraphRepositoryError",
    );
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).unlocks, "3");
    assert.equal(reconcileAgain.nodes.find((node) => node.nodeKey === "encore")?.state, "locked");

    // Post-restore Story continuation: confirm the remapped encore milestone
    // through the real command path, then reconcile with the remapped
    // definition — the carried-over locked node unlocks against target
    // identities, proving the remapped definition hash still authorizes.
    const encoreMilestoneRow = (await owner.query<{ id: string }>(
      `SELECT milestone.id
       FROM project_milestones AS milestone
       JOIN projects AS project
         ON project.workspace_id = milestone.workspace_id
        AND project.worldline_id = milestone.worldline_id
        AND project.id = milestone.project_id
       WHERE milestone.workspace_id = $1 AND milestone.worldline_id = $2
         AND project.title = 'First production' AND milestone.title = 'Encore rehearsal'`,
      [WS, restored.worldlineId],
    )).rows[0]!;
    const encoreConfirm = await restoredFinance.confirmMilestone({
      scope: restoredScope,
      projectId: restoredProjectId,
      milestoneId: encoreMilestoneRow.id,
      expectedProjectVersion: Number(restoredProjectRow.version),
      idempotencyKey: `fin-encore-${s}`,
    });
    assert.equal(encoreConfirm.status, "committed");
    const encoreReconcile = await storyGraph.reconcile({
      workspaceId: WS,
      storyId: restored.storyId,
    });
    assert.equal(encoreReconcile.nodes.find((node) => node.nodeKey === "encore")?.state, "active",
      "the carried-over locked node unlocks against the remapped target milestone");
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).unlocks, "4");

    // Continuation: both restored Records accept new committed events from
    // their restored cursors (primary + finale sibling).
    const restoredSiblingRecordId = (await owner.query<{ id: string }>(
      `SELECT id FROM records
       WHERE workspace_id = $1 AND worldline_id = $2 AND title = 'Finale'`,
      [WS, restored.worldlineId],
    )).rows[0]!.id;
    for (const [index, targetRecordId] of [restored.recordId, restoredSiblingRecordId].entries()) {
      const head = (await owner.query<{
        record_version: string;
        next_record_ordinal: string;
      }>(
        `SELECT record_version::text, next_record_ordinal::text FROM record_heads
         WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3`,
        [WS, restored.worldlineId, targetRecordId],
      )).rows[0]!;
      const worldHead = (await owner.query<{ head_tick: string; head_ordinal: string }>(
        `SELECT head_tick::text, head_ordinal::text FROM worldlines
         WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
        [WS, worldId, restored.worldlineId],
      )).rows[0]!;
      const sceneRow = (await owner.query<{ id: string }>(
        `SELECT id FROM scenes
         WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3
         ORDER BY id LIMIT 1`,
        [WS, restored.worldlineId, targetRecordId],
      )).rows[0]!;
      const policyRow = (await owner.query<{ id: string }>(
        `SELECT id FROM visibility_policies
         WHERE workspace_id = $1 AND worldline_id = $2 AND record_id = $3 AND policy_kind = 'public'
         ORDER BY id LIMIT 1`,
        [WS, restored.worldlineId, targetRecordId],
      )).rows[0]!;
      const nextTick = Number(worldHead.head_tick);
      const nextOrdinal = Number(worldHead.head_ordinal) + 1;
      const continuedEventId = `evt_${s}_continued_${index}`;
      await owner.query(
        `INSERT INTO events (
           workspace_id, world_id, worldline_id, record_id, scene_id, id,
           record_version, record_ordinal, batch_index, event_kind,
           actor_participant_id, speaker_name, content, payload,
           visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'narration.committed',
                   NULL, '', 'The story continues.', '{}'::jsonb, $9, $10, $11, 'native_calendar', '')`,
        [WS, worldId, restored.worldlineId, targetRecordId, sceneRow.id, continuedEventId,
          Number(head.record_version) + 1, Number(head.next_record_ordinal), policyRow.id,
          nextTick, nextOrdinal],
      );
      await owner.query(
        `UPDATE record_heads
         SET record_version = record_version + 1, next_record_ordinal = next_record_ordinal + 1,
             last_event_id = $5, last_world_tick = $6, last_world_ordinal = $7
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4`,
        [WS, worldId, restored.worldlineId, targetRecordId, continuedEventId, nextTick, nextOrdinal],
      );
      await owner.query(
        `UPDATE worldlines SET head_tick = $4, head_ordinal = $5
         WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
        [WS, worldId, restored.worldlineId, nextTick, nextOrdinal],
      );
    }
    const continuedCounts = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE workspace_id = $1 AND worldline_id = $2 AND id LIKE $3`,
      [WS, restored.worldlineId, `evt_${s}_continued_%`],
    );
    assert.equal(continuedCounts.rows[0]?.count, "2", "both restored Records continued from their cursors");

    // ----- same archive + same restore key replays with zero new rows
    const replayedRestore = await restorer.restore({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive: reparsed,
      targetWorldId: worldId,
      idempotencyKey: restoreKey,
    });
    assert.equal(replayedRestore.replayed, true);
    assert.equal((await domainRowCounts(owner, restored.worldlineId)).projects, "4");

    // ----- save again from the continued restored Record (encore now
    // unlocked, both Records continued), restore again under a new key.
    const secondRead = await reader.load({ workspaceId: WS, recordId: restored.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(secondRead?.domain);
    assert.equal(secondRead.domain.storyNodes.find((node) => node.nodeKey === "encore")?.state, "active");
    const secondBytes = buildRealmRuntimeSaveArchive(secondRead);
    const secondArchive = parseRealmRuntimeSaveArchive(secondBytes);
    const restoredAgain = await restorer.restore({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive: secondArchive,
      targetWorldId: worldId,
      idempotencyKey: `${restoreKey}-second`,
    });
    assert.equal(restoredAgain.replayed, false);
    assert.equal(restoredAgain.importedDomainUnlockCount, 4);
    const secondCounts = await domainRowCounts(owner, restoredAgain.worldlineId);
    assert.equal(secondCounts.ledger, "6");
    assert.equal(secondCounts.finance_groups, "14", "the post-restore encore command is carried forward");
    assert.equal(secondCounts.unlocks, "4");
    assert.equal(secondCounts.projects, "4");
    // Continued balances exclude the two continuation narrations (no ledger
    // writes), so the re-restored worldline matches the source worldline's
    // cash derived from carried ledger entries.
    assert.equal(await cashBalance(owner, restoredAgain.worldlineId), await cashBalance(owner, worldlineId));

    // Signed packages keep one immutable World ID. Exercise the same stable
    // asset-key remapping across independently installed workspaces here;
    // the separate native positive retains actual distinct-World D4a coverage.
    const worldBId = worldId;
    const assetDefinitionBId = `asset_b_${s}`;
    await library.instantiateRealmWorld({ workspaceId: workspaceB, principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal) }, plan, "closure-target");
    const targetOwner = await owner.query(`UPDATE player_world_memberships SET role='owner'
      WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3 AND role='observer' RETURNING role`, [workspaceB,worldId,POSTGRES_DEMO_IDS.principal]);
    assert.equal(targetOwner.rowCount,1);
    await owner.query(
      `INSERT INTO asset_definitions (workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable, metadata)
       VALUES ($1, $2, $3, $4, 'Signal lantern', 'core', false, '{}'::jsonb)`,
      [workspaceB, worldBId, assetDefinitionBId, `lantern_${s}`],
    );
    const restoredB = await restorer.restore({
      workspaceId: workspaceB,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive: reparsed,
      targetWorldId: worldBId,
      idempotencyKey: `${restoreKey}-worldb`,
    });
    assert.equal(restoredB.replayed, false);
    assert.notEqual(assetDefinitionBId, assetDefinitionId, "fixture: target definition row id really differs");
    const restoredBAssets = await owner.query<{ asset_definition_id: string; quantity: string }>(
      `SELECT asset_definition_id, quantity::text FROM character_assets
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       ORDER BY record_id`,
      [workspaceB, worldBId, restoredB.worldlineId],
    );
    assert.equal(restoredBAssets.rows.length, 2);
    assert.ok(restoredBAssets.rows.every((row) => row.asset_definition_id === assetDefinitionBId),
      "restored inventory binds the target World's definition identity");
    // Command replay in World B uses the target definition id inside the
    // remapped canonical request (fingerprint recomputed against target ids).
    const archiveB = await reader.load({ workspaceId: workspaceB, recordId: restoredB.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archiveB?.domain);
    const adjustBCommand = archiveB.domain.committedFactCommands.find(
      (row) => row.idempotencyKey === `fact-adjust-${s}`,
    );
    assert.ok(adjustBCommand?.request);
    const adjustBRequest = adjustBCommand.request as unknown as {
      recordId: string;
      characterInstanceId: string;
      assetDefinitionId: string;
      delta: number;
      sourceEventId: string;
      expectedRevision: number;
    };
    assert.equal(adjustBRequest.assetDefinitionId, assetDefinitionBId,
      "the remapped request carries the target definition id, not the source id");
    const factsB = createCommittedFactCommandService({
      store: createPostgresCommittedFactCommandStore(runtime),
    });
    const adjustBReplay = await factsB.adjustInventory({
      scope: { workspaceId: workspaceB, worldId: worldBId, worldlineId: restoredB.worldlineId },
      recordId: adjustBRequest.recordId,
      characterInstanceId: adjustBRequest.characterInstanceId,
      assetDefinitionId: adjustBRequest.assetDefinitionId,
      delta: adjustBRequest.delta,
      sourceEventId: adjustBRequest.sourceEventId,
      expectedRevision: adjustBRequest.expectedRevision,
      idempotencyKey: adjustBCommand.idempotencyKey,
    });
    assert.equal(adjustBReplay.status, "replayed",
      "same logical command replays against the target World's definition identity");
    // save-again from World B, restore-again back into the original World:
    // the definition identity resolves back to this World's row by asset_key.
    const restoredB2 = await restorer.restore({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
      archive: parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archiveB)),
      targetWorldId: worldId,
      idempotencyKey: `${restoreKey}-worldb-back`,
    });
    assert.equal(restoredB2.replayed, false);
    const backAssets = await owner.query<{ asset_definition_id: string }>(
      `SELECT asset_definition_id FROM character_assets
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3`,
      [WS, worldId, restoredB2.worldlineId],
    );
    assert.ok(backAssets.rows.every((row) => row.asset_definition_id === assetDefinitionId),
      "save-again/restore-again resolves the definition back by stable asset key");

    // ----- concurrent duplicate restore: two restores race with the same
    // archive + target + key. At most one commits; the loser replays or its
    // transaction rolls back on the identity collision — never double facts.
    const raceKey = `${restoreKey}-race`;
    const worldlinesBefore = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id LIKE 'worldline_restore_%'`,
      [WS, worldId],
    );
    const race = await Promise.allSettled([
      restorer.restore({
        workspaceId: WS,
        principalId: POSTGRES_DEMO_IDS.principal,
        sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
        archive: reparsed,
        targetWorldId: worldId,
        idempotencyKey: raceKey,
      }),
      restorer.restore({
        workspaceId: WS,
        principalId: POSTGRES_DEMO_IDS.principal,
        sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
        archive: reparsed,
        targetWorldId: worldId,
        idempotencyKey: raceKey,
      }),
    ]);
    const fulfilled = race.filter(
      (result): result is PromiseFulfilledResult<typeof restored> => result.status === "fulfilled",
    );
    assert.ok(fulfilled.length >= 1, "at least one concurrent restore completes");
    assert.ok(
      fulfilled.filter((result) => !result.value.replayed).length <= 1,
      "at most one concurrent restore commits",
    );
    const raceWorldlineId = fulfilled[0]!.value.worldlineId;
    assert.ok(fulfilled.every((result) => result.value.worldlineId === raceWorldlineId));
    const worldlinesAfter = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id LIKE 'worldline_restore_%'`,
      [WS, worldId],
    );
    assert.equal(
      Number(worldlinesAfter.rows[0]!.count) - Number(worldlinesBefore.rows[0]!.count),
      1,
      "the race yields exactly one restored worldline",
    );
    const raceCounts = await domainRowCounts(owner, raceWorldlineId);
    assert.equal(raceCounts.ledger, "6");
    assert.equal(raceCounts.facts, "7");
    assert.equal(raceCounts.projects, "4");
    assert.equal(raceCounts.unlocks, "3");
  },
);

test(
  "runtime domain restore fails closed with zero writes on invalid archives and targets",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000 },
  async (t) => {
    const owner = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString, max: 2 });
    owner.on("error", () => {});
    runtime.on("error", () => {});
    t.after(async () => {
      await runtime.end();
      await owner.end();
    });

    const { generateKeyPairSync, verify } = await import("node:crypto");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { installSignedRealmWorldFixture } = await import("./helpers/realmworld-package-fixture.ts");
    const { seedCapabilitySessionKey, sessionProofFor } = await import("./helpers/session-proof.ts");
    const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
    const { createInstalledRealmWorldInstantiationResolver } = await import("../modules/world-transfer/realmworld-runtime-content.ts");
    const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
    installTestSessionSecret();
    const s = randomUUID().replaceAll("-", "").slice(0, 12);
    const worldId = `world_neg_${s}`;
    // A signed package keeps its World identity. Separate workspaces isolate
    // target content without failing the earlier package-identity gate.
    const emptyWorkspaceId = `ws_neg_empty_${s}`;
    const undeclaredWorkspaceId = `ws_neg_decl_${s}`;
    const directory = await mkdtemp(join(tmpdir(), "negative-signed-policy-"));
    t.after(async () => { await rm(directory, { recursive: true, force: true }); });
    const pair = generateKeyPairSync("ed25519");
    const commandPolicy = {
      format: "realmworld-command-policy", schemaVersion: 1, policyVersion: "negative-fixture.v1",
      projects: [{ projectKey: "main", kind: "production", title: { en: "Neg production" },
        milestones: [{ milestoneKey: "completion", title: { en: "Neg milestone" } }] }],
      bindings: [{ bindingKey: "festival.completed", command: "confirm_milestone", projectKey: "main", milestoneKey: "completion",
        semanticEventKey: "harbor.festival.completed", storySelector: "genesis", recordSelector: "genesis", all: [] }],
    };
    await installSignedRealmWorldFixture({ installRoot: directory, worldId, version: "1.2.0", recordTitle: "Negative record", commandPolicy,
      declaredEvents: ["harbor.festival.completed"], keyId: "negative-fixture",
      keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } });
    const verifier = { installRoot: directory, verifySignature: ({ manifest }: { manifest: import("../modules/world-transfer/realmworld-manifest.ts").RealmWorldManifestV1 }) =>
      verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) };
    const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver(verifier);
    const plan = (await createInstalledRealmWorldInstantiationResolver({ ...verifier, locale: "en" })({ kind: "world", worldId, worldVersion: "1.2.0" }))!;
    assert.ok(plan);
    const library = createPostgresLibraryService(runtime, undefined, { resolveCommandPolicy });
    const principalId = POSTGRES_DEMO_IDS.principal;
    for (const workspaceId of [emptyWorkspaceId, undeclaredWorkspaceId]) {
      await owner.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'Negative target')`, [workspaceId]);
      await owner.query(`INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES ($1, $2, 'Negative owner')`, [workspaceId, principalId]);
    }
    for (const workspaceId of [WS, emptyWorkspaceId, undeclaredWorkspaceId]) {
      await seedCapabilitySessionKey(owner, workspaceId);
    }
    const source = await library.instantiateRealmWorld({ workspaceId: WS, principalId, sessionProof: sessionProofFor(principalId) }, plan, "negative-source");
    for (const workspaceId of [emptyWorkspaceId, undeclaredWorkspaceId]) {
      const target = await library.instantiateRealmWorld({ workspaceId, principalId, sessionProof: sessionProofFor(principalId) }, plan, "negative-target");
      assert.equal(target.worldId, source.worldId, "targets qualify against the actual signed package identity");
    }
    const { worldlineId, recordId } = source;
    const installed = (await owner.query<{ project_id: string; milestone_id: string; story_id: string; record_id: string }>(
      `SELECT project_id, milestone_id, story_id, record_id FROM realmworld_command_materializations
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_key = 'main' AND milestone_key = 'completion'`,
      [WS, worldId, worldlineId])).rows;
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.story_id, source.storyId);
    assert.equal(installed[0]!.record_id, recordId);
    const projectId = installed[0]!.project_id;
    const milestoneId = installed[0]!.milestone_id;
    const opening = (await owner.query<{ scene_id: string; id: string }>(
      `SELECT scene_id, id FROM events WHERE workspace_id = $1 AND record_id = $2 AND record_ordinal = 1`, [WS, recordId])).rows;
    assert.equal(opening.length, 1);
    const cursor = (await owner.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [WS, worldId, worldlineId])).rows[0]!;
    // Library genesis already owns its package-authored holdings. Preserve
    // their exact identities rather than treating this as an empty Record.
    const genesisAssets = await owner.query<{
      character_instance_id: string; asset_definition_id: string; quantity: number; revision: number;
    }>(`SELECT character_instance_id, asset_definition_id, quantity::integer AS quantity, revision::integer AS revision
       FROM character_assets WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
       ORDER BY character_instance_id, asset_definition_id`, [WS, worldId, worldlineId, recordId]);
    // An additional asset holding whose definition exists in the source World
    // but not in the empty target World.
    const characterDefinitionId = `chardef_neg_${s}`;
    const continuityId = `cont_neg_${s}`;
    const characterInstanceId = `char_neg_${s}`;
    const assetDefinitionId = `asset_neg_${s}`;
    await owner.query(
      `INSERT INTO character_definitions (workspace_id, world_id, id, display_name, source_format, profile)
       VALUES ($1, $2, $3, 'Neg lead', 'native', '{}'::jsonb)`,
      [WS, worldId, characterDefinitionId],
    );
    await owner.query(
      `INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, status, born_tick, born_ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)`,
      [WS, worldId, worldlineId, characterDefinitionId, continuityId, `ck_neg_${s}`],
    );
    await owner.query(
      `INSERT INTO character_instances (
         workspace_id, world_id, worldline_id, record_id, continuity_id,
         predecessor_instance_id, id, controller_mode, status,
         instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick,
         inheritance_cutoff_ordinal, retired_tick, retired_ordinal, state
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, 'human', 'present', 0, 0, 0, 0, NULL, NULL, '{}'::jsonb)`,
      [WS, worldId, worldlineId, recordId, continuityId, characterInstanceId],
    );
    await owner.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id, participant_kind,
         character_instance_id, principal_id, controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'character', $6, NULL, 'human', true, 1)`,
      [WS, worldId, worldlineId, recordId, `part_neg_${s}`, characterInstanceId],
    );
    await owner.query(
      `INSERT INTO asset_definitions (workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable, metadata)
       VALUES ($1, $2, $3, $4, 'Neg lantern', 'core', false, '{}'::jsonb)`,
      [WS, worldId, assetDefinitionId, `lantern_neg_${s}`],
    );
    await owner.query(
      `INSERT INTO character_assets (
         workspace_id, world_id, worldline_id, record_id, character_instance_id,
         asset_definition_id, quantity, revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, '{}'::jsonb)`,
      [WS, worldId, worldlineId, recordId, characterInstanceId, assetDefinitionId],
    );

    // A real command carrying a World-declared semantic event key, so the
    // archive's command provenance exercises the restore-time declaration
    // gate below.
    await owner.query(
      `UPDATE projects SET status = 'active', stage = 'funding' WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
      [WS, worldId, worldlineId, projectId],
    );
    // Only the declaration target receives this definition. The empty target
    // must fail specifically at asset resolution, before any restore writes.
    await owner.query(
      `INSERT INTO asset_definitions (workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable, metadata)
       SELECT $1, world_id, id, asset_key, title, rule_pack_key, consumable, metadata
       FROM asset_definitions WHERE workspace_id = $2 AND world_id = $3 AND id = $4`,
      [undeclaredWorkspaceId, WS, worldId, assetDefinitionId],
    );
    // Deliberately remove only the persisted target declaration after public
    // signed instantiation. Package trust, policy and owner membership remain
    // valid, so this control reaches the live target-settings refusal.
    await owner.query(`UPDATE worlds SET settings = settings - 'declaredEvents' WHERE workspace_id = $1 AND id = $2`,
      [undeclaredWorkspaceId, worldId]);
    const negFinance = createProjectFinanceCommandService({
      store: createPostgresProjectFinanceCommandStore(runtime, { resolveCommandPolicy }),
    });
    const negMilestone = await negFinance.confirmMilestone({
      scope: { workspaceId: WS, worldId, worldlineId },
      projectId,
      milestoneId,
      expectedProjectVersion: 1,
      evidence: evidenceFor(recordId, opening[0]!.scene_id, { tick: Number(cursor.head_tick), ordinal: Number(cursor.head_ordinal) }),
      semanticEventKey: "harbor.festival.completed",
      idempotencyKey: `neg-milestone-${s}`,
    });
    assert.equal(negMilestone.status, "committed");
    assert.equal(negMilestone.semanticEventKey, "harbor.festival.completed");

    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy,
      validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(archive?.domain);
    assert.equal(archive.domain.characterAssets.length, genesisAssets.rows.length + 1);
    const assetIdentities = (rows: readonly { characterInstanceId: string; assetDefinitionId: string; quantity: number; revision: number }[]) =>
      rows.map(row => [row.characterInstanceId, row.assetDefinitionId, row.quantity, row.revision]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(assetIdentities(archive.domain.characterAssets), assetIdentities([
      ...genesisAssets.rows.map(row => ({ characterInstanceId: row.character_instance_id,
        assetDefinitionId: row.asset_definition_id, quantity: row.quantity, revision: row.revision })),
      { characterInstanceId, assetDefinitionId, quantity: 1, revision: 0 },
    ]), "archive carries every genesis holding and the exact additional missing-target asset, with no extras");
    assert.equal(archive.domain.financeCommandGroups.length, 1);
    assert.equal(
      (archive.domain.financeCommandGroups[0]?.request as { semanticEventKey?: string }).semanticEventKey,
      "harbor.festival.completed",
    );

    // Dangling evidence: a completion event outside the saved Record fails
    // closed at archive build, before any byte is produced.
    const danglingDomain: RealmRuntimeSaveDomainV1 = {
      ...archive.domain,
      // Keep the installed Project, links, command map and receipt coherent;
      // mutate only the completed Milestone's evidence identity.
      milestones: archive.domain.milestones.map(milestone => milestone.id === milestoneId
        ? { ...milestone, completionEventId: "evt_not_saved" }
        : milestone),
    };
    assert.throws(
      () => buildRealmRuntimeSaveArchive({
        manifest: archive.manifest,
        record: archive.record,
        goals: archive.goals,
        topology: archive.topology,
        actionReceipts: archive.actionReceipts,
        characterEffects: archive.characterEffects,
        observations: archive.observations,
        memory: archive.memory,
        outbox: archive.outbox,
        firstNight: archive.firstNight,
        selfPlay: archive.selfPlay,
        domain: danglingDomain,
      }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_SAVE",
    );

    // Malformed bytes: the parser rejects before any restore write.
    const goodBytes = buildRealmRuntimeSaveArchive(archive);
    const tampered = new Uint8Array(goodBytes);
    tampered[tampered.length - 40] = tampered[tampered.length - 40]! ^ 0xff;
    assert.throws(() => parseRealmRuntimeSaveArchive(tampered));

    // Missing definition: the empty target World lacks the asset definition.
    // The whole transaction must roll back.
    await assert.rejects(
      restorer.restore({
        workspaceId: emptyWorkspaceId,
        principalId: POSTGRES_DEMO_IDS.principal,
        archive,
        targetWorldId: worldId,
        idempotencyKey: `neg-missing-${s}`,
      }),
      (error: unknown) => (error as { code?: string }).code === "RESTORE_INVALID_TARGET"
        && (error as Error).message === "The target World lacks a restored asset definition.",
    );
    const leaked = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id LIKE 'worldline_restore_%'`,
      [emptyWorkspaceId, worldId],
    );
    assert.equal(leaked.rows[0]?.count, "0", "failed restore leaves no partial worldline");

    // Undeclared target World: the restored command provenance carries a
    // semantic event key absent from current target settings — fail closed, zero write.
    await assert.rejects(
      restorer.restore({
        workspaceId: undeclaredWorkspaceId,
        principalId: POSTGRES_DEMO_IDS.principal,
        archive,
        targetWorldId: worldId,
        idempotencyKey: `neg-decl-${s}`,
      }),
      (error: unknown) => (error as { code?: string }).code === "RESTORE_INVALID_TARGET"
        && (error as Error).message === "The target World does not declare a restored semantic event key.",
    );
    const leakedDecl = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id LIKE 'worldline_restore_%'`,
      [undeclaredWorkspaceId, worldId],
    );
    assert.equal(leakedDecl.rows[0]?.count, "0", "declaration-gated restore leaves no partial worldline");

    // Stale idempotency: the same key bound to a different archive conflicts.
    const firstKey = `neg-key-${s}`;
    const first = await restorer.restore({
      workspaceId: WS,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: worldId,
      idempotencyKey: firstKey,
    });
    assert.equal(first.replayed, false);
    const other = await reader.load({ workspaceId: WS, recordId: first.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(other);
    await assert.rejects(
      restorer.restore({
        workspaceId: WS,
        principalId: POSTGRES_DEMO_IDS.principal,
        archive: other,
        targetWorldId: worldId,
        idempotencyKey: firstKey,
      }),
      (error: unknown) => (error as { code?: string }).code === "RESTORE_CONFLICT",
    );

    // Cross-workspace reads see nothing (RLS): the saved Record is invisible
    // from another workspace, and a restore there has no target World.
    await owner.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'other') ON CONFLICT (id) DO NOTHING`, [`ws_neg_${s}`]);
    const crossRead = await reader.load({ workspaceId: `ws_neg_${s}`, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.equal(crossRead, null);
    await assert.rejects(
      restorer.restore({
        workspaceId: `ws_neg_${s}`,
        principalId: POSTGRES_DEMO_IDS.principal,
        archive,
        targetWorldId: worldId,
        idempotencyKey: `neg-cross-${s}`,
      }),
    );
  },
);

async function lineageSaveChild(recordId: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("REALM_") || key === "DATABASE_URL") delete env[key];
  env.REALM_RUNTIME_DATABASE_URL = runtimeConnectionString;
  env.REALM_OPERATOR_PRINCIPALS = POSTGRES_DEMO_IDS.principal;
  return await new Promise<ReturnType<typeof parseRealmRuntimeSaveArchive>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("./helpers/legacy-command-lineage-fresh-process-child.ts", import.meta.url)), WS, recordId, POSTGRES_DEMO_IDS.principal],
    { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        assert.equal(code, 0); assert.equal(signal, null);
        const result = JSON.parse(stdout.trim());
        assert.equal(result.mode, "save"); assert.equal(result.pid, child.pid); assert.notEqual(result.pid, process.pid);
        assert.equal(result.poolsClosed, true); assert.equal(result.workspaceId, WS); assert.equal(result.recordId, recordId);
        process.stdout.write(`lineage child ${result.pid}: mode=save poolsClosed=true record=${recordId}\n`);
        resolve(parseRealmRuntimeSaveArchive(Buffer.from(result.archiveBase64, "base64")));
      } catch (error) { reject(error); }
    });
  });
}

test("F2b2 real shared fact anchors, 1025 events, fresh-process projection and three restores", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000,
}, async (t) => {
  const owner = new pg.Pool({ connectionString: adminConnectionString });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString });
  t.after(async () => { await runtime.end(); await owner.end(); });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const worldId = `world_lineage_${suffix}`;
  const worldlineId = `lineage_${suffix}`;
  const storyId = `story_lineage_${suffix}`;
  const scope = { workspaceId: WS, worldId, worldlineId };
  await owner.query(`INSERT INTO worlds (workspace_id,id,name,status,calendar_id,settings)
    VALUES ($1,$2,'Lineage','active','native_calendar','{}'::jsonb)`, [WS, worldId]);
  await owner.query(`INSERT INTO worldlines (workspace_id,world_id,id,label,status,head_tick,head_ordinal)
    VALUES ($1,$2,$3,'Lineage','active',0,0)`, [WS, worldId, worldlineId]);
  await owner.query(`INSERT INTO player_world_memberships (workspace_id,world_id,principal_id,role)
    VALUES ($1,$2,$3,'owner')`, [WS, worldId, POSTGRES_DEMO_IDS.principal]);
  await owner.query(`INSERT INTO stories (workspace_id,world_id,worldline_id,id,title,status,premise,start_tick,start_ordinal)
    VALUES ($1,$2,$3,$4,'Lineage','active','Lineage',0,0)`, [WS, worldId, worldlineId, storyId]);

  const addRecord = async (lineId: string, owningStoryId: string, label: string, eventCount: number, startOrdinal: number) => {
    const recordId = `record_${suffix}_${label}`;
    const sceneId = `scene_${suffix}_${label}`;
    const policyId = `policy_${suffix}_${label}`;
    await owner.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
      VALUES ($1,$2,$3,$4,$5,$6,'active',0,$7,'primary','0.0.0-local')`, [WS, worldId, lineId, owningStoryId, recordId, label, startOrdinal]);
    await owner.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
      VALUES ($1,$2,$3,$4,0,1)`, [WS, worldId, lineId, recordId]);
    await owner.query(`INSERT INTO scenes (workspace_id,world_id,worldline_id,record_id,id,title,status,start_tick,start_ordinal)
      VALUES ($1,$2,$3,$4,$5,'Lineage','active',0,$6)`, [WS, worldId, lineId, recordId, sceneId, startOrdinal]);
    await owner.query(`INSERT INTO visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind)
      VALUES ($1,$2,$3,$4,$5,'opening',1,'public')`, [WS, worldId, lineId, recordId, policyId]);
    await owner.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,
      actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
      SELECT $1,$2,$3,$4,$5,$4 || '_event_' || i,i,i,0,'narration.committed',NULL,'','Evidence','{}'::jsonb,$6,0,$8+i,'native_calendar',''
      FROM generate_series(1,$7::integer) AS i`, [WS, worldId, lineId, recordId, sceneId, policyId, eventCount, startOrdinal]);
    await owner.query(`UPDATE record_heads SET record_version=$5::bigint,next_record_ordinal=$5::bigint+1,last_event_id=$6,last_world_tick=0,last_world_ordinal=$7
      WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4`,
    [WS, worldId, lineId, recordId, eventCount, `${recordId}_event_${eventCount}`, startOrdinal + eventCount]);
    await owner.query(`UPDATE worldlines SET head_tick=0,head_ordinal=$4 WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,
      [WS, worldId, lineId, startOrdinal + eventCount]);
    return recordId;
  };
  const recordA = await addRecord(worldlineId, storyId, "A", 1, 0);
  const recordB = await addRecord(worldlineId, storyId, "B", 1025, 1);
  const actorIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    const definitionId = `definition_${suffix}_${index}`;
    const continuityId = `continuity_${suffix}_${index}`;
    const instanceId = `actor_${suffix}_${index}`;
    actorIds.push(instanceId);
    await owner.query(`INSERT INTO character_definitions (workspace_id,world_id,id,display_name,source_format,profile)
      VALUES ($1,$2,$3,'Actor','native','{}'::jsonb)`, [WS, worldId, definitionId]);
    await owner.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,status,born_tick,born_ordinal)
      VALUES ($1,$2,$3,$4,$5,$5,'active',0,0)`, [WS, worldId, worldlineId, definitionId, continuityId]);
    await owner.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,predecessor_instance_id,id,controller_mode,status,
      instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,retired_tick,retired_ordinal,state)
      VALUES ($1,$2,$3,$4,$5,NULL,$6,'human','present',0,0,0,0,NULL,NULL,'{}'::jsonb)`, [WS, worldId, worldlineId, recordB, continuityId, instanceId]);
    await owner.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode,is_active,speaking_order)
      VALUES ($1,$2,$3,$4,$5,'character',$6,NULL,'human',true,$7)`, [WS, worldId, worldlineId, recordB, `part_${suffix}_${index}`, instanceId, index]);
  }
  const assetId = `asset_${suffix}`;
  const secondAssetId = `asset_other_${suffix}`;
  for (const id of [assetId, secondAssetId]) await owner.query(`INSERT INTO asset_definitions (workspace_id,world_id,id,asset_key,title,rule_pack_key,consumable,metadata)
    VALUES ($1,$2,$3,$3,'Asset','core',false,'{}'::jsonb)`, [WS, worldId, id]);
  const recorded = recordCommittedCalls(createPostgresCommittedFactCommandStore(runtime));
  const sourceService = createCommittedFactCommandService({ store: recorded.proxy });
  const event1 = `${recordB}_event_1`, event2 = `${recordB}_event_2`;
  await sourceService.grantInventory({ scope, recordId: recordB, characterInstanceId: actorIds[0]!, assetDefinitionId: assetId,
    quantity: 3, sourceEventId: event1, idempotencyKey: "grant" });
  await sourceService.adjustInventory({ scope, recordId: recordB, characterInstanceId: actorIds[0]!, assetDefinitionId: assetId,
    delta: -1, expectedRevision: 0, sourceEventId: event2, idempotencyKey: "adjust" });
  for (const [key, event] of [["relationship-1", event1], ["relationship-2", event2]]) {
    await sourceService.reviseRelationship({ scope, subjectEntityKey: "member:a", objectEntityKey: "member:b", relationKind: "trust",
      sourceEventId: event!, idempotencyKey: key! });
  }
  const { result: acceptedAssessment } = await executePerformanceAssessmentCommand(runtime, {
    ...createPerformanceCommandTrust(scope, POSTGRES_DEMO_IDS.principal),
    enablement: { schema: true, durableTransport: true },
  }, { recordId: recordB, policyVersion: "structured-factors:v1",
    evidenceEventIds: [event1, event2], idempotencyKey: "assessment" });
  assert.equal(acceptedAssessment.status, "committed");
  const acceptedReceipt = await recorded.proxy.loadCommand(scope, "assessment");
  assert.ok(acceptedReceipt?.request);
  assert.equal(acceptedReceipt.requestFingerprint, committedFactRequestFingerprintFor(scope, acceptedReceipt.request));
  // The atomic executor owns its internal store. Retain a replay-input oracle
  // from its actually persisted accepted receipt, not a reconstructed score or
  // a claim that the outer recording proxy observed that internal write.
  const assessmentReplayInput = { scope, commandId: acceptedAssessment.commandId,
    idempotencyKey: "assessment", requestFingerprint: acceptedReceipt.requestFingerprint,
    recordId: recordB, policyVersion: "structured-factors:v1", score: acceptedAssessment.score,
    evidenceEventIds: [event1, event2], evidenceSnapshotHash: acceptedAssessment.evidenceSnapshotHash,
    request: acceptedReceipt.request };
  const assessmentStore = createPostgresCommittedFactCommandStore(runtime);
  recorded.calls.push({ method: "recordPerformanceAssessment", input: structuredClone(assessmentReplayInput),
    result: structuredClone(acceptedAssessment), invoke: input => assessmentStore.recordPerformanceAssessment(input as never) });
  const originalRequests = new Map(recorded.calls.map((call) => [call.input.idempotencyKey as string, call.input.request as Record<string, unknown>]));
  const originals = (await owner.query(`SELECT id,idempotency_key,request_fingerprint,result_manifest FROM committed_fact_commands
    WHERE workspace_id=$1 AND worldline_id=$2 ORDER BY id`, [WS, worldlineId])).rows;
  await owner.query(`UPDATE committed_fact_commands SET result_manifest=result_manifest->'result'
    WHERE workspace_id=$1 AND worldline_id=$2`, [WS, worldlineId]);
  const sourceBefore = await commandAuthoritySnapshot(owner, scope);
  const reader = createPostgresRealmRuntimeSaveReader(runtime);
  const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const sourceArchive = await reader.load({ workspaceId: WS, recordId: recordA, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
  assert.ok(sourceArchive?.domain);
  assert.equal(sourceArchive.domain.records.length, 1);
  assert.equal(sourceArchive.domain.records[0]!.recordId, recordB);
  assert.equal(sourceArchive.domain.records[0]!.bundle.record.events.length, 1025);
  assert.equal(sourceArchive.domain.commandReplayContexts?.length, 1);
  assert.equal(sourceArchive.domain.committedFactCommands.length, 5);
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), sourceBefore, "ordinary export never backfills native receipts");
  const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(sourceArchive));
  const worldSnapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ["worlds", "worldlines", "player_world_memberships", "asset_definitions", "skill_definitions", "effect_definitions", "character_definitions",
      "character_continuities", "character_instances", "participants", "stories", "story_definition_bindings", "story_node_instances",
      "story_unlock_ledger", "records", "record_heads", "scenes", "visibility_policies", "events", "goal_instances", "goal_assessments",
      "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "outbox", "record_first_nights", "record_self_play_sessions",
      "projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups",
      "obligations", "obligation_settlements", "committed_fact_commands", "character_assets", "performance_assessments", "member_relationship_revisions"]) {
      rows[table] = (await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb) AS rows
        FROM ${table} row WHERE workspace_id=$1 AND ${table === "worlds" ? "id" : "world_id"}=$2`, [WS, worldId])).rows[0].rows;
    }
    return rows;
  };
  const withContext = (context: ReturnType<typeof createReplayContext>, inputDomain = archive.domain!) => ({
    ...archive, domain: { ...inputDomain, commandReplayContexts: [context], committedFactCommands: inputDomain.committedFactCommands.map((command) => ({
      ...command, replayLineage: { ...command.replayLineage!, contextId: context.id },
    })) },
  });
  const sourceBody = { ...archive.domain!.commandReplayContexts![0]! };
  Reflect.deleteProperty(sourceBody, "id");
  const missingEvent = createReplayContext({ ...sourceBody, identities: { ...sourceBody.identities, event: sourceBody.identities.event.slice(1) } });
  const extraEvent = createReplayContext({ ...sourceBody, identities: { ...sourceBody.identities,
    event: [...sourceBody.identities.event, ["zz_unrelated_private_event", "zz_unrelated_private_event"]] } });
  const foreignWorkspace = createReplayContext({ ...sourceBody, currentScope: { ...sourceBody.currentScope, workspaceId: "foreign_workspace" } });
  const archiveCases = [withContext(missingEvent), withContext(extraEvent), withContext(foreignWorkspace),
    { ...archive, domain: { ...archive.domain!, commandReplayContexts: [] } },
    { ...archive, domain: { ...archive.domain!, committedFactCommands: archive.domain!.committedFactCommands.map((command, index) =>
      index ? command : { ...command, replayLineage: { ...command.replayLineage!, contextId: "0".repeat(64) } }) } },
    { ...archive, domain: { ...archive.domain!, financeCommandGroups: [{ replayLineage: {} } as never] } },
    { ...archive, domain: { ...archive.domain!, committedFactCommands: archive.domain!.committedFactCommands.map((command, index) =>
      index === 1 ? { ...command, idempotencyKey: archive.domain!.committedFactCommands[0]!.idempotencyKey } : command) } },
  ];
  for (const [index, bad] of archiveCases.entries()) {
    const before = await worldSnapshot();
    await assert.rejects(restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
      archive: bad, idempotencyKey: `lineage-invalid-${suffix}-${index}` }), { code: "RUNTIME_SAVE_INVALID" });
    assert.deepEqual(await worldSnapshot(), before, "direct restore rejects before definitions/topology/Story/Record writes");
    assert.throws(() => buildRealmRuntimeSaveArchive(bad));
    const files = unzipSync(buildRealmRuntimeSaveArchive(archive));
    files["runtime/domain.json"] = Buffer.from(JSON.stringify(bad.domain));
    const manifest = structuredClone(archive.manifest);
    manifest.snapshot.runtimeHash = computeRealmRuntimeSaveContentHash(new Map(Object.entries(files).filter(([path]) => path !== "realm-save-manifest.json")));
    files["realm-save-manifest.json"] = Buffer.from(JSON.stringify(manifest));
    // Both the imported context digest and outer runtimeHash may be valid; actual closure still wins.
    const ordered = Object.fromEntries(["realm-save-manifest.json", ...Object.keys(files).filter((path) => path !== "realm-save-manifest.json")].map((path) => [path, files[path]!]));
    assert.throws(() => parseRealmRuntimeSaveArchive(zipSync(ordered)));
  }
  const alias = "source_asset_alias";
  const aliasedContext = createReplayContext({ ...sourceBody, identities: { ...sourceBody.identities,
    assetDefinition: [...sourceBody.identities.assetDefinition, [alias, alias]].sort(([a], [b]) => a! < b! ? -1 : 1) } });
  const aliasedArchive = withContext(aliasedContext, { ...archive.domain!, characterAssets: [...archive.domain!.characterAssets,
    { ...archive.domain!.characterAssets[0]!, characterInstanceId: actorIds[1]!, assetDefinitionId: alias }] });
  const conflictingHints = { ...archive, domain: { ...archive.domain!, characterAssets: [...archive.domain!.characterAssets,
    { ...archive.domain!.characterAssets[0]!, characterInstanceId: actorIds[1]!, assetKey: "conflicting_asset_key" }] } };
  const beforeHints = await worldSnapshot();
  await assert.rejects(restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
    archive: conflictingHints, idempotencyKey: `lineage-hints-${suffix}` }), { code: "RUNTIME_SAVE_INVALID" });
  assert.deepEqual(await worldSnapshot(), beforeHints);
  const beforeAlias = await worldSnapshot();
  await assert.rejects(restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
    archive: aliasedArchive, idempotencyKey: `lineage-alias-${suffix}` }), { code: "RUNTIME_SAVE_INVALID" });
  assert.deepEqual(await worldSnapshot(), beforeAlias);
  const first = await restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
    archive, idempotencyKey: `lineage-first-${suffix}` });

  const originalContext = archive.domain!.commandReplayContexts![0]!;
  const assertReplayRound = async (lineId: string, primaryRecordId: string) => {
    const targetScope = { workspaceId: WS, worldId, worldlineId: lineId };
    const current = await reader.load({ workspaceId: WS, recordId: primaryRecordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
    assert.ok(current?.domain);
    const context = current.domain.commandReplayContexts![0]!;
    assert.deepEqual(context.originScope, originalContext.originScope);
    const map = (kind: "record" | "event" | "characterInstance" | "assetDefinition", id: unknown) => {
      const pair = context.identities[kind].find(([, origin]) => origin === id);
      assert.ok(pair, `actual ${kind} remap for ${String(id)}`); return pair[0];
    };
    const targetRequests = new Map<string, Record<string, unknown>>();
    for (const [key, request] of originalRequests) {
      const next = { ...request };
      for (const [field, kind] of [["recordId", "record"], ["sourceEventId", "event"], ["characterInstanceId", "characterInstance"], ["assetDefinitionId", "assetDefinition"]] as const) {
        if (typeof next[field] === "string") next[field] = map(kind, next[field]);
      }
      if (Array.isArray(next.evidenceEventIds)) next.evidenceEventIds = next.evidenceEventIds.map((id) => map("event", id)).sort((a, b) => a.localeCompare(b));
      targetRequests.set(key, next);
    }
    const store = createPostgresCommittedFactCommandStore(runtime);
    const service = createCommittedFactCommandService({ store });
    const missed = createCommittedFactCommandService({ store: { ...store, loadCommand: async () => null },
      // New scoring never uses the retired store-miss fallback. Its real
      // application executor rereads the accepted receipt under admission;
      // production-disabled new admission is deliberately not overridden here.
      atomicPerformanceExecutor: async (trustedScope, intent) => (await executePerformanceAssessmentCommand(runtime,
        createPerformanceCommandTrust(trustedScope, POSTGRES_DEMO_IDS.principal), intent)).result });
    const noWrites = async (action: () => Promise<unknown>, rejects = false) => {
      const before = await commandAuthoritySnapshot(owner, targetScope);
      if (rejects) await assert.rejects(action, { code: "IDEMPOTENCY_KEY_REUSE" });
      else assert.equal((await action() as { status: string }).status, "replayed");
      assert.deepEqual(await commandAuthoritySnapshot(owner, targetScope), before);
    };
    for (const call of recorded.calls) {
      const key = call.input.idempotencyKey as string;
      const request = targetRequests.get(key)!;
      const candidate: Record<string, unknown> = { ...request, scope: targetScope, idempotencyKey: key };
      delete candidate.command; delete candidate.score;
      const method = call.method as "grantInventory" | "adjustInventory" | "reviseRelationship" | "recordPerformanceAssessment";
      for (const gate of [service, missed]) await noWrites(() => Reflect.apply(gate[method], gate, [candidate]));
      const directInput = { ...call.input, ...request, scope: targetScope, request, requestFingerprint: committedFactRequestFingerprintFor(targetScope, request),
        // This direct-store candidate names target Event IDs. Its evidence hash
        // must name those same IDs, while the stored historical fingerprint
        // remains unchanged and is tested separately below.
        ...(method === "recordPerformanceAssessment" ? { evidenceSnapshotHash: evidenceHash(request.evidenceEventIds as string[]) } : {}) };
      await noWrites(() => Reflect.apply(store[method], store, [directInput]));
      const original = originals.find((row) => row.idempotency_key === key)!;
      const actual: RealmRuntimeSaveDomainV1["committedFactCommands"][number] = current.domain.committedFactCommands.find((command) => command.idempotencyKey === key)!;
      assert.equal(actual.requestFingerprint, original.request_fingerprint); assert.equal(actual.request, null);
      for (const [field, value] of Object.entries(request)) {
        if (["command", "policyVersion", "score", "recordId", "characterInstanceId", "assetDefinitionId", "sourceEventId", "evidenceEventIds"].includes(field)) continue;
        const changed = typeof value === "number" ? (value === -1 ? -2 : value + 1) : `${String(value)}_changed`;
        await noWrites(() => Reflect.apply(service[method], service, [{ ...candidate, [field]: changed }]), true);
      }
      const wrongOperation = { ...request, command: request.command === "inventory.adjusted" ? "inventory.granted" : "inventory.adjusted" };
      await noWrites(() => Reflect.apply(store[method], store, [{ ...directInput, request: wrongOperation,
        requestFingerprint: committedFactRequestFingerprintFor(targetScope, wrongOperation) }]), true);
      await noWrites(() => Reflect.apply(store[method], store, [{ ...directInput, requestFingerprint: original.request_fingerprint }]), true);
    }
    const grant = targetRequests.get("grant")!;
    const grantInput = { ...grant, scope: targetScope, idempotencyKey: "grant" };
    const secondActor = map("characterInstance", actorIds[1]);
    const differentEvent = map("event", event2);
    const targetB = map("record", recordB);
    for (const patch of [{ characterInstanceId: secondActor }, { sourceEventId: differentEvent }, { quantity: 4 },
      { assetDefinitionId: secondAssetId }, ...(primaryRecordId !== targetB ? [{ recordId: primaryRecordId }] : [])]) {
      await noWrites(() => service.grantInventory({ ...grantInput, ...patch } as never), true);
    }
    const assessment = { ...targetRequests.get("assessment")! };
    delete assessment.command; delete assessment.score;
    await noWrites(() => service.recordPerformanceAssessment({ ...assessment, scope: targetScope, idempotencyKey: "assessment",
      evidenceEventIds: [map("event", `${recordB}_event_3`), map("event", event2)] } as never), true);
    const sqlRows = (await owner.query(`SELECT id,idempotency_key,request_fingerprint,result_manifest FROM committed_fact_commands
      WHERE workspace_id=$1 AND worldline_id=$2 ORDER BY id`, [WS, lineId])).rows;
    assert.equal(sqlRows.filter((row) => Object.hasOwn(row.result_manifest, "replayContext")).length, 1);
    const anchor = sqlRows.find((row) => Object.hasOwn(row.result_manifest, "replayContext"))!;
    assert.equal(anchor.id, sqlRows.map((row) => row.id).sort()[0]);
    assert.equal(anchor.result_manifest.replayLineage.anchorCommandId, anchor.id);
    for (const row of sqlRows) {
      assert.equal(row.result_manifest.request, null);
      assert.equal(row.result_manifest.replayLineage.anchorCommandId, anchor.id);
      const loaded = await createPostgresCommittedFactCommandStore(runtime).loadCommand(targetScope, row.idempotency_key);
      assert.equal(loaded?.replayProof?.context.id, anchor.result_manifest.replayContext.id);
    }
    t.diagnostic(`lineage SQL round: worldline=${lineId} facts=${sqlRows.length} anchors=1 peers=${sqlRows.length - 1} events=${context.identities.event.length} origin=${context.originScope.worldlineId} anchor=${anchor.id}`);
    return { current, targetScope, targetB, targetRequests, sqlRows, anchor, noWrites, service };
  };
  const round1 = await assertReplayRound(first.worldlineId, first.recordId);
  const beforeBProjection = await commandAuthoritySnapshot(owner, round1.targetScope);
  const bArchive = await lineageSaveChild(round1.targetB);
  assert.ok(bArchive.domain);
  assert.equal(bArchive.domain.records.length, 0, "A has no B-owned evidence dependency and must be omitted");
  assert.deepEqual(bArchive.domain.commandReplayContexts![0]!.identities.record.map(([id]) => id), [round1.targetB]);
  assert.deepEqual(await commandAuthoritySnapshot(owner, round1.targetScope), beforeBProjection);
  const second = await restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
    archive: bArchive, idempotencyKey: `lineage-second-${suffix}` });
  const round2 = await assertReplayRound(second.worldlineId, second.recordId);
  const recordC = await addRecord(second.worldlineId, second.storyId, "C", 1, 1026);
  const beforeProjection = await commandAuthoritySnapshot(owner, round2.targetScope);
  const cArchive = await lineageSaveChild(recordC);
  assert.deepEqual(await commandAuthoritySnapshot(owner, round2.targetScope), beforeProjection, "projection leaves source anchor and every receipt byte-equal");
  assert.ok(cArchive.domain);
  const projected = cArchive.domain.commandReplayContexts![0]!;
  assert.ok(projected.identities.record.some(([id, origin]) => id === recordC && origin === null));
  assert.equal(projected.identities.record.length, 2);
  assert.equal(cArchive.domain.records.length, 1);
  assert.deepEqual(projected.originScope, originalContext.originScope);
  const third = await restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, targetWorldId: worldId,
    archive: cArchive, idempotencyKey: `lineage-third-${suffix}` });
  const round3 = await assertReplayRound(third.worldlineId, third.recordId);
  assert.equal(round3.current.domain!.commandReplayContexts![0]!.identities.event.filter(([, origin]) => origin === null).length, 1);

  // Tamper only disposable target receipts. Each failed call gets its own full sixteen-table image.
  const peer = round3.sqlRows.find((row) => row.id !== round3.anchor.id)!;
  const anchorManifest = structuredClone(round3.anchor.result_manifest);
  const peerManifest = structuredClone(peer.result_manifest);
  const sourceAnchorId = round1.anchor.id;
  const tamperCases = [
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: "missing" } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: sourceAnchorId } } },
    { id: round3.anchor.id, manifest: { ...anchorManifest, replayLineage: { ...anchorManifest.replayLineage, anchorCommandId: peer.id } } },
    { id: round3.anchor.id, manifest: { ...anchorManifest, replayContext: { ...anchorManifest.replayContext, id: "0".repeat(64) } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, originalRequestFingerprint: "0".repeat(64) } } },
    { id: peer.id, manifest: { ...peerManifest, provenance: "request-result-v1" } },
    { id: peer.id, manifest: { ...peerManifest, replayContext: anchorManifest.replayContext } },
  ];
  const contextBody = { ...anchorManifest.replayContext };
  delete contextBody.id;
  tamperCases.push({ id: round3.anchor.id, manifest: { ...anchorManifest, replayContext: createReplayContext({ ...contextBody,
    family: "finance", identities: { ...contextBody.identities, event: [], characterInstance: [], assetDefinition: [] } }) } });
  for (const tamper of tamperCases) {
    await owner.query(`UPDATE committed_fact_commands SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [WS, tamper.id, JSON.stringify(tamper.manifest)]);
    const before = await commandAuthoritySnapshot(owner, round3.targetScope);
    await assert.rejects(createPostgresCommittedFactCommandStore(runtime).loadCommand(round3.targetScope, peer.idempotency_key), { code: "IDEMPOTENCY_KEY_REUSE" });
    assert.deepEqual(await commandAuthoritySnapshot(owner, round3.targetScope), before);
    await assert.rejects(reader.load({ workspaceId: WS, recordId: third.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }), { code: "RUNTIME_SAVE_INVALID" });
    assert.deepEqual(await commandAuthoritySnapshot(owner, round3.targetScope), before);
    await owner.query(`UPDATE committed_fact_commands SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
      [WS, tamper.id, JSON.stringify(tamper.id === peer.id ? peerManifest : anchorManifest)]);
  }
  // Rehash internally consistent metadata to exercise scope/family/null-origin checks independently of digest mismatch.
  const contextVariants = [
    createReplayContext({ ...contextBody, currentScope: { ...contextBody.currentScope, worldlineId: first.worldlineId } }),
    createReplayContext({ ...contextBody, family: "finance", identities: { ...contextBody.identities, event: [], characterInstance: [], assetDefinition: [] } }),
    createReplayContext({ ...contextBody, identities: { ...contextBody.identities,
      event: contextBody.identities.event.map(([current, origin]: [string, string | null]) => [current, origin === event1 ? null : origin]) } }),
  ];
  for (const context of contextVariants) {
    for (const row of round3.sqlRows) {
      const manifest = structuredClone(row.result_manifest);
      manifest.replayLineage.contextId = context.id;
      if (row.id === round3.anchor.id) manifest.replayContext = context;
      await owner.query(`UPDATE committed_fact_commands SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [WS, row.id, JSON.stringify(manifest)]);
    }
    const grant = { ...round3.targetRequests.get("grant"), scope: round3.targetScope, idempotencyKey: "grant" };
    await round3.noWrites(() => round3.service.grantInventory(grant as never), true);
    if (context.family === "fact" && context.currentScope.worldlineId === third.worldlineId) {
      // B's other event still has a known origin; the missing origin is not a wildcard.
      const adjustment = { ...round3.targetRequests.get("adjust"), scope: round3.targetScope, idempotencyKey: "adjust" };
      await round3.noWrites(() => round3.service.adjustInventory(adjustment as never));
    }
    for (const row of round3.sqlRows) await owner.query(`UPDATE committed_fact_commands SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [WS, row.id, JSON.stringify(row.result_manifest)]);
  }
  await owner.query(`UPDATE committed_fact_commands SET request_fingerprint=$3 WHERE workspace_id=$1 AND id=$2`, [WS, peer.id, "0".repeat(64)]);
  const beforeWrongHash = await commandAuthoritySnapshot(owner, round3.targetScope);
  await assert.rejects(createPostgresCommittedFactCommandStore(runtime).loadCommand(round3.targetScope, peer.idempotency_key), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.deepEqual(await commandAuthoritySnapshot(owner, round3.targetScope), beforeWrongHash);
  await owner.query(`UPDATE committed_fact_commands SET request_fingerprint=$3 WHERE workspace_id=$1 AND id=$2`, [WS, peer.id, peer.request_fingerprint]);
  {
    // The actual selected row kind is mandatory at the shared gate.
    const previousKind = (await owner.query(`SELECT kind FROM committed_fact_commands WHERE workspace_id=$1 AND id=$2`, [WS, peer.id])).rows[0].kind;
    const changedKind = previousKind === "inventory_granted" ? "inventory_adjusted" : "inventory_granted";
    await owner.query(`UPDATE committed_fact_commands SET kind=$3 WHERE workspace_id=$1 AND id=$2`, [WS, peer.id, changedKind]);
    const loaded = await createPostgresCommittedFactCommandStore(runtime).loadCommand(round3.targetScope, peer.idempotency_key);
    assert.equal(loaded?.kind, changedKind);
    const call = recorded.calls.find((call) => call.input.idempotencyKey === peer.idempotency_key)!;
    const candidate: Record<string, unknown> = { ...round3.targetRequests.get(peer.idempotency_key), scope: round3.targetScope, idempotencyKey: peer.idempotency_key };
    delete candidate.command; delete candidate.score;
    await round3.noWrites(() => Reflect.apply(round3.service[call.method as keyof typeof round3.service], round3.service, [candidate]), true);
    await owner.query(`UPDATE committed_fact_commands SET kind=$3 WHERE workspace_id=$1 AND id=$2`, [WS, peer.id, previousKind]);
  }
});

async function financeSaveChild(workspaceId: string, recordId: string, principalId: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("REALM_") || key === "DATABASE_URL") delete env[key];
  env.REALM_RUNTIME_DATABASE_URL = runtimeConnectionString;
  env.REALM_OPERATOR_PRINCIPALS=principalId;
  return await new Promise<ReturnType<typeof parseRealmRuntimeSaveArchive>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("./helpers/legacy-command-lineage-fresh-process-child.ts", import.meta.url)), workspaceId, recordId, principalId],
    { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        assert.equal(code, 0); assert.equal(signal, null);
        const result = JSON.parse(stdout.trim());
        assert.equal(result.mode, "save"); assert.equal(result.pid, child.pid); assert.notEqual(result.pid, process.pid);
        assert.equal(result.poolsClosed, true); assert.equal(result.workspaceId, workspaceId); assert.equal(result.recordId, recordId);
        process.stdout.write(`Finance child ${result.pid}: mode=save poolsClosed=true record=${recordId}\n`);
        resolve(parseRealmRuntimeSaveArchive(Buffer.from(result.archiveBase64, "base64")));
      } catch (error) { reject(error); }
    });
  });
}

const FINANCE_WORLD_TABLES = ["worlds", "worldlines", "player_world_memberships", "asset_definitions", "skill_definitions", "effect_definitions",
  "character_definitions", "character_continuities", "character_instances", "participants", "stories", "story_definition_bindings", "story_node_instances",
  "story_unlock_ledger", "records", "record_heads", "scenes", "visibility_policies", "events", "goal_instances", "goal_assessments", "action_receipts",
  "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "outbox", "record_first_nights", "record_self_play_sessions",
  "projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups",
  "obligations", "obligation_settlements", "committed_fact_commands", "character_assets", "performance_assessments", "member_relationship_revisions"] as const;

async function financeWorldRows(owner: pg.Pool, workspaceId: string, worldId: string) {
  const rows: Record<string, unknown> = {};
  for (const table of FINANCE_WORLD_TABLES) rows[table] = (await owner.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),'[]'::jsonb) AS rows
     FROM ${table} row WHERE workspace_id=$1 AND ${table === "worlds" ? "id" : "world_id"}=$2`, [workspaceId, worldId],
  )).rows[0].rows;
  return rows;
}

// Independent test oracle: only typed Finance positions, with source inputs recorded at actual commit time.
function financeTargetRequest(request: Record<string, unknown>, ids: Record<string, ReadonlyMap<string, string>>): Record<string, unknown> {
  const map = (kind: string, value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    assert.equal(typeof value, "string"); const target = ids[kind]!.get(value as string);
    assert.ok(target, `SQL identity oracle ${kind}/${String(value)}`); return target;
  };
  const next = structuredClone(request);
  for (const [field, kind] of [["recordId", "record"], ["projectId", "project"], ["accountId", "financeAccount"],
    ["milestoneId", "milestone"], ["obligationId", "obligation"]]) {
    if (Object.hasOwn(next, field!)) next[field!] = map(kind!, next[field!]);
  }
  if (next.evidence) {
    const evidence = next.evidence as Record<string, unknown>;
    evidence.recordId = map("record", evidence.recordId); evidence.sceneId = map("scene", evidence.sceneId);
  }
  if (Array.isArray(next.actions)) next.actions = next.actions.map((action) => financeTargetRequest(action as Record<string, unknown>, ids));
  return next;
}

function financeServiceInput(request: Record<string, unknown>, scope: ProjectScope, idempotencyKey: string, memo = "unhashed settlement memo") {
  const input = { ...request, scope, idempotencyKey } as Record<string, unknown>;
  delete input.command;
  if (request.command === "finance.obligation.settled") input.memo = memo;
  if (request.evidence) {
    const { recordId, sceneId, visibility, worldTick, worldOrdinal } = request.evidence as Record<string, unknown>;
    input.evidence = { recordId, sceneId, visibility, expectedWorldCursor: { worldTick, worldOrdinal } };
  }
  return input;
}

test("F2b3 all Finance variants cross real workspaces, share anchors and retain origin through fresh saves", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000,
}, async (t) => {
  const owner = new pg.Pool({ connectionString: adminConnectionString });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString });
  t.after(async () => { await runtime.end(); await owner.end(); });
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { installSignedRealmWorldFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { seedCapabilitySessionKey, sessionProofFor } = await import("./helpers/session-proof.ts");
  const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { createInstalledRealmWorldInstantiationResolver } = await import("../modules/world-transfer/realmworld-runtime-content.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  installTestSessionSecret();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const wsA = `ws_fin_a_${suffix}`, wsB = `ws_fin_b_${suffix}`, worldA = `world_fin_a_${suffix}`;
  // A signed RealmWorld retains its exact package identity across workspaces.
  // The target World uses the same worldId, not a forged second package identity.
  const worldB = worldA, principal = `principal_fin_${suffix}`;
  const previousOperator = process.env.REALM_OPERATOR_PRINCIPALS;
  t.after(() => { if (previousOperator === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previousOperator; });
  process.env.REALM_OPERATOR_PRINCIPALS = principal;
  const directory = await mkdtemp(join(tmpdir(), "finance-signed-policy-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const pair = generateKeyPairSync("ed25519");
  const commandPolicy = {
    format: "realmworld-command-policy", schemaVersion: 1, policyVersion: "finance-fixture.v1",
    projects: [{ projectKey: "main", kind: "production", title: { en: "Finance main" }, milestones: [1, 2, 3, 4].map(i => ({ milestoneKey: `m${i}`, title: { en: `M${i}` } })) }],
    bindings: [{ bindingKey: "finance.ready", command: "confirm_milestone", projectKey: "main", milestoneKey: "m1", semanticEventKey: "finance.ready", storySelector: "genesis", recordSelector: "genesis", all: [] }],
  };
  await installSignedRealmWorldFixture({ installRoot: directory, worldId: worldA, version: "1.2.0", recordTitle: "B", commandPolicy,
    declaredEvents: ["finance.ready", "finance.other"], keyId: "finance-fixture", keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } });
  const verifier = { installRoot: directory, verifySignature: ({ manifest }: { manifest: import("../modules/world-transfer/realmworld-manifest.ts").RealmWorldManifestV1 }) => verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) };
  const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver(verifier);
  const plan = (await createInstalledRealmWorldInstantiationResolver({ ...verifier, locale: "en" })({ kind: "world", worldId: worldA, worldVersion: "1.2.0" }))!;
  const library = createPostgresLibraryService(runtime, undefined, { resolveCommandPolicy });
  for (const workspaceId of [wsA, wsB]) {
    await owner.query(`INSERT INTO workspaces (id,name) VALUES ($1,'Finance workspace')`, [workspaceId]);
    await owner.query(`INSERT INTO accounts (workspace_id,principal_id,display_name) VALUES ($1,$2,'Finance owner')`, [workspaceId, principal]);
    await seedCapabilitySessionKey(owner, workspaceId);
  }
  const source = await library.instantiateRealmWorld({ workspaceId: wsA, principalId: principal, sessionProof: sessionProofFor(principal) }, plan, "finance-source");
  await library.instantiateRealmWorld({ workspaceId: wsB, principalId: principal, sessionProof: sessionProofFor(principal) }, plan, "finance-target");
  const lineA = source.worldlineId, storyA = source.storyId;
  const scopeA = { workspaceId: wsA, worldId: worldA, worldlineId: lineA };
  const installed = (await owner.query<{ project_id: string; milestone_key: string; milestone_id: string; story_id: string; record_id: string }>(
    "SELECT project_id,milestone_key,milestone_id,story_id,record_id FROM realmworld_command_materializations WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 ORDER BY milestone_key DESC",
    [wsA, worldA, lineA])).rows;
  assert.equal(installed.length, 4);
  for (const row of installed) { assert.equal(row.story_id, storyA); assert.equal(row.record_id, source.recordId); }
  const projectA = installed.find(row => row.milestone_key === "m1")!.project_id;
  const milestones = [1, 2, 3, 4].map(i => { const row = installed.find(row => row.milestone_key === `m${i}`); assert.ok(row); assert.equal(row.project_id, projectA); return row.milestone_id; });
  const opening = (await owner.query<{ scene_id: string; id: string }>("SELECT scene_id,id FROM events WHERE workspace_id=$1 AND record_id=$2 AND record_ordinal=1", [wsA, source.recordId])).rows;
  assert.equal(opening.length, 1);
  const b = { recordId: source.recordId, sceneId: opening[0]!.scene_id, eventId: opening[0]!.id };
  await owner.query("UPDATE scenes SET title='B-main' WHERE workspace_id=$1 AND record_id=$2 AND id=$3", [wsA, b.recordId, b.sceneId]);
  await owner.query("UPDATE projects SET status='active',stage='funding' WHERE workspace_id=$1 AND id=$2", [wsA, projectA]);
  const addRecord = async (scope: ProjectScope, storyId: string, title: string, ordinal: number) => {
    const recordId = `record_fin_${title}_${suffix}`, sceneId = `scene_fin_${title}_${suffix}`, policyId = `policy_fin_${title}_${suffix}`;
    await owner.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
      VALUES ($1,$2,$3,$4,$5,$6,'active',0,$7,'primary','1.2.0')`, [scope.workspaceId, scope.worldId, scope.worldlineId, storyId, recordId, title, ordinal - 1]);
    await owner.query(`INSERT INTO scenes (workspace_id,world_id,worldline_id,record_id,id,title,status,start_tick,start_ordinal)
      VALUES ($1,$2,$3,$4,$5,$6,'active',0,$7)`, [scope.workspaceId, scope.worldId, scope.worldlineId, recordId, sceneId, `${title}-main`, ordinal - 1]);
    await owner.query(`INSERT INTO visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind)
      VALUES ($1,$2,$3,$4,$5,'opening',1,'public')`, [scope.workspaceId, scope.worldId, scope.worldlineId, recordId, policyId]);
    const eventId = `event_fin_${title}_${suffix}`;
    await owner.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,
      actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
      VALUES ($1,$2,$3,$4,$5,$6,1,1,0,'narration.committed',NULL,'','Finance opening','{}'::jsonb,$7,0,$8,'native_calendar','')`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, recordId, sceneId, eventId, policyId, ordinal]);
    await owner.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal,last_event_id,last_world_tick,last_world_ordinal)
      VALUES ($1,$2,$3,$4,1,2,$5,0,$6)`, [scope.workspaceId, scope.worldId, scope.worldlineId, recordId, eventId, ordinal]);
    await owner.query(`UPDATE worldlines SET head_tick=0,head_ordinal=$4 WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,
      [scope.workspaceId, scope.worldId, scope.worldlineId, ordinal]);
    return { recordId, sceneId, eventId };
  };
  const a = await addRecord(scopeA, storyA, "A", 2);
  const sceneOther = `scene_fin_B_other_${suffix}`;
  await owner.query(`INSERT INTO scenes (workspace_id,world_id,worldline_id,record_id,id,title,status,start_tick,start_ordinal)
    VALUES ($1,$2,$3,$4,$5,'B-other','active',0,1)`, [wsA, worldA, lineA, b.recordId, sceneOther]);
  const accountA = `account_fin_main_${suffix}`, accountOther = `account_fin_other_${suffix}`;
  await owner.query(`INSERT INTO finance_accounts (workspace_id,world_id,worldline_id,id,currency,status,opening_balance_minor)
    VALUES ($1,$2,$3,$4,'JPY','active',10000)`, [wsA, worldA, lineA, accountA]);
  const projectOther = `project_fin_other_${suffix}`;
  await owner.query(`INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version)
    VALUES ($1,$2,$3,$4,'production','active','funding',$5,'JPY',1)`, [wsA, worldA, lineA, projectOther, "Finance other"]);
  const cash = async (scope: ProjectScope, accountId: string) => Number((await owner.query(
    `SELECT (a.opening_balance_minor+COALESCE(SUM(CASE WHEN e.direction='income' THEN e.amount_minor ELSE -e.amount_minor END),0))::text AS balance
     FROM finance_accounts a LEFT JOIN ledger_entries e ON e.workspace_id=a.workspace_id AND e.world_id=a.world_id AND e.worldline_id=a.worldline_id AND e.account_id=a.id
     WHERE a.workspace_id=$1 AND a.world_id=$2 AND a.worldline_id=$3 AND a.id=$4 GROUP BY a.opening_balance_minor`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, accountId])).rows[0]!.balance);
  const evidence = async (): Promise<RecordEvidence> => {
    const row = (await owner.query(`SELECT head_tick::text,head_ordinal::text FROM worldlines WHERE workspace_id=$1 AND world_id=$2 AND id=$3`, [wsA, worldA, lineA])).rows[0];
    return evidenceFor(b.recordId, b.sceneId, { tick: Number(row.head_tick), ordinal: Number(row.head_ordinal) });
  };
  const stores = recordCommittedCalls(createPostgresProjectFinanceCommandStore(runtime, { resolveCommandPolicy }));
  const services = recordCommittedCalls(createProjectFinanceCommandService({ store: stores.proxy }));
  const finance = services.proxy;
  const ledger = async (key: string, method: "recordExpense" | "recordIncome" | "recordAdjustment", amountMinor: number, direction?: "income" | "expense") => {
    await Reflect.apply(finance[method], finance, [{ scope: scopeA, accountId: accountA, projectId: method === "recordIncome" ? null : projectA,
      recordId: method === "recordAdjustment" ? null : b.recordId, evidence: await evidence(), amountMinor, category: "studio", memo: `memo-${key}`,
      occurredAt: OCCURRED_AT, expectedBalanceMinor: await cash(scopeA, accountA), idempotencyKey: key, ...(direction ? { direction } : {}) }]);
  };
  await ledger("expense", "recordExpense", 100); await ledger("income", "recordIncome", 200);
  await ledger("adjust-in", "recordAdjustment", 50, "income"); await ledger("adjust-out", "recordAdjustment", 25, "expense");
  await finance.confirmMilestone({ scope: scopeA, projectId: projectA, milestoneId: milestones[0]!, expectedProjectVersion: 1,
    evidence: await evidence(), semanticEventKey: "finance.ready", idempotencyKey: "milestone-key" });
  await finance.confirmMilestone({ scope: scopeA, projectId: projectA, milestoneId: milestones[1]!, expectedProjectVersion: 2,
    evidence: await evidence(), idempotencyKey: "milestone-absent" });
  await finance.changeStage({ scope: scopeA, projectId: projectA, stage: "production", expectedProjectVersion: 3, evidence: await evidence(), idempotencyKey: "stage" });
  await finance.allocateBudget({ scope: scopeA, projectId: projectA, category: "studio", amountMinor: 900, expectedVersion: 0, idempotencyKey: "budget" });
  const loan = await finance.createObligation({ scope: scopeA, projectId: projectA, kind: "loan", principalMinor: 500, idempotencyKey: "loan" });
  const presale = await finance.createObligation({ scope: scopeA, projectId: null, kind: "presale", principalMinor: 300, undeliveredCount: 2, idempotencyKey: "presale" });
  const share = await finance.createObligation({ scope: scopeA, projectId: projectA, kind: "revenue_share", principalMinor: 400, shareBps: 1200, idempotencyKey: "revenue-share" });
  for (const [key, obligationId, settlementKind, amountMinor, expectedOutstandingMinor] of [
    ["repayment", loan.obligationId, "repayment", 100, 500], ["loan-draw", loan.obligationId, "draw", 50, 400],
    ["presale-draw", presale.obligationId, "draw", 30, 300], ["share", share.obligationId, "share", 20, 0],
  ] as const) await finance.settleObligation({ scope: scopeA, obligationId, settlementKind, amountMinor, expectedOutstandingMinor,
    expectedBalanceMinor: await cash(scopeA, accountA), accountId: key === "loan-draw" ? null : accountA,
    category: "funding", memo: `memo-${key}`, occurredAt: OCCURRED_AT, idempotencyKey: key });
  await finance.applyRecordProjectFinance({ scope: scopeA, evidence: await evidence(), idempotencyKey: "apply", actions: [
    { command: "change_stage", projectId: projectA, stage: "scheduled", expectedProjectVersion: 4 },
    { command: "confirm_milestone", projectId: projectA, milestoneId: milestones[2]!, expectedProjectVersion: 5 },
    { command: "record_expense", projectId: projectA, accountId: accountA, amountMinor: 40, category: "props", memo: "ordered props", occurredAt: OCCURRED_AT,
      expectedBalanceMinor: await cash(scopeA, accountA) },
  ] });
  assert.equal(await cash(scopeA, accountA), 10045);
  await owner.query(`INSERT INTO finance_accounts (workspace_id,world_id,worldline_id,id,currency,status,opening_balance_minor)
    VALUES ($1,$2,$3,$4,'JPY','active',500)`, [wsA, worldA, lineA, accountOther]);
  const fact = await createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(runtime) }).reviseRelationship({ scope: scopeA,
    sourceEventId: b.eventId, subjectEntityKey: "member:finance:a", objectEntityKey: "member:finance:b", relationKind: "trust", idempotencyKey: "mixed-fact" });
  assert.equal(fact.status, "committed");
  assert.equal(services.calls.length, 16);
  assert.deepEqual(new Set(services.calls.map((call) => call.method)), new Set(["recordExpense", "recordIncome", "recordAdjustment", "confirmMilestone", "changeStage",
    "allocateBudget", "createObligation", "settleObligation", "applyRecordProjectFinance"]));
  const originalRows = (await owner.query(`SELECT id,idempotency_key,request_fingerprint,result_manifest FROM project_finance_command_groups
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 ORDER BY id`, [wsA, worldA, lineA])).rows;
  for (const table of ["project_finance_command_groups", "committed_fact_commands"]) await owner.query(
    `UPDATE ${table} SET result_manifest=result_manifest->'result' WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsA, worldA, lineA]);
  const beforeExport = await commandAuthoritySnapshot(owner, scopeA);
  const reader = createPostgresRealmRuntimeSaveReader(runtime), restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
  const loaded = await reader.load({ workspaceId: wsA, recordId: a.recordId, principalId: principal, purpose: "whole-closure-backup" as const });
  assert.ok(loaded?.domain);
  assert.deepEqual(await commandAuthoritySnapshot(owner, scopeA), beforeExport);
  const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded));
  assert.deepEqual(archive.domain!.commandReplayContexts!.map((context) => context.family).sort(), ["fact", "finance"]);
  assert.equal(archive.domain!.records.length, 1); assert.equal(archive.domain!.records[0]!.recordId, b.recordId);
  const origin = archive.domain!.commandReplayContexts!.find((context) => context.family === "finance")!;
  const originalRequests = new Map(stores.calls.map((call) => [call.input.idempotencyKey as string, call.input.request as Record<string, unknown>]));
  const sourceRequestRows = await commandAuthoritySnapshot(owner, scopeA);
  const first = await restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive,
    recordTitle: "A", idempotencyKey: `finance-first-${suffix}` });
  assert.deepEqual(await commandAuthoritySnapshot(owner, scopeA), sourceRequestRows, "actual two-workspace restore leaves source authority bytes unchanged");
  const replayRound = async (worldlineId: string, primaryRecordId: string) => {
    const scope = { workspaceId: wsB, worldId: worldB, worldlineId };
    const current = await reader.load({ workspaceId: wsB, recordId: primaryRecordId, principalId: principal, purpose: "whole-closure-backup" as const }); assert.ok(current?.domain);
    const context = current.domain.commandReplayContexts!.find((item) => item.family === "finance")!;
    assert.deepEqual(context.originScope, scopeA); assert.deepEqual(context.currentScope, scope);
    assert.deepEqual(current.domain.commandReplayContexts!.map((item) => item.family).sort(), ["fact", "finance"]);
    const records = (await owner.query(`SELECT id,title FROM records WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const scenes = (await owner.query(`SELECT id,title,record_id FROM scenes WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const projects = (await owner.query(`SELECT id,title FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const accounts = (await owner.query(`SELECT id,opening_balance_minor::text FROM finance_accounts WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const targetMilestones = (await owner.query(`SELECT id,title FROM project_milestones WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const obligations = (await owner.query(`SELECT id,kind,outstanding_minor::text,share_bps,undelivered_count FROM obligations WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows;
    const byTitle = (rows: typeof records, title: string) => { const row = rows.find((row) => row.title === title); assert.ok(row); return row.id as string; };
    const recordMap = new Map<string, string>();
    for (const [sourceId, title] of [[a.recordId, "A"], [b.recordId, "B"]]) {
      const target = records.find((row) => row.title === title); if (target) recordMap.set(sourceId!, target.id);
    }
    const sceneMap = new Map<string, string>();
    for (const [sourceId, title] of [[a.sceneId, "A-main"], [b.sceneId, "B-main"], [sceneOther, "B-other"]]) {
      const target = scenes.find((row) => row.title === title); if (target) sceneMap.set(sourceId!, target.id);
    }
    const ids: Record<string, Map<string, string>> = {
      record: recordMap, scene: sceneMap,
      project: new Map([[projectA, byTitle(projects, "Finance main")], [projectOther, byTitle(projects, "Finance other")]]),
      financeAccount: new Map([[accountA, accounts.find((row) => row.opening_balance_minor === "10000")!.id], [accountOther, accounts.find((row) => row.opening_balance_minor === "500")!.id]]),
      milestone: new Map(milestones.map((id, index) => [id, byTitle(targetMilestones, `M${index + 1}`)])),
      obligation: new Map([[loan.obligationId, obligations.find((row) => row.kind === "loan")!.id],
        [presale.obligationId, obligations.find((row) => row.kind === "presale")!.id], [share.obligationId, obligations.find((row) => row.kind === "revenue_share")!.id]]),
    };
    const targetB = ids.record!.get(b.recordId)!;
    assert.equal(await cash(scope, ids.financeAccount!.get(accountA)!), 10045);
    assert.deepEqual(obligations.map((row) => [row.kind, Number(row.outstanding_minor)]).sort(), [["loan", 400], ["presale", 300], ["revenue_share", 0]]);
    assert.equal((await owner.query(`SELECT count(*)::integer AS n FROM ledger_entries WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, worldlineId])).rows[0].n, 9);
    const rows = (await owner.query(`SELECT id,idempotency_key,request_fingerprint,state,policy_version,result_manifest FROM project_finance_command_groups
      WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 ORDER BY id`, [wsB, worldB, worldlineId])).rows;
    const legacy = rows.filter((row) => row.result_manifest.provenance === "legacy-result-v1"); assert.equal(legacy.length, 16);
    const anchors = legacy.filter((row) => Object.hasOwn(row.result_manifest, "replayContext")); assert.equal(anchors.length, 1);
    const anchor = anchors[0]!; assert.equal(anchor.id, legacy.map((row) => row.id).sort()[0]);
    for (const row of legacy) {
      assert.equal(row.result_manifest.request, null); assert.equal(row.result_manifest.replayLineage.anchorCommandId, anchor.id);
      assert.equal(row.result_manifest.replayLineage.originalRequestFingerprint, originalRows.find((original) => original.idempotency_key === row.idempotency_key)!.request_fingerprint);
      assert.equal(row.result_manifest.result.commandGroupId, row.id);
      const beforeLoad = await commandAuthoritySnapshot(owner, scope);
      const loaded = await createPostgresProjectFinanceCommandStore(runtime).loadCommand(scope, row.idempotency_key);
      assert.deepEqual(await commandAuthoritySnapshot(owner, scope), beforeLoad);
      const receipt = row.result_manifest.result;
      for (const [field, table] of [["projectId", "projects"], ["milestoneId", "project_milestones"], ["obligationId", "obligations"]]) {
        if (typeof receipt[field!] !== "string") continue;
        assert.equal((await owner.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=$4`,
          [wsB, worldB, worldlineId, receipt[field!]])).rowCount, 1, `stored result ${field} is an actual target row`);
      }
      if (receipt.entry) {
        const entry = receipt.entry;
        assert.deepEqual([entry.workspaceId, entry.worldId, entry.worldlineId], [wsB, worldB, worldlineId]);
        const actualEntry = (await owner.query(`SELECT id,account_id,project_id,source_record_id,amount_minor::text,direction
          FROM ledger_entries WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=$4`, [wsB, worldB, worldlineId, entry.id])).rows[0];
        assert.ok(actualEntry); assert.equal(actualEntry.account_id, entry.accountId); assert.equal(actualEntry.project_id, entry.projectId);
        assert.equal(actualEntry.source_record_id, entry.recordId); assert.equal(Number(actualEntry.amount_minor), entry.amountMinor); assert.equal(actualEntry.direction, entry.direction);
      }
      assert.equal(loaded?.replayProof?.context.id, anchor.result_manifest.replayContext.id);
      assert.equal(loaded?.state, "committed"); assert.equal(loaded?.policyVersion, "project-finance-command.v1");
    }
    for (const modern of rows.filter((row) => row.result_manifest.provenance !== "legacy-result-v1")) {
      assert.equal(modern.result_manifest.replayLineage, undefined); assert.equal(modern.result_manifest.replayContext, undefined);
      assert.equal(modern.request_fingerprint, projectFinanceCommandFingerprintFor(scope, modern.result_manifest.request));
      assert.equal(modern.id, projectFinanceCommandGroupIdFor(scope, modern.idempotency_key, modern.request_fingerprint));
    }
    const store: ProjectFinanceCommandStore = createPostgresProjectFinanceCommandStore(runtime);
    const service = createProjectFinanceCommandService({ store });
    const noWrites = async (action: () => Promise<unknown>, code?: string) => {
      const before = await commandAuthoritySnapshot(owner, scope);
      let result: unknown;
      if (code) await assert.rejects(action, { code });
      else { result = await action(); assert.equal((result as { status: string }).status, "replayed"); }
      assert.deepEqual(await commandAuthoritySnapshot(owner, scope), before);
      return result;
    };
    for (const modern of rows.filter((row) => row.result_manifest.provenance !== "legacy-result-v1")) {
      await noWrites(() => service.allocateBudget(financeServiceInput(modern.result_manifest.request, scope, modern.idempotency_key) as never));
    }
    const targetRequests = new Map<string, Record<string, unknown>>();
    const directInputs = new Map<string, Record<string, unknown>>();
    for (const call of services.calls) {
      const key = call.input.idempotencyKey as string;
      const request = financeTargetRequest(originalRequests.get(key)!, ids); targetRequests.set(key, request);
      const input = financeServiceInput(request, scope, key, call.input.memo as string | undefined);
      const result = await noWrites(() => Reflect.apply(service[call.method as keyof typeof service], service, [input]));
      assert.equal((result as { commandGroupId: string }).commandGroupId, rows.find((row) => row.idempotency_key === key)!.id);
      assert.deepEqual(result, { ...rows.find((row) => row.idempotency_key === key)!.result_manifest.result, status: "replayed" });
      const storedCall = stores.calls.find((item) => item.input.idempotencyKey === key)!;
      const direct = { ...financeTargetRequest(storedCall.input, ids), scope, commandGroupId: rows.find((row) => row.idempotency_key === key)!.id,
        request, requestFingerprint: projectFinanceCommandFingerprintFor(scope, request as { command: string }) };
      directInputs.set(key, direct);
      await noWrites(() => Reflect.apply(store[storedCall.method as keyof typeof store], store, [direct]));
      let reachedStore = 0;
      const mutations = new Set(["commitExpense", "commitLedger", "confirmMilestone", "changeStage", "allocateBudget", "createObligation", "settleObligation", "applyRecordProjectFinance"]);
      const missStore = new Proxy(store, { get(object, property) {
        if (property === "loadCommand") return async () => null;
        const method = Reflect.get(object, property);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => { if (mutations.has(String(property))) reachedStore++; return Reflect.apply(method, object, args); };
      } });
      const missed = createProjectFinanceCommandService({ store: missStore });
      const ledgerMethod = ["recordExpense", "recordIncome", "recordAdjustment"].includes(call.method);
      await noWrites(() => Reflect.apply(missed[call.method as keyof typeof missed], missed, [input]), ledgerMethod ? "WRITE_CONFLICT" : undefined);
      assert.equal(reachedStore, ledgerMethod ? 0 : 1, "forced miss never overrides original optimistic balance validation");
      const original = originalRows.find((row) => row.idempotency_key === key)!;
      assert.equal(rows.find((row) => row.idempotency_key === key)!.request_fingerprint, original.request_fingerprint);
      await noWrites(() => Reflect.apply(store[storedCall.method as keyof typeof store], store, [{ ...direct, requestFingerprint: original.request_fingerprint }]), "IDEMPOTENCY_KEY_REUSE");
    }
    const targetOpening = (await owner.query(`SELECT id FROM events WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND record_ordinal=1`, [wsB, worldB, worldlineId, targetB])).rows[0].id;
    await noWrites(() => createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(runtime) }).reviseRelationship({ scope,
      sourceEventId: targetOpening, subjectEntityKey: "member:finance:a", objectEntityKey: "member:finance:b", relationKind: "trust", idempotencyKey: "mixed-fact" }));
    t.diagnostic(`Finance SQL round: workspace=${wsB} worldline=${worldlineId} legacy=16 anchors=1 peers=15 cash=10045 sourceWorkspace=${wsA}; forced-miss ledger=4 WRITE_CONFLICT before store, other variants=12 replayed`);
    return { scope, current, ids, targetB, rows, legacy, anchor, store, service, noWrites, targetRequests, directInputs };
  };
  const round1 = await replayRound(first.worldlineId, first.recordId);
  const beforeBSave = await commandAuthoritySnapshot(owner, round1.scope);
  const bArchive = await financeSaveChild(wsB, round1.targetB,principal);
  assert.deepEqual(await commandAuthoritySnapshot(owner, round1.scope), beforeBSave);
  assert.equal(bArchive.domain!.records.length, 0, "unrelated A is omitted instead of being exported to preserve historical maps");
  assert.deepEqual(bArchive.domain!.commandReplayContexts!.find((context) => context.family === "finance")!.identities.record.map(([id]) => id), [round1.targetB]);
  const second = await restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive: bArchive,
    recordTitle: "B", idempotencyKey: `finance-second-${suffix}` });
  const secondScope = { workspaceId: wsB, worldId: worldB, worldlineId: second.worldlineId };
  const c = await addRecord(secondScope, second.storyId, "C", 100);
  const modern = await createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(runtime) }).allocateBudget({ scope: secondScope,
    projectId: (await owner.query(`SELECT id FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND title='Finance main'`, [wsB, worldB, second.worldlineId])).rows[0].id,
    category: "modern-new", amountMinor: 77, expectedVersion: 0, idempotencyKey: "modern-after-restore" });
  assert.equal(modern.status, "committed");
  const round2 = await replayRound(second.worldlineId, second.recordId);
  const beforeCSave = await commandAuthoritySnapshot(owner, round2.scope);
  const cArchive = await financeSaveChild(wsB, c.recordId,principal);
  assert.deepEqual(await commandAuthoritySnapshot(owner, round2.scope), beforeCSave);
  const projected = cArchive.domain!.commandReplayContexts!.find((context) => context.family === "finance")!;
  assert.deepEqual(projected.originScope, origin.originScope);
  assert.equal(projected.identities.record.length, 2);
  assert.ok(projected.identities.record.some(([id, original]) => id === c.recordId && original === null));
  assert.ok(projected.identities.scene.some(([id, original]) => id === c.sceneId && original === null));
  assert.equal(cArchive.domain!.records.length, 1);
  const third = await restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive: cArchive,
    recordTitle: "C", idempotencyKey: `finance-third-${suffix}` });
  const round3 = await replayRound(third.worldlineId, third.recordId);
  assert.equal(round3.current.domain!.commandReplayContexts!.find((context) => context.family === "finance")!.identities.record.filter(([, original]) => original === null).length, 1);

  // Full canonical mutations use actual SQL-mapped alternatives; each gate gets its own sixteen-table snapshot.
  for (const round of [round1, round2]) {
    const request = round.targetRequests.get("expense")!;
    await round.noWrites(() => round.service.recordExpense(financeServiceInput({ ...request, amountMinor: 101 }, round.scope, "expense") as never), "IDEMPOTENCY_KEY_REUSE");
  }
  const mutate = async (key: string, request: Record<string, unknown>) => {
    const call = services.calls.find((call) => call.input.idempotencyKey === key)!;
    const storedCall = stores.calls.find((call) => call.input.idempotencyKey === key)!;
    await round3.noWrites(() => Reflect.apply(round3.service[call.method as keyof typeof round3.service], round3.service,
      [financeServiceInput(request, round3.scope, key, call.input.memo as string | undefined)]), "IDEMPOTENCY_KEY_REUSE");
    const direct = { ...round3.directInputs.get(key), ...request, request };
    for (const requestFingerprint of [projectFinanceCommandFingerprintFor(round3.scope, request as { command: string }), originalRows.find((row) => row.idempotency_key === key)!.request_fingerprint]) {
      await round3.noWrites(() => Reflect.apply(round3.store[storedCall.method as keyof typeof round3.store], round3.store,
        [{ ...direct, requestFingerprint }]), "IDEMPOTENCY_KEY_REUSE");
    }
  };
  let changedCandidates = 0;
  for (const [key, request] of round3.targetRequests) {
    const variants: Record<string, unknown>[] = [];
    for (const field of ["amountMinor", "category", "memo", "occurredAt", "expectedBalanceMinor", "expectedProjectVersion", "expectedVersion", "expectedOutstandingMinor", "principalMinor", "shareBps", "undeliveredCount"]) {
      const value = request[field];
      if (value === null || value === undefined || (field === "undeliveredCount" && request.kind !== "presale")) continue;
      const changed = field === "occurredAt" ? "2026-10-17T00:00:00.000Z" : typeof value === "number" ? value + 1 : `${String(value)} changed`;
      variants.push({ ...request, [field]: changed });
    }
    if (request.command === "finance.adjustment.recorded") variants.push({ ...request, direction: request.direction === "income" ? "expense" : "income" });
    if (request.command === "finance.obligation.created") variants.push({ ...request, kind: request.kind === "loan" ? "presale" : "loan", shareBps: null, undeliveredCount: 0 });
    if (request.command === "project.stage.changed") variants.push({ ...request, stage: request.stage === "planning" ? "production" : "planning" });
    for (const [field, namespace, alternative] of [
      ["accountId", "financeAccount", accountOther], ["projectId", "project", projectOther], ["milestoneId", "milestone", milestones[3]],
      ["obligationId", "obligation", request.obligationId === round3.ids.obligation!.get(loan.obligationId) ? presale.obligationId : loan.obligationId],
    ]) {
      if (Object.hasOwn(request, field!) && request[field!] !== round3.ids[namespace!]!.get(alternative!)) variants.push({ ...request, [field!]: round3.ids[namespace!]!.get(alternative!)! });
    }
    if (Object.hasOwn(request, "recordId")) variants.push({ ...request, recordId: request.recordId === null ? round3.targetB : third.recordId });
    if (request.command === "project.milestone.confirmed") {
      const absent = { ...request }; delete absent.semanticEventKey;
      if (Object.hasOwn(request, "semanticEventKey")) variants.push(absent);
      variants.push({ ...request, semanticEventKey: request.semanticEventKey === "finance.ready" ? "finance.other" : "finance.ready" });
    }
    if (Object.hasOwn(request, "evidence")) {
      if (request.evidence) {
        const ev = request.evidence as Record<string, unknown>;
        variants.push({ ...request, evidence: null },
          { ...request, evidence: { ...ev, recordId: third.recordId } },
          { ...request, evidence: { ...ev, sceneId: round3.ids.scene!.get(sceneOther) } },
          { ...request, evidence: { ...ev, visibility: "restricted" } },
          { ...request, evidence: { ...ev, worldTick: Number(ev.worldTick) + 1 } },
          { ...request, evidence: { ...ev, worldOrdinal: Number(ev.worldOrdinal) + 1 } });
      } else variants.push({ ...request, evidence: { recordId: round3.targetB, sceneId: round3.ids.scene!.get(b.sceneId), visibility: "public", worldTick: 0, worldOrdinal: 2 } });
    }
    if (Array.isArray(request.actions)) {
      const actions = request.actions as Record<string, unknown>[];
      variants.push({ ...request, actions: [...actions].reverse() }, { ...request, actions: actions.slice(0, 2) },
        { ...request, actions: [...actions, actions[0]] },
        { ...request, actions: [{ command: "confirm_milestone", projectId: round3.ids.project!.get(projectA), milestoneId: round3.ids.milestone!.get(milestones[3]!), expectedProjectVersion: 4 }, ...actions.slice(1)] });
      for (const [index, field, value] of [
        [0, "expectedProjectVersion", 5], [1, "milestoneId", round3.ids.milestone!.get(milestones[3]!)],
        [2, "amountMinor", 41], [2, "category", "different"], [2, "memo", "different"], [2, "occurredAt", "2026-10-17T00:00:00.000Z"],
        [2, "expectedBalanceMinor", 999], [2, "accountId", round3.ids.financeAccount!.get(accountOther)], [2, "projectId", round3.ids.project!.get(projectOther)],
      ] as const) variants.push({ ...request, actions: actions.map((action, i) => i === index ? { ...action, [field]: value } : action) });
    }
    const seen = new Set<string>();
    for (const variant of variants) {
      const json = JSON.stringify(variant); if (seen.has(json) || json === JSON.stringify(request)) continue; seen.add(json);
      await mutate(key, variant); changedCandidates++;
    }
    const storedCall = stores.calls.find((call) => call.input.idempotencyKey === key)!;
    const wrongOperation = { ...request, command: request.command === "finance.expense.recorded" ? "finance.income.recorded" : "finance.expense.recorded" };
    await round3.noWrites(() => Reflect.apply(round3.store[storedCall.method as keyof typeof round3.store], round3.store,
      [{ ...round3.directInputs.get(key), request: wrongOperation, requestFingerprint: projectFinanceCommandFingerprintFor(round3.scope, wrongOperation) }]), "IDEMPOTENCY_KEY_REUSE");
    if (storedCall.method === "commitLedger") {
      await round3.noWrites(() => round3.store.commitLedger({ ...round3.directInputs.get(key),
        eventKind: request.command === "finance.income.recorded" ? "finance.adjustment.recorded" : "finance.income.recorded" } as never), "IDEMPOTENCY_KEY_REUSE");
    }
  }
  // A changed *known* carried Record also refuses; the first archive still carried A's non-null origin.
  const firstExpense = round1.targetRequests.get("expense")!;
  await round1.noWrites(() => round1.service.recordExpense(financeServiceInput({ ...firstExpense,
    recordId: first.recordId, evidence: { ...(firstExpense.evidence as Record<string, unknown>), recordId: first.recordId } }, round1.scope, "expense") as never), "IDEMPOTENCY_KEY_REUSE");
  const settlement = round3.targetRequests.get("repayment")!;
  await round3.noWrites(() => round3.service.settleObligation(financeServiceInput(settlement, round3.scope, "repayment", "a changed memo intentionally stays unhashed") as never));
  await round3.noWrites(() => round3.store.settleObligation({ ...round3.directInputs.get("repayment"), memo: "direct changed memo stays unhashed" } as never));
  t.diagnostic(`Finance canonical changed candidates=${changedCandidates}; each checked by service plus direct recheck with both target and source supplied fingerprints; settlement memo omission preserved`);

  // Same-table/same-scope anchor checks, including independently rehashed semantic metadata.
  const peer = round3.legacy.find((row) => row.id !== round3.anchor.id)!;
  const anchorManifest = structuredClone(round3.anchor.result_manifest), peerManifest = structuredClone(peer.result_manifest);
  const sourceFinanceAnchor = round1.anchor.id;
  const factAnchor = (await owner.query(`SELECT id FROM committed_fact_commands WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [wsB, worldB, third.worldlineId])).rows[0].id;
  const tamperCases = [
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: "missing" } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: sourceFinanceAnchor } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: originalRows[0]!.id } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, anchorCommandId: factAnchor } } },
    { id: round3.anchor.id, manifest: { ...anchorManifest, replayLineage: { ...anchorManifest.replayLineage, anchorCommandId: peer.id } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, contextId: "0".repeat(64) } } },
    { id: peer.id, manifest: { ...peerManifest, replayLineage: { ...peerManifest.replayLineage, originalRequestFingerprint: "0".repeat(64) } } },
    { id: round3.anchor.id, manifest: { ...anchorManifest, replayContext: { ...anchorManifest.replayContext, id: "0".repeat(64) } } },
    { id: peer.id, manifest: { ...peerManifest, provenance: "request-result-v1" } },
    { id: peer.id, manifest: { ...peerManifest, replayContext: anchorManifest.replayContext } },
    { id: peer.id, manifest: { ...peerManifest, result: { ...peerManifest.result, commandGroupId: round3.anchor.id } } },
  ];
  const peerServiceCall = services.calls.find((call) => call.input.idempotencyKey === peer.idempotency_key)!;
  const peerInput = financeServiceInput(round3.targetRequests.get(peer.idempotency_key)!, round3.scope, peer.idempotency_key, peerServiceCall.input.memo as string | undefined);
  const rejectPeer = async () => {
    await round3.noWrites(() => Reflect.apply(round3.service[peerServiceCall.method as keyof typeof round3.service], round3.service, [peerInput]), "IDEMPOTENCY_KEY_REUSE");
    const before = await commandAuthoritySnapshot(owner, round3.scope);
    await assert.rejects(reader.load({ workspaceId: wsB, recordId: third.recordId, principalId: principal, purpose: "whole-closure-backup" as const }), { code: "RUNTIME_SAVE_INVALID" });
    assert.deepEqual(await commandAuthoritySnapshot(owner, round3.scope), before);
  };
  for (const tamper of tamperCases) {
    await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [wsB, tamper.id, JSON.stringify(tamper.manifest)]);
    await rejectPeer();
    await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
      [wsB, tamper.id, JSON.stringify(tamper.id === peer.id ? peerManifest : anchorManifest)]);
  }
  for (const targetRow of [peer, round3.anchor]) for (const patch of [{ state: "rejected", rejection: "TEST_REJECTED", policy: "project-finance-command.v1", hash: targetRow.request_fingerprint },
    { state: "committed", rejection: null, policy: "unsupported-policy", hash: targetRow.request_fingerprint },
    { state: "committed", rejection: null, policy: "project-finance-command.v1", hash: "0".repeat(64) }]) {
    await owner.query(`UPDATE project_finance_command_groups SET state=$3,rejection_code=$4,policy_version=$5,request_fingerprint=$6 WHERE workspace_id=$1 AND id=$2`,
      [wsB, targetRow.id, patch.state, patch.rejection, patch.policy, patch.hash]);
    await rejectPeer();
    await owner.query(`UPDATE project_finance_command_groups SET state='committed',rejection_code=NULL,policy_version='project-finance-command.v1',request_fingerprint=$3
      WHERE workspace_id=$1 AND id=$2`, [wsB, targetRow.id, targetRow.request_fingerprint]);
  }
  const contextBody = { ...anchorManifest.replayContext }; delete contextBody.id;
  const contextVariants = [
    createReplayContext({ ...contextBody, currentScope: { ...contextBody.currentScope, workspaceId: wsA } }),
    createReplayContext({ ...contextBody, family: "fact", identities: { ...contextBody.identities, scene: [], project: [], financeAccount: [], milestone: [], obligation: [] } }),
    createReplayContext({ ...contextBody, identities: { ...contextBody.identities,
      financeAccount: contextBody.identities.financeAccount.map(([id, origin]: [string, string | null]) => [id, origin === accountA ? null : origin]) } }),
  ];
  for (const context of contextVariants) {
    for (const row of round3.legacy) {
      const manifest = structuredClone(row.result_manifest); manifest.replayLineage.contextId = context.id;
      if (row.id === round3.anchor.id) manifest.replayContext = context;
      await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [wsB, row.id, JSON.stringify(manifest)]);
    }
    await round3.noWrites(() => round3.service.recordExpense(financeServiceInput(round3.targetRequests.get("expense")!, round3.scope, "expense") as never), "IDEMPOTENCY_KEY_REUSE");
    if (context.family === "finance" && context.currentScope.workspaceId === wsB) {
      await round3.noWrites(() => round3.service.allocateBudget(financeServiceInput(round3.targetRequests.get("budget")!, round3.scope, "budget") as never));
      const before = await commandAuthoritySnapshot(owner, round3.scope);
      const unknownExport = await reader.load({ workspaceId: wsB, recordId: third.recordId, principalId: principal, purpose: "whole-closure-backup" as const });
      assert.ok(unknownExport!.domain!.commandReplayContexts!.find((item) => item.family === "finance")!.identities.financeAccount.some(([, original]) => original === null));
      assert.deepEqual(await commandAuthoritySnapshot(owner, round3.scope), before);
    } else {
      const before = await commandAuthoritySnapshot(owner, round3.scope);
      await assert.rejects(reader.load({ workspaceId: wsB, recordId: third.recordId, principalId: principal, purpose: "whole-closure-backup" as const }), { code: "RUNTIME_SAVE_INVALID" });
      assert.deepEqual(await commandAuthoritySnapshot(owner, round3.scope), before);
    }
    for (const row of round3.legacy) await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb WHERE workspace_id=$1 AND id=$2`, [wsB, row.id, JSON.stringify(row.result_manifest)]);
  }
  // Unsupported/rejected old receipts without recognized proof stay exportable, without acquiring lineage.
  for (const mode of ["policy", "rejected"] as const) {
    const manifest = structuredClone(peerManifest); delete manifest.replayLineage;
    await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb,state=$4,rejection_code=$5,policy_version=$6 WHERE workspace_id=$1 AND id=$2`,
      [wsB, peer.id, JSON.stringify(manifest), mode === "rejected" ? "rejected" : "committed", mode === "rejected" ? "TEST" : null,
        mode === "policy" ? "unsupported-policy" : "project-finance-command.v1"]);
    const before = await commandAuthoritySnapshot(owner, round3.scope);
    const carried = await reader.load({ workspaceId: wsB, recordId: third.recordId, principalId: principal, purpose: "whole-closure-backup" as const }); assert.ok(carried?.domain);
    const carriedPeer = carried.domain.financeCommandGroups.find((group) => group.id === peer.id)!;
    assert.equal(carriedPeer.replayLineage, undefined); assert.equal(carriedPeer.request, null);
    parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(carried));
    assert.deepEqual(await commandAuthoritySnapshot(owner, round3.scope), before);
    await owner.query(`UPDATE project_finance_command_groups SET result_manifest=$3::jsonb,state='committed',rejection_code=NULL,policy_version='project-finance-command.v1'
      WHERE workspace_id=$1 AND id=$2`, [wsB, peer.id, JSON.stringify(peerManifest)]);
  }

  const rehashArchive = (value: ReturnType<typeof parseRealmRuntimeSaveArchive>) => {
    const { manifest, ...parts } = value;
    return { ...value, manifest: realmRuntimeSaveManifestFromData({ ...parts,
      engineApi: manifest.engineApi, mode: manifest.mode, world: manifest.world, scope: manifest.scope }) };
  };
  // Independent digest encoder also allows a correctly hashed but structurally noninjective test body.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const sourceContextBody = { ...origin }; Reflect.deleteProperty(sourceContextBody, "id");
  const withFinanceContext = (context: typeof origin, domain = archive.domain!) => ({ ...archive, domain: { ...domain,
    commandReplayContexts: [...domain.commandReplayContexts!.filter((context) => context.family !== "finance"), context].sort((a, b) => a.id < b.id ? -1 : 1),
    financeCommandGroups: domain.financeCommandGroups.map((group) => group.replayLineage
      ? { ...group, replayLineage: { ...group.replayLineage, contextId: context.id } } : group),
  } });
  const hole = createReplayContext({ ...sourceContextBody, identities: { ...origin.identities, scene: origin.identities.scene.slice(1) } });
  const extra = createReplayContext({ ...sourceContextBody, identities: { ...origin.identities,
    project: [...origin.identities.project, ["zz_private_project", "zz_private_project"]] } });
  const duplicateOriginBody = { ...sourceContextBody, identities: { ...origin.identities,
    project: origin.identities.project.map(([id]) => [id, origin.identities.project[0]![1]] as const) } };
  const duplicateOrigin = { ...duplicateOriginBody, id: createHash("sha256").update(`realm-command-lineage-context:v1\0${canonical(duplicateOriginBody)}`).digest("hex") } as typeof origin;
  const factContext = archive.domain!.commandReplayContexts!.find((context) => context.family === "fact")!;
  const archivedGroup = archive.domain!.financeCommandGroups[0]!;
  const patchGroup = (patch: Record<string, unknown>) => ({ ...archive, domain: { ...archive.domain!, financeCommandGroups: [
    { ...archivedGroup, ...patch }, ...archive.domain!.financeCommandGroups.slice(1),
  ] } });
  const orphan = createReplayContext({ ...sourceContextBody, originScope: { ...origin.originScope, worldlineId: "unreferenced_history" } });
  const archiveCases = [withFinanceContext(hole), withFinanceContext(extra), withFinanceContext(duplicateOrigin),
    { ...archive, manifest: { ...archive.manifest, scope: { ...archive.manifest.scope, workspaceId: wsB } } },
    patchGroup({ state: "rejected", rejectionCode: "TEST" }), patchGroup({ policyVersion: "unsupported-policy" }),
    patchGroup({ provenance: "request-result-v1", request: originalRequests.get(archivedGroup.idempotencyKey) }),
    patchGroup({ replayLineage: { ...archivedGroup.replayLineage, contextId: factContext.id } }),
    patchGroup({ replayLineage: { ...archivedGroup.replayLineage, contextId: "0".repeat(64) } }),
    patchGroup({ replayLineage: { ...archivedGroup.replayLineage, anchorCommandId: "not-an-archive-field" } }),
    patchGroup({ resultManifest: { ...archivedGroup.resultManifest, commandGroupId: "foreign-command" } }),
    { ...archive, domain: { ...archive.domain!, commandReplayContexts: [...archive.domain!.commandReplayContexts!, orphan].sort((a, b) => a.id < b.id ? -1 : 1) } },
    { ...archive, domain: { ...archive.domain!, financeCommandGroups: archive.domain!.financeCommandGroups.map((group, i) => i === 1 ? { ...group, idempotencyKey: archivedGroup.idempotencyKey } : group) } },
  ] as ReturnType<typeof parseRealmRuntimeSaveArchive>[];
  for (const [index, bad] of archiveCases.entries()) {
    const before = await financeWorldRows(owner, wsB, worldB);
    await assert.rejects(restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive: bad,
      idempotencyKey: `finance-invalid-${suffix}-${index}` }), { code: "RUNTIME_SAVE_INVALID" });
    assert.deepEqual(await financeWorldRows(owner, wsB, worldB), before);
    assert.throws(() => buildRealmRuntimeSaveArchive(bad));
    const files = unzipSync(buildRealmRuntimeSaveArchive(archive)); files["runtime/domain.json"] = Buffer.from(JSON.stringify(bad.domain));
    const manifest = structuredClone(bad.manifest);
    manifest.snapshot.runtimeHash = computeRealmRuntimeSaveContentHash(new Map(Object.entries(files).filter(([path]) => path !== "realm-save-manifest.json")));
    files["realm-save-manifest.json"] = Buffer.from(JSON.stringify(manifest));
    const ordered = Object.fromEntries(["realm-save-manifest.json", ...Object.keys(files).filter((path) => path !== "realm-save-manifest.json")].map((path) => [path, files[path]!]));
    assert.throws(() => parseRealmRuntimeSaveArchive(zipSync(ordered)), "valid outer hash cannot repair imported map/ref/state/policy errors");
  }

  // Existing Finance JSONB row bound is a separate, smaller capacity boundary than the pure 64MiB budget.
  const constraints = (await owner.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='project_finance_command_groups'::regclass AND contype='c'`)).rows;
  assert.ok(constraints.some((row) => row.definition.includes("octet_length") && row.definition.includes("65536")));
  const extraProjects = Array.from({ length: 300 }, (_, i) => ({ ...archive.domain!.projects[0]!, id: `finance_wide_${String(i).padStart(3, "0")}_${"x".repeat(210)}`, title: `Wide ${i}` }));
  const wideContext = createReplayContext({ ...sourceContextBody, identities: { ...origin.identities,
    project: [...origin.identities.project, ...extraProjects.map((project) => [project.id, project.id])].sort(([a], [b]) => a! < b! ? -1 : 1) } });
  const wide = rehashArchive(withFinanceContext(wideContext, { ...archive.domain!, projects: [...archive.domain!.projects, ...extraProjects] }));
  const wideBytes = buildRealmRuntimeSaveArchive(wide); parseRealmRuntimeSaveArchive(wideBytes);
  const beforeWide = await financeWorldRows(owner, wsB, worldB);
  await assert.rejects(restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive: wide,
    idempotencyKey: `finance-existing-row-limit-${suffix}` }), { code: "RUNTIME_SAVE_INVALID", message: "Runtime Finance receipt exceeds the existing database row byte limit." });
  assert.deepEqual(await financeWorldRows(owner, wsB, worldB), beforeWide);
  t.diagnostic(`Finance existing JSONB text limit=65536; structurally valid ${extraProjects.length}-extra-project archive rejects before writes; source Finance context bytes=${Buffer.byteLength(JSON.stringify(wideContext))}; no large live receipt claim`);

  // Missing older lineage can only seed the immediate scope, never recover the earlier WS-A hash.
  const lost = structuredClone(round3.current);
  lost.domain!.commandReplayContexts = lost.domain!.commandReplayContexts!.filter((context) => context.family !== "finance");
  for (const group of lost.domain!.financeCommandGroups) delete group.replayLineage;
  const lostArchive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(rehashArchive(lost)));
  const beforeLost = await commandAuthoritySnapshot(owner, round3.scope);
  const lostTarget = await restorer.restore({ workspaceId: wsB, principalId: principal, targetWorldId: worldB, archive: lostArchive,
    recordTitle: "C", idempotencyKey: `finance-lost-origin-${suffix}` });
  assert.deepEqual(await commandAuthoritySnapshot(owner, round3.scope), beforeLost);
  const lostScope = { workspaceId: wsB, worldId: worldB, worldlineId: lostTarget.worldlineId };
  const lostRecord = (await owner.query(`SELECT id FROM records WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND title='B'`, [wsB, worldB, lostTarget.worldlineId])).rows[0].id;
  const lostScene = (await owner.query(`SELECT id FROM scenes WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND title='B-main'`, [wsB, worldB, lostTarget.worldlineId, lostRecord])).rows[0].id;
  const lostAccount = (await owner.query(`SELECT id FROM finance_accounts WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND opening_balance_minor=10000`, [wsB, worldB, lostTarget.worldlineId])).rows[0].id;
  const lostProject = (await owner.query(`SELECT id FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND title='Finance main'`, [wsB, worldB, lostTarget.worldlineId])).rows[0].id;
  const lostRequest = { ...round3.targetRequests.get("expense")!, accountId: lostAccount, projectId: lostProject, recordId: lostRecord,
    evidence: { ...(round3.targetRequests.get("expense")!.evidence as Record<string, unknown>), recordId: lostRecord, sceneId: lostScene } };
  const lostStore = createPostgresProjectFinanceCommandStore(runtime), lostService = createProjectFinanceCommandService({ store: lostStore });
  const beforeLostReplay = await commandAuthoritySnapshot(owner, lostScope);
  await assert.rejects(lostService.recordExpense(financeServiceInput(lostRequest, lostScope, "expense") as never), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.deepEqual(await commandAuthoritySnapshot(owner, lostScope), beforeLostReplay);
  const loadedLost = await lostStore.loadCommand(lostScope, "expense");
  assert.deepEqual(loadedLost!.replayProof!.context.originScope, round3.scope);
  assert.equal(loadedLost!.requestFingerprint, originalRows.find((row) => row.idempotency_key === "expense")!.request_fingerprint);

});

async function createConsistentSnapshotFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const owner = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString, max: 4 });
  t.after(async () => { await runtime.end(); await owner.end(); });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const worldId = `world_f3a_${suffix}`, worldlineId = `line_f3a_${suffix}`, storyId = `story_f3a_${suffix}`;
  const scope = { workspaceId: WS, worldId, worldlineId };
  await owner.query(`INSERT INTO worlds (workspace_id,id,name,status,calendar_id,settings)
    VALUES ($1,$2,'Snapshot World','active','native_calendar','{}'::jsonb)`, [WS, worldId]);
  await owner.query(`INSERT INTO worldlines (workspace_id,world_id,id,label,status,head_tick,head_ordinal)
    VALUES ($1,$2,$3,'Snapshot line','active',0,0)`, [WS, worldId, worldlineId]);
  await owner.query(`INSERT INTO player_world_memberships (workspace_id,world_id,principal_id,role)
    VALUES ($1,$2,$3,'owner')`, [WS, worldId, POSTGRES_DEMO_IDS.principal]);
  await owner.query(`INSERT INTO stories (workspace_id,world_id,worldline_id,id,title,status,premise,start_tick,start_ordinal)
    VALUES ($1,$2,$3,$4,'Snapshot Story','active','Snapshot',0,0)`, [WS, worldId, worldlineId, storyId]);
  const definition = normalizeStoryDefinition({ storyKey: `snapshot.${suffix}`, title: "Snapshot Story", premise: "Snapshot", policyVersion: "story-graph-v1",
    nodes: [{ kind: "record", nodeKey: "opening", recordKey: "opening", title: "Primary", sequence: 1, initial: true }] });
  await createPostgresStoryGraphRepository(runtime).materialize({ workspaceId: WS, storyId, definition });
  const recordId = storyRecordIdFor({ ...scope, storyId }, "opening"), siblingId = `sibling_f3a_${suffix}`;
  await owner.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
    VALUES ($1,$2,$3,$4,$5,'Sibling','active',0,0,'primary','0.0.0-local')`, [WS, worldId, worldlineId, storyId, siblingId]);
  await owner.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
    VALUES ($1,$2,$3,$4,0,0)`, [WS, worldId, worldlineId, siblingId]);
  for (const [index, id] of [recordId, siblingId].entries()) {
    const scene = `scene_f3a_${suffix}_${index}`, policy = `policy_f3a_${suffix}_${index}`, event = `event_f3a_${suffix}_${index}`;
    await owner.query(`INSERT INTO scenes (workspace_id,world_id,worldline_id,record_id,id,title,status,start_tick,start_ordinal)
      VALUES ($1,$2,$3,$4,$5,'Snapshot scene','active',0,0)`, [WS, worldId, worldlineId, id, scene]);
    await owner.query(`INSERT INTO visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind)
      VALUES ($1,$2,$3,$4,$5,'opening',1,'public')`, [WS, worldId, worldlineId, id, policy]);
    await owner.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,
      actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
      VALUES ($1,$2,$3,$4,$5,$6,1,1,0,'narration.committed',NULL,'','Snapshot opening','{}'::jsonb,$7,0,$8,'native_calendar','')`,
    [WS, worldId, worldlineId, id, scene, event, policy, index + 1]);
    await owner.query(`UPDATE record_heads SET record_version=1,next_record_ordinal=2,last_event_id=$5,last_world_tick=0,last_world_ordinal=$6
      WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4`, [WS, worldId, worldlineId, id, event, index + 1]);
  }
  await owner.query(`UPDATE worldlines SET head_tick=0,head_ordinal=2 WHERE workspace_id=$1 AND world_id=$2 AND id=$3`, [WS, worldId, worldlineId]);
  const projectId = `project_f3a_${suffix}`, accountId = `account_f3a_${suffix}`, sceneId = `scene_f3a_${suffix}_0`;
  await owner.query(`INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version)
    VALUES ($1,$2,$3,$4,'production','active','funding','Snapshot project','JPY',1)`, [WS, worldId, worldlineId, projectId]);
  await owner.query(`INSERT INTO finance_accounts (workspace_id,world_id,worldline_id,id,currency,status,opening_balance_minor)
    VALUES ($1,$2,$3,$4,'JPY','active',1000)`, [WS, worldId, worldlineId, accountId]);
  await createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(runtime) }).allocateBudget({ scope, projectId,
    category: "seed", amountMinor: 100, expectedVersion: 0, idempotencyKey: "snapshot-budget" });
  await createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(runtime) }).reviseRelationship({ scope,
    subjectEntityKey: "member:snapshot:a", objectEntityKey: "member:snapshot:b", relationKind: "trust", sourceEventId: `event_f3a_${suffix}_1`, idempotencyKey: "snapshot-fact" });
  for (const table of ["project_finance_command_groups", "committed_fact_commands"]) await owner.query(
    `UPDATE ${table} SET result_manifest=result_manifest->'result' WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, worldId, worldlineId]);
  return { owner, runtime, scope, storyId, recordId, siblingId, sceneId, projectId, accountId };
}

function snapshotDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("F3a ordinary save keeps a coherent pre-command snapshot while a separate writer commits", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const fixture = await createConsistentSnapshotFixture(t);
  const { owner, runtime, scope, recordId, sceneId, projectId, accountId } = fixture;
  const reader = createPostgresRealmRuntimeSaveReader(runtime);
  const sourceBefore = await commandAuthoritySnapshot(owner, scope);
  const bindingBefore = (await owner.query(`SELECT to_jsonb(binding) AS row FROM story_definition_bindings binding
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, scope.worldId, scope.worldlineId])).rows;
  const before = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(before?.domain);
  parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(before));
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), sourceBefore);
  assert.equal(before.record.head.recordVersion, 1); assert.equal(before.record.events.length, 1);
  assert.equal(before.domain.financeCommandGroups.length, 1); assert.equal(before.domain.ledgerEntries.length, 0);
  assert.equal(before.domain.projects[0]!.version, 1); assert.equal(before.domain.projects[0]!.stage, "funding");
  const preHead = (sourceBefore.record_heads as { record_id: string; record_version: number; next_record_ordinal: number; last_event_id: string }[]).find((head) => head.record_id === recordId)!;
  assert.equal(preHead.record_version, 1); assert.equal(preHead.next_record_ordinal, 2); assert.equal(preHead.last_event_id, before.record.events[0]!.eventId);
  assert.equal((sourceBefore.worldlines as { head_ordinal: number }[])[0]!.head_ordinal, 2);
  assert.equal(before.domain.records[0]!.recordId, fixture.siblingId); assert.equal(before.domain.storyDefinitions.length, 1);
  assert.deepEqual(before.domain.commandReplayContexts!.map((context) => context.family).sort(), ["fact", "finance"]);
  const writer = await runtime.connect();
  const writerPid = (await writer.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  const reached = snapshotDeferred<{ pid: number; isolation: string; readOnly: string; snapshot: string }>();
  const resume = snapshotDeferred<void>();
  const order: string[] = [];
  let acquired = 0, released = 0, paused = false, resumed = false, statements = 0;
  const readerPids = new Set<number>();
  const sections = new Set<string>();
  let detachedQueries = 0;
  const instrumented = new Proxy(runtime, { get(pool, property) {
    if (property === "query") return () => { detachedQueries++; throw new Error("Snapshot reader must query through its transaction client."); };
    if (property !== "connect") { const value = Reflect.get(pool, property); return typeof value === "function" ? value.bind(pool) : value; }
    return async () => {
      acquired++; const actual = await pool.connect();
      return new Proxy(actual, { get(client, key) {
        if (key === "release") return () => { released++; client.release(); };
        if (key !== "query") { const value = Reflect.get(client, key); return typeof value === "function" ? value.bind(client) : value; }
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
          statements++;
          for (const name of ["records", "events", "goal_instances", "participants", "scenes", "memory_conclusions", "project_finance_command_groups", "committed_fact_commands", "story_definition_bindings"]) {
            if (new RegExp(`FROM ${name}\\b`).test(sql)) sections.add(name);
          }
          const result = await Reflect.apply(client.query, client, args);
          if (!paused && /FROM records AS record/.test(sql) && /head\.record_version/.test(sql)) {
            paused = true; order.push("reader.primary-head.done");
            const mode = (await client.query(`SELECT pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS "readOnly",txid_current_snapshot()::text AS snapshot`)).rows[0];
            readerPids.add(mode.pid); assert.equal(result.rows[0].record_version.toString(), "1");
            reached.resolve(mode); await resume.promise;
          }
          if (/FROM events/.test(sql)) order.push(`reader.events.done:${result.rows.length}`);
          return result;
        };
      } });
    };
  } });
  const pending = createPostgresRealmRuntimeSaveReader(instrumented).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const })
    .then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  let mode: Awaited<typeof reached.promise>;
  let writerState: Awaited<ReturnType<typeof commandAuthoritySnapshot>> | undefined;
  let commandGroupId: string | undefined;
  try {
    mode = await Promise.race([reached.promise, pending.then(() => { throw new Error("Reader ended before the real primary-head barrier."); })]);
    assert.notEqual(mode.pid, writerPid);
    assert.equal(resumed, false); order.push("writer.BEGIN"); await writer.query("BEGIN");
    await writer.query(`SET LOCAL statement_timeout = '5s'`);
    const result = await createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(writer) }).applyRecordProjectFinance({
      scope, evidence: evidenceFor(recordId, sceneId, { tick: 0, ordinal: 2 }), idempotencyKey: "snapshot-concurrent-command", actions: [
        { command: "change_stage", projectId, stage: "production", expectedProjectVersion: 1 },
        { command: "record_expense", accountId, projectId, amountMinor: 100, category: "studio", memo: "Snapshot expense", occurredAt: OCCURRED_AT, expectedBalanceMinor: 1000 },
      ],
    });
    assert.equal(result.status, "committed"); commandGroupId = result.commandGroupId; order.push("writer.command.done");
    await writer.query("COMMIT"); order.push("writer.COMMIT.done"); assert.equal(resumed, false);
    const actual = await commandAuthoritySnapshot(owner, scope); writerState = actual;
    assert.equal((actual.events as unknown[]).length, 4); assert.equal((actual.ledger_entries as unknown[]).length, 1);
    order.push("writer.visible-on-independent-connection");
  } finally {
    try { await writer.query("ROLLBACK"); } finally { writer.release(); }
    resumed = true; order.push("reader.resume"); resume.resolve();
  }
  const outcome = await pending; order.push("reader.finish");
  const afterCommand = await commandAuthoritySnapshot(owner, scope);
  assert.deepEqual(afterCommand, writerState, "resumed export adds no writes beyond the independently committed command");
  const after = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(after?.domain); order.push("fresh-reader.finish");
  parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(after));
  assert.equal(after.record.head.recordVersion, 3); assert.equal(after.record.head.nextRecordOrdinal, 4); assert.equal(after.record.events.length, 3);
  assert.deepEqual(after.record.events.map((event) => event.eventId), (afterCommand.events as { id: string; record_id: string; record_ordinal: number }[])
    .filter((event) => event.record_id === recordId).sort((a, b) => a.record_ordinal - b.record_ordinal).map((event) => event.id));
  assert.equal(after.domain.projects[0]!.version, 2); assert.equal(after.domain.projects[0]!.stage, "production");
  assert.equal(after.domain.ledgerEntries.length, 1); assert.equal(after.domain.financeCommandGroups.length, 2);
  assert.equal(after.domain.ledgerEntries[0]!.amountMinor, 100);
  assert.equal(after.domain.financeCommandGroups.find((group) => group.idempotencyKey === "snapshot-concurrent-command")!.id, commandGroupId);
  const postHead = (afterCommand.record_heads as { record_id: string; record_version: number; next_record_ordinal: number; last_event_id: string }[]).find((head) => head.record_id === recordId)!;
  assert.equal(postHead.record_version, 3); assert.equal(postHead.next_record_ordinal, 4); assert.equal(postHead.last_event_id, after.record.events.at(-1)!.eventId);
  assert.equal((afterCommand.worldlines as { head_ordinal: number }[])[0]!.head_ordinal, 4);
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), afterCommand, "fresh export changes no authority rows");
  assert.deepEqual((await owner.query(`SELECT to_jsonb(binding) AS row FROM story_definition_bindings binding
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, scope.worldId, scope.worldlineId])).rows, bindingBefore);
  assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(readerPids.size, 1); assert.equal(detachedQueries, 0);
  assert.deepEqual([...sections].sort(), ["records", "events", "goal_instances", "participants", "scenes", "memory_conclusions", "project_finance_command_groups", "committed_fact_commands", "story_definition_bindings"].sort());
  assert.ok(order.indexOf("writer.COMMIT.done") < order.indexOf("reader.resume"));
  t.diagnostic(`F3a barrier: ${JSON.stringify({ order, reader: mode, writerPid, acquired, released, statements, sections: [...sections].sort(), detachedQueries,
    pausedError: outcome.error instanceof Error ? outcome.error.message : null, pre: { head: before.record.head, events: before.record.events.map((event) => event.eventId), worldline: sourceBefore.worldlines },
    post: { head: after.record.head, events: after.record.events.map((event) => event.eventId), worldline: afterCommand.worldlines } })}`);
  assert.equal(outcome.error, undefined, "paused reader must not mix old head with newly committed events/domain rows");
  assert.deepEqual(outcome.value, before, "paused ordinary reader must retain the complete pre-command archive");
  parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(outcome.value!));
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), afterCommand, "paused export must not learn proof or modify authority rows");
  assert.ok(["repeatable read", "serializable"].includes(mode.isolation)); assert.equal(mode.readOnly, "on");
});

function trackSnapshotClient(actual: pg.PoolClient) {
  const statements: string[] = [];
  let releases = 0;
  const client = new Proxy(actual, { get(target, property) {
    if (property === "release") return () => { releases++; target.release(); };
    if (property === "query") return (...args: unknown[]) => {
      statements.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
      return Reflect.apply(target.query, target, args);
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { client, statements, get releases() { return releases; } };
}

async function actualSnapshotMode(client: pg.PoolClient) {
  return (await client.query<{ pid: number; isolation: string; readOnly: string; workspace: string | null; snapshot: string }>(
    `SELECT pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS "readOnly",current_setting('realm.workspace_id',true) AS workspace,
            txid_current_snapshot()::text AS snapshot`,
  )).rows[0]!;
}

test("F3a provided clients require a strong read-only outer transaction and retain caller ownership", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, runtime, scope, recordId, storyId } = await createConsistentSnapshotFixture(t);
  const before = await commandAuthoritySnapshot(owner, scope);
  const expected = await createPostgresRealmRuntimeSaveReader(runtime).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(expected);
  const diagnostics: Record<string, unknown>[] = [];
  const cases = [
    { begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE", isolation: "read committed", readOnly: "off", accepted: false },
    { begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", isolation: "read committed", readOnly: "on", accepted: false },
    { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE", isolation: "repeatable read", readOnly: "off", accepted: false },
    { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", isolation: "repeatable read", readOnly: "on", accepted: true },
    { begin: "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", isolation: "serializable", readOnly: "on", accepted: true },
  ];
  for (const entry of cases) {
    const actual = await runtime.connect(), tracked = trackSnapshotClient(actual);
    const sessionWorkspace = `session_f3a_${randomUUID()}`, outerWorkspace = `outer_f3a_${randomUUID()}`;
    try {
      await actual.query(`SELECT set_config('realm.workspace_id',$1,false)`, [sessionWorkspace]);
      await actual.query(entry.begin);
      if (entry.readOnly === "off") {
        await actual.query(`SELECT set_config('realm.workspace_id',$1,true)`, [WS]);
        await actual.query(`UPDATE projects SET title='caller uncommitted marker' WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, scope.worldId, scope.worldlineId]);
      }
      await actual.query(`SELECT set_config('realm.workspace_id',$1,true)`, [outerWorkspace]);
      await actual.query("SAVEPOINT caller_owned");
      const mode = await actualSnapshotMode(actual);
      assert.equal(mode.isolation, entry.isolation); assert.equal(mode.readOnly, entry.readOnly);
      if (entry.accepted) {
        const archive = await createPostgresRealmRuntimeSaveReader(tracked.client).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const });
        assert.deepEqual(archive, expected); parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive!));
        const after = await actualSnapshotMode(actual);
        assert.deepEqual(after, mode, "mode, snapshot, workspace and backend stay owned by caller");
        // A real reader validation failure must restore the outer workspace/savepoint too.
        const badDefinition = normalizeStoryDefinition({ storyKey: "snapshot.changed", title: "Different", premise: "Different", policyVersion: "story-graph-v1",
          nodes: [{ kind: "record", nodeKey: "opening", recordKey: "opening", title: "Different", sequence: 1, initial: true }] });
        await assert.rejects(createPostgresRealmRuntimeSaveReader(tracked.client).load({ workspaceId: WS, recordId, storyDefinitions: new Map([[storyId, badDefinition]]), principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }), { code: "RUNTIME_SAVE_INVALID" });
        assert.deepEqual(await actualSnapshotMode(actual), mode);
        // Recover an actual SQL-aborted savepoint, not just a JavaScript failure.
        await assert.rejects(withWorkspaceTransaction(tracked.client, WS, async (client) => {
          assert.equal((await actualSnapshotMode(client)).workspace, WS);
          await client.query("SELECT 1 / 0");
        }, { readOnly: true, isolationLevel: "repeatable read" }), { code: "22012" });
        assert.deepEqual(await actualSnapshotMode(actual), mode);
        if (entry.isolation === "repeatable read") {
          let called = false;
          await assert.rejects(withWorkspaceTransaction(tracked.client, WS, async () => { called = true; },
            { readOnly: true, isolationLevel: "serializable" }), /provided transaction cannot supply/);
          assert.equal(called, false); assert.deepEqual(await actualSnapshotMode(actual), mode);
        }
      } else {
        await assert.rejects(createPostgresRealmRuntimeSaveReader(tracked.client).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }), /provided transaction cannot supply/);
        assert.ok(tracked.statements.every((sql) => !/\bFROM\s+(records|events|projects|story_definition_bindings|committed_fact_commands|project_finance_command_groups)\b/.test(sql)),
          "weak/read-write outer clients refuse before archive section reads");
        const afterRejection = await actualSnapshotMode(actual);
        assert.deepEqual({ pid: afterRejection.pid, isolation: afterRejection.isolation, readOnly: afterRejection.readOnly, workspace: afterRejection.workspace },
          { pid: mode.pid, isolation: mode.isolation, readOnly: mode.readOnly, workspace: mode.workspace });
        // Default helper callers keep their existing behavior, even in a read/write outer transaction.
        if (entry.readOnly === "off") {
          const observed = await withWorkspaceTransaction(tracked.client, WS, actualSnapshotMode, { readOnly: true });
          assert.equal(observed.readOnly, "off"); assert.equal(observed.workspace, WS);
          await actual.query(`SELECT set_config('realm.workspace_id',$1,true)`, [WS]);
          assert.equal((await actual.query(`SELECT title FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, scope.worldId, scope.worldlineId])).rows[0].title,
            "caller uncommitted marker", "reader rejection never rolls back caller's authority changes");
        }
      }
      assert.equal(tracked.releases, 0);
      await actual.query("ROLLBACK TO SAVEPOINT caller_owned");
      assert.equal((await actualSnapshotMode(actual)).workspace, outerWorkspace);
      assert.equal((await actual.query("SELECT 42 AS usable")).rows[0].usable, 42);
      await actual.query("ROLLBACK");
      assert.equal((await actualSnapshotMode(actual)).workspace, sessionWorkspace);
      diagnostics.push({ ...entry, pid: mode.pid, innerStatements: tracked.statements.length, callerUsable: true, helperReleases: tracked.releases });
    } finally {
      await actual.query("ROLLBACK");
      await actual.query(`SELECT set_config('realm.workspace_id','',false)`);
      if (tracked.releases === 0) actual.release();
    }
    assert.deepEqual(await commandAuthoritySnapshot(owner, scope), before);
  }
  // A provided connection outside a transaction must not be silently owned/upgraded/released.
  const bare = await runtime.connect(), trackedBare = trackSnapshotClient(bare);
  try {
    await assert.rejects(createPostgresRealmRuntimeSaveReader(trackedBare.client).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }), { code: "25P01" });
    assert.equal(trackedBare.releases, 0);
    assert.equal(trackedBare.statements.some((sql) => /FROM records/.test(sql)), false);
    await bare.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.ok(await createPostgresRealmRuntimeSaveReader(trackedBare.client).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }));
    await bare.query("ROLLBACK");
  } finally { await bare.query("ROLLBACK"); if (trackedBare.releases === 0) bare.release(); }
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), before);
  t.diagnostic(`F3a provided-client matrix: ${JSON.stringify(diagnostics)}`);
});

test("F3a snapshot isolation options preserve export RO and native branch RW and release owned clients on failure", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, scope } = await createConsistentSnapshotFixture(t);
  const pool = new pg.Pool({ connectionString: runtimeConnectionString, max: 1 }); t.after(async () => { await pool.end(); });
  const actual = await pool.connect();
  await actual.query(`SELECT set_config('realm.workspace_id','f3a-session-sentinel',false)`); actual.release();
  const before = await commandAuthoritySnapshot(owner, scope);
  let connects = 0, releases = 0;
  const instrumented = new Proxy(pool, { get(target, property) {
    if (property === "connect") return async () => { connects++; const client = await target.connect(); return new Proxy(client, { get(raw, key) {
      if (key === "release") return () => { releases++; raw.release(); };
      const value = Reflect.get(raw, key); return typeof value === "function" ? value.bind(raw) : value;
    } }); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  const diagnostics = [];
  for (const options of [{}, { readOnly: true }, { readOnly: true, isolationLevel: "repeatable read" }, { readOnly: true, isolationLevel: "serializable" }, {isolationLevel:"repeatable read"}, {readOnly:false,isolationLevel:"serializable"}] as WorkspaceTransactionOptions[]) {
    const mode = await withWorkspaceTransaction(instrumented, WS, actualSnapshotMode, options);
    assert.equal(mode.workspace, WS); assert.equal(mode.isolation, options.isolationLevel ?? "read committed");
    assert.equal(mode.readOnly, options.readOnly ? "on" : "off"); diagnostics.push({ options, mode });
    const connection = await pool.connect();
    try { assert.equal((await actualSnapshotMode(connection)).workspace, "f3a-session-sentinel"); } finally { connection.release(); }
  }
  for (const options of [{ readOnly: true, isolationLevel: "read committed" }, { readOnly: true, isolationLevel: "read uncommitted" },
    { readOnly: true, isolationLevel: "invalid" }]) {
    let called = false; const beforeConnects = connects;
    await assert.rejects(withWorkspaceTransaction(instrumented, WS, async () => { called = true; }, options as WorkspaceTransactionOptions), /snapshot.*(not supported|read-only)/);
    assert.equal(called, false); assert.equal(connects, beforeConnects, "invalid requests fail before acquiring a client");
  }
  await assert.rejects(withWorkspaceTransaction(instrumented, WS, async (client) => {
    assert.equal((await actualSnapshotMode(client)).workspace, WS);
    await client.query("SELECT 1 / 0");
  }, { readOnly: true, isolationLevel: "repeatable read" }), { code: "22012" });
  await assert.rejects(withWorkspaceTransaction(instrumented, WS, async (client) => {
    await client.query(`UPDATE projects SET title='must not write' WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`, [WS, scope.worldId, scope.worldlineId]);
  }, { readOnly: true, isolationLevel: "serializable" }), { code: "25006" });
  assert.equal(connects, releases, "owned clients are released on success and real SQL failure");
  const connection = await pool.connect();
  try {
    const mode = await actualSnapshotMode(connection);
    assert.equal(mode.workspace, "f3a-session-sentinel"); assert.equal(mode.isolation, "read committed"); assert.equal(mode.readOnly, "off");
  } finally { await connection.query(`SELECT set_config('realm.workspace_id','',false)`); connection.release(); }
  assert.deepEqual(await commandAuthoritySnapshot(owner, scope), before);
  t.diagnostic(`F3a owned/options: ${JSON.stringify({ connects, releases, diagnostics })}`);
});

async function createBackupAuthorizationFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const fixture = await createConsistentSnapshotFixture(t);
  const { owner, scope, recordId, siblingId } = fixture;
  const principalId = POSTGRES_DEMO_IDS.principal;
  const id = `backup_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await owner.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,principal_id,controller_mode,speaking_order)
    VALUES ($1,$2,$3,$4,$5,'narrator',$6,'human',0)`, [WS, scope.worldId, scope.worldlineId, recordId, `${id}_narrator`, principalId]);
  await owner.query(`INSERT INTO character_definitions (workspace_id,world_id,id,display_name) VALUES ($1,$2,$3,'Private backup character')`, [WS, scope.worldId, `${id}_definition`]);
  await owner.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,born_tick,born_ordinal)
    VALUES ($1,$2,$3,$4,$5,$5,0,0)`, [WS, scope.worldId, scope.worldlineId, `${id}_definition`, `${id}_continuity`]);
  await owner.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,id,controller_mode,instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal)
    VALUES ($1,$2,$3,$4,$5,$6,'ai',0,0,0,0)`, [WS, scope.worldId, scope.worldlineId, siblingId, `${id}_continuity`, `${id}_instance`]);
  await owner.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
    VALUES ($1,$2,$3,$4,$5,'character',$6,'ai',0)`, [WS, scope.worldId, scope.worldlineId, siblingId, `${id}_participant`, `${id}_instance`]);
  const siblingScene = (await owner.query(`SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2`, [WS, siblingId])).rows[0].id;
  const sentinels: { kind: string; content: string; eventId: string; policyId: string }[] = [];
  for (const [index, kind] of ["private", "restricted", "dm_only"].entries()) {
    const policyId = `${id}_${kind}`, eventId = `${id}_event_${kind}`, content = `F3B_PRIVATE_SENTINEL_${id}_${kind}`;
    await owner.query(`INSERT INTO visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_kind,private_character_instance_id,restricted_domain_id,audience_character_instance_ids)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9::text[])`, [WS, scope.worldId, scope.worldlineId, siblingId, policyId, kind,
      kind === "private" ? `${id}_instance` : null, kind === "restricted" ? `${id}_domain` : null, kind === "restricted" ? [`${id}_instance`] : []]);
    await owner.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0,'narration.committed',NULL,'',$8,'{}'::jsonb,$9,0,$10,'native_calendar','')`,
    [WS, scope.worldId, scope.worldlineId, siblingId, siblingScene, eventId, index + 2, content, policyId, index + 3]);
    sentinels.push({ kind, content, eventId, policyId });
  }
  await owner.query(`UPDATE record_heads SET record_version=4,next_record_ordinal=5,last_event_id=$5,last_world_tick=0,last_world_ordinal=5
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4`, [WS, scope.worldId, scope.worldlineId, siblingId, sentinels[2]!.eventId]);
  await owner.query(`UPDATE worldlines SET head_ordinal=5 WHERE workspace_id=$1 AND world_id=$2 AND id=$3`, [WS, scope.worldId, scope.worldlineId]);
  await owner.query(`UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2`, [WS, siblingId]);
  installTestSessionSecret();
  const previousOperators = process.env.REALM_OPERATOR_PRINCIPALS;
  t.after(async () => {
    if (previousOperators === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
    else process.env.REALM_OPERATOR_PRINCIPALS = previousOperators;
    await endSharedRuntimePools();
  });
  return { ...fixture, principalId, sentinels };
}

function backupRequest(recordId: string, principalId: string = POSTGRES_DEMO_IDS.principal, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/record/backup", { method: "POST", headers: {
    "content-type": "application/json", cookie: `realm_session=${createSessionValue(principalId)}`,
  }, body: JSON.stringify({ recordId, ...extra }) });
}

async function backupAuthoritySnapshot(owner: pg.Pool, scope: ProjectScope) {
  const result = await commandAuthoritySnapshot(owner, scope);
  for (const table of ["records", "stories", "scenes", "visibility_policies", "character_continuities", "character_instances", "participants", "story_definition_bindings", "story_node_instances", "story_unlock_ledger", "goal_instances", "goal_assessments", "observations", "memory_conclusions", "memory_snapshots", "action_receipts", "character_effects", "outbox", "relationship_states"]) {
    result[table] = (await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t WHERE workspace_id=$1 AND worldline_id=$2`, [scope.workspaceId, scope.worldlineId])).rows[0].rows;
  }
  for (const table of ["worlds", "player_world_memberships", "character_definitions", "record_first_nights", "record_self_play_sessions"]) {
    result[table] = (await owner.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t WHERE workspace_id=$1 AND ${table === "worlds" ? "id" : "world_id"}=$2`, [scope.workspaceId, scope.worldId])).rows[0].rows;
  }
  return result;
}

test("F3b ordinary authenticated owner cannot disclose private archived siblings without explicit backup capability", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const fixture = await createBackupAuthorizationFixture(t);
  const { owner, runtime, scope, recordId, sentinels } = fixture;
  process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;
  const before = await backupAuthoritySnapshot(owner, scope);
  const trusted = await createPostgresRealmRuntimeSaveReader(runtime).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(trusted?.domain);
  parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(trusted));
  for (const sentinel of sentinels) assert.ok(JSON.stringify(trusted.domain).includes(sentinel.content), "valid complete fixture includes actual sibling plaintext");
  delete process.env.REALM_OPERATOR_PRINCIPALS;
  const response = await whole_backupRoutePOST(backupRequest(recordId));
  const bytes = new Uint8Array(await response.arrayBuffer());
  const disclosed = response.status === 200 ? parseRealmRuntimeSaveArchive(bytes) : null;
  const sentinelCount = sentinels.filter((sentinel) => JSON.stringify(disclosed).includes(sentinel.content)).length;
  t.diagnostic(`F3b disclosure: ${JSON.stringify({ status: response.status, contentType: response.headers.get("content-type"), sentinelCount, archivedSibling: fixture.siblingId, principalRole: "owner", operatorConfigured: false })}`);
  assert.deepEqual(await backupAuthoritySnapshot(owner, scope), before);
  assert.equal(response.status, 403, "ordinary current owner must not receive complete private backup ZIP");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(sentinelCount, 0);
  assert.notEqual(response.headers.get("content-type"), "application/vnd.realm.save+zip");
  assert.equal(JSON.parse(Buffer.from(bytes).toString()).error.code, "BACKUP_FORBIDDEN");
});

// Observe only this test-owned route pool. Every query delegates to the real
// driver; no global SQL patch, fabricated rows, or production injection seam.
function observeBackupPool(pool: pg.Pool, beforeStrongBegin?: () => Promise<void>) {
  const originalConnect = pool.connect;
  const observation = { acquired: 0, released: 0, privateSectionQueries: 0, authorizationQueries: 0,
    modes: [] as Awaited<ReturnType<typeof actualSnapshotMode>>[] };
  pool.connect = (async () => {
    observation.acquired++;
    const actual = await (originalConnect as () => Promise<pg.PoolClient>).call(pool);
    let strong = false;
    return new Proxy(actual, { get(client, key) {
      if (key === "release") return () => { observation.released++; client.release(); };
      if (key !== "query") { const value = Reflect.get(client, key); return typeof value === "function" ? value.bind(client) : value; }
      return async (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
        if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
          await beforeStrongBegin?.();
          const result = await Reflect.apply(client.query, client, args);
          strong = true; observation.modes.push(await actualSnapshotMode(client)); return result;
        }
        if (strong && sql.includes("AS backup_membership")) observation.authorizationQueries++;
        if (strong && /\bFROM\s+(events|goal_instances|goal_assessments|participants|scenes|visibility_policies|observations|memory_conclusions|memory_snapshots|relationship_states|outbox|stories|projects|story_definition_bindings|committed_fact_commands|project_finance_command_groups)\b/.test(sql)) observation.privateSectionQueries++;
        const result = await Reflect.apply(client.query, client, args);
        if (sql === "COMMIT" || sql === "ROLLBACK") strong = false;
        return result;
      };
    } });
  }) as typeof pool.connect;
  return { observation, restore: () => { pool.connect = originalConnect; } };
}

test("F3b exact operator AND same-World owner are required for complete private backup; all denials write nothing", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const fixture = await createBackupAuthorizationFixture(t);
  const { owner, runtime, scope, recordId, principalId, siblingId, sentinels } = fixture;
  const observed = observeBackupPool(getSharedRuntimePool(runtimeConnectionString!));
  const matrix: Record<string, unknown>[] = [];
  const attempt = async (name: string, request: Request, expectedStatus: number) => {
    const before = await backupAuthoritySnapshot(owner, scope);
    const acquired = observed.observation.acquired, sections = observed.observation.privateSectionQueries;
    const response = await whole_backupRoutePOST(request);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, expectedStatus, name);
    assert.equal(response.headers.get("cache-control"), "no-store", name);
    assert.deepEqual(await backupAuthoritySnapshot(owner, scope), before, `${name}: complete authority row images unchanged`);
    if (expectedStatus !== 200) {
      const text = Buffer.from(bytes).toString();
      assert.notEqual(response.headers.get("content-type"), "application/vnd.realm.save+zip");
      assert.equal(response.headers.has("content-disposition"), false);
      for (const sentinel of sentinels) assert.equal(text.includes(sentinel.content), false);
      for (const id of [scope.worldId, scope.worldlineId, recordId, siblingId, principalId]) assert.equal(text.includes(id), false);
      assert.equal(observed.observation.privateSectionQueries, sections, `${name}: denial before reader private sections`);
      assert.ok(["BACKUP_FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED", "INVALID_REQUEST"].includes(JSON.parse(text).error.code));
    }
    matrix.push({ name, status: response.status, acquired: observed.observation.acquired - acquired,
      privateSectionQueries: observed.observation.privateSectionQueries - sections, sentinelCount: expectedStatus === 200 ? 3 : 0 });
    return bytes;
  };
  try {
    for (const [name, allowlist] of [["missing", undefined], ["empty", ""], ["blank", "   "], ["prefix", principalId.slice(0, -2)],
      ["suffix", `${principalId}_extra`], ["wildcard", "*"], ["principal wildcard", `${principalId}*`]] as const) {
      if (allowlist === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
      else process.env.REALM_OPERATOR_PRINCIPALS = allowlist;
      const acquired = observed.observation.acquired;
      await attempt(`non-operator owner: ${name}`, backupRequest(recordId), 403);
      await attempt(`non-operator unknown Record: ${name}`, backupRequest("not-a-record"), 403);
      assert.equal(observed.observation.acquired, acquired, "early operator denial acquires no runtime client");
    }
    process.env.REALM_OPERATOR_PRINCIPALS = `principal_unused, ${principalId} `;
    const trusted = await createPostgresRealmRuntimeSaveReader(runtime).load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(trusted?.domain);
    const bytes = await attempt("exact operator + owner", backupRequest(recordId), 200);
    const parsed = parseRealmRuntimeSaveArchive(bytes);
    assert.deepEqual(parsed, parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(trusted)), "HTTP backup is the complete trusted internal snapshot");
    const sibling = parsed.domain!.records.find((record) => record.recordId === siblingId)!;
    assert.equal(sibling.status, "archived");
    for (const sentinel of sentinels) {
      const payload = sibling.bundle.record.events.find((event) => event.eventId === sentinel.eventId)!.payload as { content: string; visibilityPolicyId: string };
      assert.equal(payload.content, sentinel.content); assert.equal(payload.visibilityPolicyId, sentinel.policyId);
      assert.equal(sibling.bundle.topology!.visibilityPolicies.find((policy) => policy.sourceVisibilityPolicyId === sentinel.policyId)!.policyKind, sentinel.kind);
    }
    assert.deepEqual(parsed.domain!.commandReplayContexts!.map((context) => context.family).sort(), ["fact", "finance"]);
    assert.equal(parsed.domain!.storyDefinitions.length, 1);
    for (const role of ["player", "observer"]) {
      await owner.query(`UPDATE player_world_memberships SET role=$4 WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, principalId, role]);
      await attempt(`allowlisted ${role}`, backupRequest(recordId), 404);
    }
    await owner.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, principalId]);
    const foreignPrincipal = `principal_f3b_foreign_${randomUUID().replaceAll("-", "")}`;
    const foreignWorkspace = `ws_f3b_${randomUUID().replaceAll("-", "")}`, foreignWorld = `${foreignWorkspace}_world`;
    await owner.query(`INSERT INTO workspaces (id,name) VALUES ($1,'Backup foreign workspace')`, [foreignWorkspace]);
    await owner.query(`INSERT INTO worlds (workspace_id,id,name,status,calendar_id,settings) VALUES ($1,$2,'Other World','active','native_calendar','{}'::jsonb)`, [foreignWorkspace, foreignWorld]);
    await owner.query(`INSERT INTO player_world_memberships (workspace_id,world_id,principal_id,role) VALUES ($1,$2,$3,'owner')`, [foreignWorkspace, foreignWorld, foreignPrincipal]);
    process.env.REALM_OPERATOR_PRINCIPALS = foreignPrincipal;
    await attempt("owner only in another workspace/World", backupRequest(recordId, foreignPrincipal), 404);
    // A removed member has an authentic session but no remaining source authority.
    await owner.query(`INSERT INTO player_world_memberships (workspace_id,world_id,principal_id,role) VALUES ($1,$2,$3,'owner')`, [WS, scope.worldId, foreignPrincipal]);
    await owner.query(`DELETE FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, foreignPrincipal]);
    await attempt("removed source member", backupRequest(recordId, foreignPrincipal), 404);
    process.env.REALM_OPERATOR_PRINCIPALS = principalId;
    for (const extra of [{ principalId }, { role: "owner" }, { backupAuthorization: { principalId } }, { trustedService: true },
      { storyDefinitions: {} }, { sourceBinding: { workspaceId: WS, worldId: scope.worldId } }]) await attempt("body authority forgery", backupRequest(recordId, principalId, extra), 400);
    await attempt("anonymous", new Request("http://localhost/api/record/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId }) }), 401);
    await attempt("forged session", new Request("http://localhost/api/record/backup", { method: "POST", headers: { "content-type": "application/json", cookie: "realm_session=principal_forged.0.invalid" }, body: JSON.stringify({ recordId }) }), 401);
    await owner.query(`UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2`, [WS, recordId]);
    await attempt("primary archived remains unavailable", backupRequest(recordId), 404);
    const strong = observed.observation.modes;
    assert.ok(strong.length > 0); assert.ok(strong.every((mode) => mode.isolation === "repeatable read" && mode.readOnly === "on"));
    assert.equal(observed.observation.acquired, observed.observation.released);
    t.diagnostic(`F3b route matrix: ${JSON.stringify({ matrix, readerModes: strong, authorizationQueries: observed.observation.authorizationQueries, sourceRowsUnchanged: true })}`);
  } finally { observed.restore(); }
});

test("F3b principal-aware reader and bytes builder fail closed before private queries, including malformed authorization", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, runtime, scope, recordId, principalId } = await createBackupAuthorizationFixture(t);
  const before = await backupAuthoritySnapshot(owner, scope);
  const observed = observeBackupPool(runtime), reader = createPostgresRealmRuntimeSaveReader(runtime);
  try {
    process.env.REALM_OPERATOR_PRINCIPALS = principalId;
    let accessorReads = 0;
    const accessor = Object.defineProperty({}, "principalId", { enumerable: true, get: () => { accessorReads++; return principalId; } });
    for (const authorization of [undefined, null, {}, [], { principalId: "" }, { principalId: 7 }, { principalId: ` ${principalId}` }, { principalId, role: "owner" },
      Object.create({ principalId }), accessor]) {
      const acquired = observed.observation.acquired;
      await assert.rejects(buildRealmRuntimeSaveBytes(reader, { workspaceId: WS, recordId, principalId: (authorization) as unknown as string, purpose: "whole-closure-backup" as const } as unknown as Parameters<typeof reader.load>[0]), { code: "BACKUP_FORBIDDEN" });
      assert.equal(observed.observation.acquired, acquired);
      assert.deepEqual(await backupAuthoritySnapshot(owner, scope), before);
    }
    assert.equal(accessorReads, 0, "authorization accessors never supply a server principal");
    delete process.env.REALM_OPERATOR_PRINCIPALS;
    await assert.rejects(reader.load({ workspaceId: WS, recordId, principalId: principalId, purpose: "whole-closure-backup" as const }), { code: "BACKUP_FORBIDDEN" });
    assert.equal(observed.observation.acquired, 0);
    process.env.REALM_OPERATOR_PRINCIPALS = principalId;
    await owner.query(`UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, principalId]);
    const playerRows = await backupAuthoritySnapshot(owner, scope);
    assert.equal(await buildRealmRuntimeSaveBytes(reader, { workspaceId: WS, recordId, principalId: principalId, purpose: "whole-closure-backup" as const }), null);
    assert.equal(observed.observation.privateSectionQueries, 0); assert.equal(observed.observation.authorizationQueries, 1);
    assert.deepEqual(await backupAuthoritySnapshot(owner, scope), playerRows);
    assert.equal(await reader.load({ workspaceId: "ws_other_f3b", recordId, principalId: principalId, purpose: "whole-closure-backup" as const }), null);
    assert.equal(observed.observation.privateSectionQueries, 0);
    await owner.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, principalId]);
    const ownerRows = await backupAuthoritySnapshot(owner, scope);
    const archive = await reader.load({ workspaceId: WS, recordId, principalId: principalId, purpose: "whole-closure-backup" as const }); assert.ok(archive);
    const trusted = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.deepEqual(archive, trusted);
    assert.deepEqual(await backupAuthoritySnapshot(owner, scope), ownerRows);
    assert.ok(observed.observation.privateSectionQueries > 0);
    assert.ok(observed.observation.modes.every((mode) => mode.isolation === "repeatable read" && mode.readOnly === "on"));
    t.diagnostic(`F3b direct reader: ${JSON.stringify({ ...observed.observation, malformedDeniedBeforeAcquisition: true, playerDeniedBeforeSections: true, sourceRowsUnchanged: true })}`);
  } finally { observed.restore(); }
});

test("F3b committed ownership revocation after route scope but before reader snapshot denies without private reads", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, scope, recordId, principalId, sentinels } = await createBackupAuthorizationFixture(t);
  process.env.REALM_OPERATOR_PRINCIPALS = principalId;
  const reached = snapshotDeferred<void>(), resume = snapshotDeferred<void>(), order: string[] = [];
  const observed = observeBackupPool(getSharedRuntimePool(runtimeConnectionString!), async () => {
    order.push("route.scope.done;reader.before-BEGIN"); reached.resolve(); await resume.promise; order.push("reader.BEGIN.allowed");
  });
  const before = await backupAuthoritySnapshot(owner, scope);
  const pending = whole_backupRoutePOST(backupRequest(recordId));
  let committedRows: Awaited<ReturnType<typeof backupAuthoritySnapshot>> | undefined;
  let writerPid: number | undefined;
  try {
    await Promise.race([reached.promise, pending.then(() => { throw new Error("Route ended before authoritative snapshot barrier."); })]);
    const writer = await owner.connect();
    try {
      writerPid = (await writer.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      await writer.query("BEGIN"); order.push("writer.BEGIN");
      await writer.query(`UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, scope.worldId, principalId]);
      await writer.query("COMMIT"); order.push("writer.revocation.COMMIT");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    committedRows = await backupAuthoritySnapshot(owner, scope); order.push("revocation.visible.independently");
    for (const table of Object.keys(before).filter((name) => name !== "player_world_memberships")) assert.deepEqual(committedRows[table], before[table]);
    assert.equal((committedRows.player_world_memberships as { role: string }[])[0]!.role, "player");
  } finally { resume.resolve(); }
  try {
    const response = await pending; order.push("route.denied");
    assert.equal(response.status, 404); assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text(); for (const sentinel of sentinels) assert.equal(text.includes(sentinel.content), false);
    assert.equal(observed.observation.privateSectionQueries, 0); assert.equal(observed.observation.authorizationQueries, 1);
    assert.deepEqual(await backupAuthoritySnapshot(owner, scope), committedRows);
    assert.equal(observed.observation.modes.length, 1);
    assert.notEqual(observed.observation.modes[0]!.pid, writerPid);
    assert.equal(observed.observation.modes[0]!.isolation, "repeatable read"); assert.equal(observed.observation.modes[0]!.readOnly, "on");
    assert.ok(order.indexOf("writer.revocation.COMMIT") < order.indexOf("reader.BEGIN.allowed"));
    t.diagnostic(`F3b revocation: ${JSON.stringify({ order, writerPid, ...observed.observation, sourceRowsUnchangedAfterRevocation: true })}`);
  } finally { observed.restore(); }
});

test("F3b automatically provisioned base-World owner still needs an explicit server operator grant", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, principalId } = await createBackupAuthorizationFixture(t);
  const created = await createPostgresLibraryService(owner).instantiateBaseWorld({ workspaceId: WS, principalId, sessionProof: createSessionValue(principalId) }, createBaseInstantiationPlan({
    world: { name: "F3b automatic owner", era: "Now", summary: "Backup boundary" }, language: "en", style: "classical",
    story: { title: "Backup", premise: "Automatic owner is not operator" }, record: { title: "Opening" }, playerRole: "Keeper", playerStance: "player",
    characters: [{ displayName: "Witness", role: "Witness", summary: "Test fixture" }],
    scene: { title: "Room", location: "Room", weather: "Clear", tension: "Quiet", displayTime: "Noon", objective: "Backup" }, opening: "The backup boundary remains closed.", goals: ["base.first-narration"],
  }));
  const worldlineId = (await owner.query(`SELECT worldline_id FROM records WHERE workspace_id=$1 AND id=$2`, [WS, created.recordId])).rows[0].worldline_id as string;
  const scope = { workspaceId: WS, worldId: created.worldId, worldlineId };
  try {
  assert.equal((await owner.query(`SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [WS, created.worldId, principalId])).rows[0].role, "owner");
  delete process.env.REALM_OPERATOR_PRINCIPALS;
  const before = await backupAuthoritySnapshot(owner, scope);
  const response = await whole_backupRoutePOST(backupRequest(created.recordId));
  assert.equal(response.status, 403); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, "BACKUP_FORBIDDEN");
  assert.deepEqual(await backupAuthoritySnapshot(owner, scope), before);
  t.diagnostic("F3b auto-owner: real base genesis assigned owner; empty operator policy denied backup with unchanged source rows");
  } finally {
    // This real genesis creates runnable Goal jobs. Remove only this fixture's
    // jobs after the export comparison so later queue-claim regressions cannot
    // consume an unrelated base-World job from this disposable database.
    const removed = await owner.query(`DELETE FROM goal_assessment_jobs WHERE workspace_id=$1 AND world_id=$2 RETURNING id`, [WS, created.worldId]);
    t.diagnostic(`F3b auto-owner fixture cleanup: ${removed.rowCount} task-owned Goal jobs removed after export checks`);
  }
});

test("R1 memory-only topology anchor joins final Fact/Finance proof closure without historical C", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 90_000,
}, async (t) => {
  const { owner, runtime, scope, recordId, siblingId, storyId } = await createConsistentSnapshotFixture(t);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const memoryRecord = `record_memory_only_${suffix}`, historicalC = `record_history_C_${suffix}`;
  const memoryStory = `story_memory_${suffix}`, definition = `definition_memory_${suffix}`;
  const continuity = `continuity_memory_${suffix}`, instance = `instance_memory_${suffix}`;
  await owner.query(`INSERT INTO stories (workspace_id,world_id,worldline_id,id,title,status,premise,start_tick,start_ordinal)
    VALUES ($1,$2,$3,$4,'Memory-only Story','active','Truthful memory Story metadata',0,0)`, [WS,scope.worldId,scope.worldlineId,memoryStory]);
  for (const [id, story] of [[memoryRecord, memoryStory], [historicalC, storyId]]) {
    await owner.query(`INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,timeline_kind,world_version)
      VALUES ($1,$2,$3,$4,$5,$5,'active',0,0,'primary','0.0.0-local')`, [WS,scope.worldId,scope.worldlineId,story,id]);
    await owner.query(`INSERT INTO record_heads (workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
      VALUES ($1,$2,$3,$4,0,0)`, [WS,scope.worldId,scope.worldlineId,id]);
  }
  await owner.query(`INSERT INTO character_definitions (workspace_id,world_id,id,display_name) VALUES ($1,$2,$3,'Memory anchor')`, [WS,scope.worldId,definition]);
  await owner.query(`INSERT INTO character_continuities (workspace_id,world_id,worldline_id,definition_id,id,continuity_key,born_tick,born_ordinal)
    VALUES ($1,$2,$3,$4,$5,$5,0,0)`, [WS,scope.worldId,scope.worldlineId,definition,continuity]);
  await owner.query(`INSERT INTO character_instances (workspace_id,world_id,worldline_id,record_id,continuity_id,id,controller_mode,status,
    instantiated_tick,instantiated_ordinal,inheritance_cutoff_tick,inheritance_cutoff_ordinal,state)
    VALUES ($1,$2,$3,$4,$5,$6,'ai','present',0,0,0,0,$7::jsonb)`, [WS,scope.worldId,scope.worldlineId,memoryRecord,continuity,instance,JSON.stringify({ literalRecordId: historicalC })]);
  await owner.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
    VALUES ($1,$2,$3,$4,$5,'character',$6,'ai',0)`, [WS,scope.worldId,scope.worldlineId,memoryRecord,`participant_memory_${suffix}`,instance]);
  await owner.query(`INSERT INTO memory_conclusions (workspace_id,world_id,worldline_id,observer_continuity_id,observed_entity_key,
    source_record_id,source_observation_id,supersedes_memory_id,id,operation,memory_kind,content,keywords,semantic_embedding,embedding_model,fidelity,
    occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
    VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,$6,'add','explicit','Memory drives topology closure',ARRAY[$5,$5],$7::vector,'local-test',1,0,1,0,20,$8::jsonb)`,
    [WS,scope.worldId,scope.worldlineId,continuity,historicalC,`memory_anchor_${suffix}`,`[${Array(384).fill(0).join(",")}]`,JSON.stringify({ literalId: historicalC })]);
  const before = await backupAuthoritySnapshot(owner, scope);
  const reader = createPostgresRealmRuntimeSaveReader(runtime);
  const archive = await reader.load({ workspaceId: WS, recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose: "whole-closure-backup" as const }); assert.ok(archive);
  assert.deepEqual(await backupAuthoritySnapshot(owner, scope), before, "whole source export window");
  const domain = archive.domain!;
  assert.deepEqual(domain.records.map((row) => row.recordId).sort(), [siblingId, memoryRecord].sort());
  assert.ok(!domain.records.some((row) => row.recordId === historicalC));
  assert.deepEqual(domain.stories.find((row) => row.id === memoryStory), { id: memoryStory, title: "Memory-only Story", status: "active", premise: "Truthful memory Story metadata" });
  const bundle = domain.records.find((row) => row.recordId === memoryRecord)!.bundle;
  assert.equal(bundle.memory, undefined);
  for (const key of ["record", "goals", "topology", "actionReceipts", "characterEffects", "observations", "outbox", "firstNight", "selfPlay"]) assert.ok(Object.hasOwn(bundle, key));
  assert.ok(domain.commandReplayContexts?.length);
  for (const context of domain.commandReplayContexts!) {
    assert.deepEqual(context.identities.record.map(([id]) => id).sort(), [recordId, siblingId, memoryRecord].sort());
    assert.ok(!context.identities.record.some(([id]) => id === historicalC));
  }
  const facts = (await owner.query(`SELECT id,request_fingerprint,result_manifest FROM committed_fact_commands WHERE workspace_id=$1 AND worldline_id=$2`, [WS,scope.worldlineId])).rows;
  const finance = (await owner.query(`SELECT id,request_fingerprint,result_manifest FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2`, [WS,scope.worldlineId])).rows;
  for (const row of [...domain.committedFactCommands, ...domain.financeCommandGroups]) {
    const original = [...facts, ...finance].find((source) => source.id === row.id)!;
    assert.equal(row.requestFingerprint, original.request_fingerprint);
    assert.equal(row.replayLineage!.originalRequestFingerprint, original.request_fingerprint);
  }
  const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
  const restored = await restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal,
    archive: parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)), targetWorldId: scope.worldId, idempotencyKey: `memory-proof-${suffix}` });
  // Exact original scoped and shared-key rows remain unchanged across legitimate
  // target writes. New definitions/Records have separately asserted identities.
  const after = await backupAuthoritySnapshot(owner, scope);
  for (const table of ["character_definitions", "record_first_nights", "record_self_play_sessions"]) {
    const originalRows = before[table] as Record<string, unknown>[];
    const key = table === "record_first_nights" ? "record_id" : "id";
    const ids = new Set(originalRows.map((row) => row[key]));
    after[table] = (after[table] as Record<string, unknown>[]).filter((row) => ids.has(row[key]));
  }
  assert.deepEqual(after, before);
  const restoredMemoryRecord = (await owner.query(`SELECT r.id,r.title,s.title AS story_title,s.premise FROM records r JOIN stories s
    ON s.workspace_id=r.workspace_id AND s.id=r.story_id WHERE r.workspace_id=$1 AND r.worldline_id=$2 AND r.title=$3`, [WS,restored.worldlineId,memoryRecord])).rows;
  assert.equal(restoredMemoryRecord.length, 1); assert.notEqual(restoredMemoryRecord[0].id, memoryRecord);
  assert.equal(restoredMemoryRecord[0].story_title, "Memory-only Story"); assert.equal(restoredMemoryRecord[0].premise, "Truthful memory Story metadata");
  const forged = structuredClone(archive), oldContext = domain.commandReplayContexts![0]!;
  const extraContext = createReplayContext({ format: oldContext.format, version: oldContext.version, family: oldContext.family,
    originScope: oldContext.originScope, currentScope: oldContext.currentScope, identities: { ...oldContext.identities,
    record: [...oldContext.identities.record, [historicalC, historicalC]].sort((left, right) => left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0) } });
  forged.domain!.commandReplayContexts = domain.commandReplayContexts!.map((row) => row.id === oldContext.id ? extraContext : row);
  forged.domain!.committedFactCommands = forged.domain!.committedFactCommands.map((row) => row.replayLineage?.contextId === oldContext.id ? { ...row, replayLineage: { ...row.replayLineage, contextId: extraContext.id } } : row);
  forged.domain!.financeCommandGroups = forged.domain!.financeCommandGroups.map((row) => row.replayLineage?.contextId === oldContext.id ? { ...row, replayLineage: { ...row.replayLineage, contextId: extraContext.id } } : row);
  const targetBefore = await backupAuthoritySnapshot(owner, { ...scope, worldlineId: restored.worldlineId });
  await assert.rejects(restorer.restore({ workspaceId: WS, principalId: POSTGRES_DEMO_IDS.principal, archive: forged,
    targetWorldId: scope.worldId, idempotencyKey: `unknown-C-${suffix}` }), { code: "RUNTIME_SAVE_INVALID" });
  assert.deepEqual(await backupAuthoritySnapshot(owner, { ...scope, worldlineId: restored.worldlineId }), targetBefore);
  const evidenceDir = process.env.REALM_R1_EVIDENCE_DIR;
  if (evidenceDir) await (await import("node:fs/promises")).writeFile(`${evidenceDir}/domain-memory-proof-${suffix}-${process.pid}.json`,
    JSON.stringify({ archive, facts, finance, before, after, restored, restoredMemoryRecord, targetBefore, targetAfter: await backupAuthoritySnapshot(owner, { ...scope, worldlineId: restored.worldlineId }) }, null, 2));
});

async function c1OrdinaryFixture(t: test.TestContext) {
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
 t.after(async()=>{await runtime.end();await admin.end();});
 const scope={workspaceId:POSTGRES_DEMO_IDS.workspace,worldId:`world_${randomUUID()}`,worldlineId:`worldline_${randomUUID()}`,recordId:`record_${randomUUID()}`};
 const storyId=`story_${randomUUID()}`;
 async function clone(table:string,predicate:string,source:string,patch:object){const r=await admin.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,[JSON.stringify(patch),scope.workspaceId,source]);assert.equal(r.rowCount,1,table);}
 const scoped={workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:scope.recordId};
 await clone('worlds','id',POSTGRES_DEMO_IDS.world,{id:scope.worldId});
 await clone('worldlines','id',POSTGRES_DEMO_IDS.worldline,{id:scope.worldlineId,world_id:scope.worldId,head_tick:0,head_ordinal:0});
 await clone('stories','id',POSTGRES_DEMO_IDS.story,{...scoped,id:storyId,start_tick:0,start_ordinal:0});
 await clone('records','id',POSTGRES_DEMO_IDS.record,{...scoped,id:scope.recordId,story_id:storyId,start_tick:0,start_ordinal:0,status:'active'});
 await clone('scenes','record_id',POSTGRES_DEMO_IDS.record,{...scoped,id:`scene_${randomUUID()}`,start_tick:0,start_ordinal:0});
 await clone('visibility_policies',"policy_kind='public' AND record_id",POSTGRES_DEMO_IDS.record,{...scoped,id:`policy_${randomUUID()}`});
 await clone('record_heads','record_id',POSTGRES_DEMO_IDS.record,{...scoped,record_version:0,next_record_ordinal:1,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
 await admin.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]);
 await admin.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'narrator',$6,'human')`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,POSTGRES_DEMO_IDS.principal]);
 return {admin,runtime,scope,storyId,clone,scoped};
}


test("C1 actual Fact and cash Finance receipts survive ordinary owner save, native branch, replay and resave",{
  skip:!adminConnectionString||!runtimeConnectionString,timeout:120_000,
},async t=>{
  installTestSessionSecret();
  const {sessionProofFor}=await import('./helpers/session-proof.ts');
  const {executeRecordGoalCommand}=await import('../modules/application/record-goal-command.ts');
  const save=await import('../app/api/record/save/route.ts');const branch=await import('../app/api/record/branch/route.ts');
  const {admin,runtime,scope,clone,scoped}=await c1OrdinaryFixture(t);
  t.after(()=>endSharedRuntimePools());
  const principal=POSTGRES_DEMO_IDS.principal;const operators=process.env.REALM_OPERATOR_PRINCIPALS;delete process.env.REALM_OPERATOR_PRINCIPALS;
  t.after(()=>{if(operators===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=operators;});
  const definition=`definition_${randomUUID()}`,continuity=`continuity_${randomUUID()}`,instance=`instance_${randomUUID()}`,asset=`asset_${randomUUID()}`,accountId=`account_${randomUUID()}`;
  await clone('character_definitions','id',POSTGRES_DEMO_IDS.playerDefinition,{world_id:scope.worldId,id:definition});
  await clone('character_continuities','id',POSTGRES_DEMO_IDS.playerContinuity,{world_id:scope.worldId,worldline_id:scope.worldlineId,id:continuity,definition_id:definition});
  await clone('character_instances','id',POSTGRES_DEMO_IDS.playerInstance,{...scoped,id:instance,continuity_id:continuity,predecessor_instance_id:null});
  await clone('asset_definitions','id',POSTGRES_DEMO_IDS.signalLanternAsset,{world_id:scope.worldId,id:asset});
  await admin.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,principal_id,controller_mode) VALUES($1,$2,$3,$4,$5,'character',$6,$7,'human')`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`part_${randomUUID()}`,instance,principal]);
  await executeRecordGoalCommand(runtime,{scope,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:'c1.receipts.goal',command:{operation:'create',recordId:scope.recordId,expectedHead:{recordVersion:0,ordinal:0},draft:{title:'Local receipt continuation',description:'C1',successConditions:['Preserve commands'],failureConditions:[],settlementConditions:[],changePolicy:'fixed',visible:true}}});
  const event=(await admin.query('SELECT id FROM events WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows[0].id;
  const fact=await createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(runtime)}).grantInventory({scope,recordId:scope.recordId,characterInstanceId:instance,assetDefinitionId:asset,quantity:1,sourceEventId:event,idempotencyKey:'c1.grant'});
  assert.equal(fact.status,'committed');
  await admin.query(`INSERT INTO finance_accounts(workspace_id,world_id,worldline_id,id,currency,status,opening_balance_minor) VALUES($1,$2,$3,$4,'JPY','active',10000)`,[scope.workspaceId,scope.worldId,scope.worldlineId,accountId]);
  const sceneId=(await admin.query('SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows[0].id;
  const finance=await createProjectFinanceCommandService({store:createPostgresProjectFinanceCommandStore(runtime)}).recordIncome({scope,accountId,amountMinor:500,category:'sales',memo:'Actual cash receipt',projectId:null,recordId:scope.recordId,occurredAt:'2026-10-18T00:00:00.000Z',expectedBalanceMinor:10000,evidence:{recordId:scope.recordId,sceneId,visibility:'public',expectedWorldCursor:{worldTick:0,worldOrdinal:1}},idempotencyKey:'c1.income'});
  assert.equal(finance.status,'committed');assert.equal('cash' in finance&&finance.cash.balanceMinor,10500);
  const sourceBefore=await commandAuthoritySnapshot(admin,scope);
  const cookie=`realm_session=${sessionProofFor(principal)}`;
  async function ordinary(recordId:string){
    const response=await save.POST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId})}));
    assert.equal(response.status,200,await response.clone().text());return parseRealmRuntimeSaveArchive(new Uint8Array(await response.arrayBuffer()));
  }
  const archive=await ordinary(scope.recordId);assert.equal(archive.domain?.records?.length,0);
  assert.equal(archive.domain?.committedFactCommands[0]?.provenance,'request-result-v1');assert.equal(archive.domain?.financeCommandGroups[0]?.provenance,'request-result-v1');
  const restored=await createPostgresRealmRuntimeSaveRestorer(runtime).restore({archive,workspaceId:scope.workspaceId,targetWorldId:scope.worldId,principalId:principal,sessionProof:sessionProofFor(principal),idempotencyKey:'c1.actual.receipts.restore'});
  const request=()=>new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId,idempotencyKey:'c1.actual.receipts.branch'})});
  const first=await branch.POST(request());assert.equal(first.status,201,await first.clone().text());const branched=await first.json();
  const again=await branch.POST(request());assert.equal(again.status,200);assert.deepEqual((await again.json()).fork,branched.fork);
  for(const target of [restored,branched]){
    const targetScope={workspaceId:scope.workspaceId,worldId:scope.worldId,worldlineId:target.worldlineId};
    const saved=await ordinary(target.recordId);const domain=saved.domain!;
    assert.equal(domain.records?.length,0);assert.equal(saved.goals.definitions?.length,1);
    const command=domain.committedFactCommands.find(row=>row.idempotencyKey==='c1.grant')!;
    const group=domain.financeCommandGroups.find(row=>row.idempotencyKey==='c1.income')!;
    assert.ok(command.request);assert.ok(group.request);assert.notEqual(command.id,archive.domain!.committedFactCommands[0]!.id);
    assert.notEqual(command.request.characterInstanceId,instance);assert.equal(command.request.recordId,target.recordId);
    assert.equal(command.requestFingerprint,committedFactRequestFingerprintFor(targetScope,command.request));
    assert.equal(group.requestFingerprint,projectFinanceCommandFingerprintFor(targetScope,group.request as never));
    const before=await commandAuthoritySnapshot(admin,targetScope);
    const replayFact=await createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(runtime)}).grantInventory({...command.request,scope:targetScope,idempotencyKey:command.idempotencyKey} as never);
    const replayFinance=await createProjectFinanceCommandService({store:createPostgresProjectFinanceCommandStore(runtime)}).recordIncome(financeServiceInput(group.request,targetScope,group.idempotencyKey) as never);
    assert.equal(replayFact.status,'replayed');assert.equal(replayFinance.status,'replayed');assert.equal('cash' in replayFinance&&replayFinance.cash.balanceMinor,10500);
    assert.deepEqual(await commandAuthoritySnapshot(admin,targetScope),before,'exact replay writes no typed rows');
    const resaved=await ordinary(target.recordId);assert.deepEqual(resaved.domain,domain);
    const sql=(await admin.query('SELECT request_fingerprint,result_manifest FROM committed_fact_commands WHERE workspace_id=$1 AND id=$2',[scope.workspaceId,command.id])).rows[0];
    assert.equal(sql.request_fingerprint,command.requestFingerprint);assert.deepEqual(sql.result_manifest.request,command.request);
    console.log('C1_ORDINARY_RECEIPTS',JSON.stringify({recordId:target.recordId,nativeGoals:saved.goals.definitions?.length,cash:10500,replayed:true,resaved:true}));
  }
  assert.deepEqual(await commandAuthoritySnapshot(admin,scope),sourceBefore,'ordinary exports/restore/branch never mutate source rows');
});

}
