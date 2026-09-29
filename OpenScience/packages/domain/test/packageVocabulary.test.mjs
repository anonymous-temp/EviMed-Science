// A report writing its own package's machine vocabulary — JSON keys and
// values — as prose. Eleven of nineteen accepted capabilities did (quality
// classes 2026-09-29, C2): `ranking` 记为 `withheld`, `openfda_live`,
// 「契约种类：off-label-report ｜ 评估日期（decisionDate）」. The vocabulary is
// the package's own, so this is a closed-vocabulary check (principle 5), and it
// is advice (principle 4).
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { runGate } from '../index.mjs'

/** @param {string} kind @param {Record<string, string>} files */
const notices = (kind, files) => {
  const verdict = runGate(/** @type {any} */ ({ contractKind: kind, files: new Map(Object.entries(files)), expectedOutputs: [] }))
  return { verdict, found: verdict.issues.filter((issue) => issue.check === 'package-vocabulary-in-prose') }
}

test('a field name or value of the package written as prose is named, once per file, as advice', () => {
  const { verdict, found } = notices('drug-selection-report', {
    'drug-selection-report.md': '# 遴选\n\n本次未提供评分细则，`ranking` 记为 `withheld`。\n\n另见 selectionDomains 与 scoring_policy_version。\n',
    'selection-summary.json': JSON.stringify({ ranking: 'withheld', selectionDomains: ['efficacy'], scoring_policy_version: 'v1' }),
  })
  assert.equal(found.length, 1, JSON.stringify(verdict.issues))
  assert.equal(found[0].severity, 'advisory')
  assert.equal(found[0].code, 'report_package_vocabulary')
  assert.equal(found[0].line, 3)
  assert.match(found[0].message, /`ranking`, `withheld`/)
  assert.match(found[0].message, /and 1 more line/)
  assert.equal(verdict.ok, true, 'advice never withholds a package')
})

test('clinical abbreviations, ordinary words, links and names the package does not hold are left alone', () => {
  const { found } = notices('drug-selection-report', {
    'drug-selection-report.md': [
      '# 遴选',
      '',
      'eGFR、HbA1c、uACR 与 mRNA 按常规写法；follow-up 与 dose-response 是普通英文。',
      '来源 https://example.org/api?page_size=10&sortOrder=asc 不算正文。',
      '`ROR` 与 expected_count 不在本包的 JSON 里。',
    ].join('\n'),
    'selection-summary.json': JSON.stringify({ eGFR: 45, followUp: 'x', page_size: 10, sortOrder: 'asc' }),
  })
  assert.deepEqual(found, [])
})

test('the 2026-09-27 drug-selection package is named for the field names its report carries', async () => {
  const dir = new URL('../../../evals/drug-selection/results/2026-09-27-ds-001-doac-nvaf-no-rubric/deliverable/deliverables/', import.meta.url)
  const [id] = await readdir(dir)
  const base = new URL(`${id}/`, dir)
  /** @type {Record<string, string>} */
  const files = {}
  for (const name of await readdir(base)) {
    if (/\.(md|json|csv)$/.test(name)) files[name] = await readFile(new URL(name, base), 'utf8')
  }
  assert.ok(Object.keys(files).some((name) => name.endsWith('.json')), 'the specimen was not read')
  const { found } = notices('drug-selection-report', files)
  assert.equal(found.length, 1)
  assert.match(found[0].message, /not_assessed/)
})
