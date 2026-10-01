import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentExportWorker } from '../src/documentExportWorker.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async condition => { for (let i=0;i<100 && !condition();i++) await new Promise(resolve=>setImmediate(resolve)); assert.ok(condition()); };

test('a late renewal from the previous job cannot cancel the next render', async t => {
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  const heartbeats = [];
  globalThis.setInterval = callback => { heartbeats.push(callback); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  t.after(() => { globalThis.setInterval=interval;globalThis.clearInterval=clear; });
  const renewal = deferred();
  const first = deferred(); const second = deferred();
  const signals = [];
  let jobNumber = 0;
  const worker = new DocumentExportWorker({
    jobs:{ claim:async()=>({ userId:'alice', id:String(++jobNumber), leaseToken:'lease' }), renew:()=>renewal.promise },
    service:{ reconcileTerminatedAttempts:async()=>{}, prepare:async job=>({ attempt:{ id:job.id },dir:'/unused' }), complete:async()=>{} },
    controller:{ renderDocument:async (_attempt,{signal})=>{signals.push(signal);await (signals.length===1?first.promise:second.promise);}, cancelDocumentRender:async()=>{} },
  });
  const one = worker.tick(); await until(()=>signals.length===1);
  const oldHeartbeat = heartbeats[0]();
  first.resolve(); await one;
  const two = worker.tick(); await until(()=>signals.length===2);
  renewal.resolve(false); await oldHeartbeat;
  assert.equal(signals[0].aborted,true);
  assert.equal(signals[1].aborted,false);
  second.resolve(); await two;
});
