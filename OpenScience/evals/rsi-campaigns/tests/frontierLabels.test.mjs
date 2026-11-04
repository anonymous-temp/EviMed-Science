import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as labels from '../frontier_labels.mjs';
import {
  FRONTIER_JURY_MODEL, FRONTIER_JURY_PROVIDER, FRONTIER_JURY_VERSION, JuryError, calibrateJury, calibrationItems, dashscopeCaller, frontierJuryMessages, frontierJuryPromptDigest, frontierJuryVersion,
  goldItemText, juryQualified, labelFrontierItems, loadGoldRows, loadLabelItems, parseJuryAnswer, phaseItems, selectFrontierExemplars,
} from '../frontier_labels.mjs';
import { RSI_FRONTIER_JURY } from '../../../packages/domain/src/rsiCampaign.mjs';
import { labConfiguration } from '../profiles/benign_fixture.mjs';

const execFileAsync = promisify(execFile);
const STAND_IN = new URL('./fixtures/frontier_labels_stand_in.mjs', import.meta.url).pathname;
const GOLD_PATH = new URL('../../frontier-selection/gold.jsonl', import.meta.url).pathname;

const gold = await loadGoldRows(new URL('../../frontier-selection/gold.jsonl', import.meta.url));
const exemplars = selectFrontierExemplars(gold);
const NOW = () => '2026-10-26T04:00:00.000Z';
/** Every scratch directory a test makes is removed when the file is done. */
const made = [];
const tmp = async () => { const dir = await mkdtemp(join(tmpdir(), 'frontier-labels-')); made.push(dir); return dir; };
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));
const item = (id, extra = {}) => ({ id, text: { title_raw: `Item ${id}`, source_name: 'Source', source_type: 'media', journal: null, publication_types: [], published_at: '2026-10-25T00:00:00.000Z', date_precision: 'day', lang: 'en', excerpt: `Text of ${id}` }, ...extra });
/** CNY of one call's usage at qwen3.8-max: 1.5 / 12 / 36 per million tokens. */
const USAGE = { cacheHit: 1000, cacheMiss: 500, output: 50 };
const USAGE_CNY = 0.0093;

/** An in-memory ledger with the real one's method shapes: a settled or in-flight record answers `campaign_budget_already_dispatched`, a record of an earlier month `campaign_budget_month_expired`. */
class FakeBudget {
  constructor({ allowReserves = Infinity, refusal = 'campaign_budget_exceeded', held = [], expired = [] } = {}) {
    this.allowReserves = allowReserves; this.refusal = refusal; this.records = new Map(held.map((key) => [key, { state: 'in-flight' }])); this.log = []; this.granted = 0; this.expired = new Set(expired);
  }
  async reserve({ campaignId, stageKey, amountCny }) {
    this.log.push({ op: 'reserve', campaignId, stageKey, amountCny });
    if (this.expired.has(stageKey)) return { authorized: false, reason: 'campaign_budget_month_expired' };
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

test('the jury is pinned: rubric v1 byte for byte, the exemplar set, the model and the provider, so the lab\'s existing answer cache still hits', () => {
  // The cache (/srv/rsi-lab/state/jury-cache.jsonl) is keyed on id, pass, this version and the model.
  assert.equal(FRONTIER_JURY_VERSION, 'frontier-jury-v1');
  assert.equal(frontierJuryVersion(selectFrontierExemplars(gold)), 'frontier-jury-v1:7ac3c0f634c5');
  assert.equal(frontierJuryPromptDigest(), 'd824cc9877f976fd5b542fbdaa270679410bf7f45d120716622c23c75822ae27');
  assert.deepEqual([FRONTIER_JURY_MODEL, FRONTIER_JURY_PROVIDER], ['qwen3.8-max', 'dashscope']);
  assert.deepEqual([FRONTIER_JURY_MODEL, FRONTIER_JURY_PROVIDER], [RSI_FRONTIER_JURY.model, RSI_FRONTIER_JURY.provider], 'the one admitted identity, written once in the domain');
});

test('nothing of the Claude CLI jury survives: no caller, no environment scrub, no effort, no subscription basis, no operator items file', () => {
  for (const name of ['claudeCliCaller', 'claudeCliEnvironment', 'FRONTIER_JURY_EFFORT', 'FRONTIER_JURY_EFFORTS', 'FRONTIER_JURY_COST_BASIS', 'FRONTIER_LABEL_ITEMS_SCHEMA', 'buildLabelItemsFile', 'labelItemText'])
    assert.ok(!(name in labels), name);
  assert.deepEqual(Object.keys(labels).sort(), ['FRONTIER_CALIBRATION_SCHEMA', 'FRONTIER_JURY_MODEL', 'FRONTIER_JURY_PROVIDER', 'FRONTIER_JURY_VERSION', 'FRONTIER_LABELS_SCHEMA', 'FRONTIER_LABEL_PHASES', 'FRONTIER_WORTH',
    'JuryError', 'calibrateJury', 'calibrationItems', 'dashscopeCaller', 'frontierJuryMessages', 'frontierJuryPromptDigest', 'frontierJuryVersion', 'goldItemText', 'juryQualified', 'labelFrontierItems',
    'loadGoldRows', 'loadLabelItems', 'main', 'parseJuryAnswer', 'phaseItems', 'selectFrontierExemplars', 'shanghaiDay']);
});

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
  assert.deepEqual(budget.settles.map((entry) => [entry.stageKey, entry.outcome, entry.actualCny]), [[budget.reserves[0].stageKey, 'failed', 0]], 'its hold is released, not left against the ceiling');
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
  // every prompt character priced as an uncached token (12 per million), plus the 200-token output cap (36 per million), per call, rounded up to the ledger's 1e-8
  const chars = (id, order) => frontierJuryMessages(item(id).text, { exemplars: order, today: '2026-10-26' }).reduce((sum, message) => sum + message.content.length + 8, 0);
  const bound = ['a', 'b'].flatMap((id) => [exemplars, [...exemplars].reverse()].map((order) => (chars(id, order) * 12 + 200 * 36) / 1e6)).reduce((sum, value) => sum + value, 0);
  assert.ok(reserve.amountCny >= bound - 1e-9 && reserve.amountCny - bound <= 1.01e-8, `${reserve.amountCny} against ${bound}`);
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
  const answered = lines.filter((line) => line.pass);
  assert.equal(answered.length, 3);
  assert.deepEqual(Object.keys(answered[0]).sort(), ['campaignId', 'costCny', 'finishReason', 'id', 'juryVersion', 'model', 'pass', 'requestId', 'today', 'usage', 'why', 'worth']);
  assert.equal(answered[0].model, 'qwen3.8-max'); assert.equal(answered[0].campaignId, 'c1'); assert.deepEqual(answered[0].usage, USAGE); assert.ok(Math.abs(answered[0].costCny - USAGE_CNY) < 1e-9);

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

test('no number of failed starts locks a month: each takes the next free stage key, and a healthy start labels everything', async () => {
  const budget = new FakeBudget();
  const down = fakeModel({}, { fail: () => new JuryError('jury_http_401', { billed: false }) });
  for (let start = 0; start < 6; start++) {
    const failed = await labelFrontierItems({ items: [item('a')], exemplars, callModel: down.callModel, budget, campaignId: 'c1', now: NOW });
    assert.equal(failed.stopped, 'jury_unavailable', `start ${start}`);
  }
  const healthy = fakeModel({ a: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: healthy.callModel, budget, campaignId: 'c1', now: NOW });
  assert.deepEqual([result.stopped, result.labels.length, healthy.calls.length], [null, 1, 2]);
  assert.equal(new Set(budget.settles.map((entry) => entry.stageKey)).size, 7, 'one settled record per start');
  assert.deepEqual(budget.settles.slice(0, 6).map((entry) => entry.actualCny), [0, 0, 0, 0, 0, 0]);
});

test('a batch last reserved in an earlier month reserves again under a fresh key', async () => {
  const probe = new FakeBudget();
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }).callModel, budget: probe, campaignId: 'c1', now: NOW });
  const key = probe.reserves[0].stageKey;
  const budget = new FakeBudget({ expired: [key, `${key}:a1`] }), model = fakeModel({ a: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  assert.deepEqual(budget.reserves.map((entry) => entry.stageKey), [key, `${key}:a1`, `${key}:a2`]);
  assert.deepEqual([result.stopped, result.labels.length, budget.settles[0].stageKey], [null, 1, `${key}:a2`]);
});

