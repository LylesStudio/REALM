import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { MemoryPgJsonStream, RuntimeSectionWireLedger, countRuntimeSectionWireBytes, memoryJsonStringBytes, RealmRuntimeSaveError } from "../../modules/world-transfer/realm-runtime-save.ts";
// Transport bounds only: accepted topology capacity is the existing wire ledger.
export const TOPOLOGY_PAGE_ROWS = 1000;
export const TOPOLOGY_CHUNK_BYTES = 65536;
const INLINE_BYTES = 256;
const PENDING = "\u0000realm-topology-pending\u0000";
const FINITE_BOUNDARY = "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";
// Each lateral lookup binds a full existing unique identity (0 or 1 row).
// LIMIT 1 contains join reordering under stale statistics/RLS; it does not
// truncate accepted data or depend on ANALYZE, role changes, or planner GUCs.
const definitions = {
    "participants": {
        "query": `SELECT participant.ctid::text AS locator,
       participant.id AS participant_id,
       participant.participant_kind,
       participant.character_instance_id AS participant_character_instance_id,
       participant.principal_id AS participant_principal_id,
       participant.controller_mode AS participant_controller_mode,
       participant.is_active AS participant_is_active,
       participant.speaking_order AS participant_speaking_order,
       participant.shared_control_enabled AS participant_shared_control_enabled,
       instance.id AS instance_id,
       instance.continuity_id AS instance_continuity_id,
       instance.predecessor_instance_id AS instance_predecessor_id,
       instance.controller_mode AS instance_controller_mode,
       instance.status AS instance_status,
       instance.instantiated_tick AS instance_instantiated_tick,
       instance.instantiated_ordinal AS instance_instantiated_ordinal,
       instance.inheritance_cutoff_tick AS instance_inheritance_cutoff_tick,
       instance.inheritance_cutoff_ordinal AS instance_inheritance_cutoff_ordinal,
       instance.retired_tick AS instance_retired_tick,
       instance.retired_ordinal AS instance_retired_ordinal,
       instance.state AS instance_state,
       continuity.continuity_key,
       continuity.status AS continuity_status,
       continuity.born_tick AS continuity_born_tick,
       continuity.born_ordinal AS continuity_born_ordinal,
       continuity.ended_tick AS continuity_ended_tick,
       continuity.ended_ordinal AS continuity_ended_ordinal,
       definition.id AS definition_id,
       definition.display_name AS definition_display_name,
       definition.source_format AS definition_source_format,
       definition.profile AS definition_profile
     FROM participants AS participant
     LEFT JOIN LATERAL (
       SELECT * FROM character_instances AS instance
       WHERE instance.workspace_id = participant.workspace_id
         AND instance.world_id = participant.world_id
         AND instance.worldline_id = participant.worldline_id
         AND instance.record_id = participant.record_id
         AND instance.id = participant.character_instance_id
       LIMIT 1
     ) AS instance ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM character_continuities AS continuity
       WHERE continuity.workspace_id = instance.workspace_id
         AND continuity.world_id = instance.world_id
         AND continuity.worldline_id = instance.worldline_id
         AND continuity.id = instance.continuity_id
       LIMIT 1
     ) AS continuity ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM character_definitions AS definition
       WHERE definition.workspace_id = continuity.workspace_id
         AND definition.world_id = continuity.world_id
         AND definition.id = continuity.definition_id
       LIMIT 1
     ) AS definition ON TRUE
     WHERE participant.workspace_id = $1
       AND participant.world_id = $2
       AND participant.worldline_id = $3
       AND participant.record_id = $4`,
        "text": [
            "participant_id",
            "participant_kind",
            "participant_character_instance_id",
            "participant_principal_id",
            "participant_controller_mode",
            "instance_id",
            "instance_continuity_id",
            "instance_predecessor_id",
            "instance_controller_mode",
            "instance_status",
            "continuity_key",
            "continuity_status",
            "definition_id",
            "definition_display_name",
            "definition_source_format"
        ],
        "json": [
            "instance_state",
            "definition_profile"
        ],
        "scalars": [
            "participant_is_active",
            "participant_speaking_order",
            "participant_shared_control_enabled",
            "instance_instantiated_tick",
            "instance_instantiated_ordinal",
            "instance_inheritance_cutoff_tick",
            "instance_inheritance_cutoff_ordinal",
            "instance_retired_tick",
            "instance_retired_ordinal",
            "continuity_born_tick",
            "continuity_born_ordinal",
            "continuity_ended_tick",
            "continuity_ended_ordinal"
        ],
        "keys": [
            "participant_speaking_order",
            "participant_id"
        ]
    },
    "scenes": {
        "query": `SELECT ctid::text AS locator, id AS scene_id, title, status, location, objective,
            tension, weather, display_time,
            start_tick, start_ordinal, end_tick, end_ordinal
     FROM scenes
     WHERE workspace_id = $1
       AND world_id = $2
       AND worldline_id = $3
       AND record_id = $4`,
        "text": [
            "scene_id",
            "title",
            "status",
            "location",
            "objective",
            "tension",
            "weather",
            "display_time"
        ],
        "json": [],
        "scalars": [
            "start_tick",
            "start_ordinal",
            "end_tick",
            "end_ordinal"
        ],
        "keys": [
            "start_tick",
            "start_ordinal",
            "scene_id"
        ]
    },
    "visibility": {
        "query": `SELECT ctid::text AS locator, id AS policy_id, policy_key, policy_version, policy_kind,
            scene_id, restricted_domain_id, private_character_instance_id,
            audience_character_instance_ids
     FROM visibility_policies
     WHERE workspace_id = $1
       AND world_id = $2
       AND worldline_id = $3
       AND record_id = $4`,
        "text": [
            "policy_id",
            "policy_key",
            "policy_kind",
            "scene_id",
            "restricted_domain_id",
            "private_character_instance_id"
        ],
        "json": [
            "audience_character_instance_ids"
        ],
        "scalars": [
            "policy_version"
        ],
        "keys": [
            "policy_key",
            "policy_version",
            "policy_id"
        ]
    }
} as const;
export type TopologyFamily = keyof typeof definitions;
type Client = {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{
        rows: T[];
    }>;
};
const invalid = (): never => { throw new RealmRuntimeSaveError("INVALID_SAVE", "Runtime topology resource protocol is invalid."); };
const integer = (value: unknown): number => { const n = Number(value); if (!["string", "number"].includes(typeof value) || String(value).trim() === "" || !Number.isSafeInteger(n) || n < 0)
    invalid(); return n; };
