import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSourceText, sourceUnderstandingSchema, validateSourceUnderstanding } from '../src/sourceUnderstanding.mjs'

test('normalized complete text has contiguous exact UTF-16 units including content beyond snippets', () => {
  const text = '\uFEFFfirst\r\n' + 'long text '.repeat(1300) + '\rfinal 😀'
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text })
  assert.equal(input.units.map(unit => unit.text).join(''), input.text)
  assert.ok(input.text.endsWith('final 😀'))
  assert.equal(input.units.at(-1)?.end, input.text.length)
  assert.ok(input.units.every(unit => input.text.slice(unit.start, unit.end) === unit.text))
})

test('chunk boundaries preserve whole supplementary characters while offsets remain UTF-16', () => {
  for (const supplementary of ['😀', '𠀀']) {
    const text = 'a'.repeat(7999) + supplementary + 'b'
    const input = normalizeSourceText({ sourceId: 's', generation: 1, docType: 'note-memo', depth: 'structured', text })
    assert.equal(input.units[0].end, 7999)
    assert.equal(input.units[1].start, 7999)
    assert.equal(input.units[1].text, supplementary + 'b')
    assert.ok(input.units.every(unit => new TextDecoder().decode(new TextEncoder().encode(unit.text)) === unit.text))
    assert.equal(input.units.map(unit => unit.text).join(''), text)
  }
})

test('typed schemas share one validator; known slots need exact source evidence and unknown slots need reasons', () => {
  for (const docType of ['research-protocol', 'published-paper', 'note-memo']) {
    const input = normalizeSourceText({ sourceId: 's', generation: 2, docType, depth: 'structured', text: 'An anchored statement.' })
    /** @type {Record<string, any>} */
    const slots = Object.fromEntries(sourceUnderstandingSchema(docType).slots.map(key => [key, { state: 'unknown', reason: 'Not stated in the source.' }]))
    const output = { schemaVersion: 1, sourceId: 's', generation: 2, docType, depth: 'structured', summary: 'Source summary', slots, claims: [], methods: [], omissionAudit: { status: 'not_run', reason: 'Question audit has not run.', omissionRate: null } }
    assert.deepEqual(validateSourceUnderstanding(output, input), [])
    const key = sourceUnderstandingSchema(docType).slots[0]
    slots[key] = { state: 'known', value: 'Statement', evidence: [{ sourceId: 's', generation: 2, unitId: input.units[0].id, start: 0, end: 2, quote: 'An' }] }
    assert.deepEqual(validateSourceUnderstanding(output, input), [])
    slots[key].evidence[0].quote = 'No'
    assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('exact quote')))
    slots[key] = { state: 'unknown', reason: '' }
    assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('reason')))
  }
})

test('depth and source generation cannot be fabricated and absent audit never means zero omissions', () => {
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text: 'A note.' })
  const output = { schemaVersion: 1, sourceId: 's', generation: 3, docType: 'note-memo', depth: 'deep', summary: 'Note', slots: {}, claims: [], methods: [], omissionAudit: { status: 'not_run', omissionRate: 0 } }
  const issues = validateSourceUnderstanding(output, input)
  assert.ok(issues.some(issue => issue.includes('generation')))
  assert.ok(issues.some(issue => issue.includes('depth')))
  assert.ok(issues.some(issue => issue.includes('omission')))
})

test('Chinese output is bounded by UTF-8 bytes before canonical persistence', () => {
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text: '原文' })
  const evidence = [{ sourceId: 's', generation: 2, unitId: input.units[0].id, start: 0, end: 2, quote: '原文' }]
  const output = { schemaVersion: 1, sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', summary: '中'.repeat(8000),
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map(key => [key, { state: 'unknown', reason: '中'.repeat(2000) }])),
    claims: Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, statement: '中'.repeat(4000), evidence })), methods: [],
    omissionAudit: { status: 'not_run', reason: 'Not audited.', omissionRate: null } }
  assert.ok(JSON.stringify(output).length < 100000)
  assert.ok(new TextEncoder().encode(JSON.stringify(output)).byteLength > 262144)
  assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('UTF-8')))
})