test('a stage key reserved under limits that have changed is not free, and the next one is', async () => {
  const budget = new FakeBudget(), reserve = budget.reserve.bind(budget), model = fakeModel({ a: ['ok', 'ok'] });
  const seen = [];
  budget.reserve = async (input) => {
    seen.push(input.stageKey);
    if (seen.length === 1) throw Object.assign(new Error('Reservation identity has a different amount or limit.'), { code: 'campaign_budget_idempotency_conflict' });
    return reserve(input);
  };
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  assert.deepEqual([result.stopped, result.labels.length, seen.at(-1)], [null, 1, `${seen[0]}:a1`]);
  // anything else the ledger throws is not about the key: it ends the run by its own code
  budget.reserve = async () => { throw Object.assign(new Error('x'), { code: 'campaign_budget_unknown' }); };
  await assert.rejects(labelFrontierItems({ items: [item('b')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW }), { code: 'campaign_budget_unknown' });
});

test('the search for a free stage key has a bound and a name, and the ceiling still stops a run whose holds were never settled', async () => {
  let asked = 0;
  const budget = new FakeBudget(), model = fakeModel({ a: ['ok', 'ok'] });
  budget.reserve = async () => { asked++; return { authorized: false, reason: 'campaign_budget_already_dispatched' }; };
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW });
  assert.equal(result.stopped, 'campaign_budget_stage_keys_exhausted');
  assert.ok(asked >= 100 && asked <= 10_000, String(asked));
  assert.deepEqual([model.calls.length, budget.settles.length], [0, 0]);
  // Two interrupted starts left their holds in flight, and the ledger admits nothing more: the ceiling stops it by its own code.
  const probe = new FakeBudget();
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }).callModel, budget: probe, campaignId: 'c1', now: NOW });
  const key = probe.reserves[0].stageKey;
  const full = new FakeBudget({ held: [key, `${key}:a1`], allowReserves: 0 }), idle = fakeModel({ a: ['ok', 'ok'] });
  const capped = await labelFrontierItems({ items: [item('a')], exemplars, callModel: idle.callModel, budget: full, campaignId: 'c1', now: NOW });
  assert.deepEqual([capped.stopped, idle.calls.length, full.reserves.length], ['campaign_budget_exceeded', 0, 3]);
  assert.deepEqual([full.records.get(key).state, full.records.get(`${key}:a1`).state], ['in-flight', 'in-flight'], 'a hold from an interrupted batch stays held');
});

