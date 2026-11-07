import assert from 'node:assert/strict';
import test from 'node:test';
import { VcrConversationCompletions } from '../src/vcrConversationCompletions.mjs';

// Live defect D5: the second job of a run, finishing after the first one's continuation turn, was disclosed in the inbox only.
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
function fixture(payloads, { input = { requestId: 'cont' }, extraRuns = [] } = {}) {
  const rows = payloads.map((payload, index) => ({ id: `c${index}`, job_id: `job${index}`, study_id: 'study', user_id: 'user', project_id: 'p', root_session_id: 'root',
    dispatch_id: `vcr-completion-${String(index).repeat(32)}`, fingerprint: String(index).repeat(64), state: 'pending', created_at: iso(-60000),
    payload: { state: 'succeeded', resultId: `res${index}`, resultVersion: 1, partial: false, runId: 'run3', error: null, ...payload } }));
  const runs = [
    { id: 'run3', sessionId: 'root', status: 'succeeded', automated: false, kernelRequestIds: ['in3'], startedAt: iso(-300000), finishedAt: iso(-200000) },
    { id: 'run4', sessionId: 'root', status: 'succeeded', automated: true, dispatchId: 'vcr-completion-aaaa', kernelRequestIds: ['cont'], startedAt: iso(-190000), finishedAt: iso(-100000) },
    ...extraRuns];
  const dispatched = [];
  const store = { rows: async () => rows, query: async (_sql, values) => { const row = rows.find(r => r.id === values[0]); if (row && values.length >= 3) { row.state = values[1]; row.last_error = values[2]; } } };
  const service = new VcrConversationCompletions({ store, resolve: async () => ({ project: { id: 'p' }, user: { id: 'user' }, session: {} }),
    inbox: async () => ({ running: false, queued: 0 }), notify: async () => { service.notices++; }, readRuns: async () => runs,
    readAcknowledgment: async () => ({ observed: false }), readCurrentInput: async () => input,
    dispatch: async (_u, _p, _sid, _id, _text, options) => { await options.beforeReserve({ runs }); await options.beforePrompt(); dispatched.push(options.systemSupplement); return { dispatchStatus: 'accepted' }; } });
  service.notices = 0;
  return { service, rows, dispatched };
}
test('a job finishing after an earlier platform continuation wakes the conversation instead of staying inbox-only', async () => {
  const f = fixture([{ completedAt: iso(-50000) }]);
  await f.service.deliver();
  assert.equal(f.dispatched.length, 1);assert.equal(f.service.notices, 0);assert.equal(f.rows[0].state, 'delivered');assert.notEqual(f.rows[0].last_error, 'vcr_completion_disclosed');
});
test('a person typing after the continuation still gets the saved-result notice only', async () => {
  const f = fixture([{ completedAt: iso(-50000) }], { input: { requestId: 'typed_by_person' } });
  await f.service.deliver();
  assert.equal(f.dispatched.length, 0);assert.equal(f.service.notices, 1);assert.equal(f.rows[0].last_error, 'vcr_completion_disclosed');
});
test('two jobs finishing together after the turn share one continuation covering both', async () => {
  const f = fixture([{ completedAt: iso(-50000) }, { completedAt: iso(-49000) }]);
  await f.service.deliver();
  assert.equal(f.dispatched.length, 1);assert.match(f.dispatched[0], /res0/);assert.match(f.dispatched[0], /Also finished[^]*res1/);
  assert.deepEqual(f.rows.map(r => r.state), ['delivered', 'delivered']);assert.equal(f.rows[1].last_error, 'vcr_completion_covered');
});
test('a job that finished during the origin turn is disclosed and does not ride along the continuation', async () => {
  const f = fixture([{ completedAt: iso(-50000) }, { completedAt: iso(-250000) }]);
  await f.service.deliver();
  assert.equal(f.dispatched.length, 1);assert.doesNotMatch(f.dispatched[0], /res1/);
  assert.equal(f.rows[1].last_error, 'vcr_completion_disclosed');assert.equal(f.service.notices, 1);
});
test('a cancelled job never wakes the conversation nor rides along', async () => {
  const f = fixture([{ completedAt: iso(-50000), state: 'canceled', resultId: null }, { completedAt: iso(-49000) }]);
  await f.service.deliver();
  assert.equal(f.dispatched.length, 1);assert.doesNotMatch(f.dispatched[0], /job=job0/);assert.equal(f.rows[0].last_error, 'vcr_completion_canceled');
});
