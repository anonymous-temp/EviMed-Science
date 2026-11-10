/**
 * Tests for the append-only ledger and its summary translation.
 * All strings and run ids here are invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  appendLedgerRows,
  estimateCostCny,
  ledgerIdForRow,
  rowsFromSummary,
  validateLedgerRow,
  wilson,
} from '../run/ledger.mjs';
import { renderScoreboard } from '../run/scoreboard.mjs';

const LEDGER_CLI = fileURLToPath(new URL('../run/ledger.mjs', import.meta.url));
const SCOREBOARD_CLI = fileURLToPath(new URL('../run/scoreboard.mjs', import.meta.url));

/** @returns {Record<string, any>} */
function ledgerRow(overrides = {}) {
  return {
    runId: 'run-invented-01',
    commit: 'abcdef1234567890',
    engine: { version: '9.9.9', templatesDigest: 'd'.repeat(64) },
    arm: 'capsule',
    flags: { historySearch: true, extraction: 'flash' },
    set: 'synthetic-users',
    split: 'dev',
    metric: 'accuracy',
    n: 100,
    value: 0.87,
    ci95: [0.79, 0.93],
    judged: { code: 80, judge: 5, unknown: 0, error: 15 },
    tokens: { prompt: 1234, completion: 567, cached: 100, extractionPrompt: 400, extractionCompletion: 50 },
    costCny: 1.25,
    wallSeconds: 42.5,
    scorer: 'score@invented',
    rawPath: '/runs/run-invented-01',
    ...overrides,
  };
}

/** @returns {Record<string, any>} */
function inventedRun(overrides = {}) {
  return {
    runId: 'run-invented-02',
    commit: '1234567890abcdef',
    engine: { version: '9.9.9', templatesDigest: 'e'.repeat(64) },
    arm: 'keyword',
    flags: { historySearch: false },
    set: 'synthetic-users',
    split: 'dev',
    startedAt: '2026-11-10T01:00:00.000Z',
    finishedAt: '2026-11-10T01:02:00.000Z',
    rawPath: '/runs/run-invented-02',
    ...overrides,
  };
}

