import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armEnv, budgetBalance, claim, failureClass, ledgerRow, meanInterval, parseArgs, reuseStats, summarizeRows, taskRow, wilson, SAB_GAPS } from './run_c2.mjs';
import { dabenchText, dacodeText, reuseSplit, sampleIds, TERMINATE_SENTENCE, DABENCH_DIR, PAPER } from './benches.mjs';
import { validateLedgerRow } from '../run/ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('arms: baseline is the product for a new account, reuse turns learning and the four method switches on', () => {
  const base = armEnv('baseline'), reuse = armEnv('reuse');
  assert.equal(base.OPEN_SCIENCE_LEARNING_ENABLED, 'false');
  assert.equal(base.OPEN_SCIENCE_OFFICIAL_PACKS_ENABLED, 'true');
  assert.equal(reuse.OPEN_SCIENCE_LEARNING_ENABLED, 'true');
  for (const key of ['OPEN_SCIENCE_METHOD_PYRAMID_ENABLED', 'OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED', 'OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED', 'OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED']) {
    assert.equal(base[key], 'false'); assert.equal(reuse[key], 'true');
  }
  assert.throws(() => armEnv('tools'), /unknown C2 arm/);
});

test('presentation follows the official prompts word for word', () => {
  const text = dabenchText({ question: 'Calculate the mean fare.', constraints: 'Round to two decimals.', format: '@mean_fare[value]' });
  assert.ok(text.startsWith('Question: Calculate the mean fare.\nRound to two decimals.\n'));
  assert.match(text, /@mean_fare\[value\]\nYour answer should contain all the "@answer_name\[answer\]" in the order mentioned/);
  const da = dacodeText({ instruction: 'Save the plot as result.png.\n' });
  assert.equal(da, `Save the plot as result.png.\n\n${TERMINATE_SENTENCE}`);
  assert.match(TERMINATE_SENTENCE, /Terminate\(output="literal_answer_or_output_path"\)/);
});

test('samples and the reuse split are taken from the frozen pool in order', async () => {
  const samples = JSON.parse(await fs.readFile(path.join(HERE, '../pools/c-samples-20261110.json'), 'utf8'));
  assert.equal(sampleIds(samples, 'dabench'), null);
  assert.equal(sampleIds(samples, 'da-code').length, 100);
  assert.equal(sampleIds(samples, 'sab').length, 30);
  const split = reuseSplit(Array.from({ length: 257 }, (_, i) => i));
  assert.equal(split.validation.length, 154); assert.equal(split.test.length, 103);
  assert.deepEqual(split.test[0], 154);
  assert.equal(SAB_GAPS.length, 3); assert.match(SAB_GAPS[0], /GPT-4o/);
});

test('intervals: Wilson for pass/fail, a clipped normal interval for mean scores', () => {
  assert.equal(wilson(0, 0), null);
  const [lo, hi] = wilson(230, 257); assert.ok(lo < 230 / 257 && hi > 230 / 257 && hi <= 1);
  const [mlo, mhi] = meanInterval([1, 0, 0.5, 0.25]); assert.ok(mlo >= 0 && mhi <= 1 && mlo < 0.4375 && mhi > 0.4375);
  assert.deepEqual(meanInterval([1]), [0, 1]);
});

test('failure classes are decided from the record and the official verdict', () => {
  const ok = { turns: [{ run: { status: 'succeeded' }, tools: [] }] };
  assert.equal(failureClass({ bench: 'dabench', record: ok, verdict: { pass: true } }), null);
  assert.equal(failureClass({ bench: 'dabench', record: { turns: [{ timedOut: true, run: { status: 'running' } }] }, verdict: { pass: false } }), 'execution limit');
  assert.equal(failureClass({ bench: 'dabench', record: { infra: true, turns: [] }, verdict: null }), 'execution limit');
  assert.equal(failureClass({ bench: 'dabench', record: ok, verdict: { pass: false, missingNames: ['r'] } }), 'misread instruction');
  assert.equal(failureClass({ bench: 'dabench', record: ok, verdict: { pass: false, missingNames: [] } }), 'reasoning');
  const delegated = { turns: [{ run: { status: 'succeeded' }, tools: [{ name: 'evimed_delegate', error: true }] }] };
  assert.equal(failureClass({ bench: 'dabench', record: delegated, verdict: { pass: false, missingNames: [] } }), 'coordination');
  const missingFile = { pass: false, finished: true, added: ['notes.md'], changed: [], terminateFound: false, evalResult: [{ file: ['result.csv'] }] };
  assert.equal(failureClass({ bench: 'da-code', record: ok, verdict: missingFile }), 'misread instruction');
  assert.equal(failureClass({ bench: 'da-code', record: ok, verdict: { ...missingFile, added: ['result.csv'] } }), 'reasoning');
  assert.equal(failureClass({ bench: 'da-code', record: ok, verdict: { ...missingFile, finished: false } }), 'execution limit');
});

