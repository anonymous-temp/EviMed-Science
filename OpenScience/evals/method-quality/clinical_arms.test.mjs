// The clinical extraction evaluation's arms: two, and no two of them carry the same prompt.
//
// A third arm, `off`, ran for as long as the runner existed with a prompt byte-identical to `native`'s — the enhanced guidance only
// ever went to `on` — so the gap between `native` and `off` was the noise floor of the comparison, not a finding. An arm that is
// not a different prompt is a replicate (the runner's `repeats`), never another arm.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLINICAL_ARMS, armsForRepeat, clinicalExtractionPrompt } from './clinical_arms.mjs';

const input = { subjectKey: 'sub_1', documentId: 'doc_1', text: '患者 44 岁。', criteria: [{ kind: 'inclusion' }], asOf: '2026-10-09T00:00:00.000Z' };
const guidance = '## Evidence-preserving cloud extraction\nkeep the quote';
const factContract = { fields: ['clinical'] };
const promptOf = arm => clinicalExtractionPrompt({ arm, guidance, factContract, input });

test('the evaluation has two arms, native and on, and no two arms carry the same prompt', () => {
  assert.deepEqual([...CLINICAL_ARMS], ['native', 'on']);
  const prompts = CLINICAL_ARMS.map(promptOf);
  assert.equal(new Set(prompts).size, prompts.length, 'two arms with one prompt are replicates of one arm');
  assert.ok(promptOf('on').includes(guidance) && promptOf('on').includes(JSON.stringify({ factContract })));
  assert.ok(!promptOf('native').includes(guidance) && !promptOf('native').includes('factContract'));
});

test('the native prompt is the one the archived native cells were run with, byte for byte', () => {
  const historical = `Extract sourced facts for this synthetic study. Return only JSON {"facts":[...]}. Each fact has subjectKey, documentId, variable, value (number or text), unit (optional), polarity (affirmed/negated/hypothetical/family), occurredAt (ISO date if explicit), surface (exact substring), quote (exact substring). Do not calculate eligibility. Optional clinical metadata follows the supplied schema when guidance is present. No invented measurements. Omit optional unknown fields. Clinical metadata belongs only inside clinical.\n\n${JSON.stringify(input)}`;
  assert.equal(promptOf('native'), historical);
  assert.equal(promptOf('on'), historical.replace('\n\n', `\n${guidance}\n${JSON.stringify({ factContract })}\n`));
});

test('every repeat runs each arm once, and the order alternates so no arm always goes first', () => {
  for (const repeat of [0, 1, 2, 3]) assert.deepEqual([...armsForRepeat(repeat)].sort(), [...CLINICAL_ARMS].sort());
  assert.notDeepEqual(armsForRepeat(0), armsForRepeat(1));
  assert.deepEqual(armsForRepeat(0), armsForRepeat(2));
});

test('an arm the evaluation does not have is refused by name', () => {
  assert.throws(() => promptOf('off'), /unknown clinical arm "off"/);
});