/** A summary shaped exactly like `score.mjs`'s `summarize` + `scoreRun`. */
function realSummary() {
  return {
    schema: 'invented-scorer-version',
    sets: {
      'synthetic-users': {
        n: 4,
        pass: 3,
        fail: 1,
        'needs-judge': 0,
        pendingJudge: 0,
        unknown: 0,
        error: 0,
        'invalid-item': 0,
        nValid: 4,
        accuracy: 0.75,
        ci95: [0.3, 0.95],
        accuracyValid: 0.75,
        ci95Valid: [0.3, 0.95],
        judged: { code: 4, judge: 0, unknown: 0, error: 0 },
        byCategory: { stable: { n: 2, pass: 2 }, detail: { n: 2, pass: 1 } },
        byGenerator: { kimi: { n: 3, pass: 2 }, codex: { n: 1, pass: 1 } },
        byStep: { not_stored: 1, not_searched: 0, not_retrieved: 0, retrieved_but_wrong: 0 },
        store: { n: 2, pass: 1 },
        redlines: { secret_leak: 0, cross_patient: 1 },
      },
    },
    disputed: [
      { set: 'synthetic-users', split: 'dev', caseId: 'U01', id: 'U01-q001', reason: 'judge disagreement' },
    ],
    storeRecall: { n: 2, pass: 1, value: 0.5, ci95: [0.1, 0.9], unknown: 0 },
    redLines: {
      n: 3,
      count: 1,
      unknown: 0,
      byType: {
        secret_leak: { n: 1, pass: 1, fail: 0, judged: { code: 1, judge: 0, unknown: 0, error: 0 } },
        cross_patient: { n: 2, pass: 1, fail: 1, judged: { code: 2, judge: 0, unknown: 0, error: 0 } },
      },
    },
    tokens: {
      extraction: { prompt: 400, completion: 50 },
      answer: { prompt: 500, completion: 50, cached: 100 },
      prompt: 900,
      completion: 100,
    },
    wallSeconds: 99,
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('wilson returns the standard interval and null for an empty denominator', () => {
  assert.equal(wilson(0, 0), null);
  const [lo, hi] = wilson(50, 100);
  assert.ok(Math.abs(lo - 0.4038) < 0.001, `lo ${lo}`);
  assert.ok(Math.abs(hi - 0.5962) < 0.001, `hi ${hi}`);
  const [zeroLo, zeroHi] = wilson(0, 10);
  assert.equal(zeroLo, 0);
  assert.ok(zeroHi > 0 && zeroHi < 1);
  assert.throws(() => wilson(11, 10), RangeError);
});

test('validateLedgerRow accepts a complete row and names each broken field', () => {
  assert.deepEqual(validateLedgerRow(ledgerRow()), []);
  assert.deepEqual(validateLedgerRow(ledgerRow({ ledgerId: '0123456789ab', at: '2026-11-10T00:00:00.000Z' })), []);

  assert.ok(validateLedgerRow(ledgerRow({ rawPath: '' })).some((p) => p.includes('rawPath')));
  assert.ok(validateLedgerRow(ledgerRow({ n: -1 })).some((p) => p.includes('n must be')));
  assert.ok(validateLedgerRow(ledgerRow({ n: 1.5 })).some((p) => p.includes('n must be')));
  assert.ok(validateLedgerRow(ledgerRow({ value: Infinity })).some((p) => p.includes('value')));
  assert.ok(validateLedgerRow(ledgerRow({ ci95: [0.1] })).some((p) => p.includes('ci95')));
  assert.ok(validateLedgerRow(ledgerRow({ judged: { code: 1, judge: 0, unknown: 0 } })).some((p) => p.includes('judged.error')));
  assert.ok(validateLedgerRow(ledgerRow({ tokens: { prompt: 1, completion: -1 } })).some((p) => p.includes('tokens.completion')));
  assert.ok(validateLedgerRow(ledgerRow({ flags: [] })).some((p) => p.includes('flags')));
  assert.ok(validateLedgerRow(ledgerRow({ ledgerId: 'not-a-ledger' })).some((p) => p.includes('ledgerId')));
  assert.ok(validateLedgerRow(ledgerRow({ at: 'not a date' })).some((p) => p.includes('at must be')));
});

test('validateLedgerRow accepts a null cost and validates the scorer-derived fields', () => {
  assert.deepEqual(validateLedgerRow(ledgerRow({ costCny: null })), []);
  assert.deepEqual(
    validateLedgerRow(ledgerRow({
      valueValid: 0.9,
      ci95Valid: [0.7, 1],
      nValid: 90,
      invalid: 10,
      disputed: 2,
      byStep: { not_stored: 1, not_searched: 2, not_retrieved: 0, retrieved_but_wrong: 0 },
      label: 'invented label',
    })),
    [],
  );

  assert.ok(validateLedgerRow(ledgerRow({ costCny: -1 })).some((p) => p.includes('costCny')));
  assert.ok(validateLedgerRow(ledgerRow({ costCny: undefined })).some((p) => p.includes('costCny')));
  assert.ok(validateLedgerRow(ledgerRow({ tokens: { prompt: 1, completion: 1, cached: 0, extractionPrompt: 0 } })).some((p) => p.includes('tokens.extractionCompletion')));
  assert.ok(validateLedgerRow(ledgerRow({ valueValid: 'high' })).some((p) => p.includes('valueValid')));
  assert.ok(validateLedgerRow(ledgerRow({ ci95Valid: [0.1] })).some((p) => p.includes('ci95Valid')));
  assert.ok(validateLedgerRow(ledgerRow({ nValid: -1 })).some((p) => p.includes('nValid')));
  assert.ok(validateLedgerRow(ledgerRow({ invalid: 1.5 })).some((p) => p.includes('invalid')));
  assert.ok(validateLedgerRow(ledgerRow({ disputed: -1 })).some((p) => p.includes('disputed')));
  assert.ok(validateLedgerRow(ledgerRow({ byStep: { not_stored: -1 } })).some((p) => p.includes('byStep.not_stored')));
  assert.ok(validateLedgerRow(ledgerRow({ label: '' })).some((p) => p.includes('label')));
});

test('validateLedgerRow rejects API-key-shaped strings anywhere in the row', () => {
  const nested = ledgerRow({ flags: { note: 'prefix sk-' + 'a'.repeat(20) + ' suffix' } });
  assert.ok(validateLedgerRow(nested).some((p) => p.includes('API key')));
  const inBreakdown = ledgerRow({ byGenerator: { kimi: { n: 1, value: 1, extra: 'sk-' + 'b'.repeat(16) } } });
  assert.ok(validateLedgerRow(inBreakdown).some((p) => p.includes('API key')));
});

test('the row id is deterministic and ignores field order, ledgerId and at', () => {
  const first = ledgerRow();
  const second = {
    rawPath: first.rawPath,
    scorer: first.scorer,
    wallSeconds: first.wallSeconds,
    costCny: first.costCny,
    tokens: first.tokens,
    judged: first.judged,
    ci95: first.ci95,
    value: first.value,
    n: first.n,
    metric: first.metric,
    split: first.split,
    set: first.set,
    flags: first.flags,
    arm: first.arm,
    engine: first.engine,
    commit: first.commit,
    runId: first.runId,
  };
  const id = ledgerIdForRow(first);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(ledgerIdForRow(second), id);
  assert.equal(ledgerIdForRow({ ...first, at: '2026-01-01T00:00:00.000Z', ledgerId: 'ffffffffffff' }), id);
});

test('appendLedgerRows assigns ids, appends once per line and is idempotent', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'results', 'ledger.jsonl');
  const first = ledgerRow();
  const second = ledgerRow({ metric: 'store_recall', n: 20, value: 0.5 });
  const before = JSON.stringify(first);

  const one = appendLedgerRows(file, [first, first]);
  assert.deepEqual(one, { appended: 1, skipped: 1 });
  assert.equal(JSON.stringify(first), before, 'the input row is not mutated');

  const two = appendLedgerRows(file, [first, second]);
  assert.deepEqual(two, { appended: 1, skipped: 1 });

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.match(row.ledgerId, /^[0-9a-f]{12}$/);
    assert.equal(typeof row.at, 'string');
    assert.deepEqual(validateLedgerRow(row), []);
  }
  assert.equal(JSON.parse(lines[0]).ledgerId, ledgerIdForRow(first));
});

