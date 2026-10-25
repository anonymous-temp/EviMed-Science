import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyVcrInvocation } from '../src/vcrExecutionContext.mjs';

function fixture({ child = false, input = { what: 'study' }, pending = true } = {}) {
  const project = { id: 'project', userId: 'user' };
  const runtimeManager = { sessionTranscript: async (_project, sessionId) => ({ sessionId, truncated: false,
    turns: [{ startSeq: 1, end: null }], messages: [{ turnStartSeq: 1, role: 'assistant', parts: [
      { type: 'tool', callId: 'call', status: pending ? 'pending' : 'succeeded', tool: 'mcp__evimed__vcr_read', input } ] }] }) };
  const runs = [{ id: 'run', sessionId: 'root' }];
  return { project, runtimeManager, runs, resolveSession: () => child
    ? { child: true, parentSessionId: 'root', runId: 'run' } : { runId: 'run' } };
}
const header = sessionId => JSON.stringify({ v: 1, sessionId, callId: 'call' });
test('native VCR invocation resolves a child to its actual root run', async () => {
  const result = await verifyVcrInvocation({ ...fixture({ child: true }), header: header('child'), operation: 'read', body: { what: 'study' } });
  assert.equal(result.rootSessionId, 'root'); assert.equal(result.runId, 'run'); assert.equal(result.sessionId, 'child');
});
test('VCR rejects forged arguments, ended calls and missing execution context', async () => {
  for (const options of [{ body: { what: 'matching' } }, { pending: false }, { header: '' }]) {
    await assert.rejects(verifyVcrInvocation({ ...fixture(options), header: header('root'), operation: 'read', body: { what: 'study' }, ...options }), { code: 'vcr_invocation_unavailable' });
  }
});
test('native trial-benchmark file expansion is verified against exact control-plane bytes',async()=>{
 const actual={what:'trial_benchmark',data:{predictionsFile:'predictions.json'}};
 const f=fixture({input:actual});f.runtimeManager.sessionTranscript=async(_p,sessionId)=>({sessionId,truncated:false,turns:[{startSeq:1,end:null}],messages:[{turnStartSeq:1,parts:[{type:'tool',callId:'call',status:'pending',tool:'mcp__evimed__vcr_write',input:actual}]}]});
 const verified={comparisons:[{predicted:0.3}],sourceFile:{name:'predictions.json',sha256:'a'.repeat(64)}};
 const result=await verifyVcrInvocation({...f,header:header('root'),operation:'write',body:{what:'trial_benchmark',data:verified},readBenchmark:async(_project,file)=>{assert.equal(file,'predictions.json');return verified;}});assert.equal(result.rootSessionId,'root');
 await assert.rejects(verifyVcrInvocation({...f,header:header('root'),operation:'write',body:{what:'trial_benchmark',data:{...verified,comparisons:[{predicted:0.8}]}},readBenchmark:async()=>verified}),{code:'vcr_invocation_unavailable'});
});
