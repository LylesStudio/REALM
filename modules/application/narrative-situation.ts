import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {RuntimeInvariantError} from '../runtime/public.ts';
import type {GoalRuntimeScope} from '../goals/public.ts';

export type NarrativeSituation = {
  id:string; originEventId:string; originIndex:number; lastEventId:string; revision:number;
  status:'active'|'resolved'|'superseded'; fact:string; obstacle:string|null;
  unknowns:readonly string[]; exitConditions:readonly string[]; basisEventIds:readonly string[];
}
export type RecordNarrativeState = {
  scope:Pick<GoalRuntimeScope,'workspaceId'|'worldId'|'worldlineId'|'recordId'>|null; revision:number; lastEventId:string|null; elapsedMinutes:number;
  situations:readonly NarrativeSituation[]; lastProposalFingerprint:string|null; fingerprint:string;
}
export type NarrativeConsequenceProposal = {
  changes:readonly {
    situationId:string|null; status:NarrativeSituation['status']; fact:string; obstacle:string|null;
    unknowns:readonly string[]; exitConditions:readonly string[]; basisEventIds:readonly string[];
    /** Any unselected player action is refused; this is not a player action command. */
    playerActions:readonly string[];
  }[];
  elapsedMinutes:number;
}
function fail(code:string):never {throw new RuntimeInvariantError(code,code);}
function hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))fail('NARRATIVE_PROPOSAL_INVALID');
  return value as Record<string,unknown>;
}
function keys(row:Record<string,unknown>,allowed:readonly string[]) {
  if(Object.keys(row).sort().join('|')!==[...allowed].sort().join('|'))fail('NARRATIVE_PROPOSAL_INVALID');
}
function text(value:unknown,max=2048):string {
  if(typeof value!=='string' || !value.trim() || value.length>max || value.includes('\0'))fail('NARRATIVE_PROPOSAL_INVALID');
  return value.trim();
}
function id(value:unknown):string {
  const result=text(value,200);
  if(!/^[A-Za-z0-9._:-]+$/.test(result))fail('NARRATIVE_PROPOSAL_INVALID');
  return result;
}
function number(value:unknown,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0 || value>max)fail('NARRATIVE_PROPOSAL_INVALID');
  return value;
}
function list(value:unknown,max=16):readonly string[] {
  if(!Array.isArray(value) || value.length>max)fail('NARRATIVE_PROPOSAL_INVALID');
  const result=value.map(item=>text(item));
  if(new Set(result).size!==result.length)fail('NARRATIVE_PROPOSAL_INVALID');
  return Object.freeze(result);
}
function scope(value:GoalRuntimeScope):GoalRuntimeScope {
  return Object.freeze({workspaceId:id(value.workspaceId),worldId:id(value.worldId),worldlineId:id(value.worldlineId),recordId:id(value.recordId)});
}
function seal(body:Omit<RecordNarrativeState,'fingerprint'>):RecordNarrativeState {
  return Object.freeze({...body,fingerprint:hash(body)});
}
export function emptyNarrativeState():RecordNarrativeState {
  return seal({scope:null,revision:0,lastEventId:null,elapsedMinutes:0,situations:Object.freeze([]),lastProposalFingerprint:null});
}
export function normalizeNarrativeConsequence(value:unknown):NarrativeConsequenceProposal {
  const row=object(value);keys(row,['changes','elapsedMinutes']);
  if(!Array.isArray(row.changes) || row.changes.length>8)fail('NARRATIVE_PROPOSAL_INVALID');
  const seen=new Set<string>();
  const changes=row.changes.map(value=>{
    const change=object(value);keys(change,['situationId','status','fact','obstacle','unknowns','exitConditions','basisEventIds','playerActions']);
    const situationId=change.situationId===null?null:id(change.situationId);
    if(situationId!==null && seen.has(situationId))fail('NARRATIVE_PROPOSAL_INVALID');
    if(situationId!==null)seen.add(situationId);
    if(!['active','resolved','superseded'].includes(String(change.status)))fail('NARRATIVE_PROPOSAL_INVALID');
    const playerActions=list(change.playerActions);
    if(playerActions.length)fail('NARRATIVE_PLAYER_AGENCY');
    return Object.freeze({situationId,status:change.status as NarrativeSituation['status'],fact:text(change.fact),
      obstacle:change.obstacle===null?null:text(change.obstacle),unknowns:list(change.unknowns),
      exitConditions:list(change.exitConditions),basisEventIds:list(change.basisEventIds),playerActions});
  });
  return Object.freeze({changes:Object.freeze(changes),elapsedMinutes:number(row.elapsedMinutes,1440)});
}
export function decodeNarrativeState(value:unknown):RecordNarrativeState {
  try {
    const row=object(value);
    keys(row,['scope','revision','lastEventId','elapsedMinutes','situations','lastProposalFingerprint','fingerprint']);
    if(row.revision===0){const empty=emptyNarrativeState();if(!isDeepStrictEqual(value,empty))fail('NARRATIVE_STATE_INVALID');return empty;}
    const bound=scope(object(row.scope) as unknown as GoalRuntimeScope);
    const revision=number(row.revision);
    const lastEventId=id(row.lastEventId);
    const elapsedMinutes=number(row.elapsedMinutes);
    const lastProposalFingerprint=text(row.lastProposalFingerprint,64);
    if(!/^[a-f0-9]{64}$/.test(lastProposalFingerprint) || !Array.isArray(row.situations) || row.situations.length>1024)fail('NARRATIVE_STATE_INVALID');
    const seen=new Set<string>();
    const situations=row.situations.map(value=>{
      const item=object(value);
      keys(item,['id','originEventId','originIndex','lastEventId','revision','status','fact','obstacle','unknowns','exitConditions','basisEventIds']);
      const originEventId=id(item.originEventId);const originIndex=number(item.originIndex,7);
      const identity=`situation_${hash([bound,originEventId,originIndex])}`;
      if(item.id!==identity || seen.has(identity))fail('NARRATIVE_STATE_INVALID');
      seen.add(identity);
      const change=normalizeNarrativeConsequence({changes:[{situationId:identity,status:item.status,fact:item.fact,obstacle:item.obstacle,
        unknowns:item.unknowns,exitConditions:item.exitConditions,basisEventIds:item.basisEventIds,playerActions:[]}],elapsedMinutes:0}).changes[0]!;
      const itemRevision=number(item.revision);if(itemRevision<1 || itemRevision>revision)fail('NARRATIVE_STATE_INVALID');
      return Object.freeze({id:identity,originEventId,originIndex,lastEventId:id(item.lastEventId),revision:itemRevision,
        status:change.status,fact:change.fact,obstacle:change.obstacle,unknowns:change.unknowns,
        exitConditions:change.exitConditions,basisEventIds:change.basisEventIds});
    });
    const canonical=seal({scope:bound,revision,lastEventId,elapsedMinutes,situations:Object.freeze(situations),lastProposalFingerprint});
    if(!isDeepStrictEqual(canonical,value))fail('NARRATIVE_STATE_INVALID');
    return canonical;
  } catch {fail('NARRATIVE_STATE_INVALID');}
}
/** Import a validated event-bound snapshot into its copied Record, not a new world result. */
export function rebaseNarrativeState(input:{state:unknown;sourceScope:GoalRuntimeScope;targetScope:GoalRuntimeScope;eventIds:ReadonlyMap<string,string>}):RecordNarrativeState {
  const previous=decodeNarrativeState(input.state);
  if(previous.revision===0)return previous;
  if(!isDeepStrictEqual(previous.scope,scope(input.sourceScope)))fail('NARRATIVE_SCOPE_MISMATCH');
  const bound=scope(input.targetScope);
  const mapped=(source:string)=>{const target=input.eventIds.get(source);if(!target)fail('NARRATIVE_SOURCE_INVALID');return id(target);};
  const situations=previous.situations.map(item=>{
    const originEventId=mapped(item.originEventId);
    return Object.freeze({...item,id:`situation_${hash([bound,originEventId,item.originIndex])}`,originEventId,
      lastEventId:mapped(item.lastEventId),basisEventIds:Object.freeze(item.basisEventIds.map(mapped))});
  });
  // The old proposal digest remains immutable import provenance; the snapshot
  // digest is recomputed for the actual new scope and copied formal event IDs.
  return decodeNarrativeState(seal({scope:bound,revision:previous.revision,lastEventId:mapped(previous.lastEventId!),
    elapsedMinutes:previous.elapsedMinutes,situations:Object.freeze(situations),lastProposalFingerprint:previous.lastProposalFingerprint}));
}