test('appendLedgerRows writes nothing when a later row is invalid', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.jsonl');
  assert.throws(() => appendLedgerRows(file, [ledgerRow(), ledgerRow({ n: -3 })]), /row 1 is invalid/);
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
});

test('rowsFromSummary reads the scorer real set fields, tokens, disputed and wall time', () => {
  const run = inventedRun();
  const summary = realSummary();

  const rows = rowsFromSummary({ run, summary, scorer: 'score@2', costCny: 0.4 });
  assert.deepEqual(rows.map((row) => row.metric), ['accuracy', 'store_recall', 'redline_count', 'redline_count']);
  assert.equal(rows.length, 4);

  const [accuracy, store, secretLeak, crossPatient] = rows;
  assert.equal(accuracy.set, 'synthetic-users');
  assert.equal(accuracy.n, 4);
  assert.equal(accuracy.value, 0.75);
  assert.deepEqual(accuracy.ci95, [0.3, 0.95]);
  assert.equal(accuracy.valueValid, 0.75);
  assert.deepEqual(accuracy.ci95Valid, [0.3, 0.95]);
  assert.equal(accuracy.nValid, 4);
  assert.equal(accuracy.invalid, 0);
  assert.equal(accuracy.disputed, 1);
  assert.equal(accuracy.runId, 'run-invented-02');
  assert.equal(accuracy.rawPath, '/runs/run-invented-02');
  assert.equal(accuracy.scorer, 'score@2');
  assert.equal(accuracy.costCny, 0.4);
  assert.equal(accuracy.wallSeconds, 99, 'summary.wallSeconds wins over run timestamps');
  assert.deepEqual(accuracy.tokens, {
    prompt: 900,
    completion: 100,
    cached: 100,
    extractionPrompt: 400,
    extractionCompletion: 50,
  });
  assert.deepEqual(accuracy.judged, { code: 4, judge: 0, unknown: 0, error: 0 });
  assert.deepEqual(accuracy.byCategory.stable, { n: 2, value: 1 });
  assert.deepEqual(accuracy.byGenerator.codex, { n: 1, value: 1 });
  assert.deepEqual(accuracy.byStep, { not_stored: 1, not_searched: 0, not_retrieved: 0, retrieved_but_wrong: 0 });

  assert.equal(store.metric, 'store_recall');
  assert.equal(store.n, 2);
  assert.equal(store.value, 0.5);
  assert.ok(Array.isArray(store.ci95));
  assert.deepEqual(store.tokens, accuracy.tokens);

  assert.equal(secretLeak.metric, 'redline_count');
  assert.equal(secretLeak.n, 1);
  assert.equal(secretLeak.value, 0);
  assert.match(secretLeak.notes, /redline=secret_leak/);
  assert.equal(secretLeak.wallSeconds, 99);
  assert.deepEqual(secretLeak.tokens, accuracy.tokens);

  assert.equal(crossPatient.metric, 'redline_count');
  assert.equal(crossPatient.n, 2);
  assert.equal(crossPatient.value, 1);
  assert.match(crossPatient.notes, /redline=cross_patient/);
  assert.equal(crossPatient.ci95, null);
  assert.deepEqual(crossPatient.judged, { code: 2, judge: 0, unknown: 0, error: 0 });

  for (const row of rows) assert.deepEqual(validateLedgerRow(row), []);
});

