import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedBudget, verifyLiveBudgetWiring, armSharedBudget } from '../shared_budget.mjs';
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
 const originalFetch=globalThis.fetch;
 let providerCalls=0;
 const proxy=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:4096}},providers:{deepseek:{url:'https://provider.test/chat/completions',keyFile}},token:'test-only-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:async()=>{providerCalls++;return new Response(JSON.stringify({model:'deepseek-flash',usage:{prompt_tokens:3,completion_tokens:2},choices:[]}));}});
 const config={coordinatorUrl:proxy.url,tokenFile,sharedBudgetId:proxy.budget.id};
 try{
  await assert.rejects(()=>verifyLiveBudgetWiring(config,{nativeVerifier:()=>true}),/Unverified provider wiring/);
  const wrappers=[];
  for(const scope of ['baseline','candidate','openviking','C']){
   const wrapped=await installBudgetFetch({scope,coordinatorUrl:proxy.url,tokenFile,providerOrigins:{'https://provider.test':'deepseek'}});wrappers.push(wrapped);
   const r=await wrapped('https://provider.test/chat/completions',{body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'Unit test only'}],stream:false,max_tokens:20})});assert.equal(r.status,503);
  }
  assert.equal(providerCalls,0);
  await armSharedBudget(config,{nativeVerifier:()=>true});
  for(const wrapped of wrappers){const r=await wrapped('https://provider.test/chat/completions',{body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'Unit test only'}],stream:false,max_tokens:20})});assert.equal(r.status,200);}
  const status=await verifyLiveBudgetWiring(config,{nativeVerifier:()=>true});assert.equal(providerCalls,4);assert.equal(status.committedCny,0.000088);assert.equal(status.pending,0);
 }finally{globalThis.fetch=originalFetch;await proxy.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('an idle instrumented process retains its verified wiring beyond sixty seconds',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createBudgetProxy,installBudgetFetch}=await import('../budget_proxy.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eval-idle-budget-')),tokenFile=path.join(dir,'token');await fs.writeFile(tokenFile,'idle-test-token');const originalFetch=globalThis.fetch;
 const proxy=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:4096}},providers:{deepseek:{url:'https://provider.test/chat/completions',keyFile:path.join(dir,'unused')}},token:'idle-test-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:()=>{throw new Error('No paid provider request allowed');}});
 try{
  for(const scope of ['baseline','candidate','openviking']){
   const wrapped=await installBudgetFetch({scope,coordinatorUrl:proxy.url,tokenFile,providerOrigins:{'https://provider.test':'deepseek'}});
   await wrapped('https://provider.test/chat/completions',{body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'Dry probe'}],stream:false,max_tokens:1})});
   proxy.wiring[scope].at=Date.now()-3600000;
  }
  const config={coordinatorUrl:proxy.url,tokenFile,sharedBudgetId:proxy.budget.id};
  assert.equal((await verifyLiveBudgetWiring(config,{nativeVerifier:()=>true})).id,proxy.budget.id);
  assert.equal((await armSharedBudget(config,{nativeVerifier:()=>true})).armed,true);
 }finally{globalThis.fetch=originalFetch;await proxy.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('native DashScope compatible-mode path reaches the unarmed coordinator and never the provider',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {createBudgetProxy}=await import('../budget_proxy.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eval-embedding-path-'));let calls=0;
 const p=await createBudgetProxy({models:{'qwen3.7-text-embedding':{kind:'embedding',input:0.5,output:0,maxOutput:0}},providers:{dashscope:{url:'https://provider.test/embeddings',keyFile:path.join(dir,'unused')}},token:'unit-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:()=>{calls++;throw new Error('No provider request allowed');}});
 await fetch(p.url+'/__eval/probe',{method:'POST',headers:{Authorization:'Bearer unit-token','content-type':'application/json'},body:JSON.stringify({scope:'openviking',processId:process.pid,nonce:'unit-native'})});
 try{const r=await fetch(p.url+'/scope/openviking/dashscope/compatible-mode/v1/embeddings',{method:'POST',headers:{Authorization:'Bearer unit-token','content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',input:['Unit fixture'],dimensions:1024})});assert.equal(r.status,503);assert.equal(p.wiring.openviking.providerBoundary,true);assert.equal(calls,0);}finally{await p.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('unknown provider accounting retains reservation and halts further admission',()=>{
 const b=new SharedBudget({capCny:50,models:{flash:{input:2,output:8,maxOutput:100}}});const id=b.reserve({scope:'baseline',model:'flash',inputTokens:10,maxOutputTokens:10});b.holdUncertain(id);assert.equal(b.status().pending,1);assert.equal(b.status().halted,true);assert.throws(()=>b.reserve({scope:'candidate',model:'flash',inputTokens:1,maxOutputTokens:1}),/halted/);
});
test('bounded operator preflight preserves documented reasoning effort and refuses missing output limits',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {createBudgetProxy}=await import('../budget_proxy.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eval-effort-'));let calls=0;
 const p=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:4096}},providers:{deepseek:{url:'https://provider.test/chat/completions',keyFile:path.join(dir,'unused')}},token:'unit-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:()=>{calls++;throw new Error('No provider request allowed');}});
 const post=(route,body)=>fetch(p.url+route,{method:'POST',headers:{Authorization:'Bearer unit-token','content-type':'application/json'},body:JSON.stringify(body)});
 try{
  for(const effort of ['none','low','high','max','minimal','medium','xhigh','ultra']){
   await post('/__eval/probe',{scope:'baseline',processId:process.pid,nonce:'effort'});
   const body={model:'deepseek-flash',messages:[{role:'user',content:'Unit preflight'}],reasoning_effort:effort,max_tokens:4096};
   await post('/provider',{scope:'baseline',provider:'deepseek',request:body});assert.equal(p.wiring.baseline.providerBoundary,true);
  }
  for(const change of [{reasoning_effort:'unbounded'},{reasoning_effort:{high:true}},{max_tokens:undefined},{max_tokens:4097}]){
   await post('/__eval/probe',{scope:'baseline',processId:process.pid,nonce:'invalid'});
   await post('/provider',{scope:'baseline',provider:'deepseek',request:{model:'deepseek-flash',messages:[{role:'user',content:'Unit preflight'}],reasoning_effort:'high',max_tokens:4096,...change}});assert.equal(p.wiring.baseline.providerBoundary,undefined);
  }
  assert.equal(calls,0);assert.equal(p.budget.status().pending,0);
 }finally{await p.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('client abort is preserved while coordinator-owned provider accounting completes',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {createBudgetProxy,installBudgetFetch}=await import('../budget_proxy.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'budget-abort-')),tokenFile=path.join(dir,'token'),keyFile=path.join(dir,'key');await fs.writeFile(tokenFile,'unit-token');await fs.writeFile(keyFile,'unit-key');const original=globalThis.fetch;
 let release,started;const barrier=new Promise(r=>{release=r;}),arrived=new Promise(r=>{started=r;});
 const p=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:100}},providers:{deepseek:{url:'https://provider.test/chat/completions',keyFile}},token:'unit-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:async()=>{started();await barrier;return new Response(JSON.stringify({usage:{prompt_tokens:2,completion_tokens:1}}));}});
 try{
  let wrapped;const body=JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'Unit-only abort'}],max_tokens:10});
  for(const scope of ['baseline','candidate','openviking']){wrapped=await installBudgetFetch({scope,coordinatorUrl:p.url,tokenFile,providerOrigins:{'https://provider.test':'deepseek'}});await wrapped('https://provider.test/chat/completions',{body});}
  await armSharedBudget({coordinatorUrl:p.url,tokenFile,sharedBudgetId:p.budget.id},{nativeVerifier:()=>true});
  const controller=new AbortController();let returned=false;const pending=wrapped('https://provider.test/chat/completions',{body,signal:controller.signal}).then(()=>{returned=true;return 'resolved';},e=>{returned=true;return e.name;});
  await arrived;assert.equal(p.budget.status().pending,1);controller.abort();await new Promise(r=>setTimeout(r,25));const abortedBeforeProviderReturned=returned;release();assert.equal(await pending,'AbortError');assert.equal(abortedBeforeProviderReturned,true);
  for(let i=0;i<50&&p.budget.status().pending;i++)await new Promise(r=>setTimeout(r,5));assert.equal(p.budget.status().pending,0);assert.equal(p.budget.status().committedCny,0.000012);assert.equal(p.budget.status().halted,false);
 }finally{release?.();globalThis.fetch=original;await p.close();await fs.rm(dir,{recursive:true,force:true});}
});
