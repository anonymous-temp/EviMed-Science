import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedBudget, verifyLiveBudgetWiring } from '../shared_budget.mjs';
test('baseline, candidate, OpenViking and C reserve against one aggregate cap',()=>{
 const b=new SharedBudget({capCny:50,models:{flash:{input:2,output:8,maxOutput:4096}}});
 const ids=[]; for(const path of ['baseline','candidate','openviking','C'])ids.push(b.reserve({scope:path,model:'flash',inputTokens:1000000,maxOutputTokens:1000}));
 assert.equal(b.status().reservedCny,8.032);
 assert.throws(()=>b.reserve({scope:'C',model:'flash',inputTokens:25000000,maxOutputTokens:1000}),/budget/);
 b.settle(ids[0],{inputTokens:100,outputTokens:100});
 assert.ok(b.status().committedCny+b.status().reservedCny<50);
});
test('unknown models/output overruns and missing live wiring fail closed',async()=>{
 const b=new SharedBudget({capCny:50,models:{flash:{input:2,output:8,maxOutput:4096}}});
 assert.throws(()=>b.reserve({scope:'baseline',model:'unknown',inputTokens:1,maxOutputTokens:1}),/model/);
 assert.throws(()=>b.reserve({scope:'baseline',model:'flash',inputTokens:1,maxOutputTokens:5000}),/output/);
 await assert.rejects(()=>verifyLiveBudgetWiring({}),/wiring/);
});
test('live provider proxy aggregates all runner paths and refuses paper-only wiring',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createBudgetProxy,installBudgetFetch}=await import('../budget_proxy.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eval-budget-test-'));const tokenFile=path.join(dir,'token'),keyFile=path.join(dir,'fake-key');
 await fs.writeFile(tokenFile,'test-only-token',{mode:0o600});await fs.writeFile(keyFile,'test-only-provider-key',{mode:0o600});
 let providerCalls=0;
 const proxy=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:4096}},providers:{deepseek:{url:'https://provider.test/chat/completions',keyFile}},token:'test-only-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:async()=>{providerCalls++;return new Response(JSON.stringify({model:'deepseek-flash',usage:{prompt_tokens:3,completion_tokens:2},choices:[]}));}});
 const config={coordinatorUrl:proxy.url,tokenFile,sharedBudgetId:proxy.budget.id};
 try{
  await assert.rejects(()=>verifyLiveBudgetWiring(config),/Unverified provider wiring/);
  for(const scope of ['baseline','candidate','openviking','C']){
   const wrapped=await installBudgetFetch({scope,coordinatorUrl:proxy.url,tokenFile,providerOrigins:{'https://provider.test':'deepseek'}});
   const r=await wrapped('https://provider.test/chat/completions',{body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'Unit test only'}],stream:false,max_tokens:20})});assert.equal(r.status,200);
  }
  const status=await verifyLiveBudgetWiring(config);assert.equal(providerCalls,4);assert.equal(status.committedCny,0.000088);assert.equal(status.pending,0);
 }finally{await proxy.close();await fs.rm(dir,{recursive:true,force:true});}
});
