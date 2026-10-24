import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBudgetProxy,installBudgetFetch} from '../budget_proxy.mjs';
import {MemoryRerank} from '../../../apps/server/src/memoryRerank.mjs';

const rate={kind:'rerank',input:0.5,output:0,maxOutput:0};
const request={model:'qwen3-rerank',query:'q'.repeat(1000),documents:Array(32).fill('preserved document'),top_n:32,instruct:'Find relevant evidence.'};
const endpoint='https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
async function fixture(t,{reply={usage:{total_tokens:120},results:[]},rateOverride={},targetOverride={}}={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rerank-budget-'));const tokenFile=path.join(dir,'token'),keyFile=path.join(dir,'key');
 await fs.writeFile(tokenFile,'unit-only-token');await fs.writeFile(keyFile,'unit-only-key');
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0,reservedAtDispatch=0;const p=await createBudgetProxy({models:{'qwen3-rerank':{...rate,...rateOverride}},providers:{rerank:{kind:'rerank',url:endpoint,keyFile,responseModel:'qwen3-rerank',...targetOverride}},token:'unit-only-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:async(url,init)=>{calls++;reservedAtDispatch=[...p.budget.pending.values()][0].inputTokens;assert.equal(url,endpoint);assert.deepEqual(JSON.parse(init.body),request);return new Response(JSON.stringify(reply));}});
 const post=(route,body)=>fetch(p.url+route,{method:'POST',headers:{Authorization:'Bearer unit-only-token','content-type':'application/json'},body:JSON.stringify(body)});
 const send=(value=request,scope='baseline')=>post('/provider',{scope,provider:'rerank',request:value});
 t.after(()=>p.close());
 for(const scope of ['baseline','candidate','openviking'])await post('/__eval/probe',{scope,processId:process.pid,nonce:'unit'});
 return {p,post,send,tokenFile,calls:()=>calls,reserved:()=>reservedAtDispatch,arm:async()=>{for(const s of ['baseline','candidate','openviking'])assert.equal((await send(request,s)).status,503);assert.equal((await post('/__eval/arm',{budgetId:p.budget.id})).status,200);}};
}
test('rerank dry boundary records real request shape without provider calls or reservations',async t=>{
 const f=await fixture(t);assert.equal((await f.send()).status,503);assert.equal(f.p.wiring.baseline.providerBoundary,true);assert.equal(f.calls(),0);assert.equal(f.p.budget.status().pending,0);
});
test('rerank repeats query cost per document and settles authoritative total_tokens under the shared cap',async t=>{
 const f=await fixture(t);await f.arm();assert.equal((await f.send()).status,200);
 assert.ok(f.reserved()>=Buffer.byteLength(request.query)*request.documents.length+request.documents.reduce((n,d)=>n+Buffer.byteLength(d),0));
 assert.equal(f.p.budget.status().committedCny,0.00006);assert.equal(f.p.budget.status().pending,0);
});
test('rerank shares the same outstanding C reservations and cannot dispatch past the aggregate cap',async t=>{
 const f=await fixture(t);await f.arm();f.p.budget.reserve({scope:'C',model:'qwen3-rerank',inputTokens:99999000});
 assert.equal((await f.send()).status,503);assert.equal(f.calls(),0);assert.equal(f.p.budget.status().reservedCny,49.9995);assert.equal(f.p.budget.status().pending,1);
});
test('missing/invalid or over-bound rerank usage retains reservation and halts every arm',async t=>{
 for(const usage of [undefined,{total_tokens:0},{total_tokens:-1},{total_tokens:1.5},{total_tokens:100000000}]){
  const f=await fixture(t,{reply:{model:'qwen3-rerank',usage,results:[]}});await f.arm();assert.equal((await f.send()).status,503);
  assert.equal(f.p.budget.status().halted,true);assert.equal(f.p.budget.status().pending,1);assert.ok(f.p.budget.status().reservedCny>0);
  assert.equal((await f.send(request,'C')).status,503);assert.equal(f.calls(),1);
 }
});
test('oversized rerank responses retain the reservation instead of returning unaccounted output',async t=>{
 const f=await fixture(t,{reply:{model:'qwen3-rerank',usage:{total_tokens:10},results:[],unexpected:'x'.repeat(262145)}});await f.arm();assert.equal((await f.send()).status,503);assert.equal(f.p.budget.status().halted,true);assert.equal(f.p.budget.status().pending,1);
});
test('a returned wrong rerank model halts rather than overriding the pinned request identity',async t=>{
 const f=await fixture(t,{reply:{model:'other-model',usage:{total_tokens:10},results:[]}});await f.arm();assert.equal((await f.send()).status,503);assert.equal(f.p.budget.status().halted,true);
});
test('unbounded rerank fields, multimodal data, counts and output are rejected before forwarding',async t=>{
 const f=await fixture(t);await f.arm();
 for(const bad of [{stream:true},{max_tokens:1},{documents:[]},{documents:Array(101).fill('x')},{documents:[{image:'https://example.test/a'}]},{query:'x'.repeat(32769)},{top_n:33},{return_documents:true},{extra:'x'}])assert.equal((await f.send({...request,...bad})).status,503);
 assert.equal(f.calls(),0);assert.equal(f.p.budget.status().pending,0);
});
test('rerank price and endpoint admission cannot use embedding/chat rates or an international rate region',async t=>{
 await assert.rejects(()=>fixture(t,{rateOverride:{input:0.49}}),/price/i);
 await assert.rejects(()=>fixture(t,{rateOverride:{kind:'embedding'}}),/rerank|kind/i);
 await assert.rejects(()=>fixture(t,{targetOverride:{url:'https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks'}}),/region|endpoint/i);
});
test('real product rerank envelope selects exact provider route on a shared embedding origin',async t=>{
 const f=await fixture(t);const before=globalThis.fetch;t.after(()=>{globalThis.fetch=before;});
 const wrapped=await installBudgetFetch({scope:'baseline',coordinatorUrl:f.p.url,tokenFile:f.tokenFile,providerOrigins:{'https://dashscope.aliyuncs.com':'embedding'},providerRoutes:{[endpoint]:'rerank'}});
 const reranker=new MemoryRerank({apiKey:'unit-only-reference',model:'qwen3-rerank',apiBase:endpoint},{fetchImpl:wrapped,report:()=>{}});
 await reranker.order('Unit-only query',['one','two']);assert.equal(f.p.wiring.baseline.providerBoundary,true);assert.equal(f.calls(),0);
 await assert.rejects(()=>wrapped('https://unadmitted.test/compatible-api/v1/reranks',{body:JSON.stringify(request)}),/bypass/);
});
