import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_MATCH_BATCH_LIMITS, acceptExtractedFacts, matchBatchStatement, matchBatchUnitKey, planMatchExtraction,
  priceUsage, validateMatchBatchScenario,
} from '../index.mjs'

/**
 * A roster big enough for every category to be shown: 40 people to read (25 fit in a batch of 25, 15 wait), 13 read before, 12 the
 * table decided against, 11 with no record. The statement is a model's to read, so a count under ten is not printed.
 * @param {{ toRead?: number, alreadyRead?: number, prefiltered?: number, noDocuments?: number }} [sizes]
 */
function crowd({ toRead = 40, alreadyRead = 13, prefiltered = 12, noDocuments = 11 } = {}) {
  const rows = []
  const done = new Set()
  for (let n = 0; n < toRead; n += 1) rows.push({ subjectKey: `R-${n}`, documents: [{ id: `r${n}`, chars: 1000 }] })
  for (let n = 0; n < alreadyRead; n += 1) { rows.push({ subjectKey: `A-${n}`, documents: [{ id: `a${n}`, chars: 1000 }] }); done.add(matchBatchUnitKey(`A-${n}`, `a${n}`)) }
  for (let n = 0; n < prefiltered; n += 1) rows.push({ subjectKey: `F-${n}`, documents: [{ id: `f${n}`, chars: 1000 }], decided: true })
  for (let n = 0; n < noDocuments; n += 1) rows.push({ subjectKey: `N-${n}`, documents: [] })
  return { roster: rows, done }
}

const roster = [
  { subjectKey: 'P-001', documents: [{ id: 'd1', chars: 4000 }, { id: 'd2', chars: 1000 }] },
  { subjectKey: 'P-002', documents: [{ id: 'd3', chars: 3000 }], decided: true },
  { subjectKey: 'P-003', documents: [] },
  { subjectKey: 'P-004', documents: [{ id: 'd4', chars: 2000 }] },
  { subjectKey: 'P-005', documents: [{ id: 'd5', chars: 500 }] },
]

test('D4: match_extract is a job kind of the matching step, run by the control plane under its own method', () => {
  assert.ok(VCR_JOB_KINDS.includes('match_extract'))
  assert.equal(VCR_JOB_METHODS.match_extract, 'matching.extract')
  assert.ok(VCR_JOB_KINDS.indexOf('match_extract') > VCR_JOB_KINDS.indexOf('population_check'))
  assert.ok(VCR_JOB_KINDS.indexOf('match_extract') < VCR_JOB_KINDS.indexOf('forecast_trajectories'), 'the forecast kinds stay last')
})

test('D4: the plan reads who has records and has not been read, and names why each other person is not', () => {
  const done = new Set([matchBatchUnitKey('P-004', 'd4')])
  const plan = planMatchExtraction({ roster, done, limit: 10 })
  assert.deepEqual(plan.toRead.map((entry) => entry.subjectKey), ['P-001', 'P-005'])
  assert.deepEqual(plan.prefiltered, ['P-002'])
  assert.deepEqual(plan.noDocuments, ['P-003'])
  assert.deepEqual(plan.alreadyRead, ['P-004'])
  assert.equal(plan.bounded, null)
  // a person with one of two records read is read for the other, and only that
  const partial = planMatchExtraction({ roster, done: new Set([matchBatchUnitKey('P-001', 'd1')]), limit: 10 })
  assert.deepEqual(partial.toRead[0], { subjectKey: 'P-001', documents: [{ id: 'd2', chars: 1000 }] })
  // the prefilter can be switched off: everyone with a record is read
  const everyone = planMatchExtraction({ roster, limit: 10, prefilter: false })
  assert.deepEqual(everyone.toRead.map((entry) => entry.subjectKey), ['P-001', 'P-002', 'P-004', 'P-005'])
  assert.deepEqual(everyone.prefiltered, [])
})

test('D4: the size of a batch is bounded and the rest is said, in roster order', () => {
  const plan = planMatchExtraction({ roster, limit: 2 })
  assert.deepEqual(plan.toRead.map((entry) => entry.subjectKey), ['P-001', 'P-004'])
  assert.deepEqual(plan.deferred, ['P-005'])
  assert.deepEqual(plan.bounded, { limit: 2, deferred: 1 })
  const large = planMatchExtraction({ ...crowd(), limit: 25 })
  assert.deepEqual(large.bounded, { limit: 25, deferred: 15 })
  assert.match(matchBatchStatement(large), /一批最多读 25 位，还有 15 位这次没排进来/)
  // a configured bound above the hard ceiling is cut to it
  const wide = planMatchExtraction({ roster, limit: 10 ** 9 })
  assert.equal(wide.bounded, null)
  assert.ok(VCR_MATCH_BATCH_LIMITS.subjects >= wide.toRead.length)
  assert.equal(planMatchExtraction({ roster: [roster[0], roster[0]], limit: 5 }).toRead.length, 1, 'a person listed twice is read once')
})

