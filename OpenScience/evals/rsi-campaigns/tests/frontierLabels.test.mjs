import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRONTIER_JURY_VERSION, JuryError, calibrateJury, calibrationItems, dashscopeCaller, frontierJuryMessages, frontierJuryPromptDigest, frontierJuryVersion,
  goldItemText, juryQualified, labelFrontierItems, loadGoldRows, loadLabelItems, parseJuryAnswer, selectFrontierExemplars,
} from '../frontier_labels.mjs';

const gold = await loadGoldRows(new URL('../../frontier-selection/gold.jsonl', import.meta.url));
const exemplars = selectFrontierExemplars(gold);
const NOW = () => '2026-10-26T04:00:00.000Z';
const tmp = () => mkdtemp(join(tmpdir(), 'frontier-labels-'));
const item = (id, extra = {}) => ({ id, text: { title_raw: `Item ${id}`, source_name: 'Source', source_type: 'media', journal: null, publication_types: [], published_at: '2026-10-25T00:00:00.000Z', date_precision: 'day', lang: 'en', excerpt: `Text of ${id}` }, ...extra });
/** CNY of one call's usage at qwen3.8-max: 1.5 / 12 / 36 per million tokens. */
const USAGE = { cacheHit: 1000, cacheMiss: 500, output: 50 };
const USAGE_CNY = 0.0093;

/** An in-memory ledger with the real one's method shapes: a settled or in-flight record answers `campaign_budget_already_dispatched`. */
class FakeBudget {
  constructor({ allowReserves = Infinity, refusal = 'campaign_budget_exceeded', held = [] } = {}) {
    this.allowReserves = allowReserves; this.refusal = refusal; this.records = new Map(held.map((key) => [key, { state: 'in-flight' }])); this.log = []; this.granted = 0;
  }
  async reserve({ campaignId, stageKey, amountCny }) {
    this.log.push({ op: 'reserve', campaignId, stageKey, amountCny });
    const existing = this.records.get(stageKey);
    if (existing && existing.state !== 'reserved') return { authorized: false, reason: 'campaign_budget_already_dispatched' };
    if (!existing && this.granted >= this.allowReserves) return { authorized: false, reason: this.refusal };
    if (!existing) this.granted++;
    this.records.set(stageKey, { state: 'reserved', amountCny });
    return { authorized: true, reason: null };
  }
  async beginSpend({ stageKey }) { this.log.push({ op: 'begin', stageKey }); this.records.get(stageKey).state = 'in-flight'; return { authorized: true, reason: null }; }
  async settle({ stageKey, outcome, actualCny }) { this.log.push({ op: 'settle', stageKey, outcome, actualCny }); this.records.get(stageKey).state = 'settled'; return { authorized: true, reason: null }; }
  get settles() { return this.log.filter((entry) => entry.op === 'settle'); }
  get reserves() { return this.log.filter((entry) => entry.op === 'reserve'); }
}

/** A model that answers by item title and by which exemplar order the prompt carries (A = given order, B = reversed). */
function fakeModel(answers, { fail = () => null, usage = USAGE } = {}) {
  const systemA = frontierJuryMessages(item('x').text, { exemplars, today: '2026-10-25' })[0].content;
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const callModel = async (messages) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    const id = /Title: Item (\S+)/.exec(messages[1].content)[1], pass = messages[0].content === systemA ? 'A' : 'B';
    calls.push({ id, pass });
    const failure = fail(id, pass);
    if (failure) throw failure;
    const worth = answers[id]?.[pass === 'A' ? 0 : 1];
    return { text: typeof worth === 'string' && worth.startsWith('{') ? worth : JSON.stringify({ worth, why: `why ${id}${pass}` }), usage, requestId: `req-${id}-${pass}`, finishReason: 'stop' };
  };
  return { callModel, calls, get maxInFlight() { return maxInFlight; } };
}

