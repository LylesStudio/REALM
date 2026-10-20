import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import test from "node:test";
import {
  createPostgresStoryGraphRepository,
  StoryGraphRepositoryError,
} from "../database/postgres/story-graph-repository.ts";

import { cloneGoalRecordFixture, trustedGoalFixture, fixtureCleanup } from "./helpers/trusted-goal-fixture.ts";
import { goalInstanceIdFor } from "../modules/goals/public.ts";
import {
  normalizeStoryDefinition,
  storyRecordIdFor,
  type StoryDefinition,
} from "../modules/story-graph/public.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;

function makeDefinition(nextNode: boolean): StoryDefinition {
  return normalizeStoryDefinition({
    storyKey: "story.graph.test",
    title: "Story graph test",
    premise: "A graph used by the B2 runtime contract.",
    policyVersion: "story-graph-v1",
    nodes: [
      {
        kind: "record",
        nodeKey: "start",
        recordKey: "start-record",
        title: "Start",
        sequence: 1,
        initial: true,
      },
      {
        kind: "record",
        nodeKey: "next",
        recordKey: "next-record",
        title: "Next",
        sequence: 2,
        unlock: nextNode
          ? { kind: "goal_state", goalKey: "story.prep", scope: "story", state: "completed" }
          : { kind: "node_state", nodeKey: "start", state: "completed" },
      },
    ],
  });
}

async function createStory(owner: pg.Pool, suffix: string, worldlineId: string = WORLDLINE, worldId: string = WORLD): Promise<string> {
  const storyId = `story_b2_${suffix}`;
  await owner.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status, premise,
       start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, 'B2 Story', 'active', 'B2 test', 0, 0)`,
    [WS, worldId, worldlineId, storyId],
  );
  return storyId;
}

const storyGoalDefinition = {
  goalKey: "story.prep", policyVersion: "story-policy-v1", mode: "deterministic" as const, visible: true,
  rubric: { kind: "event_count" as const, eventKind: "narration.committed", progressKey: "done", threshold: 1 },
  outcome: {},
};

function pools(t?: test.TestContext): { owner: pg.Pool; runtime: pg.Pool } {
  const close = t ? fixtureCleanup(t) : null;
  const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
  close?.(() => owner.end());
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
  close?.(() => runtime.end());
  return { owner, runtime };
}

test(
  "0061 installs Story Graph runtime tables, RLS, grants, and append-only unlock ledger",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async () => {
    const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      const tables = await owner.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_class AS c
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('story_node_instances', 'story_unlock_ledger')
           AND c.relkind = 'r'`,
      );
      assert.deepEqual(tables.rows.map((row) => row.relname).sort(), [
        "story_node_instances",
        "story_unlock_ledger",
      ]);

      const rls = await owner.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class AS c
         WHERE c.relname IN ('story_node_instances', 'story_unlock_ledger')
         ORDER BY c.relname`,
      );
      assert.deepEqual(rls.rows, [
        { relname: "story_node_instances", relforcerowsecurity: true },
        { relname: "story_unlock_ledger", relforcerowsecurity: true },
      ]);

      const trigger = await owner.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'story_unlock_ledger'::regclass
           AND tgname = 'story_unlock_ledger_append_only_guard'`,
      );
      assert.equal(trigger.rowCount, 1);
    } finally {
      await owner.end();
    }
  },
);