/** Only an accepted Narrator result from a player turn may propose a world change.
 * No character belief, browser flag, Goal or model output can execute a player action,
 * inventory/finance command, or clock advance through this projection.
 */
export function planNarrativeConsequence(input:{
  scope:GoalRuntimeScope;previous:RecordNarrativeState;expectedRevision:number;sourceEventId:string;
  observedHead:{recordVersion:number;ordinal:number};sourceRole:'narrator'|'character'|'player';
  turnKind:'player'|'presence'|'self-play';committedEventIds:readonly string[];timeAdvanceAuthorized:boolean;
  proposal:unknown;
}):RecordNarrativeState|null {
  const bound=scope(input.scope);
  const previous=decodeNarrativeState(input.previous);
  if(previous.scope && !isDeepStrictEqual(previous.scope,bound))fail('NARRATIVE_SCOPE_MISMATCH');
  if(number(input.expectedRevision)!==previous.revision)fail('NARRATIVE_WRITE_CONFLICT');
  number(input.observedHead.recordVersion);number(input.observedHead.ordinal);
  const sourceEventId=id(input.sourceEventId);
  const proposal=normalizeNarrativeConsequence(input.proposal);
  if(input.sourceRole!=='narrator' || input.turnKind!=='player')fail('NARRATIVE_AUTHORITY_REQUIRED');
  if(proposal.elapsedMinutes && input.timeAdvanceAuthorized!==true)fail('NARRATIVE_TIME_NOT_AUTHORIZED');
  const proposalFingerprint=hash(proposal);
  if(previous.lastEventId===sourceEventId){
    if(previous.lastProposalFingerprint!==proposalFingerprint)fail('NARRATIVE_EVENT_REUSED');
    return previous;
  }
  const evidence=new Set(input.committedEventIds);
  const situations=[...previous.situations];
  let changed=proposal.elapsedMinutes>0;
  for(const [index,change] of proposal.changes.entries()) {
    if(change.basisEventIds.some(event=>!evidence.has(event)))fail('NARRATIVE_EVIDENCE_INVALID');
    const oldIndex=change.situationId===null?-1:situations.findIndex(item=>item.id===change.situationId);
    if(change.situationId!==null && oldIndex<0)fail('NARRATIVE_SITUATION_UNKNOWN');
    const old=oldIndex<0?null:situations[oldIndex]!;
    if(old && old.status!=='active')fail('NARRATIVE_SITUATION_RETIRED');
    if(old && old.status===change.status && old.fact===change.fact && old.obstacle===change.obstacle &&
      isDeepStrictEqual(old.unknowns,change.unknowns) && isDeepStrictEqual(old.exitConditions,change.exitConditions))continue;
    const situation=Object.freeze({id:old?.id ?? `situation_${hash([bound,sourceEventId,index])}`,
      originEventId:old?.originEventId ?? sourceEventId,originIndex:old?.originIndex ?? index,
      lastEventId:sourceEventId,revision:(old?.revision ?? 0)+1,status:change.status,fact:change.fact,
      obstacle:change.obstacle,unknowns:change.unknowns,exitConditions:change.exitConditions,basisEventIds:change.basisEventIds});
    if(oldIndex<0)situations.push(situation);else situations[oldIndex]=situation;
    changed=true;
  }
  if(!changed)return null;
  if(situations.length>1024 || situations.filter(item=>item.status==='active').length>32)fail('NARRATIVE_CAPACITY_EXCEEDED');
  return decodeNarrativeState(seal({scope:bound,revision:previous.revision+1,lastEventId:sourceEventId,
    elapsedMinutes:previous.elapsedMinutes+proposal.elapsedMinutes,situations:Object.freeze(situations),lastProposalFingerprint:proposalFingerprint}));
}