test('a content refusal is an abstention of its own: cached, unbilled, counted apart, and not asked again', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const refusing = fakeModel({ a: ['ok', 'ok'], b: ['ok', 'ok'], c: ['ok', 'pick'] }, { fail: (id) => (id === 'b' ? new JuryError('jury_content_refused', { billed: false }) : null) });
  const budget = new FakeBudget();
  const first = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: refusing.callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual([first.stopped, first.incomplete], [null, 0]);
  assert.deepEqual(first.labels.map((label) => [label.id, label.worth, label.basis]), [['a', 'ok', 'jury-agree'], ['b', null, 'jury-refused'], ['c', null, 'jury-disagree']]);
  assert.equal(budget.settles[0].outcome, 'success');
  assert.ok(Math.abs(budget.settles[0].actualCny - 4 * USAGE_CNY) < 1e-9, 'the refused passes are not charged');
  const rows = (await readFile(cachePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.id === 'b');
  assert.deepEqual(rows.map((row) => [row.pass, row.worth, row.basis, row.costCny, row.campaignId]).sort(), [['A', null, 'jury-refused', 0, 'c1'], ['B', null, 'jury-refused', 0, 'c1']]);
  const healthy = fakeModel({ a: ['ok', 'ok'], b: ['ok', 'ok'], c: ['ok', 'pick'] });
  const second = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: healthy.callModel, budget: new FakeBudget(), campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual([healthy.calls.length, second.labels[1].basis], [0, 'jury-refused']);
});

test('any other 400 is the account\'s or the request\'s: nothing is cached, nothing is billed, the run stops by name, and a healthy restart labels everything', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const arrears = fakeModel({}, { fail: () => new JuryError('jury_http_400', { billed: false }) });
  const budget = new FakeBudget();
  const stopped = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: arrears.callModel, budget, campaignId: 'c1', cachePath, batchSize: 4, now: NOW });
  assert.deepEqual([stopped.stopped, stopped.labels.length, stopped.incomplete, stopped.costCny], ['jury_unavailable', 0, 3, 0]);
  assert.deepEqual(budget.settles.map((entry) => [entry.outcome, entry.actualCny]), [['failed', 0]]);
  assert.equal(await readFile(cachePath, 'utf8').catch(() => ''), '', 'the cache holds nothing of it');
  const healthy = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'], c: ['no', 'no'] });
  const restart = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: healthy.callModel, budget, campaignId: 'c1', cachePath, batchSize: 4, now: NOW });
  assert.deepEqual([restart.stopped, restart.incomplete, healthy.calls.length], [null, 0, 6]);
  assert.deepEqual(restart.labels.map((label) => [label.id, label.worth]), [['a', 'pick'], ['b', 'ok'], ['c', 'no']]);
});

test('attempts that may have been billed are all priced: each costs its upper bound beside the answer that was bought', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const probe = new FakeBudget();
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }).callModel, budget: probe, campaignId: 'c1', now: NOW });
  const ceiling = probe.reserves[0].amountCny / 2;
  // pass A timed out twice before it was answered; pass B timed out three times and gave up
  const inner = fakeModel({ a: ['ok', 'ok'] }, { fail: (id, pass) => (pass === 'B' ? Object.assign(new JuryError('jury_timeout', { retryable: true }), { possiblyBilled: 3 }) : null) });
  const callModel = async (messages, options) => ({ ...(await inner.callModel(messages, options)), possiblyBilled: 2 });
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.ok(Math.abs(budget.settles[0].actualCny - (USAGE_CNY + 2 * ceiling + 3 * ceiling)) < 1e-6, String(budget.settles[0].actualCny));
  assert.ok(Math.abs(result.costCny - budget.settles[0].actualCny) < 1e-9);
  const rows = (await readFile(cachePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(Math.abs(rows.find((row) => row.pass === 'A').costCny - (USAGE_CNY + 2 * ceiling)) < 1e-6, 'the answer\'s record carries what it took');
});

