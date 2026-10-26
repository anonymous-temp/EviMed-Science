import test from 'node:test';
import assert from 'node:assert/strict';
import {withSessionPromptAdmission,runtimePromptAdmissionStatus} from '../src/runtimePromptAdmission.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('same-session admission excludes a competing human through proof and RPC acknowledgement while other sessions proceed',async()=>{
 const manager={config:{runtimePromptAdmissionTimeoutMs:2000}},project={userId:'owner',id:'project'},proof=deferred(),ack=deferred(),entered=deferred();const events=[];
 const completion=withSessionPromptAdmission(manager,project,'same',async signal=>{events.push('proof');entered.resolve();await proof.promise;signal.throwIfAborted();events.push('completion-wire');await ack.promise;events.push('completion-ack');});
 await entered.promise;
 const human=withSessionPromptAdmission(manager,project,'same',async()=>{events.push('human-wire');});
 await withSessionPromptAdmission(manager,project,'other',async()=>{events.push('other-wire');});assert.deepEqual(events,['proof','other-wire']);
 proof.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['proof','other-wire','completion-wire']);
 ack.resolve();await completion;await human;assert.deepEqual(events,['proof','other-wire','completion-wire','completion-ack','human-wire']);assert.equal(runtimePromptAdmissionStatus(manager).active,0);
});
test('an expired queued admission never runs later when its predecessor releases',async()=>{
 const manager={config:{runtimePromptAdmissionTimeoutMs:40}},project={userId:'owner',id:'project'};let entered=0;
 const first=withSessionPromptAdmission(manager,project,'same',async signal=>{await new Promise(resolve=>setTimeout(resolve,60));signal.throwIfAborted();});
 manager.config.runtimePromptAdmissionTimeoutMs=10;
 const second=withSessionPromptAdmission(manager,project,'same',async()=>{entered++;});
 const result=await Promise.allSettled([first,second]);assert.ok(result.every(item=>item.status==='rejected'));assert.equal(entered,0);assert.equal(runtimePromptAdmissionStatus(manager).timedOut,2);
});