test('rowsFromSummary keeps per-set red-line denominators when a summary mixes sets', () => {
  const summary = {
    sets: {
      alpha: {
        n: 10,
        pass: 8,
        fail: 2,
        unknown: 0,
        error: 0,
        'invalid-item': 0,
        nValid: 10,
        accuracy: 0.8,
        ci95: null,
        judged: { code: 10, judge: 0, unknown: 0, error: 0 },
        store: { n: 0, pass: 0 },
        redlines: { secret_leak: 1 },
      },
      beta: {
        n: 5,
        pass: 5,
        fail: 0,
        unknown: 0,
        error: 0,
        'invalid-item': 0,
        nValid: 5,
        accuracy: 1,
        ci95: null,
        judged: { code: 5, judge: 0, unknown: 0, error: 0 },
        store: { n: 0, pass: 0 },
        redlines: { secret_leak: 0 },
      },
    },
    redLines: { n: 12, count: 1, byType: { secret_leak: { n: 12, pass: 11, fail: 1, judged: { code: 12, judge: 0, unknown: 0, error: 0 } } } },
    tokens: { prompt: 10, completion: 2 },
    wallSeconds: 1,
  };
  const rows = rowsFromSummary({ run: inventedRun(), summary });
  assert.deepEqual(rows.map((row) => `${row.set}:${row.metric}`), [
    'alpha:accuracy',
    'alpha:redline_count',
    'beta:accuracy',
    'beta:redline_count',
  ]);
  assert.equal(rows[1].n, 10, 'the global byType n is not used as a per-set denominator');
  assert.equal(rows[1].value, 1);
  assert.equal(rows[3].n, 5);
  assert.equal(rows[3].value, 0);
  for (const row of rows) assert.deepEqual(validateLedgerRow(row), []);
});

test('rowsFromSummary reports the valid-item denominator and its disputed count', () => {
  const summary = realSummary();
  summary.sets['synthetic-users'] = {
    ...summary.sets['synthetic-users'],
    n: 10,
    pass: 6,
    fail: 2,
    'invalid-item': 2,
    nValid: 8,
    accuracy: 0.6,
    accuracyValid: 0.75,
    ci95: [0.3, 0.83],
    ci95Valid: [0.41, 0.93],
    disputed: undefined,
  };
  summary.disputed.push({ set: 'synthetic-users', split: 'dev', caseId: 'U02', id: 'U02-q001' });

  const [accuracy] = rowsFromSummary({ run: inventedRun(), summary });
  assert.equal(accuracy.value, 0.6);
  assert.equal(accuracy.valueValid, 0.75);
  assert.equal(accuracy.nValid, 8);
  assert.equal(accuracy.invalid, 2);
  assert.equal(accuracy.disputed, 2);
  assert.deepEqual(accuracy.ci95Valid, [0.41, 0.93]);
  assert.deepEqual(validateLedgerRow(accuracy), []);
});

test('estimateCostCny prices input, cached input and output, and returns null without prices', () => {
  assert.equal(estimateCostCny({ tokens: ledgerRow().tokens, prices: null }), null);
  assert.equal(estimateCostCny({ tokens: ledgerRow().tokens }), null);
  assert.equal(estimateCostCny({ tokens: ledgerRow().tokens, prices: {} }), null);

  const tokens = {
    prompt: 1_000_000,
    completion: 500_000,
    cached: 200_000,
    extractionPrompt: 400_000,
    extractionCompletion: 50_000,
  };
  const prices = { inputPerMTok: 1, cachedInputPerMTok: 0.5, outputPerMTok: 2 };
  // 400k regular input + 40k uncached extraction = 440k input; 200k answer
  // cached + 360k cached extraction = 560k cached; 500k output.
  const cost = estimateCostCny({ tokens, prices });
  assert.ok(Math.abs(cost - (0.44 + 0.28 + 1)) < 1e-9, `cost ${cost}`);

  const uncached = estimateCostCny({ tokens, prices, extractionCachedShare: 0 });
  // 400k regular input + 400k uncached extraction = 800k input; 200k answer
  // cached; 500k output.
  assert.ok(Math.abs(uncached - (0.8 + 0.1 + 1)) < 1e-9, `uncached ${uncached}`);

  // No built-in table: a single supplied price prices only its token class.
  assert.equal(estimateCostCny({ tokens, prices: { outputPerMTok: 2 } }), 1);
});

test('rowsFromSummary leaves cost null without prices and applies the extraction-cache note with prices', () => {
  const withoutPrices = rowsFromSummary({ run: inventedRun(), summary: realSummary() });
  for (const row of withoutPrices) assert.equal(row.costCny, null, `${row.metric} cost`);

  const withPrices = rowsFromSummary({
    run: inventedRun(),
    summary: realSummary(),
    prices: { inputPerMTok: 1, cachedInputPerMTok: 0.5, outputPerMTok: 2 },
    extractionCachedShare: 0.75,
  });
  for (const row of withPrices) {
    assert.ok(typeof row.costCny === 'number' && row.costCny >= 0);
    assert.match(row.notes, /cost assumption: extraction prompt tokens are costed as 75% cached input/);
    assert.deepEqual(validateLedgerRow(row), []);
  }
});

