import assert from 'node:assert/strict'
import test from 'node:test'

import { BLANK_EXAMPLES, CAPABILITY_DISPLAY } from '../index.mjs'

const CJK = /[㐀-鿿]/
/** The words that would make a general example read as a medical one; a closed list, because this guards data, not language. */
const MEDICAL = /医学|临床|药|患者|病|循证|PubMed|研究/

test('the blank conversation offers four to six pills, general ones first and two medical ones last', () => {
  assert.ok(BLANK_EXAMPLES.length >= 4 && BLANK_EXAMPLES.length <= 6)
  const medical = BLANK_EXAMPLES.filter((example) => MEDICAL.test(`${example.label}${example.draft}`) || /SGLT2|他汀/.test(example.draft))
  assert.equal(medical.length, 2)
  assert.deepEqual(BLANK_EXAMPLES.slice(-2), medical, 'the medical pills come after the general ones')
  for (const example of BLANK_EXAMPLES) {
    assert.ok(CJK.test(example.label) && example.label.length <= 8, `${example.label} is short enough for a pill`)
    assert.ok(example.draft.length > example.label.length && example.draft.length <= 400)
  }
  assert.equal(new Set(BLANK_EXAMPLES.map((example) => example.label)).size, BLANK_EXAMPLES.length)
})

test('a medical pill is a starter prompt one of the capabilities offers, so it names something the platform does', () => {
  const offered = new Set(Object.values(CAPABILITY_DISPLAY).flatMap((display) => display.starterPrompts))
  for (const example of BLANK_EXAMPLES.slice(-2)) assert.ok(offered.has(example.draft), `${example.label} is not a capability's starter`)
})