test('what a file reports is what this campaign paid for these items over all its starts: a row from before the stamp or of another campaign counts 0, and a call that left no answer is counted', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const version = frontierJuryVersion(exemplars);
  const earlier = (pass, over = {}) => JSON.stringify({ id: 'a', pass, worth: 'pick', why: '', juryVersion: version, model: 'qwen3.8-max', usage: USAGE, costCny: USAGE_CNY, requestId: 'r', finishReason: 'stop', today: '2026-10-25', ...over });
  await writeFile(cachePath, `${earlier('A')}\n${earlier('B', { campaignId: 'rehearsal-frontier-selection-2026-10' })}\n`);
  const items = ['a', 'b', 'c'].map((id) => item(id));
  const answers = { a: ['ok', 'ok'], b: ['ok', 'ok'], c: ['no', 'no'] };
  const budget = new FakeBudget();
  // b's second pass fails with a charge that cannot be ruled out and leaves no answer
  const broken = fakeModel(answers, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new Error('socket hang up') : null) });
  const first = await labelFrontierItems({ items, exemplars, callModel: broken.callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.equal(first.incomplete, 1);
  assert.ok(first.costCny > 3 * USAGE_CNY, 'the failed call is charged at its upper bound');
  const healthy = fakeModel(answers);
  const second = await labelFrontierItems({ items, exemplars, callModel: healthy.callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual(healthy.calls, [{ id: 'b', pass: 'B' }], 'the charge is not an answer: the pass is asked again');
  assert.ok(Math.abs(second.costCny - USAGE_CNY) < 1e-9, 'costCny is this start\'s spend');
  const settled = budget.settles.reduce((sum, entry) => sum + entry.actualCny, 0);
  assert.ok(Math.abs(second.campaignCostCny - settled) < 1e-6, `${second.campaignCostCny} reported, ${settled} settled`);
  assert.ok(Math.abs(first.campaignCostCny - first.costCny) < 1e-6);
  // A rerun pays nothing and reports the same; another campaign paid for none of it; another phase's items are that phase's.
  const rerun = await labelFrontierItems({ items, exemplars, callModel: fakeModel(answers).callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual([rerun.costCny, rerun.campaignCostCny], [0, second.campaignCostCny]);
  assert.equal((await labelFrontierItems({ items, exemplars, callModel: fakeModel(answers).callModel, budget, campaignId: 'c2', cachePath, now: NOW })).campaignCostCny, 0);
  const other = await labelFrontierItems({ items: [item('d')], exemplars, callModel: fakeModel({ d: ['ok', 'ok'] }).callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.ok(Math.abs(other.campaignCostCny - 2 * USAGE_CNY) < 1e-9);
});

test('a model with no price refuses the run before any money moves', async () => {
  const budget = new FakeBudget(), model = fakeModel({ a: ['ok', 'ok'] });
  await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', now: NOW, model: 'qwen-no-such-model' }), { message: 'jury_unpriced' });
  assert.deepEqual([budget.log.length, model.calls.length], [0, 0]);
  await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel: null, budget, campaignId: 'c1', now: NOW }), { message: 'jury_unconfigured' });
  await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, campaignId: 'c1', now: NOW }), { message: 'jury_unconfigured' });
  assert.equal(budget.log.length, 0);
});

test('the lab\'s existing cache still hits: a record in the shape the earlier runs wrote is read, and no field of another jury is part of the key', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const version = frontierJuryVersion(exemplars);
  const record = (id, pass, over = {}) => JSON.stringify({ id, pass, worth: 'pick', why: 'earlier', juryVersion: version, model: 'qwen3.8-max', usage: USAGE, costCny: USAGE_CNY, requestId: 'r', finishReason: 'stop', today: '2026-10-25', ...over });
  await writeFile(cachePath, [record('a', 'A'), record('a', 'B'), '', 'not json', record('b', 'A', { model: 'claude-sonnet-5-5', effort: 'medium' }), record('b', 'B', { juryVersion: 'frontier-jury-v2:0123456789ab' })].join('\n') + '\n');
  const model = fakeModel({ a: ['ok', 'ok'], b: ['no', 'no'] }), budget = new FakeBudget();
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: model.callModel, budget, campaignId: 'c1', cachePath, now: NOW });
  assert.deepEqual(model.calls.map((call) => `${call.id}${call.pass}`).sort(), ['bA', 'bB'], 'a is served from the cache; b\'s records are another model\'s and another rubric\'s');
  assert.deepEqual(result.labels.map((label) => [label.id, label.worth]), [['a', 'pick'], ['b', 'no']]);
  assert.equal(result.cachedCalls, 2);
  assert.ok(Math.abs(result.campaignCostCny - result.costCny) < 1e-9, 'an answer from before the stamp was paid by an earlier campaign');
  for (const line of (await readFile(cachePath, 'utf8')).trim().split('\n').slice(-2)) assert.ok(!('effort' in JSON.parse(line)), 'the records written now carry no effort');
});

test('a credential that cannot be read costs nothing: the call was never made, so it is not charged at its upper bound', async () => {
  const dir = await tmp(), blank = join(dir, 'blank.key');
  await writeFile(blank, '\n');
  for (const credentialPath of [join(dir, 'missing.key'), blank]) {
    const budget = new FakeBudget();
    const result = await labelFrontierItems({ items: ['a', 'b'].map((id) => item(id)), exemplars, callModel: dashscopeCaller({ credentialPath, fetchImpl: async () => assert.fail('no request without a key') }), budget, campaignId: 'c1', now: NOW });
    assert.deepEqual([result.stopped, result.costCny, result.calls, result.labels.length], ['jury_unavailable', 0, 4, 0]);
    assert.deepEqual(budget.settles.map((entry) => [entry.outcome, entry.actualCny]), [['failed', 0]]);
  }
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
  assert.deepEqual(result, { text: '{"worth":"ok","why":"x"}', usage: { cacheHit: 1000, cacheMiss: 500, output: 20 }, requestId: 'rid-1', finishReason: 'stop', possiblyBilled: 0 });
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
  // A fetch that never answers until it is aborted. AbortSignal.timeout's timer is unref'd, so on Node 22 nothing would keep the
  // loop alive while this waits and the runner cancels the file ("event loop has already resolved"): the fake holds a ref'd timer.
  const hang = (url, { signal }) => { attempts++; const keep = setTimeout(() => {}, 10_000);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { clearTimeout(keep); reject(signal.reason); })); };
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

