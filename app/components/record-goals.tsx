"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { uiText,type UiLanguage } from '../../modules/i18n/public.ts';
import { normalizeRecordGoalDraft,type RecordGoalDraft,type RecordGoalManagementSnapshot } from '../../modules/goals/authoring-contract.ts';
import { decodeGoalManagement,decodePublicGoals,type PublicGoalView } from '../../modules/goals/management-contract.ts';
import { RecordGoalFields,blankGoalDraft,goalDraftsValid } from './record-goal-fields.tsx';
import './record-goals.css';
type ManagedGoal=RecordGoalManagementSnapshot['goals'][number];
type PublicGoal=PublicGoalView;
export function RecordGoals({recordId,version,uiLanguage}:{recordId:string;version:number;uiLanguage:UiLanguage}) {
  const t=(key:string)=>uiText(`ui.goals.${key}`,uiLanguage);
  const [snapshot,setSnapshot]=useState<RecordGoalManagementSnapshot|null>(null);
  const [publicGoals,setPublicGoals]=useState<PublicGoal[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(false);
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [editor,setEditor]=useState<{goal:ManagedGoal|null;draft:RecordGoalDraft;reason:string}|null>(null);
  const generation=useRef(0);
  const requestBusy=useRef(false);
  const pendingCommand=useRef<{intent:string;key:string;payload:string}|null>(null);
  const load=useCallback(async(signal?:AbortSignal)=>{
    const owned=++generation.current;
    try {
      const [read,manage]=await Promise.all([
        fetch(`/api/record/goals?recordId=${encodeURIComponent(recordId)}`,{cache:'no-store',signal}),
        fetch(`/api/record/goals/commands?recordId=${encodeURIComponent(recordId)}`,{cache:'no-store',signal})]);
      const payload=await read.json();
      if(!read.ok || !payload.ok || payload.recordId!==recordId) throw new Error('GOAL_READ_FAILED');
      const publicView=decodePublicGoals(payload.goals);
      let management:RecordGoalManagementSnapshot|null=null;
      if(manage.ok) {const body=await manage.json();if(!body.ok || body.data?.recordId!==recordId || !Array.isArray(body.data?.goals)) throw new Error('GOAL_READ_FAILED');management=decodeGoalManagement(body.data,recordId);}
      else if(manage.status!==403) throw new Error('GOAL_READ_FAILED');
      if(owned!==generation.current || signal?.aborted) return false;
      setSnapshot(management);setPublicGoals(publicView);setLoaded(true);setError(false);return true;
    } catch {if(owned===generation.current && !signal?.aborted){setSnapshot(null);setPublicGoals([]);setLoaded(true);setError(true);}return false;}
  },[recordId]);
  useEffect(()=>{
    const controller=new AbortController();
    queueMicrotask(()=>{if(!controller.signal.aborted && !busy && !requestBusy.current) void load(controller.signal);});
    return()=>controller.abort();
  },[load,version,busy]);
  // The parent keys this component by Record: drafts and late responses cannot migrate to another Record.
  async function submit(operation:'create'|'revise'|'withdraw',goal:ManagedGoal|null,draft?:RecordGoalDraft,reason?:string) {
    if(!snapshot || requestBusy.current) return;
    let canonical:RecordGoalDraft|undefined;
    try {if(operation!=='withdraw') canonical=normalizeRecordGoalDraft(draft);} catch {setNotice('invalid');return;}
    if(operation!=='create' && !reason?.trim()) {setNotice('invalid');return;}
    requestBusy.current=true;setBusy(true);setNotice('');
    try {
      const intent=JSON.stringify({operation,recordId,goalInstanceId:goal?.goalInstanceId,draft:canonical,reason:reason?.trim()});
      if(pendingCommand.current?.intent!==intent) pendingCommand.current={intent,key:crypto.randomUUID(),
        payload:JSON.stringify({operation,recordId,expectedHead:snapshot.head,...(canonical?{draft:canonical}:{}),
          ...(goal?{goalInstanceId:goal.goalInstanceId,expectedDefinitionVersion:goal.definitionVersion,expectedInstanceRevision:goal.revision,reason:reason?.trim()}: {})})};
      const response=await fetch('/api/record/goals/commands',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':pendingCommand.current.key},
        body:pendingCommand.current.payload});
      const body=await response.json();
      if(!response.ok || !body.ok) {pendingCommand.current=null;setNotice(response.status===409?'conflict':'error');await load();return;}
      if(await load()) {pendingCommand.current=null;setEditor(null);setNotice(operation==='withdraw'?'withdrawnNotice':'saved');}
      else setNotice('error');
    } catch {setNotice('error');}
    finally {requestBusy.current=false;setBusy(false);}
  }
  async function assess(goal:ManagedGoal) {
    if(!snapshot || requestBusy.current) return;
    requestBusy.current=true;setBusy(true);
    try {
      const response=await fetch('/api/record/goals/assess',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({recordId,goalInstanceId:goal.goalInstanceId,expectedHead:snapshot.head})});
      const body=await response.json();
      if(!response.ok || !body.ok) setNotice(response.status===409?'conflict':'error');
      else setNotice(body.data.status==='waiting'?'waiting':'queued');
      await load();
    } catch {setNotice('error');} finally {requestBusy.current=false;setBusy(false);}
  }
  const renderGoal=(goal:ManagedGoal)=><article className="record-goal-card" key={goal.goalInstanceId} data-goal-instance={goal.goalInstanceId}>
    <div className="goal-meta"><span>{t(`state.${goal.resolutionKind && goal.resolutionKind!=='natural'?goal.resolutionKind:goal.state}`)}</span>
      <span>{t(goal.draft.changePolicy)}</span><span>{uiText('ui.goals.version',uiLanguage,{version:String(goal.definitionVersion)})}</span></div>
    <h3>{goal.draft.title}</h3><p>{goal.draft.description}</p>
    {goal.progressSummary?<p>{goal.progressSummary}</p>:null}
    <details className="goal-history"><summary>{t('success')}</summary><ul>{goal.draft.successConditions.map((condition,index)=><li key={index}>{goal.completedCriteria.includes(index)?'✓ ':''}{condition}</li>)}</ul></details>
    {goal.changeReason?<p className="goal-note">{goal.changeReason}</p>:null}
    {goal.assessmentState && ['pending','running','retryable','failed','completed'].includes(goal.assessmentState)?<p className="goal-note">{t(`job.${goal.assessmentState}`)}</p>:null}
    <div className="goal-actions">
      {goal.canRevise?<button type="button" disabled={busy} onClick={()=>{setEditor({goal,draft:goal.draft,reason:''});setNotice('');}}>{t('edit')}</button>:null}
      {goal.canWithdraw?<button type="button" disabled={busy} onClick={()=>{setEditor({goal,draft:goal.draft,reason:''});setNotice('');}}>{t('withdraw')}</button>:null}
      {goal.state==='active' && snapshot?.canCreate?<button type="button" disabled={busy} onClick={()=>void assess(goal)}>{t('assess')}</button>:null}
    </div>
  </article>;
  const managedIds=new Set(snapshot?.goals.map(goal=>goal.goalKey) ?? []);
  const editingGoal=editor?.goal?snapshot?.goals.find(goal=>goal.goalInstanceId===editor.goal!.goalInstanceId):null;
  const canEdit=snapshot?.canCreate && (!editor?.goal || editingGoal?.canRevise);
  const active=snapshot?.goals.filter(goal=>goal.state==='active') ?? [];
  const history=snapshot?.goals.filter(goal=>goal.state!=='active') ?? [];
  return <section className="inspector-card record-goals-panel" aria-label={t('title')}>
    <div className="inspector-heading"><p className="eyebrow">{t('title')}</p><button type="button" disabled={busy} onClick={()=>void load()}>{t('refresh')}</button></div>
    <p className="goal-note">{t('hint')}</p>
    {!loaded?<p role="status">{t('loading')}</p>:error?<p className="goal-error" role="alert">{t('error')}</p>:<>
      {!publicGoals.length?<p className="goal-note">{t('empty')}</p>:null}
      {active.map(renderGoal)}
      {publicGoals.filter(goal=>!managedIds.has(goal.goalKey)).map(goal=><article className="record-goal-card" key={goal.goalKey}>
        <div className="goal-meta">{t(`state.${goal.resolutionKind && goal.resolutionKind!=='natural'?goal.resolutionKind:goal.state}`)}</div>
        <h3>{goal.title || (typeof goal.outcome?.title==='string'?goal.outcome.title:goal.goalKey)}</h3>
        {goal.description?<p>{goal.description}</p>:null}{typeof goal.progress?.summary==='string'?<p>{goal.progress.summary}</p>:null}
      </article>)}
      {history.length?<details className="goal-history"><summary>{t('history')} · {history.length}</summary>{history.map(renderGoal)}</details>:null}
      {snapshot?.canCreate?<div className="goal-actions"><button type="button" disabled={busy} onClick={()=>{setEditor({goal:null,draft:blankGoalDraft(),reason:''});setNotice('');}}>{t('add')}</button></div>:<p className="goal-note">{t('readonly')}</p>}
    </>}
    {editor && snapshot?.canCreate?<div className="goal-create-form" aria-label={t(editor.goal?'edit':'create')}>
      <RecordGoalFields draft={editor.draft} uiLanguage={uiLanguage} disabled={busy || !canEdit} onChange={draft=>setEditor({...editor,draft})}/>
      {editor.goal?<label>{t('reason')}<textarea className="record-goal-reason" maxLength={2048} rows={2} disabled={busy} value={editor.reason} onChange={e=>setEditor({...editor,reason:e.target.value})}/></label>:null}
      <div className="goal-actions">
        {canEdit?<button type="button" disabled={busy || !goalDraftsValid([editor.draft]) || (!!editor.goal && !editor.reason.trim())}
          onClick={()=>void submit(editor.goal?'revise':'create',editingGoal ?? null,editor.draft,editor.reason)}>{t(editor.goal?'save':'create')}</button>:null}
        {editingGoal?.canWithdraw?<button type="button" disabled={busy || !editor.reason.trim()} onClick={()=>{
          if(window.confirm(t('withdrawConfirm'))) void submit('withdraw',editingGoal,undefined,editor.reason);
        }}>{t('withdraw')}</button>:null}
        <button type="button" disabled={busy} onClick={()=>setEditor(null)}>{t('cancel')}</button>
      </div>
    </div>:null}
    {busy?<p role="status" className="goal-status">{t('busy')}</p>:notice?<p role={['error','invalid','conflict'].includes(notice)?'alert':'status'} className={['error','invalid','conflict'].includes(notice)?'goal-error':'goal-status'}>{t(notice)}</p>:null}
  </section>;
}
