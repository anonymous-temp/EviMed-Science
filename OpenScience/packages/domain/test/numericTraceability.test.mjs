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
})

test('nothing to trace against is nothing found, not everything unsupported', () => {
  assert.deepEqual(numericTraceFindings({ reportText: 'OR = 0.88', outputs: [] }).findings, [])
})
