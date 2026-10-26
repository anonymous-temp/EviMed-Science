import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { RsiCampaignBudget } from '../src/rsiCampaignBudget.mjs';
import { boundLab } from './rsiLabConfiguration.test.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const u=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(u.hostname));assert.match(u.pathname,/evimed_test/);}
test('durable concurrent admission, failed/unknown costs, idempotency and Beijing rollover', {skip:!url&&'Disposable localhost PostgreSQL required'},async()=>{
 const database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
 const owner=`rsi_${randomUUID().replaceAll('-','')}`;let time='2026-10-31T15:59:59Z';
 try{
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI test','development')",[owner]);
  const configuration=boundLab(owner);configuration.budget.monthCny=1000;
  const ledger=new RsiCampaignBudget({database,configuration,now:()=>time});
  const results=await Promise.all(['a','b'].map(campaignId=>ledger.reserve({campaignId,stageKey:'one',amountCny:800})));
  assert.equal(results.filter(r=>r.authorized).length,1);
  const campaignId=results[0].authorized?'a':'b';
  assert.equal((await ledger.reserve({campaignId,stageKey:'one',amountCny:800})).authorized,true);
  await assert.rejects(ledger.reserve({campaignId,stageKey:'one',amountCny:799}),{code:'campaign_budget_idempotency_conflict'});
  assert.equal((await ledger.beginSpend({campaignId,stageKey:'one'})).authorized,true);
  assert.equal((await ledger.beginSpend({campaignId,stageKey:'one'})).authorized,false);
  await ledger.settle({campaignId,stageKey:'one',outcome:'unknown',actualCny:null});
  const restarted=new RsiCampaignBudget({database,configuration,now:()=>time});
  assert.equal((await restarted.reserve({campaignId:'third',stageKey:'one',amountCny:201})).authorized,false);
  await ledger.settle({campaignId,stageKey:'one',outcome:'failed',actualCny:850});
  await ledger.settle({campaignId,stageKey:'one',outcome:'failed',actualCny:850});
  await assert.rejects(ledger.settle({campaignId,stageKey:'one',outcome:'success',actualCny:850}),{code:'campaign_budget_settlement_conflict'});
  await ledger.reserve({campaignId:'fresh',stageKey:'expiring',amountCny:150});
  time='2026-10-31T16:00:00Z';
  assert.equal((await ledger.beginSpend({campaignId:'fresh',stageKey:'expiring'})).reason,'campaign_budget_month_expired');
  assert.equal((await ledger.reserve({campaignId:'fresh',stageKey:'november',amountCny:850})).authorized,true);
  await ledger.settle({campaignId:'fresh',stageKey:'expiring',actualCny:200,outcome:'failed'});
  assert.equal((await ledger.reserve({campaignId:'fresh',stageKey:'overrun',amountCny:1})).reason,'campaign_budget_exceeded');
  const original=await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND payload->>'stageKey'='expiring'",[owner]);
  assert.equal(original.rows[0].payload.month,'2026-10');
 }finally{await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);await database.close();}
});
test('owner caps apply atomically within a campaign and across all lab campaigns', {skip:!url&&'Disposable localhost PostgreSQL required'},async()=>{
 const database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});const owner=`rsi_${randomUUID().replaceAll('-','')}`;
 try{
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI caps test','development')",[owner]);
  const ledger=new RsiCampaignBudget({database,configuration:boundLab(owner),now:()=> '2026-10-26T01:00:00Z'});
  const pair=await Promise.all(['a','b'].map(stageKey=>ledger.reserve({campaignId:'same',stageKey,amountCny:800})));
  assert.equal(pair.filter(x=>x.authorized).length,1);assert.equal(pair.find(x=>!x.authorized).reason,'campaign_budget_exceeded');
  await ledger.reserve({campaignId:'same',stageKey:'rest',amountCny:200});
  for(let n=0;n<29;n++)assert.equal((await ledger.reserve({campaignId:`other-${n}`,stageKey:'one',amountCny:1000})).authorized,true);
  assert.equal((await ledger.reserve({campaignId:'thirty-first',stageKey:'one',amountCny:0.00000001})).reason,'campaign_month_budget_exceeded');
  await assert.rejects(ledger.reserve({campaignId:'invalid',stageKey:'one',amountCny:NaN}),{code:'campaign_budget_unknown'});
  await assert.rejects(ledger.reserve({campaignId:'invalid',stageKey:'one',amountCny:-1}),{code:'campaign_budget_unknown'});
 }finally{await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);await database.close();}
});
test('existing holds lose spending authority after overrun or tightened limits; limits never coerce', {skip:!url&&'Disposable localhost PostgreSQL required'},async()=>{
 const database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});const owner=`rsi_${randomUUID().replaceAll('-','')}`;
 try{
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI dispatch fuse','development')",[owner]);
  const configuration=boundLab(owner);configuration.budget.monthCny=1000;
  const ledger=new RsiCampaignBudget({database,configuration,now:()=> '2026-10-26T01:00:00Z'});
  for(const value of ['1000',true,Infinity,0.000000001])await assert.rejects(ledger.reserve({campaignId:'bad',stageKey:'bad',amountCny:1,limits:{campaignCny:value,monthCny:1000}}),{code:'campaign_budget_unknown'});
  await ledger.reserve({campaignId:'a',stageKey:'first',amountCny:800});await ledger.reserve({campaignId:'b',stageKey:'hold',amountCny:200});
  await ledger.beginSpend({campaignId:'a',stageKey:'first'});await ledger.settle({campaignId:'a',stageKey:'first',actualCny:1100,outcome:'failed'});
  assert.equal((await ledger.beginSpend({campaignId:'b',stageKey:'hold'})).reason,'campaign_month_budget_exceeded');
  assert.equal((await ledger.reserve({campaignId:'b',stageKey:'hold',amountCny:200})).authorized,false);
  const november=new RsiCampaignBudget({database,configuration,now:()=> '2026-11-01T01:00:00Z'});
  await november.reserve({campaignId:'c',stageKey:'first',amountCny:800});await november.reserve({campaignId:'c',stageKey:'hold',amountCny:200});
  await november.beginSpend({campaignId:'c',stageKey:'first'});await november.settle({campaignId:'c',stageKey:'first',actualCny:1100,outcome:'failed'});
  assert.equal((await november.beginSpend({campaignId:'c',stageKey:'hold'})).reason,'campaign_budget_exceeded');
  const december=new RsiCampaignBudget({database,configuration,now:()=> '2026-12-01T01:00:00Z'});
  await december.reserve({campaignId:'d',stageKey:'hold',amountCny:800});
  await december.reserve({campaignId:'d',stageKey:'lower',amountCny:50,limits:{campaignCny:900,monthCny:1000}});
  assert.equal((await december.reserve({campaignId:'d',stageKey:'raise',amountCny:100,limits:{campaignCny:1000,monthCny:1000}})).reason,'campaign_budget_exceeded');
  const tightened=structuredClone(configuration);tightened.budget.campaignCny=500;
  const tighter=new RsiCampaignBudget({database,configuration:tightened,now:()=> '2026-12-01T01:00:00Z'});
  assert.equal((await tighter.beginSpend({campaignId:'d',stageKey:'hold'})).reason,'campaign_budget_exceeded');

 }finally{await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);await database.close();}
});
