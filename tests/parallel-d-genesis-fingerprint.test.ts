import assert from "node:assert/strict";
import test from "node:test";
import type { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
type PoolClient = Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0];
import { GENESIS_LIMITS, genesisDraftFingerprint, normalizeGenesisDraft } from "../modules/application/world-genesis.ts";
import { createPostgresLibraryService, LibraryServiceError } from "../modules/application/library-service.ts";

const draft = normalizeGenesisDraft({ world: { name: "潮港" } })!;
// Captured from the reconciled, pre-correction production implementation.
const legacyDigest = "cd30eb20f47eaa2e3986c56c9e85d931186aecdff8002c84abff33a35f302a20";
const scope = { workspaceId: "workspace-d", principalId: "principal-d" };
const topology = { worldId: "world-d", storyId: "story-d", recordId: "record-d" };

function committedService(fingerprint: string) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    release() {},
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO genesis_creation_requests")) {
        assert.deepEqual(values?.slice(0, 3), [scope.workspaceId, scope.principalId, "request_d_123"]);
        return { rows: [] };
      }
      if (sql.includes("FROM genesis_creation_requests")) {
        assert.deepEqual(values, [scope.workspaceId, scope.principalId, "request_d_123"]);
        return { rows: [{ draft_fingerprint: fingerprint, state: "committed", world_id: topology.worldId, story_id: topology.storyId, record_id: topology.recordId }] };
      }
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT|SELECT (current_setting|set_config))/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  return { service: createPostgresLibraryService(client), calls };
}

test("D named request fingerprint binds the normalized name", () => {
  assert.notEqual(genesisDraftFingerprint({ ...draft, playerName: "霁川" }), genesisDraftFingerprint({ ...draft, playerName: "夜航" }));
  assert.notEqual(genesisDraftFingerprint({ ...draft, playerName: "霁川" }), legacyDigest);
});

test("D omitted/blank names preserve exact pre-correction digest bytes", () => {
  for (const playerName of [undefined, "", " \t\n "]) assert.equal(genesisDraftFingerprint({ ...draft, playerName }), legacyDigest);
});

test("D whitespace and length normalization match accepted actor-name semantics", () => {
  const name = "霁".repeat(GENESIS_LIMITS.playerName);
  assert.equal(genesisDraftFingerprint({ ...draft, playerName: `  ${name}尾  ` }), genesisDraftFingerprint({ ...draft, playerName: name }));
  assert.equal(genesisDraftFingerprint({ ...draft, playerName: "  霁川  " }), genesisDraftFingerprint({ ...draft, playerName: "霁川" }));
});

test("D same normalized named request replays only its principal-scoped saved topology", async () => {
  const { service, calls } = committedService(genesisDraftFingerprint({ ...draft, playerName: "霁川" }));
  assert.deepEqual(await service.createGenesis(scope, { ...draft, playerName: "  霁川  " }, { creationRequestId: "request_d_123" }), topology);
  assert.ok(!calls.some(({ sql }) => /accounts|character_definitions|record_first_nights/.test(sql)), "replay must not derive evidence from mutable names or mutate accounts");
});

test("D same key with a different name conflicts before account or topology writes", async () => {
  const { service, calls } = committedService(genesisDraftFingerprint({ ...draft, playerName: "霁川" }));
  await assert.rejects(service.createGenesis(scope, { ...draft, playerName: "夜航" }, { creationRequestId: "request_d_123" }), (e: unknown) => e instanceof LibraryServiceError && e.code === "GENESIS_REQUEST_CONFLICT");
  assert.ok(!calls.some(({ sql }) => /accounts|character_definitions|INSERT INTO worlds/.test(sql)));
});

for (const name of ["霁川", "夜航"]) test(`D pre-correction named receipt fails closed for ${name} without original input provenance`, async () => {
  // Even a matching resolved first-night/actor name cannot prove whether the
  // original request named it explicitly or omitted it and used the fallback.
  const { service, calls } = committedService(legacyDigest);
  await assert.rejects(service.createGenesis(scope, { ...draft, playerName: name }, { creationRequestId: "request_d_123" }), (e: unknown) => e instanceof LibraryServiceError && e.code === "GENESIS_REQUEST_CONFLICT");
  assert.ok(!calls.some(({ sql }) => /accounts|character_definitions|record_first_nights/.test(sql)));
});

test("D old unnamed request still replays its exact legacy receipt", async () => {
  const { service } = committedService(legacyDigest);
  assert.deepEqual(await service.createGenesis(scope, draft, { creationRequestId: "request_d_123" }), topology);
});
