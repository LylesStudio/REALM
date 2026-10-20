import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { createGoalContentBindingSource, bindGoalContentWitness } from "../modules/application/goal-content-binding-source.ts";
import { cloneGoalInstancesForBranch, materializeGoalInstances, retryGoalInstance } from "../database/postgres/goal-runtime-materialization.ts";
import { LOAD_GOAL_CONTENT_BINDING_SQL, LOCK_GOAL_CONTENT_WORLD_SQL } from "../database/postgres/goal-content-binding-repository.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";
import { loadBoundRecordGoalDefinition } from "../modules/application/record-goal-definition.ts";
import { goalDefinitionHash } from "../modules/goals/content-binding.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { writeRestoredGoalsV2, INSERT_RESTORED_GOAL_V2_SQL } from "../database/postgres/runtime-goal-restore.ts";
import type { RealmRuntimeSaveGoalsV2 } from "../modules/world-transfer/realm-runtime-goals-v2.ts";

const definition = { goalKey: "arrival", policyVersion: "p1", mode: "deterministic" as const,
  visible: true, rubric: { kind: "event_count" as const, eventKind: "arrived", progressKey: "count", threshold: 1 }, outcome: { title: "抵达" } };
const owner = { scopeKind: "record" as const, worldId: "world", worldlineId: "line", recordId: "record" };
const source = { sourceKind: "installed" as const, sourceWorldId: "world", sourceWorldVersion: "1.0.0",
  packageContentHash: "a".repeat(64), baseRevision: null, baseContentHash: null };
