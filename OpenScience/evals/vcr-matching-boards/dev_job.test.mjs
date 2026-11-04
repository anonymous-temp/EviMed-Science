// The dev loop's own tests: option checks, the guards, the pure shaping of boards and records, and the loop itself on a
// synthetic board against a local fake provider and a real PostgreSQL. No paid call is made and no private data is read; the
// last block runs the real SIGIR cases and the official scorer only when the environment names them.
//
//   OPEN_SCIENCE_TEST_POSTGRES_URL=postgres://<user>@127.0.0.1:55433/evimed_test node --test dev_job.test.mjs
//   (and, for the last block) VCR_BOARDS_INPUTS VCR_BOARDS_TG2 VCR_BOARDS_TG1 VCR_BOARDS_LABELS VCR_BOARDS_PYTHON
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOARDS, chunk, criterionRecord, loadCases, noteForUpload, protocolOf, rankingRecord, recordStatus } from './board_cases.mjs';
import { EXIT, main, parseOptions, runDevJob } from './dev_job.mjs';
import { dropDatabase, scratchUrl } from './devdb.mjs';
import { startFakeProvider } from './fake_provider.mjs';
import { GuardStop, createBalanceChecker, createSpendLedger, inPeakWindow, preflight, watch } from './spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const PYTHON = process.env.VCR_BOARDS_PYTHON || 'python3';
const WEDNESDAY_PEAK = new Date('2026-11-04T08:00:00Z');
const WEDNESDAY_OFF_PEAK = new Date('2026-11-04T12:00:00Z');
const SATURDAY = new Date('2026-11-07T08:00:00Z');

const tmp = (/** @type {string} */ label) => fs.mkdtempSync(path.join(os.tmpdir(), `vcr-boards-${label}-`));

