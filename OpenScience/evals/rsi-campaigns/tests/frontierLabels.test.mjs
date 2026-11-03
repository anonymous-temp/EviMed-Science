import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRONTIER_JURY_EFFORT, FRONTIER_JURY_MODEL, FRONTIER_JURY_VERSION, JuryError, buildLabelItemsFile, calibrateJury, calibrationItems, claudeCliCaller, claudeCliEnvironment, frontierJuryMessages,
  frontierJuryPromptDigest, frontierJuryVersion, goldItemText, juryQualified, labelFrontierItems, labelItemText, loadGoldRows, loadLabelItems, parseJuryAnswer, selectFrontierExemplars,
} from '../frontier_labels.mjs';

const execFileAsync = promisify(execFile);
const gold = await loadGoldRows(new URL('../../frontier-selection/gold.jsonl', import.meta.url));
const exemplars = selectFrontierExemplars(gold);
const NOW = () => '2026-10-26T04:00:00.000Z';
/** Every scratch directory a test makes is removed when the file is done. */
const made = [];
const tmp = async () => { const dir = await mkdtemp(join(tmpdir(), 'frontier-labels-')); made.push(dir); return dir; };
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));
const FAKE_CLI = new URL('./fixtures/fake_claude_cli.mjs', import.meta.url).pathname;
const labelsScript = new URL('../frontier_labels.mjs', import.meta.url).pathname;
const item = (id, extra = {}) => ({ id, text: { title_raw: `Item ${id}`, source_name: 'Source', source_type: 'media', journal: null, publication_types: [], published_at: '2026-10-25T00:00:00.000Z', date_precision: 'day', lang: 'en', excerpt: `Text of ${id}` }, ...extra });
/** What a call reports: the CLI's usage as the caller maps it (cache read, uncached input plus cache creation, output). */
const USAGE = { cacheHit: 1000, cacheMiss: 500, output: 50 };

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
  const result = await labelFrontierItems({ items: ['a', 'b', 'c', 'd'].map((id) => item(id)), exemplars, callModel: model.callModel, now: NOW });
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
  await labelFrontierItems({ items: [item('a')], exemplars, callModel, now: NOW });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], frontierJuryMessages(item('a').text, { exemplars, today: '2026-10-25' })[0].content);
  assert.equal(seen[1], frontierJuryMessages(item('a').text, { exemplars: [...exemplars].reverse(), today: '2026-10-25' })[0].content);
});

test('the user message date is the item day, else the injected clock in Asia/Shanghai', async () => {
  const users = [];
  const callModel = async (messages) => { users.push(messages[1].content.split('\n')[0]); return { text: '{"worth":"ok","why":""}', usage: USAGE, requestId: null, finishReason: 'stop' }; };
  await labelFrontierItems({ items: [item('a', { today: '2026-10-20' }), item('b'), item('c', { today: null })], exemplars, callModel, now: () => '2026-10-26T17:00:00.000Z', concurrency: 1 });
  assert.deepEqual([...new Set(users)], ['今天是 2026-10-20（Asia/Shanghai）', '今天是 2026-10-27（Asia/Shanghai）']);
});

test('a Claude call costs no lab cash: no budget, no price, tokens summed, and every record says subscription', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const model = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: model.callModel, cachePath, now: NOW });
  assert.deepEqual([result.costCny, result.costBasis, result.calls], [0, 'subscription', 4]);
  assert.deepEqual(result.tokens, { cacheHit: 4000, cacheMiss: 2000, output: 200 });
  const records = (await readFile(cachePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 4);
  assert.deepEqual(Object.keys(records[0]).sort(), ['costBasis', 'costCny', 'effort', 'finishReason', 'id', 'juryVersion', 'model', 'pass', 'requestId', 'today', 'usage', 'why', 'worth']);
  assert.ok(records.every((record) => record.costCny === 0 && record.costBasis === 'subscription' && record.model === 'claude-sonnet-5-5' && record.effort === 'medium'));
  assert.deepEqual(records[0].usage, USAGE);
  // A reply that reports no usage is still a label; its tokens are simply not counted.
  const silent = await labelFrontierItems({ items: [item('a')], exemplars, callModel: fakeModel({ a: ['ok', 'ok'] }, { usage: null }).callModel, now: NOW });
  assert.deepEqual([silent.labels.length, silent.tokens, silent.costCny], [1, { cacheHit: 0, cacheMiss: 0, output: 0 }, 0]);
});

