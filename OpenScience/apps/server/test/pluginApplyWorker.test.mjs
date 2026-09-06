import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPluginCandidate } from '../src/pluginApplyWorker.mjs';
const candidate={revision:2,enabled:false,settings:{timeoutMs:5000}};
const previous={revision:1,enabled:true,settings:{timeoutMs:4000}};
test('candidate failure restores and independently verifies the previous configuration',async()=>{
  const calls=[];
  const runtime={replacePluginRuntime:async(_p,config)=>{calls.push(['start',config.revision]);return {generation:String(config.revision)};},
    probePlugin:async(_p,config)=>{calls.push(['probe',config.revision]);if(config.revision===2)throw new Error('candidate');return {generation:'1'};},
    stop:async()=>calls.push(['stop'])};
  const result=await applyPluginCandidate(runtime,{},candidate,previous,async()=>{});
  assert.equal(result.phase,'rolled_back');assert.deepEqual(result.effective,previous);
  assert.deepEqual(calls,[['start',2],['probe',2],['start',1],['probe',1]]);
});
test('failed rollback reports unavailable and never labels unverified config effective',async()=>{
  const runtime={replacePluginRuntime:async()=>{},probePlugin:async()=>{throw new Error('failed');},stop:async()=>{}};
  const result=await applyPluginCandidate(runtime,{},candidate,previous,async()=>{});
  assert.equal(result.phase,'unavailable');assert.equal(result.effective,null);
});
test('lost authority does not start rollback or publish a result',async()=>{
  let starts=0;
  const runtime={replacePluginRuntime:async()=>{starts++;},probePlugin:async()=>{throw new Error('failed');},stop:async()=>{}};
  let checks=0;const guard=async()=>{if(++checks>1)throw Object.assign(new Error('lost'),{code:'product_job_lease_lost'});};
  await assert.rejects(applyPluginCandidate(runtime,{},candidate,previous,guard),{code:'product_job_lease_lost'});
  assert.equal(starts,1);
});