test(
  "materialization creates the initial Record atomically and replay is idempotent",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools();
    const storyId = await createStory(owner, randomUUID().replaceAll("-", "").slice(0, 12));
    t.after(async () => {
      await owner.query("DELETE FROM stories WHERE workspace_id = $1 AND id = $2", [WS, storyId]);
      await runtime.end();
      await owner.end();
    });
    const definition = makeDefinition(false);
    const repository = createPostgresStoryGraphRepository(runtime);

    const first = await repository.materialize({ workspaceId: WS, storyId, definition });
    const replay = await repository.materialize({ workspaceId: WS, storyId, definition });
    assert.deepEqual(replay, first);
    assert.equal(first.nodes.find((node) => node.nodeKey === "start")?.state, "active");
    assert.equal(first.nodes.find((node) => node.nodeKey === "next")?.state, "locked");
    const startRecordId = first.nodes.find((node) => node.nodeKey === "start")?.recordId;
    assert.equal(startRecordId, storyRecordIdFor({ workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId }, "start"));

    const counts = await owner.query<{ nodes: string; ledger: string; records: string }>(
      `SELECT
         (SELECT count(*)::text FROM story_node_instances WHERE workspace_id = $1 AND story_id = $2) AS nodes,
         (SELECT count(*)::text FROM story_unlock_ledger WHERE workspace_id = $1 AND story_id = $2) AS ledger,
         (SELECT count(*)::text FROM records WHERE workspace_id = $1 AND story_id = $2) AS records`,
      [WS, storyId],
    );
    assert.deepEqual(counts.rows[0], { nodes: "2", ledger: "1", records: "1" });
  },
);

test(
  "reconcile unlocks from a committed Story-scoped Goal and replays without duplicate topology",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools(t);
    const ids = await cloneGoalRecordFixture(owner);
    const { world: WORLD, worldline: WORLDLINE } = ids;
    const storyId = await createStory(owner, randomUUID().replaceAll("-", "").slice(0, 12), WORLDLINE, WORLD);
    const trusted = await trustedGoalFixture(t, { worldId: WORLD, worldVersion: "1.0.0", goals: [storyGoalDefinition] });
    const definition = makeDefinition(true);
    const repository = createPostgresStoryGraphRepository(runtime);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId };
    await repository.materialize({ workspaceId: WS, storyId, definition });

    const goalKey = "story.prep";
    const [goalId] = await trusted.materialize(owner, runtime, { kind: "story", ...scope });
    assert.equal(goalId, goalInstanceIdFor({ kind: "story", ...scope }, goalKey));
    await owner.query(`UPDATE goal_instances SET state='completed',revision=1,
      progress='{"done":true}'::jsonb,outcome='{"ok":true}'::jsonb,completed_at=CURRENT_TIMESTAMP
      WHERE workspace_id=$1 AND id=$2`, [WS, goalId]);

    const first = await repository.reconcile({ workspaceId: WS, storyId, definition });
    const replay = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.deepEqual(replay, { ...first, activatedNodeKeys: [] });
    assert.deepEqual(first.activatedNodeKeys, ["next"]);
    assert.equal(first.unlockedNodeKeys.includes("next"), true);
    assert.equal(first.nodes.find((node) => node.nodeKey === "next")?.state, "active");
    assert.ok(first.nodes.find((node) => node.nodeKey === "next")?.recordId);

    const counts = await owner.query<{ ledger: string; records: string }>(
      `SELECT
         (SELECT count(*)::text FROM story_unlock_ledger WHERE workspace_id = $1 AND story_id = $2) AS ledger,
         (SELECT count(*)::text FROM records WHERE workspace_id = $1 AND story_id = $2) AS records`,
      [WS, storyId],
    );
    assert.deepEqual(counts.rows[0], { ledger: "2", records: "2" });
  },
);

