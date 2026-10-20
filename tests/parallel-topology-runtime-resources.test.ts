import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
// Exact A2 reader protocol; these inherited fixtures explicitly have no installed policy.

// Explicit pre-0083 schema lane, independent from the installed A2 policy map.
// Empty Evidence families are modelled separately from all payload cursors.
function createLegacyEmptyReaderProbe(recordIds: readonly string[]) {
  const cursors = new Set<string>();
  const normalize = (sql:string) => sql.replace(/\s+/g," ").trim();
  return Object.assign((raw:string, values:unknown[]): Record<string,unknown>[] | undefined => {
    const sql=normalize(raw);
    if(sql===normalize(GOAL_TRANSPORT_CAPABILITY_SQL)) {
      assert.deepEqual(values,[]); return [{available:false}];
    }
    const declaration=/^\/\* runtime evidence (action_receipts|character_effects|observations) headers \*\/ DECLARE (realm_evidence_[a-f0-9]+) /.exec(sql);
    if(declaration) {
      const family=declaration[1] as "action_receipts"|"character_effects"|"observations", name=declaration[2]!;
      assert.equal(sql,normalize(evidenceHeaderSql(family,name)));
      assert.equal(values.length,4);
      assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
      assert.ok(recordIds.includes(String(values[3])),"Evidence must use an admitted Record");
      assert.ok(!cursors.has(name)); cursors.add(name); return [];
    }
    const page=/^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if(page) { assert.deepEqual(values,[]); assert.ok(cursors.has(page[1]!)); return []; }
    const close=/^CLOSE (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if(close) { assert.deepEqual(values,[]); assert.ok(cursors.delete(close[1]!),"unknown Evidence cursor"); return []; }
    if(sql.includes("realm_evidence_") || sql.startsWith("/* runtime evidence ")) throw Error("UNKNOWN_EMPTY_EVIDENCE_SQL:"+sql);
    return undefined;
  },{assertClosed(){assert.equal(cursors.size,0,"all Evidence header cursors must close");}});
}
const A2_MAP_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const A2_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
const inheritedCommandPolicyFixture = { schemaAvailable: true, rows: [] as Record<string, unknown>[] };
import { readFileSync } from "node:fs";
import { topologyHeaderSql, topologyBodySql, type TopologyFamily } from "../database/postgres/runtime-topology-resource-reader.ts";
/** Production reader -> real ZIP -> parser -> unchanged restorer; explicit SQL protocol doubles, NOT PG. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, serializeRealmRuntimeSaveTopologyV1, type RealmRuntimeSaveArchive, type RealmRuntimeSaveTopologyV1 } from "../modules/world-transfer/realm-runtime-save.ts";
test('N2 participant identity joins stay locally bounded under stale PG statistics', () => {
    const sql = topologyHeaderSql('participants').replace(/\s+/g, ' ');
    assert.equal((sql.match(/LEFT JOIN LATERAL/g) ?? []).length, 3);
    for (const [table, alias, binding] of [
        ['character_instances', 'instance', 'participant.character_instance_id'],
        ['character_continuities', 'continuity', 'instance.continuity_id'],
        ['character_definitions', 'definition', 'continuity.definition_id'],
    ]) {
        assert.ok(sql.includes(`SELECT * FROM ${table} AS ${alias} WHERE`));
        assert.ok(sql.includes(`AND ${alias}.id = ${binding} LIMIT 1 ) AS ${alias} ON TRUE`));
    }
    assert.ok(sql.includes('ORDER BY participant_speaking_order ASC, participant_id ASC LIMIT 1000'));
    assert.ok(!sql.includes('OFFSET'));
});
const SCOPED_GOAL_EXPORT_REFUSAL_SQL = `SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`.replace(/\s+/g, ' ').trim();
const fixtureStaticSql = new Set<string>([A2_MAP_SQL, A2_CAPABILITY_SQL]);
for (const file of ['realm-runtime-save-repository.ts', 'workspace-transaction.ts'])
    for (const match of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), 'utf8').matchAll(/`([^`]*?)`/g)) {
        if (!match[1]!.includes('${'))
            fixtureStaticSql.add(match[1]!.replace(/\s+/g, ' ').trim());
    }
fixtureStaticSql.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
fixtureStaticSql.add(`SELECT
             record.world_id,
             record.worldline_id,
             record.id AS record_id,
             record.story_id,
             record.world_version,
             head.record_version,
             head.next_record_ordinal
           FROM records AS record
           JOIN worlds AS world
             ON world.workspace_id = record.workspace_id
            AND world.id = record.world_id
           JOIN record_heads AS head
             ON head.workspace_id = record.workspace_id
            AND head.record_id = record.id
           WHERE record.workspace_id = $1
             AND record.id = $2
             AND EXISTS (
               SELECT 1 FROM player_world_memberships AS backup_membership
               WHERE backup_membership.workspace_id = record.workspace_id
                 AND backup_membership.world_id = record.world_id
                 AND backup_membership.principal_id = $3
                 AND backup_membership.role = 'owner'
             )`.replace(/\s+/g," ").trim());
const protocolFields = {
    "participants": {
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
function headerRows(family: TopologyFamily, source: unknown[], values: unknown[], rawJson: Record<string, string> = {}) {
    const d = protocolFields[family], all = source as Record<string, unknown>[];
    const after = values.slice(4);
    const compare = (row: Record<string, unknown>) => { for (let i = 0; i < d.keys.length; i++) {
        const a = row[d.keys[i]!], b = after[i];
        if (String(a) === String(b))
            continue;
        return typeof a === 'number' ? a - Number(b) : String(a) < String(b) ? -1 : 1;
    } return 0; };
    return all.map((row, i) => ({ row, locator: `(0,${i + 1})` })).filter(({ row }) => after[0] === null || compare(row) > 0).slice(0, 1000).map(({ row, locator }) => ({ locator, source_count: String(all.length), cursor_progress: true, ...Object.fromEntries(d.scalars.map(k => [k, row[k]])), ...Object.fromEntries([...d.text, ...d.json].flatMap(k => {
            const raw = row[k] ?? null, value = d.json.includes(k as never) ? (rawJson[k] ?? JSON.stringify(raw === null && k !== 'audience_character_instance_ids' ? {} : raw)) : raw as string | null;
            const bytes = value === null ? 0 : Buffer.byteLength(value);
            return [[k, value !== null && bytes <= 256 ? value : null], [`${k}_is_null`, value === null], [`${k}_bytes`, bytes], [`${k}_chars`, value === null ? 0 : value.length - [...value.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)].length]];
        })) }));
}
const scope = { workspaceId: 'ws-f4c', worldId: 'world-f4c', worldlineId: 'line-f4c', recordId: 'record-f4c' };
type Participant = RealmRuntimeSaveTopologyV1["participants"][number];
type Entry = {
    id: string;
    people: Participant[];
};
type Call = {
    sql: string;
    values: unknown[];
    returned?: number;
    bytes?: number;
};
function participant(id: string, parent: string | null = null, continuity = 'continuity-f4c'): Participant {
    return { sourceParticipantId: `participant-${id}`, participantKind: 'character', sourcePrincipalId: null, controllerMode: 'ai', isActive: true, speakingOrder: 0, sharedControlEnabled: false,
        character: { sourceCharacterInstanceId: id, sourceContinuityId: continuity, sourcePredecessorInstanceId: parent, sourceDefinitionId: 'definition-f4c',
            definition: { displayName: '角色前驱对照', sourceFormat: 'native', profile: { literal: 'leave parent IDs in prose unchanged' } },
            continuity: { continuityKey: continuity, status: 'active', bornTick: 0, bornOrdinal: 0, endedTick: null, endedOrdinal: null },
            instance: { controllerMode: 'ai', status: 'present', instantiatedTick: 0, instantiatedOrdinal: 0, inheritanceCutoffTick: 0, inheritanceCutoffOrdinal: 0, retiredTick: null, retiredOrdinal: null, state: { literalParent: parent } } } };
}
function topologyRow(p: Participant) {
    const c = p.character!;
    return {
        participant_id: p.sourceParticipantId, participant_kind: 'character', participant_principal_id: null, participant_controller_mode: 'ai', participant_is_active: true, participant_speaking_order: 0, participant_shared_control_enabled: false,
        instance_id: c.sourceCharacterInstanceId, instance_continuity_id: c.sourceContinuityId, instance_predecessor_id: c.sourcePredecessorInstanceId, instance_controller_mode: 'ai', instance_status: 'present', instance_instantiated_tick: 0, instance_instantiated_ordinal: 0, instance_inheritance_cutoff_tick: 0, instance_inheritance_cutoff_ordinal: 0, instance_retired_tick: null, instance_retired_ordinal: null, instance_state: c.instance.state,
        continuity_key: c.continuity.continuityKey, continuity_status: 'active', continuity_born_tick: 0, continuity_born_ordinal: 0, continuity_ended_tick: null, continuity_ended_ordinal: null,
        definition_id: c.sourceDefinitionId, definition_display_name: c.definition.displayName, definition_source_format: 'native', definition_profile: c.definition.profile
    };
}
function reader(entries: Entry[], options: {
    role?: string;
    rawJson?: Record<string, string>;
    mutate?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[];
    sceneRows?: Record<string, unknown>[];
    policyRows?: Record<string, unknown>[];
    ownerOverride?: {
        id: string;
        record_id: string;
        continuity_id: string;
        workspace_id: string;
        world_id: string;
        worldline_id: string;
    }[];
} = {}) {
    const calls: Call[] = [];
    let acquired = 0, released = 0, active = false;
    const topologySources = new Map<TopologyFamily, unknown[]>(), topologyCursors = new Map<string, {
        bytes: Buffer;
        offset: number;
    }>();
    const owners = options.ownerOverride ?? entries.flatMap(entry => entry.people.flatMap(p => p.character ? [{ id: p.character.sourceCharacterInstanceId,
            record_id: entry.id, continuity_id: p.character.sourceContinuityId, workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId }] : []));
    const emptyTables = new Set(['events', 'goal_instances', 'goal_assessments', 'record_goal_definitions', 'action_receipts', 'character_effects', 'observations',
        'memory_conclusions', 'memory_snapshots', 'relationship_states', 'outbox', 'record_first_nights', 'record_self_play_sessions', 'projects', 'project_milestones',
        'project_story_links', 'budget_allocations', 'finance_accounts', 'ledger_entries', 'project_finance_command_groups', 'obligations', 'obligation_settlements',
        'story_node_instances', 'story_unlock_ledger', 'committed_fact_commands', 'performance_assessments', 'member_relationship_revisions', 'character_assets',
        'story_definition_bindings', 'record_archives', 'worldlines', 'records']);
    const readerProbe=createLegacyEmptyReaderProbe(entries.map(e=>e.id));
    const client = { release() { readerProbe.assertClosed(); released++; }, async query(sql: string, values: unknown[] = []) {
            assert.equal(active, false, 'same client sequential SQL');
            active = true;
            calls.push({ sql, values });
            try {
                const normalized = sql.replace(/\s+/g, ' ').trim();
                const probe=readerProbe(sql,values); if(probe!==undefined) {
                    calls.at(-1)!.returned=probe.length;
                    calls.at(-1)!.bytes=probe.reduce((sum,row)=>sum+Object.values(row).reduce((n:number,v)=>n+(Buffer.isBuffer(v)?v.length:typeof v==="string"?Buffer.byteLength(v):8),0),0);
                    return {rows:probe,rowCount:probe.length};
                }
                if (!fixtureStaticSql.has(normalized) && !sql.startsWith('/* runtime topology') && !sql.startsWith('CLOSE realm_topology_')
                    && !sql.startsWith('/* runtime event headers */') && !sql.startsWith('/* runtime outbox headers;') && !sql.startsWith('/* memory resource')

                    && !new Set(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'ROLLBACK', "SELECT set_config('realm.workspace_id', $1, true)"]).has(sql))
                    throw Error('UNKNOWN_SQL_TEXT:' + normalized);
                let rows: unknown[] = [];
                if (normalized === A2_CAPABILITY_SQL) { assert.deepEqual(values, []); rows = [{ command_materializations_available: inheritedCommandPolicyFixture.schemaAvailable }]; }
                else if (normalized === A2_MAP_SQL) { assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]); rows = inheritedCommandPolicyFixture.rows; }
                else if (sql.includes('/* runtime topology') && sql.includes(' cursor */')) {
                    const match = /runtime topology (participants|scenes|visibility) (\w+) cursor/.exec(sql)!;
                    const family = match[1] as TopologyFamily, column = match[2]!, name = /DECLARE (\w+)/.exec(sql)![1]!;
                    assert.equal(sql, topologyBodySql(family, column, name));
                    assert.equal(values.length, 5);
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    assert.ok(entries.some(e => e.id === values[3]));
                    const index = Number(/,([0-9]+)\)/.exec(String(values[4]))![1]) - 1;
                    const row = topologySources.get(family)![index] as Record<string, unknown>;
                    const value = protocolFields[family].json.includes(column as never) ? (options.rawJson?.[column] ?? JSON.stringify(row[column] ?? {})) : String(row[column]);
                    topologyCursors.set(name, { bytes: Buffer.from(value), offset: 0 });
                }
                else if (sql.startsWith('/* runtime topology chunk */')) {
                    assert.match(sql, /^\/\* runtime topology chunk \*\/ FETCH FORWARD 1 FROM realm_topology_[a-f0-9]+$/);
                    assert.deepEqual(values, []);
                    const name = /FROM (\w+)/.exec(sql)![1]!, c = topologyCursors.get(name);
                    assert.ok(c);
                    if (c.offset < c.bytes.length) {
                        rows = [{ chunk_start: c.offset + 1, value: c.bytes.subarray(c.offset, c.offset + 65536) }];
                        c.offset += 65536;
                    }
                }
                else if (sql.startsWith('CLOSE realm_topology_')) {
                    assert.ok(topologyCursors.delete(sql.slice(6)));
                    assert.deepEqual(values, []);
                }
                else if (sql.replace(/\s+/g, ' ').trim() === SCOPED_GOAL_EXPORT_REFUSAL_SQL) {
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    assert.equal(values.length, 4);
                    assert.ok(values[3] === 'story-f4c' || values[3] === null);
                    rows = []; // Explicitly no persisted Story/worldline Goal facts in this Character fixture.
                }
                else if (sql.includes('record.id AS record_id'))
                    rows = sql.includes('backup_membership') && options.role !== undefined && options.role !== 'owner' ? [] : [{ world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId, story_id: 'story-f4c', world_version: '1.2.0', record_version: 0, next_record_ordinal: 0 }];
                else if (sql.includes('FROM player_world_memberships'))
                    rows = [{ role: options.role ?? 'owner' }];
                else if (sql.includes('AS mixed'))
                    rows = [{ mixed: false }];
                else if (sql.includes('AS bound'))
                    rows = [{ bound: false }];
                else if (sql.includes('FROM participants AS participant'))
                    rows = (entries.find(e => e.id === values[3])?.people ?? []).toSorted((a, b) => a.speakingOrder - b.speakingOrder || a.sourceParticipantId.localeCompare(b.sourceParticipantId)).map(p => p.character ? topologyRow(p) : narratorRow(p));
                else if (sql.includes('FROM scenes'))
                    rows = options.sceneRows ?? [{ scene_id: `scene-${values[3]}`, title: 'Scene', status: 'active', location: '', objective: '', tension: '', weather: '', display_time: '', start_tick: 0, start_ordinal: 0, end_tick: null, end_ordinal: null }];
                else if (sql.includes('FROM visibility_policies'))
                    rows = options.policyRows ?? [{ policy_id: `policy-${values[3]}`, policy_key: `public-${values[3]}`, policy_version: 1, policy_kind: 'public', scene_id: null, restricted_domain_id: null as string | null, private_character_instance_id: null, audience_character_instance_ids: [] as string[] }];
                else if (sql.includes('FROM stories'))
                    rows = [{ id: 'story-f4c', title: 'F4c', status: 'active', premise: '' }];
                else if (sql.includes('memory resource epoch header'))
                    rows = (values[3] as string[]).map(id => ({ observer_continuity_id: id, epoch: 0 }));
                else if (sql.includes('SELECT record.id, record.story_id, record.title'))
                    rows = entries.filter(e => (values[3] as string[]).includes(e.id)).map(e => ({ id: e.id, story_id: 'story-f4c', title: 'Sibling', status: 'active', world_version: '1.2.0', start_tick: 0, start_ordinal: 0, timeline_kind: 'primary', linked_record_id: null, record_version: 0, next_record_ordinal: 0, last_event_id: null, last_world_tick: null, last_world_ordinal: null }));
                else if (sql.includes('/* export character predecessor owners */')) {
                    assert.match(sql, /workspace_id=\$1 AND world_id=\$2 AND worldline_id=\$3/);
                    assert.match(sql, /id=ANY\(\$4::text\[\]\)/);
                    assert.match(sql, /LIMIT 1000/);
                    assert.ok((values[3] as string[]).length <= 1000);
                    rows = owners.filter(o => o.workspace_id === values[0] && o.world_id === values[1] && o.worldline_id === values[2] && (values[3] as string[]).includes(o.id));
                }
                else if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|SELECT set_config|SELECT current_setting)/.test(sql)) { /* Explicit transaction protocol: no returned domain rows. */ }
                else {
                    const table = [...sql.matchAll(/\bFROM\s+(\w+)/ig)].at(-1)?.[1];
                    if (!table || !emptyTables.has(table))
                        throw new Error(`UNEXPECTED_READER_SQL: ${sql}`);
                    // Any new Character query must be explicitly modeled above.
                    assert.doesNotMatch(sql, /FROM character_instances/);
                }
                if (sql.includes(' headers */') && sql.startsWith('/* runtime topology')) {
                    const family = /runtime topology (participants|scenes|visibility)/.exec(sql)![1] as TopologyFamily;
                    assert.equal(sql, topologyHeaderSql(family));
                    assert.equal(values.length, 4 + protocolFields[family].keys.length);
                    assert.deepEqual(values.slice(0, 3), [scope.workspaceId, scope.worldId, scope.worldlineId]);
                    topologySources.set(family, rows);
                    rows = headerRows(family, rows, values, options.rawJson);
                }
                if (options.mutate)
                    rows = options.mutate(sql, rows as Record<string, unknown>[]);
                calls.at(-1)!.returned = rows.length;
                calls.at(-1)!.bytes = rows.reduce((sum: number, row) => sum + Object.values(row as Record<string, unknown>).reduce((n: number, v) => n + (Buffer.isBuffer(v) ? v.length : typeof v === 'string' ? Buffer.byteLength(v) : 8), 0), 0);
                return { rows, rowCount: rows.length };
            }
            finally {
                active = false;
            }
        } };
    const database = { async connect() { acquired++; return client; } };
    async function load(purpose: 'record-export' | 'native-record-branch' | 'whole-closure-backup' = 'record-export') {
        return createPostgresRealmRuntimeSaveReader(database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: 'owner-f4c', purpose, ...(purpose === 'native-record-branch' ? { sessionProof: 'protocol-proof' } : {}) });
    }
    return { load, calls, query: client.query.bind(client), cursors: topologyCursors, counts: () => ({ acquired, released }) };
}
async function loadPurpose(f: ReturnType<typeof reader>, purpose: 'record-export' | 'native-record-branch' | 'whole-closure-backup') {
    const old = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = 'owner-f4c';
    try {
        return await f.load(purpose);
    }
    finally {
        if (old === undefined)
            delete process.env.REALM_OPERATOR_PRINCIPALS;
        else
            process.env.REALM_OPERATOR_PRINCIPALS = old;
    }
}
const PAGE = 1000;
function scenes(count: number, title = 'Scene') { return Array.from({ length: count }, (_, i) => ({ scene_id: `scene-${String(i).padStart(6, '0')}`, title, status: 'active', location: '', objective: '', tension: '', weather: '', display_time: '', start_tick: 0, start_ordinal: 0, end_tick: null, end_ordinal: null })); }
function policies(count: number) { return Array.from({ length: count }, (_, i) => ({ policy_id: `policy-${String(i).padStart(6, '0')}`, policy_key: `public-${String(i).padStart(6, '0')}`, policy_version: 1, policy_kind: 'public', scene_id: null, restricted_domain_id: null as string | null, private_character_instance_id: null, audience_character_instance_ids: [] as string[] })); }
function narrators(count: number): Participant[] { return Array.from({ length: count }, (_, i) => ({ sourceParticipantId: `narrator-${String(i).padStart(6, '0')}`, participantKind: 'narrator', sourcePrincipalId: null, controllerMode: 'ai', isActive: true, speakingOrder: 0, sharedControlEnabled: false, character: null })); }
// Narrator rows intentionally have every joined Character column null.
const characterRow = topologyRow;
function narratorRow(p: Participant) { return { ...Object.fromEntries(Object.keys(characterRow(participant('shape'))).map(key => [key, null])), participant_id: p.sourceParticipantId, participant_kind: 'narrator', participant_character_instance_id: null, participant_principal_id: null, participant_controller_mode: 'ai', participant_is_active: true, participant_speaking_order: 0, participant_shared_control_enabled: false }; }
function zip(a: RealmRuntimeSaveArchive) { return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)); }
for (const family of ['participants', 'scenes', 'visibility'] as const)
    for (const count of [1000, 1001, 2001])
        for (const purpose of ['record-export', 'native-record-branch', 'whole-closure-backup'] as const)
            test(`N2 public ${family} ${count} ${purpose} rows bounded without loss`, async () => {
                const f = reader([{ id: scope.recordId, people: family === 'participants' ? narrators(count) : [participant('root')] }], { sceneRows: family === 'scenes' ? scenes(count) : undefined, policyRows: family === 'visibility' ? policies(count) : undefined });
                const a = zip((await loadPurpose(f, purpose))!);
                assert.equal(a.topology![family === 'visibility' ? 'visibilityPolicies' : family].length, count);
                const calls = f.calls.filter(c => c.sql.includes(family === 'participants' ? 'FROM participants AS participant' : family === 'scenes' ? 'FROM scenes' : 'FROM visibility_policies'));
                assert.ok(calls.every(c => c.returned! <= PAGE), 'source crossed driver in an unbounded result');
                assert.ok(calls.length > 1, 'source must page all topology rows');
                assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
                assert.deepEqual(f.counts(), { acquired: 1, released: 1 });
            });
