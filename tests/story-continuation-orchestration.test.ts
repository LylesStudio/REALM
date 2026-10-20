/**
 * F1b unit coverage for the atomic command + Story continuation
 * orchestration helper: transaction/savepoint composition and safe route
 * error mapping. Real rollback semantics against PostgreSQL live in
 * tests/postgres-atomic-command-continuation.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceDatabase } from "../database/postgres/workspace-transaction.ts";
import {
  runCommandWithStoryContinuation,
  storyContinuationMeta,
  STORY_CONTINUATION_BLOCKED,
} from "../modules/application/story-graph-continuation.ts";
import { StoryGraphRepositoryError } from "../database/postgres/story-graph-repository.ts";
import { projectFinanceRouteError } from "../app/api/bridge/v1/project-finance-context.ts";

const SCOPE = { workspaceId: "ws_unit", worldId: "world_unit", worldlineId: "wl_unit" };

function stubPool(listing: "ok" | "fail"): { pool: WorkspaceDatabase; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("current_setting")) {
        return { rows: [{ workspace_id: SCOPE.workspaceId }] };
      }
      if (text.includes("FROM stories")) {
        if (listing === "fail") {
          throw new StoryGraphRepositoryError(
            "STORY_DEFINITION_CONFLICT",
            "Story Graph definition changed after runtime materialization.",
          );
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as WorkspaceDatabase;
  return { pool, calls };
}

test("new command + continuation failure rejects and rolls back the outer transaction", async () => {
  const { pool, calls } = stubPool("fail");
  await assert.rejects(
    runCommandWithStoryContinuation(pool, SCOPE, async () => ({
      result: { status: "committed" as const },
    })),
    (error: unknown) => error instanceof StoryGraphRepositoryError
      && error.code === "STORY_DEFINITION_CONFLICT",
  );
  assert.ok(calls.some((text) => text.trim() === "BEGIN"));
  assert.ok(calls.some((text) => text.trim() === "ROLLBACK"), "outer transaction must roll back");
  assert.ok(!calls.some((text) => text.trim() === "COMMIT"), "no commit after continuation failure");
});

test("new command + successful continuation commits once", async () => {
  const { pool, calls } = stubPool("ok");
  const outcome = await runCommandWithStoryContinuation(pool, SCOPE, async () => ({
    result: { status: "committed" as const },
  }));
  assert.equal(outcome.continuation.status, "applied");
  assert.ok(calls.some((text) => text.trim() === "COMMIT"));
  assert.ok(!calls.some((text) => text.trim() === "ROLLBACK"));
});

test("replayed historical receipt + continuation failure reports blocked after savepoint rollback", async () => {
  const { pool, calls } = stubPool("fail");
  const outcome = await runCommandWithStoryContinuation(pool, SCOPE, async () => ({
    result: { status: "replayed" as const, commandGroupId: "cg_unit" },
  }));
  assert.equal(outcome.command.result.status, "replayed");
  assert.deepEqual(outcome.continuation, { status: "blocked", code: STORY_CONTINUATION_BLOCKED });
  assert.ok(
    calls.some((text) => text.includes("ROLLBACK TO SAVEPOINT")),
    "the whole continuation savepoint rolls back",
  );
  assert.ok(calls.some((text) => text.trim() === "COMMIT"),
    "the historical receipt stays committed; only the continuation savepoint rolled back");
});

test("replayed historical receipt + successful continuation applies normally", async () => {
  const { pool, calls } = stubPool("ok");
  const outcome = await runCommandWithStoryContinuation(pool, SCOPE, async () => ({
    result: { status: "replayed" as const },
  }));
  assert.equal(outcome.continuation.status, "applied");
  assert.ok(calls.some((text) => text.trim() === "COMMIT"));
});

test("continuation metadata exposes real unlocks or the explicit blocked state", () => {
  assert.deepEqual(
    storyContinuationMeta({ status: "blocked", code: STORY_CONTINUATION_BLOCKED }),
    { storyContinuation: { status: "blocked", code: "STORY_CONTINUATION_BLOCKED" } },
  );
  assert.deepEqual(
    storyContinuationMeta({
      status: "applied",
      summary: { reconciledStoryIds: ["s1"], unlocks: [{ storyId: "s1", nodeKey: "n1", recordId: "r1" }] },
    }),
    { storyUnlocks: [{ storyId: "s1", nodeKey: "n1", recordId: "r1" }] },
  );
  assert.deepEqual(
    storyContinuationMeta({ status: "applied", summary: { reconciledStoryIds: [], unlocks: [] } }),
    {},
  );
});

test("route error mapping keeps Story continuation failures Story-specific and safe", async () => {
  const conflict = projectFinanceRouteError(
    new StoryGraphRepositoryError("STORY_DEFINITION_CONFLICT", "hash ffff at story_node_instances"),
  );
  assert.equal(conflict.status, 503);
  const conflictBody = await conflict.json() as { ok: false; error: { code: string; message: string } };
  assert.equal(conflictBody.ok, false);
  assert.equal(conflictBody.error.code, "STORY_DEFINITION_CONFLICT");
  assert.ok(!conflictBody.error.message.includes("story_node_instances"), "no SQL details leak");

  const missing = projectFinanceRouteError(
    new StoryGraphRepositoryError("STORY_DEFINITION_NOT_FOUND", "binding missing"),
  );
  assert.equal(missing.status, 503);
  const missingBody = await missing.json() as { error: { code: string } };
  assert.equal(missingBody.error.code, "STORY_DEFINITION_NOT_FOUND");

  const notFound = projectFinanceRouteError(
    new StoryGraphRepositoryError("STORY_NOT_FOUND", "no story"),
  );
  assert.equal(notFound.status, 404);
});
