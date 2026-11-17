import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestionData, mergeErrata } from '../run/dataCheck.mjs';
const entry = (question, official) => ({ caseId: 'A', gold: { questions: [{ qid: 'q', question, official }] } });
const loaded = text => ({ sessions: [{ sessionId: 's001', at: '2026-11-01', messages: [{ role: 'user', text }] }] });
test('question checks identify unsupported gold, date substitution and single-best multi-answer rubrics', () => {
  const e = entry('Which two medicines?', { answers: [{ content: 'aspirin', is_correct: true }, { content: 'warfarin', is_correct: true }], source_key_points: ['aspirin'], metadata: { answer_format: 'single best answer' } });
  const codes = checkQuestionData(e, loaded('Takes aspirin.'), { set: 'medmemorybench', split: 'dev' }).map(r => r.code);
  assert.ok(codes.includes('evidence_gold_mismatch')); assert.ok(codes.includes('multiple_answers_single_best'));
  const date = checkQuestionData(entry('When did the surgery happen?', { answer: '2026-11-01' }), loaded('Surgery happened two years ago.'), { set: 'medmemorybench', split: 'dev' });
  assert.ok(date.some(r => r.code === 'record_date_as_event_date'));
  assert.deepEqual(checkQuestionData(entry('Which drug?', { answer: 'aspirin', source_key_points: ['aspirin'] }), loaded('Takes aspirin.'), { set: 'medmemorybench', split: 'dev' }), []);
});
test('abstention answerable from supplied source and translated verbatim anchors are quarantined with case identity', () => {
  const e = entry('Which medicine?', { answer: 'unknown', source_key_points: ['Takes warfarin'], metadata: { unanswerable: true, answerable_value: 'warfarin' } });
  assert.ok(checkQuestionData(e, loaded('Takes warfarin.'), { set: 'medmemorybench', split: 'dev' }).some(r => r.code === 'answerable_abstention'));
  const translated = { caseId: 'B', gold: { stated: '华法林', accept: ['warfarin'], questions: [{ qid: 'q', expect: { mustContain: ['warfarin'] } }] } };
  assert.ok(checkQuestionData(translated, loaded('华法林'), { set: 'brand-generic', split: 'dev' }).some(r => r.code === 'translated_verbatim_anchor'));
  const merged = mergeErrata([{ set: 's', split: 'dev', caseId: 'A', id: 'q', reason: 'a' }], [{ set: 's', split: 'dev', caseId: 'B', id: 'q', reason: 'b' }]);
  assert.equal(merged.length, 2);
});
test('translated public replies are review signals without shrinking valid denominators', () => {
  const e = { caseId: 'B', gold: { stated: 'warfarin', questions: [{ qid: 'q', expect: { mustContainAny: ['warfarin'] } }] } };
  const findings = checkQuestionData(e, loaded('I take warfarin.'), { set: 'brand-generic', split: 'dev', answers: [{ qid: 'q', answer: '我每天服用华法林。' }] });
  assert.equal(findings[0].code, 'translated_verbatim_anchor'); assert.equal(findings[0].confirmed, false);
});