test('the jury is a pinned Claude model at a named effort, and nothing else is admitted', async () => {
  const callModel = fakeModel({}).callModel;
  for (const model of ['qwen3.8-max', 'deepseek-v4-pro', 'claude', 'Claude-sonnet-5-5', 'claude-sonnet 5']) {
    await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel, model }), { message: 'jury_model_invalid' }, String(model));
    assert.throws(() => claudeCliCaller({ model }), { code: 'jury_model_invalid' });
  }
  for (const effort of ['', 'minimal', 'Medium', 'low high']) {
    await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel, effort }), { message: 'jury_model_invalid' }, effort);
    assert.throws(() => claudeCliCaller({ effort }), { code: 'jury_model_invalid' });
  }
  await assert.rejects(labelFrontierItems({ items: [item('a')], exemplars, callModel: null }), { message: 'jury_unconfigured' });
  assert.deepEqual([FRONTIER_JURY_MODEL, FRONTIER_JURY_EFFORT], ['claude-sonnet-5-5', 'medium']);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.doesNotThrow(() => claudeCliCaller({ effort }));
});

test('batches bound the calls in flight', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const model = fakeModel(Object.fromEntries(ids.map((id) => [id, ['ok', 'ok']])));
  const result = await labelFrontierItems({ items: ids.map((id) => item(id)), exemplars, callModel: model.callModel, batchSize: 4, concurrency: 3, now: NOW });
  assert.ok(model.maxInFlight <= 3 && model.maxInFlight > 1, String(model.maxInFlight));
  assert.equal(result.labels.length, 5); assert.equal(result.calls, 10);
});

test('a failed call leaves its item incomplete and the rest labelled; the run goes on', async () => {
  const rejected = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] }, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new JuryError('jury_transport', { retryable: true }) : null) });
  const first = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: rejected.callModel, now: NOW });
  assert.deepEqual(first.labels.map((label) => label.id), ['a']); assert.equal(first.incomplete, 1); assert.equal(first.stopped, null); assert.equal(first.calls, 4);
  const unknown = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'] }, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new Error('socket hang up') : null) });
  assert.equal((await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: unknown.callModel, now: NOW })).incomplete, 1);
});

test('a batch that mostly fails stops the run as jury_unavailable', async () => {
  const model = fakeModel({}, { fail: () => new JuryError('jury_transport', { retryable: true }) });
  const result = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: model.callModel, batchSize: 2, concurrency: 1, now: NOW });
  assert.equal(result.stopped, 'jury_unavailable'); assert.equal(model.calls.length, 2, 'the second batch is not started'); assert.deepEqual(result.labels, []);
});

test('a spent usage window or a refused login stops the run at once and keeps what was answered', async () => {
  for (const code of ['jury_quota', 'jury_auth', 'jury_cli_unavailable']) {
    const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
    let served = 0;
    const model = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'], c: ['no', 'no'] }, { fail: () => (++served > 2 ? new JuryError(code) : null) });
    const result = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: model.callModel, cachePath, concurrency: 1, batchSize: 40, now: NOW });
    assert.equal(result.stopped, code);
    assert.equal(model.calls.length, 3, `${code}: no call after the refusal`);
    assert.deepEqual(result.labels.map((label) => label.id), ['a'], 'the answered item is a label');
    // The next run, after the window resets, asks only for what is missing.
    const healthy = fakeModel({ a: ['pick', 'pick'], b: ['ok', 'ok'], c: ['no', 'no'] });
    const second = await labelFrontierItems({ items: ['a', 'b', 'c'].map((id) => item(id)), exemplars, callModel: healthy.callModel, cachePath, now: NOW });
    assert.deepEqual(healthy.calls.map((call) => `${call.id}${call.pass}`).sort(), ['bA', 'bB', 'cA', 'cB']);
    assert.deepEqual([second.stopped, second.incomplete, second.cachedCalls, second.labels.length], [null, 0, 2, 3]);
  }
});

test('an aborted run stops and calls nothing more', async () => {
  const controller = new AbortController();
  const model = fakeModel({ a: ['ok', 'ok'], b: ['ok', 'ok'] });
  const callModel = async (messages, options) => { const reply = await model.callModel(messages, options); controller.abort(); return reply; };
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel, batchSize: 4, concurrency: 1, signal: controller.signal, now: NOW });
  assert.equal(result.stopped, 'aborted'); assert.equal(model.calls.length, 1);
});