describe('options', () => {
  const base = ['--board', 'sigir', '--arm', 'a1', '--data-dir', '/tmp/d', '--boards', '/tmp/b', '--key-file', '/tmp/k'];
  test('a run needs a board, an arm, the private directories and a key file, and says which is missing', () => {
    assert.equal(parseOptions(base, {}).arm, 'a1');
    assert.throws(() => parseOptions(['--arm', 'a1'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(['--board', 'sigir', '--arm', 'No Good'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(['--board', 'sigir', '--arm', 'a1'], {}), { code: 'option_missing' });
    assert.throws(() => parseOptions(base.filter((_, index) => index < 8), {}), { code: 'option_missing' }, 'no key file');
    assert.equal(parseOptions(base.filter((_, index) => index < 8).concat('--plan-only'), {}).planOnly, true, 'a plan needs no key');
    const fromEnv = parseOptions(['--board', 'nih', '--arm', 'x'], { VCR_BOARDS_DATA: '/tmp/d', VCR_BOARDS_INPUTS: '/tmp/b', OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: '/tmp/k' });
    assert.deepEqual([fromEnv.dataDir, fromEnv.boardsDir, fromEnv.keyFile], ['/tmp/d', '/tmp/b', '/tmp/k']);
  });
  test('defaults follow the board: fit for a ranking board, clause by clause for the criterion board; thinking is validated', () => {
    const ranking = parseOptions(base, {});
    assert.deepEqual([ranking.mode, ranking.topK, ranking.thinking, ranking.concurrency, ranking.capCny, ranking.floorCny], ['fit', 10, 'high', 8, 3000, 200]);
    const criterion = parseOptions(base.map((value) => (value === 'sigir' ? 'c' : value)), {});
    assert.deepEqual([criterion.mode, criterion.topK], ['criteria', 'all']);
    assert.throws(() => parseOptions([...base.map((value) => (value === 'sigir' ? 'c' : value)), '--mode', 'fit'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--thinking', 'max'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--concurrency', '65'], {}), { code: 'option_invalid' });
    assert.equal(parseOptions([...base, '--thinking', 'off'], {}).expectedOutputTokens < parseOptions(base, {}).expectedOutputTokens, true);
  });
});

describe('the guards', () => {
  test('the full-price window is weekdays 01-04 and 06-10 UTC', () => {
    assert.equal(inPeakWindow(WEDNESDAY_PEAK), true);
    assert.equal(inPeakWindow(new Date('2026-11-04T05:59:00Z')), false);
    assert.equal(inPeakWindow(WEDNESDAY_OFF_PEAK), false);
    assert.equal(inPeakWindow(SATURDAY), false, 'a weekend is off-peak all day');
    assert.equal(inPeakWindow(new Date('2026-11-04T01:00:00Z')), true);
    assert.equal(inPeakWindow(new Date('2026-11-04T04:00:00Z')), false);
  });

  test('a start is refused in the window, past the cap, under the floor and when the balance cannot be read; nothing else refuses it', async () => {
    const ok = async () => ({ code: 0, balance: 450, line: 'balance CNY 450.00' });
    const args = { estimateCny: 100, capCny: 3000, recordedCny: 500, floor: 200, allowPeak: false, now: WEDNESDAY_OFF_PEAK, balance: ok };
    assert.equal(await preflight(args), 450);
    await assert.rejects(() => preflight({ ...args, now: WEDNESDAY_PEAK }), { code: 'peak_window' });
    assert.equal(await preflight({ ...args, now: WEDNESDAY_PEAK, allowPeak: true }), 450);
    await assert.rejects(() => preflight({ ...args, estimateCny: 2501 }), { code: 'cap' });
    assert.equal(await preflight({ ...args, estimateCny: 2500 }), 450, 'exactly the cap is still inside it');
    await assert.rejects(() => preflight({ ...args, balance: async () => ({ code: 2, balance: 150, line: '' }) }), { code: 'balance_floor' });
    await assert.rejects(() => preflight({ ...args, balance: async () => ({ code: 3, balance: null, line: 'unavailable' }) }), { code: 'balance_unreadable' });
    assert.equal(await preflight({ ...args, balance: null }), null, 'no checker: a local fake provider has no balance');
  });

  test('while it works the run stops on the window, the cap and the floor, and is not stopped by one unreadable balance', async () => {
    const quiet = { spentThisRunCny: 10, recordedBeforeCny: 100, capCny: 3000, floor: 200, allowPeak: false, now: WEDNESDAY_OFF_PEAK, balance: async () => ({ code: 0, balance: 400, line: '' }) };
    assert.deepEqual(await watch(quiet), { stop: null, unreadable: false, balance: 400 });
    assert.equal((await watch({ ...quiet, now: WEDNESDAY_PEAK })).stop?.code, 'peak_window');
    assert.equal((await watch({ ...quiet, now: WEDNESDAY_PEAK, allowPeak: true })).stop, null);
    assert.equal((await watch({ ...quiet, spentThisRunCny: 2900 })).stop?.code, 'cap');
    assert.equal((await watch({ ...quiet, balance: async () => ({ code: 2, balance: 120, line: '' }) })).stop?.code, 'balance_floor');
    const blip = await watch({ ...quiet, balance: async () => ({ code: 3, balance: null, line: '' }) });
    assert.deepEqual([blip.stop, blip.unreadable], [null, true]);
    assert.ok(new GuardStop('x', 'y') instanceof Error);
  });

  test('the spend ledger is append-only, sums every arm and never takes a negative cost', () => {
    const dir = tmp('ledger');
    try {
      const ledger = createSpendLedger(path.join(dir, 'sub', 'spend.jsonl'));
      assert.equal(ledger.recorded(), 0);
      ledger.append({ kind: 'job', arm: 'a', board: 'sigir', jobId: 'j1', costCny: 1.5 });
      ledger.append({ kind: 'job', arm: 'b', board: 'nih', jobId: 'j2', costCny: 2.25 });
      ledger.append({ kind: 'reconcile', arm: 'a', board: 'sigir', jobId: 'j3', costCny: 0.25 });
      assert.equal(ledger.recorded(), 4);
      assert.deepEqual([...ledger.jobIds()].sort(), ['j1', 'j2', 'j3']);
      assert.deepEqual(ledger.byArm(), { 'a/sigir': 1.75, 'b/nih': 2.25 });
      assert.throws(() => ledger.append({ kind: 'job', arm: 'a', board: 'sigir', jobId: 'j4', costCny: -1 }), { code: 'spend_entry_invalid' });
      assert.equal(createSpendLedger(path.join(dir, 'sub', 'spend.jsonl')).recorded(), 4, 'a second handle reads the same file');
      assert.equal(fs.readFileSync(path.join(dir, 'sub', 'spend.jsonl'), 'utf8').trim().split('\n').length, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the balance checker runs budget.py by path, passes the key file and floor, and reads only the balance line', async () => {
    const dir = tmp('budget');
    try {
      const script = path.join(dir, 'fake_budget.py');
      const seen = path.join(dir, 'argv.txt');
      fs.writeFileSync(script, `import sys, pathlib\npathlib.Path(${JSON.stringify(seen)}).write_text(' '.join(sys.argv[1:]))\nprint('balance CNY 321.50')\nsys.exit(int(open(${JSON.stringify(path.join(dir, 'exit'))}).read()))\n`);
      fs.writeFileSync(path.join(dir, 'exit'), '0');
      const check = createBalanceChecker({ python: PYTHON, script, keyFile: '/nowhere/key', floor: 200 });
      assert.deepEqual(await check(), { code: 0, balance: 321.5, line: 'balance CNY 321.50' });
      assert.equal(fs.readFileSync(seen, 'utf8'), '--key-file /nowhere/key --floor 200');
      fs.writeFileSync(path.join(dir, 'exit'), '2');
      assert.equal((await check()).code, 2);
      const missing = await createBalanceChecker({ python: '/nonexistent/python', script, keyFile: 'k' })();
      assert.deepEqual([missing.code, missing.balance], [3, null]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the real budget.py reports a peak-time refusal without touching the network', () => {
    const run = spawnSync(PYTHON, ['-I', '-B', path.join(HERE, 'budget.py'), '--key-file', '/nonexistent', '--require-off-peak'], { encoding: 'utf8' });
    assert.ok([0, 3, 4].includes(run.status ?? -1), 'a missing key file is an unreadable balance (3), never a crash');
  });
});

describe('boards and records', () => {
  const trial = (/** @type {string} */ id, /** @type {Array<[string, number, string | null]>} */ clauses) => ({
    registryId: id, trialTitle: `Title ${id}`, clauses: clauses.map(([kind, number, text], index) => ({ kind, number, text, annotationId: index })),
  });

  test('cases come back in file order, split and limited by flags, and an unsafe patient id stops the load', () => {
    const dir = tmp('cases');
    try {
      fs.mkdirSync(path.join(dir, 'A-trec2021'), { recursive: true });
      const rows = [['a', 'dev'], ['b', 'test'], ['c', 'dev'], ['d', 'test']].map(([id, split]) => ({ caseId: id, patientId: `p-${id}`, split, collection: 'tg2-trec-2021', note: 'n', candidateIds: ['NCT00000001'], candidateCount: 1 }));
      fs.writeFileSync(path.join(dir, 'A-trec2021', 'cases.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
      assert.deepEqual(loadCases(dir, 'trec2021', { split: 'dev' }).map((row) => row.patientId), ['p-a', 'p-c']);
      assert.deepEqual(loadCases(dir, 'trec2021', { split: 'test', limit: 1 }).map((row) => row.patientId), ['p-b']);
      assert.equal(loadCases(dir, 'trec2021', { split: 'all' }).length, 4);
      assert.throws(() => loadCases(dir, 'nowhere'), { code: 'board_unknown' });
      assert.throws(() => loadCases(dir, 'trec2021', { split: 'half' }), { code: 'split_unknown' });
      fs.writeFileSync(path.join(dir, 'A-trec2021', 'cases.jsonl'), JSON.stringify({ ...rows[0], patientId: '../x' }));
      assert.throws(() => loadCases(dir, 'trec2021', { split: 'all' }), { code: 'case_invalid' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a list is cut into runs of at most the size, and the criterion board loses only the annotators\' sentence numbers', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 500), []);
    assert.equal(noteForUpload('c', '0. First sentence.\n1. Second one.'), 'First sentence.\nSecond one.');
    assert.equal(noteForUpload('c', '0. First.\nplain line'), '0. First.\nplain line', 'a note that is not wholly numbered is left alone');
    assert.equal(noteForUpload('sigir', '0. A list item.\n1. Another'), '0. A list item.\n1. Another', 'only the criterion board is unnumbered');
    assert.equal(Object.keys(BOARDS).length, 5);
  });

  test('a trial becomes a protocol in the platform\'s numbering: inclusion first, a clause with no words takes no number', () => {
    const protocol = protocolOf(trial('NCT00000001', [['exclusion', 1, 'ex b'], ['inclusion', 1, 'in b'], ['exclusion', 0, 'ex a'], ['inclusion', 0, 'in a'], ['inclusion', 2, null], ['inclusion', 3, '  ']]));
    assert.deepEqual(protocol.numbered.map((clause) => [clause.kind, clause.number, clause.text]), [['inclusion', 0, 'in a'], ['inclusion', 1, 'in b'], ['exclusion', 0, 'ex a'], ['exclusion', 1, 'ex b']]);
    assert.deepEqual(protocol.criteria.map((clause) => clause.kind), ['inclusion', 'inclusion', 'exclusion', 'exclusion']);
    assert.equal(protocolOf(trial('NCT00000001', [['inclusion', 0, 'x']])).key === protocolOf(trial('NCT00000001', [['inclusion', 0, 'y']])).key, false, 'other words, other protocol');
    assert.equal(protocolOf(trial('NCT00000001', [['inclusion', 0, 'x']])).key, protocolOf(trial('NCT00000001', [['inclusion', 0, 'x']])).key);
  });

  test('a ranking record keeps the reader\'s order as ranks, drops foreign and repeated ids, and counts the failures it did not recover', () => {
    const row = { patientId: 'p1', candidateIds: ['NCT00000001', 'NCT00000002', 'NCT00000003'] };
    const ranking = [{ target: { registryId: 'NCT00000002' }, fit: 80, confidence: 0.9, verdict: 'eligible' }, { target: { id: 'NCT00000001' }, fit: 40, confidence: 0.5, verdict: 'possible' },
      { target: { id: 'NCT99999999' }, fit: 99 }, { target: { id: 'NCT00000002' }, fit: 1 }];
    const record = rankingRecord({ case: row, ranking, failed: [{ registryId: 'NCT00000003', code: 'x_failed' }, { registryId: 'NCT00000002', code: 'late' }], usage: { inputTokens: 5 } });
    assert.deepEqual(record.ranking.map((entry) => [entry.registryId, entry.rank, entry.fit]), [['NCT00000002', 1, 80], ['NCT00000001', 2, 40]]);
    assert.deepEqual(record.failed, [{ registryId: 'NCT00000003', code: 'x_failed' }]);
    assert.equal(record.status, 'partial');
    assert.equal(rankingRecord({ case: row, ranking: [], failed: [] }).status, 'none');
    assert.equal(rankingRecord({ case: row, ranking: [], failed: [{ registryId: 'NCT00000001', code: 'c' }] }).status, 'failed');
    assert.equal(recordStatus({ candidates: 2, judged: 2, failed: 0 }), 'complete');
    assert.equal(Object.keys(record).sort().join(), 'failed,patientId,ranking,status,usage');
  });

  test('a criterion record maps the platform\'s clause numbers back to the annotated kind and number', () => {
    const t = trial('NCT00000007', [['inclusion', 0, 'adult'], ['exclusion', 0, 'pregnant'], ['exclusion', 1, 'asthma']]);
    const protocol = protocolOf(t);
    const row = { patientId: 'p9', trials: [t, trial('NCT00000008', [['inclusion', 0, 'x']])] };
    const judged = { ranking: [{ fit: null, confidence: null, verdict: 'eligible', criteria: [
      { number: 1, clause: 'adult', label: 'included', sentenceIds: [0], basis: 'stated' }, { number: 2, clause: 'pregnant', label: 'not_excluded', sentenceIds: [], basis: 'silent' },
      { number: 3, clause: 'a different text', label: 'excluded', sentenceIds: [1], basis: 'stated' }, { number: 9, clause: 'nowhere', label: 'included' }] }], numbered: protocol.numbered };
    const record = criterionRecord({ case: row, byTrial: new Map([['NCT00000007', judged]]), failed: [{ registryId: 'NCT00000008', code: 'registry_unavailable' }] });
    assert.deepEqual(record.ranking[0].criteria.map((item) => [item.kind, item.number, item.label]), [['inclusion', 0, 'included'], ['exclusion', 0, 'not_excluded'], ['exclusion', 1, 'excluded']]);
    assert.equal(record.clauseTextDiffers, 1, 'a row whose clause words differ is counted, not hidden');
    assert.equal(record.status, 'partial');
    assert.deepEqual(record.failed, [{ registryId: 'NCT00000008', code: 'registry_unavailable' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The loop on a synthetic board: real PostgreSQL, the platform's own module, a local fake provider.
// ---------------------------------------------------------------------------------------------------------------------

const syntheticBoard = (/** @type {string} */ dir) => {
  const trials = path.join(dir, 'trial-json');
  fs.mkdirSync(trials, { recursive: true });
  const ids = Array.from({ length: 8 }, (_, index) => `NCT9000000${index + 1}`);
  for (const id of ids) {
    fs.writeFileSync(path.join(trials, `${id}.json`), JSON.stringify({ nctid: id, title: `Synthetic trial ${id}`, brief_summary: 'A synthetic summary.',
      raw_criteria: 'Inclusion Criteria:\n\n* Adults with asthma\n* Able to use an inhaler\n\nExclusion Criteria:\n\n* Pregnancy\n* Active infection',
      study_type: 'INTERVENTIONAL', phases: ['PHASE2'], condition: ['Asthma'], minimum_age: '18 Years', maximum_age: '', sex: 'ALL', overall_status: 'COMPLETED' }));
  }
  const built = spawnSync(PYTHON, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import prepare; prepare.build_collection(${JSON.stringify(trials)}, ${JSON.stringify(path.join(dir, 'boards', 'collections', 'tg2-sigir'))}, 'sigir')`], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  fs.mkdirSync(path.join(dir, 'boards', 'A-sigir'), { recursive: true });
  const cases = Array.from({ length: 5 }, (_, index) => ({ caseId: `syn-${index + 1}`, patientId: `syn-${index + 1}`, cohort: 'sigir', collection: 'tg2-sigir', split: 'dev',
    note: `A ${40 + index}-year-old person with asthma.\nThey use an inhaler daily.`, candidateIds: ids.slice(0, 6 + (index % 2)), candidateCount: 6 + (index % 2) }));
  fs.writeFileSync(path.join(dir, 'boards', 'A-sigir', 'cases.jsonl'), cases.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { boards: path.join(dir, 'boards'), cases, pairs: cases.reduce((sum, row) => sum + row.candidateCount, 0) };
};

describe('the loop on a synthetic board', { skip: !SERVER_URL && 'OPEN_SCIENCE_TEST_POSTGRES_URL names no local PostgreSQL' }, () => {
  /** @type {string} */ let dir, dbName, dbUrl, keyFile;
  /** @type {ReturnType<typeof syntheticBoard>} */ let board;
  before(() => {
    dir = tmp('loop');
    dbName = `evimed_test_vmdev_t${Math.random().toString(16).slice(2, 10)}`;
    dbUrl = scratchUrl({ serverUrl: SERVER_URL, name: dbName });
    keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    board = syntheticBoard(dir);
  });
  after(async () => {
    await dropDatabase(dbUrl).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const argv = (/** @type {string[]} */ extra, /** @type {string} */ url, arm = 'arm1', { peak = true } = {}) => ['--board', 'sigir', '--arm', arm, '--data-dir', path.join(dir, 'data'), '--boards', board.boards, '--key-file', keyFile,
    '--base-url', url, '--db-url', SERVER_URL ?? '', '--db-name', dbName, ...(peak ? ['--allow-peak'] : []), '--score', 'no', '--progress-seconds', '0.05', ...extra];
  const quiet = () => { const lines = []; return { lines, log: (/** @type {string} */ line) => lines.push(line) }; };
  const run = async (/** @type {string[]} */ extra, /** @type {string} */ url, deps = {}, arm = 'arm1', flags = {}) => {
    const out = quiet();
    const result = await runDevJob(parseOptions(argv(extra, url, arm, flags), {}), { log: out.log, signals: false, ...deps });
    return { ...result, lines: out.lines };
  };

  test('a plan sends nothing; a run judges every pair once, writes the shape to_official.py reads, and the official converter accepts it', async () => {
    const provider = await startFakeProvider({ expectThinking: 'high', expectKey: 'not-a-real-key' });
    try {
      const planned = await run(['--plan-only', '--limit-patients', '2'], provider.url, {}, 'planned');
      assert.equal(planned.exitCode, EXIT.finished);
      assert.equal(provider.requests.length, 0);
      assert.equal(planned.summary.planOnly, true);
      assert.ok(planned.summary.estimateCny > 0 && planned.summary.estimateUpperBoundCny >= planned.summary.estimateCny);

      const first = await run(['--concurrency', '3'], provider.url);
      assert.equal(first.exitCode, EXIT.finished, first.lines.join('\n'));
      assert.equal(provider.requests.length, board.pairs, 'one trial-level call per pair');
      assert.deepEqual(provider.violations, []);
      assert.ok(provider.requests.every((request) => request.model === 'deepseek-flash' && request.thinking === 'high' && request.reasoningEffort === 'high' && request.jsonMode && !request.criteria));
      assert.equal(first.summary.patientStatus.complete, 5);
      assert.equal(first.summary.calls, board.pairs);
      assert.ok(first.summary.costCnyThisRun > 0);
      assert.equal(first.lines.some((line) => /judged \d+ failed 0 \| tokens in .* \| cost CNY/u.test(line)), true, 'a progress line names finished, failed, tokens and cost');

      const file = path.join(first.outDir, 'judgments.jsonl');
      const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.patientId), board.cases.map((row) => row.patientId));
      for (const [index, record] of records.entries()) {
        assert.deepEqual(Object.keys(record).sort(), ['failed', 'patientId', 'ranking', 'status', 'usage']);
        assert.equal(record.status, 'complete');
        assert.equal(record.ranking.length, board.cases[index].candidateCount);
        assert.deepEqual(record.ranking.map((entry) => entry.rank), record.ranking.map((_, at) => at + 1));
        assert.deepEqual(new Set(record.ranking.map((entry) => entry.registryId)), new Set(board.cases[index].candidateIds));
        assert.ok(record.ranking.every((entry, at, all) => at === 0 || all[at - 1].fit >= entry.fit), 'ranked by the score, best first');
        assert.ok(record.ranking.every((entry) => Number.isInteger(entry.fit) && typeof entry.confidence === 'number' && typeof entry.verdict === 'string'));
        assert.ok(record.usage.inputTokens > 0 && record.usage.costCny > 0);
      }
      const converted = path.join(dir, 'official');
      const run2 = spawnSync(PYTHON, ['-I', '-B', path.join(HERE, 'to_official.py'), '--cases', path.join(board.boards, 'A-sigir', 'cases.jsonl'), '--judgments', file, '--out', converted], { encoding: 'utf8' });
      assert.equal(run2.status, 0, run2.stderr);
      const counts = JSON.parse(run2.stdout);
      assert.deepEqual([counts.patients, counts.patientsFinished, counts.pairsJudged, counts.pairsUnjudged], [5, 5, board.pairs, 0]);
      const payload = JSON.parse(fs.readFileSync(path.join(converted, 'full_email_syn-1.json'), 'utf8'));
      assert.deepEqual(payload.cover_page_list.map((entry) => entry.trial_id), records[0].ranking.map((entry) => entry.registryId));
      assert.ok(fs.readFileSync(path.join(dir, 'data', 'spend-ledger.jsonl'), 'utf8').trim().split('\n').length >= 5, 'one ledger line per job');
    } finally { await provider.close(); }
  });

  test('the same arm run again judges nothing and pays nothing; settings that differ are refused under the same name', async () => {
    const provider = await startFakeProvider();
    try {
      const before = fs.readFileSync(path.join(dir, 'data', 'spend-ledger.jsonl'), 'utf8').trim().split('\n').length;
      const again = await run(['--concurrency', '3'], provider.url);
      assert.equal(again.exitCode, EXIT.finished);
      assert.equal(provider.requests.length, 0, 'every pair is already in the ledger');
      assert.equal(again.summary.jobs, 0);
      assert.equal(again.summary.patientStatus.complete, 5);
      assert.equal(fs.readFileSync(path.join(dir, 'data', 'spend-ledger.jsonl'), 'utf8').trim().split('\n').length, before, 'no job, no spend line');
      await assert.rejects(() => run(['--thinking', 'off'], provider.url), { code: 'arm_settings_differ' });
      await assert.rejects(() => run(['--mode', 'both'], provider.url), { code: 'arm_settings_differ' });
    } finally { await provider.close(); }
  });

  test('arms never mix: another arm pays for every pair again, with its own thinking setting, and leaves the first arm\'s rows alone', async () => {
    const provider = await startFakeProvider({ expectThinking: 'off' });
    try {
      const firstFile = path.join(dir, 'data', 'dev-job', 'arm1', 'sigir', 'judgments.jsonl');
      const firstBefore = fs.readFileSync(firstFile, 'utf8');
      const other = await run(['--thinking', 'off', '--concurrency', '3'], provider.url, {}, 'arm-off');
      assert.equal(other.exitCode, EXIT.finished, other.lines.join('\n'));
      assert.equal(provider.requests.length, board.pairs, 'every pair is paid for again');
      assert.ok(provider.requests.every((request) => request.thinking === 'off' && request.reasoningEffort === null));
      assert.deepEqual(provider.violations, []);
      assert.notEqual(path.resolve(other.outDir), path.resolve(path.dirname(firstFile)));
      const armOf = (/** @type {string} */ name) => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'dev-job', name, 'sigir', 'arm.json'), 'utf8'));
      assert.notEqual(armOf('arm1').studyId, armOf('arm-off').studyId, 'each arm has its own study');
      assert.equal(fs.readFileSync(firstFile, 'utf8'), firstBefore, 'the first arm\'s export is untouched');
      const again = await run(['--concurrency', '3'], provider.url, {}, 'arm1');
      assert.equal(again.summary.patientStatus.complete, 5, 'and its rows are still whole when read back');
      assert.equal(fs.readFileSync(firstFile, 'utf8'), firstBefore, 'read back as written');
      assert.equal(provider.requests.length, board.pairs, 'reading the first arm again paid for nothing');
    } finally { await provider.close(); }
  });

  test('a run is refused before any paid call in the peak window, past the cap and under the balance floor', async () => {
    const provider = await startFakeProvider();
    try {
      const waited = await run([], provider.url, { now: () => WEDNESDAY_PEAK }, 'refused-peak', { peak: false });
      assert.equal(waited.exitCode, EXIT.refused);
      assert.equal(waited.summary.refused.code, 'peak_window');
      const allowed = await run(['--plan-only'], provider.url, { now: () => WEDNESDAY_PEAK }, 'refused-peak', { peak: false });
      assert.equal(allowed.exitCode, EXIT.finished, 'a plan is not a paid call, so the window does not refuse it');
      const capped = await run(['--cap-cny', '0.000001'], provider.url, {}, 'refused-cap');
      assert.equal(capped.exitCode, EXIT.refused);
      assert.equal(capped.summary.refused.code, 'cap');
      const poor = await run([], provider.url, { balance: async () => ({ code: 2, balance: 150, line: '' }) }, 'refused-floor');
      assert.equal(poor.exitCode, EXIT.refused);
      assert.equal(poor.summary.refused.code, 'balance_floor');
      const unreadable = await run([], provider.url, { balance: async () => ({ code: 3, balance: null, line: 'unavailable' }) }, 'refused-floor');
      assert.equal(unreadable.summary.refused.code, 'balance_unreadable');
      assert.equal(provider.requests.length, 0, 'the refusals sent nothing');
    } finally { await provider.close(); }
  });

  test('a balance that falls under the floor mid-run stops it cleanly with partial results, and the next run does only the rest', async () => {
    const provider = await startFakeProvider({ latencyMs: 40 });
    try {
      let reads = 0;
      const balance = async () => ({ code: ++reads === 1 ? 0 : 2, balance: reads === 1 ? 500 : 120, line: '' });
      const stopped = await run(['--concurrency', '2', '--check-minutes', '0.001'], provider.url, { balance }, 'stop-mid');
      assert.equal(stopped.exitCode, EXIT.stopped, stopped.lines.join('\n'));
      assert.equal(stopped.summary.stopped.code, 'balance_floor');
      const first = provider.requests.length;
      assert.ok(first > 0 && first < board.pairs, `partial: ${first} of ${board.pairs}`);
      const records = fs.readFileSync(path.join(stopped.outDir, 'judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.status === 'partial' || record.status === 'none'), 'what was not judged is said so');
      assert.ok(records.every((record) => record.ranking.length === new Set(record.ranking.map((e) => e.registryId)).size));
      const finished = await run(['--concurrency', '4'], provider.url, { balance: async () => ({ code: 0, balance: 400, line: '' }) }, 'stop-mid');
      assert.equal(finished.exitCode, EXIT.finished, finished.lines.join('\n'));
      assert.equal(provider.requests.length, board.pairs, 'no pair was paid for twice across the stop and the resume');
      assert.equal(finished.summary.patientStatus.complete, 5);
    } finally { await provider.close(); }
  });

  test('a pair the provider refuses is one failed row with its code, the others finish, and a rerun retries only it', async () => {
    const refusing = { on: true };
    const provider = await startFakeProvider({ failWhen: (_index, body) => (refusing.on && String(body.messages?.at(-1)?.content ?? '').includes('NCT90000003') ? 400 : null) });
    try {
      const failed = await run(['--concurrency', '3', '--limit-patients', '2'], provider.url, {}, 'failing');
      assert.equal(failed.exitCode, EXIT.failedPairs, failed.lines.join('\n'));
      const records = fs.readFileSync(path.join(failed.outDir, 'judgments.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(records.every((record) => record.status === 'partial' && record.failed.length === 1 && record.failed[0].registryId === 'NCT90000003'));
      assert.ok(Object.keys(failed.summary.pairsFailedByCode).length === 1);
      const paid = provider.requests.length;
      refusing.on = false;
      const retried = await run(['--concurrency', '3', '--limit-patients', '2'], provider.url, {}, 'failing');
      assert.equal(retried.exitCode, EXIT.finished, retried.lines.join('\n'));
      assert.equal(provider.requests.length - paid, 2, 'one call for each patient\'s failed pair');
    } finally { await provider.close(); }
  });

  test('the CLI entry point returns the exit code and a usage error says what is wrong', async () => {
    assert.equal(await main(['--arm', 'x'], {}), EXIT.error);
    const provider = await startFakeProvider();
    try {
      assert.equal(await main(argv(['--plan-only', '--limit-patients', '1'], provider.url, 'cli-plan'), {}), EXIT.finished);
      assert.equal(provider.requests.length, 0);
    } finally { await provider.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real cases and the official scorer, only when the environment names them. Five SIGIR patients, the fake provider.
// ---------------------------------------------------------------------------------------------------------------------

const REAL = ['VCR_BOARDS_INPUTS', 'VCR_BOARDS_TG2', 'VCR_BOARDS_TG1', 'VCR_BOARDS_PYTHON'].every((name) => process.env[name]);
describe('five real SIGIR patients through to the official scorer', { skip: (!SERVER_URL && 'OPEN_SCIENCE_TEST_POSTGRES_URL names no local PostgreSQL') || (!REAL && 'the boards and the pins are not named in the environment') }, () => {
  /** @type {string} */ let dir, dbName, dbUrl, keyFile;
  before(() => {
    dir = tmp('real');
    dbName = `evimed_test_vmdev_r${Math.random().toString(16).slice(2, 10)}`;
    dbUrl = scratchUrl({ serverUrl: SERVER_URL, name: dbName });
    keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
  });
  after(async () => { await dropDatabase(dbUrl).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });

  test('judged on the real notes and the real sealed collection, written, scored, with the completion counts the scorer reports', async () => {
    const provider = await startFakeProvider({ expectThinking: 'high' });
    try {
      const lines = [];
      const options = parseOptions(['--board', 'sigir', '--arm', 'real5', '--limit-patients', '5', '--concurrency', '8', '--data-dir', path.join(dir, 'data'), '--key-file', keyFile,
        '--base-url', provider.url, '--db-url', SERVER_URL ?? '', '--db-name', dbName, '--allow-peak', '--score', 'yes', '--progress-seconds', '1'], process.env);
      const result = await runDevJob(options, { log: (line) => lines.push(line), signals: false });
      assert.equal(result.exitCode, EXIT.finished, lines.join('\n'));
      const cases = loadCases(options.boardsDir, 'sigir', { split: 'dev', limit: 5 });
      assert.equal(provider.requests.length, cases.reduce((sum, row) => sum + row.candidateIds.length, 0));
      assert.deepEqual(provider.violations, []);
      assert.equal(result.summary.patientStatus.complete, 5);
      const scored = JSON.parse(fs.readFileSync(path.join(result.outDir, 'score', 'board-a.json'), 'utf8'));
      assert.ok(fs.existsSync(path.join(result.outDir, 'score', 'board-a.md')));
      assert.equal(result.summary.score.exitCode, 0);
      assert.match(JSON.stringify(scored), /finished/u, 'the scorer reports the finished-patients variant');
      assert.equal(JSON.stringify(scored).includes('boardsInputsDigest'), true, 'and says which prepared inputs it read');
    } finally { await provider.close(); }
  });

  test('the held-out half is not scored automatically, and the scorer is left out of it', async () => {
    const provider = await startFakeProvider();
    try {
      const lines = [];
      const options = parseOptions(['--board', 'trec2021', '--arm', 'heldout', '--split', 'test', '--limit-patients', '1', '--concurrency', '32', '--data-dir', path.join(dir, 'data'), '--key-file', keyFile,
        '--base-url', provider.url, '--db-url', SERVER_URL ?? '', '--db-name', dbName, '--allow-peak', '--progress-seconds', '1'], process.env);
      assert.equal(options.score, 'auto');
      const result = await runDevJob(options, { log: (line) => lines.push(line), signals: false });
      assert.equal(result.exitCode, EXIT.finished, lines.join('\n'));
      assert.equal(lines.some((line) => /held-out \(test\) patients: not scored automatically/u.test(line)), true);
      assert.equal(fs.existsSync(path.join(result.outDir, 'score')), false);
      assert.equal(result.summary.score, undefined);
    } finally { await provider.close(); }
  });
});
