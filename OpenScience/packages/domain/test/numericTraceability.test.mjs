import assert from 'node:assert/strict'
import test from 'node:test'

import { numericTraceFindings, outputNumbers, traceNumber } from '../index.mjs'

test('every number an output holds is read: nested JSON, numeric strings, grouped and quoted CSV counts', () => {
  const numbers = outputNumbers([
    { path: 'output/mendelian-randomization-run.json', text: JSON.stringify([{ mr_results: [{ method: 'IVW', b: -0.1234, se: '0.0456', pval: 6.8e-3 }], n_instruments: 24 }]) },
    { path: 'output/signals.csv', text: 'reaction,a,N,ROR,ROR_lo\nHaemorrhage,"2,200","20,328,575",3.41,2.95\n' },
    { path: 'output/notes.md', text: '99 99 99' },
    { path: 'output/broken.json', text: '{ not json' },
  ])
  for (const value of [-0.1234, 0.0456, 6.8e-3, 24, 2200, 20328575, 3.41, 2.95]) assert.ok(numbers.includes(value), `${value} missing`)
  assert.equal(numbers.includes(99), false, 'prose files are not outputs')
})

test('a stated number is verified at the precision it is written with, a near miss is mismatched', () => {
  const outputs = [-0.1234, 0.234, 95.3, 3.4149]
  assert.equal(traceNumber('0.12', outputs), 'verified', 'a negative estimate stated by magnitude')
  assert.equal(traceNumber('23.4', outputs), 'verified', 'a percentage of a stored fraction')
  assert.equal(traceNumber('3.41', outputs), 'verified')
  assert.equal(traceNumber('3.42', outputs), 'mismatched', 'rounded wrong')
  assert.equal(traceNumber('7.7', outputs), 'unsupported')
})

test('results on uncited lines are traced; the literature\'s numbers, conventions and the reference list are not', () => {
  const reportText = [
    '# 孟德尔随机化结果',
    'IVW 法显示 OR = 0.88（95% CI 0.80–0.97），P = 0.0068，共 24 个工具变量。',
    '既往观察性研究报告 HR 1.45 [3]。',
    '敏感性分析：MR-Egger OR 0.61，P < 0.05 视为显著。',
    '```',
    'OR = 5.55',
    '```',
    '## 参考文献',
    '1. Some study with 2,000 participants and OR 3.3.',
  ].join('\n')
  const outputs = [Math.exp(-0.1234), 0.8006, 0.9702, 0.0068, 24]
  const { findings, metrics } = numericTraceFindings({ reportText, outputs, outputLabel: '作业 mr-123 的输出' })
  assert.deepEqual(findings.map((finding) => [finding.line, finding.verdict, finding.numbers]), [[4, 'unsupported', ['0.61']]])
  assert.match(findings[0].message, /作业 mr-123 的输出里找不到/)
  assert.equal(findings[0].location, '第 4 行')
  assert.equal(metrics.verified >= 4, true, JSON.stringify(metrics))
})

test('a number close to an output but not equal to it is a near miss, named as such', () => {
  const { findings } = numericTraceFindings({ reportText: 'IVW OR = 0.91（P = 0.0068）', outputs: [0.88, 0.0068] })
  assert.deepEqual(findings.map((finding) => [finding.verdict, finding.numbers]), [['mismatched', ['0.91']]])
  assert.match(findings[0].message, /相近而不相同/)
  // A difference with a reason is answered to the finding, not explained in
  // the report: the 2026-09-27 osimertinib report grew a provenance table
  // that existed only to answer these (quality classes 2026-09-29, C1).
  assert.doesNotMatch(findings[0].message, /在文中说明/)
  assert.match(findings[0].message, /不在报告里另作说明/)
})

test('nothing to trace against is nothing found, not everything unsupported', () => {
  assert.deepEqual(numericTraceFindings({ reportText: 'OR = 0.88', outputs: [] }).findings, [])
})

test('a citation covers its sentence across wrapped lines, not only the physical line it sits on', () => {
  // The 2026-09-27 topic report (evals/research-topic-quality/results/
  // 2026-09-27-ordinary-constrained-cohort), wrapped at 110 columns: each
  // literature figure sits in a sentence whose [n] is on the next line, and
  // read line by line every one came back 「数字溯源不到」.
  const reportText = [
    'A 15,340-patient US network cohort found that the odds of missing at least one treatment were higher',
    'below age 55 (OR 1.33), and higher for Tuesday/Thursday/Saturday schedules (OR 1.33), with misses most',
    'prevalent on Saturdays (DOI 10.1093/ckj/sfs071 [3]). The European cohort found a hazard ratio for',
    'mortality of 2.04 (95% CI 1.27–3.29) when the miss was the first session of the week',
    '(PMID 32517695 [1]).',
  ].join('\n')
  assert.deepEqual(numericTraceFindings({ reportText, outputs: [16, 3] }).findings, [])
})

