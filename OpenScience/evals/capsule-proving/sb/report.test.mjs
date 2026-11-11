import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, openings, verdict } from './report.mjs';

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
