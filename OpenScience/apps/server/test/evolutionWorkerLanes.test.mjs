import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';
test('one heavy lane and two light lanes work independently while a heavy budget wait refunds its claim',async()=>{
 const pending=[{id:'heavy',kind:'evolution-build'},{id:'light-a',kind:'evolution-mission'},{id:'light-b',kind:'evolution-mission'}];
 const started=[],finished=[],failed=[];let releaseHeavy;
 const hold=new Promise(resolve=>{releaseHeavy=resolve;});
 const service={list:async()=>[],jobs:{claim:async kinds=>{const index=pending.findIndex(job=>kinds.includes(job.kind));if(index<0)return null;return {...pending.splice(index,1)[0],userId:'operator',payload:{},leaseToken:'lease'};},renew:async()=>true,finish:async(u,id,t,result)=>{finished.push(id);return result;},fail:async(u,id,t,error,options)=>{failed.push({id,error,options});return{status:'queued'};}}};
 const worker=new EvolutionWorker({service,config:{evolutionEnabled:true,evolutionLightConcurrency:2},callbacks:{build:async()=>{started.push('heavy');await hold;throw Object.assign(Error('unpaid budget'),{code:'usage_budget_exceeded',status:402,details:{window:'day'}});},mission:async()=>{started.push('light');return{status:'waiting_resource'};}}});
 worker.housekeeping=async()=>{};
 const ticking=worker.tick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(started.sort(),['heavy','light','light']);assert.deepEqual(finished.sort(),['light-a','light-b']);
 assert.equal(worker.lanes.length,3);assert.equal(worker.lanes.filter(lane=>lane.lane==='heavy').length,1);
 releaseHeavy();await ticking;
 assert.equal(failed.length,1);assert.equal(failed[0].id,'heavy');assert.equal(failed[0].options.refundAttempt,true);assert.equal(failed[0].options.retry,true);
});

test('a light lane claims its next job on the next tick while the heavy lane is still running its job',{timeout:10_000},async()=>{
 const pending=[{id:'heavy',kind:'evolution-build'},{id:'light-a',kind:'evolution-mission'}];
 const finished=[];let releaseHeavy;
 const hold=new Promise(resolve=>{releaseHeavy=resolve;});
 const service={list:async()=>[],jobs:{claim:async kinds=>{const index=pending.findIndex(job=>kinds.includes(job.kind));if(index<0)return null;return {...pending.splice(index,1)[0],userId:'operator',payload:{},leaseToken:'lease'};},renew:async()=>true,finish:async(u,id,t,result)=>{finished.push(id);return result;},fail:async()=>({status:'queued'})}};
 const worker=new EvolutionWorker({service,config:{evolutionEnabled:true,evolutionLightConcurrency:2},callbacks:{build:async()=>{await hold;return {status:'waiting_resource'};},mission:async()=>({status:'waiting_resource'})}});
 worker.housekeeping=async()=>{};
 const first=worker.tick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(finished,['light-a']);
 // A mission arrives while the heavy job still holds its lane; the next tick must not wait for that job.
 pending.push({id:'light-b',kind:'evolution-mission'});
 const second=worker.tick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(finished,['light-a','light-b'],'the light lane was held by the heavy job');
 releaseHeavy();await Promise.all([first,second]);
 assert.deepEqual(finished.sort(),['heavy','light-a','light-b']);
 await worker.close();
});
