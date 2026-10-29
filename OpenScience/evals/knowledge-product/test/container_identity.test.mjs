import test from 'node:test';import assert from 'node:assert/strict';
import { validateContainerIdentity } from '../container_identity.mjs';
const binding={containerId:'a'.repeat(64),imageId:'sha256:approved',owner:'w15-owned',scope:'baseline'};
const inspected={Id:binding.containerId,Image:binding.imageId,State:{Running:true,Pid:1234},Config:{Labels:{'evimed.eval.owner':'w15-owned','evimed.eval.scope':'baseline'}},HostConfig:{PidMode:'',NetworkMode:'host'}};
test('operator binding translates only exact owned container namespace PID',()=>{
 assert.equal(validateContainerIdentity(binding,inspected,1,'NSpid:\t1234\t1\n'),1234);
 for(const change of [{Image:'sha256:other'},{Id:'b'.repeat(64)},{State:{Running:false,Pid:1234}},{HostConfig:{PidMode:'host',NetworkMode:'host'}},{Config:{Labels:{'evimed.eval.owner':'foreign'}}}])assert.throws(()=>validateContainerIdentity(binding,{...inspected,...change},1,'NSpid:\t1234\t1\n'));
 assert.throws(()=>validateContainerIdentity(binding,inspected,2,'NSpid:\t1234\t1\n'));
});
test('operator container mode rejects omitted container admission at the HTTP boundary',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {createBudgetProxy}=await import('../budget_proxy.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'container-proof-test-'));
 const p=await createBudgetProxy({models:{'deepseek-flash':{input:2,output:8,maxOutput:1}},providers:{},token:'unit',ledgerFile:path.join(dir,'ledger'),operatorBindingsFile:path.join(dir,'operator-root-only')});
 try{const r=await fetch(p.url+'/__eval/probe',{method:'POST',headers:{authorization:'Bearer unit','content-type':'application/json'},body:JSON.stringify({scope:'baseline',processId:process.pid,nonce:'unit'})});assert.equal(r.status,503);assert.equal(p.wiring.baseline,undefined);}finally{await p.close();await fs.rm(dir,{recursive:true,force:true});}
});
