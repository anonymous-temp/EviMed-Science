import test from 'node:test';
import assert from 'node:assert/strict';
import {cancelAndConfirmTerminal,collectIndependentCells} from '../protocol.mjs';
for(const status of ['queued','starting',undefined,'unknown'])test(`unconfirmed ${status} stops subsequent cells`,async()=>{
 let time=0,cells=0;
 const api={call:async(method)=>method==='POST'?{status:200,json:{data:{}}}:{status:200,json:{data:status===undefined?[]:[{id:'r',status}]}}};
 await assert.rejects(collectIndependentCells([1,2],async()=>{cells++;await cancelAndConfirmTerminal(api,{id:'r',status:'starting'},{timeoutMs:10,now:()=>time,sleep:async ms=>{time+=ms;}});},async()=>{}),error=>error.cancellationUnconfirmed&&error.cancellationEvidence.cancelResponse.status===200);
 assert.equal(cells,1);
});
test('cancel HTTP failure is fatal with response evidence',async()=>{
 await assert.rejects(cancelAndConfirmTerminal({call:async()=>({status:500,json:{code:'failed'}})},{id:'r',status:'running'}),error=>error.cancellationUnconfirmed&&error.cancellationEvidence.cancelResponse.status===500);
});
test('an unanswered cancellation request is bounded and stops collection',async()=>{
 let cells=0;
 await assert.rejects(collectIndependentCells([1,2],async()=>{
  cells++;
  await cancelAndConfirmTerminal({call:()=>new Promise(()=>{})},{id:'r',status:'running'},{timeoutMs:20,requestTimeoutMs:10});
 },async()=>{}),error=>error.cancellationUnconfirmed&&error.cancellationEvidence.cancelResponse===null);
 assert.equal(cells,1);
});
for(const status of ['succeeded','failed','cancelled'])test(`explicit ${status} confirms stop`,async()=>{
 const result=await cancelAndConfirmTerminal({call:async method=>({status:200,json:{data:method==='POST'?{}:[{id:'r',status}]}})},{id:'r',status:'running'});
 assert.equal(result.lastStatus,status);
});
