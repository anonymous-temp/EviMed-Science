import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBudgetProxy} from '../budget_proxy.mjs';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'budget-port-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return {models:{'deepseek-flash':{input:2,output:8,maxOutput:32}},providers:{},token:'fixture-token',ledgerFile:path.join(dir,'ledger')};
}
test('fixed loopback port preserves the advertised coordinator identity',async t=>{
 const options=await fixture(t),first=await createBudgetProxy(options);
 const port=Number(new URL(first.url).port);await first.close();
 const second=await createBudgetProxy({...options,ledgerFile:options.ledgerFile+'-second',listenPort:port});
 t.after(()=>second.close());assert.equal(second.url,`http://127.0.0.1:${port}`);
 const response=await fetch(second.url+'/__eval/status',{headers:{authorization:'Bearer fixture-token'}});
 assert.equal(response.status,200);assert.equal((await response.json()).armed,false);
});
test('invalid listen port rejects before creating a ledger',async t=>{
 const options=await fixture(t);
 for(const listenPort of [-1,65536,1.5,NaN,Infinity,'33687']){
  await assert.rejects(createBudgetProxy({...options,listenPort}),/Invalid budget proxy listen port/);
  await assert.rejects(access(options.ledgerFile),{code:'ENOENT'});
 }
});
test('occupied loopback port rejects promptly instead of hanging', {timeout:3000},async t=>{
 const options=await fixture(t),held=http.createServer();
 await new Promise(resolve=>held.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>held.close(resolve)));
 await assert.rejects(createBudgetProxy({...options,listenPort:held.address().port}),{code:'EADDRINUSE'});
});