test('an interrupted run resumes from the cache and never asks for a cached pass twice', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const answers = { a: ['pick', 'pick'], b: ['ok', 'no'] };
  const broken = fakeModel(answers, { fail: (id, pass) => (id === 'b' && pass === 'B' ? new Error('connection reset') : null) });
  const first = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: broken.callModel, cachePath, now: NOW });
  assert.equal(first.calls, 4); assert.equal(first.incomplete, 1);
  assert.equal((await readFile(cachePath, 'utf8')).trim().split('\n').length, 3);

  const healthy = fakeModel(answers);
  const second = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: healthy.callModel, cachePath, now: NOW });
  assert.deepEqual(healthy.calls, [{ id: 'b', pass: 'B' }]);
  assert.equal(second.cachedCalls, 3); assert.equal(second.calls, 1); assert.equal(second.incomplete, 0);
  assert.deepEqual(second.labels.map((label) => [label.id, label.worth, label.basis]), [['a', 'pick', 'jury-agree'], ['b', null, 'jury-disagree']]);

  const idle = fakeModel(answers);
  const third = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: idle.callModel, cachePath, now: NOW });
  assert.equal(idle.calls.length, 0); assert.equal(third.calls, 0); assert.equal(third.labels.length, 2);

  // another exemplar set, another model or another effort is another jury: nothing is reused
  const other = fakeModel(answers);
  await labelFrontierItems({ items: [item('a')], exemplars: exemplars.slice(1), callModel: other.callModel, cachePath, now: NOW });
  assert.equal(other.calls.length, 2);
  const opus = fakeModel(answers);
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: opus.callModel, cachePath, model: 'claude-opus-5-5', now: NOW });
  assert.equal(opus.calls.length, 2);
  const low = fakeModel(answers);
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: low.callModel, cachePath, effort: 'low', now: NOW });
  assert.equal(low.calls.length, 2, 'the measured figures are for one effort: another effort is not served from the medium answers');
  const again = fakeModel(answers);
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: again.callModel, cachePath, effort: 'low', now: NOW });
  assert.equal(again.calls.length, 0);
});

test('an answer from a run before efforts were recorded is not read as one', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const version = frontierJuryVersion(exemplars);
  await writeFile(cachePath, ['A', 'B'].map((pass) => JSON.stringify({ id: 'a', pass, worth: 'pick', why: '', juryVersion: version, model: 'claude-sonnet-5-5', usage: null, costCny: 0 })).join('\n') + '\n');
  const model = fakeModel({ a: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, cachePath, now: NOW });
  assert.equal(model.calls.length, 2); assert.equal(result.labels[0].worth, 'ok');
});