test('exemplars: ten odd-n rows, 4 pick / 4 ok / 2 no, deterministic, with readable text', () => {
  assert.equal(exemplars.length, 10);
  assert.deepEqual(['pick', 'ok', 'no'].map((worth) => exemplars.filter((exemplar) => exemplar.worth === worth).length), [4, 4, 2]);
  assert.ok(exemplars.every((exemplar) => exemplar.n % 2 === 1 && exemplar.text.excerpt.length >= 200));
  assert.deepEqual(selectFrontierExemplars(gold).map((exemplar) => exemplar.n), exemplars.map((exemplar) => exemplar.n));
  assert.notEqual(exemplars.at(-1).worth, exemplars.at(-2).worth);
});

test('messages never carry an even-n gold row or a platform-written field', () => {
  const row = gold.find((entry) => entry.n % 2 === 0);
  const text = { ...goldItemText(row), title_zh: 'ZH-TITLE-MARK', summary_zh: 'ZH-SUMMARY-MARK', evidence_type: 'ET-MARK', genre: 'GENRE-MARK', score_total: 98765, live: { total: 4321 } };
  const [system, user] = frontierJuryMessages(text, { exemplars, today: '2026-10-25' });
  assert.equal(system.role, 'system'); assert.equal(user.role, 'user');
  assert.ok(user.content.startsWith('今天是 2026-10-25（Asia/Shanghai）'));
  assert.ok(user.content.includes(row.title_raw));
  for (const mark of ['ZH-TITLE-MARK', 'ZH-SUMMARY-MARK', 'ET-MARK', 'GENRE-MARK', '98765', '4321']) assert.ok(!user.content.includes(mark) && !system.content.includes(mark), mark);
  for (const even of gold.filter((entry) => entry.n % 2 === 0)) {
    assert.ok(!system.content.includes(even.id), `even row id ${even.n} in system`);
    assert.ok(!system.content.includes(even.title_raw), `even row ${even.n} in system`);
  }
  for (const exemplar of exemplars) {
    const source = gold.find((entry) => entry.n === exemplar.n);
    assert.ok(system.content.includes(source.title_raw));
    // for a Chinese-language source the platform's title is the source's own title; only a written-over title is a leak
    if (source.title_zh !== source.title_raw) assert.ok(!system.content.includes(source.title_zh));
    assert.ok(!system.content.includes(source.summary_zh));
  }
  assert.throws(() => frontierJuryMessages(text, { exemplars: [{ ...exemplars[0], n: 2 }], today: '2026-10-25' }), /jury_exemplar_calibration_row/);
  assert.throws(() => frontierJuryMessages(text, { exemplars, today: 'yesterday' }), /jury_today_invalid/);
});

test('the system message is byte-stable per exemplar order and the date lives in the user message', () => {
  const a1 = frontierJuryMessages(item('1').text, { exemplars, today: '2031-01-02' }), a2 = frontierJuryMessages(item('2').text, { exemplars, today: '2031-03-04' });
  assert.equal(a1[0].content, a2[0].content);
  assert.ok(!a1[0].content.includes('2031') && a1[1].content.includes('2031-01-02'));
  const b = frontierJuryMessages(item('1').text, { exemplars: [...exemplars].reverse(), today: '2031-01-02' });
  assert.notEqual(b[0].content, a1[0].content);
  assert.ok(a1[0].content.indexOf(exemplars[0].text.title_raw) < a1[0].content.indexOf(exemplars.at(-1).text.title_raw));
  assert.ok(b[0].content.indexOf(exemplars[0].text.title_raw) > b[0].content.indexOf(exemplars.at(-1).text.title_raw));
  assert.match(frontierJuryPromptDigest(), /^[0-9a-f]{64}$/);
  assert.equal(frontierJuryVersion(exemplars), frontierJuryVersion([...exemplars].reverse()));
  assert.ok(frontierJuryVersion(exemplars).startsWith(FRONTIER_JURY_VERSION));
  assert.notEqual(frontierJuryVersion(exemplars), frontierJuryVersion(exemplars.slice(1)));
});

