import assert from 'node:assert/strict'
import test from 'node:test'

import { logGamma, statConsistencyFindings, twoSidedP } from '../src/statConsistency.mjs'

/** @param {number | null} actual @param {number} expected */
const close = (actual, expected, tolerance = 1e-6) => assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`)

test('the distributions match a reference implementation (scipy 1.15)', () => {
  close(logGamma(10.5), 13.940625219403763, 1e-10)
  close(logGamma(0.3), 1.0957979948180752, 1e-10)
  close(twoSidedP('t', 2.2, [28]), 0.0362254847788378)
  close(twoSidedP('t', 1, [10]), 0.3408931323020601)
  close(twoSidedP('t', 10, [5]), 0.00017094757574296357, 1e-9)
  close(twoSidedP('t', 0.5, [200]), 0.6176247523164607)
  close(twoSidedP('F', 4.11, [2, 57]), 0.021507045023543767)
  close(twoSidedP('F', 3.2, [1, 40]), 0.08121333758180461)
  close(twoSidedP('chi2', 3.84, [1]), 0.05004352124870519)
  close(twoSidedP('chi2', 12.3, [4]), 0.015254394655769615)
  close(twoSidedP('chi2', 50, [30]), 0.01240206071890054)
  close(twoSidedP('z', 1.96), 0.04999579029644087)
  close(twoSidedP('z', 2.58), 0.00988003151554129)
  close(twoSidedP('r', 0.35, [48]), 0.012715445142957906)
  assert.equal(twoSidedP('r', 1.2, [10]), null, 'a correlation cannot exceed 1')
  assert.equal(twoSidedP('t', 2, [0]), null)
})

test('a consistent APA line says nothing, whatever the rounding', () => {
  assert.deepEqual(statConsistencyFindings('The groups differed, t(28) = 2.20, p = .036.'), [])
  assert.deepEqual(statConsistencyFindings('An effect of dose, F(2, 57) = 4.11, p < .05, and of time, χ2(4) = 12.3, p = .015.'), [])
  assert.deepEqual(statConsistencyFindings('相关，r(48) = .35，p = 0.013。'), [])
  assert.deepEqual(statConsistencyFindings('Z = 2.58, P < 0.01'), [])
})

test('a p value the statistic cannot produce is found, and a flipped decision is gross', () => {
  const [wrong] = statConsistencyFindings('Line one.\nThe difference was t(28) = 2.20, p = .36 in the trial.')
  assert.equal(wrong.check, 'stat-p-inconsistent')
  assert.equal(wrong.line, 2)
  assert.equal(wrong.gross, true, '.36 says not significant; t(28) = 2.20 is')
  assert.match(wrong.message, /0\.036/)
  const [minor] = statConsistencyFindings('F(1, 40) = 3.20, p = .07')
  assert.equal(minor.check, 'stat-p-inconsistent')
  assert.equal(minor.gross, false, 'both sides say not significant')
})

test('an interval that excludes the null with a p that says otherwise is found — on the scale the measure names', () => {
  const [ratio] = statConsistencyFindings('HR 0.75 (95% CI 0.60–0.94; P = 0.21)')
  assert.equal(ratio.check, 'ci-p-inconsistent')
  assert.equal(ratio.computed.nullValue, 1)
  const [difference] = statConsistencyFindings('均数差 -3.40（95%CI -8.94 至 2.14，P=0.01）')
  assert.equal(difference.check, 'ci-p-inconsistent')
  assert.equal(difference.computed.nullValue, 0)
  assert.match(difference.message, /包含无效值 0/)
})

test('the 2026-09-22 reviewer case: a log odds ratio of 0.73 (0.46–1.00) excludes its null of 0', () => {
  assert.deepEqual(statConsistencyFindings('a pooled log odds ratio of 0.73 (95% CI: 0.46-1.00), P < 0.001'), [])
  // The same numbers as an odds ratio would be the boundary case, which is not decidable at two decimals.
  assert.deepEqual(statConsistencyFindings('OR 0.73 (95% CI 0.46-1.00), P = 0.04'), [])
})

test('an estimate outside its own interval is always wrong', () => {
  const [finding] = statConsistencyFindings('The hazard ratio was 1.52 (95% CI 0.60 to 0.94).')
  assert.equal(finding.check, 'estimate-outside-ci')
  assert.equal(finding.gross, true)
})

test('NEJM and Chinese spellings are read; unrelated p values are not attached to the wrong estimate', () => {
  assert.deepEqual(statConsistencyFindings('(hazard ratio, 0.75; 95% CI, 0.60 to 0.94; P=0.01)'), [])
  assert.deepEqual(statConsistencyFindings('风险比 1.36（95%CI：1.11～1.68，P=0.003）'), [])
  // The p belongs to the second estimate, and the first must not borrow it.
  assert.deepEqual(statConsistencyFindings('HR 0.75 (95% CI 0.60–0.94) and OR 1.2 (95% CI 0.9–1.6), P = 0.30'), [])
  // A p in the next sentence is not this interval's.
  assert.deepEqual(statConsistencyFindings('RR 1.2 (95% CI 0.9-1.6)。另一项研究 P=0.001'), [])
  // Nor is the p of the next outcome after the bracket closes (outputs/clinical-qa, 2026-07-22).
  assert.deepEqual(statConsistencyFindings('（OR 1.916，95% CI 0.999–3.674），LVEF 改善（p < 0.01）'), [])
})

test('near 0.05 an interval and a p from two methods may disagree, and that is not reported', () => {
  assert.deepEqual(statConsistencyFindings('OR=10.09, 95%CI 1.27–217.6, p=0.0545'), [])
  assert.equal(statConsistencyFindings('OR=10.09, 95%CI 1.27–217.6, p=0.21')[0]?.check, 'ci-p-inconsistent')
})

test('text without notation yields nothing', () => {
  assert.deepEqual(statConsistencyFindings('二甲双胍是 2 型糖尿病的一线用药，10 项研究，p 值未报告。'), [])
  assert.deepEqual(statConsistencyFindings(''), [])
})
