// Plan R33 linked to the claim words (stream A4): the sentence of an individualized forecast follows the frozen evaluation, per method and endpoint
// family, and never reaches an endpoint or a method the evaluation did not cover.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { VCR_INDIVIDUALIZATION_METHODS, predictionClaimOf, predictionClaimPremise, vcrIndividualEvaluationFamily, vcrIndividualizationHelped } from '../index.mjs'
import evaluation from '../src/vcr-individual-evaluation.json' with { type: 'json' }

const RECORD = new URL('../../../evals/vcr-in-silico/individual/result-20261109.json', import.meta.url)
const premise = (/** @type {string} */ method, /** @type {string} */ code) => /** @type {any} */ (predictionClaimPremise(predictionClaimOf({ real: true, usesOwnHistory: true }),
  { helped: vcrIndividualizationHelped({ method, endpointCode: code }), family: vcrIndividualEvaluationFamily(method, code) })).value

test('the data the runtime reads is the finding of the frozen record, dataset by dataset', { skip: !fs.existsSync(RECORD) && 'the evaluation directory is not in this tree' }, () => {
  const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'))
  assert.equal(record.sourceCommit, evaluation.sourceCommit)
  assert.equal(record.protocolSha256, evaluation.protocolSha256)
  const found = Object.fromEntries(record.datasets.map((/** @type {any} */ d) => [d.dataset, d.claim.individualizationHelps]))
  assert.deepEqual(found, { pbcseq: false, aids: true, actg175: true })
  assert.deepEqual(Object.fromEntries(Object.entries(evaluation.datasets).map(([name, d]) => [name, d.helped])), found)
  // every dataset the table assigns to a family is one the record ran
  for (const method of Object.values(evaluation.methods)) for (const family of Object.values(method.endpointFamilies)) for (const name of family.datasets) assert.ok(name in found, name)
})

test('the finding follows the endpoint family: bilirubin did not help, CD4 helped, anything else was not compared', () => {
  assert.deepEqual([...VCR_INDIVIDUALIZATION_METHODS], ['lmm_empirical_bayes'])
  const lmm = 'lmm_empirical_bayes'
  assert.equal(vcrIndividualizationHelped({ method: lmm, endpointCode: 'Bilirubin' }), false, 'codes are matched lower-cased, as written')
  assert.equal(vcrIndividualizationHelped({ method: lmm, endpointCode: ' 24467-3 ' }), true)
  assert.equal(vcrIndividualizationHelped({ method: lmm, endpointCode: 'hba1c' }), null, 'an endpoint nobody evaluated has no finding')
  assert.equal(vcrIndividualizationHelped({ method: lmm, endpointCode: 'bilirubin_x' }), null, 'nothing fuzzy')
  assert.equal(vcrIndividualizationHelped({ method: 'some_cloud_model', endpointCode: 'cd4' }), null, 'another method inherits nothing')
  assert.equal(vcrIndividualizationHelped({ method: 'beta_logit_laplace', endpointCode: 'adas_cog' }), null, 'the Alzheimer posterior was checked by simulation only')
  assert.equal(vcrIndividualizationHelped({}), null)
})

test('the claim sentence says what the protocol allows for the endpoint at hand, and names the endpoint the finding is about', () => {
  const bilirubin = premise('lmm_empirical_bayes', 'bilirubin')
  assert.ok(bilirubin.includes('血清胆红素') && bilirubin.includes('没有显示比') && !bilirubin.includes('小于'), bilirubin)
  const cd4 = premise('lmm_empirical_bayes', 'cd4')
  assert.ok(cd4.includes('CD4 计数') && cd4.includes('95% 区间不含 0') && cd4.includes('小于沿用最近一次观测值'), cd4)
  for (const none of [premise('lmm_empirical_bayes', 'hba1c'), premise('another_model', 'cd4')]) {
    assert.ok(none.includes('没有做过') && none.includes('不说它比简单做法更准'), none)
    assert.ok(!none.includes('95% 区间不含 0') && !none.includes('血清胆红素') && !none.includes('CD4'), 'never a finding about another endpoint')
  }
  for (const text of [bilirubin, cd4]) assert.ok(!/[「」]/.test(text) && !/LOCF|EB\b|MAP|nlme|job|tool|hash/i.test(text), text)
})
