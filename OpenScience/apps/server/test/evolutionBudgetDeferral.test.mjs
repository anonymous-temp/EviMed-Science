import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionWorker } from '../src/evolutionWorker.mjs';
import { HttpError } from '../src/security.mjs';
async function execute(error) {
 const recorded=[],waits=[];const checkpoint={completedSourceHash:'original',finishedStages:['extraction']};
 const job={id:'job',userId:'operator',kind:'evolution-evaluate',payload:{checkpoint},leaseToken:'lease',attempts:3,maxAttempts:10};
 const service={jobs:{claim:async()=>job,renew:async()=>true,fail:async(...args)=>{recorded.push(args);return{status:args[4].retry?'queued':'failed'};}}};
 const worker=new EvolutionWorker({service,config:{evolutionEnabled:true,evolutionMaxJobAttempts:3},callbacks:{evaluate:async payload=>{assert.deepEqual(payload.checkpoint,checkpoint);throw error;}}});
 worker.housekeeping=async()=>{};worker.resourceWait=async(...args)=>{waits.push(args);};
 const result=await worker.tick({kinds:['evolution-evaluate']});
 return{result,recorded,waits,checkpoint};
}
test('daily reservation refusal defers the same checkpoint and refunds only its claim even at the ordinary retry ceiling',async()=>{
 const f=await execute(new HttpError(402,'usage_budget_exceeded','Private amount details',{window:'day',committed:49.95,requested:0.10}));
 assert.equal(f.result.status,'queued');assert.equal(f.waits.length,0);
 assert.deepEqual(f.recorded[0].slice(0,3),['operator','job','lease']);
 assert.deepEqual(f.recorded[0][4],{retry:true,refundAttempt:true,delayMs:3600000});
 assert.deepEqual(f.recorded[0][3],{code:'usage_budget_exceeded',message:'Evolution work waits for available rolling daily budget.'});
 assert.deepEqual(f.checkpoint,{completedSourceHash:'original',finishedStages:['extraction']});
});
test('run cap, unknown window, failed DSH run and unrelated failures retain bounded failure handling',async()=>{
 for(const error of [new HttpError(402,'usage_budget_exceeded','Run cap',{window:'run'}),new HttpError(402,'usage_budget_exceeded','No window'),new HttpError(402,'usage_budget_exceeded','Week cap',{window:'week'}),new HttpError(409,'usage_budget_exceeded','The development run did not complete.',{window:'day'}),new HttpError(402,'model_gateway_upstream_error','Provider unavailable',{window:'day'}),new Error('Unknown')]){
  const f=await execute(error);assert.equal(f.result.status,'failed');assert.equal(f.waits.length,1);assert.equal(f.recorded[0][4].retry,false);assert.equal(f.recorded[0][4].refundAttempt,undefined);
 }
});
