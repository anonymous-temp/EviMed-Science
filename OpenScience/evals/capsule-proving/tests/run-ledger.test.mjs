/**
 * Tests for the append-only ledger and its summary translation.
 * All strings and run ids here are invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  appendLedgerRows,
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
    tokens: { prompt: 1234, completion: 567 },
    costCny: 1.25,
    wallSeconds: 42.5,
    scorer: 'score@invented',
    rawPath: '/runs/run-invented-01',
    ...overrides,
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

test('rowsFromSummary emits accuracy and store rows with category and generator breakdowns', () => {
  const run = {
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
  };
  const summary = {
    sets: {
      'synthetic-users': {
        n: 4,
        pass: 3,
        fail: 1,
        needsJudge: 0,
        unknown: 0,
        error: 0,
        accuracy: 0.75,
        ci95: [0.3, 0.95],
        judged: { code: 4, judge: 0, unknown: 0, error: 0 },
        byCategory: { stable: { n: 2, pass: 2 }, detail: { n: 2, pass: 1 } },
        byGenerator: { kimi: { n: 3, pass: 2 }, codex: { n: 1, pass: 1 } },
        store: { n: 2, pass: 1 },
        redlines: { secret_leak: 0, cross_patient: 1 },
      },
    },
    tokens: { prompt: 900, completion: 100 },
  };

  const rows = rowsFromSummary({ run, summary, scorer: 'score@2', costCny: 0.4, wallSeconds: 120 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.metric), ['accuracy', 'store_recall', 'redline_count']);

  const [accuracy, store, redline] = rows;
  assert.equal(accuracy.set, 'synthetic-users');
  assert.equal(accuracy.n, 4);
  assert.equal(accuracy.value, 0.75);
  assert.deepEqual(accuracy.ci95, [0.3, 0.95]);
  assert.equal(accuracy.runId, 'run-invented-02');
  assert.equal(accuracy.rawPath, '/runs/run-invented-02');
  assert.equal(accuracy.scorer, 'score@2');
  assert.equal(accuracy.costCny, 0.4);
  assert.equal(accuracy.wallSeconds, 120);
  assert.deepEqual(accuracy.tokens, { prompt: 900, completion: 100 });
  assert.deepEqual(accuracy.byCategory.stable, { n: 2, value: 1 });
  assert.deepEqual(accuracy.byGenerator.codex, { n: 1, value: 1 });

  assert.equal(store.value, 0.5);
  assert.equal(store.n, 2);
  assert.ok(Array.isArray(store.ci95));
  assert.equal(redline.value, 1);
  assert.equal(redline.n, 4);
  assert.equal(redline.ci95, null);
  assert.match(redline.notes, /cross_patient=1/);

  for (const row of rows) assert.deepEqual(validateLedgerRow(row), []);
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
          needsJudge: 0,
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
});


test('renderScoreboard groups by set, sorts rows and renders the contract columns', () => {
  const base = {
    split: 'dev',
    arm: 'capsule',
    flags: { historySearch: true, extraction: 'flash' },
    n: 10,
    metric: 'accuracy',
    judged: { code: 9, judge: 1, unknown: 0, error: 0 },
    tokens: { prompt: 100, completion: 50 },
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
        tokens: { prompt: 0, completion: 0 },
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