test('D4: the estimate is a ceiling from the characters and the per-record overhead, priced by the reference list', () => {
  const plan = planMatchExtraction({ roster: roster.slice(0, 1), limit: 5 })
  const records = 2
  const inputTokens = 4000 + 1000 + records * VCR_MATCH_BATCH_LIMITS.overheadTokens
  const outputTokens = records * VCR_MATCH_BATCH_LIMITS.outputTokens
  assert.deepEqual({ people: plan.estimate.people, records: plan.estimate.records, inputTokens: plan.estimate.inputTokens, outputTokens: plan.estimate.outputTokens },
    { people: 1, records, inputTokens, outputTokens })
  const price = priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheHit: 0, cacheMiss: inputTokens, output: outputTokens, peak: true })
  assert.equal(plan.estimate.cost, price.cost)
  assert.equal(plan.estimate.basis, 'ceiling')
  // a record longer than the per-record cap is counted at the cap
  const long = planMatchExtraction({ roster: [{ subjectKey: 'P-9', documents: [{ id: 'x', chars: 10 ** 7 }] }], limit: 1 })
  assert.equal(long.estimate.characters, VCR_MATCH_BATCH_LIMITS.documentChars)
  // an unpriced model is said as "not priced", never as zero
  const unpriced = planMatchExtraction({ roster: roster.slice(0, 1), limit: 1, model: 'no-such-model' })
  assert.equal(unpriced.estimate.cost, null)
  assert.match(matchBatchStatement(unpriced), /费用按当前价格表算不出/)
})

test('D4: the statement says the cost before the work, that nothing needs confirming, and how stopping and starting again behave', () => {
  const plan = planMatchExtraction({ ...crowd(), limit: 100 })
  const text = matchBatchStatement(plan)
  assert.match(text, /这一批要读 40 位病人的 40 份病历/)
  assert.match(text, /最多约 \d+\.\d\d 元/)
  assert.match(text, /13 位读过的不会重读/)
  assert.match(text, /12 位按表格里已知的信息已确定不符合，病历不读（仍会评估）/)
  assert.match(text, /11 位没有病历文档/)
  assert.doesNotMatch(text, /不显示具体人数/, 'every category is shown')
  assert.match(text, /不用确认/)
  assert.match(text, /取消，读完的保留；再启动同样的选择会接着读没读过的/)
  // a batch with nothing to read says so and points at the evaluation
  const empty = matchBatchStatement(planMatchExtraction({ roster: roster.slice(2, 3), limit: 10 }))
  assert.match(empty, /没有要读的病历/)
  assert.match(empty, /逐条评估/)
})

test('P0-2: the statement is a model\'s to read, so a head count under ten is not printed in it, in any form', () => {
  // The five-person roster of the tests above: nobody is shown a count, a category with nobody in it is not told apart from a small one.
  const small = planMatchExtraction({ roster, done: new Set([matchBatchUnitKey('P-004', 'd4')]), limit: 10 })
  const text = matchBatchStatement(small)
  assert.match(text, /这一批要读的病历（人数不显示）/)
  assert.match(text, /人数少的类别按小样本规则不显示具体人数/)
  assert.doesNotMatch(text, /\d+ 位|\d+ 份/, 'no head count of people or records survives')
  assert.doesNotMatch(text, /位读过的|位按表格|位没有病历文档/, 'and no category is described: its count would be what it says')
  assert.match(text, /最多约 \d+\.\d\d 元/, 'what the work costs is not a head count')
  // Only the small cell is hidden when the rest are large: the prefiltered 3 of a roster of 63 stay out of the sentence, the rest are said.
  const mixed = matchBatchStatement(planMatchExtraction({ ...crowd({ prefiltered: 3 }), limit: 100 }))
  assert.match(mixed, /这一批要读 40 位病人的 40 份病历/)
  assert.match(mixed, /13 位读过的不会重读/)
  assert.doesNotMatch(mixed, /已确定不符合/, 'a hidden cell is not described')
  assert.match(mixed, /不显示具体人数/)
  assert.doesNotMatch(mixed, /\b3 位/, 'three people are not three numbers')
  const other = matchBatchStatement(planMatchExtraction({ ...crowd({ prefiltered: 3, noDocuments: 40 }), limit: 100 }))
  assert.doesNotMatch(other, /已确定不符合/)
  assert.match(other, /40 位没有病历文档/, 'a category over the floor is still said')
  // Nothing to read, and nothing shown: the sentence still points at the evaluation and prints no count.
  const nothing = matchBatchStatement(planMatchExtraction({ roster: roster.slice(1, 3), limit: 10 }))
  assert.match(nothing, /没有要读的病历/)
  assert.doesNotMatch(nothing, /\d+ 位/)
  // The floor is a parameter: a deployment that raises it hides more, and the sentence follows.
  assert.doesNotMatch(matchBatchStatement(planMatchExtraction({ ...crowd(), limit: 100 }), { minCell: 20 }), /1[123] 位/)
})

