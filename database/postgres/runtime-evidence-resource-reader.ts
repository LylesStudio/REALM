import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { MemoryPgJsonStream, RuntimeSectionWireLedger, countRuntimeSectionWireBytes, memoryJsonStringBytes, RealmRuntimeSaveError } from "../../modules/world-transfer/realm-runtime-save.ts";
// Bounds on transport buffers only; the original file capacity still applies.
export const EVIDENCE_PAGE_ROWS = 1000;
export const EVIDENCE_CHUNK_BYTES = 65536;
const INLINE_BYTES = 256;
const FINITE_BOUNDARY = "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";
export const evidenceFields = {
  "action_receipts": {
    "table": "action_receipts",
    "text": [
      "id",
      "transaction_id",
      "call_fingerprint",
      "actor_character_instance_id",
      "source_event_id",
      "recorded_at"
    ],
    "json": [
      "receipt"
    ],
    "scalars": [
      "world_tick",
      "world_ordinal"
    ],
    "keys": [
      "world_tick",
      "world_ordinal",
      "id"
    ]
  },
  "character_effects": {
    "table": "character_effects",
    "text": [
      "id",
      "character_instance_id",
      "effect_definition_id",
      "effect_key",
      "source_action_receipt_id",
      "status"
    ],
    "json": [
      "metadata"
    ],
    "scalars": [
      "applied_tick",
      "applied_ordinal",
      "ended_tick",
      "ended_ordinal",
      "revision"
    ],
    "keys": [
      "applied_tick",
      "applied_ordinal",
      "id"
    ]
  },
  "observations": {
    "table": "observations",
    "text": [
      "id",
      "observer_character_instance_id",
      "source_event_id",
      "dedupe_key",
      "observation_kind",
      "content",
      "learned_at"
    ],
    "json": [
      "metadata"
    ],
    "scalars": [
      "fidelity",
      "occurred_tick",
      "occurred_ordinal",
      "available_from_tick",
      "available_from_ordinal"
    ],
    "keys": [
      "occurred_tick",
      "occurred_ordinal",
      "id"
    ]
  }
} as const;
export type EvidenceFamily = keyof typeof evidenceFields;
type Client = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
const invalid = (): never => { throw new RealmRuntimeSaveError("INVALID_SAVE", "Runtime evidence resource protocol is invalid."); };
function integer(value: unknown): number {
  const n = Number(value);
  if (!["string", "number"].includes(typeof value) || String(value).trim() === "" || !Number.isSafeInteger(n) || n < 0) invalid();
  return n;
}
function cursorName(value: string): string {
  if (!/^realm_evidence_[a-f0-9]+$/.test(value)) invalid();
  return value;
}
function normalizedJson(column: string): string {
  return `CASE WHEN jsonb_typeof(${column})='object' AND NOT jsonb_path_exists(${column},
    'strict $.** ? (@.type() == "number" && (@ >= ${FINITE_BOUNDARY} || @ <= -${FINITE_BOUNDARY}))') THEN ${column} ELSE '{}'::jsonb END`;
}
function source(family: EvidenceFamily, body = false): string {
  const d = evidenceFields[family];
  const columns = [...d.text, ...d.json, ...d.scalars].map(k => k === 'effect_key' ? 'definition.effect_key' : ['recorded_at','learned_at'].includes(k) ? `e.${k}::text AS ${k}` : `e.${k}`);
  // Resolve the workspace/id primary key before the World check. With fresh
  // statistics, putting World inside the lookup can choose the effect_key index
  // by tenant prefix and rescan that world's definitions for every effect.
  // The inner LIMIT fences an already unique identity, never accepted effects;
  // the outer World predicate retains the original INNER/scope semantics.
  const join = family === 'character_effects' ? `JOIN LATERAL (
    SELECT bound_definition.effect_key FROM (
      SELECT definition.world_id, definition.effect_key FROM effect_definitions AS definition
      WHERE definition.workspace_id=e.workspace_id AND definition.id=e.effect_definition_id LIMIT 1
    ) AS bound_definition WHERE bound_definition.world_id=e.world_id
  ) AS definition ON TRUE` : '';
  return `SELECT e.ctid::text AS locator, ${columns.join(', ')} FROM ${d.table} AS e ${join}
    WHERE e.workspace_id=$1 AND e.world_id=$2 AND e.worldline_id=$3 AND e.record_id=$4${body ? ' AND e.ctid=$5::tid' : ''}`;
}
export function evidenceHeaderSql(family: EvidenceFamily, cursor: string): string {
  const d = evidenceFields[family];
  return `/* runtime evidence ${family} headers */ DECLARE ${cursorName(cursor)} NO SCROLL CURSOR FOR
    WITH evidence_source AS NOT MATERIALIZED (${source(family)})
    SELECT locator, row_number() OVER (ORDER BY ${d.keys.join(', ')})::text AS row_position, ${d.scalars.join(', ')},
    ${[...d.text, ...d.json].map(column => {
      const expr = d.json.includes(column as never) ? `(${normalizedJson(column)})::text` : column;
      return `(${expr}) IS NULL AS ${column}_is_null, COALESCE(octet_length(${expr}),0) AS ${column}_bytes, COALESCE(length(${expr}),0) AS ${column}_chars,
        CASE WHEN octet_length(${expr})<=${INLINE_BYTES} THEN ${expr} ELSE NULL END AS ${column}`;
    }).join(', ')} FROM evidence_source ORDER BY ${d.keys.map(k => `${k} ASC`).join(', ')}`;
}
export function evidenceBodySql(family: EvidenceFamily, column: string, cursor: string): string {
  const d = evidenceFields[family];
  if (![...d.text,...d.json].includes(column as never)) invalid();
  const expr = d.json.includes(column as never) ? `(${normalizedJson(column)})::text` : column;
  return `/* runtime evidence ${family} ${column} body */ DECLARE ${cursorName(cursor)} NO SCROLL CURSOR FOR
    WITH evidence_source AS NOT MATERIALIZED (${source(family,true)}),
    body AS MATERIALIZED (SELECT convert_to(${expr},'UTF8') AS bytes FROM evidence_source)
    SELECT chunk_start, substring(bytes FROM chunk_start FOR ${EVIDENCE_CHUNK_BYTES}) AS value
    FROM body CROSS JOIN LATERAL generate_series(1,octet_length(bytes),${EVIDENCE_CHUNK_BYTES}) AS positions(chunk_start) ORDER BY chunk_start`;
}
function decode(decoder: TextDecoder, value?: Uint8Array, stream = false): string {
  try { return decoder.decode(value, { stream }); } catch { return invalid(); }
}
function object(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
}
/** One snapshot header cursor, no per-page rescans or JS collation. Every body
 * uses the same full Record scope and base-table tid; it converts only once.
 * Caller supplies either an exact root-file ledger or the shared domain-file
 * evidence contribution ledger. The final domain/aggregate gates stay intact.
 */
