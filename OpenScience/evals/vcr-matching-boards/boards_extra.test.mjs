// Boards F (n2c2 cohort selection) and G (Chinese robustness): the pure pieces, the preparation on made-up notes, and board F through the
// platform's judging job on a real PostgreSQL with the fake provider. Every note here is made up; no real note is read.
//
//   OPEN_SCIENCE_TEST_POSTGRES_URL=postgres://<user>@127.0.0.1:55433/evimed_test node --test boards_extra.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CRITERIA } from '../vcr-matching/n2c2/criteria.mjs';
import { dropDatabase, scratchUrl } from './devdb.mjs';
import { EXTRA_BOARDS, boardNames, boardSpec } from './extra_boards.mjs';
import { startFakeProvider } from './fake_provider.mjs';
import { TAGS, n2c2Protocol, n2c2Record, recordsOfNote, stateOfLabel } from './n2c2_board.mjs';
import { prepareF } from './prepare_f.mjs';
import { PROMPT_SHA256, SYSTEM, ZH_BOARDS, numbersMatch, numbersOf, parseOptions as parseZhOptions, prepareZh, readsAsChinese, translateOne } from './prepare_zh.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.VCR_BOARDS_PYTHON || 'python3';

const SERVER_URL = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const tmp = (/** @type {string} */ label) => fs.mkdtempSync(path.join(os.tmpdir(), `vcr-extra-${label}-`));

/** A made-up n2c2 root: `count` training patients with two dated records and thirteen tags each. */
function madeUpRoot(count = 6) {
  const root = tmp('n2c2');
  const train = path.join(root, 'work', 'train', 'train');
  fs.mkdirSync(train, { recursive: true });
  for (let id = 100; id < 100 + count; id += 1) {
    const tags = TAGS.map((tag, index) => `<${tag} met="${(id + index) % 3 === 0 ? 'met' : 'not met'}" />`).join('\n');
    fs.writeFileSync(path.join(train, `${id}.xml`), `<?xml version="1.0" encoding="UTF-8" ?>\n<PatientMatching>\n<TEXT><![CDATA[\n\nRecord date: 21${id % 90}-03-04\n\nFirst visit, patient ${id}.\n\nRecord date: 21${id % 90}-09-30\n\nSecond visit, patient ${id}.\n]]></TEXT>\n<TAGS>\n${tags}\n</TAGS>\n</PatientMatching>\n`);
  }
  return root;
}

describe('the boards', () => {
  test('F and G are named, the first boards are left as they were, and each extra board knows its scorer', () => {
    assert.deepEqual(Object.keys(EXTRA_BOARDS), ['n2c2', 'sigir-zh', 'trec2021-zh-dev', 'trec2022-zh-dev']);
    assert.equal(boardNames().length, 9);
    assert.deepEqual([boardSpec('sigir')?.scorer, boardSpec('n2c2')?.scorer, boardSpec('sigir-zh')?.scorer, boardSpec('trec2021-zh-dev')?.cohort], ['a', 'f', 'a', 'trec_2021']);
    assert.equal(boardSpec('nope'), null);
    assert.equal(boardSpec('constructor'), null, 'a name that is on every object is not a board');
  });
});

