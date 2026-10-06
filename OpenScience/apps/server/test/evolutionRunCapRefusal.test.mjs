// A run that exceeds its own spend cap is not retried from scratch every hour (review of
// 「循证进化」, 2026-10-05, F10, and F9's second half). The refusal of a run's spend limit does not say
// which limit: the day's allowance frees with the window, but a run's own cap does not — the same
// case costs the same again. The worker deferred both with a refunded attempt, so one meta-analysis
// case that needed ¥12 spent ¥10 every hour in a fresh project with a fresh dispatch id until the
// day's ¥50 was gone, then kept cycling, and every other job went without budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionWorker } from '../src/evolutionWorker.mjs';
import { HttpError } from '../src/security.mjs';

async function execute(error, refusalCause) {
  const recorded = [], waits = [];
  const job = { id: 'job', userId: 'operator', kind: 'evolution-evaluate', payload: {}, leaseToken: 'lease', attempts: 1, maxAttempts: 10 };
  const service = { jobs: { claim: async () => job, renew: async () => true, fail: async (...args) => { recorded.push(args); return { status: args[4].retry ? 'queued' : 'failed' }; } } };
  const worker = new EvolutionWorker({ lane:"heavy", service, config: { evolutionEnabled: true, evolutionMaxJobAttempts: 3 },
    callbacks: { evaluate: async () => { throw error; }, ...(refusalCause ? { refusalCause } : {}) } });
  worker.housekeeping = async () => {}; worker.resourceWait = async (...args) => { waits.push(args); };
  const result = await worker.tick({ kinds: ['evolution-evaluate'] });
  return { result, recorded, waits };
}
const typed = () => new HttpError(402, 'paper_gold_administrative_deferred', 'Observed native quota, window unknown');
const spent = () => Object.assign(new HttpError(409, 'runtime_spend_limit_reached', 'The development run did not complete.'));

test('a refusal that was the run\'s own cap ends the job with a resource card instead of requeueing it', async () => {
  for (const [label, error] of [['an evaluation unit', typed()], ['a development run', spent()]]) {
    const f = await execute(error, async () => 'run');
    assert.equal(f.result.status, 'failed', label);
    assert.equal(f.waits.length, 1, `${label}: the gap is filed as a resource wait`);
    assert.equal(f.waits[0][1].code, 'evolution_run_budget_exhausted');
    assert.deepEqual(f.recorded[0][4], { retry: false }, `${label}: no retry, no refunded attempt`);
    assert.equal(f.recorded[0][3].code, 'evolution_run_budget_exhausted');
  }
});

test('a refusal while the day\'s allowance is spent waits for the window, keeping its attempt, for either shape', async () => {
  for (const [label, error] of [['an evaluation unit', typed()], ['a development run', spent()]]) {
    const f = await execute(error, async () => 'day');
    assert.equal(f.result.status, 'queued', label);
    assert.equal(f.waits.length, 0);
    assert.deepEqual(f.recorded[0][4], { retry: true, refundAttempt: true, delayMs: 3600000 }, label);
  }
});

test('when nobody can say which limit refused, the evaluation is deferred as before and a development run keeps its bounded handling', async () => {
  for (const callback of [async () => { throw new Error('ledger unavailable'); }, undefined]) {
    const unknown = await execute(typed(), callback);
    assert.equal(unknown.result.status, 'queued');
    assert.equal(unknown.recorded[0][4].refundAttempt, true);
    const guessed = await execute(spent(), callback);
    assert.equal(guessed.recorded[0][4].refundAttempt, undefined, 'a development run is not waited for on a guess');
  }
  // Neither shape's lookalikes are refusals: a 409 with the evaluation's code, or any other code, keep their bounded handling.
  for (const error of [new HttpError(409, 'paper_gold_administrative_deferred', 'Unverified'), new HttpError(502, 'model_gateway_upstream_error', 'Provider')]) {
    const f = await execute(error, async () => 'day');
    assert.equal(f.recorded[0][4].refundAttempt, undefined, error.code);
  }
});