test('an uncited sentence is still traced, even inside a paragraph that cites elsewhere', () => {
  const reportText = [
    'Non-attendance was 0.6–1.4% of sessions in one cohort [1]. One network abstract measured 8.3% of',
    'sessions missed, with earlier reports at OR 1.7 (Blume 2012).',
    '',
    '- A list item stating OR 1.9 without a marker',
    '- is a block of its own, so it does not borrow this item\'s [4].',
  ].join('\n')
  const { findings } = numericTraceFindings({ reportText, outputs: [16] })
  // Line 1 carries a marker itself; line 2 is only the uncited sentence; the
  // first list item does not borrow the second item's citation.
  assert.deepEqual(findings.map((finding) => [finding.line, finding.numbers]), [[2, ['1.7']], [4, ['1.9']]])
})

test('a citation written after the full stop still covers the sentence before it', () => {
  const reportText = 'The pooled estimate across six trials\nwas OR 0.63.\n[17] It held in sensitivity analyses.\nA second estimate, OR 0.71, is uncited.'
  const { findings } = numericTraceFindings({ reportText, outputs: [16] })
  assert.deepEqual(findings.map((finding) => [finding.line, finding.numbers]), [[4, ['0.71']]])
})

test('a number written in powers of ten is traced as the value it states, held to its mantissa\'s precision', () => {
  // 2026-09-28 Mendelian randomization report: six p-values written as
  // a×10⁻ⁿ, each equal digit for digit to the output's e-notation, came back
  // as 「数字溯源不到」 — the mantissa had been traced alone.
  const outputs = outputNumbers([{ path: 'mr_results.csv', text: 'method,pval,Q_pval\nIVW,3.54262863158619e-11,9.97081339452979e-06\nsnp,2.17e-158,\n' }])
  const traced = (/** @type {string} */ reportText) => numericTraceFindings({ reportText, outputs }).findings.map((finding) => [finding.verdict, finding.numbers])
  assert.deepEqual(traced('IVW p = 3.54262863158619×10⁻¹¹，Q 检验 p = 9.97081339452979×10⁻⁶。'), [])
  assert.deepEqual(traced('最强变异 p = 2.17×10^-158；另一写法 p = 2.17×10-158。'), [])
  assert.deepEqual(traced('IVW p = 3.54e-11'), [])
  assert.deepEqual(traced('IVW p = 3.5×10⁻¹¹'), [], 'rounded to its own precision is still the output')
  assert.deepEqual(traced('IVW p = 3.6×10⁻¹¹'), [['mismatched', ['3.6']]], 'rounded wrong is still a near miss')
  assert.deepEqual(traced('IVW p = 3.54×10⁻¹²'), [['unsupported', ['3.54']]], 'the wrong power of ten is not the output')
})

test('a category label the engine writes as a range or an open bound holds its bounds', () => {
  // 2026-09-27 osimertinib package, report line 49: the age bands came back as
  // 「44、45、64、65、74、75 … 只有相近而不相同的值」.
  const outputs = outputNumbers([{
    path: 'overview.json',
    text: JSON.stringify({ age: [{ term: '<18', count: 2 }, { term: '18-44', count: 139 }, { term: '45-64', count: 1044 }, { term: '65-74', count: 1137 }, { term: '75+', count: 1105 }] }),
  }, { path: 'bands.csv', text: 'band,n\n"≥80",12\n' }])
  for (const value of [18, 44, 45, 64, 65, 74, 75, 80]) assert.ok(outputs.includes(value), `${value} missing`)
  const reportText = '年龄：<18 岁 2、18–44 岁 139、45–64 岁 1,044、65–74 岁 1,137、≥75 岁 1,105'
  assert.deepEqual(numericTraceFindings({ reportText, outputs }).findings, [])
  // Only the closed label shapes: a word with digits in it is not a label.
  assert.deepEqual(outputNumbers([{ path: 'x.json', text: JSON.stringify({ a: 'rs1421085', b: 'age 18-44 years', c: 'COVID-19' }) }]), [])
})