test('a 400 is about this text only when the body\'s code says content inspection refused it; arrears and every other 400 stay jury_http_400, and no body reaches an error', async () => {
  const path = await keyFile();
  const refusal = async (body, status = 400) => {
    let attempts = 0;
    const error = await dashscopeCaller({ credentialPath: path, fetchImpl: async () => { attempts++; return { ...reply(status), json: body }; }, sleep: noSleep })([]).then(() => assert.fail('expected a failure'), (failure) => failure);
    assert.ok(error instanceof JuryError);
    assert.equal(attempts, 1, 'a 400 is not retried');
    for (const text of [error.message, String(error), error.stack ?? '', JSON.stringify(error)]) assert.ok(!text.includes(SECRET) && !text.includes('Access denied'), text);
    return [error.code, error.billed];
  };
  // compatible mode and the native spelling
  assert.deepEqual(await refusal(async () => ({ error: { code: 'data_inspection_failed', message: `Input data may contain inappropriate content. ${SECRET}` } })), ['jury_content_refused', false]);
  assert.deepEqual(await refusal(async () => ({ code: 'DataInspectionFailed', message: 'x' })), ['jury_content_refused', false]);
  for (const body of [async () => ({ error: { code: 'Arrearage', message: `Access denied ${SECRET}` } }), async () => ({ code: 'Arrearage' }), async () => ({ error: { code: 'invalid_parameter_error' } }), async () => ({ error: { message: 'data_inspection_failed' } }), async () => ({}), async () => null, async () => { throw new Error(SECRET); }])
    assert.deepEqual(await refusal(body), ['jury_http_400', false]);
  // the code means this only on a 400
  assert.deepEqual(await refusal(async () => ({ error: { code: 'data_inspection_failed' } }), 403), ['jury_http_403', false]);
});

test('the caller counts the attempts that may have been billed: a timeout or a lost connection may be, a status answer is not', async () => {
  const path = await keyFile();
  const scripted = (...steps) => { const left = [...steps]; return async () => { const step = left.shift(); if (step instanceof Error) throw step; return reply(step, step === 200 ? goodBody : {}); }; };
  const call = (fetchImpl) => dashscopeCaller({ credentialPath: path, fetchImpl, sleep: noSleep })([]);
  assert.equal((await call(scripted(200))).possiblyBilled, 0);
  assert.equal((await call(scripted(503, 429, 200))).possiblyBilled, 0, 'answered by status: nothing was generated');
  assert.equal((await call(scripted(new Error('reset'), new Error('reset'), 200))).possiblyBilled, 2);
  assert.equal((await call(scripted(new Error('reset'), 503, 200))).possiblyBilled, 1);
  await assert.rejects(call(scripted(new Error('reset'), new Error('reset'), new Error('reset'), new Error('reset'))), (error) => error.code === 'jury_network' && error.possiblyBilled === 4);
  await assert.rejects(call(scripted(new Error('reset'), 503, new Error('reset'), 503)), (error) => error.code === 'jury_http_503' && error.billed === false && error.possiblyBilled === 2);
  const missing = dashscopeCaller({ credentialPath: join(await tmp(), 'missing.key'), fetchImpl: scripted(200), sleep: noSleep });
  await assert.rejects(missing([]), (error) => error.code === 'jury_credential_unreadable' && error.possiblyBilled === 0);
  // a call priced through the ledger takes the count from here
  const budget = new FakeBudget();
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: dashscopeCaller({ credentialPath: path, fetchImpl: scripted(new Error('reset'), 200, 200), sleep: noSleep }), budget, campaignId: 'c1', now: NOW, concurrency: 1 });
  const ceiling = budget.reserves[0].amountCny / 2, oneAnswer = (1000 * 1.5 + 500 * 12 + 20 * 36) / 1e6;
  assert.ok(Math.abs(result.costCny - (2 * oneAnswer + ceiling)) < 1e-6, String(result.costCny));
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

test('label items come from a plain or gzipped export, each on its feed day, and the export\'s digest comes with them', async () => {
  const dir = await tmp();
  const texts = { 101: item('101').text, 102: { ...item('102').text, published_at: '2026-10-20T20:00:00.000Z' }, 103: { ...item('103').text, published_at: null } };
  const exported = { schema: 'rsi-frontier-export-v1', texts, days: [{ day: '2026-10-22', rows: [{ id: '101' }] }, { day: '2026-10-23', rows: [{ id: '101' }] }] };
  await writeFile(join(dir, 'export.json'), JSON.stringify(exported)); await writeFile(join(dir, 'export.json.gz'), gzipSync(JSON.stringify(exported)));
  for (const name of ['export.json', 'export.json.gz']) {
    const { items, missing, exportSha256 } = await loadLabelItems({ exportPath: join(dir, name), ids: ['101', '102', '103', '999'] });
    assert.equal(missing, 1);
    assert.deepEqual(items.map((entry) => [entry.id, entry.today]), [['101', '2026-10-22'], ['102', '2026-10-21'], ['103', undefined]]);
    assert.equal(exportSha256, createHash('sha256').update(await readFile(join(dir, name))).digest('hex'));
  }
  await writeFile(join(dir, 'bad.json'), '{}');
  await assert.rejects(loadLabelItems({ exportPath: join(dir, 'bad.json'), ids: ['101'] }), /input_invalid/);
  await assert.rejects(loadLabelItems({ exportPath: join(dir, 'export.json'), ids: 'not a list' }), /input_invalid/);
});

