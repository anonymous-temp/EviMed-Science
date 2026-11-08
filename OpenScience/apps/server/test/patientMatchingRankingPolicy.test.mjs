import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { JEV_FIT_INSTRUCTIONS, JEV_FIT_LEVELS, RANKING_POLICY, composeRanking, trialRecordText } from '@evimed/patient-matching-core';

const harness = fs.readFileSync(new URL('../../../evals/vcr-matching-boards/jev_arm.py', import.meta.url), 'utf8');

test('the product Jev rubric is the one the benchmark measured, word for word', () => {
  for (const level of JEV_FIT_LEVELS) assert.ok(harness.includes(JSON.stringify(level)), `level not in jev_arm.py: ${level.slice(0, 40)}`);
  for (const sentence of JEV_FIT_INSTRUCTIONS.split(/(?<=\.) /)) assert.ok(harness.includes(sentence), `instruction not in jev_arm.py: ${sentence.slice(0, 40)}`);
});

test('the trial record keeps the benchmark field order and the whole eligibility text', () => {
  const text = trialRecordText({ title: 'T', conditions: ['A', 'B'], interventions: ['X'], summary: 'S', sex: 'ALL', minimumAge: '18 Years', eligibility: 'Inclusion Criteria:\n- adults'.padEnd(5000, '.') });
  assert.match(text, /^Title: T\nTarget conditions: A; B\nInterventions: X\nBrief summary: S\nThe registry says the trial takes: sex ALL; minimum age 18 Years\nEligibility Criteria \(raw\):\nInclusion Criteria:/);
  assert.ok(text.length > 5000);
  assert.match(trialRecordText({ title: 'T', eligibilityText: 'in_record' }), /the registry record carries none/);
});

test('rank fusion follows the measured policy and never invents or drops a candidate', () => {
  assert.equal(RANKING_POLICY.id, 'triallink-1');
  const rerankOrder = ['a', 'b', 'c', 'd'];
  const fused = composeRanking({ rerankOrder, jevScores: [{ registryId: 'd', score: 3.9 }, { registryId: 'a', score: 0.1 }, { registryId: 'b', score: 2 }, { registryId: 'c', score: 2 }, { registryId: 'zz', score: 4 }] });
  assert.deepEqual(fused.jevOrder, ['d', 'b', 'c', 'a']);
  assert.deepEqual(fused.finalOrder, ['b', 'a', 'd', 'c']);
  assert.deepEqual(composeRanking({ rerankOrder }).finalOrder, rerankOrder);
  assert.throws(() => composeRanking({ rerankOrder: ['a', 'a'] }));
});
