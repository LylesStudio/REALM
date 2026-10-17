import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGoalManagement,decodePublicGoals } from '../modules/goals/management-contract.ts';
import { uiMessageKeys,uiMessageTable } from '../modules/i18n/public.ts';
const draft={title:'Protect the letter',description:'Deliver it intact.',successConditions:['Delivery is confirmed'],failureConditions:[],settlementConditions:[],changePolicy:'fixed',visible:true};
const goal={goalInstanceId:'instance_1',goalKey:'goal_1',definitionVersion:1,revision:1,draft,state:'active',progressSummary:'',completedCriteria:[],supersedesInstanceId:null,changeReason:null,canRevise:false,canWithdraw:true,assessmentState:null};
const snapshot={recordId:'record_1',canCreate:true,head:{recordVersion:1,ordinal:1},goals:[goal]};
test('Goal editor reads closed canonical definitions and never fabricates fixed-policy authority',()=>{
  assert.deepEqual(decodeGoalManagement(snapshot,'record_1'),snapshot);
  for(const changed of [{...snapshot,recordId:'record_other'},{...snapshot,head:{recordVersion:0,ordinal:1}},
    {...snapshot,goals:[{...goal,canRevise:true}]},{...snapshot,goals:[{...goal,draft:{...draft,visible:false}}]},
    {...snapshot,goals:[{...goal,completedCriteria:[2]}]},{...snapshot,goals:[goal,goal]},
    {...snapshot,goals:[{...goal,supersedesInstanceId:'hidden_instance'}]},
    {...snapshot,goals:[{...goal,draft:{...draft,role:'owner'}}]}]) assert.throws(()=>decodeGoalManagement(changed,'record_1'));
});
test('public Goal cards accept only supported states and safe renderable fields',()=>{
  assert.deepEqual(decodePublicGoals([{goalKey:'key',state:'active',progress:{},outcome:null}]),[{goalKey:'key',state:'active',progress:{},outcome:null}]);
  for(const value of [{},[{goalKey:'key',state:['active'],progress:{},outcome:null}],[{goalKey:'key',state:'active',progress:{summary:{}},outcome:null}]]) assert.throws(()=>decodePublicGoals(value));
});
test('every Goal control, status and error has complete three-language copy',()=>{
  const keys=uiMessageKeys().filter(key=>key.startsWith('ui.goals.'));
  assert.ok(keys.length>40);
  for(const key of keys) for(const language of ['zh-CN','en','ja'] as const) assert.ok(uiMessageTable(key)?.[language]?.trim(),`${key}:${language}`);
});
