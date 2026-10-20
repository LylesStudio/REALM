import assert from "node:assert/strict";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
import test from "node:test";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { countRuntimeSectionWireBytes, serializeRealmRuntimeSaveRecordV1 } from "../modules/world-transfer/realm-runtime-save.ts";

const scope = { workspaceId: "parallel_a_ws", worldId: "parallel_a_world", worldlineId: "parallel_a_line", recordId: "parallel_a_record" };
const COMMAND_MAP_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
const COMMAND_MAP_READ_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const PAGE = 1000, CHUNK = 65536;
function pgLength(value: string): number { return value.length - [...value.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)].length; }
function pgPayload(row: SourceRow): string { return JSON.stringify(row.payload).replace('"number":1', '"number":1.000000e0'); }
type SourceRow = ReturnType<typeof sourceRow>;
function sourceRow(index: number, content = "") {
  return { id: `event_${index}`, record_version: String(index + 1), record_ordinal: String(index),
    event_kind: "narration.committed", payload: { number: 1, text: "汉😀\\\"" }, content,
    speaker_name: "", actor_participant_id: null, scene_id: "scene", visibility_policy_id: "policy",
    world_tick: String(index), world_ordinal: "0", calendar_id: "calendar", display_time: "" };
}
function mapped(row: SourceRow) {
  return { eventId: row.id, recordVersion: Number(row.record_version), ordinal: Number(row.record_ordinal),
    kind: row.event_kind, payload: { content: row.content, speakerName: row.speaker_name,
      actorParticipantId: row.actor_participant_id, sceneId: row.scene_id, visibilityPolicyId: row.visibility_policy_id,
      worldTick: Number(row.world_tick), worldOrdinal: Number(row.world_ordinal), calendarId: row.calendar_id,
      displayTime: row.display_time, eventPayload: row.payload } };
}
function driver(rows: SourceRow[], rawPayloadText?: string) {
  const payloadText = (row: SourceRow) => rawPayloadText ?? pgPayload(row);
  const cursors = new Map<string, { bytes: Buffer; offset: number }>();
  const evidenceCursors = new Set<string>();
  const trace: { sql: string; values: unknown[]; returned: number; maxChars: number }[] = [];
  let acquired = 0, released = 0;
  const client = { release() { assert.equal(evidenceCursors.size, 0, "all empty evidence cursors must close"); released++; }, async query(sql: string, values: unknown[] = []) {
    let result: unknown[] = [];
    // Installed schema, explicitly no persisted policy map in this event-only fixture.
    if (sql.replace(/\s+/g, " ").trim() === COMMAND_MAP_CAPABILITY_SQL) {
      assert.deepEqual(values, []);
      result = [{ command_materializations_available: true }];
    } else if (sql.replace(/\s+/g, " ").trim() === COMMAND_MAP_READ_SQL) {
      assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]);
      result = [];
    } else if (sql.includes("realmworld_command_materializations") || sql.includes("command_materializations_available")) {
      throw new Error("UNKNOWN_COMMAND_MATERIALIZATION_SQL");
    } else if (sql.startsWith("/* runtime evidence ")) {
        const q = sql.replace(/\s+/g, " ").trim();
        const declaration = /^\/\* runtime evidence (action_receipts|character_effects|observations) headers \*\/ DECLARE (realm_evidence_[a-f0-9]+) /.exec(q);
        const page = /^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(q);
        if (declaration) {
          const family = declaration[1] as "action_receipts" | "character_effects" | "observations";
          assert.equal(q, evidenceHeaderSql(family, declaration[2]!).replace(/\s+/g, " ").trim());
          assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId]);
          assert.ok(!evidenceCursors.has(declaration[2]!)); evidenceCursors.add(declaration[2]!);
        } else if (page) { assert.deepEqual(values, []); assert.ok(evidenceCursors.has(page[1]!)); }
        else throw Error("UNKNOWN_EMPTY_EVIDENCE_SQL:" + q);
      } else if (/^CLOSE realm_evidence_[a-f0-9]+$/.test(sql)) {
        assert.deepEqual(values, []); assert.ok(evidenceCursors.delete(sql.slice(6)), "unknown evidence cursor");
      } else if (sql.includes("record.id AS record_id")) result = [{ world_id: scope.worldId, worldline_id: scope.worldlineId,
      record_id: scope.recordId, story_id: "story", world_version: "local", record_version: rows.length, next_record_ordinal: rows.length }];
    else if (sql.includes("SELECT role FROM player_world_memberships")) result = [{ role: "owner" }];
    else if (sql.includes("AS mixed")) result = [{ mixed: false }];
    else if (sql.includes("AS bound")) result = [{ bound: false }];
    else if (sql.includes("/* runtime event headers */")) {
      const after = values[2] === null ? null : BigInt(String(values[2]));
      result = rows.filter(row => after === null || BigInt(row.record_ordinal) > after).slice(0, PAGE).map(row => ({
        record_version: row.record_version, record_ordinal: row.record_ordinal, world_tick: row.world_tick, world_ordinal: row.world_ordinal,
        actor_is_null: row.actor_participant_id === null,
        ...Object.fromEntries(["id", "event_kind", "content", "speaker_name", "actor_participant_id", "scene_id", "visibility_policy_id", "calendar_id", "display_time"].flatMap(key => {
          const value = row[key as keyof SourceRow] as string | null;
          return [[key, value !== null && Buffer.byteLength(value) <= 256 ? value : null], [`${key}_chars`, value === null ? 0 : pgLength(value)], [`${key}_bytes`, value === null ? 0 : Buffer.byteLength(value)]];
        })), payload_chars: pgLength(payloadText(row)), payload_bytes: Buffer.byteLength(payloadText(row)), payload: Buffer.byteLength(payloadText(row)) <= 256 ? row.payload : null,
      }));
    } else if (sql.includes("/* runtime event payload cursor */")) {
      const name = /DECLARE (\w+)/.exec(sql)![1]!;
      const row = rows.find(row => row.record_ordinal === String(values[2]))!;
      cursors.set(name, { bytes: Buffer.from(payloadText(row)), offset: 0 });
    } else if (sql.includes("FETCH FORWARD")) {
      const name = /FROM (\w+)/.exec(sql)![1]!;
      const cursor = cursors.get(name)!;
      if (cursor.offset < cursor.bytes.length) {
        result = [{ value: cursor.bytes.subarray(cursor.offset, cursor.offset + CHUNK) }];
        cursor.offset += CHUNK;
      }
    } else if (sql.startsWith("CLOSE ")) {
      cursors.delete(sql.slice(6));
    } else if (sql.includes("/* runtime event chunk */")) {
      const row = rows.find(row => row.record_ordinal === String(values[2]))!;
      const column = sql.includes("jsonb_path_exists") ? "payload" : /substring\((\w+)(?:::text)? FROM/.exec(sql)![1]!;
      const text = column === "payload" ? payloadText(row) : row[column as keyof SourceRow] as string;
      const offset = Number(values[3]) - 1, size = Number(values[4]);
      result = [{ value: /[\uD800-\uDFFF]/.test(text) ? [...text].slice(offset, offset + size).join("") : text.slice(offset, offset + size) }];
    } else if (/FROM events\s+WHERE/.test(sql)) result = rows;
    const maxChars = Math.max(0, ...result.flatMap(row => Object.values(row as object).filter(value => typeof value === "string").map(value => pgLength(value))));
    trace.push({ sql, values, returned: result.length, maxChars });
    return { rows: result };
  } };
  return { database: { async connect() { acquired++; return client; } }, trace, counts: () => ({ acquired, released }) };
}

