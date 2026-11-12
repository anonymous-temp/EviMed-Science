// One discovery per task and request, answered within a call's bound (production 2026-11-11: discoveries of 63–115 s against the
// plugin's 110 s host call; two of four calls were cut off and each started the whole search again).
import assert from 'node:assert/strict';
import test from 'node:test';
import { joinableDiscovery } from '../src/patientMatchingDiscovery.mjs';

const scope = { tenantId: 'u1', projectId: 'p1', actorId: 'u1', conversationId: 's1' };
/** @param {Record<string, unknown>} input @param {AbortSignal} [signal] */
function call(input, signal) {
  const origin = Object.defineProperty({ userId: 'u1', projectId: 'p1', rootSessionId: 's1', pluginGeneration: 'g1' }, 'signal', { value: signal ?? new AbortController().signal, enumerable: false });
  return { scope, origin, study: { id: 'study1' }, meta: { taskId: 'matchTask_1' }, input, patient: { note: { hash: 'record-1' } } };
}
/** A discovery that finishes when the test says so, counting its starts and keeping the signal each start received. */
function controlledRun() {
  /** @type {Array<{resolve:(value:any)=>void,reject:(error:any)=>void,signal:AbortSignal,origin:any}>} */
  const starts = [];
  const run = (/** @type {any} */ args) => new Promise((resolve, reject) => { starts.push({ resolve, reject, signal: args.origin.signal, origin: args.origin }); });
  return { run, starts };
}
const done = (/** @type {string} */ searchId) => ({ status: 'complete', summary: 'Candidate discovery completed with recorded coverage and order.', data: { searchId }, artifacts: [] });

test('a call past its bound answers pending with the same call to make; that call joins the running search, which starts once', async () => {
  const { run, starts } = controlledRun(); const outcomes = [];
  const discover = joinableDiscovery(run, { waitMs: 20, runMs: 60_000, report: outcome => outcomes.push(outcome) });
  const input = { taskId: 'matchTask_1', query: 'EGFR non-small cell lung cancer', terms: ['osimertinib resistance'] };
  const first = await discover(call(input));
  assert.equal(first.status, 'pending');
  assert.deepEqual(first.data.next, { tool: 'match_discover', arguments: input });
  assert.match(first.summary, /same arguments/);
  const second = discover(call(structuredClone(input)));
  starts[0].resolve(done('search_1'));
  assert.deepEqual(await second, done('search_1'));
  assert.deepEqual(await discover(call(structuredClone(input))), done('search_1'), 'a finished search answers a repeated call');
  assert.equal(starts.length, 1);
  assert.deepEqual(outcomes, ['pending', 'joined', 'joined']);
});

test('another request, another patient record or another task is another search', async () => {
  const { run, starts } = controlledRun();
  const discover = joinableDiscovery(run, { waitMs: 5, runMs: 60_000 });
  const input = { taskId: 'matchTask_1', query: 'lung cancer' };
  await discover(call(input));
  await discover(call({ ...input, query: 'lung adenocarcinoma' }));
  await discover({ ...call(input), patient: { note: { hash: 'record-2' } } });
  await discover({ ...call(input), meta: { taskId: 'matchTask_2' } });
  assert.equal(starts.length, 4);
});

test('the search keeps running when the request that started it ends, and stops at its own bound', async () => {
  const { run, starts } = controlledRun();
  const discover = joinableDiscovery(run, { waitMs: 60_000, runMs: 30 });
  const request = new AbortController();
  const answer = discover(call({ taskId: 'matchTask_1', query: 'lung cancer' }, request.signal));
  await new Promise(resolve => setImmediate(resolve));
  request.abort();
  assert.equal((await answer).status, 'pending', 'the caller stops waiting at once');
  assert.equal(starts[0].signal.aborted, false, 'the search does not stop with its caller');
  assert.equal(starts[0].origin.userId, 'u1');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(starts[0].signal.aborted, true, 'the search stops at runMs');
});

test('a failed search is not kept: within the bound its error is the answer, and the next call starts again', async () => {
  const { run, starts } = controlledRun();
  const discover = joinableDiscovery(run, { waitMs: 1_000, runMs: 60_000 });
  const input = { taskId: 'matchTask_1', query: 'lung cancer' };
  const failing = discover(call(input));
  await new Promise(resolve => setImmediate(resolve));
  starts[0].reject(Object.assign(new Error('registry down'), { code: 'vcr_registry_unavailable' }));
  await assert.rejects(failing, { code: 'vcr_registry_unavailable' });
  const again = discover(call(input));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 2);
  starts[1].resolve(done('search_2'));
  assert.deepEqual(await again, done('search_2'));
});

test('a search that fails after its caller was answered pending is started again by the next call', async () => {
  const { run, starts } = controlledRun();
  const discover = joinableDiscovery(run, { waitMs: 5, runMs: 60_000 });
  const input = { taskId: 'matchTask_1', query: 'lung cancer' };
  assert.equal((await discover(call(input))).status, 'pending');
  starts[0].reject(new Error('rerank failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await discover(call(input))).status, 'pending');
  assert.equal(starts.length, 2);
});
