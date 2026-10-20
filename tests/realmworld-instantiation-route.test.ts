import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/realmworld/instantiate/route.ts";

async function responseError(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  return body.error;
}

test("RealmWorld instantiate route requires an idempotency key before runtime access", async () => {
  const response = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worldId: "world_harbor", worldVersion: "1.2.0" }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await responseError(response), {
    code: "INVALID_IDEMPOTENCY_KEY",
    message: "idempotency-key is required.",
  });
});

test("RealmWorld instantiate route rejects malformed content identity and locale", async () => {
  const identityResponse = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route-fixture",
    },
    body: JSON.stringify({ worldId: "world harbor", worldVersion: "1.2.0" }),
  }));
  assert.equal(identityResponse.status, 400);
  assert.equal((await responseError(identityResponse)).code, "INVALID_REQUEST");

  const localeResponse = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route-fixture-locale",
    },
    body: JSON.stringify({ worldId: "world_harbor", worldVersion: "1.2.0", locale: "zh_CN" }),
  }));
  assert.equal(localeResponse.status, 400);
  assert.equal((await responseError(localeResponse)).code, "INVALID_REQUEST");
});

// Actual public Library -> private genesis -> command policy materializer.
// SQL protocol simulation proves application transaction composition, not PG enforcement.
function a2InstallProtocol(failTable?: string) {
  let state: Record<string, Record<string, unknown>[]> = {}, saved = structuredClone(state), active = false;
  let transaction = 0, acquired = 0, released = 0;
  const calls: { sql: string; values: unknown[]; transaction: number }[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const known = new Set<string>();
  const client = { release() { released++; }, async query(raw: string, values: unknown[] = []) {
    const sql = norm(raw); calls.push({ sql, values: structuredClone(values), transaction });
    const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
    if (sql === "BEGIN" || sql === "BEGIN READ ONLY") { assert.equal(active, false); active = true; saved = structuredClone(state); transaction++; return result([]); }
    if (sql === "COMMIT") { assert.equal(active, true); active = false; return result([]); }
    if (sql === "ROLLBACK") { state = structuredClone(saved); active = false; return result([]); }
    assert.ok(active, "all SQL runs inside the acquired transaction");
    if (!known.has(sql)) throw Error("UNKNOWN_A2_INSTALL_SQL:" + sql);
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") return result([]);
    if (sql.startsWith("SELECT membership_capability_grant(")) return result([]);
    if (sql === "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available") { assert.deepEqual(values, []); return result([{ command_materializations_available: true }]); }
    if (sql.startsWith("SELECT schema_version, world_version, content_hash, policy_version,")) return result((state.realmworld_command_materializations ?? []).filter(r => r.workspace_id === values[0] && r.world_id === values[1] && r.worldline_id === values[2]).toReversed());
    if (sql.startsWith("SELECT world_id, worldline_id, story_id FROM records")) return result((state.records ?? []).filter(r => r.workspace_id === values[0] && r.id === values[1]));
    if (sql.startsWith("SELECT world_version, status FROM worlds")) return result((state.worlds ?? []).filter(r => r.workspace_id === values[0] && r.id === values[1]));
    if (sql.startsWith("SELECT settings->>'style' AS style FROM worlds")) return result([{ style: "modern" }]);
    if (sql.startsWith("SELECT definition.display_name,")) return result([]);
    if (sql.startsWith("SELECT display_name FROM accounts")) return result([{ display_name: "Synthetic player" }]);
    if (sql.startsWith("SELECT id FROM character_continuities")) return result([]);
    if (sql.startsWith("SELECT skill_key, id FROM skill_definitions")) return result((state.skill_definitions ?? []).filter(r => r.workspace_id === values[0] && r.world_id === values[1]));
    for (const table of ["asset_definitions", "effect_definitions"]) if (sql.startsWith(`SELECT id FROM ${table}`)) return result((state[table] ?? []).filter(r => r.workspace_id === values[0] && r.world_id === values[1]));
    if (sql.startsWith("SELECT EXISTS (") && sql.includes("table_name = 'scenes'")) return result([{ exists: true }]);
    if (sql.startsWith("SELECT head_tick, head_ordinal FROM worldlines")) return result((state.worldlines ?? []).filter(r => r.workspace_id === values[0] && r.id === values[1]));
    const insert = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*?)\)(?: ON CONFLICT .*?)?$/.exec(sql);
    if (insert) {
      if (insert[1] === failTable) throw Error("A2_INSTALL_INJECTED_FAILURE");
      const columns = insert[2].split(",").map(s => s.trim());
      const terms = insert[3].split(",").map(s => s.trim()); assert.equal(columns.length, terms.length);
      const row = Object.fromEntries(columns.map((column, i) => {
        const term = terms[i], parameter = /^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(term);
        if (parameter) { const value = values[Number(parameter[1]) - 1]; return [column, term.endsWith("::jsonb") ? JSON.parse(String(value)) : value]; }
        if (term === "NULL") return [column, null];
        if (term === "CURRENT_TIMESTAMP") return [column, "synthetic-server-time"];
        if (/^'.*'(?:::\w+)?$/.test(term)) return [column, term.replace(/::\w+$/, "").slice(1, -1)];
        if (/^\d+$/.test(term)) return [column, Number(term)];
        if (["true", "false"].includes(term)) return [column, term === "true"];
        throw Error("UNKNOWN_A2_INSTALL_TERM:" + term);
      }));
      (state[insert[1]] ??= []).push(row); return result([row]);
    }
    if (sql.startsWith("UPDATE record_heads SET record_version = 1,")) {
      const head = state.record_heads.find(r => r.workspace_id === values[0] && r.record_id === values[1])!;
      Object.assign(head, { record_version: 1, next_record_ordinal: 2, last_event_id: values[2] }); return result([]);
    }
    if (sql.startsWith("UPDATE worldlines SET head_tick = 0,")) {
      const line = state.worldlines.find(r => r.workspace_id === values[0] && r.id === values[1])!;
      Object.assign(line, { head_tick: 0, head_ordinal: 1 }); return result([]);
    }
    throw Error("UNHANDLED_A2_INSTALL_SQL:" + sql);
  } };
  return { known, database: { connect: async () => { acquired++; return client; } }, calls, snapshot: () => structuredClone(state), counts: () => ({ acquired, released }) };
}

