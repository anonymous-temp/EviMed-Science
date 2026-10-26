import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
test('serving worker claims only events and completes feedback continuation',async()=>{
 const calls=[]; const row={id:'event',payload:{type:'researcher-feedback',status:'pending'}};
 const service={owner:async()=>'u',get:async()=>row,save:async(...args)=>calls.push(['save',...args]),resolveWaiters:async()=>calls.push(['wake']),jobs:{claim:async kinds=>{assert.deepEqual(kinds,['evolution-event','evolution-decision']);return {id:'job',userId:'u',leaseToken:'lease',payload:{eventId:'event'}}},finish:async()=>calls.push(['finish']),fail:async()=>assert.fail('unexpected failure'),renew:async()=>true}};
 const worker=createEvolutionServingWorker({service,config:{evolutionEnabled:true},integration:{consume:async()=>calls.push(['consume'])}});
 await worker.tick(); assert.deepEqual(calls.map(c=>c[0]),['consume','wake','save','finish']);assert.equal(worker.status().experimentScheduling,false);await worker.close();
});
test('experimental events retain durable explicit deferral',async()=>{
 let saved,failed; const row={id:'event',payload:{type:'frontier-publication',status:'pending'}};
 const service={owner:async()=>'u',get:async()=>row,save:async(_kind,_id,payload)=>{saved=payload},jobs:{claim:async()=>({id:'job',userId:'u',leaseToken:'lease',payload:{eventId:'event'}}),fail:async(...args)=>{failed=args},renew:async()=>true}};
 const worker=createEvolutionServingWorker({service,config:{evolutionEnabled:true},integration:{consume:async()=>assert.fail('experiment consumed')}});await worker.tick();assert.equal(saved.status,'deferred');assert.equal(saved.deferredReason,'evolution_offline_only');assert.equal(failed[3].code,'evolution_offline_only');await worker.close();
});
test('maintenance prevents a claim and the serving owner fences the SQL queue',async()=>{
 let permitted=false,claims=0;
 const service={owner:async()=>'publisher',jobs:{claim:async(_kinds,_worker,options)=>{claims++;assert.equal(options.ownerId,'publisher');assert.equal(await options.admission({}),permitted);return null;}}};
 const worker=createEvolutionServingWorker({service,integration:{},config:{evolutionEnabled:true},canRun:async()=>permitted});
 await worker.tick();assert.equal(claims,0);
 permitted=true;await worker.tick();assert.equal(claims,1);await worker.close();
});
