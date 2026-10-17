import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {decodeGoalManagement} from '../../modules/goals/management-contract';
test.afterEach(async({page},info)=>{if(info.status===info.expectedStatus)return;
  const id=new URL(page.url()).searchParams.get('recordId');
  const panel=await page.locator('.record-goals-panel').innerHTML().catch(()=>null);
  const snapshot=id?await (await page.request.get(`/api/record/goals/commands?recordId=${id}`)).json().catch(()=>null):null;
  await writeFile(join(process.env.HOME!,'.hermes/cache/scratch',`realm-iris-${info.title.slice(0,3)}-debug.json`),JSON.stringify({url:page.url(),panel,snapshot},null,2));
});
import {openDemoRecord,openLibrary,uniqueName,waitForRecordReady} from './helpers';

test('RG1 manual creation reviews fixed/evolving Goals, persists exact values and reloads the public panel',async({page})=>{
  await openDemoRecord(page);await openLibrary(page);
  await page.locator('.guided-entry:not(.is-primary)').click();
  await page.getByRole('textbox',{name:'世界名称输入'}).fill(uniqueName('GUI目标创世'));
  await page.locator('.guided-confirm').click();
  for(let step=0;step<8;step++) await page.locator('.guided-skip').click();
  const goals=page.locator('.genesis-goals');
  await expect(goals).toBeVisible();
  await goals.getByRole('button',{name:'添加目标',exact:true}).click();
  await expect(page.locator('.guided-seal-button')).toBeDisabled();
  const first=goals.locator('.goal-draft-card').nth(0);
  await first.getByLabel('目标标题',{exact:true}).fill('Protect the original letter');
  await first.getByLabel('目标说明',{exact:true}).fill('Keep the original letter intact until its recipient accepts it.');
  await first.getByLabel('成功条件 1',{exact:true}).fill('The recipient receives the original letter intact.');
  await expect(first.getByLabel('目标演化方式')).toHaveValue('fixed');
  await goals.getByRole('button',{name:'添加目标',exact:true}).click();
  const second=goals.locator('.goal-draft-card').nth(1);
  await second.getByLabel('目标标题',{exact:true}).fill('Find a safe route');
  await second.getByLabel('目标说明',{exact:true}).fill('Find a viable path when the road conditions change.');
  await second.getByLabel('成功条件 1',{exact:true}).fill('A safe route to the refuge is established.');
  await second.getByLabel('目标演化方式').selectOption('evolving');
  const committed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/world/generate' && response.request().method()==='POST');
  await page.locator('.guided-seal-button').click();
  const result=await (await committed).json();expect(result.ok).toBe(true);
  await waitForRecordReady(page);
  const panel=page.locator('.record-goals-panel');
  await expect(panel.getByRole('heading',{name:'Protect the original letter',exact:true})).toBeVisible();
  await expect(panel.getByRole('heading',{name:'Find a safe route',exact:true})).toBeVisible();
  const read=await page.request.get(`/api/record/goals/commands?recordId=${result.recordId}`);
  expect(read.ok()).toBe(true);
  const body=await read.json();const snapshot=decodeGoalManagement(body.data,result.recordId);
  if(!snapshot) throw new Error('Invalid Goal management response');
  expect(snapshot.goals).toHaveLength(2);
  const letter=snapshot.goals.find(goal=>goal.draft.title==='Protect the original letter');
  const route=snapshot.goals.find(goal=>goal.draft.title==='Find a safe route');
  if(!letter || !route) throw new Error('Missing created Goals');
  expect(letter.draft.changePolicy).toBe('fixed');expect(route.draft.changePolicy).toBe('evolving');
  expect(letter.draft.successConditions).toEqual(['The recipient receives the original letter intact.']);
  await page.goto(`/?recordId=${result.recordId}`);await waitForRecordReady(page);
  await page.reload();await waitForRecordReady(page);
  await expect(page.locator('.record-goals-panel')).toContainText('Protect the original letter');
  await expect(page.locator('.record-goals-panel')).toContainText('Find a safe route');
});