test(
  "withdrawn and superseded Goals cannot unlock settled Story conditions; natural settlement can",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools(t);
    const ids = await cloneGoalRecordFixture(owner);
    const { world: WORLD, worldline: WORLDLINE } = ids;
    const trusted = await trustedGoalFixture(t, { worldId: WORLD, worldVersion: "1.0.0", goals: [storyGoalDefinition] });
    {
      for (const resolution of ["withdrawn", "superseded", "natural"] as const) {
        const storyId = await createStory(owner, randomUUID().replaceAll("-", "").slice(0, 12), WORLDLINE, WORLD);
        const definition = normalizeStoryDefinition({ ...makeDefinition(true), nodes: [
          {kind:"record",nodeKey:"start",recordKey:"start-record",title:"Start",sequence:1,initial:true},
          {kind:"record",nodeKey:"next",recordKey:"next-record",title:"Next",sequence:2,
            unlock:{kind:"goal_state",goalKey:"story.prep",scope:"story",state:"settled"}},
        ]});
        const repository = createPostgresStoryGraphRepository(runtime);
        const scope = { workspaceId:WS,worldId:WORLD,worldlineId:WORLDLINE,storyId };
        await repository.materialize({ workspaceId:WS,storyId,definition });
        const [goalId] = await trusted.materialize(owner, runtime, { kind: "story", ...scope });
        await owner.query(`UPDATE goal_instances SET state='settled',revision=1,completed_at=CURRENT_TIMESTAMP,
          resolution_kind=$3 WHERE workspace_id=$1 AND id=$2`, [WS, goalId, resolution]);
        const result = await repository.reconcile({ workspaceId:WS,storyId,definition });
        assert.equal(result.unlockedNodeKeys.includes("next"), resolution === "natural", resolution);
        assert.equal(result.nodes.find(node=>node.nodeKey==="next")?.state,
          resolution === "natural" ? "active" : "locked", resolution);
        const ledger = await owner.query<{count:string}>(
          "SELECT count(*)::text FROM story_unlock_ledger WHERE workspace_id=$1 AND story_id=$2 AND node_key='next'",
          [WS,storyId]);
        assert.equal(ledger.rows[0].count, resolution === "natural" ? "1" : "0", resolution);
      }
    }
  },
);

test(
  "failed Record instantiation rolls back the node row and unlock ledger",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools();
    const storyId = await createStory(owner, randomUUID().replaceAll("-", "").slice(0, 12));
    const definition = makeDefinition(false);
    const collisionId = storyRecordIdFor({ workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId }, "start");
    await owner.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title, status,
         start_tick, start_ordinal, timeline_kind, linked_record_id
       ) VALUES ($1, $2, $3, $4, $5, 'collision', 'active', 0, 0, 'primary', NULL)`,
      [WS, WORLD, WORLDLINE, storyId, collisionId],
    );
    t.after(async () => {
      await owner.query("DELETE FROM stories WHERE workspace_id = $1 AND id = $2", [WS, storyId]);
      await runtime.end();
      await owner.end();
    });
    const repository = createPostgresStoryGraphRepository(runtime);

    await assert.rejects(
      repository.materialize({ workspaceId: WS, storyId, definition }),
      (error: unknown) => error instanceof StoryGraphRepositoryError && error.code === "STORY_RECORD_INSTANTIATION_FAILED",
    );
    const counts = await owner.query<{ nodes: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM story_node_instances WHERE workspace_id = $1 AND story_id = $2) AS nodes,
         (SELECT count(*)::text FROM story_unlock_ledger WHERE workspace_id = $1 AND story_id = $2) AS ledger`,
      [WS, storyId],
    );
    assert.deepEqual(counts.rows[0], { nodes: "0", ledger: "0" });
  },
);

