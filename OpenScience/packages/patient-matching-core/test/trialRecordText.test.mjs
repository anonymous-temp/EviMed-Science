import test from 'node:test'
import assert from 'node:assert/strict'
import { trialRecordText } from '../index.mjs'

const eligibility = 'Inclusion Criteria:\n- ' + 'adult with measurable disease. '.repeat(200) + '\nExclusion Criteria:\n- prior therapy'
const base = { title: 'T', conditions: ['A'], interventions: ['Drug X', 'Drug Y'], sex: 'ALL', minimumAge: '18 Years', eligibility }

test('under the limit the text is exactly the benchmark layout', () => {
  const out = trialRecordText({ ...base, summary: 'Short.' })
  assert.equal(out, ['Title: T', 'Target conditions: A', 'Interventions: Drug X; Drug Y', 'Brief summary: Short.', 'The registry says the trial takes: sex ALL; minimum age 18 Years', `Eligibility Criteria (raw):\n${eligibility}`].join('\n'))
})

test('over the limit the summary is shortened first and the eligibility criteria stay whole', () => {
  const out = trialRecordText({ ...base, summary: 'S'.repeat(30000) })
  assert.ok(out.length <= 24000)
  assert.ok(out.endsWith(eligibility))
  assert.match(out, /Interventions: Drug X; Drug Y/)
})

test('interventions are shortened after the summary is gone, and an eligibility longer than the limit is cut as before', () => {
  const out = trialRecordText({ ...base, summary: 'S'.repeat(500), interventions: ['I'.repeat(900)] }, { limit: eligibility.length + 300 })
  assert.ok(out.endsWith(eligibility) && out.length <= eligibility.length + 300)
  const huge = trialRecordText({ ...base, summary: 'x' }, { limit: 100 })
  assert.equal(huge.length, 100)
})