function normalizedJson(column: string): string {
    if (column === "audience_character_instance_ids")
        return `to_jsonb(${column})`;
    // Match historical jsonObject, including a late nonfinite numeric anywhere.
    return `CASE WHEN jsonb_typeof(${column})='object' AND NOT jsonb_path_exists(${column},
    'strict $.** ? (@.type() == "number" && (@ >= ${FINITE_BOUNDARY} || @ <= -${FINITE_BOUNDARY}))') THEN ${column} ELSE '{}'::jsonb END`;
}
function source(family: TopologyFamily): string { return `WITH topology_source AS NOT MATERIALIZED (${definitions[family].query})`; }
function predicate(family: TopologyFamily): string {
    const keys = definitions[family].keys;
    return `($5::${family === 'visibility' ? 'text' : 'bigint'} IS NULL OR (${keys.join(',')})>(${keys.map((_, i) => `$${i + 5}::${i === keys.length - 1 || family === 'visibility' && i === 0 ? 'text' : 'bigint'}`).join(',')}))`;
}
export function topologyHeaderSql(family: TopologyFamily): string {
    const d = definitions[family], fields = [...d.text, ...d.json];
    return `/* runtime topology ${family} headers */ ${source(family)} SELECT locator, ${d.scalars.join(',')},
  (SELECT count(*)::text FROM topology_source) AS source_count, ${predicate(family)} AS cursor_progress,
  ${fields.map(column => {
        const expr = d.json.includes(column as never) ? `(${normalizedJson(column)})::text` : column;
        return `(${expr}) IS NULL AS ${column}_is_null, COALESCE(octet_length(${expr}),0) AS ${column}_bytes, COALESCE(length(${expr}),0) AS ${column}_chars,
  CASE WHEN octet_length(${expr})<=${INLINE_BYTES} THEN ${expr} ELSE NULL END AS ${column}`;
    }).join(',')}
  FROM topology_source WHERE ${predicate(family)} ORDER BY ${d.keys.map(k => `${k} ASC`).join(', ')} LIMIT ${TOPOLOGY_PAGE_ROWS}`;
}
export function topologyBodySql(family: TopologyFamily, column: string, cursor: string): string {
    const d = definitions[family];
    if (![...d.text, ...d.json].includes(column as never) || !/^realm_topology_[a-f0-9]+$/.test(cursor))
        invalid();
    const expr = d.json.includes(column as never) ? `(${normalizedJson(column)})::text` : column;
    return `/* runtime topology ${family} ${column} cursor */ DECLARE ${cursor} NO SCROLL CURSOR FOR
  ${source(family)}, body AS MATERIALIZED (SELECT convert_to(${expr},'UTF8') AS bytes FROM topology_source WHERE locator=$5 LIMIT 1)
  SELECT chunk_start, substring(bytes FROM chunk_start FOR ${TOPOLOGY_CHUNK_BYTES}) AS value
  FROM body CROSS JOIN LATERAL generate_series(1,octet_length(bytes),${TOPOLOGY_CHUNK_BYTES}) AS positions(chunk_start) ORDER BY chunk_start`;
}
function validJsonShape(column: string, value: unknown): void {
    if (column === 'audience_character_instance_ids' ? !Array.isArray(value) : value === null || typeof value !== 'object' || Array.isArray(value))
        invalid();
}
function decode(decoder: TextDecoder, value?: Uint8Array, stream = false): string { try {
    return decoder.decode(value, { stream });
}
catch {
    return invalid();
} }
function withoutPending(value: unknown): unknown {
    if (value === PENDING)
        return "";
    if (Array.isArray(value))
        return value.map(withoutPending);
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPending(v)]));
    return value;
}
/** Shared by ordinary/native roots and every whole-closure Record. A caller's
 * ledger counts only emitted topology, including each actual array comma.
 * Database tuple comparison retains database collation, independent of JS sort.
 */
