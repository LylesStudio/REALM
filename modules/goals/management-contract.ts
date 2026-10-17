import { normalizeRecordGoalDraft,type RecordGoalManagementSnapshot } from './authoring-contract.ts';
const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const integer=(v:unknown,min=0):v is number=>typeof v==='number' && Number.isSafeInteger(v) && v>=min;
const text=(v:unknown,max:number):v is string=>typeof v==='string' && v.length>0 && v.length<=max && !v.includes('\0');
const states=['active','completed','failed','settled'];
const resolutions=['natural','withdrawn','superseded'];
function invalid():never {throw new Error('GOAL_RESPONSE_INVALID');}
export function decodeGoalManagement(value:unknown,recordId:string):RecordGoalManagementSnapshot {
  if(!object(value) || value.recordId!==recordId || typeof value.canCreate!=='boolean' || !object(value.head)
    || !integer(value.head.recordVersion) || !integer(value.head.ordinal) || !Array.isArray(value.goals)) invalid();
  if((value.head.recordVersion===0)!==(value.head.ordinal===0)) invalid();
  const canCreate=value.canCreate;
  const goals=value.goals.map((row):RecordGoalManagementSnapshot['goals'][number]=>{
    if(!object(row) || !text(row.goalInstanceId,160) || !text(row.goalKey,256) || !integer(row.definitionVersion,1)
      || !integer(row.revision,1) || typeof row.state!=='string' || !states.includes(row.state)
      || (row.resolutionKind!==undefined && (typeof row.resolutionKind!=='string' || !resolutions.includes(row.resolutionKind)))
      || typeof row.progressSummary!=='string' || row.progressSummary.length>1600 || !Array.isArray(row.completedCriteria)
      || typeof row.canRevise!=='boolean' || typeof row.canWithdraw!=='boolean'
      || (row.supersedesInstanceId!==null && !text(row.supersedesInstanceId,160))
      || (row.changeReason!==null && !text(row.changeReason,2048))
      || (row.assessmentState!==null && (typeof row.assessmentState!=='string' || !['pending','running','retryable','failed','completed'].includes(row.assessmentState)))) invalid();
    const draft=normalizeRecordGoalDraft(row.draft);
    if(!draft.visible || row.completedCriteria.some(item=>!integer(item) || item>=draft.successConditions.length)
      || new Set(row.completedCriteria).size!==row.completedCriteria.length) invalid();
    if((row.canRevise && (!canCreate || row.state!=='active' || draft.changePolicy!=='evolving'))
      || (row.canWithdraw && (!canCreate || row.state!=='active'))) invalid();
    return {goalInstanceId:row.goalInstanceId,goalKey:row.goalKey,definitionVersion:row.definitionVersion,revision:row.revision,
      draft,state:row.state as RecordGoalManagementSnapshot['goals'][number]['state'],
      ...(row.resolutionKind ? {resolutionKind:row.resolutionKind as 'natural'|'withdrawn'|'superseded'} : {}),
      progressSummary:row.progressSummary,completedCriteria:row.completedCriteria as number[],
      supersedesInstanceId:row.supersedesInstanceId as string|null,changeReason:row.changeReason as string|null,
      canRevise:row.canRevise,canWithdraw:row.canWithdraw,assessmentState:row.assessmentState as string|null};
  });
  const ids=new Set(goals.map(goal=>goal.goalInstanceId));
  if(ids.size!==goals.length || goals.some(goal=>goal.supersedesInstanceId!==null && !ids.has(goal.supersedesInstanceId))) invalid();
  return {recordId,canCreate,head:{recordVersion:value.head.recordVersion,ordinal:value.head.ordinal},goals};
}
export interface PublicGoalView {goalKey:string;state:string;resolutionKind?:string;title?:string;description?:string;progress:{summary?:string};outcome:{title?:string}|null;}
export function decodePublicGoals(value:unknown):PublicGoalView[] {
  if(!Array.isArray(value)) invalid();
  return value.map(row=>{
    if(!object(row) || !text(row.goalKey,256) || typeof row.state!=='string' || !states.includes(row.state)
      || (row.resolutionKind!==undefined && (typeof row.resolutionKind!=='string' || !resolutions.includes(row.resolutionKind)))
      || (row.title!==undefined && !text(row.title,160)) || (row.description!==undefined && !text(row.description,4000))
      || !object(row.progress) || (row.progress.summary!==undefined && (typeof row.progress.summary!=='string' || row.progress.summary.length>1600))
      || (row.outcome!==null && !object(row.outcome))) invalid();
    return {goalKey:row.goalKey,state:row.state,...(row.resolutionKind?{resolutionKind:row.resolutionKind as string}:{}),
      ...(row.title?{title:row.title as string}:{}),...(row.description?{description:row.description as string}:{}),
      progress:typeof row.progress.summary==='string'?{summary:row.progress.summary}:{},
      outcome:object(row.outcome) && typeof row.outcome.title==='string'?{title:row.outcome.title}:null};
  });
}