test('parseJuryAnswer accepts a valid answer and rejects the rest', () => {
  assert.deepEqual(parseJuryAnswer('{"worth":"pick","why":"big RCT"}'), { worth: 'pick', why: 'big RCT' });
  assert.deepEqual(parseJuryAnswer('```json\n{"worth":"OK","why":"x"}\n```'), { worth: 'ok', why: 'x' });
  assert.deepEqual(parseJuryAnswer('{"worth":"no"}'), { worth: 'no', why: '' });
  assert.equal(parseJuryAnswer('{"worth":"pick","why":"' + 'y'.repeat(300) + '"}').why.length, 200);
  for (const bad of ['', 'not json', '{"worth":"maybe","why":"x"}', '{"why":"x"}', '[]', 'null', '{"worth":1}', undefined, null, 42]) assert.equal(parseJuryAnswer(bad), null, String(bad));
});

test('two agreeing passes stand, disagreement and an invalid answer abstain', async () => {
  const model = fakeModel({ a: ['pick', 'pick'], b: ['pick', 'ok'], c: ['no', 'no'], d: ['{"worth":"bogus"}', 'ok'] });
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: ['a', 'b', 'c', 'd'].map((id) => item(id)), exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  const by = Object.fromEntries(result.labels.map((label) => [label.id, label]));
  assert.deepEqual([by.a.worth, by.a.basis], ['pick', 'jury-agree']);
  assert.deepEqual([by.b.worth, by.b.basis], [null, 'jury-disagree']);
  assert.deepEqual([by.c.worth, by.c.basis], ['no', 'jury-agree']);
  assert.deepEqual([by.d.worth, by.d.basis], [null, 'jury-invalid']);
  assert.deepEqual(by.b.passes.map((pass) => [pass.pass, pass.worth]), [['A', 'pick'], ['B', 'ok']]);
  assert.equal(result.calls, 8); assert.equal(result.stopped, null); assert.equal(result.incomplete, 0);
});

test('the two passes read the exemplars in opposite orders', async () => {
  const seen = [];
  const callModel = async (messages) => { seen.push(messages[0].content); return { text: '{"worth":"ok","why":""}', usage: USAGE, requestId: null, finishReason: 'stop' }; };
  await labelFrontierItems({ items: [item('a')], exemplars, callModel, budget: new FakeBudget(), campaignId: 'c1', now: NOW });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], frontierJuryMessages(item('a').text, { exemplars, today: '2026-10-25' })[0].content);
  assert.equal(seen[1], frontierJuryMessages(item('a').text, { exemplars: [...exemplars].reverse(), today: '2026-10-25' })[0].content);
});

test('the user message date is the item day, else the injected clock in Asia/Shanghai', async () => {
  const users = [];
  const callModel = async (messages) => { users.push(messages[1].content.split('\n')[0]); return { text: '{"worth":"ok","why":""}', usage: USAGE, requestId: null, finishReason: 'stop' }; };
  await labelFrontierItems({ items: [item('a', { today: '2026-10-20' }), item('b')], exemplars, callModel, budget: new FakeBudget(), campaignId: 'c1', now: () => '2026-10-26T17:00:00.000Z', concurrency: 1 });
  assert.deepEqual([...new Set(users)], ['今天是 2026-10-20（Asia/Shanghai）', '今天是 2026-10-27（Asia/Shanghai）']);
});

test('a refused reservation stops cleanly before any call', async () => {
  const model = fakeModel({ a: ['pick', 'pick'] });
  const budget = new FakeBudget({ allowReserves: 0, refusal: 'campaign_budget_exceeded' });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  assert.equal(result.stopped, 'campaign_budget_exceeded');
  assert.equal(model.calls.length, 0); assert.equal(result.calls, 0); assert.equal(result.costCny, 0);
  assert.deepEqual(result.labels, []); assert.equal(result.incomplete, 1);
  assert.equal(budget.log.filter((entry) => entry.op !== 'reserve').length, 0);
});

test('a later refusal keeps what the earlier batches finished', async () => {
  const model = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] });
  const budget = new FakeBudget({ allowReserves: 1 });
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', batchSize: 2, now: NOW });
  assert.equal(result.stopped, 'campaign_budget_exceeded');
  assert.deepEqual(result.labels.map((label) => [label.id, label.worth]), [['a', 'pick']]);
  assert.equal(result.incomplete, 1); assert.equal(result.calls, 2);
});

