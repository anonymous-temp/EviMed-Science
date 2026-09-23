import assert from 'node:assert/strict'
import test from 'node:test'

import { referenceEntries, referenceLookups, referenceResolutionFindings, titleCoverage } from '../index.mjs'

const report = [
  '## 结论',
  '远程监测降低心衰再住院 [1]，TIM-HF2 [2]，指南 [3]，另一篇 [4]。',
  '',
  '## 参考文献',
  '1. Koehler F, et al. Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2): a randomised, controlled, parallel-group, unmasked trial. Lancet. 2018;392:1047-1057. doi:10.1016/S0140-6736(18)31880-4 PMID: 30153985',
  '2. Smith A. A made-up paper about telemonitoring. doi:10.9999/not-a-real-doi',
  '3. 国家卫生健康委员会. 心力衰竭诊疗指南（2024 年版）. https://www.nhc.gov.cn/',
  '4. Brown B. Remote monitoring in chronic heart failure: a meta-analysis.',
  '   J Card Fail. 2020. PMID: 12345678 doi:10.1016/j.cardfail.2020.01.001',
].join('\n')

test('the entries of the last reference list are read with their identifiers, continuation lines joined', () => {
  const entries = referenceEntries(report)
  assert.deepEqual(entries.map((entry) => [entry.number, entry.dois, entry.pmids]), [
    [1, ['10.1016/s0140-6736(18)31880-4'], ['30153985']],
    [2, ['10.9999/not-a-real-doi'], []],
    [3, [], []],
    [4, ['10.1016/j.cardfail.2020.01.001'], ['12345678']],
  ])
  const lookups = referenceLookups(entries)
  assert.deepEqual(lookups.dois.length, 3)
  assert.deepEqual(lookups.pmids, ['30153985', '12345678'])
  assert.equal(lookups.truncated, 0)
})

test('each registry answer means what it decides and no more', () => {
  const entries = referenceEntries(report)
  const doi = new Map([
    ['10.1016/s0140-6736(18)31880-4', { status: /** @type {const} */ ('found'), title: 'Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2): a randomised, controlled, parallel-group, unmasked trial' }],
    ['10.9999/not-a-real-doi', { status: /** @type {const} */ ('not_found') }],
    ['10.1016/j.cardfail.2020.01.001', { status: /** @type {const} */ ('unknown'), reason: 'timeout' }],
  ])
  const pmid = new Map([
    ['30153985', { status: /** @type {const} */ ('found'), title: 'Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2)', doi: '10.1016/S0140-6736(18)31880-4' }],
    // The PMID is real, and names another work than the entry's DOI.
    ['12345678', { status: /** @type {const} */ ('found'), title: 'Something else entirely', doi: '10.1000/other' }],
  ])
  const { findings, metrics } = referenceResolutionFindings(entries, { doi, pmid })
  assert.deepEqual(findings.map((finding) => [finding.location, finding.kind]), [
    ['[2]', 'reference_unresolvable'],
    ['[4]', 'reference_mismatch'],
  ])
  assert.match(findings[0].message, /DOI 10\.9999\/not-a-real-doi/)
  assert.match(findings[1].message, /PMID 12345678/)
  // The evidence is the entry as listed, which is what makes it locatable in the report.
  assert.ok(report.includes(findings[0].evidence))
  assert.deepEqual(metrics, { references: 4, withIdentifier: 3, resolved: 2, unresolvable: 1, mismatched: 1, undecided: 0, truncated: 0 })
})

test('a registry that did not answer decides nothing', () => {
  const entries = referenceEntries(report)
  const unknown = new Map()
  const { findings, metrics } = referenceResolutionFindings(entries, { doi: unknown, pmid: unknown })
  assert.deepEqual(findings, [])
  assert.equal(metrics.undecided, 3)
})

test('a registry title is compared word by word, and a title in another script is not compared at all', () => {
  const entry = 'Koehler F. Efficacy of telemedical interventional management in patients with heart failure. Lancet 2018.'
  assert.ok(Number(titleCoverage('Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2)', entry)) >= 0.8)
  assert.ok(Number(titleCoverage('Dapagliflozin in patients with heart failure and reduced ejection fraction', entry)) < 0.5)
  assert.equal(titleCoverage('Dapagliflozin in patients with heart failure', '达格列净用于射血分数降低的心力衰竭'), null)
  const mismatch = referenceResolutionFindings(
    referenceEntries('## 参考文献\n1. Koehler F. Efficacy of telemedical interventional management in heart failure. doi:10.1056/nejmoa1911303'),
    { doi: new Map([['10.1056/nejmoa1911303', { status: /** @type {const} */ ('found'), title: 'Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction' }]]), pmid: new Map() },
  )
  assert.equal(mismatch.findings[0]?.kind, 'reference_mismatch')
  assert.match(mismatch.findings[0].message, /Dapagliflozin/)
})