test('rowsFromSummary returns no rows for an empty summary', () => {
  assert.deepEqual(rowsFromSummary({ run: { runId: 'r' }, summary: { sets: {} } }), []);
  assert.deepEqual(rowsFromSummary({ run: { runId: 'r' }, summary: {} }), []);
});

test('rowsFromSummary accepts the scorer bySet/storeRecall shape as a fallback', () => {
  const run = {
    runId: 'run-invented-07',
    set: 'synthetic-users',
    split: 'dev',
    commit: '1111111222222222',
    engine: { version: '9.9.9', templatesDigest: 'a'.repeat(64) },
    arm: 'capsule',
    flags: {},
  };
  const summary = {
    bySet: {
      'synthetic-users': {
        n: 2,
        pass: 2,
        fail: 0,
        'needs-judge': 0,
        unknown: 0,
        error: 0,
        accuracy: 1,
        ci95: [0.7, 1],
        judged: { code: 2, judge: 0, unknown: 0, error: 0 },
      },
    },
    storeRecall: { n: 1, pass: 1 },
    redLines: { n: 3, count: 1 },
  };
  const rows = rowsFromSummary({ run, summary, scorer: 'score@3' });
  assert.deepEqual(rows.map((row) => row.metric), ['accuracy', 'store_recall', 'redline_count']);
  assert.equal(rows[0].set, 'synthetic-users');
  assert.equal(rows[1].value, 1);
  assert.equal(rows[2].value, 1);
  assert.equal(rows[2].n, 3);
  assert.equal(rows[0].costCny, null);
  assert.deepEqual(rows[0].tokens, { prompt: 0, completion: 0, cached: 0, extractionPrompt: 0, extractionCompletion: 0 });
});

test('the ledger CLI reads run.json and scores/summary.json and appends', (t) => {
  const dir = tempDir(t);
  const runDir = join(dir, 'run');
  mkdirSync(join(runDir, 'scores'), { recursive: true });
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId: 'run-invented-03',
      commit: 'fedcba9876543210',
      engine: { version: '9.9.9', templatesDigest: 'f'.repeat(64) },
      arm: 'capsule',
      flags: { historySearch: true },
      set: 'synthetic-users',
      split: 'dev',
      startedAt: '2026-11-10T02:00:00.000Z',
      finishedAt: '2026-11-10T02:00:30.000Z',
    }),
  );
  writeFileSync(
    join(runDir, 'scores', 'summary.json'),
    JSON.stringify({
      sets: {
        'synthetic-users': {
          n: 2,
          pass: 2,
          fail: 0,
          'needs-judge': 0,
          unknown: 0,
          error: 0,
          accuracy: 1,
          ci95: null,
          judged: { code: 2, judge: 0, unknown: 0, error: 0 },
        },
      },
      tokens: { prompt: 10, completion: 5 },
    }),
  );
  const ledger = join(dir, 'ledger.jsonl');
  const result = spawnSync(process.execPath, [LEDGER_CLI, 'append', '--run', runDir, '--ledger', ledger, '--cost-cny', '0.25'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout.trim());
  assert.equal(printed.appended, 1);
  assert.equal(printed.rows, 1);

  const row = JSON.parse(readFileSync(ledger, 'utf8').trim());
  assert.equal(row.runId, 'run-invented-03');
  assert.equal(row.costCny, 0.25);
  assert.equal(row.wallSeconds, 30);
  assert.equal(row.rawPath, runDir);
  assert.equal(row.scorer, 'fedcba9876543210');
  assert.equal(row.value, 1);
  assert.equal(row.ci95, null);
  assert.deepEqual(row.tokens, { prompt: 10, completion: 5, cached: 0, extractionPrompt: 0, extractionCompletion: 0 });
});

