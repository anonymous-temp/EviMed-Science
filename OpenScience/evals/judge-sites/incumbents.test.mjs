import assert from 'node:assert/strict';
import test from 'node:test';
import { createIncumbents, createMeter } from './incumbents.mjs';

const answer = (usage, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage }), { status });

test('the meter prices the provider\'s own token counts at the list price and attributes them to the arm call that made them', async () => {
  const meter = createMeter({ inner: async () => answer({ prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 500, completion_tokens: 100 }), sleep: async () => {} });
  const first = await meter.measure(() => meter.fetchImpl('https://provider.example/chat', { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash' }) }));
  const second = await meter.measure(async () => { await meter.fetchImpl('u', { body: JSON.stringify({ model: 'deepseek-flash' }) }); await meter.fetchImpl('u', { body: JSON.stringify({ model: 'deepseek-flash' }) }); });
  // (1000 x 0.04 + 500 x 2 + 100 x 8) per million
  assert.ok(Math.abs(first.cost - 0.00184) < 1e-9, String(first.cost));
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 2);
  assert.ok(Math.abs(second.cost - 2 * 0.00184) < 1e-9);
  assert.equal(meter.totals.calls, 3);
  assert.deepEqual(meter.totals.tokens, { cacheHit: 3000, cacheMiss: 1500, output: 300 });
  // The body is still readable by the caller after the meter read it.
  const response = await meter.fetchImpl('u', { body: JSON.stringify({ model: 'deepseek-flash' }) });
  assert.deepEqual((await response.json()).choices[0].message, { content: '{}' });
});

test('a rate-limited call is retried after a pause that is neither counted in the arm\'s latency nor billed twice', async () => {
  let calls = 0;
  const pauses = [];
  const meter = createMeter({ inner: async () => { calls += 1; return calls === 1 ? answer(null, 429) : answer({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 0 }); },
    sleep: async (ms) => { pauses.push(ms); await new Promise((resolve) => setTimeout(resolve, 30)); } });
  const arm = await meter.measure(() => meter.fetchImpl('u', { body: JSON.stringify({ model: 'deepseek-flash' }) }));
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [3000]);
  assert.equal(meter.totals.retried, 1);
  assert.equal(arm.calls, 1, 'only the answered call is booked');
  assert.ok(arm.ms < 25, `the 30 ms pause was counted: ${arm.ms}`);
  assert.ok(Math.abs(arm.cost - 0.002) < 1e-9);
});

test('the fixed originals of J4, J15 and J18 are the frozen pattern and two fixed verdicts, with no model behind them', async () => {
  const meter = createMeter({ inner: async () => { throw new Error('no model call expected'); } });
  const arms = createIncumbents({ config: { deepseekProviderEnabled: true, deepseekApiKey: 'not-a-key', deepseekModel: 'deepseek-flash' }, meter });
  assert.equal((await arms.J4({ input: { line: '本报告由 mcp__evimed__search 工具调用生成' } })).value.leakage, true);
  assert.equal((await arms.J4({ input: { line: '二甲双胍降低 HbA1c 约 0.9 个百分点。' } })).value.leakage, false);
  assert.deepEqual((await arms.J15({})).value, { relation: 'related' });
  assert.deepEqual((await arms.J18({})).value, { relation: 'different' });
  assert.equal(meter.totals.calls, 0);
});
