import assert from 'node:assert/strict';
import test from 'node:test';
import {coworkToolSpecs} from './bridge.mjs';
test('thin bridge retains invoking scope and cancellation; caller cannot select a host path',async()=>{
  const calls=[],specs=coworkToolSpecs(async input=>{calls.push(input);return{ok:true,data:{format:'xlsx'}};});
  const signal=new AbortController().signal,call={agent:{id:'actual-child'},signal};
  await specs[0].execute({resourceId:'res_public',options:{rows:3}},call);
  assert.equal(calls[0].call,call);assert.equal(calls[0].request.operation,'doc_read');
  await assert.rejects(specs[0].execute({resourceId:'res_public',path:'/data-plane'},call));
  assert.deepEqual(specs.map(spec=>spec.name),['doc_read','doc_write']);
});
