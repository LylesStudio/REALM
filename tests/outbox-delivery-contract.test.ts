import assert from "node:assert/strict";
import test from "node:test";
import { createHttpOutboxDeliverySink } from "../modules/application/outbox-delivery-sink.ts";
import { PermanentOutboxPublishError, type OutboxPublishRequest } from "../modules/application/outbox-dispatcher.ts";

const native = {
  messageId: "message-1", turnId: "turn-1", recordId: "record-1",
  topic: "record.events.committed", dedupeKey: "stable-key", attempt: 1,
  payload: { recordId: "record-1", eventIds: ["event-1"] },
};
const restored = { ...native, origin: "record-events-restore-v1", turnId: null };
function sink(restoreDelivery?: string) {
  const bodies: string[] = [];
  const value = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/events",
    ...({ restoreDelivery } as object),
    fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response(null, { status: 202 }); },
  });
  return { value, bodies };
}

test("native v1 bytes remain exact with restore disabled or opted in", async () => {
  for (const mode of [undefined, "disabled", "record-events-v2"]) {
    const s = sink(mode); await s.value.publish(native);
    assert.deepEqual(s.bodies, [JSON.stringify({ version: 1, ...native })]);
  }
});
test("restore requires explicit v2 opt-in and otherwise performs zero fetch", async () => {
  for (const mode of [undefined, "disabled"]) {
    const s = sink(mode);
    await assert.rejects(s.value.publish(restored as unknown as OutboxPublishRequest),
      (e: unknown) => e instanceof PermanentOutboxPublishError && e.code === "OUTBOX_RESTORE_DELIVERY_DISABLED");
    assert.deepEqual(s.bodies, []);
  }
});
test("opted-in restore encodes real nullable-turn v2 while native stays v1", async () => {
  const s = sink("record-events-v2"); await s.value.publish(restored as unknown as OutboxPublishRequest);
  assert.deepEqual(s.bodies, [JSON.stringify({ version: 2, origin: "record-events-restore-v1", ...native, turnId: null })]);
});
test("invalid union requests are permanent local errors before fetch", async () => {
  for (const patch of [
    { turnId: null }, { turnId: " " }, { turnId: undefined }, { origin: "unknown" },
    { ...restored, turnId: "turn-1" }, { ...restored, topic: "custom" },
    { ...restored, payload: { recordId: "other", eventIds: [] } },
    { ...restored, payload: { recordId: "record-1", eventIds: ["bad id"] } },
  ]) {
    const s = sink("record-events-v2");
    await assert.rejects(s.value.publish({ ...native, ...patch } as unknown as OutboxPublishRequest),
      (e: unknown) => e instanceof PermanentOutboxPublishError && e.code === "OUTBOX_DELIVERY_REQUEST_INVALID");
    assert.deepEqual(s.bodies, []);
  }
});
test("restore configuration is exact, including empty-string refusal", () => {
  for (const value of ["", "true", "1", "v2", " record-events-v2 ", null, true]) {
    assert.throws(() => sink(value as string), { code: "OUTBOX_RESTORE_DELIVERY_CONFIG_INVALID" });
  }
});

import { createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
const P = "SELECT restore_delivery_kind FROM public.outbox WHERE false";
const stamp = "2026-10-18T00:00:00.000Z";
type Row = Record<string, unknown>;
function archive(topic = "record.events.committed", envelope: Row = { recordId: "source-record", eventIds: ["source-event"] }, outbox = true) {
  const record = { format: "realm-runtime-record", schemaVersion: 1, scope: { worldId: "world", worldlineId: "line", recordId: "source-record" }, head: { recordVersion: 1, nextRecordOrdinal: 2 }, events: [{ eventId: "source-event", recordVersion: 1, ordinal: 1, kind: "narration.committed", payload: { content: "source", speakerName: "", eventPayload: {}, actorParticipantId: null, sceneId: "scene", visibilityPolicyId: "policy", worldTick: 0, worldOrdinal: 1, calendarId: "calendar", displayTime: "" } }] };
  const data = { record, goals: { format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [] }, topology: { format: "realm-runtime-topology", schemaVersion: 1, participants: [], scenes: [{ sourceSceneId: "scene", title: "Scene", status: "active", location: "", objective: "", tension: "", weather: "", displayTime: "", startTick: 0, startOrdinal: 0, endTick: null, endOrdinal: null }], visibilityPolicies: [{ sourceVisibilityPolicyId: "policy", policyKey: "public", policyVersion: 1, policyKind: "public", sourceSceneId: null, restrictedDomainId: null, sourcePrivateCharacterInstanceId: null, sourceAudienceCharacterInstanceIds: [] }] }, ...(outbox ? { outbox: { format: "realm-runtime-outbox", schemaVersion: 1, messages: [{ sourceMessageId: "message", sourceEventId: null, dedupeKey: "dedupe", topic, envelope, state: "pending", deliveryAttempts: 3, nextAttemptAt: stamp, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null }] } } : {}) } as unknown as RealmRuntimeSaveArchive;
  data.manifest = realmRuntimeSaveManifestFromData({ ...data, engineApi: "1.x", mode: "world-bound", world: { worldId: "world", worldVersion: "1.2.0" }, scope: { workspaceId: "ws", worldlineId: "line", recordId: "source-record" } });
  return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(data));
}
function restoreDouble(missingSchema = false) {
  const calls: { sql: string; values: unknown[] }[] = [], tables: Record<string, Row[]> = {};
  const allowed = new Set(["worldlines", "stories", "records", "scenes", "visibility_policies", "events", "record_heads", "outbox"]);
  const client = { release() {}, async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); calls.push({ sql, values: structuredClone(values) });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(values, ["ws"]); return { rows: [], rowCount: 0 }; }
    let rows: Row[];
    if (sql === P) { assert.deepEqual(values, []); if (missingSchema) throw Object.assign(new Error("private driver detail"), { code: "42703" }); rows = []; }
    else if (sql === "INSERT INTO participants ( workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, is_active, speaking_order, shared_control_enabled ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, NULL, 'ai', true, $6, false)") {
      assert.equal(values.length, 6);
      assert.deepEqual(values.slice(0, 3), ["ws", "world", calls.find(c => c.sql.startsWith("INSERT INTO worldlines"))!.values[2]]);
      assert.equal(values[5], 0);
      (tables.participants ??= []).push({ workspace_id: values[0], world_id: values[1], worldline_id: values[2], record_id: values[3], id: values[4], participant_kind: "narrator", character_instance_id: null, principal_id: null, controller_mode: "ai", is_active: true, speaking_order: values[5], shared_control_enabled: false });
      rows = [];
    }
    else if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE") rows = [{ world_version: "1.2.0", status: "active", settings: {} }];
    else if (sql === "SELECT role FROM player_world_memberships WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3") rows = [{ role: "owner" }];
    else if (sql.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status, story.premise AS story_premise FROM records AS record JOIN stories AS story")) {
      const r = tables.records?.find(r => r.id === values[1]); rows = r ? [{ ...r, story_premise: tables.stories.find(s => s.id === r.story_id)!.premise }] : [];
    } else {
      const m = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*)\)$/.exec(sql);
      if (!m || !allowed.has(m[1])) throw new Error(`UNKNOWN_RESTORE_SQL:${sql}`);
      const columns = m[2].split(",").map(s => s.trim()), terms = m[3].split(",").map(s => s.trim());
      assert.equal(columns.length, terms.length); const row: Row = {};
      columns.forEach((column, i) => {
        const term = terms[i], param = /^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(term);
        if (param) { row[column] = values[Number(param[1]) - 1]; if (term.endsWith("::jsonb")) row[column] = JSON.parse(String(row[column])); }
        else if (term === "NULL") row[column] = null;
        else if (term === "CURRENT_TIMESTAMP") row[column] = stamp;
        else if (/^'.*'$/.test(term)) row[column] = term.slice(1, -1);
        else if (/^\d+$/.test(term)) row[column] = Number(term);
        else throw new Error(`UNKNOWN_TERM:${term}`);
      });
      (tables[m[1]] ??= []).push(row); rows = [];
    }
    return { rows, rowCount: rows.length };
  } };
  const service = createPostgresRealmRuntimeSaveRestorer({ async connect() { return client; } } as never, { validateWorldBinding: async () => {} });
  return { calls, tables, query: client.query, restore: (a: RealmRuntimeSaveArchive) => service.restore({ archive: a, workspaceId: "ws", principalId: "owner", targetWorldId: "world", idempotencyKey: "key" }) };
}