/** A tiny export and the plan the lab would have made from it: two ids to develop on, one to confirm on, one with no text. */
async function planAndExport() {
  const dir = await tmp();
  const platform = { title_zh: 'ZH-MARK', summary_zh: 'SUMMARY-MARK', score_total: 98765, genre: 'GENRE-MARK', evidence_type: 'ET-MARK', live: { total: 4321 } };
  const texts = { 101: { ...item('101').text, ...platform }, 102: { ...item('102').text, ...platform }, 201: { ...item('201').text, ...platform } };
  const exported = { schema: 'rsi-frontier-export-v1', texts, days: [{ day: '2026-09-02', rows: [{ id: '101' }, { id: '102' }, { id: '404' }] }, { day: '2026-10-03', rows: [{ id: '201' }] }] };
  const bytes = gzipSync(JSON.stringify(exported));
  await writeFile(join(dir, 'export.json.gz'), bytes);
  const plan = { month: '2026-11', idPrefix: 'rehearsal-', exportSha256: createHash('sha256').update(bytes).digest('hex'), idsByRole: { development: ['101', '102', '404'], confirmation: ['201'] } };
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  return { dir, exportPath: join(dir, 'export.json.gz'), plan };
}

test('a phase\'s items are the plan\'s ids for it with their source text, bound to the export; any other phase, plan or export is refused', async () => {
  const { exportPath, plan } = await planAndExport();
  const development = await phaseItems({ exportPath, plan, phase: 'development' });
  assert.deepEqual([development.month, development.idPrefix, development.phase, development.exportSha256, development.missing], ['2026-11', 'rehearsal-', 'development', plan.exportSha256, 1]);
  assert.deepEqual(development.items.map((entry) => [entry.id, entry.today]), [['101', '2026-09-02'], ['102', '2026-09-02']]);
  assert.deepEqual((await phaseItems({ exportPath, plan, phase: 'confirmation' })).items.map((entry) => entry.id), ['201']);
  await assert.rejects(phaseItems({ exportPath, plan, phase: 'all' }), { message: 'usage_phase' });
  await assert.rejects(phaseItems({ exportPath, plan: { ...plan, idsByRole: undefined }, phase: 'development' }), { message: 'usage_phase' });
  await assert.rejects(phaseItems({ exportPath, plan: { ...plan, exportSha256: 'e'.repeat(64) }, phase: 'development' }), { message: 'campaign_export_changed' });
  // what the prompt carries of a row is its source text alone, whatever else the export holds
  const [system, user] = frontierJuryMessages(development.items[0].text, { exemplars, today: development.items[0].today });
  for (const mark of ['ZH-MARK', 'SUMMARY-MARK', '98765', 'GENRE-MARK', 'ET-MARK', '4321']) assert.ok(!user.content.includes(mark) && !system.content.includes(mark), mark);
});

// The real command (main), with the lab's ledger and DashScope stood in by fixtures/frontier_labels_stand_in.mjs: files, exit codes, the key and the cache.
const KEY = 'sk-cli-SECRET-0123456789';
async function cliTree() {
  const { dir, exportPath, plan } = await planAndExport();
  const key = join(dir, 'dashscope.key'), config = join(dir, 'config.json');
  await writeFile(key, `${KEY}\n`); await writeFile(config, JSON.stringify(labConfiguration));
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, FAKE_BUDGET_LEDGER: join(dir, 'ledger.json'), FAKE_DASHSCOPE_LOG: join(dir, 'dashscope.jsonl'), FAKE_DASHSCOPE_GOLD: GOLD_PATH, FAKE_DASHSCOPE_WORTH: 'pick' };
  const run = (command, args, over = {}) => execFileAsync(process.execPath, [STAND_IN, command, '--credential', key, '--cache', join(dir, 'cache.jsonl'), '--campaign', 'rehearsal-frontier-selection-2026-11', '--config', config, ...args],
    { cwd: dir, env: { ...env, ...over }, maxBuffer: 1 << 24 }).catch((error) => error);
  const read = async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'));
  const lines = async (name) => (await readFile(join(dir, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { dir, exportPath, plan, key, run, read, lines, ledger: () => read('ledger.json').catch(() => ({ records: {}, granted: 0, settles: [] })) };
}

test('label: the labels file names its phase, month, export, jury and provider; the cost is the priced usage; a rerun asks for nothing and pays nothing; the key is in no file', async () => {
  const t = await cliTree();
  const out = join(t.dir, 'labels-development.json');
  const first = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', out]);
  assert.equal(first.code ?? 0, 0, first.stderr);
  const file = await t.read('labels-development.json');
  assert.deepEqual([file.schema, file.command, file.phase, file.month, file.idPrefix, file.exportSha256, file.juryVersion, file.promptDigest, file.provider, file.model],
    ['rsi-frontier-jury-labels-v1', 'label', 'development', '2026-11', 'rehearsal-', t.plan.exportSha256, frontierJuryVersion(exemplars), frontierJuryPromptDigest(), 'dashscope', 'qwen3.8-max']);
  assert.deepEqual([file.items, file.missing, file.labelled, file.incomplete, file.stopped, file.calls, file.cachedCalls], [2, 1, 2, 0, null, 4, 0]);
  assert.deepEqual(file.labels.map((label) => [label.id, label.worth, label.basis]), [['101', 'pick', 'jury-agree'], ['102', 'pick', 'jury-agree']]);
  assert.deepEqual(file.labelCounts, { pick: 2, ok: 0, no: 0, abstained: 0, refused: 0 });
  assert.ok(Math.abs(file.costCny - 4 * 0.00822) < 1e-9, String(file.costCny));
  assert.ok(!('effort' in file) && !('tokens' in file) && !('costBasis' in file));
  const requests = await t.lines('dashscope.jsonl');
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.authorized && request.model === 'qwen3.8-max'));
  const ledger = await t.ledger();
  assert.deepEqual([ledger.settles.length, ledger.settles[0].outcome, Math.abs(ledger.settles[0].actualCny - file.costCny) < 1e-9, ledger.settles[0].actualCny < ledger.settles[0].reservedCny], [1, 'success', true, true]);
  // a rerun: the cache serves all four, no request is made and no money moves
  const rerun = JSON.parse((await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'again.json')])).stdout);
  assert.deepEqual([rerun.calls, rerun.cachedCalls, rerun.costCny], [0, 4, file.costCny], 'it paid nothing, and the file still says what the campaign paid');
  assert.equal((await t.lines('dashscope.jsonl')).length, 4);
  assert.equal((await t.ledger()).settles.length, 1);
  // confirmation is the plan\'s other phase, labelled under its own name
  await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'confirmation', '--out', join(t.dir, 'labels-confirmation.json')]);
  assert.deepEqual((await t.read('labels-confirmation.json')).labels.map((label) => label.id), ['201']);
  for (const name of ['labels-development.json', 'again.json', 'labels-confirmation.json', 'cache.jsonl', 'dashscope.jsonl', 'ledger.json']) assert.ok(!(await readFile(join(t.dir, name), 'utf8')).includes(KEY), name);
  assert.ok(!first.stdout.includes(KEY) && !first.stderr.includes(KEY));
});

