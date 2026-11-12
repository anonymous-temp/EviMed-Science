import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignStep, campaignLedger, campaignMessagesInvoice, createCampaignReadGate, freezeClinicalSubset } from './campaign-host.mjs';
import { priceUsage } from '../../packages/domain/index.mjs';
test('driver preserves all SIGIR candidates and never retries an unsaved clinical child', () => {
  const state = { board: 'sigir', case: { note: 'source', candidateIds: ['NCT00000001', 'NCT00000002'] }, nativeSegments: 0 };
  assert.deepEqual(campaignStep(state).args, { messageSeq: 1 });
  state.context = { taskId: 'task', subjectKey: 'subject' };
  assert.equal(campaignStep(state).tool, 'match_assess');
  state.nativeSegments = 1;
  assert.deepEqual(campaignStep(state), {});
  assert.equal(state.stopReason, 'native_assessment_no_saved_progress');
  assert.deepEqual(campaignStep({ board: 'trec2023', stopReason: 'discovery_failed', context: { taskId: 'task' }, case: {} }), {});
  delete state.stopReason; state.lastSavedSegment = 1; state.result = { rows: [{ current: true }, { current: false }] };
  assert.equal(campaignStep(state).tool, 'match_assess');
  state.result.rows[1].current = true;
  assert.deepEqual(campaignStep(state), {});
});
test('an explicit source repair acknowledges one historical failure without admitting a repeated failure', () => {
  const state = { board: 'sigir', case: {}, context: { taskId: 'same-task', subjectKey: 'same-person' }, nativeSegments: 3, lastSavedSegment: 2,
    sourceRepair: { acceptedFailureThroughSegment: 3 } };
  assert.equal(campaignStep(state).tool, 'match_assess');
  state.nativeSegments = 4;
  assert.deepEqual(campaignStep(state), {});
  assert.equal(state.stopReason, 'native_assessment_no_saved_progress');
});
test('Messages invoice counts cache writes as misses and refuses an unexpected served model', () => {
  const events = model => Buffer.from(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg', model, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 0 } } })}\n\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 20 } })}\n`);
  const invoice = campaignMessagesInvoice(events('deepseek-flash'), new Date('2026-11-05T12:00:00Z'));
  assert.deepEqual(invoice.usage, { promptTokens: 105, cacheHitTokens: 90, cacheMissTokens: 15, completionTokens: 20 });
  assert.equal(invoice.price.cost, priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheHit: 90, cacheMiss: 15, output: 20, peak: false }).cost);
  assert.equal(campaignMessagesInvoice(events('deepseek-pro'), new Date()).validModel, false);
  assert.equal(invoice.finished, false);
  assert.equal(campaignMessagesInvoice(Buffer.concat([events('deepseek-flash'), Buffer.from('data: {"type":"message_stop"}\n\n')]), new Date()).finished, true);
});
test('billing wrapper releases the shared fence if PG refuses before dispatch', async () => {
  const calls = [], budget = { reserve: async input => calls.push(['reserve', input]), settle: async input => calls.push(['settle', input]) };
  const real = { reserveModel: async () => { throw new Error('durable cap'); }, release: async () => calls.push(['pg-release']) };
  const ledger = campaignLedger(real, budget);
  await assert.rejects(ledger.reserveModel({ id: 'one', model: 'deepseek-flash', estimatedCost: 1 }), /durable cap/);
  assert.deepEqual(calls[1], ['settle', { id: 'one', costCny: 0 }]);
  await ledger.release('owner', 'two', 'provider_not_accepted');
  assert.deepEqual(calls.at(-1), ['settle', { id: 'two', costCny: 0 }]);
});
test('unpaid native checks refuse every provider before either billing fence', async () => {
  let attempts = 0;
  const denied = async () => { attempts++; throw new Error('Must not reserve'); };
  const ledger = campaignLedger({ reserveModel: denied }, { reserve: denied }, false);
  for (const model of ['deepseek-flash', 'qwen3.7-text-rerank', 'qwen3.7-text-embedding', 'jev-1.14.0']) await assert.rejects(ledger.reserveModel({ id: model, model, estimatedCost: 1 }), /paid calls are disabled/);
  assert.equal(attempts, 0);
});
test('eight topic discoveries and clinical preparations share eight source reads without lost work', async () => {
  const gate = createCampaignReadGate(8); let active = 0, maximum = 0;
  const read = async value => { active++; maximum = Math.max(maximum, active); try { await new Promise(resolve => setTimeout(resolve, 1)); if (value === 7) throw new Error('preserved source failure'); return value; } finally { active--; } };
  const evidence = Object.fromEntries(['registryRecord', 'judgmentRecord'].map(name => [name, value => gate(() => read(value))]));
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => evidence[index < 32 ? 'registryRecord' : 'judgmentRecord'](index)));
  assert.equal(maximum, 8); assert.equal(active, 0);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 39);
  assert.equal(results[7].status, 'rejected');
  assert.deepEqual(results.filter(row => row.status === 'fulfilled').map(row => row.value), Array.from({ length: 40 }, (_, i) => i).filter(i => i !== 7));
});
test('clinical20 is a persisted subset of the unchanged full100 ranking with its collection and parent receipt', async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `NCT${String(index + 1).padStart(8, '0')}`), full = { id: 'full-search', items: ids.map(registryId => ({ registryId })), request: { condition: 'original source' }, collection: { id: 'frozen', revision: 'exact' }, registries: [], rerank: { incomingOrder: [...ids].reverse(), finalOrder: ids, model: 'qwen3.7-text-rerank' } }, original = structuredClone(full);
  let saved; const searches = { get: async () => full, save: async (_study, value) => { saved = value; return 'clinical-search'; } };
  const selected = await freezeClinicalSubset({ searches, study: { id: 'study' }, subjectKey: 'subject', discovery: { searchId: full.id }, depth: 20 });
  assert.deepEqual(full, original); assert.equal(selected.parentCount, 100); assert.equal(selected.selectedCount, 20); assert.equal(saved.items.length, 20);
  assert.deepEqual(saved.items.map(row => row.registryId), ids.slice(0, 20)); assert.deepEqual(saved.collection, full.collection);
  assert.equal(saved.request.clinicalSubset.parentSearchId, full.id); assert.deepEqual(saved.rerank.incomingOrder, ids.slice(0, 20).reverse());
  assert.equal(campaignStep({ board: 'trec2023', case: {}, context: { taskId: 'task', subjectKey: 'subject' }, discovery: { searchId: full.id }, clinicalSelection: selected, nativeSegments: 0 }).args.searchId, 'clinical-search');
});