describe('board F: the protocol, the records and the answers', () => {
  test('the protocol is the guide\'s thirteen criteria in the scorer\'s order, every clause an inclusion, with a stable key', () => {
    const protocol = n2c2Protocol();
    assert.equal(protocol.criteria.length, 13);
    assert.deepEqual(protocol.tags, [...TAGS]);
    assert.deepEqual(protocol.criteria.map((clause) => clause.sourceText), CRITERIA.map((criterion) => criterion.sourceText));
    assert.ok(protocol.criteria.every((clause) => clause.kind === 'inclusion'));
    assert.match(protocol.criteria[0].sourceText, /^History of intra abdominal surgery/u);
    assert.equal(n2c2Protocol().key, protocol.key);
  });
  test('a note is cut at its `Record date:` lines into dated records, each kept whole', () => {
    const note = '\n\nRecord date: 2101-03-04\n\nFirst.\nMore of the first.\n\nRecord date: 2099-12-31\n\nSecond.\n\n';
    const records = recordsOfNote(note);
    assert.deepEqual(records.map((record) => record.date), ['2101-03-04', '2099-12-31'], 'in the order of the file');
    assert.equal(records[0].text, 'Record date: 2101-03-04\n\nFirst.\nMore of the first.');
    assert.equal(records[1].text, 'Record date: 2099-12-31\n\nSecond.');
    assert.deepEqual(recordsOfNote('no dates at all'), []);
  });
  test('a label is a yes, a no, or neither', () => {
    assert.deepEqual(['included', 'not_included', 'Not Included', 'not_enough_information', 'not applicable', 'excluded', null].map(stateOfLabel), ['met', 'not met', 'not met', 'unknown', 'unknown', 'unknown', 'unknown']);
  });
  test('a record names each tag by its clause number, counts what is held, and notes a clause whose words are not the guide\'s', () => {
    const clause = (/** @type {number} */ number, /** @type {string} */ label, words = CRITERIA[number - 1].sourceText) => ({ number, label, basis: 'stated', sentenceIds: [0], clause: words });
    const full = n2c2Record({ case: { patientId: 'p1' }, judgment: { criteria: CRITERIA.map((_, index) => clause(index + 1, 'included')) } });
    assert.equal(full.status, 'complete');
    assert.deepEqual(Object.keys(full.labels), [...TAGS]);
    assert.equal(full.labels.HBA1C.label, 'included');
    const some = n2c2Record({ case: { patientId: 'p1' }, judgment: { criteria: [clause(1, 'not_included', 'other words'), clause(8, 'included'), clause(99, 'included', 'beyond the thirteen')] }, usage: { inputTokens: 5 } });
    assert.deepEqual([some.status, Object.keys(some.labels), some.clauseTextDiffers, some.usage], ['partial', ['ABDOMINAL', 'ENGLISH'], 1, { inputTokens: 5 }]);
    assert.equal(n2c2Record({ case: { patientId: 'p1' }, judgment: null }).status, 'none');
    assert.equal(n2c2Record({ case: { patientId: 'p1' }, judgment: null, failed: [{ registryId: 'x', code: 'c' }] }).status, 'failed');
  });
});