test('N2 public oversized scene text refuses before body transfer', async () => {
    const f = reader([{ id: scope.recordId, people: [participant('root')] }], { sceneRows: scenes(1, 'x'.repeat(67108865)) });
    await assert.rejects(f.load(), e => e instanceof Error && 'code' in e && e.code === 'RUNTIME_SAVE_INVALID');
    assert.ok(f.calls.filter(c => c.sql.includes('FROM scenes')).every(c => c.bytes! < 1000000), 'oversized body crossed driver before rejection');
    assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
});
function textured(count: number) { return Array.from({ length: count }, (_, i) => createHash('sha256').update(String(i)).digest('hex') + '汉😀\\"\n').join(''); }
function refusal(e: unknown) { return e instanceof Error && 'code' in e && e.code === 'RUNTIME_SAVE_INVALID'; }
function noWrites(f: ReturnType<typeof reader>) { assert.equal(f.calls.filter(c => /\b(?:INSERT|UPDATE|DELETE)\b/.test(c.sql)).length, 0); assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK'); assert.equal(f.cursors.size, 0); assert.deepEqual(f.counts(), { acquired: 1, released: 1 }); }
for (const purpose of ['record-export', 'native-record-branch', 'whole-closure-backup'] as const)
    test(`N2 ${purpose} public Unicode body -> ZIP -> parse`, async () => {
        const p = participant('root');
        p.character!.definition.displayName = textured(2000);
        p.character!.definition.profile = { text: textured(2100) };
        const f = reader([{ id: scope.recordId, people: [p] }], { sceneRows: scenes(1, textured(2200)) });
        const old = process.env.REALM_OPERATOR_PRINCIPALS;
        process.env.REALM_OPERATOR_PRINCIPALS = 'owner-f4c';
        try {
            const a = zip((await f.load(purpose))!);
            assert.equal(a.topology!.participants[0]!.character!.definition.displayName, p.character!.definition.displayName);
            assert.deepEqual(a.topology!.participants[0]!.character!.definition.profile, p.character!.definition.profile);
            assert.equal(a.topology!.scenes[0]!.title, textured(2200));
        }
        finally {
            if (old === undefined)
                delete process.env.REALM_OPERATOR_PRINCIPALS;
            else
                process.env.REALM_OPERATOR_PRINCIPALS = old;
        }
        const declarations = f.calls.filter(c => c.sql.includes(' cursor */'));
        assert.equal(declarations.length, 3);
        assert.equal(f.calls.filter(c => c.sql.startsWith('CLOSE realm_topology_')).length, 3);
        assert.ok(declarations.every(c => c.sql.includes('AS MATERIALIZED')));
        assert.ok(f.calls.filter(c => c.sql.includes('FETCH FORWARD')).every(c => c.returned! <= 1 && c.bytes! < 140000));
        assert.equal(f.cursors.size, 0);
    });
for (const defect of ['missing', 'duplicate-position', 'extra', 'wrong-length', 'bad-utf8', 'query-error', 'header-bytes', 'header-chars', 'header-count', 'header-null', 'progress', 'duplicate-id', 'array-malformed', 'foreign-audience'] as const)
    test(`N2 public refuses ${defect}; closes/rolls back/releases`, async () => {
        let changed = false;
        const p = participant('root');
        p.character!.definition.profile = { big: 'x'.repeat(140000) };
        const rows = scenes(2);
        const policy = policies(1);
        if (defect === 'foreign-audience') {
            policy[0]!.policy_kind = 'restricted';
            policy[0]!.restricted_domain_id = 'domain';
            policy[0]!.audience_character_instance_ids = ['foreign'] as never;
        }
        const f = reader([{ id: scope.recordId, people: [p] }], { sceneRows: rows, policyRows: policy, rawJson: defect === 'array-malformed' ? { audience_character_instance_ids: '{}' } : undefined, mutate(sql, result) {
                if (sql.startsWith('/* runtime topology chunk */')) {
                    if (defect === 'query-error')
                        throw Error('SYNTHETIC_DRIVER_FETCH_FAILURE');
                    if (defect === 'extra' && !result.length && !changed) {
                        changed = true;
                        return [{ chunk_start: 196609, value: Buffer.from('x') }];
                    }
                    if (result.length) {
                        if (defect === 'duplicate-position' && !changed && result[0]!.chunk_start === 65537) {
                            changed = true;
                            return [{ ...result[0], chunk_start: 1 }];
                        }
                        if (!changed && ['missing', 'wrong-length', 'bad-utf8'].includes(defect)) {
                            changed = true;
                            if (defect === 'missing')
                                return [];
                            return [{ ...result[0], value: defect === 'bad-utf8' ? Buffer.alloc(65536, 255) : Buffer.from('x') }];
                        }
                    }
                }
                if (sql.startsWith('/* runtime topology scenes headers */')) {
                    if (defect === 'duplicate-id')
                        result[1] = { ...result[0] };
                    if (defect === 'header-count')
                        result[0]!.source_count = '3';
                    if (defect === 'progress')
                        result[0]!.cursor_progress = false;
                    if (defect === 'header-bytes')
                        result[0]!.title_bytes = 999;
                    if (defect === 'header-chars')
                        result[0]!.title_chars = 999;
                    if (defect === 'header-null')
                        result[0]!.title_is_null = true;
                }
                return result;
            } });
        await assert.rejects(f.load(), defect === 'query-error' ? /SYNTHETIC_DRIVER_FETCH_FAILURE/ : refusal);
        noWrites(f);
        if (['missing', 'duplicate-position', 'extra', 'wrong-length', 'bad-utf8', 'query-error'].includes(defect))
            assert.equal(f.calls.filter(c => c.sql.startsWith('CLOSE realm_topology_')).length, 1);
    });
test('N2 shared whole sibling loader uses bounded header/cursor and actual ZIP', async () => {
    const root = participant('child', 'parent'), parent = participant('parent');
    parent.character!.definition.profile = { big: textured(2300) };
    root.character!.definition.profile = parent.character!.definition.profile;
    const f = reader([{ id: scope.recordId, people: [root] }, { id: 'sibling', people: [parent, ...narrators(1001)] }]);
    const old = process.env.REALM_OPERATOR_PRINCIPALS;
    process.env.REALM_OPERATOR_PRINCIPALS = 'owner-f4c';
    try {
        const a = zip((await f.load('whole-closure-backup'))!);
        assert.equal(a.domain!.records!.length, 1);
        assert.deepEqual(a.domain!.records![0]!.bundle!.topology!.participants.find(p => p.character !== null)!.character!.definition.profile, parent.character!.definition.profile);
    }
    finally {
        if (old === undefined)
            delete process.env.REALM_OPERATOR_PRINCIPALS;
        else
            process.env.REALM_OPERATOR_PRINCIPALS = old;
    }
    for (const family of ['participants', 'scenes', 'visibility'])
        assert.ok(f.calls.some(c => c.sql.startsWith(`/* runtime topology ${family} headers */`) && c.values[3] === 'sibling'));
    assert.equal(f.cursors.size, 0);
});
for (const id of ['汉', '😀', ' bad', 'bad '])
    test(`N2 identity is rejected without trimming (${JSON.stringify(id)})`, async () => {
        const rows = scenes(1);
        rows[0]!.scene_id = id;
        const f = reader([{ id: scope.recordId, people: [participant('root')] }], { sceneRows: rows });
        await assert.rejects(f.load(), refusal);
        noWrites(f);
    });
test('N2 legal large-raw normalized-small decimal/scientific JSON retains numeric acceptance', async () => {
    const raw = '{' + Array.from({ length: 4096 }, (_, i) => `"n${i}":0.${'0'.repeat(16382)}1`).join(',') + ',"scientific":1.0000000000000000000e0}';
    assert.ok(Buffer.byteLength(raw) > 67108864);
    const f = reader([{ id: scope.recordId, people: [participant('root')] }], { rawJson: { definition_profile: raw } });
    const a = zip((await f.load())!);
    const profile = a.topology!.participants[0]!.character!.definition.profile;
    assert.equal(Object.keys(profile).length, 4097);
    assert.equal(profile.n0, 0);
    assert.equal(profile.scientific, 1);
    assert.equal(f.calls.filter(c => c.sql.includes('definition_profile cursor */')).length, 1);
    assert.equal(f.calls.filter(c => c.sql.startsWith('CLOSE realm_topology_')).length, 1);
    assert.equal(f.cursors.size, 0);
});
test('N2 cross-page keyset stall fails at public loader', async () => {
    let saved: Record<string, unknown>[] | undefined;
    const f = reader([{ id: scope.recordId, people: narrators(1001) }], { mutate(sql, rows) { if (sql.startsWith('/* runtime topology participants headers */')) {
            if (saved)
                return saved;
            saved = rows;
        } return rows; } });
    await assert.rejects(f.load(), refusal);
    noWrites(f);
});
test('N2 strict driver refuses unknown SQL on known tables', async () => {
    const f = reader([{ id: scope.recordId, people: [] }]);
    await assert.rejects(f.query('SELECT * FROM scenes'), /UNKNOWN_SQL_TEXT/);
    await assert.rejects(f.query('/* runtime topology scenes headers */ SELECT 1'), /UNEXPECTED|Assertion|UNKNOWN/);
});
test('N2 bounded audience array preserves order and same-scope references through ZIP', async () => {
    const people = Array.from({ length: 100 }, (_, i) => participant(`character-${i}`, null, `continuity-${i}`));
    const policy = policies(1);
    policy[0]!.policy_kind = 'restricted';
    policy[0]!.restricted_domain_id = 'domain';
    policy[0]!.audience_character_instance_ids = people.map(p => p.character!.sourceCharacterInstanceId) as never;
    const f = reader([{ id: scope.recordId, people }], { policyRows: policy });
    const a = zip((await f.load())!);
    assert.deepEqual(a.topology!.visibilityPolicies[0]!.sourceAudienceCharacterInstanceIds, policy[0]!.audience_character_instance_ids);
    assert.equal(f.calls.filter(c => c.sql.includes('audience_character_instance_ids cursor */')).length, 1);
    assert.equal(f.cursors.size, 0);
});
test('N2 exact existing topology wire capacity and +1 at public loader (projection; ZIP ratio separate)', async () => {
    const f0 = reader([{ id: scope.recordId, people: [participant('root')] }], { sceneRows: scenes(1, '') });
    const empty = (await f0.load())!.topology!;
    const overhead = Buffer.byteLength(serializeRealmRuntimeSaveTopologyV1(empty));
    const title = 'x'.repeat(67108864 - overhead);
    const exact = reader([{ id: scope.recordId, people: [participant('root')] }], { sceneRows: scenes(1, title) });
    const a = (await exact.load())!;
    assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveTopologyV1(a.topology!)), 67108864);
    assert.equal(exact.cursors.size, 0);
    const plus = reader([{ id: scope.recordId, people: [participant('root')] }], { sceneRows: scenes(1, title + 'x') });
    await assert.rejects(plus.load(), refusal);
    noWrites(plus);
    assert.ok(plus.calls.filter(c => c.sql.includes('runtime topology')).every(c => c.returned! <= 1000));
});

test('N2 long safe IDs and nonempty untrimmed labels preserve exact values',async()=>{
 const p=participant('root');p.character!.definition.displayName='  😀 display  ';p.character!.continuity.continuityKey='  汉 key  ';
 const rows=scenes(1),id=Array.from({length:1500},(_,i)=>createHash('sha256').update('identity'+i).digest('hex')).join('');rows[0]!.scene_id=id;
 const policy=policies(1);policy[0]!.policy_key='  😀 policy  ';
 const f=reader([{id:scope.recordId,people:[p]}],{sceneRows:rows,policyRows:policy});const a=zip((await f.load())!);
 assert.equal(a.topology!.scenes[0]!.sourceSceneId,id);assert.equal(a.topology!.participants[0]!.character!.definition.displayName,p.character!.definition.displayName);assert.equal(a.topology!.participants[0]!.character!.continuity.continuityKey,p.character!.continuity.continuityKey);assert.equal(a.topology!.visibilityPolicies[0]!.policyKey,policy[0]!.policy_key);
 assert.equal(f.calls.filter(c=>c.sql.includes('scene_id cursor */')).length,1);assert.equal(f.cursors.size,0);
});
