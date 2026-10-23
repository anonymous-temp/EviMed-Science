import test from 'node:test';import assert from 'node:assert/strict';
import { validateContainerIdentity } from '../container_identity.mjs';
const binding={containerId:'a'.repeat(64),imageId:'sha256:approved',owner:'w15-owned',scope:'baseline'};
const inspected={Id:binding.containerId,Image:binding.imageId,State:{Running:true,Pid:1234},Config:{Labels:{'evimed.eval.owner':'w15-owned','evimed.eval.scope':'baseline'}},HostConfig:{PidMode:'',NetworkMode:'host'}};
test('operator binding translates only exact owned container namespace PID',()=>{
 assert.equal(validateContainerIdentity(binding,inspected,1,'NSpid:\t1234\t1\n'),1234);
 for(const change of [{Image:'sha256:other'},{Id:'b'.repeat(64)},{State:{Running:false,Pid:1234}},{HostConfig:{PidMode:'host',NetworkMode:'host'}},{Config:{Labels:{'evimed.eval.owner':'foreign'}}}])assert.throws(()=>validateContainerIdentity(binding,{...inspected,...change},1,'NSpid:\t1234\t1\n'));
 assert.throws(()=>validateContainerIdentity(binding,inspected,2,'NSpid:\t1234\t1\n'));
});
