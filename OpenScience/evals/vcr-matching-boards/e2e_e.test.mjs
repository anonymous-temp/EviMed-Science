// Board E's end-to-end wiring: the boards a retrieval turns into, the options, and, when a local PostgreSQL is named, one judged run of a tiny
// official-format collection through dev_job's loop with a local stand-in for the model. No network, no key, no label.
//
//   node --test e2e_e.test.mjs
//   OPEN_SCIENCE_TEST_POSTGRES_URL=postgres://<user>@127.0.0.1:55433/postgres node --test e2e_e.test.mjs   (also runs the judged block)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { dropDatabase, scratchUrl } from './devdb.mjs';
import { EXIT, buildBoards, manifestFor, parseOptions, runEndToEnd } from './e2e_e.mjs';
import { startFakeProvider } from './fake_provider.mjs';
import { buildCollections, tmp } from './retrieve_e_fixture.mjs';

const SERVER_URL = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const cleanups = /** @type {Array<() => Promise<void> | void>} */ ([]);
after(async () => { for (const fn of cleanups) await fn(); });

const XML_2021 = '<topics><topic number="1">A 58-year-old woman with stage IV lung adenocarcinoma.</topic><topic number="2">A 7 year old boy with migraine.</topic></topics>';
const RETRIEVED = [
  { topic: 'trec-20211', year: 2021, retrieved: ['NCT00000001', 'NCT00000002', 'NCT00000002', 'NCT00000005'] },
  { topic: 'trec-20212', year: 2021, retrieved: ['NCT00000003', 'NCT00000004'] },
];

describe('the boards a retrieval becomes', () => {
  const collections = buildCollections();
  cleanups.push(() => fs.rmSync(collections, { recursive: true, force: true }));

  test('one case per topic with the first N distinct ids in retrieval order, and a manifest that gives the platform the same revision', async () => {
    const out = tmp('boards');
    cleanups.push(() => fs.rmSync(out, { recursive: true, force: true }));
    const notes = new Map([['trec-20211', 'Record one.'], ['trec-20212', 'Record two.']]);
    const made = buildBoards({ records: RETRIEVED, notes, collectionsDir: collections, topN: 3, outDir: out, years: [2021, 2022, 2023] });
    assert.deepEqual(Object.keys(made), ['2021']);
    const cases = fs.readFileSync(path.join(made[2021].boardsDir, 'A-trec2021', 'cases.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(cases.map((row) => [row.patientId, row.candidateIds, row.candidateCount, row.split, row.collection, row.note]), [
      ['trec-20211', ['NCT00000001', 'NCT00000002', 'NCT00000005'], 3, 'dev', 'trec-ct-2021', 'Record one.'],
      ['trec-20212', ['NCT00000003', 'NCT00000004'], 2, 'dev', 'trec-ct-2021', 'Record two.'],
    ]);
    const copy = path.join(made[2021].boardsDir, 'collections', 'trec-ct-2021', 'collection.json');
    const here = createVcrTrialCorpus(copy), there = createVcrTrialCorpus(manifestFor(collections, 2021));
    try { assert.equal(here?.revision, there?.revision, 'the collection revision a judgment names is the one the retrieval searched'); } finally { await here?.close(); await there?.close(); }
    assert.ok(path.isAbsolute(JSON.parse(fs.readFileSync(copy, 'utf8')).databasePath));
    assert.equal(manifestFor(collections, 2022), manifestFor(collections, 2021), 'TREC 2021 and 2022 share the snapshot');
    assert.throws(() => buildBoards({ records: RETRIEVED, notes: new Map(), collectionsDir: collections, topN: 3, outDir: out, years: [2021] }), { code: 'topic_missing' });
  });
});

describe('options', () => {
  const base = ['--retrieved', 'r.jsonl', '--exp', 'e1', '--topics', 't', '--collections', 'c', '--data-dir', 'd', '--qrels-dir', 'q'];
  test('top N, years and the experiment are checked; the qrels are needed only to score', () => {
    const o = parseOptions(base, {});
    assert.deepEqual([o.topN, o.mode, o.thinking, o.years, o.capCny, o.score], [100, 'fit', 'off', [2021, 2022, 2023], '8', true]);
    assert.throws(() => parseOptions([...base, '--top-n', '501'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--years', '2019'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(base.map((value) => (value === 'e1' ? 'E 1' : value)), {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(base.slice(0, -2), {}), { code: 'option_missing' });
    assert.equal(parseOptions([...base.slice(0, -2), '--no-score'], {}).score, false);
  });
});

describe('a judged run on the tiny collection', { skip: !SERVER_URL && 'OPEN_SCIENCE_TEST_POSTGRES_URL names no local PostgreSQL' }, () => {
  /** @type {string} */ let dir, dbName, dbUrl, collections;
  before(() => {
    dir = tmp('e2e');
    collections = buildCollections();
    dbName = `evimed_test_s8e_t${Math.random().toString(16).slice(2, 10)}`;
    dbUrl = scratchUrl({ serverUrl: SERVER_URL, name: dbName });
    fs.mkdirSync(path.join(dir, 'topics'));
    fs.writeFileSync(path.join(dir, 'topics', 'topics2021.xml'), XML_2021);
    fs.writeFileSync(path.join(dir, 'retrieved.jsonl'), `${RETRIEVED.map((row) => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'key'), 'not-a-real-key\n', { mode: 0o600 });
  });
  after(async () => {
    await dropDatabase(dbUrl).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(collections, { recursive: true, force: true });
  });

  test('the top N is judged once per pair, fit only, thinking off, and the saved ranking holds exactly those trials', async () => {
    const provider = await startFakeProvider({ expectThinking: 'off', expectKey: 'not-a-real-key' });
    try {
      const o = parseOptions(['--retrieved', path.join(dir, 'retrieved.jsonl'), '--exp', 'e1', '--top-n', '3', '--topics', path.join(dir, 'topics'), '--collections', collections,
        '--data-dir', path.join(dir, 'data'), '--key-file', path.join(dir, 'key'), '--base-url', provider.url, '--db-name', dbName, '--allow-peak', '--no-score', '--concurrency', '3'],
      { OPEN_SCIENCE_TEST_POSTGRES_URL: SERVER_URL });
      const lines = /** @type {string[]} */ ([]);
      const outcome = await runEndToEnd(o, { log: (line) => lines.push(line), devDeps: { signals: false } });
      assert.equal(outcome.exitCode, EXIT.finished, lines.join('\n'));
      assert.deepEqual(provider.violations, []);
      assert.equal(provider.requests.length, 3 + 2, 'one trial-level call per pair: three for the first topic, two for the second');
      assert.ok(provider.requests.every((request) => !request.criteria && request.thinking === 'off'));
      const records = fs.readFileSync(outcome.judgments['2021'], 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => [record.patientId, record.status, record.ranking.length]), [['trec-20211', 'complete', 3], ['trec-20212', 'complete', 2]]);
      assert.deepEqual(new Set(records[0].ranking.map((entry) => entry.registryId)), new Set(['NCT00000001', 'NCT00000002', 'NCT00000005']));
      assert.ok(records[0].ranking.every((entry, at, all) => at === 0 || all[at - 1].fit >= entry.fit), 'ranked by the judge, best first');
      // The run again continues from the platform's ledger and pays for nothing.
      const before = provider.requests.length;
      const again = await runEndToEnd(o, { log: () => {}, devDeps: { signals: false } });
      assert.equal(again.exitCode, EXIT.finished);
      assert.equal(provider.requests.length, before);
    } finally { await provider.close(); }
  });
});