test('calibrate: the anchor\'s calibration rows, two passes each, written with the qualification the campaign is gated on and the provider it names', async () => {
  const t = await cliTree();
  // A jury that calls everything `ok` against the anchor picks nothing, so kappa is unavailable and the calibration does not qualify.
  const result = await t.run('calibrate', ['--out', join(t.dir, 'calibration.json'), '--gold', GOLD_PATH], { FAKE_DASHSCOPE_WORTH: 'ok' });
  assert.equal(result.code ?? 0, 0, result.stderr);
  const summary = JSON.parse(result.stdout), file = await t.read('calibration.json');
  const evenRows = gold.filter((row) => row.n % 2 === 0).length;
  assert.deepEqual([file.schema, file.provider, file.model, file.juryVersion, file.promptDigest, file.items, file.labelled, file.calls, file.stopped],
    ['rsi-frontier-jury-calibration-v1', 'dashscope', 'qwen3.8-max', frontierJuryVersion(exemplars), frontierJuryPromptDigest(), evenRows, evenRows, 2 * evenRows, null]);
  assert.equal(file.qualification.qualified, false);
  assert.ok(file.qualification.reasons.includes('kappa_unavailable') || file.qualification.reasons.includes('pick_precision_unavailable'));
  assert.deepEqual([summary.qualified, summary.reasons], [false, file.qualification.reasons]);
  assert.equal(file.calibration.calibrationRows, evenRows);
  assert.ok(!('phase' in file) && file.costCny > 0);
  // the anchor\'s own labels, answered back, qualify it
  const exact = await t.run('calibrate', ['--out', join(t.dir, 'exact.json'), '--cache', join(t.dir, 'exact-cache.jsonl')], { FAKE_DASHSCOPE_WORTH: 'by-title' });
  assert.equal(exact.code ?? 0, 0, exact.stderr);
  const qualified = await t.read('exact.json');
  assert.deepEqual([qualified.qualification.qualified, qualified.calibration.pickKappa], [true, 1]);
});

test('a budget that refuses ends the command with exit code 2 and the file written; a key that cannot be read stops it the same way, charging nothing', async () => {
  const t = await cliTree();
  const refused = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'labels.json')], { FAKE_BUDGET_ALLOW_RESERVES: '0' });
  assert.equal(refused.code, 2);
  assert.deepEqual([JSON.parse(refused.stdout).stopped, JSON.parse(refused.stdout).calls], ['campaign_budget_exceeded', 0]);
  const file = await t.read('labels.json');
  assert.deepEqual([file.stopped, file.labelled, file.incomplete, file.phase], ['campaign_budget_exceeded', 0, 2, 'development']);
  assert.equal((await t.lines('dashscope.jsonl')).length, 0);
  await writeFile(t.key, '   \n');
  const blank = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'blank.json')]);
  assert.equal(blank.code, 2);
  assert.equal((await t.read('blank.json')).stopped, 'jury_unavailable');
  assert.equal((await t.lines('dashscope.jsonl')).length, 0, 'no request without a key');
  assert.ok((await t.ledger()).settles.every((entry) => entry.actualCny === 0));
  // an item left without both passes (here a provider outage on half of the batch) is not a finished labelling: the command says so with exit 2, and the month does not build on it
  await writeFile(t.key, `${KEY}\n`);
  const partial = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'partial.json'), '--cache', join(t.dir, 'partial-cache.jsonl')], { FAKE_DASHSCOPE_REJECT_STATUS: '503', FAKE_DASHSCOPE_REJECT: 'Item 102' });
  assert.equal(partial.code, 2);
  assert.deepEqual([JSON.parse(partial.stdout).stopped, JSON.parse(partial.stdout).labelled, JSON.parse(partial.stdout).incomplete], ['jury_unavailable', 1, 1]);
  // A content refusal is the provider's answer about this text: the pass is an abstention, unbilled, kept in the cache, so the unattended month goes on and a rerun does not ask again.
  const before = (await t.lines('dashscope.jsonl')).length;
  const refusedText = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'refused.json'), '--cache', join(t.dir, 'refused-cache.jsonl')], { FAKE_DASHSCOPE_REJECT: 'Item 102' });
  assert.ok(!refusedText.code, refusedText.stderr);
  const refusedFile = await t.read('refused.json');
  assert.deepEqual([refusedFile.stopped, refusedFile.incomplete, refusedFile.labelled], [null, 0, 2]);
  assert.equal(refusedFile.labels.filter((label) => label.worth === null && label.basis === 'jury-refused').length, 1);
  assert.deepEqual(refusedFile.labelCounts, { pick: 1, ok: 0, no: 0, abstained: 0, refused: 1 });
  const asked = (await t.lines('dashscope.jsonl')).length;
  assert.ok(asked > before);
  const rerun = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'refused2.json'), '--cache', join(t.dir, 'refused-cache.jsonl')], { FAKE_DASHSCOPE_REJECT: 'Item 102' });
  assert.ok(!rerun.code, rerun.stderr);
  assert.equal((await t.lines('dashscope.jsonl')).length, asked, 'a refused pass is not asked for again');
  // Any other 400 (arrears are a 400 at DashScope) is not an answer: exit 2, nothing cached, nothing billed, and the key its body echoes reaches no file.
  const cache = join(t.dir, 'arrears-cache.jsonl');
  const settled = (await t.ledger()).settles.length;
  const arrears = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'arrears.json'), '--cache', cache], { FAKE_DASHSCOPE_MODE: 'http-400', FAKE_DASHSCOPE_REJECT_CODE: 'Arrearage' });
  assert.equal(arrears.code, 2);
  assert.deepEqual([JSON.parse(arrears.stdout).stopped, JSON.parse(arrears.stdout).labelled, JSON.parse(arrears.stdout).costCny], ['jury_unavailable', 0, 0]);
  assert.equal(await readFile(cache, 'utf8').catch(() => ''), '');
  assert.ok((await t.ledger()).settles.slice(settled).every((entry) => entry.outcome === 'failed' && entry.actualCny === 0));
  assert.ok(!arrears.stdout.includes(KEY) && !arrears.stderr.includes(KEY));
  const healthy = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'recovered.json'), '--cache', cache]);
  assert.ok(!healthy.code, healthy.stderr);
  assert.deepEqual((await t.read('recovered.json')).labels.map((label) => label.basis), ['jury-agree', 'jury-agree']);
});

