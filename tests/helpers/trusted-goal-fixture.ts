import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type pg from "pg";
import { POSTGRES_DEMO_IDS } from "../../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../../database/postgres/workspace-transaction.ts";
import { lockGoalContentWorld } from "../../database/postgres/goal-content-binding-repository.ts";
import { materializeGoalInstances } from "../../database/postgres/goal-runtime-materialization.ts";
import { createGoalContentBindingSource } from "../../modules/application/goal-content-binding-source.ts";
import { createRealmWorldDefinitionResolver } from "../../modules/world-transfer/realmworld-definition-resolver.ts";
import { mountRealmWorld } from "../../modules/world-transfer/realmworld-loader.ts";
import { createRealmWorldSignatureVerifierFromTrustStoreDocument } from "../../modules/world-transfer/realmworld-signature.ts";
import type { GoalDefinition, GoalScope } from "../../modules/goals/public.ts";
import { installSignedRealmWorldFixture } from "./realmworld-package-fixture.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./session-proof.ts";

/** Register ownership before setup awaits; every close runs even if one fails. */
export function fixtureCleanup(t: TestContext) {
  const closers: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of closers.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
  });
  return (close: () => Promise<unknown>) => { closers.push(close); };
}

/** Real signed bytes and mount authority; no serialized/fabricated witnesses. */
export async function trustedGoalFixture(t: TestContext, input: {
  worldId: string; worldVersion: string; goals: readonly GoalDefinition[];
}) {
  const installRoot = await mkdtemp(join(tmpdir(), "realm-trusted-goals-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "trusted-goal-test";
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  await installSignedRealmWorldFixture({ installRoot, worldId: input.worldId,
    version: input.worldVersion, recordTitle: "Trusted Goal fixture", goals: input.goals,
    keyId, keyPair: { privateKey, publicKeyPem } });
  const verifySignature = createRealmWorldSignatureVerifierFromTrustStoreDocument({
    document: { format: "realmworld-trust-store", version: 1,
      keys: [{ keyId, publicKey: publicKeyPem, status: "active" }] }, now: new Date(),
  });
  const mount = (identity: { worldId: string; worldVersion: string }) =>
    mountRealmWorld({ installRoot, ...identity, verifySignature });
  const resolveSource = createGoalContentBindingSource({ mount });
  const resolveDefinition = createRealmWorldDefinitionResolver({ mount });
  return { installRoot, mount, resolveSource, resolveDefinition,
    context(principalId = POSTGRES_DEMO_IDS.principal) {
      return { sessionProof: sessionProofFor(principalId), worldVersion: input.worldVersion, resolveSource };
    },
    async materialize(admin: pg.Pool | pg.Client, database: pg.Pool, scope: GoalScope,
      goals: readonly GoalDefinition[] = input.goals, principalId = POSTGRES_DEMO_IDS.principal) {
      installTestSessionSecret();
      await seedCapabilitySessionKey(admin, scope.workspaceId);
      return withWorkspaceTransaction(database, scope.workspaceId, async client => {
        await lockGoalContentWorld(client, scope.workspaceId, scope.worldId);
        return materializeGoalInstances(client, scope, goals, {
          sessionProof: sessionProofFor(principalId), worldVersion: input.worldVersion, resolveSource,
        });
      });
    },
  };
}

/** Independent signed World with the original demo's opening evidence shape. */
export async function cloneGoalRecordFixture(admin: pg.Pool, worldVersion = "1.0.0") {
  const suffix = randomUUID().replaceAll("-", "");
  const ids = { ...POSTGRES_DEMO_IDS, world: `world_goal_${suffix}`, worldline: `line_goal_${suffix}`,
    story: `story_goal_${suffix}`, record: `record_goal_${suffix}`, scene: `scene_goal_${suffix}`,
    publicPolicy: `policy_goal_${suffix}`, openingEvent: `opening_goal_${suffix}` };
  await withWorkspaceTransaction(admin, ids.workspace, async client => {
    const opening = await client.query<{ world_tick: string; world_ordinal: string }>(
      "SELECT world_tick,world_ordinal FROM events WHERE workspace_id=$1 AND id=$2",
      [ids.workspace, POSTGRES_DEMO_IDS.openingEvent]);
    assert.equal(opening.rowCount, 1);
    const cursor = opening.rows[0]!;
    const clone = async (table: string, key: string, value: string, patch: object) => {
      const result = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${key}=$3`,
      [JSON.stringify(patch), ids.workspace, value]);
      assert.equal(result.rowCount, 1, `${table} fixture source must be unique`);
    };
    await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: ids.world, world_version: worldVersion });
    const common = { world_id: ids.world, worldline_id: ids.worldline };
    await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: ids.worldline, world_id: ids.world,
      parent_worldline_id: null, fork_tick: null, fork_ordinal: null,
      head_tick: cursor.world_tick, head_ordinal: cursor.world_ordinal });
    await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...common, id: ids.story });
    await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...common, id: ids.record, story_id: ids.story,
      world_version: worldVersion, linked_record_id: null, timeline_kind: "primary" });
    await clone("scenes", "id", POSTGRES_DEMO_IDS.scene, { ...common, record_id: ids.record, id: ids.scene });
    await clone("visibility_policies", "id", POSTGRES_DEMO_IDS.publicPolicy,
      { ...common, record_id: ids.record, id: ids.publicPolicy, scene_id: null });
    await clone("events", "id", POSTGRES_DEMO_IDS.openingEvent, { ...common, record_id: ids.record,
      scene_id: ids.scene, visibility_policy_id: ids.publicPolicy, id: ids.openingEvent,
      actor_participant_id: null });
    await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record,
      { ...common, record_id: ids.record, record_version: 1, next_record_ordinal: 2, last_event_id: ids.openingEvent,
        last_world_tick: cursor.world_tick, last_world_ordinal: cursor.world_ordinal });
    await client.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role)
      VALUES($1,$2,$3,'owner')`, [ids.workspace, ids.world, ids.principal]);
  });
  return ids;
}
