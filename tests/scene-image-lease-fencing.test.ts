import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresSceneImageQueue } from "../database/postgres/scene-image-queue.ts";

test("lease claims advance a revision and stale settle operations cannot rewrite the new claim", async () => {
  const updates: Array<{ sql: string; values?: unknown[] }> = [];
  let lastClaimRevision = 0;
  const database = {
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
            || sql.includes("SELECT set_config('realm.workspace_id'")) {
            return { rows: [], rowCount: null };
          }
          if (sql.includes("SELECT world.status AS world_status")) {
            return { rows: [{ world_status: "active", record_status: "active" }], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO scene_image_requests")) {
            return { rows: [{
              id: "request-1", world_id: "world-1", record_id: "record-1", scene_id: "scene-1",
              principal_id: "principal-1", trigger_kind: "every_turn", source_event_id: "turn-1",
              status: "queued", generation_id: null, attempts: 0, lease_revision: 0,
            }], rowCount: 1 };
          }
          if (sql.includes("SELECT id, world_id, record_id, scene_id, principal_id")
            && sql.includes("AS request")) {
            return { rows: [{
              id: "request-1", world_id: "world-1", record_id: "record-1", scene_id: "scene-1",
              principal_id: "principal-1", trigger_kind: "every_turn", source_event_id: "turn-1",
              status: "queued", generation_id: null, attempts: 0, lease_revision: lastClaimRevision,
            }], rowCount: 1 };
          }
          if (sql.includes("UPDATE scene_image_requests") && sql.includes("SET status = 'leased'")) {
            lastClaimRevision += 1;
            return { rows: [{ id: "request-1", lease_revision: lastClaimRevision }], rowCount: 1 };
          }
          if (sql.includes("UPDATE scene_image_requests") && sql.includes("AND lease_revision = $")) {
            updates.push({ sql, values });
            return { rows: [], rowCount: values?.at(-1) === lastClaimRevision ? 1 : 0 };
          }
          throw new Error(`unexpected queue SQL: ${sql.replaceAll(/\s+/g, " ").trim()}`);
        },
        release() {},
      };
    },
  };
  const queue = createPostgresSceneImageQueue(database as never);
  const first = await queue.enqueue({
    workspaceId: "workspace-1", worldId: "world-1", recordId: "record-1", sceneId: "scene-1",
    principalId: "principal-1", triggerKind: "every_turn", sourceEventId: "turn-1",
  });
  assert.equal(first.request.leaseRevision, 0);
  const oldClaim = await queue.claim({ workspaceId: "workspace-1" }, { leaseMs: 1 });
  const newClaim = await queue.claim({ workspaceId: "workspace-1" }, { leaseMs: 1000 });
  assert.equal(oldClaim?.leaseRevision, 1);
  assert.equal(newClaim?.leaseRevision, 2);

  await queue.complete({ workspaceId: "workspace-1", id: "request-1", leaseRevision: 1 }, "generation-old");
  await queue.fail({ workspaceId: "workspace-1", id: "request-1", leaseRevision: 1 }, "STALE");
  await queue.retry({ workspaceId: "workspace-1", id: "request-1", leaseRevision: 1 });
  assert.equal(updates.length, 3);
  assert.ok(updates.every(({ sql }) => sql.includes("AND lease_revision = $")));

  await queue.complete({ workspaceId: "workspace-1", id: "request-1", leaseRevision: 2 }, "generation-new");
  assert.equal(updates.length, 4);
});

test("scene image worker fences every settle with the exact lease it claimed", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../modules/application/scene-image-worker-runtime.ts", import.meta.url), "utf8",
  );
  // M8：fence 贯穿 worker → service → store；ready/failed 终态在 service 内
  // 经 store.complete/failGenerationAndSettle 与 generation/文件同事务原子
  // 结算，worker 不得再绕过 fence 直接 settle 请求行。
  assert.match(source, /const fence = \{ requestId: request\.id, leaseRevision: request\.leaseRevision \}/);
  assert.match(source, /service\.dispatchAndStoreSceneImage\([\s\S]{0,200}\{ fence \}/);
  assert.match(source, /sceneImageStore\.failGenerationAndSettle\([\s\S]{0,160}fence/);
  assert.match(source, /queue\.retry\(\{ workspaceId, id: request\.id, leaseRevision: request\.leaseRevision \}\)/);
  assert.match(source, /queue\.fail\([\s\S]{0,120}leaseRevision: request\.leaseRevision/);
  assert.ok(!source.includes("queue.complete("), "worker 不得绕过 fence 直接 complete 请求行");
});
