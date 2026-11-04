// Definition cards of a trial's eligibility clauses: the call that writes them, the reading of its answer, and the lines a clause-level call carries.
// Nothing here calls a model.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  VCR_DEFINITION_PROMPT_VERSION, criteriaMessages, definitionLines, definitionMessages, parseDefinitionsAnswer, segmentCriteria, segmentSentences,
} from '../index.mjs'

const ELIGIBILITY = 'Inclusion Criteria:\n* Adequate organ function\n* Prior platinum-based chemotherapy\nExclusion Criteria:\n* Active infection'
const clauses = segmentCriteria(ELIGIBILITY)
const sentences = segmentSentences('Male, 70. Stage IV NSCLC. Creatinine 90 umol/L.')

test('the card call carries the trial, the numbered clauses and, where one was retrieved, a guideline passage by clause number', () => {
  const messages = definitionMessages({ title: 'Lung trial', summary: 'S', conditions: ['NSCLC'], interventions: ['Drug A'], clauses,
    passages: { 2: { source: 'NCCN NSCLC 2026', text: 'Platinum-based doublet is the usual first-line regimen.' }, 9: { text: 'for a clause the trial does not have' } } })
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user'])
  assert.match(messages[0].content, /definition card/)
  assert.match(messages[0].content, /Do not decide anything about any patient/)
  assert.match(messages[1].content, /Title: Lung trial\nTarget diseases: NSCLC\nInterventions: Drug A\nSummary: S/)
  assert.match(messages[1].content, /1\. Adequate organ function\n2\. Prior platinum-based chemotherapy\n3\. Active infection/)
  assert.match(messages[1].content, /Guideline passage for criterion 2 \(NCCN NSCLC 2026\): Platinum-based doublet/)
  assert.equal(/criterion 9/.test(messages[1].content), false, 'a passage for a clause the trial does not have is not carried')
  const none = definitionMessages({ title: 'T', clauses })
  assert.equal(/Guideline passage/.test(none[1].content), false)
})

test('the answer is read into cards for the clauses the trial has; anything else is dropped and counted, and nothing throws', () => {
  const answer = { 1: { counts: 'ECOG 0-1 and a creatinine clearance usually at least 50 mL/min', does_not_count: 'a single normal lab value' }, 2: { counts: 'cisplatin or carboplatin', does_not_count: 'a taxane alone', source: 'passage' },
    7: { counts: 'a clause that does not exist' }, 3: { counts: '', does_not_count: '' }, x: { counts: 'not a number' }, 4: 'not an object' }
  const parsed = parseDefinitionsAnswer(JSON.stringify(answer), clauses)
  assert.deepEqual(parsed.definitions.map((card) => [card.number, card.source]), [[1, 'knowledge'], [2, 'passage']])
  assert.equal(parsed.dropped, 4)
  assert.equal(parseDefinitionsAnswer('```json\n' + JSON.stringify({ 1: { counts: 'a' } }) + '\n```', clauses).definitions.length, 1, 'a fenced block is read')
  assert.equal(parseDefinitionsAnswer('Here it is: {"1": {"counts": "a", "does_not_count": "b"}} done', clauses).definitions[0].doesNotCount, 'b')
  for (const garbage of ['', 'no json', null, undefined, 12, [], '[1]']) assert.deepEqual(parseDefinitionsAnswer(garbage, clauses), { definitions: [], dropped: 0 })
  const long = parseDefinitionsAnswer({ 1: { counts: 'x'.repeat(2000), does_not_count: 'y' } }, clauses).definitions[0]
  assert.equal(long.counts.length, 400, 'a card is short')
})

test('a clause-level call carries the cards of its own clauses as background, and a call with no cards is exactly the call it was', () => {
  const base = { title: 'Lung trial', summary: 'S', criteria: clauses, sentences }
  const plain = criteriaMessages(base)
  assert.deepEqual(criteriaMessages({ ...base, definitions: [] }), plain, 'the field defaults to none')
  assert.deepEqual(criteriaMessages({ ...base, definitions: undefined }), plain)
  const cards = [{ number: 1, counts: 'ECOG 0-1', doesNotCount: 'one normal lab' }, { number: 3, counts: '', doesNotCount: 'a cold' }]
  const withCards = criteriaMessages({ ...base, definitions: cards })
  assert.equal(withCards[0].content, plain[0].content, 'the system prompt is the same, so the provider caches it')
  assert.match(withCards[1].content, /Background notes on some of the criteria above/)
  assert.match(withCards[1].content, /the patient note decides/)
  assert.match(withCards[1].content, /\n1\. Counts: ECOG 0-1 Does not count: one normal lab\n3\. Does not count: a cold\n\nPlain JSON output:$/)
  // A call that carries one side only gets the cards of that side.
  const inclusionOnly = criteriaMessages({ ...base, kind: 'inclusion', definitions: cards })
  assert.match(inclusionOnly[1].content, /\n1\. Counts: ECOG 0-1/)
  assert.equal(/3\. Does not count/.test(inclusionOnly[1].content), false)
  const exclusionOnly = criteriaMessages({ ...base, kind: 'exclusion', definitions: [cards[0]] })
  assert.deepEqual(exclusionOnly[1].content, criteriaMessages({ ...base, kind: 'exclusion' })[1].content, 'no card for these clauses, no block')
  assert.deepEqual(definitionLines([], new Set([1])), [])
  assert.equal(VCR_DEFINITION_PROMPT_VERSION, 'defs-1')
})
