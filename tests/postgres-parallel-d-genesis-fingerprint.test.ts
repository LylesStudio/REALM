import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { createPostgresLibraryService, LibraryServiceError } from "../modules/application/library-service.ts";
import { genesisDraftFingerprint, normalizeGenesisDraft } from "../modules/application/world-genesis.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

installTestSessionSecret();

test("D actual PG named replay, legacy refusal, immutable resolved-name ambiguity and principal isolation", {
  skip: !process.env.DATABASE_URL || !process.env.REALM_SCRATCH_POSTGRES_CONTAINER,
  timeout: 120_000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  const client = await pool.connect();
  const ended = once(client, "end");
  try {
    await client.query("BEGIN");
    const workspaceId = POSTGRES_DEMO_IDS.workspace;
    await client.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceId]);
    await seedCapabilitySessionKey(client, workspaceId);
    const suffix = randomUUID().replaceAll("-", "");
    const principalId = `principal_parallel_d_${suffix}`;
    const otherPrincipal = `principal_parallel_d_other_${suffix}`;
    await client.query("INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES ($1,$2,$3),($1,$4,$5)",
      [workspaceId, principalId, `Account D ${suffix}`, otherPrincipal, `Other D ${suffix}`]);
    await client.query("SET LOCAL ROLE realm_runtime");
    const scope = { workspaceId, principalId, sessionProof: sessionProofFor(principalId) };
    const service = createPostgresLibraryService(client);
    const draft = normalizeGenesisDraft({ world: { name: "D isolated harbor" }, playerName: "霁川" })!;
    const request = `parallel_d_${suffix}`;
    const first = await service.createGenesis(scope, draft, { creationRequestId: request });
    assert.deepEqual(await service.createGenesis(scope, { ...draft, playerName: "  霁川  " }, { creationRequestId: request }), first);
    await assert.rejects(service.createGenesis(scope, { ...draft, playerName: "夜航" }, { creationRequestId: request }),
      (e: unknown) => e instanceof LibraryServiceError && e.code === "GENESIS_REQUEST_CONFLICT");
    const other = await service.createGenesis({ workspaceId, principalId: otherPrincipal, sessionProof: sessionProofFor(otherPrincipal) },
      { ...draft, playerName: "其他玩家" }, { creationRequestId: request });
    assert.notEqual(other.worldId, first.worldId, "same lexical request key cannot replay another principal's receipt");
    await service.create(scope, { kind: "record", storyId: first.storyId, title: "D continued" });
    const names = await client.query(`SELECT definition.display_name FROM character_definitions definition
      JOIN character_continuities continuity ON continuity.workspace_id=definition.workspace_id AND continuity.definition_id=definition.id
      JOIN character_instances instance ON instance.workspace_id=continuity.workspace_id AND instance.continuity_id=continuity.id
      JOIN participants seat ON seat.workspace_id=instance.workspace_id AND seat.character_instance_id=instance.id
      WHERE seat.workspace_id=$1 AND seat.world_id=$2 AND seat.principal_id=$3 AND seat.controller_mode='human'`,
    [workspaceId, first.worldId, principalId]);
    assert.ok(names.rows.length >= 2);
    assert.ok(names.rows.every((row) => row.display_name === "霁川"));
    const account = await client.query("SELECT display_name FROM accounts WHERE workspace_id=$1 AND principal_id=$2", [workspaceId, principalId]);
    assert.equal(account.rows[0].display_name, `Account D ${suffix}`);
    // Fixture-only old receipt: retain the original creation context and actor,
    // but replace the stored digest with the genuine pre-correction encoding.
    await client.query("RESET ROLE");
    await client.query("UPDATE genesis_creation_requests SET draft_fingerprint=$4 WHERE workspace_id=$1 AND principal_id=$2 AND creation_request_id=$3",
      [workspaceId, principalId, request, genesisDraftFingerprint({ ...draft, playerName: undefined })]);
    const context = await client.query("SELECT context->>'playerName' AS name FROM record_first_nights WHERE workspace_id=$1 AND record_id=$2", [workspaceId, first.recordId]);
    assert.equal(context.rows[0].name, "霁川");
    await client.query("SET LOCAL ROLE realm_runtime");
    for (const playerName of ["霁川", "夜航"]) await assert.rejects(service.createGenesis(scope, { ...draft, playerName }, { creationRequestId: request }),
      (e: unknown) => e instanceof LibraryServiceError && e.code === "GENESIS_REQUEST_CONFLICT");
    const unnamed = { ...draft, playerName: undefined };
    const unnamedRequest = `unnamed_d_${suffix}`;
    const oldUnnamed = await service.createGenesis(scope, unnamed, { creationRequestId: unnamedRequest });
    assert.deepEqual(await service.createGenesis(scope, { ...unnamed, playerName: "  " }, { creationRequestId: unnamedRequest }), oldUnnamed);
  } finally {
    await client.query("ROLLBACK"); // Entire fixture cohort, including all owned worlds, is discarded.
    client.release();
    await pool.end();
    await ended; // Real client-end gate, not pool bookkeeping.
  }
});