test("focused restore fixture really reaches production writes", async () => {
  const d = restoreDouble(); const r = await d.restore(archive());
  assert.equal(r.replayed, false); assert.equal(d.tables.outbox.length, 1);
});
test("fresh restore derives marker only for validated engine body and probes before first write", async () => {
  for (const wrapped of [false, true]) {
    const body = { recordId: "source-record", eventIds: ["source-event", "source-event"], literal: "source-event" };
    const d = restoreDouble(), r = await d.restore(archive("record.events.committed", wrapped ? { __realmRuntimePayload: body, metadata: "literal" } : body));
    assert.equal(d.tables.outbox[0].restore_delivery_kind, "record-events-v1");
    assert.equal(d.tables.outbox[0].turn_run_id, null);
    const payload = d.tables.outbox[0].payload as Row;
    const mapped = (wrapped ? payload.__realmRuntimePayload : payload) as Row;
    assert.equal(mapped.recordId, r.recordId); assert.equal(mapped.literal, "source-event");
    assert.deepEqual(mapped.eventIds, [d.tables.events[0].id, d.tables.events[0].id]);
    const probes = d.calls.filter(c => c.sql === P); assert.equal(probes.length, 1); assert.deepEqual(probes[0].values, []);
    assert.ok(d.calls.findIndex(c => c.sql === P) < d.calls.findIndex(c => c.sql.startsWith("INSERT")));
    const before = d.calls.length; const replay = await d.restore(archive("record.events.committed", wrapped ? { __realmRuntimePayload: body, metadata: "literal" } : body));
    assert.equal(replay.replayed, true); assert.equal(d.calls.slice(before).filter(c => c.sql === P || c.sql.startsWith("INSERT")).length, 0);
  }
});
test("custom restore JSON and self-reported trust remain literal with null marker", async () => {
  const body = { origin: "record-events-restore-v1", restore_delivery_kind: "record-events-v1", recordId: "foreign", __realmRuntimePayload: { eventIds: ["foreign"] } };
  const d = restoreDouble(); await d.restore(archive("custom", body));
  assert.deepEqual(d.tables.outbox[0].payload, body); assert.equal(d.tables.outbox[0].restore_delivery_kind, null);
});
test("fresh restore without outbox requires schema, missing column refuses before zero writes", async () => {
  for (const includeOutbox of [false, true]) {
    const d = restoreDouble(true);
    await assert.rejects(d.restore(archive(undefined, undefined, includeOutbox)), { code: "RUNTIME_SAVE_INVALID" });
    assert.equal(d.calls.filter(c => c.sql === P).length, 1); assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
    assert.equal(d.calls.at(-1)!.sql, "ROLLBACK");
  }
});
test("malformed engine own wrapper refuses before schema or writes without flat fallback", async () => {
  const d = restoreDouble();
  await assert.rejects(d.restore(archive("record.events.committed", { recordId: "source-record", eventIds: ["source-event"], __realmRuntimePayload: 7 })), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(d.calls.filter(c => c.sql === P || c.sql.startsWith("INSERT")).length, 0);
});

test("fresh restore without outbox still probes once; conflict and replay probe zero times", async () => {
  const d=restoreDouble(), a=archive(undefined,undefined,false);
  await d.restore(a);assert.equal(d.calls.filter(c=>c.sql===P).length,1);
  const before=d.calls.length;assert.equal((await d.restore(a)).replayed,true);
  assert.equal(d.calls.slice(before).filter(c=>c.sql===P||c.sql.startsWith("INSERT")).length,0);
  const changed=archive("custom",{literal:"changed"});
  await assert.rejects(d.restore(changed),{code:"RESTORE_CONFLICT"});
  assert.equal(d.calls.slice(before).filter(c=>c.sql===P||c.sql.startsWith("INSERT")).length,0);
});
test("strict restore double refuses unknown SQL, wrong probe binds and altered narrator protocol",async()=>{
  const d=restoreDouble();
  await assert.rejects(d.query("SELECT unknown_protocol()",[]),/UNKNOWN_RESTORE_SQL/);
  await assert.rejects(d.query(P,["wrong"]));
  await assert.rejects(d.query("INSERT INTO participants (id) VALUES ($1)",["narrator"]),/UNKNOWN_RESTORE_SQL/);
});
