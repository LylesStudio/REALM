"use client";
import './record-goals.css';
import {useId} from 'react';
import { uiText,type UiLanguage } from '../../modules/i18n/public.ts';
import { normalizeRecordGoalDrafts,MAX_RECORD_GOALS,type RecordGoalDraft } from '../../modules/goals/authoring-contract.ts';
export const blankGoalDraft=():RecordGoalDraft=>({title:'',description:'',successConditions:[''],failureConditions:[],settlementConditions:[],changePolicy:'fixed',visible:true});
export function goalDraftsValid(value:unknown):boolean {
  try {normalizeRecordGoalDrafts(value ?? []);return true;} catch {return false;}
}
export function RecordGoalFields({draft,onChange,uiLanguage,disabled=false}:{draft:RecordGoalDraft;onChange:(draft:RecordGoalDraft)=>void;uiLanguage:UiLanguage;disabled?:boolean}) {
  const descriptionLabel=useId();
  const t=(key:string)=>uiText(`ui.goals.${key}`,uiLanguage);
  return <fieldset className="record-goal-fields" disabled={disabled}>
    <label><span>{t('name')}</span><input maxLength={160} value={draft.title} onChange={e=>onChange({...draft,title:e.target.value})}/></label>
    <label><span id={descriptionLabel}>{t('description')}</span><textarea aria-labelledby={descriptionLabel} maxLength={4000} rows={3} value={draft.description} onChange={e=>onChange({...draft,description:e.target.value})}/></label>
    {(['successConditions','failureConditions','settlementConditions'] as const).map((key,index)=><div className="goal-conditions" key={key}>
      <span>{t(['success','failure','settlement'][index])}</span>
      {draft[key].map((condition,i)=><div className="goal-condition-row" key={i}>
        <textarea aria-label={`${t(['success','failure','settlement'][index])} ${i+1}`} rows={2} maxLength={2048} value={condition}
          onChange={e=>onChange({...draft,[key]:draft[key].map((value,n)=>n===i?e.target.value:value)})}/>
        <button type="button" aria-label={t('removeCondition')} onClick={()=>onChange({...draft,[key]:draft[key].filter((_,n)=>n!==i)})}>×</button>
      </div>)}
      <button type="button" disabled={draft[key].length>=8} onClick={()=>onChange({...draft,[key]:[...draft[key],'']})}>{t('addCondition')}</button>
    </div>)}
    <label><span>{t('policy')}</span><select value={draft.changePolicy} onChange={e=>onChange({...draft,changePolicy:e.target.value as RecordGoalDraft['changePolicy']})}>
      <option value="fixed">{t('fixed')}</option><option value="evolving">{t('evolving')}</option>
    </select></label>
    <small>{t('policyHint')}</small>
    <label className="goal-visibility"><input type="checkbox" checked={draft.visible} onChange={e=>onChange({...draft,visible:e.target.checked})}/><span>{t('visible')}</span></label>
    {!draft.visible?<small>{t('hiddenHint')}</small>:null}
  </fieldset>;
}
export function GenesisGoalFields({goals,onChange,uiLanguage}:{goals:readonly RecordGoalDraft[];onChange:(goals:readonly RecordGoalDraft[])=>void;uiLanguage:UiLanguage}) {
  const t=(key:string)=>uiText(`ui.goals.${key}`,uiLanguage);
  return <section className="genesis-goals is-wide" aria-label={t('title')}>
    <h3>{t('title')}</h3><p className="goal-note">{t('hint')}</p>
    {goals.map((goal,index)=><details className="goal-draft-card" key={index} open>
      <summary>{goal.title.trim() || `${t('name')} ${index+1}`}</summary>
      <RecordGoalFields draft={goal} uiLanguage={uiLanguage} onChange={next=>onChange(goals.map((value,i)=>i===index?next:value))}/>
      <button type="button" onClick={()=>onChange(goals.filter((_,i)=>i!==index))}>{t('remove')}</button>
    </details>)}
    {!goalDraftsValid(goals)?<p className="goal-error" role="alert">{t('invalid')}</p>:null}
    <button type="button" disabled={goals.length>=MAX_RECORD_GOALS} onClick={()=>onChange([...goals,blankGoalDraft()])}>{t('add')}</button>
  </section>;
}