test('an invalid answer is cached too, so it is not asked for again', async () => {
  const dir = await tmp(), cachePath = join(dir, 'cache.jsonl');
  const model = fakeModel({ a: ['{"worth":"?"}', 'ok'] });
  await labelFrontierItems({ items: [item('a')], exemplars, callModel: model.callModel, cachePath, now: NOW });
  const again = fakeModel({ a: ['ok', 'ok'] });
  const result = await labelFrontierItems({ items: [item('a')], exemplars, callModel: again.callModel, cachePath, now: NOW });
  assert.equal(again.calls.length, 0); assert.equal(result.labels[0].basis, 'jury-invalid');
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

// ---- the Claude CLI caller ----

const MESSAGES = [{ role: 'system', content: 'SYSTEM RUBRIC\nwith two lines' }, { role: 'user', content: 'USER ITEM 标题' }];
const LEAK = 'sk-ant-LEAK';
/** A caller over the fake CLI, its log in a fresh directory; `env` is the parent environment it is given. */
async function fakeCaller(mode = 'ok', options = {}) {
  const dir = await tmp(), log = join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, HOME: dir, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode, ...options.env };
  const caller = claudeCliCaller({ cli: FAKE_CLI, env, scratchRoot: dir, sleep: async () => {}, ...options.caller });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { caller, calls, dir };
}

test('the caller runs the CLI in print mode, safe mode, no tools and no session: system message from a file, user message on stdin, the answer from the JSON result', async () => {
  const { caller, calls, dir } = await fakeCaller('ok', { env: { FAKE_CLAUDE_WORTH: 'pick' }, caller: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  const reply = await caller(MESSAGES);
  assert.deepEqual(reply, { text: '{"worth":"pick","why":"fake"}', usage: { cacheHit: 1200, cacheMiss: 740, output: 33 }, requestId: 'sess-1', finishReason: 'success' });
  const [call] = await calls();
  assert.deepEqual(call.argv, ['-p', '--safe-mode', '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--output-format', 'json', '--system-prompt-file', call.systemFile, '--tools', '', '--no-session-persistence']);
  assert.equal(call.system, MESSAGES[0].content, 'the system message is the file\'s content');
  assert.equal(call.stdin, MESSAGES[1].content, 'the user message is stdin');
  assert.ok(call.cwd.startsWith(dir) && call.cwd !== process.cwd(), 'the CLI runs in a scratch directory, not in the checkout');
  await assert.rejects(access(call.systemFile), { code: 'ENOENT' }, 'the system file is removed after the call');
  await caller.close();
  await assert.rejects(access(call.cwd), { code: 'ENOENT' });
  const opus = await fakeCaller('ok', { caller: { model: 'claude-opus-5-5', effort: 'high' } });
  await opus.caller(MESSAGES);
  assert.deepEqual((await opus.calls())[0].argv.slice(0, 6), ['-p', '--safe-mode', '--model', 'claude-opus-5-5', '--effort', 'high']);
});

test('the parent environment is scrubbed of every account, endpoint and provider variable', async () => {
  const parent = { PATH: '/usr/bin', HOME: '/home/op', LANG: 'C', ANTHROPIC_API_KEY: LEAK, ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'm', CLAUDE_CODE_OAUTH_TOKEN: LEAK, CLAUDE_CODE_USE_VERTEX: '1', CLAUDECODE: '1',
    CLAUDE_AGENT_SDK: '1', CLAUDE_CONFIG_DIR: '/x', CLAUDE_EFFORT: 'max', CLAUDE_PID: '9', AI_AGENT: 'x', CLOUD_ML_REGION: 'r', AWS_BEARER_TOKEN_BEDROCK: LEAK, GOOGLE_CLOUD_PROJECT: 'p', VERTEX_REGION: 'v',
    DEEPSEEK_API_KEY: LEAK, DASHSCOPE_API_KEY: LEAK, DASHSCOPE_BASE: 'x', OPEN_SCIENCE_X: '1' };
  const env = claudeCliEnvironment(parent);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'HOME', 'LANG', 'OPEN_SCIENCE_X', 'PATH']);
  assert.deepEqual([env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, env.DISABLE_TELEMETRY], ['1', '1']);
  const { caller, calls } = await fakeCaller('ok', { env: { ANTHROPIC_API_KEY: LEAK, CLAUDE_CODE_OAUTH_TOKEN: LEAK, CLAUDECODE: '1', DEEPSEEK_API_KEY: LEAK, DASHSCOPE_API_KEY: LEAK, VERTEX_REGION: 'v' } });
  await caller(MESSAGES);
  const [call] = await calls();
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'VERTEX_REGION']) assert.ok(!call.env.includes(name), name);
  for (const name of ['PATH', 'HOME', 'FAKE_CLAUDE_LOG', 'DISABLE_TELEMETRY']) assert.ok(call.env.includes(name), name);
});

test('a failure is a closed code and never carries a word of what the CLI printed', async () => {
  const cases = [['quota', 'jury_quota', false], ['quota-text', 'jury_quota', false], ['auth', 'jury_auth', false], ['auth-text', 'jury_auth', false], ['overloaded', 'jury_transport', true],
    ['other-error', 'jury_cli_error', true], ['transport', 'jury_transport', true], ['badjson', 'jury_bad_response', false], ['empty', 'jury_bad_response', false]];
  for (const [mode, code, retryable] of cases) {
    const { caller, calls } = await fakeCaller(mode, { caller: { retries: 0 } });
    const error = await caller(MESSAGES).then(() => assert.fail(mode), (failure) => failure);
    assert.ok(error instanceof JuryError, mode);
    assert.deepEqual([error.code, error.retryable], [code, retryable], mode);
    for (const text of [error.message, String(error), error.stack ?? '', JSON.stringify(error)]) assert.ok(!text.includes(LEAK) && !text.includes('limit') && !text.includes('hang up'), mode);
    assert.equal((await calls()).length, 1, `${mode}: retries 0`);
  }
});