test('the ledger CLI append --variant reads scores.<name>/summary.json and joins the arm', (t) => {
  const dir = tempDir(t);
  const runDir = join(dir, 'run');
  mkdirSync(join(runDir, 'scores.sft'), { recursive: true });
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId: 'run-invented-08',
      commit: '2222222233333333',
      engine: { version: '9.9.9', templatesDigest: 'b'.repeat(64) },
      arm: 'capsule',
      flags: { historySearch: true },
      set: 'synthetic-users',
      split: 'test',
      label: 'invented arm label',
      startedAt: '2026-11-10T04:00:00.000Z',
      finishedAt: '2026-11-10T04:00:10.000Z',
    }),
  );
  writeFileSync(
    join(runDir, 'scores.sft', 'summary.json'),
    JSON.stringify({
      sets: {
        'synthetic-users': {
          n: 3,
          pass: 2,
          fail: 1,
          'needs-judge': 0,
          unknown: 0,
          error: 0,
          'invalid-item': 0,
          nValid: 3,
          accuracy: 2 / 3,
          accuracyValid: 2 / 3,
          ci95: null,
          ci95Valid: null,
          judged: { code: 3, judge: 0, unknown: 0, error: 0 },
          byStep: { not_stored: 0, not_searched: 1, not_retrieved: 0, retrieved_but_wrong: 0 },
          store: { n: 0, pass: 0 },
          redlines: {},
        },
      },
      tokens: { extraction: { prompt: 0, completion: 0 }, answer: { prompt: 0, completion: 0, cached: 0 } },
      wallSeconds: 10,
    }),
  );
  const ledger = join(dir, 'ledger.jsonl');
  const result = spawnSync(process.execPath, [LEDGER_CLI, 'append', '--run', runDir, '--variant', 'sft', '--ledger', ledger], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1, 'a set with no store results and no red lines yields one accuracy row');
  assert.equal(rows[0].arm, 'capsule+sft');
  assert.equal(rows[0].label, 'invented arm label');
  assert.equal(rows[0].split, 'test');
  assert.equal(rows[0].rawPath, runDir);
  assert.equal(rows[0].wallSeconds, 10);
  assert.deepEqual(rows[0].byStep, { not_stored: 0, not_searched: 1, not_retrieved: 0, retrieved_but_wrong: 0 });
});

test('the ledger CLI prices a run from flags and records the cache assumption', (t) => {
  const dir = tempDir(t);
  const runDir = join(dir, 'run');
  mkdirSync(join(runDir, 'scores'), { recursive: true });
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId: 'run-invented-09',
      commit: '3333333344444444',
      engine: { version: '9.9.9', templatesDigest: 'c'.repeat(64) },
      arm: 'capsule',
      flags: {},
      set: 'synthetic-users',
      split: 'dev',
      startedAt: '2026-11-10T05:00:00.000Z',
      finishedAt: '2026-11-10T05:00:05.000Z',
    }),
  );
  writeFileSync(
    join(runDir, 'scores', 'summary.json'),
    JSON.stringify({
      sets: {
        'synthetic-users': {
          n: 1,
          pass: 1,
          fail: 0,
          'needs-judge': 0,
          unknown: 0,
          error: 0,
          accuracy: 1,
          ci95: null,
          judged: { code: 1, judge: 0, unknown: 0, error: 0 },
        },
      },
      tokens: {
        extraction: { prompt: 400_000, completion: 50_000 },
        answer: { prompt: 200_000, completion: 100_000, cached: 100_000 },
        prompt: 600_000,
        completion: 150_000,
      },
      wallSeconds: 5,
    }),
  );
  const ledger = join(dir, 'ledger.jsonl');
  const result = spawnSync(process.execPath, [
    LEDGER_CLI,
    'append',
    '--run',
    runDir,
    '--ledger',
    ledger,
    '--price-input',
    '1',
    '--price-cached',
    '0.5',
    '--price-output',
    '2',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(readFileSync(ledger, 'utf8').trim());
  assert.ok(Math.abs(row.costCny - 0.67) < 1e-9, `cost ${row.costCny}`);
  assert.match(row.notes, /extraction prompt tokens are costed as 90% cached input/);
});

