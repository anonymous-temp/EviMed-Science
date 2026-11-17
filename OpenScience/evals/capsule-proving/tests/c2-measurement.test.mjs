import test from 'node:test';
import assert from 'node:assert/strict';
import { failureClass, taskRow, summarizeRows } from '../c2/run_c2.mjs';
import { dacodeText } from '../c2/benches.mjs';
const record = { turns: [{ run: { status: 'succeeded' }, tools: [] }] };
test('scorer failures and post-process errors are not reasoning failures or observed zero scores', () => {
  const verdict = { score: null, pass: null, error: 'post-process failed: basch: command not found', outcome: 'post-process-failed', postProcessLog: [{ cmd: 'basch', exit: 127, stderr: 'basch: command not found' }], added: ['result.png'] };
  const row = taskRow({ bench: 'da-code', task: { id: 'plot' }, record, verdict });
  assert.equal(row.score, null); assert.equal(row.scored, false);
  assert.equal(row.failureClass, 'post-process failed');
  assert.equal(failureClass({ bench: 'da-code', record, verdict: { error: 'scorer exit 127', score: null } }), 'measurement failure');
  const wrong = taskRow({ bench: 'da-code', task: { id: 'wrong' }, record, verdict: { score: 0, pass: false, finished: true } });
  assert.equal(wrong.failureClass, 'reasoning');
  const summary = summarizeRows([row, wrong], { bench: 'da-code', arm: 'baseline', expected: 2 });
  assert.equal(summary.n, 2); assert.equal(summary.nValid, 1); assert.deepEqual(summary.unobservedTasks, ['plot']);
});
test('plot tasks disclose the reproducible script requirement without imposing an unexplained basename', () => {
  const prompt = dacodeText({ instruction: 'Save result.png', post_process: ['plot_process'] });
  assert.match(prompt, /top-level.*\.py/); assert.match(prompt, /plt\.savefig/);
  assert.match(prompt, /any filename/i);
});