function productionSql(symbol: string, startsWith: string): string {
  const source = readFileSync(new URL("../database/postgres/goal-runtime-materialization.ts", import.meta.url), "utf8");
  const section = source.split(`export async function ${symbol}(`)[1]?.split("\nexport ")[0];
  const matches = [...(section ?? "").matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(sql => sql.startsWith(startsWith));
  assert.equal(matches.length, 1, "register only a unique actual production SQL template");
  return matches[0];
}
function fixture(content: GoalDefinition = definition) {
  let revoked = false;
  let hash = source.packageContentHash;
  let mounts = 0;
  const resolve = createGoalContentBindingSource({ mount: async () => {
    mounts++;
    if (revoked) throw new Error("fixture revoked trust");
    return { manifest: { format: "realmworld", formatVersion: 1, worldId: "world", worldVersion: "1.0.0",
      engineCompat: { schemaLatest: "", requiresMigrations: [], baseRange: "*" }, contentHash: hash,
      signature: { algorithm: "ed25519", keyId: "fixture", value: "" } }, files: new Map([["content/goals.json",
        Buffer.from(JSON.stringify({ format: "realmworld-goals", schemaVersion: 1, goals: [content] }))]]) };
  } });
  return { resolve, revoke: () => { revoked = true; }, replace: () => { hash = "b".repeat(64); }, mounts: () => mounts };
}

test("0085 V3 uses its distinct content admission while the actual V2 writer keeps its original RPC",async()=>{
  const witness=await fixture().resolve({worldId:"world",worldVersion:"1.0.0",goalKey:"arrival"});
  const binding=bindGoalContentWitness(witness,"workspace",owner,"restored-goal");
  const goals:RealmRuntimeSaveGoalsV2={format:"realm-runtime-goals",schemaVersion:2,workspaceId:"workspace",definitions:[],assessments:[],
    roots:[{owner,instances:[{ref:{owner,instanceId:"restored-goal"},goalKey:"arrival",definition:{kind:"content",binding},
      state:"active",revision:0,progress:{},outcome:null,policyVersion:"p1",attempt:1,predecessor:null,resolutionKind:"natural",evidenceStart:null}]}]};
  for(const bodyVersion of [2,3] as const) {
    const calls:string[]=[];
    const prepare=bodyVersion===3?"SELECT goal_content_write_prepare_v3($1,$2,$3,$4,$5::jsonb) AS admission":"SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission";
    const client={async query(sql:string,params:unknown[]) {
      calls.push(sql);
      if(sql===prepare) {
        assert.deepEqual(params.slice(0,4),["workspace","proof",`restore-v${bodyVersion}`,"b".repeat(64)]);
        const plan=JSON.parse(String(params[4]));assert.equal(plan.restoreGroupRoot,"root");assert.equal(plan.operation,`restore-v${bodyVersion}`);
        assert.deepEqual(plan.instances[0].source,binding.source);
        return {rows:[{admission:{actor:"owner",planCommitment:"c".repeat(64)}}]};
      }
      if(sql===INSERT_RESTORED_GOAL_V2_SQL){assert.equal(params[6],"restored-goal");return {rows:[],rowCount:1};}
      if(sql==="SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {assert.deepEqual(JSON.parse(String(params[4])),[binding]);return {rows:[]};}
      throw Error(`UNKNOWN_V3_GOAL_SQL:${sql}`);
    }} as unknown as PoolClient;
    await writeRestoredGoalsV2(client,{goals,sessionProof:"proof",root:"root",bodyCommitment:"b".repeat(64),principalId:"owner",bodyVersion});
    assert.equal(calls.length,3);assert.equal(calls[0],prepare);
  }
  const sql=readFileSync(new URL("../database/postgres/migrations/0085_runtime_performance_transport_body_v3.sql",import.meta.url),"utf8");
  for(const name of ["record_goal_restore_group_prepare_v3","record_goal_restore_group_replay_v3","goal_restore_v3_complete","performance_restore_v3_complete","goal_content_write_prepare_v3"])assert.match(sql,new RegExp(`CREATE FUNCTION ${name}\\(`));
  assert.match(sql,/realm-save:body-v3:/);assert.match(sql,/goal_restore_v2_plan_assert/);assert.match(sql,/performance_restore_v3_fact_assert/);
  assert.doesNotMatch(sql,/CREATE ROLE|\bBYPASSRLS\b|GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]+TO realm_runtime/);
});
test("server source rechecks mount/trust each time and compares the full historical tuple", async () => {
  const f = fixture();
  const witness = await f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival", expectedSource: source });
  assert.equal(witness.definitionHash, goalDefinitionHash(definition));
  assert.ok(Object.isFrozen(witness.definition.rubric));
  assert.equal(bindGoalContentWitness(witness, "workspace", owner, "instance").source.packageContentHash, source.packageContentHash);
  await f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival", expectedSource: source });
  assert.equal(f.mounts(), 2);
  f.replace();
  await assert.rejects(f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival", expectedSource: source }));
  f.revoke();
  await assert.rejects(f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival" }));
  assert.throws(() => bindGoalContentWitness({ ...witness }, "workspace", owner, "fake"));
});
test("base sentinel alone cannot prove historical revision; explicit immutable registry can", async () => {
  const resolve = createGoalContentBindingSource();
  const current = await resolve({ worldId: "world", worldVersion: "0.0.0-local", goalKey: "base.first-narration" });
  assert.equal(current.source.sourceKind, "base");
  assert.notEqual(current.source.baseRevision, "0.0.0-local");
  const historical = await resolve({ worldId: "world", worldVersion: "0.0.0-local", goalKey: "base.first-narration", expectedSource: current.source });
  assert.equal(historical.definitionHash, current.definitionHash);
  await assert.rejects(resolve({ worldId: "world", worldVersion: "0.0.0-local", goalKey: "base.first-narration",
    expectedSource: { ...current.source, baseRevision: "missing" } }));
});
test("materialize uses the caller client: trusted resolve, prepare, INSERT, bind; exact protocol only", async () => {
  const f = fixture();
  const calls: string[] = [];
  const client = { query: async (sql: string, params: unknown[]) => {
    if (sql === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      calls.push("prepare"); assert.equal(params[0], "workspace"); assert.equal(params[1], "proof"); assert.equal(params[2], "materialize");
      const plan = JSON.parse(params[4] as string);
      assert.equal(plan.instances[0].source.packageContentHash, source.packageContentHash);
      assert.equal(plan.instances[0].definitionHash, goalDefinitionHash(definition));
      return { rows: [{ admission: { actor: "owner", planCommitment: "c".repeat(64) } }] };
    }
    if (sql === productionSql("materializeGoalInstances", "INSERT INTO goal_instances (")) {
      calls.push("insert"); assert.deepEqual(params.slice(0, 6), ["workspace", "world", "line", "record", null, "record"]);
      return { rows: [], rowCount: 1 };
    }
    if (sql === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {
      calls.push("bind"); assert.equal(params[3], "c".repeat(64)); assert.equal(JSON.parse(params[4] as string)[0].definitionHash, goalDefinitionHash(definition));
      return { rows: [] };
    }
    throw new Error(`Unknown production SQL: ${sql}`);
  } } as unknown as PoolClient;
  const ids = await materializeGoalInstances(client, { workspaceId: "workspace", ...owner }, [definition],
    { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0" });
  assert.equal(ids.length, 1); assert.deepEqual(calls, ["prepare", "insert", "bind"]);
});
test("untrusted materialization refuses before SQL and a source failure cannot leave an INSERT", async () => {
  const f = fixture(); f.revoke(); let queries = 0;
  const client = { query: async () => { queries++; throw new Error("unexpected SQL"); } } as unknown as PoolClient;
  await assert.rejects(materializeGoalInstances(client, { workspaceId: "workspace", ...owner }, [definition]));
  await assert.rejects(materializeGoalInstances(client, { workspaceId: "workspace", ...owner }, [definition],
    { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0" }));
  assert.equal(queries, 0);
});
test("materialize keeps Story and worldline typed anchors in the real SQL/admission", async () => {
  for (const scope of [{ workspaceId: "workspace", worldId: "world", worldlineId: "line", kind: "story" as const, storyId: "story" },
    { workspaceId: "workspace", worldId: "world", worldlineId: "line", kind: "worldline" as const }]) {
    const f = fixture(); let planOwner: unknown;
    const client = { query: async (sql: string, params: unknown[]) => {
      if (sql === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
        planOwner = JSON.parse(params[4] as string).instances[0].owner;
        assert.deepEqual(planOwner, { scopeKind: scope.kind, worldId: "world", worldlineId: "line", ...(scope.kind === "story" ? { storyId: "story" } : {}) });
        return { rows: [{ admission: { actor: "owner", planCommitment: "c".repeat(64) } }] };
      }
      if (sql === productionSql("materializeGoalInstances", "INSERT INTO goal_instances (")) {
        assert.deepEqual(params.slice(3,6), [null, scope.kind === "story" ? "story" : null, scope.kind]); return { rows: [], rowCount: 1 };
      }
      if (sql === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") { assert.deepEqual(JSON.parse(params[4] as string)[0].owner, planOwner); return { rows: [] }; }
      throw new Error(`Unknown production SQL: ${sql}`);
    } } as unknown as PoolClient;
    await materializeGoalInstances(client, scope, [definition], { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0" });
  }
});
test("retry verifies the persisted predecessor source and historical retryable setting before admission", async () => {
  const f = fixture({ ...definition, retryable: true });
  const witness = await f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival" });
  const binding = bindGoalContentWitness(witness, "workspace", owner, "previous");
  const calls: string[] = [];
  const previousSql = productionSql("retryGoalInstance", "SELECT id, state, attempt").replace("${scopeFilter}", "scope_kind = 'record' AND record_id = $4").replace("${goalKeyParam}", "5");
  const client = { query: async (sql: string, params: unknown[]) => {
    if (sql === LOCK_GOAL_CONTENT_WORLD_SQL) { calls.push("world"); assert.deepEqual(params, ["workspace", "world"]); return { rows: [{ id: "world" }] }; }
    if ([productionSql("retryGoalInstance", "SELECT id FROM records"), productionSql("retryGoalInstance", "SELECT id FROM worldlines")].includes(sql)) { assert.equal(calls[0], "world"); return { rows: [{ id: "record" }] }; }
    if (sql === previousSql) { assert.deepEqual(params, ["workspace", "world", "line", "record", "arrival"]); return { rows: [{ id: "previous", state: "completed", attempt: 1, resolution_kind: "natural", policy_version: "p1" }] }; }
    if (sql === LOAD_GOAL_CONTENT_BINDING_SQL) { assert.deepEqual(params, ["workspace", "previous"]); return { rows: [{ binding }] }; }
    if (sql === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      calls.push("prepare"); assert.equal(params[2], "retry"); const plan = JSON.parse(params[4] as string);
      assert.equal(plan.instances[0].predecessor, "previous"); assert.deepEqual(plan.instances[0].source, binding.source);
      return { rows: [{ admission: { actor: "owner", planCommitment: "c".repeat(64) } }] };
    }
    if (sql === productionSql("retryGoalInstance", "INSERT INTO goal_instances (")) { calls.push("insert"); assert.deepEqual(params.slice(9), [2, "previous"]); return { rows: [], rowCount: 1 }; }
    if (sql === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") { calls.push("bind"); return { rows: [] }; }
    throw new Error(`Unknown production SQL: ${sql}`);
  } } as unknown as PoolClient;
  await retryGoalInstance(client, { workspaceId: "workspace", ...owner }, { ...definition, retryable: true },
    { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0" });
  assert.deepEqual(calls, ["world", "prepare", "insert", "bind"]);
  f.replace(); calls.length = 0;
  await assert.rejects(retryGoalInstance(client, { workspaceId: "workspace", ...owner }, { ...definition, retryable: true },
    { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0" }));
  assert.deepEqual(calls, ["world"]);
});
test("direct clone starts a target family with exact source and head proof; history is not a retry", async () => {
  const f = fixture(); const witness = await f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival" });
  const binding = bindGoalContentWitness(witness, "workspace", owner, "previous");
  const context = { sessionProof: "proof", resolveSource: f.resolve, worldVersion: "1.0.0",
    source: { recordId: "record", recordVersion: 1, nextRecordOrdinal: 2 } };
  let queries = 0;
  const client = { query: async (sql: string, params: unknown[]) => {
    queries++;
    if (sql === LOAD_GOAL_CONTENT_BINDING_SQL) return { rows: [{ binding }] };
    if (sql === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      assert.equal(params[2], "clone"); const plan = JSON.parse(params[4] as string);
      assert.equal(plan.instances[0].predecessor, null); assert.equal(plan.instances[0].owner.recordId, "target");
      assert.deepEqual(plan.source, context.source); assert.deepEqual(plan.instances[0].source, binding.source);
      return { rows: [{ admission: { actor: "owner", planCommitment: "c".repeat(64) } }] };
    }
    if (sql === productionSql("cloneGoalInstancesForBranch", "INSERT INTO goal_instances (")) { assert.equal(params[3], "target"); assert.equal(params[8], '{"text":"record previous"}'); return { rows: [], rowCount: 1 }; }
    if (sql === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") return { rows: [] };
    throw new Error(`Unknown production SQL: ${sql}`);
  } } as unknown as PoolClient;
  const goal = { instanceId: "previous", goalKey: "arrival", policyVersion: "p1", state: "active" as const,
    revision: "0", progress: { text: "record previous" }, outcome: null, completedAt: null, attempt: 1 };
  const target = { workspaceId: "workspace", worldId: "world", worldlineId: "target-line", recordId: "target" };
  await cloneGoalInstancesForBranch(client, target, [goal], context);
  assert.equal(queries, 4); queries = 0;
  await assert.rejects(cloneGoalInstancesForBranch(client, target, [{ ...goal, attempt: 2 }], context));
  assert.equal(queries, 0);
});
test("Record content read refuses missing historical binding instead of invoking a current-rubric fallback", async () => {
  let fallbacks = 0;
  const source = readFileSync(new URL("../modules/application/record-goal-definition.ts", import.meta.url), "utf8");
  const sql = [...source.matchAll(/`([^`]+)`/g)].map(m => m[1]).find(q => q.startsWith("SELECT id FROM goal_instances"));
  assert.ok(sql);
  const client = { query: async (q: string, params: unknown[]) => {
    if (q === sql) { assert.deepEqual(params, ["workspace", "world", "line", "record", "arrival", "p1", "previous"]); return { rows: [{ id: "previous" }] }; }
    if (q === LOAD_GOAL_CONTENT_BINDING_SQL) return { rows: [] };
    throw new Error(`Unknown production SQL: ${q}`);
  } } as unknown as PoolClient;
  await assert.rejects(loadBoundRecordGoalDefinition(client, { scope: { workspaceId: "workspace", ...owner },
    binding: { instanceId: "previous", definitionSource: "content", goalKey: "arrival", policyVersion: "p1", worldVersion: "1.0.0" },
    resolveContentDefinition: () => { fallbacks++; return definition; }, resolveGoalSource: fixture().resolve }),
    { code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" });
  assert.equal(fallbacks, 0);
});
test("0083 authors the production capabilities, typed/deferred guards and two forced-RLS tables", () => {
  const sql = readFileSync(new URL("../database/postgres/migrations/0083_goal_content_instance_bindings.sql", import.meta.url), "utf8");
  for (const name of ["goal_content_binding_assert", "guard_goal_content_binding_immutable", "goal_content_write_prepare", "goal_content_write_bind", "guard_goal_content_predecessor"]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION ${name}\\(`));
    assert.match(sql, new RegExp(`ALTER FUNCTION ${name}\\([^;]+OWNER TO realm_goal_authoring`));
  }
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g) ?? []).length, 2);
  for (const table of ["goal_content_instance_bindings", "goal_content_write_admissions"]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON ${table} FROM PUBLIC,realm_runtime`));
  }
  assert.match(sql, /CREATE CONSTRAINT TRIGGER goal_content_binding_required/);
  assert.match(sql, /BEFORE INSERT ON goal_instances/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|ALL)[^;]+TO realm_runtime/);
});

test("actual Library content-only branch keeps World-first locks, exact clone proof and same-transaction binding", async () => {
  const f = fixture(); const witness = await f.resolve({ worldId: "world", worldVersion: "1.0.0", goalKey: "arrival" });
  const binding = bindGoalContentWitness(witness, "workspace", owner, "previous");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const known = new Set<string>();
  for (const path of ["../modules/application/library-service.ts", "../modules/application/base-rule-definitions.ts",
    "../database/postgres/goal-runtime-materialization.ts"]) {
    for (const match of readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/`([^`]+)`/g)) {
      if (!match[1].includes("${")) known.add(norm(match[1]));
    }
  }
  known.add("SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE");
  const calls: { sql: string; params: unknown[] }[] = [];
  let target: { id: unknown; worldline_id: unknown; story_id: unknown; start_tick: string; start_ordinal: string } | null = null;
  let acquired = 0, released = 0, transactions = 0, committed = false;
  let bound = false; let insertedGoal: unknown[] | null = null;
  const client = { release() { released++; }, async query(sql: string, params: unknown[] = []) {
    const q = norm(sql); calls.push({ sql: q, params: structuredClone(params) });
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (q === "BEGIN ISOLATION LEVEL REPEATABLE READ") { transactions++; committed = false; return result([]); }
    if (q === "COMMIT") { committed = true; return result([]); }
    if (q === "ROLLBACK") return result([]);
    if (q === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(params, ["workspace"]); return result([]); }
    if (q === norm(LOAD_GOAL_CONTENT_BINDING_SQL)) { assert.deepEqual(params, ["workspace", "previous"]); return result([{ binding }]); }
    if (q === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      assert.equal(params[1], "proof"); assert.equal(params[2], "clone"); assert.match(params[3] as string, /^[a-f0-9]{64}$/);
      const plan = JSON.parse(params[4] as string); assert.equal(plan.instances[0].predecessor, null);
      assert.deepEqual(plan.source, { recordId: "record", recordVersion: 0, nextRecordOrdinal: 0 });
      assert.deepEqual(plan.instances[0].source, binding.source); assert.equal(plan.instances[0].owner.recordId, target!.id);
      return result([{ admission: { actor: "owner", planCommitment: "c".repeat(64) } }]);
    }
    if (q === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {
      assert.ok(insertedGoal); const bindings = JSON.parse(params[4] as string);
      assert.equal(bindings[0].instanceId, insertedGoal[4]); assert.equal(bindings[0].owner.recordId, target!.id);
      bound = true; return result([]);
    }
    if (!known.has(q)) throw new Error(`UNKNOWN_LIBRARY_GOAL_SQL:${q}`);
    if (q.startsWith("SELECT world_id FROM records")) return result([{ world_id: "world" }]);
    if (q === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") return result([{ status: "active" }]);
    if (q.startsWith("SELECT role FROM player_world_memberships")) return result([{ role: "owner" }]);
    if (q.startsWith("SELECT record.worldline_id,")) {
      assert.ok(calls.some(c => c.sql === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE"));
      return result([{ worldline_id: "line", story_id: "story", world_version: "1.0.0", record_title: "Record",
        record_status: "active", story_title: "Story", story_premise: "literal record previous", start_tick: "0", start_ordinal: "0",
        observer: true, player_role: "" }]);
    }
    if (q.startsWith("SELECT last_world_tick::text")) return result([{ last_world_tick: "0", last_world_ordinal: "0", record_version: "0", next_record_ordinal: "0" }]);
    if (q.startsWith("SELECT id, goal_key, state, revision::text")) return result([{ id: "previous", goal_key: "arrival", state: "active", revision: "0",
      progress: { literal: "previous record" }, outcome: null, policy_version: "p1", completed_at: null, attempt: 1, definition_source: "content" }]);
    if (q.startsWith("SELECT EXISTS(SELECT 1 FROM events")) return result([{ present: false }]);
    if (q.startsWith("SELECT id, worldline_id, story_id,")) return result(target ? [target] : []);
    if (q.startsWith("SELECT title, location, objective")) return result([{ title: "Scene", location: "", objective: "", tension: "", weather: "", display_time: "" }]);
    if (q.startsWith("SELECT DISTINCT definition.id,")) return result([]);
    if (q === "SELECT settings->>'style' AS style FROM worlds WHERE workspace_id = $1 AND id = $2") return result([{ style: "modern" }]);
    if (q.startsWith("SELECT skill_key, id FROM skill_definitions")) return result([]);
    if (q.startsWith("SELECT id FROM asset_definitions")) return result([{ id: "base-asset" }]);
    if (q.startsWith("SELECT id FROM effect_definitions")) return result([{ id: "base-stance" }]);
    if (q.startsWith("SELECT EXISTS ( SELECT 1 FROM information_schema.columns")) return result([{ exists: true }]);
    const table = /^INSERT INTO (\w+)/.exec(q)?.[1];
    if (table && new Set(["worldlines", "stories", "records", "record_heads", "participants", "skill_definitions",
      "asset_definitions", "effect_definitions", "scenes", "visibility_policies", "goal_instances"]).has(table)) {
      assert.equal(params[0], "workspace"); assert.equal(params[1], "world");
      if (table === "records") target = { id: params[4], worldline_id: params[2], story_id: params[3], start_tick: "0", start_ordinal: "0" };
      if (table === "goal_instances") {
        insertedGoal = params; assert.equal(params[3], target!.id); assert.equal(params[8], '{"literal":"previous record"}');
        assert.equal(params[9], null); assert.equal(params[12], 1);
      }
      return result([]);
    }
    throw new Error(`UNHANDLED_LIBRARY_GOAL_SQL:${q}`);
  } };
  const service = createPostgresLibraryService({ async connect() { acquired++; return client; } } as never,
    undefined, { resolveGoalSource: f.resolve });
  const scope = { workspaceId: "workspace", principalId: "owner", sessionProof: "proof" };
  const input = { sourceRecordId: "record", idempotencyKey: "native-content" };
  const created = await service.branchRecord(scope, input);
  assert.equal(created.replayed, false); assert.ok(bound); assert.ok(committed); assert.equal(transactions, 1);
  const writes = calls.filter(c => c.sql.startsWith("INSERT")).length;
  assert.equal((await service.branchRecord(scope, input)).replayed, true);
  assert.equal(calls.filter(c => c.sql.startsWith("INSERT")).length, writes);
  f.replace(); await assert.rejects(service.branchRecord(scope, input));
  assert.equal(calls.filter(c => c.sql.startsWith("INSERT")).length, writes);
  assert.equal(acquired, released); assert.equal(acquired, 3);
});