test('transport, overload and unknown failures are retried, a spent window and a refused login are not', async () => {
  for (const [mode, expected] of [['transport', 3], ['overloaded', 3], ['other-error', 3], ['quota', 1], ['auth', 1], ['badjson', 1]]) {
    const { caller, calls } = await fakeCaller(mode, { caller: { retries: 2 } });
    await assert.rejects(caller(MESSAGES));
    assert.equal((await calls()).length, expected, mode);
  }
});

test('a call that outlasts its time is killed and reported as a timeout; an abort is reported as one', async () => {
  const { caller, calls } = await fakeCaller('timeout', { caller: { timeoutMs: 400, retries: 1 } });
  await assert.rejects(caller(MESSAGES), (error) => error.code === 'jury_timeout' && error.retryable === true);
  assert.equal((await calls()).length, 2);
  const controller = new AbortController();
  const slow = await fakeCaller('timeout', { caller: { timeoutMs: 30_000 } });
  const pending = slow.caller(MESSAGES, { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, (error) => error.code === 'jury_aborted' && error.retryable === false);
  const early = new AbortController(); early.abort();
  await assert.rejects(slow.caller(MESSAGES, { signal: early.signal }), { code: 'jury_aborted' });
  await slow.caller.close();
});

test('a CLI that is not there is its own code, and an answer that is not the label JSON is an abstention, not a failure', async () => {
  const dir = await tmp();
  await assert.rejects(claudeCliCaller({ cli: join(dir, 'no-such-claude'), env: { PATH: process.env.PATH }, scratchRoot: dir, retries: 0 })(MESSAGES), (error) => error.code === 'jury_cli_unavailable' && error.retryable === false);
  const { caller } = await fakeCaller('prose');
  const reply = await caller(MESSAGES);
  assert.equal(parseJuryAnswer(reply.text), null, 'reasoning before the JSON is not parsed leniently: it abstains');
  await assert.rejects(caller([MESSAGES[1]]), { code: 'jury_messages_invalid' });
});

test('the caller over the real labelling: the fake CLI labels items through the whole path, and the cache makes a rerun free', async () => {
  const { caller, calls, dir } = await fakeCaller('ok', { env: { FAKE_CLAUDE_WORTH: 'no' } });
  const cachePath = join(dir, 'cache.jsonl');
  const result = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: caller, cachePath, concurrency: 2, now: NOW });
  assert.deepEqual(result.labels.map((label) => [label.id, label.worth, label.basis]), [['a', 'no', 'jury-agree'], ['b', 'no', 'jury-agree']]);
  assert.deepEqual([result.calls, result.costCny, result.costBasis, result.tokens], [4, 0, 'subscription', { cacheHit: 4800, cacheMiss: 2960, output: 132 }]);
  const logged = await calls();
  assert.equal(logged.length, 4);
  assert.deepEqual([...new Set(logged.map((call) => call.system))].length, 2, 'two exemplar orders, so two system messages');
  const again = await labelFrontierItems({ items: [item('a'), item('b')], exemplars, callModel: caller, cachePath, now: NOW });
  assert.deepEqual([again.calls, again.cachedCalls, (await calls()).length], [0, 4, 4]);
  await caller.close();
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

// ---- the label-items file and the commands around it ----

/** A tiny export and the plan the lab would have made from it: two ids to develop on, one to confirm on, one with no text. */
async function planAndExport() {
  const dir = await tmp();
  const platform = { title_zh: 'ZH-MARK', summary_zh: 'SUMMARY-MARK', score_total: 98765, genre: 'GENRE-MARK', evidence_type: 'ET-MARK', live: { total: 4321 } };
  const texts = { 101: { ...item('101').text, ...platform }, 102: { ...item('102').text, ...platform }, 201: { ...item('201').text, ...platform } };
  const exported = { schema: 'rsi-frontier-export-v1', texts, days: [{ day: '2026-09-02', rows: [{ id: '101' }, { id: '102' }, { id: '404' }] }, { day: '2026-10-03', rows: [{ id: '201' }] }] };
  const bytes = gzipSync(JSON.stringify(exported));
  await writeFile(join(dir, 'export.json.gz'), bytes);
  const { createHash } = await import('node:crypto');
  const plan = { month: '2026-11', idPrefix: '', exportSha256: createHash('sha256').update(bytes).digest('hex'), idsByRole: { development: ['101', '102', '404'], confirmation: ['201'] } };
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  return { dir, exportPath: join(dir, 'export.json.gz'), plan };
}

test('the label-items file carries a phase\'s ids and only the source text, bound to the export, and nothing a platform model wrote', async () => {
  const { exportPath, plan } = await planAndExport();
  const development = await buildLabelItemsFile({ exportPath, plan, phase: 'development' });
  assert.deepEqual([development.schema, development.month, development.phase, development.exportSha256, development.missing], ['rsi-frontier-label-items-v1', '2026-11', 'development', plan.exportSha256, 1]);
  assert.deepEqual(development.items.map((entry) => [entry.id, entry.today]), [['101', '2026-09-02'], ['102', '2026-09-02']]);
  const text = JSON.stringify(development);
  for (const mark of ['ZH-MARK', 'SUMMARY-MARK', '98765', 'GENRE-MARK', 'ET-MARK', '4321', 'title_zh', 'score_total']) assert.ok(!text.includes(mark), mark);
  assert.deepEqual(Object.keys(development.items[0].text).sort(), Object.keys(labelItemText({})).sort());
  const confirmation = await buildLabelItemsFile({ exportPath, plan, phase: 'confirmation' });
  assert.deepEqual(confirmation.items.map((entry) => entry.id), ['201']);
  await assert.rejects(buildLabelItemsFile({ exportPath, plan, phase: 'all' }), { message: 'usage_phase' });
  await assert.rejects(buildLabelItemsFile({ exportPath, plan: { ...plan, idsByRole: undefined }, phase: 'development' }), { message: 'usage_phase' });
  await assert.rejects(buildLabelItemsFile({ exportPath, plan: { ...plan, exportSha256: 'e'.repeat(64) }, phase: 'development' }), { message: 'campaign_export_changed' });
});

test('the commands: the lab writes the items, the operator calibrates and labels them with the CLI, the labels name the phase, the export and the jury', async () => {
  const { dir, exportPath } = await planAndExport();
  const log = join(dir, 'calls.jsonl'), env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_WORTH: 'pick' };
  const run = (args, over = {}) => execFileAsync(process.execPath, [labelsScript, ...args], { cwd: dir, env: { ...env, ...over } });
  const items = JSON.parse((await run(['items', '--export', exportPath, '--plan', join(dir, 'plan.json'), '--phase', 'development', '--out', join(dir, 'items-development.json')])).stdout);
  assert.deepEqual([items.command, items.phase, items.items, items.missing], ['items', 'development', 2, 1]);
  // The operator side holds the items file and the CLI, never the export.
  const labelled = JSON.parse((await run(['label', '--items', join(dir, 'items-development.json'), '--out', join(dir, 'labels-development.json'), '--cache', join(dir, 'cache.jsonl'), '--cli', FAKE_CLI])).stdout);
  assert.deepEqual([labelled.phase, labelled.model, labelled.effort, labelled.labelled, labelled.costCny, labelled.costBasis, labelled.stopped, labelled.incomplete], ['development', 'claude-sonnet-5-5', 'medium', 2, 0, 'subscription', null, 0]);
  const file = JSON.parse(await readFile(join(dir, 'labels-development.json'), 'utf8'));
  assert.deepEqual([file.schema, file.phase, file.month, file.exportSha256, file.juryVersion.startsWith('frontier-jury-v1:'), file.promptDigest], ['rsi-frontier-jury-labels-v1', 'development', '2026-11', file.exportSha256, true, frontierJuryPromptDigest()]);
  assert.deepEqual(file.labels.map((label) => [label.id, label.worth]), [['101', 'pick'], ['102', 'pick']]);
  assert.deepEqual(file.tokens, { cacheHit: 4800, cacheMiss: 2960, output: 132 }, 'the tokens the CLI reported, summed over the four calls');
  const argv = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).map((call) => call.argv);
  assert.equal(argv.length, 4);
  assert.ok(argv.every((flags) => flags.includes('claude-sonnet-5-5') && flags[flags.indexOf('--effort') + 1] === 'medium'));
  // The effort is a flag; a rerun with the same cache asks for nothing.
  const rerun = JSON.parse((await run(['label', '--items', join(dir, 'items-development.json'), '--out', join(dir, 'labels-2.json'), '--cache', join(dir, 'cache.jsonl'), '--cli', FAKE_CLI])).stdout);
  assert.deepEqual([rerun.calls, rerun.cachedCalls], [0, 4]);
  const low = JSON.parse((await run(['label', '--items', join(dir, 'items-development.json'), '--out', join(dir, 'labels-3.json'), '--cache', join(dir, 'cache.jsonl'), '--cli', FAKE_CLI, '--effort', 'low', '--model', 'claude-opus-5-5'])).stdout);
  assert.deepEqual([low.model, low.effort, low.calls], ['claude-opus-5-5', 'low', 4]);
});