export async function readTopologyRows<T extends QueryResultRow>(client: Client, family: TopologyFamily, scope: unknown[], ledger: RuntimeSectionWireLedger, project: (row: T) => unknown): Promise<{
    rows: T[];
}> {
    const d = definitions[family], rows: T[] = [], ids = new Set<string>();
    let cursor: unknown[] | null = null, total: number | undefined;
    const cost = (row: QueryResultRow): number => countRuntimeSectionWireBytes(withoutPending(project(row as T)), "canonical-runtime");
    for (;;) {
        const answer = await client.query(topologyHeaderSql(family), [...scope, ...(cursor ?? d.keys.map(() => null))]);
        if (answer.rows.length > TOPOLOGY_PAGE_ROWS)
            invalid();
        if (!answer.rows.length) {
            if (total !== undefined && rows.length !== total)
                invalid();
            break;
        }
        for (const header of answer.rows) {
            const count = integer(header.source_count);
            if (total !== undefined && total !== count)
                invalid();
            total = count;
            if (header.cursor_progress !== true || typeof header.locator !== "string" || !/^\(\d+,\d+\)$/.test(header.locator) || rows.length >= total)
                invalid();
            const row: QueryResultRow = Object.fromEntries(d.scalars.map(key => [key, header[key]]));
            for (const column of [...d.text, ...d.json]) {
                const bytes = integer(header[`${column}_bytes`]), chars = integer(header[`${column}_chars`]);
                if (typeof header[`${column}_is_null`] !== "boolean" || chars > bytes)
                    invalid();
                if (header[`${column}_is_null`]) {
                    if (bytes || chars || header[column] !== null)
                        invalid();
                    row[column] = null;
                }
                else if (bytes <= INLINE_BYTES) {
                    if (typeof header[column] !== "string" || Buffer.byteLength(header[column]) !== bytes || [...header[column]].length !== chars)
                        invalid();
                    if (d.json.includes(column as never)) {
                        try {
                            row[column] = JSON.parse(header[column]);
                        }
                        catch {
                            invalid();
                        }
                        validJsonShape(column, row[column]);
                    }
                    else
                        row[column] = header[column];
                }
                else {
                    if (header[column] !== null)
                        invalid();
                    row[column] = d.json.includes(column as never) ? column === 'audience_character_instance_ids' ? [] : {} : PENDING;
                }
            }
            if (rows.length)
                ledger.checkLowerBound(1);
            const comma = rows.length ? 1 : 0;
            for (const column of [...d.text, ...d.json]) {
                const bytes = integer(header[`${column}_bytes`]);
                if (bytes <= INLINE_BYTES || header[`${column}_is_null`])
                    continue;
                const json = d.json.includes(column as never), old = json ? countRuntimeSectionWireBytes(row[column], "canonical-runtime") : 2;
                const remaining = ledger.remainingBytes - comma - cost(row) + old;
                if (remaining < 0 || !json && bytes + 2 > remaining)
                    invalid();
                const name = `realm_topology_${randomUUID().replaceAll('-', '')}`;
                await client.query(topologyBodySql(family, column, name), [...scope, header.locator]);
                try {
                    const decoder = new TextDecoder('utf-8', { fatal: true }), parser = json ? new MemoryPgJsonStream(remaining) : null, parts: string[] = [];
                    let textBytes = 2, characters = 0;
                    for (let position = 1; position <= bytes; position += TOPOLOGY_CHUNK_BYTES) {
                        const chunk = await client.query(`/* runtime topology chunk */ FETCH FORWARD 1 FROM ${name}`);
                        const item = chunk.rows[0];
                        if (chunk.rows.length !== 1 || integer(item?.chunk_start) !== position || !Buffer.isBuffer(item?.value) || item.value.length !== Math.min(TOPOLOGY_CHUNK_BYTES, bytes - position + 1))
                            invalid();
                        const value = decode(decoder, item.value, true);
                        characters += [...value].length;
                        if (parser)
                            parser.write(value);
                        else {
                            textBytes += memoryJsonStringBytes(value) - 2;
                            if (textBytes > remaining)
                                invalid();
                            parts.push(value);
                        }
                    }
                    const tail = decode(decoder);
                    characters += [...tail].length;
                    if (characters !== integer(header[`${column}_chars`]))
                        invalid();
                    if (parser) {
                        parser.write(tail);
                        row[column] = parser.finish();
                        validJsonShape(column, row[column]);
                    }
                    else {
                        textBytes += memoryJsonStringBytes(tail) - 2;
                        if (textBytes > remaining)
                            invalid();
                        parts.push(tail);
                        row[column] = parts.join('');
                    }
                    const end = await client.query(`/* runtime topology chunk */ FETCH FORWARD 1 FROM ${name}`);
                    if (end.rows.length)
                        invalid();
                }
                catch (error) {
                    try {
                        await client.query(`CLOSE ${name}`);
                    }
                    catch { /* original drives rollback */ }
                    throw error;
                }
                await client.query(`CLOSE ${name}`);
            }
            const id = row[d.keys.at(-1)!];
            if (typeof id !== "string" || ids.has(id) || id === PENDING)
                invalid();
            ids.add(id);
            if (cursor && d.keys.every((k, i) => String(row[k]) === String(cursor![i])))
                invalid();
            ledger.addExact(comma);
            ledger.reserve(project(row as T));
            rows.push(row as T);
        }
        cursor = d.keys.map(k => rows.at(-1)![k]);
        if (answer.rows.length < TOPOLOGY_PAGE_ROWS) {
            if (rows.length !== total)
                invalid();
            break;
        }
    }
    return { rows };
}
