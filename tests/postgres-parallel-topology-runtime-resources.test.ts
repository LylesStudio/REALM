/** AUTHORED ONLY: syntax/typecheck in wave13; execution belongs to parent disposable PG lane. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { POSTGRES_DEMO_IDS, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
async function fixture(t: test.TestContext, count = 1) {
    assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith('realm'), 'authorized disposable runner required');
    assert.ok(process.env.DATABASE_URL && process.env.REALM_RUNTIME_DATABASE_URL);
    const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    t.after(() => owner.end());
    const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 });
    t.after(() => runtime.end());
    const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `topology_world_${randomUUID()}`, worldlineId: `topology_line_${randomUUID()}`, recordId: `topology_record_${randomUUID()}` };
    const storyId = `topology_story_${randomUUID()}`;
    await withWorkspaceTransaction(owner, scope.workspaceId, async (client) => {
        const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
            const result = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), scope.workspaceId, sourceId]);
            assert.equal(result.rowCount, 1, `fixture ${table}`);
        };
        const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
        await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: "Outbox bounded resources" });
        await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: 0, head_ordinal: 0 });
        await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick: 0, start_ordinal: 0 });
        await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: "active", start_tick: 0, start_ordinal: 0 });
        await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scoped, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
        await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
        await clone("character_definitions", "id", POSTGRES_DEMO_IDS.scoutDefinition, { workspace_id: scope.workspaceId, world_id: scope.worldId, id: scope.recordId + '.definition' });
        await clone("character_continuities", "id", POSTGRES_DEMO_IDS.scoutContinuity, { ...scoped, id: scope.recordId + '.continuity', definition_id: scope.recordId + '.definition', continuity_key: 'topology', born_tick: 0, born_ordinal: 0, ended_tick: null, ended_ordinal: null });
        await clone("character_instances", "id", POSTGRES_DEMO_IDS.scoutInstance, { ...scoped, id: scope.recordId + '.instance', continuity_id: scope.recordId + '.continuity', predecessor_instance_id: null, instantiated_tick: 0, instantiated_ordinal: 0, inheritance_cutoff_tick: 0, inheritance_cutoff_ordinal: 0, retired_tick: null, retired_ordinal: null, state: {} });
        // One narrator per Record is a real schema invariant. Many-row positive
        // fixtures therefore use distinct legal Character families, not narrators.
        await client.query(`INSERT INTO character_continuities
      SELECT (jsonb_populate_record(NULL::character_continuities,to_jsonb(source)||
        jsonb_build_object('id',$2||'.continuity.'||n,'continuity_key','topology.'||n))).*
      FROM character_continuities source CROSS JOIN generate_series(2,$3::int) n
      WHERE workspace_id=$1 AND id=$2||'.continuity'`, [scope.workspaceId, scope.recordId, count]);
        await client.query(`INSERT INTO character_instances
      SELECT (jsonb_populate_record(NULL::character_instances,to_jsonb(source)||
        jsonb_build_object('id',$2||'.instance.'||n,'continuity_id',$2||'.continuity.'||n))).*
      FROM character_instances source CROSS JOIN generate_series(2,$3::int) n
      WHERE workspace_id=$1 AND id=$2||'.instance'`, [scope.workspaceId, scope.recordId, count]);
        await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
      SELECT $1,$2,$3,$4,$4||'.p.'||lpad(n::text,6,'0'),'character',
        CASE WHEN n=1 THEN $4||'.instance' ELSE $4||'.instance.'||n END,'ai',0 FROM generate_series(1,$5::int) n`, [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, count]);
        await client.query(`INSERT INTO scenes
      SELECT (jsonb_populate_record(NULL::scenes,to_jsonb(source)||jsonb_build_object('world_id',$2::text,'worldline_id',$3::text,'record_id',$4::text,'id',$4||'.s.'||lpad(n::text,6,'0'),'start_tick',0,'start_ordinal',0,'end_tick',null,'end_ordinal',null))).*
      FROM scenes source CROSS JOIN generate_series(1,$5::int) n WHERE workspace_id=$1 AND source.id=$6`, [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, count, POSTGRES_DEMO_IDS.scene]);
        await client.query(`INSERT INTO visibility_policies(workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind)
      SELECT $1,$2,$3,$4,$4||'.v.'||lpad(n::text,6,'0'),'same-key',n,'public' FROM generate_series(1,$5::int) n`, [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, count]);
    });
    const trace: {
        sql: string;
        rows: number;
        maxString: number;
        maxBuffer: number;
    }[] = [];
    let failFetch = false, released = 0;
    const database = { async connect() {
            const client = await runtime.connect(), query = client.query, release = client.release;
            const execute = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
            client.query = (async (sql: string, values?: unknown[]) => {
                const result = failFetch && sql.startsWith('/* runtime topology chunk */') ? { rows: [] } : await execute(sql, values);
                const cells = result.rows.flatMap(row => Object.values(row));
                trace.push({ sql, rows: result.rows.length, maxString: Math.max(0, ...cells.filter((v): v is string => typeof v === 'string').map(v => Buffer.byteLength(v))), maxBuffer: Math.max(0, ...cells.filter((v): v is Buffer => Buffer.isBuffer(v)).map(v => v.length)) });
                return result;
            }) as typeof client.query;
            client.release = (...args) => { released++; client.query = query; client.release = release; release.apply(client, args); };
            return client;
        } };
    const load = (purpose: 'record-export' | 'native-record-branch' | 'whole-closure-backup' = 'record-export') => createPostgresRealmRuntimeSaveReader(database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: POSTGRES_DEMO_IDS.principal, purpose, ...(purpose === 'native-record-branch' ? { sessionProof: 'fixture-proof' } : {}) });
    const mutate = (sql: string, values: unknown[] = []) => withWorkspaceTransaction(owner, scope.workspaceId, client => client.query(sql, [scope.workspaceId, scope.recordId, ...values]));
    return { scope, trace, load, mutate, fail() { failFetch = true; }, released: () => released };
}
for (const count of [1000, 1001, 2001])
    test(`N2 PG all topology families ${count} ties through three public routes`, async (t) => {
        const f = await fixture(t, count), old = process.env.REALM_OPERATOR_PRINCIPALS;
        process.env.REALM_OPERATOR_PRINCIPALS = POSTGRES_DEMO_IDS.principal;
        try {
            for (const purpose of ['record-export', 'native-record-branch', 'whole-closure-backup'] as const) {
                f.trace.length = 0;
                const a = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load(purpose))!));
                assert.equal(a.topology!.participants.length, count);
                assert.equal(a.topology!.scenes.length, count);
                assert.equal(a.topology!.visibilityPolicies.length, count);
                for (const family of ['participants', 'scenes', 'visibility']) {
                    const h = f.trace.filter(c => c.sql.startsWith(`/* runtime topology ${family} headers */`));
                    assert.equal(h.length, Math.floor(count / 1000) + 1);
                    assert.ok(h.every(c => c.rows <= 1000 && c.maxString <= 256));
                }
            }
        }
        finally {
            if (old === undefined)
                delete process.env.REALM_OPERATOR_PRINCIPALS;
            else
                process.env.REALM_OPERATOR_PRINCIPALS = old;
        }
    });