test('a refused beginSpend stops and no call is made', async () => {
  const budget = new FakeBudget(); budget.beginSpend = async () => ({ authorized: false, reason: 'campaign_budget_month_expired' });
  const model = fakeModel({ a: ['pick', 'pick'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  assert.equal(result.stopped, 'campaign_budget_month_expired'); assert.equal(model.calls.length, 0);
});

test('settlement is the priced usage, reserved ahead as an upper bound, spend begun before the calls', async () => {
  const model = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] });
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: model.callModel, budget, campaignId: 'camp-9', stagePrefix: 'jury-x', now: NOW });
  assert.deepEqual(budget.log.map((entry) => entry.op), ['reserve', 'begin', 'settle']);
  const [reserve] = budget.reserves, [settle] = budget.settles;
  assert.equal(reserve.campaignId, 'camp-9'); assert.match(reserve.stageKey, /^jury-x:[0-9a-f]{16}$/);
  assert.equal(settle.stageKey, reserve.stageKey); assert.equal(settle.outcome, 'success');
  assert.ok(Math.abs(settle.actualCny - 4 * USAGE_CNY) < 1e-9, String(settle.actualCny));
  assert.ok(Math.abs(result.costCny - 4 * USAGE_CNY) < 1e-9);
  // every prompt character priced as an uncached token, plus the output cap, per call
  assert.ok(reserve.amountCny > 4 * 0.1 && reserve.amountCny > settle.actualCny * 5, String(reserve.amountCny));
  assert.ok(Math.abs(reserve.amountCny * 1e8 - Math.round(reserve.amountCny * 1e8)) < 1e-6);
});

test('batches reserve and settle separately and bound the calls in flight', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const model = fakeModel(Object.fromEntries(ids.map((id) => [id, ['ok', 'ok']])));
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: ids.map((id) => item(id)), exemplars, callModel: model.callModel, budget, campaignId: 'c1', batchSize: 4, concurrency: 3, now: NOW });
  assert.equal(budget.reserves.length, 3); assert.equal(budget.settles.length, 3);
  assert.equal(new Set(budget.reserves.map((entry) => entry.stageKey)).size, 3);
  assert.ok(model.maxInFlight <= 3 && model.maxInFlight > 1, String(model.maxInFlight));
  assert.equal(result.labels.length, 5); assert.equal(result.calls, 10);
});

test('a provider rejection is not charged, an unknown failure is charged at its upper bound, and the item stays incomplete', async () => {
  const rejected = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] }, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new JuryError('jury_http_500', { retryable: true, billed: false }) : null) });
  const budget = new FakeBudget();
  const first = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: rejected.callModel, budget, campaignId: 'c1', now: NOW });
  assert.equal(budget.settles[0].outcome, 'failed');
  assert.ok(Math.abs(budget.settles[0].actualCny - 3 * USAGE_CNY) < 1e-9);
  assert.deepEqual(first.labels.map((label) => label.id), ['a']); assert.equal(first.incomplete, 1); assert.equal(first.stopped, null);

  const unknown = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] }, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new Error('socket hang up') : null) });
  const second = new FakeBudget();
  await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: unknown.callModel, budget: second, campaignId: 'c1', now: NOW });
  const ceiling = second.reserves[0].amountCny / 4;
  assert.ok(Math.abs(second.settles[0].actualCny - (3 * USAGE_CNY + ceiling)) < 1e-6, String(second.settles[0].actualCny));
  assert.ok(second.settles[0].actualCny <= second.reserves[0].amountCny);
});

test('a batch that mostly fails stops the run as jury_unavailable', async () => {
  const model = fakeModel({}, { fail: () => new JuryError('jury_http_429', { retryable: true, billed: false }) });
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: model.callModel, budget, campaignId: 'c1', batchSize: 2, now: NOW });
  assert.equal(result.stopped, 'jury_unavailable'); assert.equal(budget.reserves.length, 1); assert.equal(result.costCny, 0);
});

