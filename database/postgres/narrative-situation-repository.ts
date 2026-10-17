import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {RuntimeInvariantError} from '../../modules/runtime/public.ts';
import type {GoalRuntimeScope} from '../../modules/goals/public.ts';
import {decodeNarrativeState,emptyNarrativeState,type RecordNarrativeState} from '../../modules/application/narrative-situation.ts';

function fail(code:string):never {throw new RuntimeInvariantError(code,code);}
function bound(state:RecordNarrativeState,scope:GoalRuntimeScope):void {
  if(state.scope && (['workspaceId','worldId','worldlineId','recordId'] as const).some(key=>
    state.scope![key]!==scope[key]))fail('NARRATIVE_SCOPE_MISMATCH');
}
function payload(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))fail('NARRATIVE_SOURCE_INVALID');
  const outer=value as Record<string,unknown>;
  const inner=outer.__realmRuntimePayload ?? outer;
  if(!inner || typeof inner!=='object' || Array.isArray(inner))fail('NARRATIVE_SOURCE_INVALID');
  return inner as Record<string,unknown>;
}
async function source(client:PoolClient,scope:GoalRuntimeScope,sourceEventId:string) {
  const result=await client.query<{payload:unknown;record_version:string;record_ordinal:string}>(`SELECT event.payload,event.record_version::text,event.record_ordinal::text
    FROM events event JOIN visibility_policies policy ON policy.workspace_id=event.workspace_id AND policy.id=event.visibility_policy_id
      AND policy.world_id=event.world_id AND policy.worldline_id=event.worldline_id AND policy.record_id=event.record_id
    WHERE event.workspace_id=$1 AND event.world_id=$2 AND event.worldline_id=$3 AND event.record_id=$4 AND event.id=$5
      AND event.event_kind='narration.committed' AND policy.policy_kind='public'`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,sourceEventId]);
  const row=result.rows[0];if(!row)fail('NARRATIVE_SOURCE_INVALID');
  const body=payload(row.payload);if(body.role!=='narrator')fail('NARRATIVE_SOURCE_INVALID');
  const state=decodeNarrativeState(body.narrativeState);bound(state,scope);
  if(state.lastEventId!==sourceEventId)fail('NARRATIVE_SOURCE_INVALID');
  return {...row,state};
}
async function replay(client:PoolClient,scope:GoalRuntimeScope):Promise<RecordNarrativeState> {
  const rows=await client.query<{id:string;payload:unknown}>(`SELECT event.id,event.payload FROM events event
    JOIN visibility_policies policy ON policy.workspace_id=event.workspace_id AND policy.id=event.visibility_policy_id
      AND policy.world_id=event.world_id AND policy.worldline_id=event.worldline_id AND policy.record_id=event.record_id
    WHERE event.workspace_id=$1 AND event.world_id=$2 AND event.worldline_id=$3 AND event.record_id=$4
      AND event.event_kind='narration.committed' AND policy.policy_kind='public'
      AND COALESCE(event.payload->'__realmRuntimePayload',event.payload) ? 'narrativeState'
    ORDER BY event.record_version,event.record_ordinal,event.id`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId]);
  let previous=emptyNarrativeState();
  for(const row of rows.rows){
    const body=payload(row.payload);if(body.role!=='narrator')fail('NARRATIVE_SOURCE_INVALID');
    const current=decodeNarrativeState(body.narrativeState);bound(current,scope);
    if(current.lastEventId!==row.id || current.revision!==previous.revision+1 || current.elapsedMinutes<previous.elapsedMinutes)fail('NARRATIVE_HISTORY_INVALID');
    for(const old of previous.situations){
      const next=current.situations.find(item=>item.id===old.id);
      if(!next || (old.status!=='active' && !isDeepStrictEqual(old,next)) || next.originEventId!==old.originEventId
        || next.originIndex!==old.originIndex || (next.lastEventId!==old.lastEventId && (next.lastEventId!==row.id || next.revision!==old.revision+1)))fail('NARRATIVE_HISTORY_INVALID');
    }
    previous=current;
  }
  return previous;
}
/** Read-only: a lost cache is rebuilt from immutable, public Narrator events in memory. */
export async function loadRecordNarrativeState(client:PoolClient,scope:GoalRuntimeScope):Promise<RecordNarrativeState> {
  // Legacy read-only schemas may not yet contain this rebuildable cache. The
  // immutable event stream remains authoritative; never hide query/decoder errors.
  const catalog=await client.query<{available:boolean}>("SELECT to_regclass('public.record_narrative_state') IS NOT NULL AS available");
  if(!catalog.rows[0]?.available)return replay(client,scope);
  const row=(await client.query<{document:unknown}>(`SELECT document FROM record_narrative_state
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId])).rows[0];
  if(!row)return replay(client,scope);
  const state=decodeNarrativeState(row.document);bound(state,scope);return state;
}
/** Called after the real Narrator event is appended, inside its existing commit transaction. */
export async function applyCommittedNarrativeState(client:PoolClient,input:{scope:GoalRuntimeScope;sourceEventId:string;expectedRevision:number}):Promise<'applied'|'replayed'> {
  const {scope}=input;
  const current=(await client.query<{revision:string;source_event_id:string;document:unknown}>(`SELECT revision::text,source_event_id,document FROM record_narrative_state
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 FOR UPDATE`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId])).rows[0];
  const event=await source(client,scope,input.sourceEventId);
  if(current?.source_event_id===input.sourceEventId){
    if(!isDeepStrictEqual(current.document,event.state))fail('NARRATIVE_WRITE_CONFLICT');
    return 'replayed';
  }
  if((current && Number(current.revision)!==input.expectedRevision) || event.state.revision!==input.expectedRevision+1)fail('NARRATIVE_WRITE_CONFLICT');
  await write(client,scope,event);
  return 'applied';
}
async function write(client:PoolClient,scope:GoalRuntimeScope,event:Awaited<ReturnType<typeof source>>) {
  await client.query(`INSERT INTO record_narrative_state (workspace_id,world_id,worldline_id,record_id,revision,source_event_id,source_record_version,source_ordinal,document)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (workspace_id,record_id) DO UPDATE
    SET revision=EXCLUDED.revision,source_event_id=EXCLUDED.source_event_id,source_record_version=EXCLUDED.source_record_version,
      source_ordinal=EXCLUDED.source_ordinal,document=EXCLUDED.document,updated_at=CURRENT_TIMESTAMP`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,event.state.revision,event.state.lastEventId,event.record_version,event.record_ordinal,JSON.stringify(event.state)]);
}
export async function rebuildRecordNarrativeState(client:PoolClient,scope:GoalRuntimeScope):Promise<RecordNarrativeState> {
  const state=await replay(client,scope);
  if(state.lastEventId)await write(client,scope,await source(client,scope,state.lastEventId));
  return state;
}
