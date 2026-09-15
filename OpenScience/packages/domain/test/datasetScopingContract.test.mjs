/**
 * Number provenance in a dataset-scoping package.
 *
 * The contract is borrowed from `dsh-data-quality`'s `verifyCitations` and the
 * reason it is worth borrowing is the four-value verdict: a number the snapshot
 * does not hold and a number the snapshot nearly holds ask for opposite
 * repairs, and a check that says only "not found" makes the run work out which
 * it is. These cases hold the four apart.
 *
 * Advisory throughout, by decision rather than by omission (principle 4).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { runGate } from '../src/contractRegistry.mjs'
import { datasetScopingFindings } from '../src/datasetScopingContract.mjs'

const PROFILE = {
  rows: 4820,
  columns: 37,
  missingness: { egfr: 0.1834, hba1c: 0.0421 },
  numeric: [{ name: 'age', mean: 63.7, sd: 11.2 }],
}

/** The ten outputs the manifest declares, so the required-output pass is quiet. */
const OUTPUTS = [
  'data-profile.md', 'data-profile.json', 'data-profile.py', 'data-quality.md',
  'evidence-map.md', 'feasibility-matrix.md', 'external-linkage.md',
  'research-portfolio.md', 'study-protocol.md', 'scoping-run.json',
]

/** @param {Record<string, string>} files */
const gate = (files) => runGate({
  contractKind: 'dataset-scoping-package',
  files: new Map(Object.entries({
    ...Object.fromEntries(OUTPUTS.map((path) => [path, path.endsWith('.json') ? '{}' : `# ${path}\n\n正文。\n`])),
    'scoping-run.json': JSON.stringify({ jobId: 'job_1', status: 'succeeded', artifacts: [] }),
    ...files,
  })),
  expectedOutputs: OUTPUTS.map((path) => ({ path, required: true })),
})

/** @param {Record<string, string>} files @param {string[]} prose */
const findings = (files, prose) => datasetScopingFindings({ files: new Map(Object.entries(files)) }, prose)

test('a number the snapshot holds is verified, at the precision the prose wrote it', () => {
  const found = findings({
    'data-profile.json': JSON.stringify(PROFILE),
    'data-quality.md': '# 数据质量\n\n共 4820 行、37 列。年龄均值 63.7 岁（标准差 11.2）。\n',
  }, ['data-quality.md'])
  assert.deepEqual(found.issues, [])
  assert.equal(found.metrics.datasetNumbersVerified, 4)
  assert.equal(found.metrics.datasetNumberProvenance, 'verified')
})

test('a percentage in the prose matches the proportion in the snapshot', () => {
  // A profiler writes 0.1834 and a report writes 18.3%. They are one fact, and
  // only one of the two spellings would survive a check that did not know it.
  const found = findings({
    'data-profile.json': JSON.stringify(PROFILE),
    'data-quality.md': '# 数据质量\n\neGFR 缺失 18.3%，HbA1c 缺失 4.2%。\n',
  }, ['data-quality.md'])
  assert.deepEqual(found.issues, [])
  assert.equal(found.metrics.datasetNumbersVerified, 2)
})

test('a near miss is reported as mismatched, not as unsupported', () => {
  // 4830 against a snapshot of 4820: the shape a stale number leaves. Telling
  // the run "no source" would send it looking for one that is already there.
  const found = findings({
    'data-profile.json': JSON.stringify(PROFILE),
    'data-quality.md': '# 数据质量\n\n共纳入 4830 行。\n',
  }, ['data-quality.md'])
  assert.deepEqual(found.issues.map((issue) => issue.code), ['dataset_number_mismatched'])
  assert.equal(found.issues[0].severity, 'advisory')
  assert.equal(found.issues[0].check, 'dataset-number-provenance')
  assert.match(found.issues[0].message, /4830/)
  assert.equal(found.metrics.datasetNumbersMismatched, 1)
  assert.equal(found.metrics.datasetNumbersUnsupported, 0)
})

test('a number with nothing near it in the snapshot is unsupported', () => {
  const found = findings({
    'data-profile.json': JSON.stringify(PROFILE),
    'research-portfolio.md': '# 选题\n\n预计可入组 91400 例。\n',
  }, ['research-portfolio.md'])
  assert.deepEqual(found.issues.map((issue) => issue.code), ['dataset_number_unsupported'])
  assert.match(found.issues[0].message, /91400/)
  assert.equal(found.metrics.datasetNumbersUnsupported, 1)
})

test('an unreadable snapshot makes every number unverifiable, and says so once', () => {
  const found = findings({
    'data-profile.json': '{ "rows": 4820,',
    'data-quality.md': '# 数据质量\n\n共 9999 行、888 列。\n',
  }, ['data-quality.md'])
  assert.deepEqual(found.issues.map((issue) => issue.code), ['dataset_profile_unparseable'])
  assert.equal(found.metrics.datasetNumberProvenance, 'unverifiable')
})

test('an absent snapshot is not reported twice', () => {
  // The manifest's required-output pass is what blocks on a missing file.
  const found = findings({ 'data-quality.md': '# 数据质量\n\n共 9999 行。\n' }, ['data-quality.md'])
  assert.deepEqual(found.issues, [])
  assert.equal(found.metrics.datasetNumberProvenance, 'unverifiable')
})

test('numerals that are not quantities are not numbers', () => {
  const found = findings({
    'data-profile.json': JSON.stringify(PROFILE),
    'study-protocol.md': [
      '# 方案',
      '',
      '1. 第一步。',
      '2. 第二步。',
      '',
      '数据截止 2026-09-15，随访自 2019 年起。',
      '',
      '```bash',
      'python profile_dataset.py --rows 123456',
      '```',
      '',
    ].join('\n'),
  }, ['study-protocol.md'])
  assert.deepEqual(found.issues, [])
  assert.equal(found.metrics.datasetNumbersUnsupported, 0)
})

test('the finding is advisory: a package with unsupported numbers is still delivered', () => {
  const verdict = gate({
    'data-profile.json': JSON.stringify(PROFILE),
    'data-quality.md': '# 数据质量\n\n共 91400 行。\n',
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.errorCode, null)
  assert.ok(verdict.issues.some((/** @type {any} */ entry) => entry.code === 'dataset_number_unsupported'))
  assert.equal(verdict.metrics.datasetNumbersUnsupported, 1)
})