test('an aborted run stops, settles what ran and calls nothing more', async () => {
  const controller = new AbortController();
  const model = fakeModel({ a: ['ok', 'ok'], b: ['ok', 'ok'] });
  const callModel = async (messages, options) => { const reply = await model.callModel(messages, options); controller.abort(); return reply; };
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel, budget, campaignId: 'c1', batchSize: 4, concurrency: 1, signal: controller.signal, now: NOW });
  assert.equal(result.stopped, 'aborted'); assert.equal(model.calls.length, 1);
  assert.equal(budget.settles[0].outcome, 'failed'); assert.ok(Math.abs(budget.settles[0].actualCny - USAGE_CNY) < 1e-9);
});

test('an interrupted run resumes from the cache and never pays for a cached pass twice', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const answers = { a: ['pick', 'pick'], b: ['ok', 'no'] };
  const broken = fakeModel(answers, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new Error('connection reset') : null) });
  const first = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: broken.callModel, budget: new FakeBudget(), campaignId: 'c1', cachePath, now: NOW });
  assert.equal(first.calls, 4); assert.equal(first.incomplete, 1);
  const lines = (await readFile(cachePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['costCny', 'finishReason', 'id', 'juryVersion', 'model', 'pass', 'requestId', 'today', 'usage', 'why', 'worth']);
  assert.equal(lines[0].model, 'qwen3.8-max'); assert.deepEqual(lines[0].usage, USAGE); assert.ok(Math.abs(lines[0].costCny - USAGE_CNY) < 1e-9);

  const healthy = fakeModel(answers), budget = new FakeBudget();
  const second = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: healthy.callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual(healthy.calls, [{ id: 'b', pass: 'B' }]);
  assert.equal(second.cachedCalls, 3); assert.equal(second.calls, 1); assert.equal(second.incomplete, 0);
  assert.deepEqual(second.labels.map((label) => [label.id, label.worth, label.basis]), [['a', 'pick', 'jury-agree'], ['b', null, 'jury-disagree']]);
  assert.ok(Math.abs(second.costCny - USAGE_CNY) < 1e-9);

  const idle = fakeModel(answers), untouched = new FakeBudget();
  const third = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: idle.callModel, budget: untouched, campaignId: 'c1', cachePath, now: NOW });
  assert.equal(idle.calls.length, 0); assert.equal(untouched.log.length, 0); assert.equal(third.calls, 0); assert.equal(third.labels.length, 2);

  // another exemplar set is another jury version: nothing is reused
  const other = fakeModel(answers);
  await labelFrontierItems({ items: [item('a')], exemplars: exemplars.slice(1), callModel: other.callModel, budget: new FakeBudget(), campaignId: 'c1', cachePath, now: NOW });
  assert.equal(other.calls.length, 2);
});

test('an invalid answer is cached too, so it is not bought again', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const model = fakeModel({ a: ['{"worth":"?"}', 'ok'] });
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget: new FakeBudget(), campaignId: 'c1', cachePath, now: NOW });
  const again = fakeModel({ a: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: again.callModel, budget: new FakeBudget(), campaignId: 'c1', cachePath, now: NOW });
  assert.equal(again.calls.length, 0); assert.equal(result.labels[0].basis, 'jury-invalid');
});

test('a held reservation from an interrupted batch is left held and the retry reserves under a fresh key', async () => {
  const probe = new FakeBudget();
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }).callModel, budget: probe, campaignId: 'c1', now: NOW });
  const heldKey = probe.reserves[0].stageKey;
  const budget = new FakeBudget({ held: [heldKey] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }).callModel, budget, campaignId: 'c1', now: NOW });
  assert.deepEqual(budget.reserves.map((entry) => entry.stageKey), [heldKey, `${heldKey}:a1`]);
  assert.equal(budget.records.get(heldKey).state, 'in-flight');
  assert.equal(result.labels.length, 1); assert.equal(result.stopped, null);
});

// ---- calibration ----

const goldRow = (n, worth) => ({ n, id: `g${n}`, label: { worth } });
const verdicts = (rows) => rows.map(([n, truth, jury]) => ({ gold: goldRow(n, truth), label: { id: `g${n}`, worth: jury } }));

