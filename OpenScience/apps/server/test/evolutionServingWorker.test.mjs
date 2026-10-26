import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
import { HttpError } from '../src/security.mjs';

const quiet = { error() {} };
/** A stub service with the housekeeping reads a serving worker makes. @param {Record<string, any>} patch */
const stub = (patch = {}) => ({ owner: async () => 'u', now: () => new Date('2026-10-04T00:00:00Z'), tools: async () => [], list: async () => [], get: async () => null,
  enqueue: async () => ({}), ...patch });
test('serving worker claims only serving work and completes feedback continuation',async()=>{
 const calls=[]; const row={id:'event',payload:{type:'researcher-feedback',status:'pending'}};
 const service=stub({get:async(id)=>id==='event'?row:null,save:async(...args)=>calls.push(['save',...args]),resolveWaiters:async()=>calls.push(['wake']),jobs:{claim:async kinds=>{assert.deepEqual(kinds,['evolution-event','evolution-decision','evolution-digest','evolution-maintain']);return {id:'job',kind:'evolution-event',userId:'u',leaseToken:'lease',payload:{eventId:'event'}}},finish:async()=>calls.push(['finish']),fail:async()=>assert.fail('unexpected failure'),renew:async()=>true}});
 const worker=createEvolutionServingWorker({service,config:{evolutionEnabled:true},logger:quiet,integration:{consume:async()=>calls.push(['consume'])}});
 await worker.tick(); assert.deepEqual(calls.map(c=>c[0]),['consume','wake','save','finish']);assert.equal(worker.status().experimentScheduling,false);await worker.close();
});
test('an experiment\'s event is closed once as retired to the lab, kept whole, and its job finishes',async()=>{
 let saved,finished; const row={id:'event',payload:{type:'frontier-publication',status:'queued',paper:'kept'}};
 const service=stub({get:async(id)=>id==='event'?row:null,save:async(_kind,_id,payload)=>{saved=payload},jobs:{claim:async()=>({id:'job',kind:'evolution-event',userId:'u',leaseToken:'lease',payload:{eventId:'event'}}),finish:async(...args)=>{finished=args},fail:async()=>assert.fail('a closed event is no failure'),renew:async()=>true}});
 const worker=createEvolutionServingWorker({service,config:{evolutionEnabled:true},logger:quiet,integration:{consume:async()=>assert.fail('experiment consumed')}});await worker.tick();
 assert.deepEqual([saved.status,saved.closedReason,saved.paper],['closed','retired-to-lab','kept']);assert.deepEqual(finished[3],{eventId:'event',status:'closed',closedReason:'retired-to-lab'});
 assert.equal(worker.counters.closed,1);await worker.close();
});
test('failures follow main\'s classification: a request a retry cannot change fails at once, others retry until the attempts are spent',async()=>{
 const failures=[];
 /** @param {any} error @param {number} attempts */
 const run=async(error,attempts)=>{
  const service=stub({get:async()=>({id:'event',payload:{type:'researcher-feedback',status:'queued'}}),jobs:{claim:async()=>({id:'job',kind:'evolution-event',userId:'u',leaseToken:'lease',attempts,maxAttempts:3,payload:{eventId:'event'}}),
   fail:async(...args)=>{failures.push(args)},finish:async()=>assert.fail('unexpected completion'),renew:async()=>true}});
  const worker=createEvolutionServingWorker({service,config:{evolutionEnabled:true,evolutionMaxJobAttempts:3,evolutionRetryMs:60000},logger:quiet,integration:{consume:async()=>{throw error;}}});
  await worker.tick();await worker.close();return failures.at(-1);
 };
 for(const status of [400,401,403,404,422]){const [, , , detail, options]=await run(new HttpError(status,'evolution_feedback_invalid','refused'),1);assert.deepEqual([detail.code,options.retry],['evolution_feedback_invalid',false],String(status));}
 let [, , , detail, options]=await run(Object.assign(new Error('blip'),{code:'ECONNRESET'}),1);
 assert.deepEqual([detail.code,options.retry,options.refundAttempt,options.delayMs],['evolution_serving_failed',true,undefined,60000],'an attempt is spent: no minute-by-minute retry for ever');
 [, , , detail, options]=await run(new Error('poison'),3);
 assert.equal(options.retry,false,'the attempts are capped');
});
test('maintenance prevents a claim and the serving owner fences the SQL queue',async()=>{
 let permitted=false,claims=0;
 const service=stub({owner:async()=>'publisher',jobs:{claim:async(_kinds,_worker,options)=>{claims++;assert.equal(options.ownerId,'publisher');assert.equal(await options.admission({}),permitted);return null;}}});
 const worker=createEvolutionServingWorker({service,integration:{},config:{evolutionEnabled:true},logger:quiet,canRun:async()=>permitted});
 await worker.tick();assert.equal(claims,0);
 permitted=true;await worker.tick();assert.equal(claims,1);await worker.close();
});
test('a self-check is claimed after the light work, under its own concurrency admission',async()=>{
 const claimed=[];let admitted;
 const client={query:async(text)=>/count/.test(text)?{rows:[{count:1}]}:{rows:[]}};
 const service=stub({jobs:{claim:async(kinds,_worker,options)=>{claimed.push(kinds);if(kinds.includes('evolution-self-check'))admitted=await options.admission(client);return null;}}});
 const worker=createEvolutionServingWorker({service,integration:{},selfCheck:{run:async()=>null},config:{evolutionEnabled:true,evolutionMaxConcurrency:1},logger:quiet});
 await worker.tick();
 assert.deepEqual(claimed,[['evolution-event','evolution-decision','evolution-digest','evolution-maintain'],['evolution-self-check']]);
 assert.equal(admitted,false,'one self-check already holds the isolated executor');await worker.close();
});
