import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBudgetProxy} from '../budget_proxy.mjs';
const request={model:'deepseek-flash',max_tokens:32,stream:true,system:[{type:'text',text:'system'}],thinking:{type:'enabled',budget_tokens:16},messages:[{role:'assistant',content:[{type:'thinking',thinking:'reason',signature:'sig'},{type:'tool_use',id:'x',name:'lookup',input:{q:'query'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'x',content:[{type:'text',text:'answer'}]}]}]};
const events=[{type:'message_start',message:{model:'deepseek-flash',usage:{input_tokens:3,cache_creation_input_tokens:4,cache_read_input_tokens:5}}},{type:'message_delta',usage:{output_tokens:2}},{type:'message_stop'}];
const sse=rows=>rows.map(x=>`data: ${JSON.stringify(x)}\n\n`).join('');
for(const mode of ['complete','terminal-missing','usage-missing','error','model-mismatch'])test(`Messages HTTP proxy accounting: ${mode}`,async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'messages-proxy-')),keyFile=path.join(dir,'key');await writeFile(keyFile,'fixture-key');
 let calls=0;
 const rows=structuredClone(events);
 if(mode==='terminal-missing')rows.pop();
 if(mode==='usage-missing')delete rows[0].message.usage;
 if(mode==='error')rows.push({type:'error',error:{type:'overloaded_error'}});
 if(mode==='model-mismatch')rows[0].message.model='wrong';
 const proxy=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:32}},providers:{messages:{protocol:'messages',url:'https://api.deepseek.com/anthropic/v1/messages',keyFile,responseModel:'deepseek-flash'}},token:'fixture-token',ledgerFile:path.join(dir,'ledger'),fetchImpl:async(url,init)=>{
 calls++;assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');assert.equal(init.headers['x-api-key'],'fixture-key');assert.equal(init.headers['anthropic-version'],'2023-06-01');assert.deepEqual(JSON.parse(init.body),request);return new Response(sse(rows));
 }});
 t.after(async()=>{await proxy.close();await rm(dir,{recursive:true,force:true});});
 const post=(route,body)=>fetch(proxy.url+route,{method:'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/json'},body:JSON.stringify(body)});
 for(const scope of ['baseline','candidate','openviking']){
 assert.equal((await post('/__eval/probe',{scope,processId:process.pid})).status,200);
 assert.equal((await post(`/scope/${scope}/messages/v1/messages`,request)).status,503);
 }
 assert.equal(calls,0);
 assert.equal((await post('/__eval/arm',{budgetId:proxy.budget.id})).status,200);
 for(const extra of [{unknown:true},{max_tokens:0},{max_tokens:1e100},{messages:[{role:'user',content:[{type:'image',source:{data:'AA=='}}]}]},{messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'x',content:[{type:'tool_result',content:'deep'}]}]}]}])assert.equal((await post('/scope/candidate/messages/v1/messages',{...request,...extra})).status,503);
 assert.equal(calls,0);
 const response=await post('/scope/candidate/messages/v1/messages',request);
 assert.equal(response.status,mode==='complete'?200:503);assert.equal(calls,1);
 const status=proxy.budget.status();
 if(mode==='complete'){assert.equal(status.pending,0);assert.equal(status.reservedCny,0);assert.equal(status.committedCny,0.00004);assert.equal(status.halted,false);}else{assert.equal(status.pending,1);assert.ok(status.reservedCny>0);assert.equal(status.halted,true);assert.equal((await post('/scope/candidate/messages/v1/messages',request)).status,503);assert.equal(calls,1);}
});

test('Messages route cannot inherit a chat origin fallback',async t=>{
 const {installBudgetFetch}=await import('../budget_proxy.mjs');
 const original=globalThis.fetch,dir=await mkdtemp(path.join(os.tmpdir(),'messages-route-')),tokenFile=path.join(dir,'token');await writeFile(tokenFile,'fixture');
 t.after(async()=>{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});});
 const seen=[];
 const wrapped=await installBudgetFetch({scope:'candidate',coordinatorUrl:'http://127.0.0.1:1',tokenFile,providerOrigins:{'https://api.deepseek.com':'chat'},providerRoutes:{'https://api.deepseek.com/anthropic/v1/messages':{provider:'messages',protocol:'messages'}},fetchImpl:async(url,init)=>{seen.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({probe:JSON.parse(init.body).nonce}));}});
 await assert.rejects(()=>wrapped('https://api.deepseek.com/v1/messages',{body:JSON.stringify(request)}),/eval_messages_route_invalid/);
 assert.equal(seen.length,1);
 await wrapped('https://api.deepseek.com/anthropic/v1/messages',{body:JSON.stringify(request)});
 assert.equal(seen[1].body.protocol,'messages');assert.equal(seen[1].body.provider,'messages');assert.deepEqual(seen[1].body.request,request);
});

