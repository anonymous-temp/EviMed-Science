// Tests of the runner's own pieces: the plan builder, the arm-A persona replacement and the transcript digest. No kernel, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../runner/run.mjs';
import { replacePersonaPrefix, NEUTRAL_PERSONA } from '../runner/persona.mjs';
import { digestTranscript, normalizeTool } from '../runner/cell.mjs';

const SUITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OS = path.resolve(SUITE, '../..');
const cases = JSON.parse(fs.readFileSync(path.join(SUITE, 'cases.json'), 'utf8')).cases;

test('the plan: 28 cases are 27 cells, plus the two fault variants', () => {
  const plan = buildPlan(cases, { set: 'all', arm: 'B' });
  assert.equal(plan.length, 29);
  const ids = plan.map((u) => `${u.id}/${u.variant.id}`);
  assert.ok(ids.includes('G06+G07/normal'));
  assert.ok(!ids.some((id) => id.startsWith('G07/')));
  assert.ok(ids.includes('G16/classifier-timeout') && ids.includes('G14/web-search-off'));
  assert.equal(plan.find((u) => u.id === 'G06+G07').cases.length, 2);
});

test('arm A runs the general cases only', () => {
  const plan = buildPlan(cases, { set: 'all', arm: 'A' });
  assert.ok(plan.every((u) => u.cases.every((c) => c.kind === 'general')));
  assert.equal(new Set(plan.flatMap((u) => u.cases.map((c) => c.id))).size, 22);
});

test('asking for G07 alone brings G06 along, since G07 continues its conversation', () => {
  const plan = buildPlan(cases, { ids: ['G07'], set: 'all', arm: 'B' });
  assert.deepEqual(plan.map((u) => u.id), ['G06+G07']);
});

test('an unknown case id is refused', () => {
  assert.throws(() => buildPlan(cases, { ids: ['G99'], set: 'all', arm: 'B' }), /unknown case/);
});

test('every fault variant names a profile the runner knows', () => {
  for (const c of cases) for (const v of c.variants ?? []) assert.ok(!v.profile || ['classifier-timeout', 'web-search-off'].includes(v.profile), `${c.id}/${v.id}`);
});

test('persona replacement swaps only the persona block, in both preset files of the tree under test', () => {
  for (const rel of ['packages/socket/presets/evimed-universal.patch.yml', 'packages/socket/presets/evimed-universal/agent.cordis.yml']) {
    const text = fs.readFileSync(path.join(OS, rel), 'utf8');
    const out = replacePersonaPrefix(text);
    assert.ok(out.replaced, rel);
    assert.ok(out.text.includes(NEUTRAL_PERSONA));
    const before = text.split('\n');
    const after = out.text.split('\n');
    const start = after.findIndex((l) => l.includes(NEUTRAL_PERSONA));
    assert.deepEqual(after.slice(0, start), before.slice(0, start), 'nothing before the block changes');
    const tail = after.slice(start + 1);
    assert.deepEqual(tail, before.slice(before.length - tail.length), 'nothing after the block changes');
    assert.ok(!after.slice(Math.max(0, start - 6), start + 2).join('\n').match(/医学/), 'the medical wording is gone from the block');
  }
});

test('persona replacement leaves a file without a persona row alone', () => {
  assert.deepEqual(replacePersonaPrefix('- id: other\n  config:\n    prefix: >-\n      keep me\n'), { text: '- id: other\n  config:\n    prefix: >-\n      keep me\n', replaced: false });
});

test('the transcript digest takes the last turn: its reply and its tool calls', () => {
  const lines = [
    { schemaVersion: 1 },
    { role: 'user', turn: 1, parts: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', turn: 1, parts: [{ type: 'text', text: 'a1' }] },
    { role: 'user', turn: 2, parts: [{ type: 'text', text: 'q2' }] },
    { role: 'tool', turn: 2, parts: [{ type: 'tool', tool: 'mcp__evimed__web_search', status: 'completed', input: { q: 'x' }, output: 'result' }] },
    { role: 'assistant', turn: 2, parts: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'a2' }] },
  ];
  const digest = digestTranscript(lines);
  assert.equal(digest.reply, 'a2');
  assert.deepEqual(digest.tools.map((t) => t.name), ['web_search']);
  assert.equal(normalizeTool('mcp__evimed__literature_search'), 'literature_search');
});
