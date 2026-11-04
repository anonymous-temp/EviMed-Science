import assert from 'node:assert/strict';
import test from 'node:test';
import { startMeteredVcrLanguageCall } from '../src/vcrLanguageModel.mjs';

const input=()=>({unit:{userId:'u1',model:'deepseek-flash',thinking:'disabled',outputLimit:1000,criterionKey:'k',axis:'requirement',documents:[{id:'d1'}]},
  jobId:'job1',projectId:'p1',runLimit:2,criteria:[{kind:'inclusion',sourceText:'Whole criterion',requirement:{op:'language',text:'Whole criterion'}}],documents:[{documentId:'d1',text:'synthetic chart'}]});
const config={deepseekBaseUrl:'https://api.deepseek.com',deepseekApiKey:'fixture-secret',production:true};
test('metered call reserves before handoff and settles only after response',async()=>{
  const events=[];let finish,reply;
  const transport=()=>({handoff:new Promise(resolve=>{finish=resolve;}),response:new Promise(resolve=>{reply=resolve;})});
  const ledger={reserveModel:async()=>{events.push('reserve');return{id:'r1'};},settleModel:async()=>events.push('settle')};
  const call=startMeteredVcrLanguageCall({config,usageLedger:ledger,transport},input());
  for(let i=0;!finish&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.deepEqual(events,['reserve']);finish();await call.handoff;assert.deepEqual(events,['reserve']);
  reply({status:200,body:Buffer.from(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:2}}))});
  await call.result;assert.deepEqual(events,['reserve','settle']);
});
test('budget refusal and invalid scope never start transport',async()=>{
  let calls=0;
  const transport=()=>{calls++;throw new Error('must not send');};
  const ledger={reserveModel:async()=>{throw Object.assign(new Error('budget'),{code:'usage_budget_exceeded'});}};
  const call=startMeteredVcrLanguageCall({config,usageLedger:ledger,transport},input());
  await assert.rejects(call.handoff,/budget/);await assert.rejects(call.result,/budget/);assert.equal(calls,0);
  assert.throws(()=>startMeteredVcrLanguageCall({config,usageLedger:ledger,transport},{...input(),runLimit:0}));
});
test('handoff deadline fails closed while reservation is stalled and never starts transport',async()=>{
  let release,calls=0;
  const held=new Promise(resolve=>{release=resolve;});
  const ledger={reserveModel:async()=>{await held;return{id:'r1'};},release:async()=>{}};
  const call=startMeteredVcrLanguageCall({config,usageLedger:ledger,transport:()=>{calls++;throw new Error('must not send');},handoffTimeoutMs:10},input());
  await assert.rejects(call.handoff,/timed out/);release();await assert.rejects(call.result);assert.equal(calls,0);
});
