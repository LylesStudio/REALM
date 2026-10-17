import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresLibraryService } from '../modules/application/library-service.ts';
import { normalizeGenesisDraft } from '../modules/application/world-genesis-contract.ts';
import { withWorkspaceTransaction } from '../database/postgres/workspace-transaction.ts';
import { sessionProofFor, seedCapabilitySessionKey, installTestSessionSecret } from './helpers/session-proof.ts';
import { loadRecordGoalNarrativeContext } from '../modules/application/record-goal-projection.ts';

const options = { skip: !process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL ? 'requires scratch PostgreSQL' : false, timeout: 120000 };
const goals = [{ title: 'Protect the letter', description: 'Deliver the original letter intact.', successConditions: ['The recipient receives the letter'],
  failureConditions: ['The original letter is permanently destroyed'], settlementConditions: [], changePolicy: 'fixed' as const, visible: true },
  { title: 'PRIVATE_ROUTE', description: 'Find a different route when the old one closes.', successConditions: ['A new route is established'],
    failureConditions: [], settlementConditions: [], changePolicy: 'evolving' as const, visible: false }];

test('native genesis atomically initializes mixed-policy Goals with creator proof, including observer creation and exact replay',options,async()=>{
  const owner = new pg.Pool({connectionString:process.env.DATABASE_URL!,max:1});
  const runtime = new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL!,max:1});
  const scope = {workspaceId:`genesis_goals_${randomUUID()}`,principalId:`principal_genesis_${randomUUID()}`};
  installTestSessionSecret();
  try {
    await withWorkspaceTransaction(owner,scope.workspaceId,async client=>{
      await client.query(`INSERT INTO workspaces(id,name) VALUES($1,'Genesis Goal isolated fixture')`,[scope.workspaceId]);
      await client.query(`INSERT INTO accounts(workspace_id,principal_id,display_name) VALUES($1,$2,'Goal creator')`,[scope.workspaceId,scope.principalId]);
    });
    await seedCapabilitySessionKey(owner,scope.workspaceId);
    const actor = {...scope,sessionProof:sessionProofFor(scope.principalId)};
    const library = createPostgresLibraryService(runtime);
    for (const playerStance of ['player','observer'] as const) {
      const draft = normalizeGenesisDraft({world:{name:`Goal genesis ${playerStance}`},playerStance,recordGoals:goals,
        scene:{objective:'Inspect the gate'},opening:'The road is open; the unopened letter is still in your bag.'})!;
      const creationRequestId = `genesis-goals-${randomUUID()}`;
      const created = await library.createGenesis(actor,draft,{creationRequestId});
      assert.deepEqual(await library.createGenesis(actor,draft,{creationRequestId}),created);
      const rows = (await owner.query(`SELECT definition.definition,instance.state,instance.revision::text
        FROM record_goal_definitions definition JOIN goal_instances instance ON instance.workspace_id=definition.workspace_id AND instance.definition_id=definition.id
        WHERE definition.workspace_id=$1 AND definition.record_id=$2 ORDER BY definition.goal_id`,[scope.workspaceId,created.recordId])).rows;
      assert.equal(rows.length,2);
      assert.deepEqual(rows.map(row=>row.definition.draft),goals);
      assert.ok(rows.every(row=>row.state==='active' && row.revision==='1'));
      const jobs = (await owner.query(`SELECT count(*)::int AS n FROM goal_assessment_jobs WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,created.recordId])).rows[0];
      assert.equal(jobs.n,2);
      const context = await loadRecordGoalNarrativeContext(runtime,{scope:{...scope,...created,worldlineId:rows[0].definition.scope.worldlineId},principalId:scope.principalId});
      assert.ok(context.document.includes(goals[0]!.title));
      assert.equal(context.document.includes('PRIVATE_ROUTE'),false);
      await assert.rejects(library.createGenesis(actor,{...draft,recordGoals:[{...goals[0]!,changePolicy:'evolving'},goals[1]!]},{creationRequestId}));
      const firstNight = (await owner.query(`SELECT context FROM record_first_nights WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,created.recordId])).rows[0];
      assert.deepEqual(firstNight.context.recordGoals,[{title:goals[0]!.title,description:goals[0]!.description,changePolicy:'fixed'}]);
    }
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM worlds WHERE workspace_id=$1`,[scope.workspaceId])).rows[0].n,2);
  } finally { await runtime.end();await owner.end(); }
});
