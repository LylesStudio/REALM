import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import test from "node:test";
import {
  createPostgresStoryGraphRepository,
  StoryGraphRepositoryError,
} from "../database/postgres/story-graph-repository.ts";

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

async function createStory(owner: pg.Pool, suffix: string): Promise<string> {
  const storyId = `story_b2_${suffix}`;
  await owner.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status, premise,
       start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, 'B2 Story', 'active', 'B2 test', 0, 0)`,
    [WS, WORLD, WORLDLINE, storyId],
  );
  return storyId;
}

function pools(): { owner: pg.Pool; runtime: pg.Pool } {
  return {
    owner: new pg.Pool({ connectionString: adminConnectionString!, max: 2 }),
    runtime: new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 }),
  };
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
    const { owner, runtime } = pools();
    const storyId = await createStory(owner, randomUUID().replaceAll("-", "").slice(0, 12));
    t.after(async () => {
      await owner.query("DELETE FROM stories WHERE workspace_id = $1 AND id = $2", [WS, storyId]);
      await runtime.end();
      await owner.end();
    });
    const definition = makeDefinition(true);
    const repository = createPostgresStoryGraphRepository(runtime);
    const scope = { workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId };
    await repository.materialize({ workspaceId: WS, storyId, definition });

    const goalKey = "story.prep";
    await owner.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, story_id, scope_kind, id,
         goal_key, state, revision, progress, outcome, policy_version, completed_at
       ) VALUES ($1, $2, $3, $4, 'story', $5, $6, 'completed', 1,
                 '{"done":true}'::jsonb, '{"ok":true}'::jsonb, 'story-policy-v1', CURRENT_TIMESTAMP)`,
      [WS, WORLD, WORLDLINE, storyId, goalInstanceIdFor({ kind: "story", ...scope }, goalKey), goalKey],
    );

    const first = await repository.reconcile({ workspaceId: WS, storyId, definition });
    const replay = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.deepEqual(replay, first);
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
    const storyId = await createStory(owner, `facts_${suffix}`);
    const projectId = `project_facts_${suffix}`;
    const milestoneId = `milestone_facts_${suffix}`;
    const obligationId = `obligation_facts_${suffix}`;
    const accountId = `account_facts_${suffix}`;
    const linkId = `link_facts_${suffix}`;
    t.after(async () => {
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
      [WS, WORLD, WORLDLINE, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (
         workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [WS, WORLD, WORLDLINE, linkId, projectId, storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence, title, status
       ) VALUES ($1, $2, $3, $4, $5, 1, 'First show', 'active')`,
      [WS, WORLD, WORLDLINE, milestoneId, projectId],
    );
    await owner.query(
      `INSERT INTO obligations (
         workspace_id, world_id, worldline_id, id, project_id, kind, status,
         principal_minor, outstanding_minor
       ) VALUES ($1, $2, $3, $4, $5, 'loan', 'open', 0, 0)`,
      [WS, WORLD, WORLDLINE, obligationId, projectId],
    );
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 5000)`,
      [WS, WORLD, WORLDLINE, accountId],
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
    const opened = await repository.reconcile({ workspaceId: WS, storyId, definition });
    assert.equal(opened.unlockedNodeKeys.includes("show"), true);
    assert.equal(opened.nodes.find((node) => node.nodeKey === "show")?.state, "active");
  },
);
