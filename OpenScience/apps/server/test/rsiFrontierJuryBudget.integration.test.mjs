// The frontier jury's labelling through the lab's real budget ledger on PostgreSQL: the model is a stand-in, the ledger's admission, holds and month rollover are not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { RsiCampaignBudget } from '../src/rsiCampaignBudget.mjs';
import { boundLab } from './rsiLabConfiguration.test.mjs';
import { JuryError, labelFrontierItems, loadGoldRows, selectFrontierExemplars } from '../../../evals/rsi-campaigns/frontier_labels.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const u = new URL(url); assert.ok(['localhost', '127.0.0.1', '::1'].includes(u.hostname)); assert.match(u.pathname, /evimed_test/); }
const skip = { skip: !url && 'Disposable localhost PostgreSQL required' };
const exemplars = selectFrontierExemplars(await loadGoldRows(new URL('../../../evals/frontier-selection/gold.jsonl', import.meta.url)));
const items = ['a', 'b'].map((id) => ({ id, today: '2026-10-25', text: { title_raw: `Item ${id}`, source_name: 'Source', lang: 'en', excerpt: `Text of ${id}` } }));
const USAGE = { cacheHit: 1000, cacheMiss: 500, output: 50 }, USAGE_CNY = 0.0093;
const answers = async () => ({ text: '{"worth":"ok","why":"x"}', usage: USAGE, requestId: null, finishReason: 'stop' });
const refusing = async () => { throw new JuryError('jury_http_400', { billed: false }); };

/** @param {(lab:{ledger:RsiCampaignBudget, run:(callModel:any, budget?:any)=>Promise<any>, rows:()=>Promise<any[]>, at:(time:string)=>void, tightened:(budget:any)=>RsiCampaignBudget})=>Promise<void>} scenario */
async function withLab(scenario, limits = {}) {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `rsi_${randomUUID().replaceAll('-', '')}`, campaignId = 'frontier-selection-2026-10';
  let time = '2026-10-26T01:00:00Z';
  const now = () => time;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI frontier jury','development')", [owner]);
    const configuration = boundLab(owner);
    Object.assign(configuration.budget, limits);
    const ledger = new RsiCampaignBudget({ database, configuration, now });
    await scenario({
      ledger,
      run: (callModel, budget = ledger) => labelFrontierItems({ items, exemplars, callModel, budget, campaignId, now }),
      rows: async () => (await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='rsi-budget-reservation'", [owner])).rows.map((row) => row.payload),
      at: (value) => { time = value; },
      tightened: (budget) => new RsiCampaignBudget({ database, configuration: { ...configuration, budget: { ...configuration.budget, ...budget } }, now }),
    });
  } finally { await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]); await database.close(); }
}

test('a batch reserves its upper bound, spends and settles the priced actual', skip, () => withLab(async ({ run, rows }) => {
  const result = await run(answers);
  assert.deepEqual([result.stopped, result.labels.length, result.calls], [null, 2, 4]);
  const [row, ...others] = await rows();
  assert.deepEqual(others, []);
  assert.deepEqual([row.state, row.outcome, row.campaignId, row.month], ['settled', 'success', 'frontier-selection-2026-10', '2026-10']);
  assert.ok(Math.abs(row.actualCny - 4 * USAGE_CNY) < 1e-9 && row.reservedCny > row.actualCny, `${row.actualCny} of ${row.reservedCny}`);
}));

test('failed starts never lock the month on the real ledger: each settled key answers already-dispatched, the next is free, and a healthy start labels everything', skip, () => withLab(async ({ run, rows }) => {
  for (let start = 0; start < 6; start++) assert.equal((await run(refusing)).stopped, 'jury_unavailable', `start ${start}`);
  const healthy = await run(answers);
  assert.deepEqual([healthy.stopped, healthy.labels.length, healthy.calls], [null, 2, 4]);
  const records = await rows();
  assert.equal(new Set(records.map((row) => row.stageKey)).size, 7);
  assert.deepEqual(records.filter((row) => row.outcome === 'failed').map((row) => row.actualCny), [0, 0, 0, 0, 0, 0]);
  assert.equal(records.filter((row) => row.outcome === 'success').length, 1);
}));

test('a batch settled in an earlier month is answered month-expired, and the same batch reserves under a fresh key in the new one', skip, () => withLab(async ({ run, rows, at }) => {
  assert.equal((await run(refusing)).stopped, 'jury_unavailable');
  at('2026-10-31T16:00:00Z');
  const next = await run(answers);
  assert.deepEqual([next.stopped, next.labels.length], [null, 2]);
  const records = await rows();
  assert.deepEqual(records.map((row) => [row.month, row.outcome]).sort(), [['2026-10', 'failed'], ['2026-11', 'success']]);
}));

test('a reservation under limits since changed is not a lock: the next key is taken', skip, () => withLab(async ({ run, tightened, rows }) => {
  assert.equal((await run(refusing)).stopped, 'jury_unavailable');
  const next = await run(answers, tightened({ campaignCny: 500 }));
  assert.deepEqual([next.stopped, next.labels.length], [null, 2]);
  assert.equal((await rows()).length, 2);
}));

test('holds from interrupted starts stay against the ceiling: the search for a free key ends in the budget\'s own refusal, with nothing called', skip, () => withLab(async ({ ledger, run, rows }) => {
  // A start that dies before it settles (the process was killed): its hold stays in flight.
  const interrupted = { reserve: (input) => ledger.reserve(input), beginSpend: (input) => ledger.beginSpend(input), settle: async () => { throw new Error('killed'); } };
  let starts = 0, refusal = null;
  while (!refusal && starts < 50) {
    starts++;
    const result = await run(answers, interrupted).catch((error) => { assert.equal(error.message, 'killed'); return null; });
    if (result) { refusal = result.stopped; assert.equal(result.calls, 0); }
  }
  assert.equal(refusal, 'campaign_budget_exceeded');
  const records = await rows();
  assert.equal(records.length, starts - 1, 'one hold per interrupted start, none for the refused one');
  assert.ok(records.every((row) => row.state === 'in-flight'));
  assert.ok(records.reduce((sum, row) => sum + row.reservedCny, 0) <= 1, 'the holds never passed the campaign\'s ceiling');
}, { campaignCny: 1 }));

test('a beginSpend the ledger refuses (the month turned between reserve and begin) releases its hold, and the next start goes on', skip, () => withLab(async ({ ledger, run, rows, at }) => {
  const turning = { reserve: (input) => ledger.reserve(input), settle: (input) => ledger.settle(input), beginSpend: (input) => { at('2026-10-31T16:00:00Z'); return ledger.beginSpend(input); } };
  const stopped = await run(answers, turning);
  assert.deepEqual([stopped.stopped, stopped.calls], ['campaign_budget_month_expired', 0]);
  const [held] = await rows();
  assert.deepEqual([held.state, held.outcome, held.actualCny], ['settled', 'failed', 0]);
  const next = await run(answers);
  assert.deepEqual([next.stopped, next.labels.length], [null, 2]);
}));