test('a calibration command measures the anchor with the CLI and writes the qualification the campaign is gated on', async () => {
  const { dir } = await planAndExport();
  const log = join(dir, 'calls.jsonl');
  // A jury that calls everything `ok` against the anchor: it abstains nowhere and picks nothing, so kappa is unavailable and the calibration does not qualify.
  const result = await execFileAsync(process.execPath, [labelsScript, 'calibrate', '--out', join(dir, 'calibration.json'), '--cache', join(dir, 'cache.jsonl'), '--cli', FAKE_CLI, '--concurrency', '8'],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_WORTH: 'ok' }, maxBuffer: 1 << 24 });
  const summary = JSON.parse(result.stdout);
  const file = JSON.parse(await readFile(join(dir, 'calibration.json'), 'utf8'));
  const evenRows = gold.filter((row) => row.n % 2 === 0).length;
  assert.deepEqual([file.schema, file.model, file.effort, file.items, file.labelled, file.calls, file.costCny, file.costBasis], ['rsi-frontier-jury-calibration-v1', 'claude-sonnet-5-5', 'medium', evenRows, evenRows, 2 * evenRows, 0, 'subscription']);
  assert.equal(file.qualification.qualified, false);
  assert.ok(file.qualification.reasons.includes('kappa_unavailable') || file.qualification.reasons.includes('pick_precision_unavailable'));
  assert.deepEqual([summary.qualified, summary.reasons], [false, file.qualification.reasons]);
  assert.equal(file.calibration.calibrationRows, evenRows);
  assert.equal(file.labels.length, evenRows);
  assert.equal(file.juryVersion, frontierJuryVersion(exemplars));
});