test('RG2 native editor handles lost-response replay, successor history, fixed policy and explicit withdrawal',async({page})=>{
  const response=await page.request.post('/api/world/generate',{data:{creationRequestId:randomUUID(),draft:{
    world:{name:uniqueName('GUI目标管理')},opening:'An unopened letter lies on the table.',companions:[],scene:{objective:'Examine the table'}}}});
  expect(response.ok()).toBe(true);const created=await response.json();
  await page.goto(`/?recordId=${created.recordId}`);await waitForRecordReady(page);
  // The fresh world's scheduled first-night release legitimately advances its
  // head. Settle that fixture boundary before injecting a lost Goal response;
  // a valid 409 is not a committed response to lose.
  await expect.poll(async()=>{
    const read=await page.request.get(`/api/record/goals/commands?recordId=${created.recordId}`);
    const body=await read.json();return decodeGoalManagement(body.data,created.recordId)?.head.recordVersion??0;
  }).toBeGreaterThan(0);
  const panel=page.locator('.record-goals-panel');
  await panel.getByRole('button',{name:'添加目标',exact:true}).click();
  const form=panel.locator('.goal-create-form');
  await form.getByLabel('目标标题',{exact:true}).fill('Verify the seal');
  await form.getByLabel('目标说明',{exact:true}).fill('Have the original seal verified by the intended recipient.');
  await form.getByLabel('成功条件 1',{exact:true}).fill('The recipient verifies the original seal.');
  await form.getByLabel('目标演化方式').selectOption('evolving');
  let lost=false;
  await page.route('**/api/record/goals/commands',async route=>{
    if(route.request().method()!=='POST' || lost){await route.continue();return;}
    lost=true;const actual=await route.fetch();expect(actual.ok(),`lost-response admission: ${actual.status()} ${await actual.text()}`).toBe(true);await route.abort('failed');
  });
  await form.getByRole('button',{name:'创建目标',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('操作未完成');
  await form.getByRole('button',{name:'创建目标',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('目标已保存');
  await expect(panel.locator('.record-goal-card')).toHaveCount(1);
  await page.unroute('**/api/record/goals/commands');
  const card=panel.locator('.record-goal-card').first();
  await card.getByRole('button',{name:'修订目标',exact:true}).click();
  await form.getByLabel('目标说明',{exact:true}).fill('Find the recipient before asking them to verify the seal.');
  await form.getByLabel('变更理由',{exact:true}).fill('The recipient has moved to the northern gate.');
  const revision=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/record/goals/commands'
    && response.request().method()==='POST' && response.request().postDataJSON().operation==='revise');
  await form.getByRole('button',{name:'保存新版本',exact:true}).click();
  if((await revision).status()===409) {
    await expect(panel.getByRole('alert')).toContainText('局势或目标版本已经变化');
    await expect(form.getByLabel('目标说明',{exact:true})).toHaveValue('Find the recipient before asking them to verify the seal.');
    await form.getByRole('button',{name:'保存新版本',exact:true}).click();
  }
  await expect(panel.getByRole('status')).toContainText('目标已保存');
  await expect(panel).toContainText('定义 v2');
  await expect(panel).toContainText('The recipient has moved to the northern gate.');
  const after=await (await page.request.get(`/api/record/goals/commands?recordId=${created.recordId}`)).json();
  const revised=decodeGoalManagement(after.data,created.recordId);
  if(!revised) throw new Error('Invalid revised Goal management response');
  expect(revised.goals).toHaveLength(2);
  expect(revised.goals.find(goal=>goal.definitionVersion===1)?.resolutionKind).toBe('superseded');
  const active=panel.locator('.record-goal-card').filter({has:page.getByRole('button',{name:'修订目标',exact:true})});
  await active.getByRole('button',{name:'撤回目标',exact:true}).click();
  await form.getByLabel('变更理由',{exact:true}).fill('The player withdraws this direction; no story outcome is claimed.');
  page.once('dialog',dialog=>dialog.accept());
  await form.getByRole('button',{name:'撤回目标',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('目标已撤回');
  await panel.getByRole('button',{name:'添加目标',exact:true}).click();
  await form.getByLabel('目标标题',{exact:true}).fill('Keep the letter intact');
  await form.getByLabel('目标说明',{exact:true}).fill('Do not replace or destroy the original letter.');
  await form.getByLabel('成功条件 1',{exact:true}).fill('The original reaches its recipient intact.');
  await form.getByRole('button',{name:'创建目标',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('目标已保存');
  const fixed=panel.locator('.record-goal-card').filter({has:page.getByRole('heading',{name:'Keep the letter intact',exact:true})});
  await expect(fixed.getByRole('button',{name:'修订目标',exact:true})).toHaveCount(0);
  await expect(fixed.getByRole('button',{name:'撤回目标',exact:true})).toBeVisible();
  await fixed.getByRole('button',{name:'评估已提交的事实',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText(/等待目标启用后|评估已在队列中/);
  await page.reload();await waitForRecordReady(page);
  await expect(page.locator('.record-goals-panel')).toContainText('Keep the letter intact');
});

test('RG3 archive restore and visible branch retain native Goals and isolate later revision',async({page},info)=>{
  const fixed={title:'Preserve the archive seal',description:'Keep the sealed archive intact.',successConditions:['The archive reaches its keeper intact.'],
    failureConditions:[],settlementConditions:[],visible:true,changePolicy:'fixed'};
  const evolving={...fixed,title:'Locate the archive keeper',description:'Find the keeper before arranging the handover.',changePolicy:'evolving'};
  const createdResponse=await page.request.post('/api/world/generate',{data:{creationRequestId:randomUUID(),draft:{
    world:{name:uniqueName('GUI目标存档分支')},opening:'The sealed archive is on the desk. Its keeper has not arrived.',companions:[],scene:{objective:'Inspect the archive'},recordGoals:[fixed,evolving]}}});
  expect(createdResponse.ok()).toBe(true);const created=await createdResponse.json();
  const read=async(recordId:string)=>{
    const response=await page.request.get(`/api/record/goals/commands?recordId=${recordId}`);expect(response.ok()).toBe(true);
    const body=await response.json();const result=decodeGoalManagement(body.data,recordId);if(!result)throw new Error('Invalid Goal archive/branch readback');return result;
  };
  const definitions=(snapshot:NonNullable<ReturnType<typeof decodeGoalManagement>>)=>snapshot.goals.map(goal=>({
    goalInstanceId:goal.goalInstanceId,definitionVersion:goal.definitionVersion,draft:goal.draft,state:goal.state,resolutionKind:goal.resolutionKind}));
  const open=async(recordId:string)=>{
    await page.goto(`/?recordId=${recordId}`);await waitForRecordReady(page);
    for(const title of [fixed.title,evolving.title])await expect(page.locator('.record-goals-panel').getByRole('heading',{name:title,exact:true})).toBeVisible();
  };
  await open(created.recordId);const source=definitions(await read(created.recordId));
  const archive=await page.request.post('/api/record/save',{data:{recordId:created.recordId}});expect(archive.status()).toBe(200);
  const bytes=await archive.body();expect(bytes[0]).toBe(0x50);expect(bytes[1]).toBe(0x4b);
  const restore=await page.request.post('/api/record/restore',{headers:{'content-type':'application/vnd.realm.save+zip','x-realm-target-world':created.worldId,'idempotency-key':`rg3-restore-${randomUUID()}`},data:bytes});
  expect(restore.status()).toBe(201);const restored=await restore.json();expect(restored.recordId).not.toBe(created.recordId);
  await open(restored.recordId);await page.reload();await waitForRecordReady(page);
  expect((await read(restored.recordId)).goals.map(goal=>goal.draft).sort((a,b)=>a.title.localeCompare(b.title))).toEqual([fixed,evolving].sort((a,b)=>a.title.localeCompare(b.title)));
  await open(created.recordId);
  await page.getByRole('button',{name:'创建分支',exact:true}).first().click();
  const dialog=page.locator('[data-testid="branch-dialog"]');await expect(dialog).toBeVisible();
  const response=page.waitForResponse(result=>new URL(result.url()).pathname==='/api/record/branch'&&result.request().method()==='POST');
  await dialog.getByRole('button',{name:'创建分支',exact:true}).click();
  const result=await response;expect(result.status()).toBe(201);const branched=await result.json();
  await expect(page.locator('.record-heading .record-timeline-badge')).toHaveText('分支');await waitForRecordReady(page);
  await expect(page.locator('.record-goals-panel')).toContainText(fixed.title);await expect(page.locator('.record-goals-panel')).toContainText(evolving.title);
  expect((await read(branched.recordId)).goals.map(goal=>goal.draft).sort((a,b)=>a.title.localeCompare(b.title))).toEqual([fixed,evolving].sort((a,b)=>a.title.localeCompare(b.title)));
  const card=page.locator('.record-goal-card').filter({has:page.getByRole('heading',{name:evolving.title,exact:true})});
  await card.getByRole('button',{name:'修订目标',exact:true}).click();
  const form=page.locator('.goal-create-form');await form.getByLabel('目标说明',{exact:true}).fill('Find the keeper at the northern gate in this branch only.');
  await form.getByLabel('变更理由',{exact:true}).fill('An explicit branch-local direction; the source archive remains unchanged.');
  const revision=page.waitForResponse(result=>new URL(result.url()).pathname==='/api/record/goals/commands'&&result.request().method()==='POST');
  await form.getByRole('button',{name:'保存新版本',exact:true}).click();expect((await revision).status()).toBe(200);
  await expect(page.locator('.record-goals-panel').getByRole('status')).toContainText('目标已保存');
  await expect(page.locator('.record-goals-panel')).toContainText('定义 v2');
  expect(definitions(await read(created.recordId))).toEqual(source);
  expect((await read(restored.recordId)).goals.map(goal=>goal.draft).sort((a,b)=>a.title.localeCompare(b.title))).toEqual([fixed,evolving].sort((a,b)=>a.title.localeCompare(b.title)));
  await page.screenshot({path:info.outputPath('rg3-branch-goals.png'),fullPage:true});
});
