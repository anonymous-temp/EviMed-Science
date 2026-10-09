import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceCitationProse, sourceCitationReferences, locateSourceQuotation, agendaResultKind } from '../index.mjs'

test('citation metadata stays off screen during streaming and in the preserved reply', () => {
  const marker = '<!-- evimed-source:{"sourceId":"src_' + 'a'.repeat(32) + '","quote":"The sentence."} -->'
  assert.equal(sourceCitationProse(`Visible. ${marker} More prose.`), 'Visible.  More prose.')
  assert.equal(sourceCitationProse('Visible. <!-- evimed-source:{"sourceId":'), 'Visible. ')
  assert.equal(sourceCitationProse('Visible. <!-- ordinary comment -->'), 'Visible. <!-- ordinary comment -->')
})

test('only bounded source references are read from answer comments', () => {
  const ref = { sourceId: `src_${'a'.repeat(32)}`, quote: 'The preserved sentence.' }
  const comment = `<!-- evimed-source:${JSON.stringify(ref)} -->`
  assert.deepEqual(sourceCitationReferences(`Answer. ${comment} ${comment}`), [ref])
  assert.deepEqual(sourceCitationReferences('<!-- evimed-source:{"sourceId":"../../other","quote":"Anything"} -->'), [])
  assert.deepEqual(sourceCitationReferences('<!-- evimed-source:{bad} -->'), [])
})

test('quotations share the report check and acquire offsets and pages only from a unique preserved passage', () => {
  const text = 'Introduction. The observed difference was 12%. End.'
  const quote = 'The observed difference was 12%.'
  const found = locateSourceQuotation({ text, quote, pageMap: [{ page: 7, start: 0, end: text.length }] })
  assert.deepEqual(found, { status: 'verified', start: 14, end: 46, page: 7 })
  assert.equal(text.slice(found.start, found.end), quote)
  assert.equal(locateSourceQuotation({ text, quote }).page, null)
  assert.deepEqual(locateSourceQuotation({ text: text + text, quote }), { status: 'verified', start: null, end: null, page: null })
  assert.equal(locateSourceQuotation({ text, quote: quote.replace('12%', '18%') }).status, 'quote_not_found')
  assert.equal(locateSourceQuotation({ text, quote, pageMap: [{ page: 1, start: 0, end: 30 }, { page: 2, start: 30, end: 50 }] }).page, null)
})

test('no new evidence cannot be inferred from a missing, malformed or failed result', () => {
  assert.equal(agendaResultKind({ status: 'succeeded', deltaSchemaVersion: 1, claims: [] }), 'no-new-evidence')
  assert.equal(agendaResultKind({ status: 'succeeded', deltaSchemaVersion: 1 }), 'result')
  assert.equal(agendaResultKind({ status: 'succeeded', deltaSchemaVersion: 1, claims: [], deltaErrorCode: 'unreadable' }), 'result')
  assert.equal(agendaResultKind({ status: 'failed', deltaSchemaVersion: 1, claims: [] }), 'failed')
})