for (const count of [1000, 1001, 2001]) for (const purpose of ["record-export", "native-record-branch"] as const) {
  test(`A event resource reader keeps all ${count} rows for ${purpose} in bounded pages`, async () => {
    const rows = Array.from({ length: count }, (_, index) => sourceRow(index));
    const fixture = driver(rows);
    const archive = await createPostgresRealmRuntimeSaveReader(fixture.database as never).load({
      workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose,
      ...(purpose === "native-record-branch" ? { sessionProof: "proof" } : {}),
    });
    assert.ok(archive);
    assert.deepEqual(archive.record.events, rows.map(mapped));
    const events = fixture.trace.filter(row => /FROM events/.test(row.sql));
    assert.ok(events.length > 1, "source must page/header/hydrate rather than return one full event array");
    assert.ok(events.every(row => row.returned <= PAGE));
    const headers = events.filter(row => row.sql.includes("runtime event headers"));
    assert.equal(headers.length, Math.floor(count / PAGE) + 1);
    assert.ok(headers.every(row => row.sql.includes("ORDER BY record_ordinal ASC, id ASC") && row.sql.includes("LIMIT 1000")));
    assert.deepEqual(headers.map(row => row.values[2]), [null, ...Array.from({ length: Math.floor(count / PAGE) }, (_, page) => String((page + 1) * PAGE - 1))]);
    assert.deepEqual(fixture.counts(), { acquired: 1, released: 1 });
    assert.equal(fixture.trace[0]!.sql, purpose === "record-export" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal(fixture.trace.at(-1)!.sql, "COMMIT");
    assert.equal(countRuntimeSectionWireBytes(archive.record, "canonical-runtime"), Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(archive.record)));
  });
}

