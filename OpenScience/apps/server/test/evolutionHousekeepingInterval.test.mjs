import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';

// The worker polls every 15 s and its housekeeping is idempotent: every enqueue has a fixed key and every write reads first. Correct, and a
// standing load of dozens of reads and writes a poll that grows with the number of documents it lists (review D-E24). Each block now runs
// when it is first due, when what it keys on changes, and no more often than its interval.
const harness=(config={})=>{
 let time=new Date('2026-10-06T04:00:00Z');const calls=[];
 const service={config:{},callbacks:{scanLeadSources:async()=>{},compactRecords:async()=>{calls.push('compact');}},now:()=>time,owner:async()=>'operator',
  reconcileQueued:async()=>{calls.push('reconcile');},tools:async()=>{calls.push('tools');return[];},
  list:async type=>{calls.push(`list:${type}`);return[];},get:async()=>null,save:async()=>{calls.push('save');},
  enqueue:async(kind,payload,key)=>{calls.push(`enqueue:${key}`);},ingestEvent:async event=>{calls.push(`event:${event.id}`);},
  notifications:{preferences:async()=>{calls.push('preferences');return{digestTime:'08:00'};}}};
 const worker=new EvolutionWorker({service,config:{releaseId:'release-1',sourceRevision:'a'.repeat(40),...config}});
 const poll=async()=>{calls.length=0;await worker.housekeeping();return[...calls];};
 return{worker,poll,advance:ms=>{time=new Date(time.getTime()+ms);},set:instant=>{time=new Date(instant);},config:worker.config};
};
test('a second poll inside the interval repeats nothing, and the first pass is whole',async()=>{
 const {poll,advance}=harness();
 const first=await poll();
 for(const expected of ['reconcile','tools','list:maintenance-review','preferences','enqueue:release-replay:release-1:'+'a'.repeat(40),'enqueue:daily-digest:2026-10-06','enqueue:daily-scout:2026-10-06',
  'event:handbook-scan:2026-10-06','event:source-facts:2026-10-06','event:prospective-targets:2026-10-06','event:lead-sources:2026-10-06','enqueue:monthly-v2:2026-10','list:evaluation',
  'enqueue:platform-plan:2026-10-05:2026-10-06','enqueue:self-research:2026-10-05','enqueue:meta-loop:2026-10','enqueue:heldout-audit:2026-09','compact'])assert.ok(first.includes(expected),`the first pass lacks ${expected}`);
 advance(15_000);
 assert.deepEqual(await poll(),[],'the next poll, fifteen seconds on');
});
test('the frequent blocks come back each minute and the daily ones with the day',async()=>{
 const {poll,advance,set}=harness();
 await poll();
 advance(61_000);
 const minute=await poll();
 assert.deepEqual(minute,['reconcile','tools','list:maintenance-review','preferences','list:mission'],'only what must notice a change quickly; the digest was queued for today');
 advance(24*3600_000);
 const day=await poll();
 for(const expected of ['enqueue:daily-digest:2026-10-07','enqueue:daily-scout:2026-10-07','event:handbook-scan:2026-10-07','event:lead-sources:2026-10-07','enqueue:platform-plan:2026-10-05:2026-10-07','compact'])assert.ok(day.includes(expected),`the next day lacks ${expected}`);
 assert.ok(!minute.includes('compact'),'the fold is a daily block: it is not among those that come back each minute');
 assert.ok(day.includes('enqueue:monthly-v2:2026-10'),'the monthly block is refreshed with the day');
 set('2026-10-31T10:00:00Z');await poll();
 set('2026-10-31T16:30:00Z');
 assert.deepEqual((await poll()).filter(call=>call.startsWith('enqueue:monthly')),[],'inside the day, in the same month');
 set('2026-11-01T00:30:00Z');
 assert.ok((await poll()).includes('enqueue:monthly-v2:2026-11'),'a new month is not left waiting for the next daily pass');
});
test('lifting the pause is noticed at once: a paused poll is not a poll that was done',async()=>{
 const {poll,advance,config}=harness({evolutionSearchPaused:true});
 const paused=await poll();
 assert.ok(!paused.includes('enqueue:daily-scout:2026-10-06')&&!paused.some(call=>call.startsWith('enqueue:platform-plan')),'research is paused');
 config.evolutionSearchPaused=false;advance(15_000);
 const resumed=await poll();
 assert.ok(resumed.includes('enqueue:daily-scout:2026-10-06')&&resumed.includes('enqueue:platform-plan:2026-10-05:2026-10-06')&&resumed.includes('enqueue:meta-loop:2026-10'),'what the pause held back is queued on the next poll');
 assert.ok(resumed.includes('list:mission'),'and so are the missions it stopped');
});
test('a block that failed is not marked done: the next poll tries it again',async()=>{
 const {worker,poll,advance}=harness();
 let fail=true;worker.service.tools=async()=>{if(fail)throw new Error('database down');return[];};
 await assert.rejects(poll(),/database down/);
 fail=false;advance(15_000);
 assert.ok((await poll()).includes('enqueue:daily-digest:2026-10-06'),'the pass that failed did not count');
});