test('rows, summary and ledger row: every task counts, infra failures are wrong and excluded only from valueValid', () => {
  const record = (status, usage) => ({ wallMs: 60_000, turns: [{ run: { status, model: 'm', effectiveAgentId: 'a', effectiveRouteReason: 'r', usage }, tools: [{ name: 'bash' }], changed: ['x.py'] }], firstRequest: { hadMemoryTools: false } });
  const usage = { requests: 3, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, costCny: 0.01 };
  const rows = [
    taskRow({ bench: 'dabench', task: { id: 'dabench-0', level: 'easy' }, record: record('succeeded', usage), verdict: { pass: true, score: 1 } }),
    taskRow({ bench: 'dabench', task: { id: 'dabench-5', level: 'hard' }, record: record('succeeded', usage), verdict: { pass: false, score: 0, missingNames: [] } }),
    taskRow({ bench: 'dabench', task: { id: 'dabench-6', level: 'hard' }, record: { infra: true, turns: [] }, verdict: null }),
  ];
  const summary = summarizeRows(rows, { bench: 'dabench', arm: 'baseline', expected: 3 });
  assert.equal(summary.n, 3); assert.equal(summary.passed, 1); assert.equal(summary.value, 1 / 3);
  assert.equal(summary.nValid, 2); assert.equal(summary.valueValid, 0.5); assert.equal(summary.complete, true);
  assert.deepEqual(summary.failureClasses, { reasoning: 1, 'execution limit': 1 });
  assert.equal(summary.tokens.prompt, 2000); assert.equal(summary.byCategory.hard.n, 2); assert.deepEqual(summary.models, { m: 2 });
  const row = ledgerRow(summary, { runId: 'c2-dabench-baseline-1', commit: 'abc', engineVersion: 'v0.5.3', flags: { a: 'b' }, rawPath: '/srv/x', notes: { scorer: 'official', text: 'n' }, label: 'C2' });
  assert.deepEqual(validateLedgerRow(row), []);
  assert.equal(row.arm, 'product-baseline'); assert.equal(row.set, PAPER.dabench.set); assert.equal(row.metric, 'accuracy');
});

test('reuse rate counts openings of methods learned in other tasks', () => {
  const rows = [{ id: 't1', methodsOpened: ['learned-a', 'official-x'] }, { id: 't2', methodsOpened: ['learned-a'] }, { id: 't3', methodsOpened: [] }];
  const stats = reuseStats(rows, [{ name: 'learned-a' }, { name: 'learned-b' }]);
  assert.equal(stats.openings, 3); assert.equal(stats.learnedOpenings, 2); assert.equal(stats.crossTaskReuseRate, 2 / 3);
  assert.equal(stats.tasksUsingLearned, 2); assert.equal(stats.learnedMethods, 2);
});

test('claims are exclusive while the owner lives and are taken over from a dead owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c2-claim-'));
  try {
    assert.equal(await claim(dir, 't1', { pid: process.pid, slot: 1 }), true);
    assert.equal(await claim(dir, 't1', { pid: process.pid + 999999, slot: 2 }), false);
    await fs.writeFile(path.join(dir, 't2.json'), JSON.stringify({ pid: 2 ** 22 + 12345, slot: 2 }));
    assert.equal(await claim(dir, 't2', { pid: process.pid, slot: 1 }), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('arguments and the budget line', () => {
  const args = parseArgs(['worker', '--bench', 'dabench', '--arm', 'baseline', '--out', '/x', '--slot', '2', '--gate-load', '16', '--keep-data']);
  assert.equal(args.mode, 'worker'); assert.equal(args.slot, 2); assert.equal(args.gateLoad, 16); assert.equal(args.keepData, true);
  assert.equal(budgetBalance('2026-11-10T09:38:40Z balance 3237.65'), 3237.65);
  assert.equal(budgetBalance(''), null);
});

test('the official DABench scorer decides a pinned question (lab data only)', { skip: !fsSync.existsSync(`${DABENCH_DIR}/eval_closed_form.py`) }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c2-dab-'));
  try {
    const python = process.env.C2_SCORE_PYTHON ?? 'python3';
    const score = async (text) => {
      await fs.writeFile(`${dir}/r.txt`, text);
      const run = spawnSync(python, ['-I', `${HERE}/score_dabench.py`, 'one', '--id', '0', '--response-file', `${dir}/r.txt`, '--out', `${dir}/v.json`], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(await fs.readFile(`${dir}/v.json`, 'utf8'));
    };
    assert.equal((await score('The mean fare is @mean_fare[34.65].')).pass, true);
    const wrong = await score('@mean_fare[34.66]');
    assert.equal(wrong.pass, false); assert.deepEqual(wrong.missingNames, []);
    const unformatted = await score('The mean fare is 34.65.');
    assert.equal(unformatted.pass, false); assert.deepEqual(unformatted.missingNames, ['mean_fare']);
    assert.equal((await score('')).emptyResponse, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