test("A event resource chunks preserve astral Unicode, escaped strings and normalized JSON numbers", async () => {
  const rows = [sourceRow(0, ("汉😀\\\"\n".repeat(17000)))];
  rows[0]!.payload.text = "汉😀\\\"".repeat(18000);
  const fixture = driver(rows);
  const archive = await createPostgresRealmRuntimeSaveReader(fixture.database as never).load({
    workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export",
  });
  assert.deepEqual(archive!.record.events, rows.map(mapped));
  const chunks = fixture.trace.filter(row => row.sql.includes("runtime event chunk"));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(row => row.maxChars <= CHUNK && row.returned === 1));
  assert.ok(chunks.every(row => row.sql.includes("FETCH FORWARD 1") || row.values[4] === CHUNK));
  for (const declaration of fixture.trace.filter(row => row.sql.includes("runtime event payload cursor"))) {
    assert.match(declaration.sql, /AS MATERIALIZED/);
    assert.match(declaration.sql, /65536/);
  }
});

test("A exact64MiB+1 mapped event refuses before transferring its ASCII content", async () => {
  const row = sourceRow(0);
  const emptyRecord = { format: "realm-runtime-record" as const, schemaVersion: 1 as const,
    scope: { worldId: scope.worldId, worldlineId: scope.worldlineId, recordId: scope.recordId },
    head: { recordVersion: 1, nextRecordOrdinal: 1 }, events: [mapped(row)] };
  const overhead = Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(emptyRecord));
  row.content = "x".repeat(67108864 + 1 - overhead);
  const fixture = driver([row]);
  await assert.rejects(createPostgresRealmRuntimeSaveReader(fixture.database as never).load({
    workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export",
  }), { code: "RUNTIME_SAVE_INVALID" });
  assert.ok(fixture.trace.filter(call => /FROM events/.test(call.sql)).every(call => call.maxChars <= CHUNK), "rejected source content crossed the driver boundary");
  assert.equal(fixture.trace.filter(call => call.sql.includes("substring(content FROM")).length, 0);
  assert.equal(fixture.trace.at(-1)!.sql, "ROLLBACK");
  assert.deepEqual(fixture.counts(), { acquired: 1, released: 1 });
});

test("A missing event text chunk rolls back without an unbounded fallback", async () => {
  const fixture = driver([sourceRow(0, "x".repeat(CHUNK + 1))]);
  const database = { async connect() {
    const client = await fixture.database.connect();
    const query = client.query.bind(client);
    client.query = async (sql: string, values: unknown[] = []) => sql.includes("substring(content FROM")
      ? { rows: [] } : query(sql, values);
    return client;
  } };
  await assert.rejects(createPostgresRealmRuntimeSaveReader(database as never).load({
    workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export",
  }), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(fixture.trace.at(-1)!.sql, "ROLLBACK");
  assert.equal(fixture.trace.filter(call => /FROM events/.test(call.sql) && !call.sql.includes("runtime event")).length, 0);
});

test("A overflow preflight boundary matches JavaScript Number round-to-nearest", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../database/postgres/realm-runtime-save-repository.ts", import.meta.url), "utf8");
  const boundary = /EVENT_FINITE_NUMBER_BOUNDARY = "(\d+)"/.exec(source)![1]!;
  assert.equal(BigInt(boundary), BigInt(2) ** BigInt(1024) - BigInt(2) ** BigInt(970));
  assert.equal(Number(boundary), Infinity);
  assert.equal(Number(String(BigInt(boundary) - BigInt(1))), Number.MAX_VALUE);
  assert.equal(Number(`-${boundary}`), -Infinity);
  assert.equal(Number(`-${BigInt(boundary) - BigInt(1)}`), -Number.MAX_VALUE);
});

