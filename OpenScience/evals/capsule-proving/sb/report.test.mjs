import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregate, openings, primaryRequest, verdict } from './report.mjs';

test('whole pre-compatibility calibration phase is excluded without selecting outcomes', () => {
  const amendments = [{ runId: 'sb-none-1', tasks: ['pass', 'fail'], primaryAfter: '2026-11-11T08:40:00Z' }];
  for (const task of ['pass', 'fail']) {
    assert.equal(primaryRequest({ runId: 'sb-none-1', task, at: '2026-11-11T08:30:00Z' }, amendments), false);
    assert.equal(primaryRequest({ runId: 'sb-none-1', task, at: '2026-11-11T09:30:00Z' }, amendments), true);
  }
  assert.equal(primaryRequest({ runId: 'sb-learned-1', task: 'fail', at: '2026-11-11T08:30:00Z' }, amendments), true);
});

test('verifier infrastructure errors never become scored task failures', () => {
  assert.deepEqual(verdict({ official: { verifier_error: 'bootstrap failed', rewards: { reward: 0 } } }),
    { pass: false, scored: false, error: 'bootstrap failed' });
});
test('reads both upstream reward formats', () => {
  assert.equal(verdict({ official: { rewards: { reward: 1 } } }).pass, true);
  assert.equal(verdict({ official: { passed: false, reward: 0 } }).scored, true);
  assert.equal(verdict({ official: { rewards: null } }).scored, false);
  assert.equal(verdict({ official: { error: 'timeout', rewards: { reward: 0 } } }).scored, true);
  assert.equal(verdict({ official: { error: 'docker_build_failed', passed: false } }).scored, false);
});
test('unfinished and infrastructure tasks remain in planned denominator', () => {
  const record = { task: { category: 'data' }, official: { passed: true }, requests: [] };
  const result = aggregate([record, { ...record, infraError: 'docker unavailable' }], 4);
  assert.equal(result.value, .25); assert.equal(result.scoredValue, 1);
  assert.equal(result.error, 1); assert.equal(result.unknown, 2); assert.equal(result.complete, false);
  assert.ok(result.ci95[0] < .25 && result.ci95[1] > .25);
});
test('usage totals preserve cached tokens and missing usage', () => {
  const result = aggregate([{ task: { category: 'data' }, official: { passed: true },
    requests: [{ usage: { prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 8 }, costCny: .1 }, { usageMissing: true }] }], 1);
  assert.equal(result.tokens.prompt, 10); assert.equal(result.tokens.cached, 8);
  assert.equal(result.tokens.completion, 3); assert.equal(result.tokens.missingUsage, 1);
});
test('off-peak prices do not masquerade as a methods efficiency gain', () => {
  const request = { requestedModel: 'deepseek-flash', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, costCny: 2 };
  const result = aggregate([{ task: { category: 'data' }, official: { passed: true }, requests: [
    { ...request, at: '2026-11-11T05:30:00Z' }, { ...request, at: '2026-11-11T06:30:00Z' }] }], 1);
  assert.equal(result.tokens.costCny, 3);
  assert.equal(result.tokens.costCnyPeakEquivalent, 4);
});
test('an empty sample has no confidence interval or rate', () => {
  const result = aggregate([], 0);
  assert.equal(result.value, null); assert.equal(result.ci95, null);
});
test('opening requires an actual read of an available skill, not prose or directory listing', () => {
  const events = [{ role: 'assistant', content: 'I opened foo/SKILL.md' },
    { name: 'bash', arguments: { command: 'ls /skills/foo' } },
    { name: 'read', arguments: { path: '/skills/unknown/SKILL.md' } },
    { id: 'one', name: 'read', arguments: { path: '/skills/foo/SKILL.md' } },
    { id: 'one', name: 'read', arguments: { path: '/skills/foo/SKILL.md' } },
    { type: 'tool_execution_end', toolCallId: 'one', isError: false },
    { id: 'failed', name: 'read', arguments: { path: '/skills/foo/SKILL.md' } },
    { type: 'tool_execution_end', toolCallId: 'failed', isError: true }];
  assert.deepEqual(openings(events, ['foo']), ['foo']);
});
test('upstream ACP read events retain method identity and completion state', () => {
  const events = [{ type: 'tool_call', tool_call_id: 'a', kind: 'read', title: '/home/agent/.agents/skills/foo/SKILL.md', status: 'completed' },
    { type: 'tool_call', tool_call_id: 'b', kind: 'read', title: '/home/agent/.agents/skills/foo/SKILL.md', status: 'failed' }];
  assert.deepEqual(openings(events, ['foo']), ['foo']);
});
test('final report includes late gateway charges and appends one idempotent ledger row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-report-'));
  try {
    const runs = path.join(root, 'runs'), dir = path.join(runs, 'sb-none-1');
    fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ pins: { sb: 'fixture-pin' }, samplingRule: 'fixture' }));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ tasks: ['x'], model: 'deepseek-flash', pins: { sb: 'fixture-pin' } }));
    const first = { runId: 'sb-none-1', task: 'x', usage: { prompt_tokens: 10, completion_tokens: 1 }, costCny: .1 };
    const late = { ...first, disconnected: true };
    fs.writeFileSync(path.join(dir, 'records/x.json'), JSON.stringify({ task: { id: 'x', category: 'data' },
      official: { passed: true }, wallSeconds: 1, mounted: [], requests: [first] }));
    fs.writeFileSync(path.join(root, 'usage.jsonl'), [first, late, { ...first, runId: 'another-arm' }].map(JSON.stringify).join('\n'));
    const ledger = path.join(root, 'ledger.jsonl');
    const script = fileURLToPath(new URL('./report.mjs', import.meta.url));
    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync(process.execPath, [script, root, runs, ledger, '--append'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    assert.equal(summary.tokens.requests, 2); assert.equal(summary.tokens.prompt, 20);
    assert.equal(summary.tokens.costCny, .2);
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1); assert.equal(rows[0].costCny, .2); assert.equal(rows[0].n, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