test(
  "reconcile reads committed milestone, obligation, and cash instead of caller facts",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const { owner, runtime } = pools();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const worldlineId = `worldline_facts_${suffix}`;
    await owner.query(
      `INSERT INTO worldlines (
         workspace_id, world_id, id, label, status, head_tick, head_ordinal
       ) VALUES ($1, $2, $3, 'Isolated facts', 'active', 0, 0)`,
      [WS, WORLD, worldlineId],
    );
    const storyId = await createStory(owner, `facts_${suffix}`, worldlineId);
    const projectId = `project_facts_${suffix}`;
    const milestoneId = `milestone_facts_${suffix}`;
    const obligationId = `obligation_facts_${suffix}`;
    const accountId = `account_facts_${suffix}`;
    const linkId = `link_facts_${suffix}`;
    // A preceding suite may legitimately leave an active account in the demo
    // worldline. This fixture must not depend on that worldline being empty.
    const unrelatedAccountId = `account_unrelated_${suffix}`;
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 0)`,
      [WS, WORLD, WORLDLINE, unrelatedAccountId],
    );
    t.after(async () => {
      await owner.query("DELETE FROM finance_accounts WHERE workspace_id = $1 AND id = $2", [WS, unrelatedAccountId]);
      await owner.query("DELETE FROM obligations WHERE workspace_id = $1 AND id = $2", [WS, obligationId]);
      await owner.query("DELETE FROM finance_accounts WHERE workspace_id = $1 AND id = $2", [WS, accountId]);
      await owner.query("DELETE FROM projects WHERE workspace_id = $1 AND id = $2", [WS, projectId]);
      await owner.query("DELETE FROM stories WHERE workspace_id = $1 AND id = $2", [WS, storyId]);
      await runtime.end();
      await owner.end();
    });
    await owner.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'production', 'Fact project', 'JPY', 1)`,
      [WS, WORLD, worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (
         workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [WS, WORLD, worldlineId, linkId, projectId, storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence, title, status
       ) VALUES ($1, $2, $3, $4, $5, 1, 'First show', 'active')`,
      [WS, WORLD, worldlineId, milestoneId, projectId],
    );
    await owner.query(
      `INSERT INTO obligations (
         workspace_id, world_id, worldline_id, id, project_id, kind, status,
         principal_minor, outstanding_minor
       ) VALUES ($1, $2, $3, $4, $5, 'loan', 'open', 0, 0)`,
      [WS, WORLD, worldlineId, obligationId, projectId],
    );
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 5000)`,
      [WS, WORLD, worldlineId, accountId],
    );
    const definition = normalizeStoryDefinition({
      storyKey: "story.graph.facts",
      title: "Committed facts",
      premise: "Unlock only from committed rows.",
      policyVersion: "story-graph-facts-v1",
      nodes: [
        {
          kind: "record",
          nodeKey: "start",
          recordKey: "start-record",
          title: "Start",
          sequence: 1,
          initial: true,
        },
        {
          kind: "record",
          nodeKey: "show",
          recordKey: "show-record",
          title: "Show",
          sequence: 2,
          unlock: {
            kind: "all",
            rules: [
              { kind: "milestone_status", milestoneId, status: "completed" },
              { kind: "obligation_outstanding_at_most", obligationId, maximumMinor: 0 },
              { kind: "cash_at_least", minimumMinor: 1 },
            ],
          },
        },
      ],
    });
    const repository = createPostgresStoryGraphRepository(runtime);
    await repository.materialize({ workspaceId: WS, storyId, definition });
    const blocked = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.equal(blocked.unlockedNodeKeys.includes("show"), false);
    await owner.query(
      `UPDATE project_milestones SET status = 'completed'
       WHERE workspace_id = $1 AND id = $2`,
      [WS, milestoneId],
    );
    // Ambiguous accounts inside the *same* worldline must still fail closed.
    // Isolation is not permission to sum or arbitrarily choose an account.
    const ambiguousAccountId = `account_ambiguous_${suffix}`;
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 9000)`,
      [WS, WORLD, worldlineId, ambiguousAccountId],
    );
    const ambiguous = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.equal(ambiguous.unlockedNodeKeys.includes("show"), false);
    assert.equal(ambiguous.nodes.find((node) => node.nodeKey === "show")?.state, "locked");
    await owner.query("DELETE FROM finance_accounts WHERE workspace_id = $1 AND id = $2", [WS, ambiguousAccountId]);
    const opened = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.equal(opened.unlockedNodeKeys.includes("show"), true);
    assert.equal(opened.nodes.find((node) => node.nodeKey === "show")?.state, "active");
  },
);