test("Iris A long-decimal normalized-small payload converts once then fetches bounded bytes", async () => {
  // Exact independent adversarial vector: legal PG numeric scale, tiny JS output.
  const numeric = "0." + "0".repeat(16382) + "1";
  const raw = "{" + Array.from({ length: 4096 }, (_, i) => `"n${String(i).padStart(4, "0")}": ${numeric}`).join(", ") + "}";
  assert.equal(raw.length, 67158016);
  const row = sourceRow(0);
  row.payload = JSON.parse(raw);
  const fixture = driver([row], raw);
  const archive = await createPostgresRealmRuntimeSaveReader(fixture.database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export" });
  assert.deepEqual(archive!.record.events, [mapped(row)]);
  assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(archive!.record)) < 100_000);
  const conversions = fixture.trace.filter(call => call.sql.includes("runtime event chunk") && call.sql.includes("jsonb_path_exists"));
  assert.equal(conversions.length, 0, "each chunk must not re-run whole JSONB conversion/preflight");
  const declarations = fixture.trace.filter(call => call.sql.includes("runtime event payload cursor"));
  assert.equal(declarations.length, 1);
  assert.match(declarations[0]!.sql, /AS MATERIALIZED/);
  assert.match(declarations[0]!.sql, /convert_to/);
  const fetches = fixture.trace.filter(call => /FETCH FORWARD 1 FROM realm_event_payload_/.test(call.sql));
  assert.equal(fetches.length, Math.ceil(Buffer.byteLength(raw) / CHUNK));
  assert.ok(fetches.every(call => call.returned === 1 && !call.sql.includes("::text")));
  assert.equal(fixture.trace.filter(call => call.sql.startsWith("CLOSE realm_event_payload_")).length, 1);
});

test("Iris A byte cursor preserves an astral code point split at the transfer boundary", async () => {
  const row = sourceRow(0);
  row.payload.text = "";
  const prefixBytes = Buffer.byteLength(pgPayload(row).slice(0, -2));
  row.payload.text = "x".repeat(CHUNK - prefixBytes - 1) + "😀";
  const fixture = driver([row]);
  const archive = await createPostgresRealmRuntimeSaveReader(fixture.database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export" });
  assert.deepEqual(archive!.record.events, [mapped(row)]);
  assert.equal(fixture.trace.filter(call => /FETCH FORWARD 1 FROM realm_event_payload_/.test(call.sql)).length, 2);
});

test("Iris A missing payload cursor chunk closes it and rolls back without fallback", async () => {
  const row = sourceRow(0);
  row.payload.text = "x".repeat(CHUNK + 1);
  const fixture = driver([row]);
  const database = { async connect() {
    const client = await fixture.database.connect();
    const query = client.query.bind(client);
    client.query = async (sql: string, values: unknown[] = []) => /FETCH FORWARD 1 FROM realm_event_payload_/.test(sql) ? { rows: [] } : query(sql, values);
    return client;
  } };
  await assert.rejects(createPostgresRealmRuntimeSaveReader(database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export" }), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(fixture.trace.filter(call => call.sql.startsWith("CLOSE realm_event_payload_")).length, 1);
  assert.equal(fixture.trace.at(-1)!.sql, "ROLLBACK");
  assert.equal(fixture.trace.filter(call => call.sql.includes("runtime event chunk") && call.sql.includes("jsonb_path_exists")).length, 0);
});
