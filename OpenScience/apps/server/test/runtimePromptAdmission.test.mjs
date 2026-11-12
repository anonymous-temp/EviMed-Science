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
test('admissions hold at most half the database pool while kernels acknowledge; the rest wait without a client',async()=>{
 const release=deferred(),entered=deferred();let open=0,most=0;const order=[];
 const database={transactionScope:()=>null,withTransactionClient:(_client,operation)=>operation(),
  transaction:async work=>{open++;most=Math.max(most,open);try{return await work({query:async()=>({rows:[]})});}finally{open--;}}};
 const manager={config:{runtimePromptAdmissionTimeoutMs:2000,databasePoolMax:3},promptAdmissionDatabase:database},project={userId:'owner',id:'project'};
 const first=withSessionPromptAdmission(manager,project,'a',async()=>{order.push('a');entered.resolve();await release.promise;});
 await entered.promise;
 const second=withSessionPromptAdmission(manager,project,'b',async()=>{order.push('b');});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(order,['a']);assert.equal(runtimePromptAdmissionStatus(manager).waitingForClient,1);
 release.resolve();await first;await second;
 assert.deepEqual(order,['a','b']);assert.equal(most,1);assert.equal(runtimePromptAdmissionStatus(manager).waitingForClient,0);
});
test('an admission that times out waiting for a client never takes one later',async()=>{
 const release=deferred(),entered=deferred();let transactions=0;
 const database={transactionScope:()=>null,withTransactionClient:(_client,operation)=>operation(),
  transaction:async work=>{transactions++;return work({query:async()=>({rows:[]})});}};
 const manager={config:{runtimePromptAdmissionTimeoutMs:2000,databasePoolMax:2},promptAdmissionDatabase:database},project={userId:'owner',id:'project'};
 const first=withSessionPromptAdmission(manager,project,'a',async()=>{entered.resolve();await release.promise;});
 await entered.promise;manager.config.runtimePromptAdmissionTimeoutMs=20;
 const late=withSessionPromptAdmission(manager,project,'b',async()=>{throw new Error('must not run');});
 await assert.rejects(late,/admitting another input/);
 release.resolve();await first;await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(transactions,1);assert.equal(runtimePromptAdmissionStatus(manager).waitingForClient,0);
});


test('isolated admission keeps its database session fence without exposing its transaction to kernel callbacks', async () => {
 const { AsyncLocalStorage } = await import('node:async_hooks');
 const scope = new AsyncLocalStorage();
 let clientHeld = false;
 const database = { transactionScope: () => scope.getStore(),
  withTransactionClient: (client, operation) => scope.run(client, operation),
  withoutTransactionClient: operation => scope.run(undefined, operation),
  transaction: async work => { clientHeld = true; try { return await work({ query: async () => ({ rows: [] }) }); } finally { clientHeld = false; } } };
 const manager = { config: { memoryRuntimeLockIsolationEnabled: true }, promptAdmissionDatabase: database };
 await withSessionPromptAdmission(manager, { userId: 'owner', id: 'project' }, 'session', async () => {
  assert.equal(clientHeld, true, 'the cross-process session exclusion is still held');
  assert.equal(database.transactionScope(), undefined, 'memory proof reads cannot retain locks on the admission client');
 });
 assert.equal(clientHeld, false);
});
