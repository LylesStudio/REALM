/** Production reader + explicit SQL protocol doubles. No PostgreSQL execution. */
import assert from "node:assert/strict";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { countRuntimeSectionWireBytes, serializeRealmRuntimeSaveOutboxV1 } from "../modules/world-transfer/realm-runtime-save.ts";

const scope = { workspaceId: "outbox_ws", worldId: "outbox_world", worldlineId: "outbox_line", recordId: "outbox_record" };
const COMMAND_MAP_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
const COMMAND_MAP_READ_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const PAGE = 1000, CHUNK = 65536, LIMIT = 67108864;
function message(i = 0) {
  return { id: `message_${String(i).padStart(6, "0")}`, dedupe_key: `dedupe_${i}`, topic: "event.committed",
    payload: { n: 1, text: "汉😀\\\"\n" } as unknown, state: "pending", attempt_count: 0,
    available_at: "2026-10-18T00:00:00.000Z", event_id: null as string | null,
    lease_owner: null as string | null, lease_expires_at: null as string | null,
    last_error_code: null as string | null, last_error_message: null as string | null, last_error_at: null as string | null,
    // Same millisecond, distinct microseconds and ties spanning page boundaries.
    created_at: `2026-10-18 00:00:00.${String(Math.floor(i / 2)).padStart(6, "0")}+00` };
}
type Row = ReturnType<typeof message>;
function mapped(row: Row) {
  const { id, dedupe_key, topic, payload, state, attempt_count, available_at, event_id,
    lease_owner, lease_expires_at, last_error_code, last_error_message, last_error_at } = row;
  return { sourceMessageId: id, dedupeKey: dedupe_key, topic, envelope: payload,
    state, deliveryAttempts: attempt_count, nextAttemptAt: available_at, sourceEventId: event_id,
    leaseOwner: lease_owner, leaseExpiresAt: lease_expires_at, lastErrorCode: last_error_code,
    lastErrorMessage: last_error_message, lastErrorAt: last_error_at };
}
function document(rows: Row[]) { return { format: "realm-runtime-outbox" as const, schemaVersion: 1 as const, messages: rows.map(mapped) }; }
function driver(rows: Row[], options: { raw?: string; whole?: boolean; sibling?: boolean; missingChunk?: boolean } = {}) {
  const trace: { sql: string; values: unknown[]; returned: number; maxText: number; maxBytes: number; payloadBodies: number }[] = [];
  const cursors = new Map<string, { bytes: Buffer; offset: number }>();
  const evidenceCursors = new Set<string>();
  const finiteJson = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value)
    : value !== null && typeof value === "object" ? Object.values(value).every(finiteJson) : true;
  // Prepare the simulated server bytes outside the production-reader call.
  // These are fixture allocations, never claimed as driver or reader work.
  const payloadBytes = rows.map(row => Buffer.from(row.payload !== null && typeof row.payload === "object"
    && !Array.isArray(row.payload) && finiteJson(row.payload) ? options.raw ?? JSON.stringify(row.payload) : "{}"));
  let acquired = 0, released = 0, inFlight = false;
  const client = { release() { assert.equal(evidenceCursors.size, 0, "all empty evidence cursors must close"); released++; }, async query(sql: string, values: unknown[] = []) {
    assert.equal(inFlight, false, "one client must never issue concurrent SQL"); inFlight = true;
    try {
      let result: unknown[] = [];
      // Installed schema, explicitly no persisted policy map in this Outbox-only fixture.
      if (sql.startsWith("/* runtime evidence ")) {
        const q = sql.replace(/\s+/g, " ").trim();
        const declaration = /^\/\* runtime evidence (action_receipts|character_effects|observations) headers \*\/ DECLARE (realm_evidence_[a-f0-9]+) /.exec(q);
        const page = /^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(q);
        if (declaration) {
          const family = declaration[1] as "action_receipts" | "character_effects" | "observations";
          assert.equal(q, evidenceHeaderSql(family, declaration[2]!).replace(/\s+/g, " ").trim());
          assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, (options.sibling && values[3] === "outbox_sibling" ? "outbox_sibling" : scope.recordId)]);
          assert.ok(!evidenceCursors.has(declaration[2]!)); evidenceCursors.add(declaration[2]!);
        } else if (page) { assert.deepEqual(values, []); assert.ok(evidenceCursors.has(page[1]!)); }
        else throw Error("UNKNOWN_EMPTY_EVIDENCE_SQL:" + q);
      } else if (/^CLOSE realm_evidence_[a-f0-9]+$/.test(sql)) {
        assert.deepEqual(values, []); assert.ok(evidenceCursors.delete(sql.slice(6)), "unknown evidence cursor");
      } else if (sql.replace(/\s+/g, " ").trim() === COMMAND_MAP_CAPABILITY_SQL) {
        assert.deepEqual(values, []);
        result = [{ command_materializations_available: true }];
      } else if (sql.replace(/\s+/g, " ").trim() === COMMAND_MAP_READ_SQL) {
        assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]);
        result = [];
      } else if (sql.includes("realmworld_command_materializations") || sql.includes("command_materializations_available")) {
        throw new Error("UNKNOWN_COMMAND_MATERIALIZATION_SQL");
      } else if (sql.includes("record.id AS record_id")) result = [{ world_id: scope.worldId, worldline_id: scope.worldlineId,
        record_id: scope.recordId, story_id: "story", world_version: "local", record_version: 0, next_record_ordinal: 1 }];
      else if (sql.includes("SELECT role FROM player_world_memberships")) result = [{ role: "owner" }];
      else if (sql.includes("AS mixed")) result = [{ mixed: false }];
      else if (sql.includes("AS bound")) result = [{ bound: false }];
      else if (options.sibling && /SELECT linked_record_id FROM records/.test(sql)) result = [{ linked_record_id: "outbox_sibling" }];
      else if (options.sibling && /SELECT record.id, record.story_id, record.title/.test(sql)) result = [{
        id: "outbox_sibling", story_id: "story", title: "Sibling", status: "active", world_version: "local",
        start_tick: 0, start_ordinal: 0, timeline_kind: "branch", linked_record_id: null,
        record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 }];
      else if (options.sibling && /FROM record_first_nights/.test(sql) && values[1] === "outbox_sibling") throw new Error("WHOLE_SIBLING_AFTER_OUTBOX_SENTINEL");
      else if (options.whole && /SELECT id, title, status, premise/.test(sql)) throw new Error("WHOLE_AFTER_OUTBOX_SENTINEL");
      else if (sql.includes("outbox payload cursor")) {
        const name = /DECLARE (\w+)/.exec(sql)![1]!;
        const index = Number(String(values[4]).slice(3, -1)) - 1;
        cursors.set(name, { bytes: payloadBytes[index]!, offset: 0 });
      } else if (sql.includes("FETCH FORWARD")) {
        const cursor = cursors.get(/FROM (\w+)/.exec(sql)![1]!)!;
        if (!options.missingChunk && cursor.offset < cursor.bytes.length) {
          result = [{ value: cursor.bytes.subarray(cursor.offset, cursor.offset + CHUNK) }]; cursor.offset += CHUNK;
        }
      } else if (sql.startsWith("CLOSE ")) cursors.delete(sql.slice(6));
      else if (sql.includes("outbox reference chunk")) {
        const row = rows[Number(String(values[4]).slice(3, -1)) - 1]!;
        const key = /substring\((\w+) FROM/.exec(sql)![1]!;
        const value = row[key as "id" | "event_id"]!;
        result = [{ value: value.slice(Number(values[5])-1, Number(values[5])-1+Number(values[6])) }];
      } else if (/FROM outbox\s+WHERE/.test(sql)) {
        const after = values[4] as string | null;
        const selected = (options.sibling && values[3] === scope.recordId ? [] : rows).filter(row => row.state !== "delivered" && (!after || row.created_at > after || row.created_at === after && row.id > String(values[5])));
        result = /LIMIT 1000/.test(sql) ? selected.slice(0, PAGE) : selected;
        if (sql.includes("outbox preflight")) result = (result as Row[]).map(row => {
          const header: Record<string, unknown> = { ...row, row_locator: `(0,${rows.indexOf(row)+1})`, payload: row.payload };
          for (const [key, limit] of Object.entries({ dedupe_key: 512, topic: 256, lease_owner: 256, last_error_code: 128, last_error_message: 4096 })) {
            const value = row[key as keyof Row] as string | null;
            header[`${key}_valid`] = value === null || value.length <= limit;
            header[key] = header[`${key}_valid`] ? value : null;
          }
          // Emulate SQL projection, including payload omission for rejected fields.
          if (Object.keys(header).some(key => key.endsWith("_valid") && !header[key])) header.payload = null;
          if (sql.includes("outbox bounded envelope")) {
            delete header.payload;
            for (const key of ["id", "event_id"] as const) {
              const value = row[key]; header[`${key}_is_null`] = value === null;
              header[`${key}_chars`] = value?.length ?? 0; header[`${key}_bytes`] = value === null ? 0 : Buffer.byteLength(value);
              header[key] = value !== null && Buffer.byteLength(value) <= 256 ? value : null;
            }
          }
          return header;
        });
      }
      const strings = result.flatMap(row => Object.values(row as object).filter((v): v is string => typeof v === "string"));
      const buffers = result.flatMap(row => Object.values(row as object).filter((v): v is Buffer => Buffer.isBuffer(v)));
      trace.push({ sql, values, returned: result.length, maxText: Math.max(0, ...strings.map(v => v.length)), maxBytes: Math.max(0, ...buffers.map(v => v.length)), payloadBodies: result.filter(row => (row as Row).payload !== null && Object.hasOwn(row as object,"payload")).length });
      return { rows: result };
    } finally { inFlight = false; }
  } };
  return { database: { async connect() { acquired++; return client; } }, trace, cursors, counts: () => ({ acquired, released }) };
}
async function load(f: ReturnType<typeof driver>, purpose: "record-export" | "native-record-branch" | "whole-closure-backup" = "record-export") {
  return createPostgresRealmRuntimeSaveReader(f.database as never).load({ workspaceId: scope.workspaceId,
    recordId: scope.recordId, principalId: "owner", purpose, ...(purpose === "native-record-branch" ? { sessionProof: "proof" } : {}) });
}
for (const count of [1001, 2001]) for (const purpose of ["record-export", "native-record-branch"] as const) {
  test(`Outbox pages retain ${count} rows and microsecond/tie order for ${purpose}`, async () => {
    const rows = Array.from({ length: count }, (_, i) => message(i)), f = driver(rows);
    const archive = await load(f, purpose);
    assert.deepEqual(archive!.outbox, document(rows));
    const calls = f.trace.filter(c => /runtime outbox headers/.test(c.sql));
    console.log(JSON.stringify({ purpose, count, driverRows: calls.map(c => c.returned) }));
    assert.ok(calls.every(c => c.returned <= PAGE), "bulk Outbox crossed the driver boundary");
    assert.equal(calls.length, Math.floor(count / PAGE) + 1);
    assert.ok(calls.every(c => /ORDER BY created_at ASC, id ASC/.test(c.sql) && /LIMIT 1000/.test(c.sql) && !/OFFSET/.test(c.sql)));
    assert.deepEqual(calls.map(c => c.values.slice(4)), [[null, null], ...Array.from({length: Math.floor(count / PAGE)}, (_, i) => [rows[(i+1)*PAGE-1]!.created_at, rows[(i+1)*PAGE-1]!.id])]);
    assert.equal(f.trace[0]!.sql, purpose === "record-export" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal(f.trace.at(-1)!.sql, "COMMIT");
    assert.deepEqual(f.counts(), { acquired: 1, released: 1 });
  });
}
test("whole reader uses the same bounded Outbox loader before explicit domain sentinel (not a whole ZIP)", async () => {
  const previous = process.env.REALM_OPERATOR_PRINCIPALS; process.env.REALM_OPERATOR_PRINCIPALS = "owner";
  try {
    const f = driver(Array.from({length: 2001}, (_, i) => message(i)), { whole: true });
    await assert.rejects(load(f, "whole-closure-backup"), /WHOLE_AFTER_OUTBOX_SENTINEL/);
    const calls = f.trace.filter(c => /runtime outbox headers/.test(c.sql));
    assert.deepEqual(calls.map(c => c.returned), [1000,1000,1]);
  } finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
});

for (const key of ["topic", "dedupe_key", "lease_owner", "last_error_code", "last_error_message"] as const) {
  test(`Outbox preflight refuses a 1MiB ${key} before its body or envelope crosses driver`, async () => {
    const row = message(); row[key] = "x".repeat(1024 * 1024);
    row.payload = { unrelated: "p".repeat(1024 * 1024) };
    const f = driver([row]);
    await assert.rejects(load(f), { code: "RUNTIME_SAVE_INVALID" });
    const maxText = Math.max(...f.trace.map(c => c.maxText));
    console.log(JSON.stringify({ key, driverMaxText: maxText }));
    assert.ok(maxText < 1024 * 1024, "invalid field body already crossed the driver");
    assert.equal(f.trace.filter(c => /outbox payload cursor|FETCH FORWARD 1 FROM realm_outbox_payload_/.test(c.sql)).length, 0);
    assert.equal(f.trace.at(-1)!.sql, "ROLLBACK");
  });
}
for (const [topic, valid] of [["汉".repeat(256), true], ["😀".repeat(128), true], ["😀".repeat(129), false], ["a\u0001b", true], [" topic", false], ["topic\uFEFF", false], ["", false]] as const) {
  test(`Outbox topic follows codec UTF16/trim semantics: length ${topic.length}, valid ${valid}`, async () => {
    const row = message(); row.topic = topic; const f = driver([row]);
    if (valid) assert.equal((await load(f))!.outbox!.messages[0]!.topic, topic);
    else await assert.rejects(load(f), { code: "RUNTIME_SAVE_INVALID" });
    if (topic.length > 256) assert.ok(f.trace.every(c => c.maxText < topic.length));
  });
}

test("Outbox envelope streams normalized escaped/Unicode JSON with an astral split across bytes", async () => {
  const row = message(); row.payload = { text: "x".repeat(CHUNK - 11) + "😀汉\\\"\n".repeat(20000), n: 1 };
  const raw = JSON.stringify(row.payload).replace('"n":1','"n":1.000000');
  const f = driver([row], { raw }); const archive = await load(f);
  assert.deepEqual(archive!.outbox, document([row]));
  assert.ok(f.trace.filter(c => /headers/.test(c.sql)).every(c => c.payloadBodies === 0), "header transferred envelope body");
  const declarations = f.trace.filter(c => /outbox payload cursor/.test(c.sql));
  assert.equal(declarations.length, 1); assert.match(declarations[0]!.sql, /AS MATERIALIZED/);
  const fetches = f.trace.filter(c => /FETCH FORWARD 1 FROM realm_outbox_payload_/.test(c.sql));
  assert.equal(fetches.length, Math.ceil(Buffer.byteLength(raw)/CHUNK)+1);
  assert.ok(fetches.every(c => c.maxBytes <= CHUNK && !/::text|jsonb_path/.test(c.sql)));
  assert.equal(f.cursors.size, 0);
  assert.equal(countRuntimeSectionWireBytes(archive!.outbox,"canonical-runtime"), Buffer.byteLength(serializeRealmRuntimeSaveOutboxV1(archive!.outbox!)));
});
test("Outbox cursor closes on missing chunk and rolls back with no fallback", async () => {
  const f = driver([message()], { missingChunk: true });
  await assert.rejects(load(f), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(f.trace.filter(c => c.sql.startsWith("CLOSE realm_outbox_payload_")).length, 1);
  assert.equal(f.cursors.size, 0); assert.equal(f.trace.at(-1)!.sql, "ROLLBACK");
});
test("Outbox accepts legal >64MiB raw decimals whose normalized envelope is small", async () => {
  const numeric = "0." + "0".repeat(16382) + "1";
  const raw = "{" + Array.from({length:4096},(_,i)=>`"n${String(i).padStart(4,"0")}": ${numeric}`).join(", ") + "}";
  assert.equal(raw.length,67158016);
  const row = message(); row.payload = JSON.parse(raw);
  const f = driver([row], { raw }); const archive = await load(f);
  assert.deepEqual(archive!.outbox, document([row]));
  assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveOutboxV1(archive!.outbox!)) < 100000);
  assert.equal(f.trace.filter(c => /outbox payload cursor/.test(c.sql)).length,1);
  assert.equal(f.trace.filter(c => /FETCH FORWARD 1 FROM realm_outbox_payload_/.test(c.sql)).length,1026);
});
for (const delta of [0, 1]) test(`Outbox admits exact 64MiB normalized wire and rejects +1: delta=${delta}`, async () => {
  const row = message(); row.payload = { big: "" };
  const overhead = countRuntimeSectionWireBytes(document([row]),"canonical-runtime");
  row.payload = { big: "x".repeat(LIMIT+delta-overhead) };
  const f = driver([row]);
  if (!delta) {
    const archive = await load(f); assert.equal(countRuntimeSectionWireBytes(archive!.outbox,"canonical-runtime"),LIMIT);
    assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveOutboxV1(archive!.outbox!)),LIMIT);
  } else {
    await assert.rejects(load(f), { code: "RUNTIME_SAVE_INVALID" });
    assert.equal(f.trace.at(-1)!.sql,"ROLLBACK");
  }
  assert.equal(f.cursors.size,0);
  assert.ok(f.trace.filter(c=>/headers/.test(c.sql)).every(c=>c.payloadBodies===0));
});
for (const payload of [null, [], "text", 2, { overflow: Infinity, text: "x".repeat(CHUNK+1) }]) {
  test(`Outbox jsonObject fallback preserves non-object/nonfinite semantics: ${typeof payload}`, async () => {
    const row = message(); row.payload = payload; const f = driver([row]);
    assert.deepEqual((await load(f))!.outbox!.messages[0]!.envelope, {});
  });
}
test("Outbox references have no invented length cap and hydrate under file budget", async () => {
  const row = message(); row.id = "m".repeat(CHUNK+1);
  const f = driver([row]); const archive = await load(f);
  assert.equal(archive!.outbox!.messages[0]!.sourceMessageId, row.id);
  assert.ok(f.trace.every(c => c.maxText <= CHUNK));
  assert.ok(f.trace.some(c => /outbox reference chunk/.test(c.sql)));
});
test("small inherited Outbox output preserves bytes/hash, lease/errors, delivered omission", async () => {
  const row = message(); row.state = "delivering"; row.lease_owner = "worker汉😀"; row.lease_expires_at = row.available_at;
  row.last_error_code = "ERROR"; row.last_error_message = "失败\u0001"; row.last_error_at = row.available_at;
  const delivered = message(1); delivered.state = "delivered";
  const archive = await load(driver([row,delivered]));
  const expected = serializeRealmRuntimeSaveOutboxV1(document([row]) as never);
  const actual = serializeRealmRuntimeSaveOutboxV1(archive!.outbox!);
  console.log(JSON.stringify({ smallOutboxBytes: Buffer.byteLength(actual), smallOutboxSha256: createHash("sha256").update(actual).digest("hex") }));
  assert.equal(actual,expected); assert.equal(createHash("sha256").update(actual).digest("hex"),createHash("sha256").update(expected).digest("hex"));
});
test("all ordinary/native/whole/sibling source calls share the bounded loader", () => {
  const source = readFileSync(new URL("../database/postgres/realm-runtime-save-repository.ts",import.meta.url),"utf8");
  assert.equal((source.match(/loadRuntimeOutboxRows\(client,/g)??[]).length,2);
  assert.match(source,/loadRecordSections\(client,[\s\S]*?recordId: row.id/);
  const loader = source.slice(source.indexOf("async function loadRuntimeOutboxRows"),source.indexOf("/**\n * Load every persisted section"));
  assert.doesNotMatch(loader,/OFFSET|Promise\.all/);
});

test("Outbox cumulative escaped-wire +1 refuses before rejected full formatting or Buffer allocation", async () => {
  const row = message(); row.payload = { big: "", n: -0, unicode: "汉😀" };
  const overhead=countRuntimeSectionWireBytes(document([row]),"canonical-runtime"),body=LIMIT-overhead;
  // The first message exactly fills this file; the next message must fail
  // before opening another envelope or formatting the whole accumulated file.
  row.payload={big:"\n".repeat(Math.floor(body/2))+"x".repeat(body%2),n:-0,unicode:"汉😀"};
  assert.equal(countRuntimeSectionWireBytes(document([row]),"canonical-runtime"),LIMIT);
  const f=driver([row,message(1)]),stringify=JSON.stringify,from=Buffer.from;
  let largeFormatted=0,largeBuffers=0;
  JSON.stringify=function(...args:Parameters<typeof JSON.stringify>){const value=Reflect.apply(stringify,JSON,args);if(typeof value==="string"&&value.length>1024*1024)largeFormatted++;return value;} as typeof JSON.stringify;
  Buffer.from=function(...args:unknown[]){const value=Reflect.apply(from,Buffer,args) as Buffer;if(value.length>1024*1024)largeBuffers++;return value;} as typeof Buffer.from;
  try{await assert.rejects(load(f),{code:"RUNTIME_SAVE_INVALID"});}finally{JSON.stringify=stringify;Buffer.from=from;}
  assert.equal(largeFormatted,0);assert.equal(largeBuffers,0);
  assert.equal(f.trace.filter(c=>/outbox payload cursor/.test(c.sql)).length,1);
  assert.equal(f.cursors.size,0);assert.equal(f.trace.at(-1)!.sql,"ROLLBACK");
});

test("whole reader carries linked sibling through the actual bounded loader before explicit sentinel", async () => {
  const previous=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS="owner";
  try{
    const f=driver(Array.from({length:2001},(_,i)=>message(i)),{sibling:true});
    await assert.rejects(load(f,"whole-closure-backup"),/WHOLE_SIBLING_AFTER_OUTBOX_SENTINEL/);
    const headers=f.trace.filter(c=>c.sql.includes("outbox headers"));
    assert.deepEqual(headers.map(c=>[c.values[3],c.returned]),[[scope.recordId,0],["outbox_sibling",1000],["outbox_sibling",1000],["outbox_sibling",1]]);
    assert.equal(f.cursors.size,0);assert.equal(f.trace.at(-1)!.sql,"ROLLBACK");
  }finally{if(previous===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=previous;}
});