test('explicit native session origins preserve only exact session message POSTs',async t=>{
 const {installBudgetFetch}=await import('../budget_proxy.mjs');
 const original=globalThis.fetch,dir=await mkdtemp(path.join(os.tmpdir(),'native-session-route-')),tokenFile=path.join(dir,'token');await writeFile(tokenFile,'fixture');
 t.after(async()=>{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});});
 const seen=[],native='http://127.0.0.1:19441';
 const wrapped=await installBudgetFetch({scope:'candidate',coordinatorUrl:'http://127.0.0.1:1',tokenFile,providerOrigins:{'https://api.deepseek.com':'chat'},nativeSessionOrigins:[native],fetchImpl:async(input,init)=>{seen.push({input,init});return new Response(JSON.stringify({probe:JSON.parse(init.body).nonce}));}});
 const signal=new AbortController().signal,init={method:'POST',headers:{'x-test':'preserved'},body:'{"role":"user","parts":[]}',signal};
 const url=native+'/api/v1/sessions/dsh-J17_example/messages';await wrapped(url,init);
 assert.equal(seen.length,2);assert.equal(seen[1].input,url);assert.deepEqual(seen[1].init,{...init,redirect:'error'});assert.equal(seen[1].init.signal,signal);
 for(const target of ['http://user:pass@127.0.0.1:19441/api/v1/sessions/dsh-test/messages','http://127.0.0.1:19442/api/v1/sessions/dsh-test/messages',native+'/v1/messages',native+'/api/v1/sessions/dsh-test/messages?x=1',native+'/api/v1/sessions/dsh-test/messages#x'])await assert.rejects(wrapped(target,init));
 await assert.rejects(wrapped(url,{...init,method:'GET'}));assert.equal(seen.length,2);
 for(const origin of ['https://example.com','http://localhost:19441','http://127.0.0.1:19441/','http://127.0.0.1:19441/path','http://user@127.0.0.1:19441',native+'?x=1'])await assert.rejects(installBudgetFetch({scope:'candidate',coordinatorUrl:'http://127.0.0.1:1',tokenFile,providerOrigins:{'https://api.deepseek.com':'chat'},nativeSessionOrigins:[origin],fetchImpl:async()=>{throw Error('must not probe');}}),/eval_native_session_origin_invalid/);
 assert.equal(seen.length,2);
});

for(const status of [307,308])test(`native session redirect ${status} never reaches an unmetered target`,async t=>{
 const {installBudgetFetch}=await import('../budget_proxy.mjs');
 const original=globalThis.fetch,dir=await mkdtemp(path.join(os.tmpdir(),'native-redirect-')),tokenFile=path.join(dir,'token');await writeFile(tokenFile,'fixture');
 let hits=0;const target=http.createServer((req,res)=>{hits++;res.end('{}');});
 await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
 const source=http.createServer((req,res)=>{res.writeHead(status,{location:`http://127.0.0.1:${target.address().port}/v1/messages`});res.end();});
 await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{globalThis.fetch=original;await Promise.all([new Promise(r=>source.close(r)),new Promise(r=>target.close(r))]);await rm(dir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${source.address().port}`;
 const wrapped=await installBudgetFetch({scope:'candidate',coordinatorUrl:'http://127.0.0.1:1',tokenFile,providerOrigins:{'https://api.deepseek.com':'chat'},nativeSessionOrigins:[origin],fetchImpl:async(input,init)=>String(input).endsWith('/__eval/probe')?new Response(JSON.stringify({probe:JSON.parse(init.body).nonce})):original(input,init)});
 await assert.rejects(wrapped(origin+'/api/v1/sessions/dsh-test/messages',{method:'POST',body:'{}',redirect:'follow'}));assert.equal(hits,0);
});
