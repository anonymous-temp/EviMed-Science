import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createForecastProviders } from '../src/vcrForecastProvider.mjs';

const endpoint = {code:'HbA1c',type:'continuous',unit:'%'};
const permission = {schema:1,status:'approved',dataClass:'synthetic',purpose:'vcr',destinations:['https://forecast.example.org']};
async function fixture(t,fetchImpl,extra={}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-provider-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'providers.json');
  const provider = {id:'test',url:'https://forecast.example.org/predict',protocol:'evimed-event-history-v1',enabled:true,
    model:'synthetic',version:'1',batchSize:1,inputCodes:['HbA1c'],...extra};
  await fs.writeFile(file,JSON.stringify({providers:[provider]}));
  return {file,provider,api:createForecastProviders({file,fetchImpl})};
}
const input = () => ({providerId:'test',jobId:'job_1',history:{asOf:'2026-01-01T00:00:00.000Z',events:['a','b'].map(subjectKey =>
  ({subjectKey,code:'HbA1c',value:7,unit:'%',occurredAt:'2025-12-01T00:00:00.000Z',availableAt:'2025-12-02T00:00:00.000Z',
    originalValue:'CANARY',source:{quote:'CANARY-PHI'}}))},endpoint,horizonsDays:[30],seed:4,permissions:async()=>[permission],onBatch:async()=>{},isCanceled:async()=>false});
function answer(body,version='1') {return new Response(JSON.stringify({schema:1,origin:body.origin,endpoint:body.endpoint,model:'synthetic',version,
  rows:body.events.map(e => ({subjectKey:e.subjectKey,horizonDays:30,point:6.9}))}),{headers:{'content-type':'application/json'}});}

test('batch projection excludes source prose, preserves actual model provenance and completed batches on failure',async t => {
  const sent=[],batches=[];
  const {api} = await fixture(t,async(_url,options)=>{
    const body=JSON.parse(options.body);sent.push(body);
    return sent.length===1 ? answer(body) : new Response('',{status:503});
  });
  const result=await api.predict({...input(),onBatch:async batch=>{batches.push(batch);}});
  assert.equal(result.rows.length,1);assert.equal(result.failures[0].code,'provider_http_503');
  assert.equal(result.receipts[0].actualVersion,'1');assert.equal(result.receipts[0].seedSupported,false);
  assert.equal(result.receipts[0].cost,null);
  assert.ok(!JSON.stringify(sent).includes('CANARY'));
  assert.equal(batches.at(-1).rows.length,1);
});

test('revocation stops the next external request, while the first batch is already persisted',async t=>{
  let calls=0,saved=0;
  const {api}=await fixture(t,async(_url,options)=>{calls++;return answer(JSON.parse(options.body));});
  await assert.rejects(()=>api.predict({...input(),permissions:async()=>[calls ? {...permission,status:'revoked'} : permission],onBatch:async()=>{saved++;}}),{code:'vcr_cloud_processing_not_authorized'});
  assert.equal(calls,1);assert.equal(saved,1);
});

test('unknown transport outcomes are never automatically charged twice without idempotency support',async t=>{
  let calls=0;
  const {api}=await fixture(t,async()=>{calls++;throw new Error('Must not call');});
  const result=await api.predict({...input(),beginBatch:async()=>({pending:true})});
  assert.equal(calls,0);assert.equal(result.failures.length,2);
  assert.ok(result.failures.every(r=>r.code==='provider_outcome_unknown_no_replay'));
});

test('cancel interrupts an in-flight request; version rollback never mixes batches silently',async t=>{
  let canceled=false;
  const {api}=await fixture(t,async(_url,options)=>new Promise((_resolve,reject)=>{
    canceled=true;options.signal.addEventListener('abort',()=>reject(new Error('Aborted')));
  }));
  const result=await api.predict({...input(),isCanceled:async()=>canceled});
  assert.equal(result.rows.length,0);assert.equal(result.failures[0].code,'canceled');
});

test('provider-reported version and endpoint changes are recorded as local batch failures',async t=>{
  const {api}=await fixture(t,async(_url,options)=>answer(JSON.parse(options.body),'2'));
  const result=await api.predict(input());
  assert.equal(result.rows.length,0);assert.equal(result.failures[0].code,'provider_version_mismatch');
});

test('a completed batch is replayed from its receipt without another provider charge',async t=>{
  let calls=0;
  const {api}=await fixture(t,async()=>{calls++;throw new Error('No network on replay');});
  const result=await api.predict({...input(),beginBatch:async({body})=>({response:await answer(body).json(),receipt:{cost:.01,costCurrency:'CNY',actualVersion:'1'}})});
  assert.equal(result.rows.length,2);assert.equal(calls,0);assert.equal(result.receipts.length,2);
});

test('changing the provider configuration stops new batches and preserves completed results',async t=>{
  let calls=0;
  const held=await fixture(t,async(_url,options)=>{calls++;return answer(JSON.parse(options.body));});
  const result=await held.api.predict({...input(),onBatch:async()=>{await fs.writeFile(held.file,JSON.stringify({providers:[{...held.provider,version:'rolled-back'}]}));}});
  assert.equal(calls,1);assert.equal(result.rows.length,1);assert.equal(result.failures[0].code,'provider_configuration_changed');
});

test('malformed peers keep valid rows, the original exchange, cost and a replayable sanitized receipt',async t=>{
  let persisted,batch,calls=0;
  const {api}=await fixture(t,async(_url,options)=>{
    calls++;const body=JSON.parse(options.body),reply=await answer(body).json();
    return Response.json({...reply,cost:.02,costCurrency:'CNY',rows:[...reply.rows,{subjectKey:'outside',horizonDays:30,point:7},null]});
  },{batchSize:100});
  const result=await api.predict({...input(),finishBatch:async value=>{persisted=value;},onBatch:async value=>{batch=value;}});
  assert.equal(result.rows.length,2);assert.equal(result.receipts[0].invalidRows,2);assert.equal(result.receipts[0].cost,.02);
  assert.equal(batch.rawResponse.rows.length,4);assert.equal(persisted.response.rows.length,2);
  const replay=await api.predict({...input(),beginBatch:async()=>persisted});
  assert.equal(replay.rows.length,2);assert.equal(replay.failures[0].code,'provider_rows_invalid');assert.equal(calls,1);
});