test('a spent usage window ends the command with exit code 2 and the answered items cached; a refused login names its code', async () => {
  const { dir, exportPath } = await planAndExport();
  const run = (mode) => execFileAsync(process.execPath, [labelsScript, 'label', '--items', join(dir, 'items.json'), '--out', join(dir, `labels-${mode}.json`), '--cache', join(dir, 'cache.jsonl'), '--cli', FAKE_CLI, '--concurrency', '1'],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, FAKE_CLAUDE_LOG: join(dir, 'calls.jsonl'), FAKE_CLAUDE_MODE: mode } }).catch((error) => error);
  await execFileAsync(process.execPath, [labelsScript, 'items', '--export', exportPath, '--plan', join(dir, 'plan.json'), '--phase', 'development', '--out', join(dir, 'items.json')]);
  const quota = await run('quota');
  assert.equal(quota.code, 2);
  const summary = JSON.parse(quota.stdout);
  assert.deepEqual([summary.stopped, summary.labelled, summary.incomplete, summary.calls], ['jury_quota', 0, 2, 1]);
  assert.ok(!quota.stdout.includes('LEAK') && !quota.stderr.includes('LEAK'));
  assert.equal(JSON.parse((await run('auth')).stdout).stopped, 'jury_auth');
  const bad = await execFileAsync(process.execPath, [labelsScript, 'label', '--items', join(dir, 'nothing.json'), '--out', join(dir, 'x.json'), '--cache', join(dir, 'cache.jsonl')], { cwd: dir }).catch((error) => error);
  assert.equal(bad.code, 1);
  const unknown = await execFileAsync(process.execPath, [labelsScript, 'bogus'], { cwd: dir }).catch((error) => error);
  assert.deepEqual(JSON.parse(unknown.stderr), { error: 'usage_command' });
});
