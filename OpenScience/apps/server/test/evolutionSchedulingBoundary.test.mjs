import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvolutionServingWorker} from '../src/evolutionServingWorker.mjs';

// The clock of serving's housekeeping is two clocks: a local day (Shanghai) keys what is done per day, a UTC month keys the metrics of the month just completed.
// The four instants straddle a Shanghai month and a Shanghai year boundary while the UTC date has not moved yet.
test('housekeeping keys the day in Shanghai and the metrics month in UTC across month and year boundaries',async()=>{
 for(const [instant,metricsMonth,localDay,digestDue] of [
  ['2026-09-30T16:30:00Z','2026-08','2026-10-01',false],
  ['2026-10-01T00:30:00Z','2026-09','2026-10-01',true],
  ['2026-12-31T16:30:00Z','2026-11','2027-01-01',false],
  ['2027-01-01T00:30:00Z','2026-12','2027-01-01',true],
 ]){
  const jobs=[];
  const service={now:()=>new Date(instant),owner:async()=>'operator',tools:async()=>[{id:'leaving',payload:{status:'retired',retirement:{state:'pending'}}}],list:async()=>[],get:async()=>null,
   enqueue:async(kind,payload,key)=>jobs.push({kind,payload,key}),jobs:{claim:async()=>null}};
  const worker=createEvolutionServingWorker({service,integration:{},config:{evolutionEnabled:true},logger:{error(){}}});
  await worker.tick();await worker.close();
  assert.deepEqual(jobs.find(row=>row.key.startsWith('serving-metrics:')),{kind:'maintain',payload:{metricsMonth,metricsOnly:true},key:`serving-metrics:${metricsMonth}`},instant);
  assert.ok(jobs.some(row=>row.key===`retirement:leaving:${localDay}`),`${instant}: per-day work keeps the Shanghai day`);
  // The digest waits for the configured local time (08:00 by default), so the 00:30 Shanghai instants have none yet.
  assert.equal(jobs.some(row=>row.key===`daily-digest:${localDay}`),digestDue,`${instant}: the digest is queued from 08:00 local`);
  assert.equal(jobs.some(row=>/scout|build|evaluate|mission|monthly-v2/.test(row.key)),false,`${instant}: housekeeping queues no experiment`);
 }
});