test('calibration metrics on a hand-computed set', () => {
  // gold/jury: pick/pick x4, pick/ok x1, ok/pick x1, ok/ok x3, no/no x1, one ok abstained; odd-n rows are ignored
  const rows = [[2, 'pick', 'pick'], [4, 'pick', 'pick'], [6, 'pick', 'pick'], [8, 'pick', 'pick'], [10, 'pick', 'ok'], [12, 'ok', 'pick'],
    [14, 'ok', 'ok'], [16, 'ok', 'ok'], [18, 'ok', 'ok'], [20, 'no', 'no'], [22, 'ok', null], [3, 'pick', 'no'], [5, 'no', 'pick']];
  const input = verdicts(rows);
  const calibration = calibrateJury({ gold: [...input.map((entry) => entry.gold), goldRow(24, 'ok')], labels: input.map((entry) => entry.label) });
  assert.equal(calibration.calibrationRows, 12); assert.equal(calibration.labelled, 11); assert.equal(calibration.unlabelled, 1);
  assert.equal(calibration.scored, 10); assert.equal(calibration.abstained, 1);
  assert.ok(Math.abs(calibration.abstentionRate - 1 / 11) < 1e-12);
  assert.deepEqual(calibration.confusion.pick, { pick: 4, ok: 1, no: 0 });
  assert.deepEqual(calibration.confusion.ok, { pick: 1, ok: 3, no: 0 });
  assert.deepEqual(calibration.confusion.no, { pick: 0, ok: 0, no: 1 });
  // TP 4, FN 1, FP 1, TN 4: po 0.8, pe 0.5, kappa 0.6
  assert.ok(Math.abs(calibration.pickKappa - 0.6) < 1e-12, String(calibration.pickKappa));
  assert.ok(Math.abs(calibration.pickPrecision - 0.8) < 1e-12); assert.ok(Math.abs(calibration.pickRecall - 0.8) < 1e-12);
  assert.ok(Math.abs(calibration.accuracy - 0.8) < 1e-12);
  assert.equal(calibration.pickRecallWithAbstentions, 4 / 5);
});

test('kappa with unequal marginals', () => {
  // TP 2, FN 2, FP 0, TN 6: po 0.8, pe 0.4*0.2 + 0.6*0.8 = 0.56, kappa 0.24 / 0.44
  const input = verdicts([[2, 'pick', 'pick'], [4, 'pick', 'pick'], [6, 'pick', 'ok'], [8, 'pick', 'no'], ...[10, 12, 14, 16, 18, 20].map((n) => [n, 'ok', 'ok'])]);
  const calibration = calibrateJury({ gold: input.map((entry) => entry.gold), labels: input.map((entry) => entry.label) });
  assert.ok(Math.abs(calibration.pickKappa - 0.24 / 0.44) < 1e-12, String(calibration.pickKappa));
  assert.equal(calibration.pickPrecision, 1); assert.equal(calibration.pickRecall, 0.5);
});

test('degenerate calibration is reported as unavailable, never as zero', () => {
  const input = verdicts([[2, 'ok', 'ok'], [4, 'ok', 'ok'], [6, 'ok', null]]);
  const calibration = calibrateJury({ gold: input.map((entry) => entry.gold), labels: input.map((entry) => entry.label) });
  assert.equal(calibration.pickKappa, null); assert.equal(calibration.pickPrecision, null); assert.equal(calibration.pickRecall, null);
  const empty = calibrateJury({ gold: input.map((entry) => entry.gold), labels: [] });
  assert.equal(empty.labelled, 0); assert.equal(empty.abstentionRate, null); assert.equal(empty.accuracy, null);
  assert.deepEqual(juryQualified(empty).reasons.sort(), ['abstention_above_maximum', 'calibration_incomplete', 'kappa_unavailable', 'pick_precision_unavailable']);
});

