// What a tenant's call of a published tool holds while it runs, and how many it may have
// (review of 「循证进化」, 2026-10-05, S4). The gateway used to run the whole execution inside the
// admission transaction: the host-wide heavy-work advisory lock and one pooled connection were held
// for up to 75 s per call, so a run that fanned out eight calls queued eight transactions behind the
// lock and exhausted the ten-connection pool for every route of every tenant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionToolAdmission } from '../src/evolutionToolAdmission.mjs';

const config = { evolutionToolMaxConcurrentPerProject: 2, evolutionToolCallsPerMinute: 4, evolutionDailyBudgetCny: 50 };
const scope = (projectId, userId = 'owner') => ({ project: { id: projectId, userId } });
const deferred = () => { /** @type {any} */ let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

/** A database whose transaction count is observable, and whose pool is as small as production's matters here: one. */
function fixture(overrides = {}) {
  const state = { open: 0, maxOpen: 0, transactions: 0, locks: 0, hostFree: true, cost: 0, clock: 1_000_000 };
  const database = { async transaction(/** @type {any} */ run) {
    state.open += 1; state.maxOpen = Math.max(state.maxOpen, state.open); state.transactions += 1;
    try { return await run({}); } finally { state.open -= 1; }
  } };
  const admission = createEvolutionToolAdmission({ config: { ...config, ...overrides }, database, canRun: async () => true,
    heavyWorkAdmission: async () => { state.locks += 1; return state.hostFree; }, isInternalProject: (id) => id.startsWith('eval-paper-'),
    dailyCost: async () => state.cost, now: () => state.clock });
  return { state, admission };
}

test('neither the heavy-work transaction nor a pooled connection is open while the tool runs', async () => {
  const { state, admission } = fixture();
  const seen = [];
  const results = await Promise.all(['a', 'b'].map((project) => admission.admit(scope(project), async () => { seen.push(state.open); await new Promise((resolve) => setTimeout(resolve, 5)); return project; })));
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(seen, [0, 0], 'the admission transaction is over before the execution begins');
  assert.equal(state.locks, 2, 'the host check still happens, once per call');
  assert.equal(state.open, 0);
});

test('one project cannot have more than its share of calls running, and another project is unaffected', async () => {
  const { admission } = fixture();
  const gates = [deferred(), deferred()];
  const running = gates.map((gate) => admission.admit(scope('busy'), () => gate.promise));
  await assert.rejects(admission.admit(scope('busy'), async () => 'third'), (error) => error.status === 429 && error.code === 'evolution_tool_rate_limited');
  assert.equal(await admission.admit(scope('quiet'), async () => 'served'), 'served', 'another tenant is not queued behind it');
  assert.equal(await admission.admit(scope('busy', 'someone-else'), async () => 'other owner'), 'other owner', 'the key is the owner and the project');
  gates[0].resolve('one');
  assert.equal(await running[0], 'one');
  assert.equal(await admission.admit(scope('busy'), async () => 'again'), 'again', 'a finished call frees its place');
  gates[1].resolve('two');
  await running[1];
  assert.equal(admission.counters.refusedProjectConcurrency, 1);
});

test('a project that fails does not keep its place', async () => {
  const { admission } = fixture({ evolutionToolMaxConcurrentPerProject: 1 });
  await assert.rejects(admission.admit(scope('p'), async () => { throw new Error('tool failed'); }), /tool failed/);
  assert.equal(await admission.admit(scope('p'), async () => 'next'), 'next');
});

test('calls in a minute are bounded per project, and the window moves on', async () => {
  const { state, admission } = fixture();
  for (let call = 0; call < config.evolutionToolCallsPerMinute; call += 1) await admission.admit(scope('p'), async () => call);
  await assert.rejects(admission.admit(scope('p'), async () => 'over'), (error) => error.status === 429 && error.code === 'evolution_tool_rate_limited');
  assert.equal(await admission.admit(scope('q'), async () => 'other'), 'other');
  state.clock += 60_001;
  assert.equal(await admission.admit(scope('p'), async () => 'new window'), 'new window');
  assert.equal(admission.counters.refusedProjectRate, 1);
});

test('host capacity and the module budget still refuse, by name, and a refusal frees its place', async () => {
  const { state, admission } = fixture({ evolutionToolMaxConcurrentPerProject: 1 });
  state.hostFree = false;
  await assert.rejects(admission.admit(scope('p'), async () => 'never'), (error) => error.status === 503 && error.code === 'evolution_temporarily_unavailable');
  state.hostFree = true;
  state.cost = 50;
  await assert.rejects(admission.admit(scope('eval-paper-x'), async () => 'never'), (error) => error.status === 402 && error.code === 'usage_budget_exceeded');
  assert.equal(await admission.admit(scope('p'), async () => 'a researcher project is not held to the module budget'), 'a researcher project is not held to the module budget');
  assert.deepEqual({ ...admission.counters }, { admitted: 1, refusedHostCapacity: 1, refusedBudget: 1, refusedProjectConcurrency: 0, refusedProjectRate: 0, refusedBusy: 0 });
});
