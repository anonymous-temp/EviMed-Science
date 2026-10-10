import assert from 'node:assert/strict';
import test from 'node:test';
import { runForecastCalculation } from '../src/vcrForecastCalculation.mjs';

test('statistical work is cancellable without occupying the API event loop',async()=>{
  const origin = '2026-01-01T00:00:00.000Z';
  const rows = Array.from({length:15_000},(_,i)=>({subjectKey:String(i),horizonDays:30,point:i%100}));
  const prediction = {origin,endpoint:{code:'x',unit:'u',type:'continuous'},horizonsDays:[30],rows};
  const history = {asOf:origin,events:[],dataClass:'synthetic'};
  const outcomes = {dataClass:'synthetic',events:rows.map(r=>({...r,code:'x',unit:'u',value:r.point+1,valueSource:'synthetic',occurredAt:'2026-01-31T00:00:00.000Z'}))};
  let checks = 0, heartbeats = 0;
  const timer = setInterval(()=>{heartbeats++;},10);
  try {
    await assert.rejects(()=>runForecastCalculation('forecast.evaluate',[prediction,history,outcomes,{bootstrap:500}],{
      timeoutMs:3000,isCanceled:async()=>++checks>1}),{code:'vcr_forecast_unavailable'});
    assert.ok(heartbeats>=2,'HTTP process remains responsive while statistics run');
  } finally {clearInterval(timer);}
});

test('a finite wall deadline terminates the calculation and leaves its caller usable',async()=>{
  await assert.rejects(()=>runForecastCalculation('forecast.trial_benchmark',[{comparisons:[]}],{timeoutMs:1}),{code:'vcr_forecast_unavailable'});
  const result = await runForecastCalculation('forecast.trial_benchmark',[{comparisons:[]}]);
  assert.equal(result.comparisons,0);
});
