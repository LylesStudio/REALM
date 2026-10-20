/** NOT_RUN in the parallel batch. Run only through the authorized serial disposable runner. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { POSTGRES_DEMO_IDS, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { serializeRealmRuntimeSaveRecordV1 } from "../modules/world-transfer/realm-runtime-save.ts";

const LIMIT = 67108864;
type Trace = { sql: string; rows: number; maxTextChars: number; textBytes: number; binaryBytes: number; maxChunkBytes: number };
function codepoints(text: string) { return text.length - [...text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)].length; }
async function fixture(t: test.TestContext, count: number, input: { contentBytes?: number; payload?: "overflow" | "long-decimal" | "unicode" } = {}) {
  // The runner generates this marker and both disposable database URLs. A
  // direct invocation against an unmarked/shared cluster fails before connect.
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "authorized disposable PG runner required");
  assert.ok(process.env.DATABASE_URL && process.env.REALM_RUNTIME_DATABASE_URL);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 });
  const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `parallel_a_world_${randomUUID()}`,
    worldlineId: `parallel_a_line_${randomUUID()}`, recordId: `parallel_a_record_${randomUUID()}` };
  const storyId = `parallel_a_story_${randomUUID()}`, sceneId = `parallel_a_scene_${randomUUID()}`, policyId = `parallel_a_policy_${randomUUID()}`;
  t.after(async () => {
    // History is immutable; the disposable runner owns destruction of this World.
    try { await runtime.end(); }
    finally { await owner.end(); }
  });
  await withWorkspaceTransaction(owner, scope.workspaceId, async client => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      const answer = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,
        [JSON.stringify(patch), scope.workspaceId, sourceId]);
      assert.equal(answer.rowCount, 1, `fixture ${table}`);
    };
    const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
    await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: "Parallel A resources" });
    await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: count, head_ordinal: 0 });
    await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick: 0, start_ordinal: 0 });
    await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: "active", start_tick: 0, start_ordinal: 0 });
    await clone("scenes", "record_id", POSTGRES_DEMO_IDS.record, { ...scoped, id: sceneId, start_tick: 0, start_ordinal: 0 });
    await clone("visibility_policies", "policy_kind='public' AND record_id", POSTGRES_DEMO_IDS.record, { ...scoped, id: policyId });
    await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scoped, record_version: count, next_record_ordinal: count + 1,
      last_event_id: null, last_world_tick: count, last_world_ordinal: 0 });
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",
      [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
  });
  async function append(start: number, end: number) {
    await withWorkspaceTransaction(owner, scope.workspaceId, async client => {
      const payload = {
        overflow: `jsonb_build_object('oversize',repeat('x',${LIMIT + 1}),'overflow','1e999'::jsonb)`,
        "long-decimal": `(SELECT jsonb_object_agg('n'||lpad(n::text,4,'0'),('0.'||repeat('0',16382)||'1')::numeric) FROM generate_series(0,4095) n)`,
        unicode: `jsonb_build_object('text',repeat('汉😀',20000))`,
      };
      // Special capacity inputs are written once, never UPDATEd after commit.
      const payloadSql = input.payload ? payload[input.payload] : `'{"number":1.000000,"small":1e-999}'::jsonb`;
      await client.query(`INSERT INTO events(workspace_id,world_id,worldline_id,record_id,scene_id,id,
        record_version,record_ordinal,batch_index,event_kind,speaker_name,content,payload,visibility_policy_id,
        world_tick,world_ordinal,calendar_id,display_time)
        SELECT $1,$2,$3,$4,$5,$4||'.event.'||n,n,n,0,'narration.committed','',
          CASE WHEN $9::integer IS NULL THEN '汉😀 quote" slash\\ newline'||chr(10) ELSE repeat('x',$9::integer) END,${payloadSql},$6,n,0,'calendar',''
        FROM generate_series($7::integer,$8::integer) n`,
        [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, sceneId, policyId, start, end, input.contentBytes ?? null]);
      await client.query(`UPDATE record_heads SET record_version=$3::bigint,next_record_ordinal=$3::bigint+1,last_event_id=$4,
        last_world_tick=$3::bigint,last_world_ordinal=0 WHERE workspace_id=$1 AND record_id=$2`,
        [scope.workspaceId, scope.recordId, end, `${scope.recordId}.event.${end}`]);
      await client.query("UPDATE worldlines SET head_tick=$3,head_ordinal=0 WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, scope.worldlineId, end]);
    });
  }
  if (count) await append(1, count);
  const trace: Trace[] = [];
  let afterFirstPage: (() => Promise<void>) | undefined;
  const observedDatabase = { async connect() {
    const client = await runtime.connect();
    const query = client.query, release = client.release;
    const execute = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<pg.QueryResult<pg.QueryResultRow>>;
    client.query = (async function(sql: string, values?: unknown[]) {
      const answer = await execute(sql, values);
      if (sql.includes("runtime event") || sql.startsWith("CLOSE ")) {
        const strings = answer.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string"));
        const buffers = answer.rows.flatMap(row => Object.values(row).filter((value): value is Buffer => Buffer.isBuffer(value)));
        trace.push({ sql, rows: answer.rows.length, maxTextChars: Math.max(0, ...strings.map(codepoints)),
          textBytes: strings.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
          binaryBytes: buffers.reduce((sum, value) => sum + value.length, 0), maxChunkBytes: Math.max(0, ...buffers.map(value => value.length)) });
        if (sql.includes("runtime event headers") && afterFirstPage) {
          const writer = afterFirstPage; afterFirstPage = undefined; await writer();
        }
      }
      return answer;
    }) as typeof client.query;
    client.release = (...args) => { client.query = query; client.release = release; release.apply(client, args); };
    return client;
  } };
  const load = (purpose: "record-export" | "native-record-branch" | "whole-closure-backup" = "record-export") =>
    createPostgresRealmRuntimeSaveReader(observedDatabase as never).load({ workspaceId: scope.workspaceId,
      recordId: scope.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose,
      ...(purpose === "native-record-branch" ? { sessionProof: "reader-only-proof" } : {}) });
  return { owner, scope, trace, load, append, afterPage(writer: () => Promise<void>) { afterFirstPage = writer; } };
}

for (const count of [1000, 1001, 2001]) test(`A PG real event pages retain all ${count} rows in all root readers`, async t => {
  const f = await fixture(t, count);
  const previous = process.env.REALM_OPERATOR_PRINCIPALS;
  process.env.REALM_OPERATOR_PRINCIPALS = POSTGRES_DEMO_IDS.principal;
  try {
    for (const purpose of ["record-export", "native-record-branch", "whole-closure-backup"] as const) {
      f.trace.length = 0;
      const archive = await f.load(purpose);
      assert.ok(archive);
      assert.equal(archive.record.events.length, count);
      assert.deepEqual(archive.record.events.map(row => row.ordinal), Array.from({ length: count }, (_, i) => i + 1));
      assert.equal(new Set(archive.record.events.map(row => row.eventId)).size, count);
      const pages = f.trace.filter(row => row.sql.includes("runtime event headers"));
      assert.equal(pages.length, Math.floor(count / 1000) + 1);
      assert.ok(f.trace.every(row => row.rows <= 1000 && row.maxTextChars <= 65536));
      t.diagnostic(JSON.stringify({ purpose, count, pages: pages.length, transfers: f.trace.map(row => ({ rows: row.rows, maxTextChars: row.maxTextChars, textBytes: row.textBytes })) }));
    }
  } finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
});

test("A PG event pages preserve the repeatable-read image across an independent committed writer", async t => {
  const f = await fixture(t, 2001);
  f.afterPage(() => f.append(2002, 2002));
  const old = await f.load();
  assert.equal(old!.record.events.length, 2001);
  assert.equal(old!.record.head.recordVersion, 2001);
  const fresh = await f.load();
  assert.equal(fresh!.record.events.length, 2002);
  assert.equal(fresh!.record.head.recordVersion, 2002);
});

test("A PG event exact64MiB and +1 enforce real pretransfer content limits", async t => {
  const minimum = await fixture(t, 1, { contentBytes: 1 });
  const base = await minimum.load();
  const overhead = Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(base!.record)) - 1;
  const f = await fixture(t, 1, { contentBytes: LIMIT - overhead });
  f.trace.length = 0;
  const exact = await f.load();
  assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(exact!.record)), LIMIT);
  assert.ok(f.trace.filter(row => row.sql.includes("runtime event chunk")).every(row => row.maxTextChars <= 65536 && row.rows === 1));
  const over = await fixture(t, 1, { contentBytes: LIMIT - overhead + 1 });
  await assert.rejects(over.load(), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(over.trace.filter(row => row.sql.includes("substring(content FROM")).length, 0);
});

test("A PG legal overflowing numeric JSON normalizes before a giant raw representation transfers", async t => {
  const f = await fixture(t, 1, { payload: "overflow" });
  f.trace.length = 0;
  const archive = await f.load();
  assert.deepEqual((archive!.record.events[0]!.payload as { eventPayload: unknown }).eventPayload, {});
  assert.equal(f.trace.filter(row => row.sql.includes("runtime event chunk")).length, 0);
});

test("Iris A PG long-decimal small-normalized payload uses one conversion cursor", async t => {
  const f = await fixture(t, 1, { payload: "long-decimal" });
  const raw = await f.owner.query("SELECT octet_length(convert_to(payload::text,'UTF8')) AS bytes FROM events WHERE workspace_id=$1 AND record_id=$2", [f.scope.workspaceId, f.scope.recordId]);
  assert.equal(raw.rows[0].bytes, 67158016);
  f.trace.length = 0;
  const archive = await f.load();
  const payload = (archive!.record.events[0]!.payload as { eventPayload: Record<string, number> }).eventPayload;
  assert.equal(Object.keys(payload).length, 4096);
  assert.ok(Object.values(payload).every(value => value === 0));
  assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(archive!.record)) < 100_000);
  const declarations = f.trace.filter(row => row.sql.includes("runtime event payload cursor"));
  assert.equal(declarations.length, 1);
  assert.match(declarations[0]!.sql, /AS MATERIALIZED/);
  const chunks = f.trace.filter(row => row.sql.includes("FETCH FORWARD"));
  assert.equal(chunks.length, 1025);
  assert.ok(chunks.every(row => row.rows === 1 && row.maxChunkBytes <= 65536 && !row.sql.includes("::text")));
  assert.equal(chunks.reduce((sum, row) => sum + row.binaryBytes, 0), raw.rows[0].bytes);
  const payloadCursor = /DECLARE (realm_event_payload_[a-f0-9]+) NO SCROLL CURSOR FOR/.exec(declarations[0]!.sql)![1];
  assert.equal(f.trace.filter(row => row.sql === `CLOSE ${payloadCursor}`).length, 1);
  t.diagnostic(JSON.stringify({ rawPayloadBytes: raw.rows[0].bytes, normalizedRecordBytes: Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(archive!.record)), cursorDeclarations: declarations.length, fetches: chunks.length, maxDecodedChunkBytes: Math.max(...chunks.map(row => row.maxChunkBytes)), note: "Driver-decoded bytea sizes, not TCP packet/hex protocol or measured server CPU amplification" }));
});

test("Iris A PG byte cursor preserves Unicode spanning chunk boundaries", async t => {
  const f = await fixture(t, 1, { payload: "unicode" });
  f.trace.length = 0;
  const archive = await f.load();
  assert.equal((archive!.record.events[0]!.payload as { eventPayload: { text: string } }).eventPayload.text, "汉😀".repeat(20000));
  const chunks = f.trace.filter(row => row.sql.includes("FETCH FORWARD"));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(row => row.rows === 1 && row.maxChunkBytes <= 65536));
});
