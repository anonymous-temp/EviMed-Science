import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCriterionVerdict, timingVerdict, validateCriterionLogic, openQuestionsOf } from '../index.mjs'

test('parts combine by rule, not-applicable parts do not count', () => {
  const part = (verdict) => ({ text: 'x', verdict, basis: 'stated', evidenceIds: [], timing: null })
  const at = (parts, rule) => deriveCriterionVerdict({ verdict: 'unknown', parts, rule }).verdict
  assert.equal(at([part('satisfied'), part('satisfied'), part('not-satisfied')], { kind: 'atLeast', count: 2 }), 'satisfied')
  assert.equal(at([part('satisfied'), part('unknown'), part('not-satisfied')], { kind: 'atLeast', count: 2 }), 'unknown')
  assert.equal(at([part('satisfied'), part('not-satisfied'), part('not-satisfied')], { kind: 'atLeast', count: 2 }), 'not-satisfied')
  assert.equal(at([part('satisfied'), part('unknown')], { kind: 'all', count: null }), 'unknown')
  assert.equal(at([part('not-satisfied'), part('unknown')], { kind: 'all', count: null }), 'not-satisfied')
  assert.equal(at([part('not-satisfied'), part('satisfied')], { kind: 'any', count: null }), 'satisfied')
  assert.equal(at([part('not-applicable'), part('satisfied')], { kind: 'all', count: null }), 'satisfied')
  assert.deepEqual(deriveCriterionVerdict({ verdict: 'satisfied' }), { verdict: 'satisfied', derived: false, parts: undefined })
})

test('a part list visibly short of the criterion overrules the model only with what the listed parts prove', () => {
  const part = (verdict) => ({ text: 'x', verdict, basis: 'stated', evidenceIds: [], timing: null })
  const derive = (verdict, parts, rule) => deriveCriterionVerdict({ verdict, parts, rule })
  // "Two or more of four": only the one condition looked at is listed; its absence does not prove the criterion unmet.
  assert.deepEqual([derive('unknown', [part('not-satisfied')], { kind: 'atLeast', count: 2 }).verdict, derive('unknown', [part('not-satisfied')], { kind: 'atLeast', count: 2 }).derived], ['unknown', false])
  assert.equal(derive('satisfied', [part('unknown')], { kind: 'atLeast', count: 2 }).verdict, 'satisfied')
  assert.equal(derive('unknown', [part('satisfied'), part('satisfied')], { kind: 'atLeast', count: 2 }).verdict, 'satisfied', 'enough met parts prove it')
  // One listed part of an "all" or "any": a met "all" or an unmet "any" needs the rest; an unmet "all" or a met "any" does not.
  assert.equal(derive('not-satisfied', [part('satisfied')], { kind: 'all', count: null }).verdict, 'not-satisfied')
  assert.equal(derive('unknown', [part('not-satisfied')], { kind: 'all', count: null }).verdict, 'not-satisfied')
  assert.equal(derive('satisfied', [part('not-satisfied')], { kind: 'any', count: null }).verdict, 'satisfied')
  assert.equal(derive('unknown', [part('satisfied')], { kind: 'any', count: null }).verdict, 'satisfied')
})

test('time windows are computed in whole days from the recorded dates', () => {
  const t = (eventDate, referenceDate, windowDays, relation = 'within') => timingVerdict({ eventDate, referenceDate, windowDays, relation })
  assert.equal(t('2069-01-01', '2069-06-30', 183), 'satisfied')
  assert.equal(t('2068-12-01', '2069-06-30', 183), 'not-satisfied')
  assert.equal(t('2068-12-01', '2069-06-30', 183, 'beyond'), 'satisfied')
  assert.equal(t(null, '2069-06-30', 183), null)
  assert.equal(t('2069-07-01', '2069-06-30', 183), null, 'an event after the reference date decides nothing')
  const part = { text: 'MI', verdict: 'unknown', basis: 'stated', evidenceIds: [], timing: { eventDate: '2069-03-01', referenceDate: '2069-04-01', windowDays: 183, relation: 'within' } }
  assert.equal(deriveCriterionVerdict({ verdict: 'unknown', parts: [part], rule: { kind: 'any', count: null } }).verdict, 'satisfied')
})

test('criterion logic is validated', () => {
  assert.throws(() => validateCriterionLogic({ rule: { kind: 'atLeast', count: 0 } }, 'c'))
  assert.throws(() => validateCriterionLogic({ rule: { kind: 'all', count: 2 } }, 'c'))
  assert.throws(() => validateCriterionLogic({ timing: { eventDate: '2069-13-40', referenceDate: null, windowDays: 1, relation: 'within' } }, 'c'))
  assert.throws(() => validateCriterionLogic({ parts: [{ text: 'x', verdict: 'maybe', basis: 'stated', evidenceIds: [], timing: null }] }, 'c'))
  assert.throws(() => validateCriterionLogic({ missingFact: 'x'.repeat(301) }, 'c'))
  validateCriterionLogic({ rule: null, timing: null, parts: [], missingFact: '' }, 'c')
})

test('open questions group the facts that keep criteria unknown across pairs', () => {
  const row = (trialId, facts) => ({ subjectKey: 'p', trialId, state: 'complete', criteria: facts.map((fact, index) => ({ criterionId: `c${index}`, verdict: fact ? 'unknown' : 'satisfied', missingFact: fact })) })
  const questions = openQuestionsOf([row('t1', ['EGFR mutation status', 'ECOG performance status']), row('t2', ['EGFR mutation status.', '']), { ...row('t3', ['EGFR mutation status']), state: 'pending' }])
  assert.deepEqual(questions.map((q) => [q.fact, q.pairs]), [['EGFR mutation status', 2], ['ECOG performance status', 1]])
  assert.deepEqual(questions[0].trials, ['t1', 't2'])
})