test('juryQualified applies its three thresholds and a coverage floor', () => {
  const base = { calibrationRows: 100, labelled: 100, pickKappa: 0.5, abstentionRate: 0.2, pickPrecision: 0.7 };
  assert.deepEqual(juryQualified(base), { qualified: true, reasons: [] });
  assert.deepEqual(juryQualified({ ...base, pickKappa: 0.39 }), { qualified: false, reasons: ['kappa_below_minimum'] });
  assert.equal(juryQualified({ ...base, pickKappa: 0.4 }).qualified, true);
  assert.deepEqual(juryQualified({ ...base, abstentionRate: 0.36 }).reasons, ['abstention_above_maximum']);
  assert.equal(juryQualified({ ...base, abstentionRate: 0.35 }).qualified, true);
  assert.deepEqual(juryQualified({ ...base, pickPrecision: 0.49 }).reasons, ['pick_precision_below_minimum']);
  assert.deepEqual(juryQualified({ ...base, labelled: 80 }).reasons, ['calibration_incomplete']);
  assert.equal(juryQualified({ ...base, pickKappa: 0.2 }, { minKappa: 0.1 }).qualified, true);
  assert.deepEqual(juryQualified({ ...base, pickKappa: 0.2, abstentionRate: 0.5, pickPrecision: 0.1 }).reasons, ['kappa_below_minimum', 'abstention_above_maximum', 'pick_precision_below_minimum']);
});

// ---- the DashScope caller ----

const SECRET = 'sk-test-SECRET-0123456789';
const keyFile = async () => { const path = join(await tmp(), 'dashscope.key'); await writeFile(path, `${SECRET}\n`); return path; };
const reply = (status, data = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Map([['x-request-id', 'rid-1']]), json: async () => data });
const goodBody = { id: 'chatcmpl-1', choices: [{ message: { content: '{"worth":"ok","why":"x"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1000 } } };
const noSleep = async () => {};

test('the caller sends the pinned request and maps usage', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push({ url, options }); return reply(200, goodBody); };
  const call = dashscopeCaller({ credentialPath: await keyFile(), fetchImpl, sleep: noSleep });
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const result = await call(messages);
  assert.deepEqual(result, { text: '{"worth":"ok","why":"x"}', usage: { cacheHit: 1000, cacheMiss: 500, output: 20 }, requestId: 'rid-1', finishReason: 'stop' });
  assert.equal(sent[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(sent[0].options.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(sent[0].options.body);
  assert.equal(body.model, 'qwen3.8-max'); assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 200); assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.messages, messages);
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'frontier_label', strict: true, schema: { type: 'object',
    properties: { worth: { type: 'string', enum: ['pick', 'ok', 'no'] }, why: { type: 'string', maxLength: 200 } }, required: ['worth', 'why'], additionalProperties: false } } });
  await call(messages);
  assert.equal(sent.length, 2);
});

test('the caller retries 429, 5xx and timeouts, and gives up with a closed code', async () => {
  let attempts = 0;
  const flaky = async () => { attempts++; return attempts < 3 ? reply(attempts === 1 ? 429 : 503) : reply(200, goodBody); };
  const result = await dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: flaky, sleep: noSleep })([]);
  assert.equal(attempts, 3); assert.equal(result.usage.cacheMiss, 500);

  attempts = 0;
  await assert.rejects(dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: async () => { attempts++; return reply(503); }, sleep: noSleep })([]),
    (error) => error instanceof JuryError && error.code === 'jury_http_503' && error.billed === false);
  assert.equal(attempts, 4);

  attempts = 0;
  const hang = (url, { signal }) => { attempts++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
  await assert.rejects(dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: hang, timeoutMs: 5, retries: 1, sleep: noSleep })([]),
    (error) => error.code === 'jury_timeout' && error.billed === null);
  assert.equal(attempts, 2);
});

test('a 4xx other than 429 is not retried and a malformed reply is a bad response', async () => {
  let attempts = 0;
  await assert.rejects(dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: async () => { attempts++; return reply(401, { error: { message: `Incorrect API key provided: ${SECRET}` } }); }, sleep: noSleep })([]),
    (error) => error.code === 'jury_http_401');
  assert.equal(attempts, 1);
  await assert.rejects(dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: async () => reply(200, { choices: [] }), sleep: noSleep })([]), (error) => error.code === 'jury_bad_response');
  const noUsage = await dashscopeCaller({ credentialPath: await keyFile(), fetchImpl: async () => reply(200, { ...goodBody, usage: undefined }), sleep: noSleep })([]);
  assert.equal(noUsage.usage, null); assert.equal(noUsage.text, '{"worth":"ok","why":"x"}');
});