test('the ledger CLI add appends a single row or an array and assigns ledger ids', (t) => {
  const dir = tempDir(t);
  const ledger = join(dir, 'ledger.jsonl');
  const first = ledgerRow({ runId: 'run-invented-10' });
  const second = ledgerRow({ runId: 'run-invented-10', metric: 'store_recall', n: 5, value: 0.4 });
  const arrayFile = join(dir, 'rows.json');
  writeFileSync(arrayFile, JSON.stringify([first, second]));

  const one = spawnSync(process.execPath, [LEDGER_CLI, 'add', '--json', arrayFile, '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout.trim()).appended, 2);
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ledgerId, ledgerIdForRow(first));
  assert.equal(lines[1].ledgerId, ledgerIdForRow(second));
  for (const row of lines) assert.deepEqual(validateLedgerRow(row), []);

  const again = spawnSync(process.execPath, [LEDGER_CLI, 'add', '--json', arrayFile, '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(JSON.parse(again.stdout.trim()).skipped, 2);

  const singleFile = join(dir, 'row.json');
  writeFileSync(singleFile, JSON.stringify(ledgerRow({ runId: 'run-invented-11' })));
  const single = spawnSync(process.execPath, [LEDGER_CLI, 'add', '--json', singleFile, '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout.trim()).appended, 1);
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 3);
});

test('the ledger CLI add applies the same validation and writes nothing on an invalid row', (t) => {
  const dir = tempDir(t);
  const ledger = join(dir, 'ledger.jsonl');
  const file = join(dir, 'rows.json');
  writeFileSync(file, JSON.stringify([ledgerRow({ runId: 'run-invented-12' }), ledgerRow({ engine: null })]));
  const result = spawnSync(process.execPath, [LEDGER_CLI, 'add', '--json', file, '--ledger', ledger], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /row 1 is invalid/);
  assert.equal(existsSync(ledger), false);
});


test('renderScoreboard groups by set, sorts rows and renders the contract columns', () => {
  const base = {
    split: 'dev',
    arm: 'capsule',
    flags: { historySearch: true, extraction: 'flash' },
    n: 10,
    metric: 'accuracy',
    judged: { code: 9, judge: 1, unknown: 0, error: 0 },
    tokens: { prompt: 100, completion: 50, cached: 0, extractionPrompt: 0, extractionCompletion: 0 },
    costCny: 1.5,
    commit: 'abcdef0123456789',
    runId: 'run-invented-04',
  };
  const rows = [
    { ...base, set: 'zeta', at: '2026-01-02T00:00:00.000Z', value: 0.9, ci95: [0.6, 0.98] },
    { ...base, set: 'alpha', at: '2026-01-01T00:00:00.000Z', value: 1, ci95: [0.7, 1] },
    { ...base, set: 'zeta', at: '2026-01-01T00:00:00.000Z', value: 0.5, ci95: [0.2, 0.8] },
  ];

  const markdown = renderScoreboard(rows, '2026-11-10T03:00:00.000Z');
  assert.match(markdown, /^# Capsule proving scoreboard/);
  assert.match(markdown, /a number without a ledger row does not count/);
  assert.match(markdown, /Generated at 2026-11-10T03:00:00\.000Z/);
  assert.ok(markdown.indexOf('## alpha') < markdown.indexOf('## zeta'));
  assert.equal((markdown.match(/^## /gm) ?? []).length, 2);
  assert.match(markdown, /90\.0% \[60\.0%, 98\.0%\]/);
  assert.match(markdown, /50\.0% \[20\.0%, 80\.0%\]/);
  assert.match(markdown, /extraction=flash, historySearch=true/);
  assert.match(markdown, /9\/1\/0\/0/);
  assert.match(markdown, /100 \/ 50/);
  assert.match(markdown, /1\.50/);
  assert.match(markdown, /abcdef0/);
  assert.match(markdown, /run-invented-04/);

  const zeta = markdown.slice(markdown.indexOf('## zeta'));
  assert.ok(zeta.indexOf('50.0%') < zeta.indexOf('90.0%'), 'same arm sorts by at');
});

test('renderScoreboard shows the valid-item value, wrong-because steps and disputed count', () => {
  const rows = [{
    set: 'synthetic-users',
    split: 'dev',
    arm: 'capsule',
    at: '2026-01-01T00:00:00.000Z',
    flags: {},
    n: 61,
    metric: 'accuracy',
    value: 0.613,
    valueValid: 0.63,
    ci95: null,
    ci95Valid: null,
    nValid: 59,
    invalid: 2,
    disputed: 3,
    byStep: { not_stored: 3, not_searched: 40, not_retrieved: 0, retrieved_but_wrong: 0 },
    judged: { code: 61, judge: 0, unknown: 0, error: 0 },
    tokens: { prompt: 0, completion: 0, cached: 0, extractionPrompt: 0, extractionCompletion: 0 },
    costCny: null,
    commit: '0123456789abcdef',
    runId: 'run-invented-13',
  }];
  const markdown = renderScoreboard(rows, 'fixed-time');
  assert.match(markdown, /61\.3% \(63\.0% without 2 invalid items\)/);
  assert.match(markdown, /not stored 3 · not searched 40 · not retrieved 0 · misused 0/);
  assert.match(markdown, /\| 3 \| 61\/0\/0\/0 \|/);
  assert.match(markdown, /\| — \| 0123456 \|/);
  assert.doesNotMatch(markdown, /87\.5%/);
});

test('renderScoreboard groups the arms of one set+split together and prints mean scores as numbers', () => {
  const base = {
    set: 'synthetic-users',
    flags: {},
    ci95: null,
    judged: { code: 1, judge: 0, unknown: 0, error: 0 },
    tokens: { prompt: 0, completion: 0, cached: 0, extractionPrompt: 0, extractionCompletion: 0 },
    costCny: 0,
    commit: '0123456789abcdef',
  };
  const rows = [
    { ...base, split: 'dev', arm: 'capsule', at: '2026-01-01T00:00:00.000Z', n: 2, metric: 'accuracy', value: 0.5, runId: 'r1' },
    { ...base, split: 'test', arm: 'capsule', at: '2026-01-01T00:00:00.000Z', n: 2, metric: 'accuracy', value: 0.6, runId: 'r2' },
    { ...base, split: 'dev', arm: 'keyword', at: '2026-01-01T00:00:00.000Z', n: 2, metric: 'accuracy', value: 0.4, runId: 'r3' },
    { ...base, split: 'dev', arm: 'capsule', at: '2026-01-01T00:00:00.000Z', n: 2, metric: 'mean_score', value: 0.875, runId: 'r4' },
    { ...base, split: 'dev', arm: 'capsule', at: '2026-01-01T00:00:00.000Z', n: 2, metric: 'redline_count', value: 2, runId: 'r5' },
  ];

  const markdown = renderScoreboard(rows, 'fixed-time');
  const dev = markdown.slice(markdown.indexOf('### dev'), markdown.indexOf('### test'));
  assert.match(dev, /capsule/);
  assert.match(dev, /keyword/);
  assert.ok(dev.indexOf('| capsule |') < dev.indexOf('| keyword |'), 'arms sit together in one split section');
  assert.ok(markdown.indexOf('### dev') < markdown.indexOf('### test'));

  assert.match(markdown, /\| 0\.875 \|/);
  assert.doesNotMatch(markdown, /87\.5%/);
  assert.match(markdown, /\| 2 \| redline_count \| 2 \|/);

  assert.equal(renderScoreboard(rows, 'fixed-time'), markdown, 'the renderer is a pure function of the rows and time');
});

test('renderScoreboard renders count metrics as counts and handles no rows', () => {
  const markdown = renderScoreboard(
    [
      {
        set: 'synthetic-users',
        split: 'dev',
        arm: 'capsule',
        at: '2026-01-01T00:00:00.000Z',
        flags: {},
        n: 20,
        metric: 'redline_count',
        value: 2,
        ci95: null,
        judged: { code: 16, judge: 0, unknown: 0, error: 0 },
        tokens: { prompt: 0, completion: 0, cached: 0, extractionPrompt: 0, extractionCompletion: 0 },
        costCny: 0,
        commit: '0123456789abcdef',
        runId: 'run-invented-05',
      },
    ],
    'fixed-time',
  );
  assert.match(markdown, /\| 20 \| redline_count \| 2 \|/);

  const empty = renderScoreboard([], 'fixed-time');
  assert.match(empty, /No ledger rows\./);
  assert.doesNotMatch(empty, /^## /m);
});

test('the scoreboard CLI writes the generated Markdown', (t) => {
  const dir = tempDir(t);
  const ledger = join(dir, 'ledger.jsonl');
  const row = {
    ...ledgerRow({ runId: 'run-invented-06' }),
    ledgerId: '0123456789ab',
    at: '2026-11-10T00:00:00.000Z',
  };
  writeFileSync(ledger, `${JSON.stringify(row)}\n`);
  const out = join(dir, 'SCOREBOARD.md');
  const result = spawnSync(process.execPath, [SCOREBOARD_CLI, '--ledger', ledger, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const markdown = readFileSync(out, 'utf8');
  assert.match(markdown, /a number without a ledger row does not count/);
  assert.match(markdown, /run-invented-06/);
});

test('live forget metrics reach the append-only ledger with separate action groups', () => {
  const summary = realSummary();
  summary.forget = { forgetToolCalled: { n: 3, count: 1, unknown: 1 }, forgottenReappeared: {
    toolCalled: { n: 1, count: 1, unknown: 0 }, toolNotCalled: { n: 1, count: 0, unknown: 0 }, unobserved: { n: 1, count: 0, unknown: 1 },
  } };
  const rows = rowsFromSummary({ run: inventedRun(), summary });
  const called = rows.find(row => row.metric === 'forget_tool_called');
  assert.equal(called.n, 3);
  assert.equal(called.value, 1 / 3);
  assert.equal(called.judged.unknown, 1);
  const groups = rows.filter(row => row.metric === 'forgotten_reappeared_count');
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(row => row.n), [1, 1, 1]);
  assert.deepEqual(groups.map(row => row.value), [1, 0, 0]);
  for (const row of [called, ...groups]) assert.deepEqual(validateLedgerRow(row), []);
});