test('N2 PG UTF8 cursor preserves astral text and CLOSE on success/fetch failure', async (t) => {
    const f = await fixture(t);
    const title = Array.from({ length: 3000 }, (_, i) => createHash('sha256').update(String(i)).digest('hex') + '汉😀').join('');
    await f.mutate('UPDATE scenes SET title=$3 WHERE workspace_id=$1 AND record_id=$2', [title]);
    const a = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load())!));
    assert.equal(a.topology!.scenes[0]!.title, title);
    assert.ok(f.trace.filter(c => c.sql.includes('runtime topology')).every(c => c.rows <= 1000 && c.maxBuffer <= 65536));
    assert.equal(f.trace.filter(c => c.sql.startsWith('CLOSE realm_topology_')).length, 1);
    f.trace.length = 0;
    f.fail();
    await assert.rejects(f.load(), { code: 'RUNTIME_SAVE_INVALID' });
    assert.equal(f.trace.filter(c => c.sql.startsWith('CLOSE realm_topology_')).length, 1);
    assert.equal(f.trace.at(-1)!.sql, 'ROLLBACK');
    assert.equal(f.released(), 2);
});
test('N2 PG legal numeric raw larger than file limit stays normalized-small', async (t) => {
    const f = await fixture(t);
    await f.mutate(`UPDATE character_definitions SET profile=(SELECT jsonb_object_agg('n'||n,('0.'||repeat('0',16382)||'1')::numeric) FROM generate_series(0,4095) n) WHERE workspace_id=$1 AND id=$2||'.definition'`);
    const a = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load())!));
    assert.equal(Object.keys(a.topology!.participants[0]!.character!.definition.profile).length, 4096);
    assert.equal(f.trace.filter(c => c.sql.includes('definition_profile cursor */')).length, 1);
    assert.ok(f.trace.every(c => c.maxBuffer <= 65536));
});
test('N2 PG giant text refuses at public loader before any body cursor', async (t) => {
    const f = await fixture(t);
    await f.mutate("UPDATE scenes SET title=repeat('x',67108865) WHERE workspace_id=$1 AND record_id=$2");
    await assert.rejects(f.load(), { code: 'RUNTIME_SAVE_INVALID' });
    assert.equal(f.trace.filter(c => c.sql.includes('title cursor */')).length, 0);
    assert.ok(f.trace.filter(c => c.sql.includes('runtime topology')).every(c => c.maxString <= 256));
    assert.equal(f.trace.at(-1)!.sql, 'ROLLBACK');
});