test('a calibration with an unanswered row is not a finished calibration: exit 2, its file written, and the same command asks only for what is missing', async () => {
  const t = await cliTree();
  const row = gold.find((entry) => entry.n % 2 === 0);
  const partial = await t.run('calibrate', ['--out', join(t.dir, 'calibration.json'), '--gold', GOLD_PATH], { FAKE_DASHSCOPE_REJECT: row.title_raw, FAKE_DASHSCOPE_REJECT_STATUS: '401' });
  assert.equal(partial.code, 2, partial.stderr);
  const file = await t.read('calibration.json');
  const rows = gold.filter((entry) => entry.n % 2 === 0).length;
  assert.deepEqual([file.stopped, file.incomplete, file.labelled], [null, 1, rows - 1]);
  const asked = (await t.lines('dashscope.jsonl')).length;
  const resumed = await t.run('calibrate', ['--out', join(t.dir, 'calibration.json'), '--gold', GOLD_PATH]);
  assert.ok(!resumed.code, resumed.stderr);
  assert.deepEqual((await t.lines('dashscope.jsonl')).slice(asked).map((request) => request.title), [row.title_raw, row.title_raw]);
  assert.deepEqual([(await t.read('calibration.json')).incomplete, (await t.read('calibration.json')).labelled], [0, rows]);
});

test('the command refuses by closed code: an unknown command, a missing flag, a phase or export that is not the plan\'s, a lab configuration without the provider', async () => {
  const t = await cliTree();
  const closed = async (result) => JSON.parse(result.stderr);
  assert.deepEqual(await closed(await execFileAsync(process.execPath, [STAND_IN, 'items', '--out', 'x'], { cwd: t.dir, env: { PATH: process.env.PATH } }).catch((error) => error)), { error: 'usage_command' });
  assert.deepEqual(await closed(await execFileAsync(process.execPath, [STAND_IN, 'label', '--out', 'x'], { cwd: t.dir, env: { PATH: process.env.PATH } }).catch((error) => error)), { error: 'usage_missing_credential' });
  const phase = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'all', '--out', join(t.dir, 'x.json')]);
  assert.deepEqual([phase.code, await closed(phase)], [1, { error: 'usage_phase' }]);
  const nothing = await t.run('label', ['--out', join(t.dir, 'x.json')]);
  assert.deepEqual([nothing.code, await closed(nothing)], [1, { error: 'usage_missing_export' }]);
  await writeFile(join(t.dir, 'other.json.gz'), gzipSync('{"texts":{},"days":[]}'));
  const other = await t.run('label', ['--export', join(t.dir, 'other.json.gz'), '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'x.json')]);
  assert.deepEqual([other.code, await closed(other)], [1, { error: 'campaign_export_changed' }]);
  const { providers, ...bare } = labConfiguration;
  await writeFile(join(t.dir, 'config.json'), JSON.stringify(bare));
  const noProvider = await t.run('label', ['--export', t.exportPath, '--plan', join(t.dir, 'plan.json'), '--phase', 'development', '--out', join(t.dir, 'x.json')]);
  assert.deepEqual([noProvider.code, await closed(noProvider)], [1, { error: 'campaign_lab_configuration_invalid' }]);
  assert.equal((await t.lines('dashscope.jsonl')).length, 0);
});
