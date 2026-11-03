import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyVcrInvocation } from '../src/vcrExecutionContext.mjs';
import { createVcrCompletionResolver } from '../src/vcrConversationCompletions.mjs';

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
test('a validate call is proved by the scenario it carries, as a start is', async () => {
  // Found on a real kernel: validate was read as a status call, so its proof compared {action, jobId} with what was sent, and
  // every validate in a live conversation answered vcr_invocation_unavailable and sent the run away from the engine.
  const input = { action: 'validate', kind: 'design_analytic', scenario: { truth: { hazardRatio: 0.75 } } };
  const f = fixture({ input });
  f.runtimeManager.sessionTranscript = async (_project, sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
    messages: [{ turnStartSeq: 1, role: 'assistant', parts: [{ type: 'tool', callId: 'call', status: 'pending', tool: 'mcp__evimed__vcr_simulate', input }] }] });
  const result = await verifyVcrInvocation({ ...f, header: header('root'), operation: 'simulate', body: input });
  assert.equal(result.runId, 'run');
  await assert.rejects(verifyVcrInvocation({ ...f, header: header('root'), operation: 'simulate', body: { ...input, kind: 'design_simulation' } }), { code: 'vcr_invocation_unavailable' });
});
test('a start or a validate that names the papers of its numbers is proved by them too, and a forged list is refused', async () => {
  // Found on a real kernel (2026-11-02): the proof compared the pending call with a closed list of keys that did not hold `sources`, so every start
  // that named a paper answered vcr_invocation_unavailable while the same start without the list was queued. The list rides the proof like the scenario.
  const input = { action: 'start', kind: 'design_analytic', scenario: { endpoint: { type: 'time_to_event' }, truth: { controlMedian: 13.8 } },
    sources: [{ field: 'truth.controlMedian', publication: 'PMID 37676259', quote: '13.8 months with sorafenib' }] };
  const f = fixture({ input });
  f.runtimeManager.sessionTranscript = async (_project, sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
    messages: [{ turnStartSeq: 1, role: 'assistant', parts: [{ type: 'tool', callId: 'call', status: 'pending', tool: 'mcp__evimed__vcr_simulate', input }] }] });
  for (const action of ['start', 'validate']) {
    const named = { ...input, action };
    f.runtimeManager.sessionTranscript = async (_project, sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, role: 'assistant', parts: [{ type: 'tool', callId: 'call', status: 'pending', tool: 'mcp__evimed__vcr_simulate', input: named }] }] });
    assert.equal((await verifyVcrInvocation({ ...f, header: header('root'), operation: 'simulate', body: named })).runId, 'run', action);
    await assert.rejects(verifyVcrInvocation({ ...f, header: header('root'), operation: 'simulate', body: { ...named, sources: [{ ...named.sources[0], quote: 'another sentence' }] } }), { code: 'vcr_invocation_unavailable' });
    await assert.rejects(verifyVcrInvocation({ ...f, header: header('root'), operation: 'simulate', body: { ...named, sources: undefined } }), { code: 'vcr_invocation_unavailable' });
  }
});
test('a first call waits for its turn to reach the ledger, and a turn that never does is refused', async () => {
  // Found on a real kernel: the first vcr_read went out 2.6 s into a composer turn, whose run was written at 8.6 s.
  let asked = 0;
  const late = await verifyVcrInvocation({ ...fixture(), header: header('root'), operation: 'read', body: { what: 'study' }, adoptionWaitMs: 5000,
    runs: async () => (++asked < 3 ? [] : [{ id: 'run', sessionId: 'root' }]) });
  assert.equal(late.runId, 'run'); assert.equal(asked, 3);
  await assert.rejects(verifyVcrInvocation({ ...fixture(), header: header('root'), operation: 'read', body: { what: 'study' }, adoptionWaitMs: 50, runs: async () => [] }),
    { code: 'vcr_invocation_unavailable' });
  // Arguments that do not match the pending call are refused at once, without waiting for anything.
  let waited = 0;
  await assert.rejects(verifyVcrInvocation({ ...fixture(), header: header('root'), operation: 'read', body: { what: 'matching' }, adoptionWaitMs: 5000, runs: async () => { waited += 1; return []; } }),
    { code: 'vcr_invocation_unavailable' });
  assert.equal(waited, 0);
});
test('native trial-benchmark file expansion is verified against exact control-plane bytes',async()=>{
 const actual={what:'trial_benchmark',data:{predictionsFile:'predictions.json'}};
 const f=fixture({input:actual});f.runtimeManager.sessionTranscript=async(_p,sessionId)=>({sessionId,truncated:false,turns:[{startSeq:1,end:null}],messages:[{turnStartSeq:1,parts:[{type:'tool',callId:'call',status:'pending',tool:'mcp__evimed__vcr_write',input:actual}]}]});
 const verified={comparisons:[{predicted:0.3}],sourceFile:{name:'predictions.json',sha256:'a'.repeat(64)}};
 const result=await verifyVcrInvocation({...f,header:header('root'),operation:'write',body:{what:'trial_benchmark',data:verified},readBenchmark:async(_project,file)=>{assert.equal(file,'predictions.json');return verified;}});assert.equal(result.rootSessionId,'root');
 await assert.rejects(verifyVcrInvocation({...f,header:header('root'),operation:'write',body:{what:'trial_benchmark',data:{...verified,comparisons:[{predicted:0.8}]}},readBenchmark:async()=>verified}),{code:'vcr_invocation_unavailable'});
});
test('a job that outlives a turn typed in the composer finds its conversation', async () => {
  const accounts = { userById: async () => ({ id: 'owner' }), requireProject: async () => ({ id: 'p', userId: 'owner' }) };
  const studies = { getStudy: async () => ({ projectId: 'p', status: 'active', scope: 'conversation', conversationSessionId: 'root' }) };
  const row = { user_id: 'owner', project_id: 'p', study_id: 'std', root_session_id: 'root' };
  const resolve = (adoptSession) => createVcrCompletionResolver({ accounts, studies, sessions: { get: async () => null }, allows: () => true, adoptSession })(row);
  assert.deepEqual((await resolve(async (_project, id) => ({ sessionId: id }))).session, { sessionId: 'root' });
  // A conversation with no run of its own is still unavailable.
  assert.equal((await resolve(async () => null)).session, null);
  assert.equal((await resolve(undefined)).session, null);
});