describe('board F: preparation on made-up notes', () => {
  test('notes and labels go to different directories, the split is the fixed salted hash, and nothing is replaced', async () => {
    const root = madeUpRoot(6);
    const out = tmp('out'), labelsOut = tmp('labels');
    try {
      const result = await prepareF({ root, out, labelsOut, rule: { salt: 'n2c2-dev-v1', size: 2 } });
      assert.deepEqual([result.train, result.dev, result.heldout, result.test], [6, 2, 4, null]);
      const cases = fs.readFileSync(path.join(out, 'F-n2c2', 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(cases.length, 6);
      assert.ok(cases.every((row) => row.cohort === 'n2c2' && row.patientId.startsWith('n2c2-') && row.records.length === 2 && row.records[0].text.startsWith('Record date: ')));
      assert.ok(!JSON.stringify(cases).includes('"met"') && !JSON.stringify(cases).includes('tags'), 'a label never reaches the runner\'s directory');
      const labels = fs.readFileSync(path.join(labelsOut, 'F-n2c2', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(labels.map((row) => row.patientId), cases.map((row) => row.patientId));
      assert.ok(labels.every((row) => Object.keys(row.tags).length === 13));
      assert.equal(cases.filter((row) => row.split === 'train-dev').length, 2);
      assert.equal(fs.existsSync(path.join(out, 'F-n2c2', 'cases-test.jsonl')), false, 'the test notes are not written unless asked');
      await assert.rejects(() => prepareF({ root, out, labelsOut, rule: { salt: 'n2c2-dev-v1', size: 2 } }), { code: 'EEXIST' });
      const again = JSON.parse(fs.readFileSync(path.join(out, 'F-n2c2', 'manifest.json'), 'utf8'));
      assert.deepEqual([again.counts.dev, again.testSealed, again.casesSha256], [2, true, result.casesSha256]);
    } finally { for (const dir of [root, out, labelsOut]) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('the real split is 40 and 162 by the salt the n2c2 README used (same ids, same digest) when the real files are named', { skip: !process.env.EVIMED_N2C2_ROOT && 'EVIMED_N2C2_ROOT is not set' }, async () => {
    const out = tmp('real-out'), labelsOut = tmp('real-labels');
    try {
      const result = await prepareF({ root: /** @type {string} */ (process.env.EVIMED_N2C2_ROOT), out, labelsOut });
      assert.deepEqual([result.train, result.dev, result.heldout], [202, 40, 162]);
      assert.equal(result.devDigest, 'abf3d52129f817e06fec1cfb54554133a579681a4c76270f869e5fb74963652c', 'the README\'s frozen development ids');
      assert.equal(result.heldoutDigest, '966c56cf8596a1291afdf38b2b2b78785eaf49e01143d605a8148ce4fcdb5905', 'and its frozen held-out ids');
    } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(labelsOut, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Board G
// ---------------------------------------------------------------------------------------------------------------------

describe('board G: what code can check of a translation', () => {
  test('numbers are a multiset the translation has to give back, in either decimal mark', () => {
    assert.deepEqual(numbersOf('A 45-year-old, 3.5 mg twice, BP 120/80, 1,5 L'), ['1.5', '120', '3.5', '45', '80']);
    assert.equal(numbersMatch('Aged 45 with HbA1c 7.2%.', '45岁，糖化血红蛋白7.2%。'), true);
    assert.equal(numbersMatch('Aged 45 with HbA1c 7.2%.', '45岁，糖化血红蛋白7.3%。'), false);
    assert.equal(numbersMatch('Twice daily, 5 mg.', '每日两次，5 mg，共5天'), false, 'a number added is as wrong as one dropped');
    assert.equal(numbersMatch('No numbers here.', '这里没有数字。'), true);
    assert.deepEqual(numbersOf('HbA1c 7.2% and vitamin B12 at 300 pg/mL, COVID-19'), ['19', '300', '7.2'], 'a digit inside a name is part of the name');
  });
  test('Chinese is told by its characters, so an untranslated note or a half-translated one is not accepted', () => {
    assert.equal(readsAsChinese('患者为45岁男性，有哮喘病史。'), true);
    assert.equal(readsAsChinese('A 45-year-old man with asthma.'), false);
    assert.equal(readsAsChinese('A 45-year-old man with asthma. 患者'), false);
    assert.equal(readsAsChinese(''), false);
  });
  test('a translation that drops a number is asked for again with a reminder; one that never keeps them is kept and flagged', async () => {
    const source = 'A 45-year-old man takes 5 mg daily.';
    const asked = [];
    const result = await translateOne({ source, ask: async (_text, reminder) => { asked.push(reminder ?? null); return { content: reminder ? '一名45岁男性每日服用5 mg。' : '一名男性每日服用5 mg。', cost: 0.01, inputTokens: 10, outputTokens: 5 }; } });
    assert.deepEqual([result.numbersOk, result.attempts, asked.length, result.cost], [true, 2, 2, 0.02]);
    assert.match(String(asked[1]), /exactly as in the original/u);
    const stubborn = await translateOne({ source, ask: async () => ({ content: '一名男性每日服用药物。', cost: 0.01, inputTokens: 1, outputTokens: 1 }) });
    assert.deepEqual([stubborn.numbersOk, stubborn.attempts], [false, 2]);
    const first = await translateOne({ source, ask: async () => ({ content: '一名45岁男性每日服用5 mg。', cost: 0.01, inputTokens: 1, outputTokens: 1 }) });
    assert.deepEqual([first.numbersOk, first.attempts], [true, 1]);
  });
  test('the instruction fixes what the translator may and may not do, and its hash is the frozen one', () => {
    assert.match(SYSTEM, /Add nothing, omit nothing, explain nothing and infer nothing/u);
    assert.match(SYSTEM, /exactly as written/u);
    assert.equal(PROMPT_SHA256.length, 64);
    assert.deepEqual(ZH_BOARDS.map((board) => board.name), ['sigir-zh', 'trec2021-zh-dev', 'trec2022-zh-dev']);
    assert.ok(ZH_BOARDS.every((board) => board.split === 'dev'));
  });
});

describe('board G: preparation and a run, against the fake provider', { skip: !SERVER_URL && 'OPEN_SCIENCE_TEST_POSTGRES_URL names no local PostgreSQL' }, () => {
  /** @type {string} */ let dir, boards, zh, dbName, dbUrl, keyFile;
  const ids = Array.from({ length: 8 }, (_, index) => `NCT9100000${index + 1}`);
  before(() => {
    dir = tmp('zh');
    boards = path.join(dir, 'boards'); zh = path.join(dir, 'zh');
    const trials = path.join(dir, 'trial-json');
    fs.mkdirSync(trials, { recursive: true });
    for (const id of ids) fs.writeFileSync(path.join(trials, `${id}.json`), JSON.stringify({ nctid: id, title: `Synthetic trial ${id}`, brief_summary: 'A synthetic summary.', raw_criteria: 'Inclusion Criteria:\n\n* Adults with asthma\n\nExclusion Criteria:\n\n* Pregnancy',
      study_type: 'INTERVENTIONAL', phases: ['PHASE2'], condition: ['Asthma'], minimum_age: '18 Years', maximum_age: '', sex: 'ALL', overall_status: 'COMPLETED' }));
    const built = spawnSync(PYTHON, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import prepare; prepare.build_collection(${JSON.stringify(trials)}, ${JSON.stringify(path.join(boards, 'collections', 'tg2-sigir'))}, 'sigir')`], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const make = (/** @type {string} */ cohort, /** @type {string} */ collection, /** @type {string} */ prefix, /** @type {number} */ count, /** @type {string[]} */ splits) => Array.from({ length: count }, (_, index) => ({
      caseId: `${prefix}-${index + 1}`, patientId: `${prefix}-${index + 1}`, cohort, collection, split: splits[index % splits.length], note: `A ${40 + index}-year-old person with asthma. They use 2 puffs of an inhaler daily.`, candidateIds: ids.slice(0, 5), candidateCount: 5 }));
    for (const [dirName, rows] of [['A-sigir', make('sigir', 'tg2-sigir', 'sigir-t', 3, ['dev'])], ['A-trec2021', make('trec_2021', 'tg2-trec-2021', 'trec-2021-t', 3, ['dev', 'test', 'dev'])], ['A-trec2022', make('trec_2022', 'tg2-trec-2022', 'trec-2022-t', 2, ['dev'])]]) {
      fs.mkdirSync(path.join(boards, dirName), { recursive: true });
      fs.writeFileSync(path.join(boards, dirName, 'cases.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    dbName = `evimed_test_vmzh_t${Math.random().toString(16).slice(2, 10)}`;
    dbUrl = scratchUrl({ serverUrl: SERVER_URL, name: dbName });
    keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
  });
  after(async () => { await dropDatabase(dbUrl).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });

  const options = (/** @type {string[]} */ extra, /** @type {string} */ url) => parseZhOptions(['--boards', boards, '--out', zh, '--data-dir', path.join(dir, 'data'), '--key-file', keyFile, '--base-url', url, '--db-url', SERVER_URL ?? '', '--db-name', dbName, '--allow-peak', '--concurrency', '3', ...extra], {});
  /** The "translator": Chinese words and the digits of the note, in order; a note whose first digit is 4 and which is asked for the first time loses a digit. */
  const translator = (/** @type {{ flawed?: RegExp }} */ { flawed } = {}) => (/** @type {number} */ _index, /** @type {any} */ body) => {
    const user = String(body.messages.at(-1).content);
    const reminded = /exactly as in the original/u.test(user);
    const digits = (user.split('\n\n')[0].match(/\d+/gu) ?? []);
    const kept = flawed && flawed.test(user) ? digits.slice(1) : reminded && flawed ? digits : digits;
    return `患者是${kept[0] ?? ''}岁的人，有哮喘，每天使用${kept[1] ?? ''}喷吸入剂。`;
  };

  test('a plan sends nothing; the translation goes through the gateway call with thinking off and the stage budget in force', async () => {
    const provider = await startFakeProvider({ expectThinking: 'off', expectKey: 'not-a-real-key', contentWhen: translator() });
    try {
      const planned = await prepareZh({ ...options(['--plan-only'], provider.url) }, { log: () => {}, balance: null });
      assert.deepEqual([planned.planOnly, planned.notes, planned.missing], [true, 7, 7]);
      assert.equal(provider.requests.length, 0);
      await assert.rejects(() => prepareZh({ ...options(['--budget-cny', '0.0000001'], provider.url) }, { log: () => {}, balance: null }), { code: 'stage_budget' });
      assert.equal(provider.requests.length, 0, 'refused before the first call');
      await assert.rejects(() => prepareZh({ ...options([], provider.url), allowPeak: false }, { log: () => {}, balance: null, now: () => new Date('2026-11-04T08:00:00Z') }), { code: 'peak_window' });
      assert.equal(provider.requests.length, 0);
    } finally { await provider.close(); }
  });

  test('every dev note of the three boards is translated once, checked for its numbers, and frozen with hashes beside the first boards\' ids', async () => {
    const provider = await startFakeProvider({ expectThinking: 'off', contentWhen: translator() });
    try {
      const result = await prepareZh(options([], provider.url), { log: () => {}, balance: null });
      assert.equal(result.frozen, true);
      assert.deepEqual(result.boards.map((board) => [board.board, board.cases, board.numberMismatches, board.notChinese]), [['sigir-zh', 3, 0, 0], ['trec2021-zh-dev', 2, 0, 0], ['trec2022-zh-dev', 2, 0, 0]]);
      assert.equal(provider.requests.length, 7, 'one call a note; the test-split note of the TREC 2021 board is not translated');
      assert.deepEqual(provider.violations, []);
      assert.ok(provider.requests.every((request) => request.thinking === 'off' && request.model === 'deepseek-flash' && !request.jsonMode));
      const cases = fs.readFileSync(path.join(zh, 'A-sigir-zh', 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const originals = fs.readFileSync(path.join(boards, 'A-sigir', 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(cases.map((row) => row.patientId), originals.map((row) => row.patientId), 'the same patient ids, so the same qrels');
      assert.deepEqual(cases.map((row) => row.candidateIds), originals.map((row) => row.candidateIds), 'the same candidates');
      assert.ok(cases.every((row, index) => readsAsChinese(row.note) && row.language === 'zh-Hans' && row.translatedFrom.length === 64 && row.collection === originals[index].collection));
      const manifest = JSON.parse(fs.readFileSync(path.join(zh, 'A-sigir-zh', 'manifest.json'), 'utf8'));
      assert.deepEqual([manifest.frozen, manifest.thinking, manifest.promptSha256, manifest.model], [true, 'off', PROMPT_SHA256, 'deepseek-flash']);
      assert.equal(manifest.casesSha256.length, 64);
      assert.ok(manifest.costCny > 0 && manifest.inputTokens > 0);
      const again = await prepareZh(options([], provider.url), { log: () => {}, balance: null });
      assert.deepEqual([again.frozen, again.boards.length, provider.requests.length], [true, 0, 7], 'a frozen board is never translated or written again');
    } finally { await provider.close(); }
  });

  test('a note whose numbers do not come back is asked again once, and a board with one that never does is frozen with it counted', async () => {
    const other = tmp('zh2');
    const provider = await startFakeProvider({ contentWhen: translator({ flawed: /41-year-old/u }) });
    try {
      const result = await prepareZh({ ...options([], provider.url), out: other }, { log: () => {}, balance: null });
      const sigir = result.boards.find((board) => board.board === 'sigir-zh');
      assert.equal(sigir.numberMismatches, 1, 'the one note that never keeps its numbers is counted, not hidden');
      assert.ok(sigir.attempts >= 4, 'it was asked twice');
      const cache = fs.readFileSync(path.join(other, 'translations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(cache.filter((entry) => !entry.numbersOk).length >= 1, true);
    } finally { await provider.close(); fs.rmSync(other, { recursive: true, force: true }); }
  });

  test('an interrupted translation resumes from its cache and asks only for what is missing', async () => {
    const other = tmp('zh3');
    const refusing = { on: true };
    const provider = await startFakeProvider({ contentWhen: translator(), failWhen: (_index, body) => (refusing.on && String(body.messages.at(-1).content).includes('42-year-old') ? 400 : null) });
    try {
      await assert.rejects(() => prepareZh({ ...options([], provider.url), out: other }, { log: () => {}, balance: null }), { code: 'translations_missing' });
      const paid = provider.requests.length;
      assert.ok(paid >= 7 - 1);
      refusing.on = false;
      const result = await prepareZh({ ...options([], provider.url), out: other }, { log: () => {}, balance: null });
      assert.equal(result.frozen, true);
      assert.ok(provider.requests.length - paid <= 3, 'only the missing note (asked per board that lacked it) is asked for again');
    } finally { await provider.close(); fs.rmSync(other, { recursive: true, force: true }); }
  });
});
