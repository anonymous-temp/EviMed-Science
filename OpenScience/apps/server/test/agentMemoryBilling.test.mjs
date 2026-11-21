import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createMemoryBilling, memoryModelAttribution, memoryPayer, withMemoryPayer } from '../src/agentMemoryBilling.mjs';

const wire = JSON.parse(await readFile(new URL('../../../packages/contracts/openviking/fixtures/memory/session-read-after-commit.json', import.meta.url)));
const payer = {ownerId:'u', keyId:'k', projectId:'default', model:'deepseek-v4-flash', generation:'stamp', operation:'POST /remember', chargeWallet:true};

test('the recorded native wire allocates actual tokens to the initiating key with stable settlement identities', async () => {
  const rows = [];
  const service = createMemoryBilling({config:{},ledger:{recordSettled:async row=>rows.push(row)},wallet:()=>null,store:{}});
  const commit = {engineSession:wire.response.result.session_id, archiveUri:'owned-archive'};
  const args = {userId:'u', commit, sessions:{readSession:async()=>wire.response}, createdAt:wire.response.result.created_at};
  await service.extraction(payer,args); await service.extraction(payer,args);
  assert.deepEqual(rows[0],rows[2]); assert.deepEqual(rows[1],rows[3]);
  assert.equal(rows[0].taskId,'k'); assert.equal(rows[0].userId,'u'); assert.match(rows[0].runId,/^amc_/);
  assert.deepEqual(rows[0].usage,{cacheHitTokens:768,cacheMissTokens:27220,completionTokens:142});
  assert.equal(rows[1].usage.cacheMissTokens,77);
  await assert.rejects(service.extraction(payer,{...args,commit:{...commit,engineSession:'other'}}),{code:'agent_memory_usage_pending'});
});

test('only measured search counts settle, and a budget or balance refusal stops the model', async () => {
  const events = [];
  const charge = {assertBalanceForStart:async()=>({allowed:true})};
  const deps = {config:{},store:{userById:async()=>({id:'u',accountCreatedAt:'stamp'}),requireProject:async()=>({})},
    ledger:{assertWithinLimits:async()=>{},reserveModel:async row=>events.push(row),settleModel:async(...args)=>events.push(args),
      markUncertain:async(...args)=>events.push(args)},wallet:()=>charge};
  const service = createMemoryBilling(deps);
  await service.search(payer,'private',async()=>({usage:{tokens:{embedding:{total:4}}}}));
  assert.equal(events[0].taskId,'k'); assert.equal(events[1][2].usage.cacheMissTokens,4);
  await service.search(payer,'private',async()=>({}));
  assert.equal(events[3][2],'response_usage_missing'); assert.doesNotMatch(JSON.stringify(events),/private/);
  charge.assertBalanceForStart = async()=>{ throw Object.assign(new Error(),{status:402}); };
  await assert.rejects(service.search(payer,'text',async()=>assert.fail()),{status:402});
  deps.ledger.assertWithinLimits=async()=>{ throw Object.assign(new Error(),{code:'usage_budget_exceeded'}); };
  await assert.rejects(service.admit(payer),{code:'usage_budget_exceeded'});
});

test('two concurrent clients never inherit one another’s payer', async () => {
  const ids = await Promise.all(['keyA','keyB'].map(keyId=>withMemoryPayer({payer:{...payer,keyId}}, async()=>{
    await Promise.resolve(); return memoryModelAttribution(memoryPayer().payer).taskId;
  })));
  assert.deepEqual(ids,['keyA','keyB']); assert.equal(memoryPayer(),null);
});

test('native extraction reserves once before dispatch and settles that reservation from the engine receipt', async () => {
  const calls = [];
  let reserved = null;
  const ledger = {
    assertWithinLimits:async()=>{},
    memoryReservation:async()=>reserved,
    reserveModel:async row=>{ calls.push(row); reserved = {created_at:row.now}; },
    settleModel:async (...args)=>calls.push(args),
    recordSettled:async row=>calls.push(row),
  };
  const meter = createMemoryBilling({config:{userDailySpendLimit:2}, ledger,
    wallet:()=>({assertBalanceForStart:async()=>({allowed:true})}),
    store:{userById:async()=>({id:'u',accountCreatedAt:'stamp'}),requireProject:async()=>({})}});
  const admission = {engineSession:wire.response.result.session_id,text:'A captured transcript'};
  await meter.reserveExtraction(payer,admission);
  await meter.reserveExtraction(payer,admission);
  assert.equal(calls.length,1); assert.equal(calls[0].dailyLimit,2);
  assert.ok(calls[0].estimatedCost > 0); assert.doesNotMatch(JSON.stringify(calls),/captured transcript/);
  await meter.extraction(payer,{userId:'u',sessions:{readSession:async()=>wire.response}, commit:{...admission,archiveUri:'archive'},createdAt:new Date(),engineSession:admission.engineSession});
  assert.equal(calls[1][1],calls[0].id);
  assert.equal(calls[1][2].usage.cacheHitTokens,768);
  assert.equal(calls[2].taskId,payer.keyId);
});