export async function readEvidenceRows<T extends QueryResultRow>(client: Client, family: EvidenceFamily, scope: unknown[], ledger: RuntimeSectionWireLedger, project: (row: T) => unknown): Promise<{rows:T[]}> {
  if (scope.length !== 4) invalid();
  const d = evidenceFields[family], rows:T[] = [], ids = new Set<string>(), locators = new Set<string>();
  const fields = [...d.text,...d.json];
  const cost = (row: QueryResultRow) => countRuntimeSectionWireBytes(project(row as T),ledger.formatter);
  const headerCursor = `realm_evidence_${randomUUID().replaceAll('-','')}`;
  await client.query(evidenceHeaderSql(family,headerCursor),scope);
  try {
    for (;;) {
      const page = await client.query(`/* runtime evidence headers */ FETCH FORWARD ${EVIDENCE_PAGE_ROWS} FROM ${headerCursor}`);
      if (page.rows.length > EVIDENCE_PAGE_ROWS) invalid();
      if (!page.rows.length) break;
      for (const header of page.rows) {
        if (integer(header.row_position) !== rows.length+1 || typeof header.locator !== 'string' || !/^\(\d+,\d+\)$/.test(header.locator) || locators.has(header.locator)) invalid();
        locators.add(header.locator);
        const row:QueryResultRow = Object.fromEntries(d.scalars.map(k => [k,header[k]]));
        for (const column of fields) {
          const bytes=integer(header[`${column}_bytes`]), chars=integer(header[`${column}_chars`]);
          if (typeof header[`${column}_is_null`] !== 'boolean' || chars>bytes) invalid();
          if (header[`${column}_is_null`]) {
            if(bytes || chars || header[column]!==null) invalid();
            row[column]=null;
          } else if (bytes<=INLINE_BYTES) {
            if(typeof header[column]!=='string' || Buffer.byteLength(header[column])!==bytes || [...header[column]].length!==chars) invalid();
            if(d.json.includes(column as never)) {
              try { row[column]=JSON.parse(header[column]); } catch { invalid(); }
              object(row[column]);
            } else row[column]=header[column];
          } else {
            if(header[column]!==null) invalid();
            row[column]=d.json.includes(column as never)?{}:'';
          }
        }
        // Validate bounded scalars before fetching unrelated JSON. PG lengths
        // count codepoints; these conservative prechecks never reject valid UTF16.
        if(family==='action_receipts') for (const [column,limit] of [['transaction_id',512],['call_fingerprint',4096]] as const) {
          if(header[`${column}_is_null`] || integer(header[`${column}_chars`])<1 || integer(header[`${column}_chars`])>limit || integer(header[`${column}_bytes`])>limit*3) invalid();
        }
        const comma=rows.length?1:0;
        ledger.checkLowerBound(comma+cost(row));
        for(const column of fields) {
          const bytes=integer(header[`${column}_bytes`]);
          if(bytes<=INLINE_BYTES || header[`${column}_is_null`]) continue;
          const json=d.json.includes(column as never), old=json?countRuntimeSectionWireBytes(row[column],ledger.formatter):2;
          const remaining=ledger.remainingBytes-comma-cost(row)+old;
          if(remaining<0 || !json && bytes+2>remaining) invalid();
          const cursor=`realm_evidence_${randomUUID().replaceAll('-','')}`;
          await client.query(evidenceBodySql(family,column,cursor),[...scope,header.locator]);
          try {
            // Database UTF8 bytes are field content, not a file BOM. Keep leading U+FEFF.
            // https://nodejs.org/api/util.html#new-textdecoderencoding-options
            const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}), parser=json?new MemoryPgJsonStream(remaining):null,parts:string[]=[];
            let textBytes=2,characters=0;
            for(let position=1;position<=bytes;position+=EVIDENCE_CHUNK_BYTES) {
              const chunk=await client.query(`/* runtime evidence body */ FETCH FORWARD 1 FROM ${cursor}`),item=chunk.rows[0];
              if(chunk.rows.length!==1 || integer(item?.chunk_start)!==position || !Buffer.isBuffer(item?.value) || item.value.length!==Math.min(EVIDENCE_CHUNK_BYTES,bytes-position+1)) invalid();
              const value=decode(decoder,item.value,true);characters += [...value].length;
              if(parser) parser.write(value);
              else {textBytes+=memoryJsonStringBytes(value)-2;if(textBytes>remaining) invalid();parts.push(value);}
            }
            const tail=decode(decoder);characters += [...tail].length;
            if(characters!==integer(header[`${column}_chars`])) invalid();
            if(parser) {parser.write(tail);row[column]=parser.finish();object(row[column]);}
            else {textBytes+=memoryJsonStringBytes(tail)-2;if(textBytes>remaining) invalid();parts.push(tail);row[column]=parts.join('');}
            const end=await client.query(`/* runtime evidence body */ FETCH FORWARD 1 FROM ${cursor}`);
            if(end.rows.length) invalid();
          } catch(error) {try {await client.query(`CLOSE ${cursor}`);} catch { /* preserve primary failure */ } throw error;}
          await client.query(`CLOSE ${cursor}`);
          if(family==='action_receipts' && (column==='transaction_id'||column==='call_fingerprint') && (row[column] as string).length>(column==='transaction_id'?512:4096)) invalid();
        }
        if(family==='action_receipts' && ((row.transaction_id as string).length>512 || (row.call_fingerprint as string).length>4096)) invalid();
        if(typeof row.id!=='string' || ids.has(row.id)) invalid();
        ids.add(row.id);ledger.addExact(comma);ledger.reserve(project(row as T));rows.push(row as T);
      }
    }
  } catch(error) {try {await client.query(`CLOSE ${headerCursor}`);} catch { /* preserve primary failure */ } throw error;}
  await client.query(`CLOSE ${headerCursor}`);
  return {rows};
}