test("A2 public Library installs mounted signed policy in genesis transaction and rolls back every installation stage", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { generateKeyPairSync, verify, createHash } = await import("node:crypto");
  const { installSignedRealmWorldFixture, syntheticCommandPolicyFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { createInstalledRealmWorldInstantiationResolver } = await import("../modules/world-transfer/realmworld-runtime-content.ts");
  const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  const { createPostgresLibraryService } = await import("../modules/application/library-service.ts");
  const directory = await mkdtemp(join(tmpdir(), "a2-library-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  await installSignedRealmWorldFixture({ installRoot: directory, worldId: "world-a2", version: "1.2.0", recordTitle: "record_literal_source_id", sceneObjective: "project_literal_source_id", keyId: "test", keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() }, commandPolicy: syntheticCommandPolicyFixture(), declaredEvents: ["synthetic.ready"] });
  const verifier = { installRoot: directory, verifySignature: ({ manifest }: { manifest: import("../modules/world-transfer/realmworld-manifest.ts").RealmWorldManifestV1 }) => verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) };
  const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver(verifier);
  const plan = (await createInstalledRealmWorldInstantiationResolver({ ...verifier, locale: "en" })({ kind: "world", worldId: "world-a2", worldVersion: "1.2.0" }))!;
  const policy = (await resolveCommandPolicy(plan.binding))!;
  function fixture(failTable?: string) {
    const f = a2InstallProtocol(failTable);
    for (const lock of ["FOR KEY SHARE", "FOR UPDATE"]) f.known.add(`SELECT world_version, status FROM worlds WHERE workspace_id = $1 AND id = $2 ${lock}`);
    for (const file of ["../modules/application/library-service.ts", "../modules/application/base-rule-definitions.ts", "../database/postgres/business-command-policy.ts", "../database/postgres/membership-capability.ts", "../database/postgres/workspace-transaction.ts"]) {
      for (const m of readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) if (!m[1].includes("${")) f.known.add(m[1].replace(/\s+/g, " ").trim());
    }
    return f;
  }
  const scope = { workspaceId: "a2-install-ws", principalId: "a2-owner", sessionProof: "strict-protocol-proof" };
  await t.test("successful materialization and exact replay", async () => {
    const f = fixture(), service = createPostgresLibraryService(f.database as never, undefined, { resolveCommandPolicy });
    const installed = await service.instantiateRealmWorld(scope, plan, "install-a2"); assert.equal(installed.replayed, false);
    const state = f.snapshot(), rows = state.realmworld_command_materializations; assert.equal(rows.length, 2);
    assert.equal(state.projects.length, 1); assert.equal(state.project_milestones.length, 2); assert.equal(state.project_story_links.length, 1);
    const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
    const projectId = "project_realm_" + hash(["realmworld-project:v1", scope.workspaceId, installed.worldId, installed.worldlineId, policy.contentHash, "p"]);
    for (const row of rows) {
      assert.equal(row.project_id, projectId); assert.equal(row.story_id, installed.storyId); assert.equal(row.record_id, installed.recordId);
      assert.equal(row.content_hash, policy.contentHash); assert.equal(row.milestone_id, "milestone_realm_" + hash(["realmworld-milestone:v1", scope.workspaceId, installed.worldId, installed.worldlineId, policy.contentHash, "p", String(row.milestone_key)]));
    }
    const writeTransactions = new Set(f.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql)).map(c => c.transaction)); assert.equal(writeTransactions.size, 1);
    const before = f.snapshot(), writes = f.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql)).length;
    assert.equal((await service.instantiateRealmWorld(scope, plan, "install-a2")).replayed, true);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql)).length, writes);
    assert.deepEqual(f.counts().acquired, f.counts().released);
  });
  await t.test("independent workspaces and independent instances preserve authored identity with disjoint runtime IDs", async () => {
    const f = fixture(), service = createPostgresLibraryService(f.database as never, undefined, { resolveCommandPolicy });
    const requests = [
      { scope, key: "isolated-first" },
      { scope, key: "isolated-second" },
      { scope: { ...scope, workspaceId: "a2-other-workspace" }, key: "isolated-first" },
    ];
    const installed = [];
    for (const request of requests) installed.push(await service.instantiateRealmWorld(request.scope, plan, request.key));
    const state = f.snapshot();
    for (const field of ["worldlineId", "storyId", "recordId"] as const) assert.equal(new Set(installed.map(r => r[field])).size, 3);
    const sets = installed.map((result, i) => {
      const rows = state.realmworld_command_materializations.filter(r => r.workspace_id === requests[i]!.scope.workspaceId && r.worldline_id === result.worldlineId);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(r => [r.project_key, r.milestone_key]).sort(), [["p", "prior"], ["p", "target"]]);
      for (const row of rows) {
        assert.equal(row.content_hash, policy.contentHash); assert.equal(row.world_version, "1.2.0"); assert.equal(row.policy_version, policy.policyVersion);
        assert.equal(row.story_id, result.storyId); assert.equal(row.record_id, result.recordId);
        const project = state.projects.find(p => p.workspace_id === row.workspace_id && p.id === row.project_id)!;
        const milestone = state.project_milestones.find(m => m.workspace_id === row.workspace_id && m.id === row.milestone_id)!;
        assert.equal(project.worldline_id, result.worldlineId); assert.equal(milestone.project_id, project.id);
        assert.ok(state.project_story_links.some(l => l.workspace_id === row.workspace_id && l.project_id === project.id && l.story_id === result.storyId && l.link_kind === "primary"));
      }
      return new Set(rows.flatMap(r => [r.project_id, r.milestone_id]));
    });
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) assert.equal([...sets[i]!].some(id => sets[j]!.has(id)), false);
    const before = f.snapshot();
    for (const request of requests) assert.equal((await service.instantiateRealmWorld(request.scope, plan, request.key)).replayed, true);
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.counts().acquired, f.counts().released);
  });
  for (const purpose of ["record-export", "whole-closure-backup"] as const) await t.test(`populated signed ${purpose} public two-generation ZIP transport`, async st => {
    const { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
    const { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } = await import("../modules/world-transfer/realm-runtime-save.ts");
    const f = fixture(), installed = await createPostgresLibraryService(f.database as never, undefined, { resolveCommandPolicy }).instantiateRealmWorld(scope, plan, `transport-${purpose}`);
    let protocol = await a2TransportProtocol(f.snapshot());
    const { createProjectFinanceCommandService } = await import("../modules/application/project-finance-command.ts");
    const { createPostgresProjectFinanceCommandStore } = await import("../database/postgres/project-finance-command-repository.ts");
    const commandService = (p: typeof protocol, resolver = resolveCommandPolicy) => createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(p.database as never, { resolveCommandPolicy: resolver }) });
    const installedState = protocol.snapshot(), map = installedState.realmworld_command_materializations;
    const sourceScene = installedState.scenes.find(r => r.record_id === installed.recordId)!;
    const commandScope = { workspaceId: scope.workspaceId, worldId: installed.worldId, worldlineId: installed.worldlineId };
    const prior = map.find(r => r.milestone_key === "prior")!, target = map.find(r => r.milestone_key === "target")!;
    const priorIntent = { scope: commandScope, projectId: String(prior.project_id), milestoneId: String(prior.milestone_id), expectedProjectVersion: 1, idempotencyKey: "historical-metadata-free",
      evidence: { recordId: installed.recordId, sceneId: String(sourceScene.id), visibility: "public" as const, expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } } };
    const targetIntent = { ...priorIntent, milestoneId: String(target.milestone_id), expectedProjectVersion: 2, idempotencyKey: "signed-policy-target", semanticEventKey: "synthetic.ready",
      evidence: { ...priorIntent.evidence, expectedWorldCursor: { worldTick: 0, worldOrdinal: 2 } } };
    const commands = commandService(protocol);
    assert.equal((await commands.confirmMilestone(priorIntent)).status, "committed");
    for (const [name, mutate] of [
      ["private supporting Event", (state: ReturnType<typeof protocol.snapshot>) => { const support = state.events.find(e => e.event_kind === "project.milestone.confirmed")!; state.visibility_policies.push({ ...state.visibility_policies.find(v => v.id === support.visibility_policy_id)!, id: "private-support-policy", policy_kind: "private" }); support.visibility_policy_id = "private-support-policy"; }],
      ["foreign Record supporting Event", (state: ReturnType<typeof protocol.snapshot>) => { state.events.find(e => e.event_kind === "project.milestone.confirmed")!.record_id = "foreign-record"; }],
      ["foreign worldline supporting Event", (state: ReturnType<typeof protocol.snapshot>) => { state.events.find(e => e.event_kind === "project.milestone.confirmed")!.worldline_id = "foreign-line"; }],
    ] as const) await st.test(name, async () => {
      const seed = protocol.snapshot(); mutate(seed); const negative = await a2TransportProtocol(seed), before = negative.snapshot();
      await assert.rejects(commandService(negative).confirmMilestone(targetIntent), { code: "BUSINESS_PRECONDITION_FAILED" });
      assert.deepEqual(negative.snapshot(), before); assert.equal(negative.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
    });
    assert.equal((await commands.confirmMilestone(targetIntent)).status, "committed");
    const accepted = protocol.snapshot().project_finance_command_groups;
    assert.equal("requestPolicy" in (accepted.find(g => g.idempotency_key === priorIntent.idempotencyKey)!.result_manifest as { result: object }).result, false);
    const signedMetadata = (accepted.find(g => g.idempotency_key === targetIntent.idempotencyKey)!.result_manifest as { result: { requestPolicy: object } }).result.requestPolicy;
    const badMetadata: [string, unknown][] = [["null metadata", null], ["array metadata", []], ["unknown runtime identity member", { ...signedMetadata, recordId: installed.recordId }], ["unsupported metadata schema", { ...signedMetadata, schemaVersion: 2 }], ["malformed content hash", { ...signedMetadata, contentHash: "A".repeat(64) }], ["invalid policy key", { ...signedMetadata, policyVersion: "../policy" }], ["invalid binding key", { ...signedMetadata, bindingKey: " " }]];
    for (const key of ["schemaVersion", "contentHash", "policyVersion", "bindingKey"]) { const missing = { ...signedMetadata }; Reflect.deleteProperty(missing, key); badMetadata.push([`missing metadata ${key}`, missing]); }
    for (const [name, metadata] of badMetadata) await st.test(`stored receipt decoder ${name}`, async () => {
      const seed = protocol.snapshot(), row = seed.project_finance_command_groups.find(g => g.idempotency_key === targetIntent.idempotencyKey)!;
      (row.result_manifest as { result: { requestPolicy: unknown } }).result.requestPolicy = metadata;
      const negative = await a2TransportProtocol(seed), before = negative.snapshot(); let resolverCalls = 0;
      await assert.rejects(commandService(negative, async () => { resolverCalls++; throw Error("DECODER_MUST_PRECEDE_POLICY"); }).confirmMilestone(targetIntent), { code: "IDEMPOTENCY_KEY_REUSE" });
      assert.equal(resolverCalls, 0); assert.deepEqual(negative.snapshot(), before); assert.equal(negative.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
    });
    // Historical result-only storage fixture: retain the genuinely accepted
    // result and fingerprint verbatim. The full original input stays above;
    // neither the reader nor replay receives a manufactured canonical intent.
    const historicalState = protocol.snapshot();
    const historical = historicalState.project_finance_command_groups.find(g => g.idempotency_key === priorIntent.idempotencyKey)!;
    const acceptedFingerprint = historical.request_fingerprint;
    historical.result_manifest = (historical.result_manifest as { result: object }).result;
    // Descriptive fixture literals deliberately equal real mapped runtime IDs.
    // Their JSON positions are not typed domain references or policy authority.
    const opening = historicalState.events.find(e => e.event_kind === "narration.committed")!;
    opening.content = prior.project_id;
    opening.payload = { ...(opening.payload as Record<string, unknown>), literalMap: { projectId: prior.project_id, milestoneId: prior.milestone_id } };
    const firstNight = historicalState.record_first_nights.find(r => r.record_id === installed.recordId)!;
    firstNight.context = { ...(firstNight.context as Record<string, unknown>), literalMap: { projectId: prior.project_id, recordId: installed.recordId } };
    protocol = await a2TransportProtocol(historicalState);
    assert.equal(protocol.snapshot().project_finance_command_groups.find(g => g.idempotency_key === priorIntent.idempotencyKey)!.request_fingerprint, acceptedFingerprint);
    const nativeOffline = commandService(protocol, async () => { throw Error("NATIVE_PACKAGE_OFFLINE"); });
    assert.equal((await nativeOffline.confirmMilestone(priorIntent)).status, "replayed");
    const previous = process.env.REALM_OPERATOR_PRINCIPALS; process.env.REALM_OPERATOR_PRINCIPALS = scope.principalId;
    try {
      const reader = createPostgresRealmRuntimeSaveReader(protocol.database as never);
      const load = async (workspaceId: string, recordId: string) => {
        const data = await reader.load({ workspaceId, recordId, principalId: scope.principalId, purpose }); assert.ok(data);
        const bytes = buildRealmRuntimeSaveArchive(data); assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), "PK");
        return parseRealmRuntimeSaveArchive(bytes);
      };
      let archive = await load(scope.workspaceId, installed.recordId);
      assert.equal(archive.domain!.commandMaterializations!.rows.length, 2);
      const { realmRuntimeSaveManifestFromData } = await import("../modules/world-transfer/realm-runtime-save.ts");
      const negativeArchive = (mutate: (a: typeof archive) => void) => { const copy = structuredClone(archive); mutate(copy); return copy; };
      for (const [name, resolver, candidate, code] of [
        ["missing policy resolver despite no-op binding validator", undefined, archive, "REALMWORLD_VALIDATION_UNAVAILABLE"],
        ["no-op resolver", async () => null, archive, "REALMWORLD_PACKAGE_UNTRUSTED"],
        ["copied policy is not mounted authority", async () => ({ ...policy }), archive, "REALMWORLD_PACKAGE_UNTRUSTED"],
        ["wrong content hash", resolveCommandPolicy, negativeArchive(a => { a.domain!.commandMaterializations!.contentHash = "0".repeat(64); }), "REALMWORLD_PACKAGE_UNTRUSTED"],
        ["wrong policy version", resolveCommandPolicy, negativeArchive(a => { a.domain!.commandMaterializations!.policyVersion = "wrong.v1"; }), "REALMWORLD_PACKAGE_UNTRUSTED"],
        ["wrong exact version", resolveCommandPolicy, negativeArchive(a => { a.domain!.commandMaterializations!.worldVersion = "1.2.1"; }), "RUNTIME_SAVE_INVALID"],
        ["incomplete authored map", resolveCommandPolicy, negativeArchive(a => { a.domain!.commandMaterializations!.rows.pop(); }), "REALMWORLD_PACKAGE_UNTRUSTED"],
        ["foreign Record map closure", resolveCommandPolicy, negativeArchive(a => { for (const r of a.domain!.commandMaterializations!.rows) r.recordId = "foreign-record"; }), "RUNTIME_SAVE_INVALID"],
        ["foreign Project map closure", resolveCommandPolicy, negativeArchive(a => { for (const r of a.domain!.commandMaterializations!.rows) r.projectId = "foreign-project"; }), "RUNTIME_SAVE_INVALID"],
      ] as const) await st.test(name, async () => {
        const negative = await a2TransportProtocol(f.snapshot());
        await assert.rejects(createPostgresRealmRuntimeSaveRestorer(negative.database as never, { validateWorldBinding: async () => {}, resolveCommandPolicy: resolver }).restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, targetWorldId: installed.worldId, archive: candidate, idempotencyKey: "negative" }), { code });
        assert.equal(negative.calls.length, 0, "earliest archive/trust boundary precedes database acquisition");
      });
      for (const [name, options, expected] of [
        ["target missing map schema", { capabilityRows: [{ command_materializations_available: false }] }, "RUNTIME_SAVE_INVALID"],
        ["malformed capability", { capabilityRows: [{ command_materializations_available: "true" }] }, "BUSINESS_POLICY_MISSING"],
        ["capability query error", { capabilityError: true }, "A2_CAPABILITY_QUERY_ERROR"],
      ] as const) await st.test(name, async () => {
        const negative = await a2TransportProtocol(f.snapshot(), options);
        await assert.rejects(createPostgresRealmRuntimeSaveRestorer(negative.database as never, { resolveCommandPolicy, validateWorldBinding: async () => {} }).restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, targetWorldId: installed.worldId, archive, idempotencyKey: "negative-schema" }), expected.startsWith("A2_") ? new RegExp(expected) : { code: expected });
        assert.equal(negative.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false); assert.equal(negative.calls.at(-1)!.sql, "ROLLBACK");
      });
      const restorer = createPostgresRealmRuntimeSaveRestorer(protocol.database as never, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
      // A second workspace has the same exact installed package World identity.
      const targetWorkspace = "a2-transport-other-workspace";
      const targetInstall = fixture();
      await createPostgresLibraryService(targetInstall.database as never, undefined, { resolveCommandPolicy }).instantiateRealmWorld({ ...scope, workspaceId: targetWorkspace }, plan, "target-context");
      const targetProtocol = await a2TransportProtocol(targetInstall.snapshot());
      const targetRestorer = createPostgresRealmRuntimeSaveRestorer(targetProtocol.database as never, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
      const first = await targetRestorer.restore({ workspaceId: targetWorkspace, principalId: scope.principalId, targetWorldId: installed.worldId, archive, idempotencyKey: "a2-first-generation" });
      assert.notEqual(first.recordId, installed.recordId);
      const firstState = targetProtocol.snapshot();
      assert.equal((await targetRestorer.restore({ workspaceId: targetWorkspace, principalId: scope.principalId, targetWorldId: installed.worldId, archive, idempotencyKey: "a2-first-generation" })).replayed, true);
      assert.deepEqual(targetProtocol.snapshot(), firstState);
      const firstData = await createPostgresRealmRuntimeSaveReader(targetProtocol.database as never).load({ workspaceId: targetWorkspace, recordId: first.recordId, principalId: scope.principalId, purpose }); assert.ok(firstData);
      const again = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(firstData));
      const sorted = (a: typeof archive) => a.domain!.commandMaterializations!.rows.map(r => [r.projectKey, r.milestoneKey]).sort();
      assert.deepEqual(sorted(again), sorted(archive));
      for (const key of ["worldVersion", "contentHash", "policyVersion"] as const) assert.equal(again.domain!.commandMaterializations![key], archive.domain!.commandMaterializations![key]);
      // Build explicit typed bijections from authored keys and stable event coordinates.
      // No source request fields are taken from stored receipt manifests.
      const typedMaps = (from: typeof archive, to: typeof archive) => {
        const maps = Object.fromEntries(["project", "milestone", "story", "record", "event", "participant", "scene"].map(k => [k, new Map<string, string>()])) as Record<"project" | "milestone" | "story" | "record" | "event" | "participant" | "scene", Map<string, string>>;
        const bind = (kind: keyof typeof maps, source: string, target: string) => {
          const map = maps[kind]; assert.ok(!map.has(source) || map.get(source) === target);
          assert.ok(![...map].some(([s, t]) => s !== source && t === target)); map.set(source, target); assert.notEqual(source, target);
        };
        for (const row of from.domain!.commandMaterializations!.rows) {
          const match = to.domain!.commandMaterializations!.rows.find(r => r.projectKey === row.projectKey && r.milestoneKey === row.milestoneKey)!; assert.ok(match);
          bind("project", row.projectId, match.projectId); bind("milestone", row.milestoneId, match.milestoneId); bind("story", row.storyId, match.storyId); bind("record", row.recordId, match.recordId);
        }
        for (const event of from.record.events) {
          const match = to.record.events.find(e => e.kind === event.kind && e.ordinal === event.ordinal && e.recordVersion === event.recordVersion)!; assert.ok(match); bind("event", event.eventId, match.eventId);
        }
        for (const participant of from.topology!.participants) {
          const match = to.topology!.participants.find(p => p.participantKind === participant.participantKind && p.speakingOrder === participant.speakingOrder && p.character?.continuity.continuityKey === participant.character?.continuity.continuityKey)!;
          assert.ok(match); bind("participant", participant.sourceParticipantId, match.sourceParticipantId);
        }
        for (const scene of from.topology!.scenes) {
          const match = to.topology!.scenes.find(s => s.title === scene.title && s.startTick === scene.startTick && s.startOrdinal === scene.startOrdinal)!; assert.ok(match); bind("scene", scene.sourceSceneId, match.sourceSceneId);
        }
        assert.equal(maps.project.size, from.domain!.projects.length); assert.equal(maps.milestone.size, from.domain!.milestones.length);
        assert.equal(maps.event.size, from.record.events.length); assert.equal(maps.participant.size, from.topology!.participants.length);
        for (const milestone of from.domain!.milestones) {
          const mapped = to.domain!.milestones.find(m => m.id === maps.milestone.get(milestone.id))!;
          assert.equal(mapped.projectId, maps.project.get(milestone.projectId));
          assert.equal(mapped.completionEventId, milestone.completionEventId === null ? null : maps.event.get(milestone.completionEventId));
          assert.equal(mapped.completionRecordId, milestone.completionRecordId === null ? null : maps.record.get(milestone.completionRecordId));
        }
        for (const event of from.record.events) {
          const body = event.payload as Record<string, unknown>, targetBody = to.record.events.find(e => e.eventId === maps.event.get(event.eventId))!.payload as Record<string, unknown>;
          assert.equal(targetBody.content, body.content); assert.equal(targetBody.actorParticipantId, body.actorParticipantId === null ? null : maps.participant.get(String(body.actorParticipantId)));
          if (event.kind === "narration.committed") assert.deepEqual((targetBody.eventPayload as Record<string, unknown>).literalMap, (body.eventPayload as Record<string, unknown>).literalMap);
          if (event.kind === "project.milestone.confirmed") {
            const payload = body.eventPayload as Record<string, unknown>, mapped = targetBody.eventPayload as Record<string, unknown>;
            assert.equal(mapped.projectId, maps.project.get(String(payload.projectId))); assert.equal(mapped.milestoneId, maps.milestone.get(String(payload.milestoneId)));
          }
        }
        for (const field of ["worldVersion", "contentHash", "policyVersion"] as const) assert.equal(to.domain!.commandMaterializations![field], from.domain!.commandMaterializations![field]);
        for (const key of [priorIntent.idempotencyKey, targetIntent.idempotencyKey]) {
          const source = from.domain!.financeCommandGroups.find(g => g.idempotencyKey === key)!, target = to.domain!.financeCommandGroups.find(g => g.idempotencyKey === key)!;
          if (key === priorIntent.idempotencyKey) assert.equal(target.requestFingerprint, acceptedFingerprint);
          const sourceResult = (source.resultManifest.result ?? source.resultManifest) as Record<string, unknown>;
          const targetResult = (target.resultManifest.result ?? target.resultManifest) as Record<string, unknown>;
          assert.deepEqual(targetResult.requestPolicy, sourceResult.requestPolicy);
          if (key === priorIntent.idempotencyKey) assert.equal(sourceResult.requestPolicy, undefined);
        }
        assert.deepEqual(to.firstNight!.entry!.context, from.firstNight!.entry!.context);
        assert.ok(JSON.stringify(to.firstNight!.entry!.context).includes("project_literal_source_id"));
        return maps;
      };
      const replayOriginalIntents = async (p: typeof protocol, from: typeof archive, to: typeof archive, workspaceId: string) => {
        const maps = typedMaps(from, to), before = p.snapshot(), callStart = p.calls.length;
        let resolverCalls = 0;
        const offline = commandService(p, async () => { resolverCalls++; throw Error("A2_PACKAGE_OFFLINE"); });
        for (const acceptedIntent of [priorIntent, targetIntent]) {
          const remapped = { ...acceptedIntent, scope: { ...acceptedIntent.scope, workspaceId, worldlineId: to.record.scope.worldlineId },
            projectId: maps.project.get(acceptedIntent.projectId)!, milestoneId: maps.milestone.get(acceptedIntent.milestoneId)!,
            evidence: { ...acceptedIntent.evidence, recordId: maps.record.get(acceptedIntent.evidence.recordId)!, sceneId: maps.scene.get(acceptedIntent.evidence.sceneId)! } };
          assert.equal((await offline.confirmMilestone(remapped)).status, "replayed");
          for (const change of [{ expectedProjectVersion: remapped.expectedProjectVersion + 1 }, { projectId: "changed-project" }, { milestoneId: "changed-milestone" }, { semanticEventKey: "synthetic.changed" }, { evidence: { ...remapped.evidence, expectedWorldCursor: { worldTick: 9, worldOrdinal: 9 } } }, { evidence: { ...remapped.evidence, sceneId: "changed-scene" } }]) {
            await assert.rejects(offline.confirmMilestone({ ...remapped, ...change }), { code: "IDEMPOTENCY_KEY_REUSE" });
          }
        }
        assert.equal(resolverCalls, 0); assert.deepEqual(p.snapshot(), before);
        assert.equal(p.calls.slice(callStart).some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
      };
      await replayOriginalIntents(targetProtocol, archive, again, targetWorkspace);
      await st.test("legacy no-map restore replays full receipts but refuses new semantic intent", async () => {
        const legacy = negativeArchive(a => { delete a.domain!.commandMaterializations; });
        legacy.manifest = realmRuntimeSaveManifestFromData({ ...legacy, ...legacy.manifest });
        const legacyProtocol = await a2TransportProtocol(targetInstall.snapshot());
        const restored = await createPostgresRealmRuntimeSaveRestorer(legacyProtocol.database as never, { validateWorldBinding: async () => {} }).restore({ workspaceId: targetWorkspace, principalId: scope.principalId, targetWorldId: installed.worldId, archive: parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(legacy)), idempotencyKey: "legacy-no-map" });
        const state = legacyProtocol.snapshot(), restoredProject = state.projects.find(p => p.worldline_id === restored.worldlineId)!;
        assert.equal(state.realmworld_command_materializations.some(r => r.worldline_id === restored.worldlineId), false);
        const before = legacyProtocol.snapshot(), start = legacyProtocol.calls.length;
        let legacyResolverCalls = 0;
        const legacyOffline = commandService(legacyProtocol, async () => { legacyResolverCalls++; throw Error("LEGACY_PACKAGE_OFFLINE"); });
        for (const originalIntent of [priorIntent, targetIntent]) {
          const sourceMilestone = archive.domain!.milestones.find(m => m.id === originalIntent.milestoneId)!;
          const candidates = state.project_milestones.filter(m => m.worldline_id === restored.worldlineId && m.project_id === restoredProject.id && m.title === sourceMilestone.title && m.sequence === sourceMilestone.sequence);
          assert.equal(candidates.length, 1);
          const remapped = { ...originalIntent, scope: { ...commandScope, workspaceId: targetWorkspace, worldlineId: restored.worldlineId }, projectId: String(restoredProject.id), milestoneId: String(candidates[0]!.id), evidence: { ...originalIntent.evidence, recordId: restored.recordId, sceneId: String(state.scenes.find(s => s.record_id === restored.recordId && s.title === sourceScene.title)!.id) } };
          assert.equal((await legacyOffline.confirmMilestone(remapped)).status, "replayed");
          await assert.rejects(legacyOffline.confirmMilestone({ ...remapped, expectedProjectVersion: remapped.expectedProjectVersion + 1 }), { code: "IDEMPOTENCY_KEY_REUSE" });
        }
        assert.equal(legacyResolverCalls, 0);
        await assert.rejects(commandService(legacyProtocol).confirmMilestone({ ...targetIntent, scope: { ...commandScope, workspaceId: targetWorkspace, worldlineId: restored.worldlineId }, projectId: String(restoredProject.id), milestoneId: String(state.project_milestones.find(m => m.worldline_id === restored.worldlineId && m.title === "Target")!.id), expectedProjectVersion: 3, idempotencyKey: "new-semantic-no-map" }), { code: "BUSINESS_POLICY_MISSING" });
        assert.deepEqual(legacyProtocol.snapshot(), before); assert.equal(legacyProtocol.calls.slice(start).some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
      });
      const second = await restorer.restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, targetWorldId: installed.worldId, archive: again, idempotencyKey: "a2-second-generation" });
      const final = await load(scope.workspaceId, second.recordId);
      const secondState = protocol.snapshot();
      assert.equal((await restorer.restore({ workspaceId: scope.workspaceId, principalId: scope.principalId, targetWorldId: installed.worldId, archive: again, idempotencyKey: "a2-second-generation" })).replayed, true);
      assert.deepEqual(protocol.snapshot(), secondState);
      assert.deepEqual(sorted(final), sorted(archive));
      typedMaps(again, final);
      await replayOriginalIntents(protocol, archive, final, scope.workspaceId);
      for (const next of [again, final]) for (const original of archive.domain!.commandMaterializations!.rows) {
        const mapped = next.domain!.commandMaterializations!.rows.find(r => r.projectKey === original.projectKey && r.milestoneKey === original.milestoneKey)!;
        for (const kind of ["projectId", "milestoneId", "storyId", "recordId"] as const) assert.notEqual(mapped[kind], original[kind]);
      }
      archive = final;
    } finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
  });
  await t.test("actual project route replays full historical intent with policy unavailable and rejects new semantic intent", async st => {
    const pg = (await import("pg")).default;
    const { POST: commandPost } = await import("../app/api/bridge/v1/projects/commands/route.ts");
    const { endSharedRuntimePools } = await import("../app/api/world-scope.ts");
    const { LOCAL_RECORD_SCOPE } = await import("../modules/application/local-record-service.ts");
    const { installTestSessionSecret, sessionProofFor } = await import("./helpers/session-proof.ts");
    const { createProjectFinanceCommandService } = await import("../modules/application/project-finance-command.ts");
    const { createPostgresProjectFinanceCommandStore } = await import("../database/postgres/project-finance-command-repository.ts");
    installTestSessionSecret();
    const f = fixture(), routeScope = { ...scope, workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId: "principal_a2_route_owner" };
    const installed = await createPostgresLibraryService(f.database as never, undefined, { resolveCommandPolicy }).instantiateRealmWorld(routeScope, plan, "route-replay");
    const p = await a2TransportProtocol(f.snapshot()), state = p.snapshot();
    const prior = state.realmworld_command_materializations.find(r => r.milestone_key === "prior")!, target = state.realmworld_command_materializations.find(r => r.milestone_key === "target")!;
    const commandScope = { workspaceId: routeScope.workspaceId, worldId: installed.worldId, worldlineId: installed.worldlineId };
    const intent = { scope: commandScope, projectId: String(prior.project_id), milestoneId: String(prior.milestone_id), expectedProjectVersion: 1, idempotencyKey: "route-historical-key", evidence: { recordId: installed.recordId, sceneId: String(state.scenes[0]!.id), visibility: "public" as const, expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } } };
    await createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(p.database as never) }).confirmMilestone(intent);
    const previousUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    process.env.REALM_RUNTIME_DATABASE_URL = "postgresql://127.0.0.1:1/a2-protocol-only";
    const connect = st.mock.method(pg.Pool.prototype, "connect", async () => p.database.connect());
    const request = (change: Record<string, unknown> = {}, key = intent.idempotencyKey) => new Request(`http://offline.invalid/api/bridge/v1/projects/commands?worldId=${installed.worldId}&worldlineId=${installed.worldlineId}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, cookie: `realm_session=${sessionProofFor(routeScope.principalId)}` },
      body: JSON.stringify({ command: "confirm_milestone", projectId: intent.projectId, milestoneId: intent.milestoneId, expectedProjectVersion: intent.expectedProjectVersion, ...intent.evidence, ...change }),
    });
    try {
      const before = p.snapshot(), start = p.calls.length;
      const replay = await commandPost(request()); assert.equal(replay.status, 200, JSON.stringify({ response: await replay.clone().json(), calls: p.calls.slice(-4) }));
      const body = await replay.json() as { data: { status: string }; meta: { storyContinuation?: { status: string } } };
      assert.equal(body.data.status, "replayed"); assert.equal(body.meta.storyContinuation, undefined, "a graph-free Story continues normally; SQL errors must not masquerade as blocked replay");
      const changed = await commandPost(request({ expectedProjectVersion: 2 })); assert.equal(changed.status, 409);
      assert.equal((await changed.json() as { error: { code: string } }).error.code, "IDEMPOTENCY_KEY_REUSE");
      const denied = await commandPost(request({ milestoneId: target.milestone_id, expectedProjectVersion: 2, semanticEventKey: "synthetic.ready", expectedWorldCursor: { worldTick: 0, worldOrdinal: 2 } }, "new-route-policy-key"));
      assert.equal(denied.status, 422); assert.equal((await denied.json() as { error: { code: string } }).error.code, "BUSINESS_POLICY_MISSING");
      assert.deepEqual(p.snapshot(), before); assert.equal(p.calls.slice(start).some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
    } finally {
      await endSharedRuntimePools(); connect.mock.restore();
      if (previousUrl === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL; else process.env.REALM_RUNTIME_DATABASE_URL = previousUrl;
    }
  });
  for (const table of ["projects", "project_story_links", "project_milestones", "realmworld_command_materializations"]) await t.test(`rollback at ${table}`, async () => {
    const f = fixture(table), service = createPostgresLibraryService(f.database as never, undefined, { resolveCommandPolicy });
    await assert.rejects(service.instantiateRealmWorld(scope, plan, "rollback-a2"), /A2_INSTALL_INJECTED_FAILURE/);
    assert.deepEqual(f.snapshot(), {}); assert.equal(f.calls.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(f.counts().acquired, f.counts().released);
  });
  for (const options of [{}, { resolveCommandPolicy: async () => ({ ...policy }) }]) await t.test("missing or copied resolver cannot authorize pure plan", async () => {
    const f = fixture(); await assert.rejects(createPostgresLibraryService(f.database as never, undefined, options).instantiateRealmWorld(scope, plan, "untrusted-a2"), { code: "BUSINESS_POLICY_MISSING" }); assert.equal(f.calls.length, 0);
  });
});

// State is populated by public Library genesis and by actual restorer INSERTs.
// This protocol models no PostgreSQL constraints, RLS, or authorization enforcement.
async function a2TransportProtocol(seed: Record<string, Record<string, unknown>[]>, options: { capabilityRows?: readonly Record<string, unknown>[]; capabilityError?: boolean } = {}) {
  const { readFileSync } = await import("node:fs");
  const { topologyHeaderSql } = await import("../database/postgres/runtime-topology-resource-reader.ts");
  const { GOAL_TRANSPORT_CAPABILITY_SQL, LOAD_TRANSPORT_GOALS_SQL } = await import("../database/postgres/runtime-goal-binding-reader.ts");
  const { evidenceHeaderSql } = await import("../database/postgres/runtime-evidence-resource-reader.ts");
  type Row = Record<string, unknown>;
  let state = structuredClone(seed), saved = structuredClone(seed), workspace: unknown;
  const calls: { sql: string; values: unknown[] }[] = [];
  const evidenceCursors = new Set<string>();
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const known = new Set(["SAVEPOINT realm_workspace_scope", "RELEASE SAVEPOINT realm_workspace_scope", "ROLLBACK TO SAVEPOINT realm_workspace_scope", "SELECT current_setting('realm.workspace_id', true) AS workspace_id", "BEGIN", "BEGIN READ ONLY", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK", "SELECT set_config('realm.workspace_id', $1, true)"]);
  known.add(norm(GOAL_TRANSPORT_CAPABILITY_SQL)); known.add(norm(LOAD_TRANSPORT_GOALS_SQL));
  for (const lock of ["FOR KEY SHARE", "FOR UPDATE"]) known.add(`SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 ${lock}`);
  for (const path of ["../database/postgres/realm-runtime-save-repository.ts", "../database/postgres/business-command-policy.ts", "../database/postgres/project-finance-command-repository.ts", "../database/postgres/world-write-gate.ts", "../app/api/world-scope.ts", "../app/api/bridge/v1/project-finance-context.ts", "../modules/application/story-graph-continuation.ts", "../database/postgres/workspace-transaction.ts"]) {
    for (const m of readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) if (!m[1].includes("${")) known.add(norm(m[1]));
  }
  const policyLockSql = "SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)";
  assert.ok(readFileSync(new URL("../database/postgres/business-command-policy.ts", import.meta.url), "utf8").includes(JSON.stringify(policyLockSql)), "protocol helper seam must match the production SQL literal");
  known.add(policyLockSql);
  known.add("SELECT restore_delivery_kind FROM public.outbox WHERE false");
  known.add("SELECT current_setting('transaction_isolation') AS isolation_level");
  known.add("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
  known.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
  const headers = new Map((["participants", "scenes", "visibility"] as const).map(f => [norm(topologyHeaderSql(f)), f]));
  for (const sql of headers.keys()) known.add(sql);
  const tables = new Set(["worlds", "worldlines", "stories", "records", "record_heads", "participants", "scenes", "visibility_policies", "events", "goal_instances", "goal_assessments", "record_goal_definitions", "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "outbox", "record_first_nights", "record_self_play_sessions", "projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "story_node_instances", "story_unlock_ledger", "committed_fact_commands", "performance_assessments", "member_relationship_revisions", "character_assets", "story_definition_bindings", "record_archives", "realmworld_command_materializations", "character_instances", "character_continuities", "character_definitions", "asset_definitions", "memory_cache_epochs"]);
  const result = (rows: Row[]) => ({ rows: rows.toReversed(), rowCount: rows.length });
  const rows = (table: string, values: unknown[], sql: string) => {
    if (sql.startsWith("UPDATE ")) sql = sql.slice(sql.indexOf(" WHERE "));
    assert.ok(tables.has(table), `UNSUPPORTED_A2_TABLE:${table}`);
    return (state[table] ?? []).map(r => table === "record_first_nights" ? { hook_content: "", suggestions: [], ...r } : table === "character_assets" ? { revision: 1, metadata: {}, ...r } : r).filter(r => {
      assert.equal(values[0], workspace);
      if (r.workspace_id !== values[0]) return false;
      for (const [, column, parameter] of sql.matchAll(/(?:\b\w+\.)?(workspace_id|world_id|worldline_id|record_id|story_id|project_id|idempotency_key|id)\s*=\s*\$(\d+)\b/g)) {
        if (r[column] !== undefined && r[column] !== values[Number(parameter) - 1]) return false;
      }
      for (const [, column, parameter] of sql.matchAll(/\b(id|project_id) = ANY\(\$(\d+)::text\[\]\)/g)) if (!(values[Number(parameter) - 1] as unknown[]).includes(r[column])) return false;
      return true;
    });
  };
  const client = { release() {}, async query(raw: string, values: unknown[] = []) {
    const sql = norm(raw); calls.push({ sql, values: structuredClone(values) });
    const declaration = /DECLARE (realm_evidence_[a-f0-9]+) NO SCROLL/.exec(sql);
    if (declaration) for (const family of ["action_receipts", "character_effects", "observations"] as const) {
      if (sql === norm(evidenceHeaderSql(family, declaration[1]))) {
        assert.equal(values.length, 4); assert.equal(values[0], workspace);
        assert.equal(rows(family, values, sql).length, 0, "A2 fixture has no evidence rows to decode");
        evidenceCursors.add(declaration[1]); return result([]);
      }
    }
    const fetchEvidence = /^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if (fetchEvidence) { assert.ok(evidenceCursors.has(fetchEvidence[1])); return result([]); }
    const closeEvidence = /^CLOSE (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if (closeEvidence) { assert.ok(evidenceCursors.delete(closeEvidence[1])); return result([]); }
    const root = sql.includes("record.id AS record_id") && sql.includes("backup_membership");
    const eventHeader = sql.startsWith("/* runtime event headers */");
    const memoryHeader = /^\/\* memory resource (epoch header|header (?:conclusions|snapshots|relationships)) \*\//.test(sql);
    const outboxHeader = sql.startsWith("/* runtime outbox headers;");
    if (!known.has(sql) && !root && !eventHeader && !outboxHeader && !memoryHeader) throw Error("UNKNOWN_A2_TRANSPORT_SQL:" + sql);
    if (sql === norm(GOAL_TRANSPORT_CAPABILITY_SQL)) { assert.deepEqual(values, []); return result([{ available: true }]); }
    if (sql === norm(LOAD_TRANSPORT_GOALS_SQL)) {
      assert.equal(values.length, 5); assert.equal(values[0], workspace);
      assert.equal((state.goal_instances ?? []).length, 0, "A2 fixture has genuinely no persisted Goal instances");
      return result([]);
    }
    if (sql === "SAVEPOINT realm_workspace_scope" || sql === "RELEASE SAVEPOINT realm_workspace_scope" || sql === "ROLLBACK TO SAVEPOINT realm_workspace_scope") return result([]);
    if (sql === "SELECT current_setting('realm.workspace_id', true) AS workspace_id") return result([{ workspace_id: workspace }]);
    if (sql.includes("current_setting('transaction_read_only') AS read_only")) return result([{ isolation_level: "read committed", read_only: "off" }]);
    if (sql.startsWith("SELECT public.bridge_command_membership_role(")) return result([{ role: "owner" }]);
    if (sql.startsWith("SELECT membership.role AS role")) return result([{ role: "owner" }]);
    if (sql.startsWith("SELECT story.id, binding.story_id IS NOT NULL AS bound,")) return result(rows("stories", values, sql).map(r => ({ id: r.id, bound: false, has_graph: false })));
    if (sql.startsWith("BEGIN")) { saved = structuredClone(state); return result([]); }
    if (sql === "COMMIT") return result([]);
    if (sql === "ROLLBACK") { state = structuredClone(saved); return result([]); }
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { workspace = values[0]; return result([]); }
    if (sql.includes("record.id AS record_id")) {
      const r = state.records?.find(r => r.workspace_id === values[0] && r.id === values[1]);
      const h = state.record_heads?.find(h => h.workspace_id === values[0] && h.record_id === values[1]);
      return result(r && h ? [{ ...r, record_id: r.id, record_version: h.record_version, next_record_ordinal: h.next_record_ordinal }] : []);
    }
    if (sql === "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available") { assert.deepEqual(values, []); if (options.capabilityError) throw Error("A2_CAPABILITY_QUERY_ERROR"); return result([...(options.capabilityRows ?? [{ command_materializations_available: true }])]); }
    if (sql.includes("FROM player_world_memberships")) return result([{ role: "owner" }]);
    if (sql.endsWith("AS mixed")) return result([{ mixed: false }]);
    if (sql.endsWith("AS bound")) return result([{ bound: false }]);
    if (sql.includes("unsupported_scoped_goal")) return result([]); // Library fixture installs no scoped Goals.
    if (sql === "SELECT restore_delivery_kind FROM public.outbox WHERE false") return result([]);
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level") return result([{ isolation_level: "read committed" }]);
    if (sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") return result([]);
    if (sql === "SELECT octet_length($1::jsonb::text) AS bytes") return result([{ bytes: Buffer.byteLength(JSON.stringify(JSON.parse(String(values[0])))) }]);
    if (sql.startsWith("SELECT command.workspace_id,")) return result(rows("project_finance_command_groups", values, sql).map(r => {
      const anchorId = ((r.result_manifest as Row).replayLineage as Row | undefined)?.anchorCommandId;
      const anchor = state.project_finance_command_groups?.find(a => a.workspace_id === r.workspace_id && a.world_id === r.world_id && a.worldline_id === r.worldline_id && a.id === anchorId);
      return { ...r, receipt_oversized: false, anchor_row: anchor ? { ...anchor, receipt_oversized: false } : null };
    }));
    if (sql.startsWith("SELECT worldline.head_tick,")) return result(rows("worldlines", values, sql).map(r => ({ ...r, calendar_id: state.worlds?.find(w => w.workspace_id === workspace && w.id === r.world_id)?.calendar_id, display_time: "" })));
    if (sql === policyLockSql) {
      assert.equal(values.length, 6);
      assert.equal(values[0], workspace);
      const record = state.records?.find(r => r.workspace_id === workspace && r.world_id === values[1] && r.worldline_id === values[2] && r.id === values[3] && r.story_id === values[4] && r.status !== "archived");
      const story = state.stories?.find(s => s.workspace_id === workspace && s.world_id === values[1] && s.worldline_id === values[2] && s.id === values[4] && s.status !== "archived");
      const link = state.project_story_links?.find(l => l.workspace_id === workspace && l.world_id === values[1] && l.worldline_id === values[2] && l.project_id === values[5] && l.story_id === values[4] && l.link_kind === "primary");
      return result(record && story && link ? [{ world_version: record.world_version }] : []);
    }
    if (sql.startsWith("SELECT e.id FROM events AS e")) {
      const matching = state.events?.filter(e => e.workspace_id === workspace && e.world_id === values[1] && e.worldline_id === values[2] && e.record_id === values[3] && e.id === values[4] && e.event_kind === "project.milestone.confirmed" && (e.payload as Row).projectId === values[5] && (e.payload as Row).milestoneId === values[6] && state.visibility_policies?.some(v => v.workspace_id === workspace && v.record_id === e.record_id && v.id === e.visibility_policy_id && v.policy_kind === "public"));
      return result(matching ?? []);
    }
    if (sql.startsWith("UPDATE record_heads SET record_version = $3,")) {
      const updated = rows("record_heads", values, sql); for (const row of updated) Object.assign(row, { record_version: values[2], next_record_ordinal: values[3], last_event_id: values[4], last_world_tick: values[5], last_world_ordinal: values[6] }); return result(updated);
    }
    if (sql.startsWith("UPDATE worldlines SET head_tick = $4,")) {
      const updated = rows("worldlines", values, sql); for (const row of updated) Object.assign(row, { head_tick: values[3], head_ordinal: values[4] }); return result(updated);
    }
    if (sql.startsWith("UPDATE project_milestones SET status = 'completed',")) {
      const updated = rows("project_milestones", values, sql); for (const row of updated) Object.assign(row, { status: "completed", completion_record_id: values[2], completion_event_id: values[3] }); return result(updated);
    }
    if (sql.startsWith("UPDATE projects SET version = version + 1,")) {
      const updated = rows("projects", values, sql).filter(r => r.version === values[2]); for (const row of updated) row.version = Number(row.version) + 1; return result(updated);
    }
    if (headers.has(sql)) {
      const family = headers.get(sql)!;
      const table = family === "visibility" ? "visibility_policies" : family;
      const source = rows(table, values, sql);
      const keys = family === "participants" ? ["participant_speaking_order", "participant_id"] : family === "scenes" ? ["start_tick", "start_ordinal", "scene_id"] : ["policy_key", "policy_version", "policy_id"];
      if (values[4] !== null) return result([]); // all fixture topologies fit the first page
      const shaped: Row[] = source.map(r => {
        if (family === "scenes") return { ...r, scene_id: r.id, end_tick: r.end_tick ?? null, end_ordinal: r.end_ordinal ?? null };
        if (family === "visibility") return { ...r, policy_id: r.id, scene_id: r.scene_id ?? null, restricted_domain_id: r.restricted_domain_id ?? null, private_character_instance_id: r.private_character_instance_id ?? null, audience_character_instance_ids: r.audience_character_instance_ids ?? [] };
        const belongs = (a: Row) => a.workspace_id === r.workspace_id && a.world_id === r.world_id && a.worldline_id === r.worldline_id;
        const instance = state.character_instances?.find(i => belongs(i) && i.record_id === r.record_id && i.id === r.character_instance_id);
        const continuity = instance && state.character_continuities?.find(c => belongs(c) && c.id === instance.continuity_id);
        const definition = continuity && state.character_definitions?.find(d => d.workspace_id === r.workspace_id && d.world_id === r.world_id && d.id === continuity.definition_id);
        const row: Row = { participant_id: r.id, participant_kind: r.participant_kind, participant_principal_id: r.principal_id, participant_controller_mode: r.controller_mode, participant_is_active: r.is_active, participant_speaking_order: r.speaking_order, participant_shared_control_enabled: r.shared_control_enabled ?? false, participant_character_instance_id: r.character_instance_id ?? null,
          instance_id: instance?.id ?? null, instance_continuity_id: instance?.continuity_id ?? null, instance_predecessor_id: instance?.predecessor_instance_id ?? null,
          continuity_key: continuity?.continuity_key ?? null, continuity_status: continuity?.status ?? null,
          definition_id: definition?.id ?? null, definition_display_name: definition?.display_name ?? null, definition_source_format: definition?.source_format ?? null, definition_profile: definition?.profile ?? {}, instance_state: instance?.state ?? {} };
        for (const key of ["controller_mode", "status", "instantiated_tick", "instantiated_ordinal", "inheritance_cutoff_tick", "inheritance_cutoff_ordinal", "retired_tick", "retired_ordinal"]) row["instance_" + key] = instance?.[key] ?? null;
        for (const key of ["born_tick", "born_ordinal", "ended_tick", "ended_ordinal"]) row["continuity_" + key] = continuity?.[key] ?? null;
        return row;
      });
      return result(shaped.map((r, i) => ({ ...r, locator: `(0,${i + 1})`, source_count: String(source.length), cursor_progress: true,
        ...Object.fromEntries([...sql.matchAll(/ AS (\w+)_bytes/g)].flatMap(m => {
          const key = m[1], json = ["instance_state", "definition_profile", "audience_character_instance_ids"].includes(key);
          const value = json ? JSON.stringify(r[key] ?? (key === "audience_character_instance_ids" ? [] : {})) : r[key] ?? null;
          assert.ok(value === null || typeof value === "string");
          return [[key, value], [key + "_bytes", value === null ? 0 : Buffer.byteLength(value as string)], [key + "_chars", value === null ? 0 : [...String(value)].length], [key + "_is_null", value === null]];
        })), ...Object.fromEntries(keys.map(k => [k, r[k]])) })));
    }
    if (memoryHeader) {
      assert.equal(values[0], workspace);
      if (sql.startsWith("/* memory resource epoch header */")) {
        assert.equal(values.length, 4); assert.ok(sql.endsWith('ORDER BY c.id COLLATE "C" LIMIT 1000'));
        const observerIds = values[3] as string[];
        return result(rows("character_continuities", values.slice(0, 3), "").filter(r => observerIds.includes(String(r.id))).map(r => ({ observer_continuity_id: r.id, epoch: 0 })));
      }
      const table = /FROM (memory_conclusions|memory_snapshots|relationship_states) WHERE/.exec(sql)?.[1]; assert.ok(table);
      assert.equal((state[table] ?? []).length, 0, "this public genesis fixture has no formal memory rows");
      assert.ok(sql.endsWith('LIMIT 1000) memory_headers ORDER BY keys COLLATE "C"')); return result([]);
    }
    if (eventHeader) {
      const events = rows("events", values, sql);
      return result(events.map(r => ({ ...r, actor_is_null: r.actor_participant_id === null, payload_bytes: Buffer.byteLength(JSON.stringify(r.payload)),
        ...Object.fromEntries(["id", "event_kind", "speaker_name", "actor_participant_id", "scene_id", "visibility_policy_id", "calendar_id", "display_time", "content"].flatMap(k => [[k + "_bytes", Buffer.byteLength(String(r[k] ?? ""))], [k + "_chars", [...String(r[k] ?? "")].length]])) })));
    }
    if (outboxHeader) { assert.equal((state.outbox ?? []).length, 0); return result([]); }
    if (sql.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status,")) {
      const r = state.records?.find(r => r.workspace_id === values[0] && r.id === values[1]);
      return result(r ? [{ ...r, story_premise: state.stories?.find(s => s.id === r.story_id)?.premise }] : []);
    }
    if (sql.startsWith("INSERT INTO ")) {
      const m = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*)\)(?: ON CONFLICT .*?)?(?: RETURNING .*?)?$/.exec(sql); assert.ok(m, sql);
      assert.ok(tables.has(m[1]), m[1]);
      const terms = m[3].split(/,(?![^()]*\))/).map(s => s.trim()), columns = m[2].split(",").map(s => s.trim());
      assert.equal(terms.length, columns.length, sql);
      const row = Object.fromEntries(columns.map((column, i) => {
        const term = terms[i], parameter = /^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(term);
        if (parameter) { const value = values[Number(parameter[1]) - 1]; return [column, term.endsWith("::jsonb") && value !== null ? JSON.parse(String(value)) : value]; }
        if (term === "NULL") return [column, null];
        if (term === "CURRENT_TIMESTAMP") return [column, "2026-10-19T00:00:00.000Z"];
        if (/^'.*'(?:::\w+)?$/.test(term)) return [column, term.replace(/::\w+$/, "").slice(1, -1)];
        if (/^\d+$/.test(term)) return [column, Number(term)];
        if (["true", "false"].includes(term)) return [column, term === "true"];
        if (term === "CASE WHEN $7 = 'committed' THEN CURRENT_TIMESTAMP ELSE NULL END") return [column, values[6] === "committed" ? "2026-10-19T00:00:00.000Z" : null];
        throw Error("UNKNOWN_A2_TRANSPORT_TERM:" + term);
      }));
      assert.equal(row.workspace_id, workspace); (state[m[1]] ??= []).push(row); return result([row]);
    }
    const from = /\bFROM (\w+)/.exec(sql)?.[1];
    if ((sql.startsWith("SELECT ") || sql.startsWith("/* memory resource head */")) && from && tables.has(from)) return result(rows(from, values, sql).map(r => from === "project_finance_command_groups" ? { rejection_code: null, receipt_oversized: false, ...r } : r));
    throw Error("UNHANDLED_A2_TRANSPORT_SQL:" + sql);
  } };
  return { database: { connect: async () => client }, calls, snapshot: () => structuredClone(state) };
}
