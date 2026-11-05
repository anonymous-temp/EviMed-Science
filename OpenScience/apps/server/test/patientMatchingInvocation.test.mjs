import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPatientMatchingInvocation } from '../src/patientMatchingInvocation.mjs';

function fixture() {
  const input = { taskId: 'task-a', query: 'prior treatment' };
  /** @type {any} */
  const transcript = { sessionId: 'child-a', truncated: false, turns: [{ startSeq: 5, end: null }], messages: [{ turnStartSeq: 5, parts: [{ type: 'tool', callId: 'call-a', tool: 'match_evidence', status: 'pending', input }] }] };
  /** @type {any} */
  const options = { request: { invocation: { tool: 'match_evidence', sessionId: 'child-a', callId: 'call-a', rootCallId: 'root-call', args: input } }, project: { id: 'project-a', userId: 'owner-a' },
    runtimeManager: { async sessionTranscript(_project,sessionId) { return sessionId === 'child-a' ? transcript : { ...transcript, sessionId: 'root-a', messages: [{ turnStartSeq: 5, parts: [{ type: 'tool', tool: 'match_assess', callId: 'root-call', status: 'pending', input: {taskId:'task-a'} }] }] }; } }, resolveSession: () => ({ child: true, parentSessionId: 'root-a', runId: 'run-a' }),
    runs: [{ id: 'run-a', sessionId: 'root-a', status: 'running' }], resolveTool: async (_project, name) => ({ name, pluginId: 'patient-matching', generation: 'generation-a' }), authenticatedUserId: 'actor-a' };
  return { options, transcript };
}

test('matching scope comes from the pending native call and current run, not caller claims', async () => {
  const f = fixture();
  f.options.request.invocation.rootSessionId = 'forged-root';
  const origin = await verifyPatientMatchingInvocation(f.options);
  assert.equal(origin.rootSessionId, 'root-a');
  assert.equal(origin.userId, 'actor-a');
  assert.equal(origin.pluginGeneration, 'generation-a');
});

test('changed arguments, completed/replayed calls, duplicate calls and unadmitted tools are refused', async () => {
  for (const mutate of [
    f => { f.options.request.invocation.args = { taskId: 'other', query: 'prior treatment' }; },
    f => { f.transcript.messages[0].parts[0].status = 'completed'; },
    f => { f.transcript.messages[0].parts.push({ ...f.transcript.messages[0].parts[0] }); },
    f => { f.transcript.turns[0].end = 10; },
    f => { f.options.resolveTool = async () => null; },
    f => { f.options.runs = []; },
    f => { f.options.request.invocation.args = { taskId: 'other-task', query: 'prior treatment' }; f.transcript.messages[0].parts[0].input = f.options.request.invocation.args; },
    f => { f.options.resolveSession = () => ({ child: true, parentSessionId: 'someone-elses-root', runId: 'run-a' }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(verifyPatientMatchingInvocation(f.options), { code: 'patient_matching_invocation_unavailable' });
  }
});