test('D4: the scenario is the platform\'s frozen roster and nothing a caller invents', () => {
  const good = { protocolVersionId: 'pv_1', asOf: '2026-11-01T00:00:00.000Z', subjects: ['P-001'], variables: ['age', 'ecog'], estimate: { people: 1 }, chain: 'c1', prefilter: true }
  assert.deepEqual(validateMatchBatchScenario('matching.extract', good), [])
  const codes = (/** @type {any} */ scenario) => validateMatchBatchScenario('matching.extract', scenario).map((issue) => `${issue.code}@${issue.field}`)
  assert.deepEqual(codes({ ...good, text: 'a record' }), ['scenario_field_unknown@scenario.text'])
  assert.deepEqual(codes({ ...good, subjects: [] }), ['scenario_field_invalid@scenario.subjects'])
  assert.deepEqual(codes({ ...good, variables: ['Age'] }), ['scenario_field_invalid@scenario.variables'])
  assert.deepEqual(codes({ protocolVersionId: 'pv_1' }), ['asOf', 'subjects', 'variables', 'estimate'].map((key) => `scenario_field_required@scenario.${key}`))
  assert.deepEqual(validateMatchBatchScenario('matching.nothing', good).map((issue) => issue.code), ['method_unknown'])
})

test('D4: what the extractor proposes is held to the criteria\'s own variables before anything is written', () => {
  const variables = new Set(['age', 'ecog', 'pregnant'])
  const { facts, dropped } = acceptExtractedFacts({ facts: [
    { variable: 'age', value: 63, unit: 'year', surface: '63岁', quote: '患者 63岁，女性', occurredAt: '2026-03-02', dateSurface: '2026-03-02' },
    { variable: 'ecog', polarity: 'affirmed', value: '1', surface: 'ECOG 1', quote: 'ECOG 1 分' },
    { variable: 'creatinine', surface: 'Cr', quote: 'Cr 80' },
    { variable: 'pregnant', polarity: 'maybe', surface: '妊娠', quote: '否认妊娠' },
    { variable: 'pregnant', polarity: 'negated', surface: '妊娠', quote: '' },
    { variable: 'pregnant', polarity: 'negated', surface: '妊娠', quote: '否认妊娠' },
    { variable: 'ecog', surface: 'not in quote', quote: 'ECOG 1 分' },
  ] }, variables)
  assert.deepEqual(facts.map((fact) => fact.variable), ['age', 'ecog', 'pregnant'])
  assert.equal(facts[0].value, 63)
  assert.equal(facts[1].value, '1')
  assert.equal(facts[2].polarity, 'negated')
  assert.deepEqual(dropped, { variable_not_asked: 1, polarity_invalid: 1, quote_missing: 2 })
  assert.deepEqual(acceptExtractedFacts('not json', variables), { facts: [], dropped: {} })
})

test('D4: a second quotation for a fact\'s date is kept as the model wrote it, and only when it is a line', () => {
  const variables = new Set(['aspirin'])
  const base = { variable: 'aspirin', surface: 'aspirin', quote: 'Takes aspirin daily.' }
  const { facts } = acceptExtractedFacts({ facts: [
    { ...base, occurredAt: '2100-03-01', dateSurface: '2100-03-01', dateQuote: 'Record date: 2100-03-01' },
    { ...base, dateQuote: '   ' },
    { ...base, dateQuote: 'x'.repeat(201) },
    { ...base, dateQuote: 42 },
  ] }, variables)
  assert.equal(facts.length, 4, 'a bad date quotation costs the date, never the fact')
  assert.equal(facts[0].dateQuote, 'Record date: 2100-03-01')
  assert.deepEqual(facts.slice(1).map((fact) => 'dateQuote' in fact), [false, false, false])
})