test('no error the caller raises carries the key', async () => {
  const path = await keyFile();
  const leaking = async () => { throw new Error(`request to https://dashscope failed, Authorization: Bearer ${SECRET}`); };
  const failures = [];
  for (const fetchImpl of [leaking, async () => reply(401, { error: { message: SECRET } }), async () => ({ ...reply(200), json: async () => { throw new Error(SECRET); } })]) {
    try { await dashscopeCaller({ credentialPath: path, fetchImpl, retries: 1, sleep: noSleep })([]); assert.fail('expected a failure'); } catch (error) { failures.push(error); }
  }
  assert.deepEqual(failures.map((error) => error.code), ['jury_network', 'jury_http_401', 'jury_network']);
  for (const error of failures) {
    assert.ok(error instanceof JuryError);
    for (const text of [error.message, String(error), error.stack ?? '', JSON.stringify(error), error.cause ? String(error.cause) : '']) assert.ok(!text.includes(SECRET));
  }
  await assert.rejects(dashscopeCaller({ credentialPath: join(await tmp(), 'missing.key'), fetchImpl: async () => reply(200, goodBody) })([]), (error) => error.code === 'jury_credential_unreadable');
  const empty = join(await tmp(), 'empty.key'); await writeFile(empty, '\n');
  await assert.rejects(dashscopeCaller({ credentialPath: empty, fetchImpl: async () => reply(200, goodBody) })([]), (error) => error.code === 'jury_credential_missing');
});

test('an aborted caller reports jury_aborted without retrying', async () => {
  const controller = new AbortController(); controller.abort();
  let attempts = 0;
  const fetchImpl = async (url, { signal }) => { attempts++; throw signal.reason; };
  await assert.rejects(dashscopeCaller({ credentialPath: await keyFile(), fetchImpl, sleep: noSleep })([], { signal: controller.signal }), (error) => error.code === 'jury_aborted');
  assert.equal(attempts, 1);
});

// ---- the command line's inputs ----

test('the calibration items are the even-n anchor rows in the export text shape, judged on their own day', () => {
  const items = calibrationItems(gold);
  assert.equal(items.length, gold.filter((row) => row.n % 2 === 0).length);
  const row = gold.find((entry) => entry.id === items[0].id);
  assert.equal(row.n % 2, 0); assert.equal(items[0].today, row.published);
  assert.deepEqual(Object.keys(items[0].text).sort(), ['date_precision', 'excerpt', 'journal', 'lang', 'publication_types', 'published_at', 'source_name', 'source_type', 'title_raw']);
  assert.ok(!items.some((entry) => exemplars.some((exemplar) => exemplar.id === entry.id)));
});

test('label items come from a plain or gzipped export, each on its feed day', async () => {
  const dir = await tmp();
  const texts = { 101: item('101').text, 102: { ...item('102').text, published_at: '2026-10-20T20:00:00.000Z' }, 103: { ...item('103').text, published_at: null } };
  const exported = { schema: 'rsi-frontier-export-v1', texts, days: [{ day: '2026-10-22', rows: [{ id: '101' }] }, { day: '2026-10-23', rows: [{ id: '101' }] }] };
  await writeFile(join(dir, 'export.json'), JSON.stringify(exported)); await writeFile(join(dir, 'export.json.gz'), gzipSync(JSON.stringify(exported)));
  await writeFile(join(dir, 'ids.json'), JSON.stringify(['101', '102', '103', '999']));
  for (const name of ['export.json', 'export.json.gz']) {
    const { items, missing } = await loadLabelItems({ exportPath: join(dir, name), idsPath: join(dir, 'ids.json') });
    assert.equal(missing, 1);
    assert.deepEqual(items.map((entry) => [entry.id, entry.today]), [['101', '2026-10-22'], ['102', '2026-10-21'], ['103', undefined]]);
  }
  await writeFile(join(dir, 'bad.json'), '{}');
  await assert.rejects(loadLabelItems({ exportPath: join(dir, 'bad.json'), idsPath: join(dir, 'ids.json') }), /input_invalid/);
});
