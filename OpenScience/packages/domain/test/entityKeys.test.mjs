import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENTITY_TEXT_KINDS,
  identifierKeys,
  identifierKeysInText,
  isEntityKey,
  isIdentifierKey,
  keyKind,
  overlap,
  splitKeys,
} from '../src/entityKeys.mjs'

test('identifier keys are the frontier spelling: lower-case DOI, bare PMID, upper-case registry id', () => {
  assert.deepEqual(identifierKeys({ doi: 'https://doi.org/10.1056/NEJMoa2307563', pmid: '37952131', registryIds: ['nct03574597'] }),
    ['doi:10.1056/nejmoa2307563', 'pmid:37952131', 'reg:NCT03574597'])
  // The same work in any spelling is one key, and the order is fixed: DOIs, PMIDs, registry numbers, each sorted.
  assert.deepEqual(identifierKeys({ doi: ['DOI: 10.1000/b', '10.1000/A.'], pmid: ['PMID: 22', '11', '22'], registryIds: ['NCT02', ' NCT01 ', 'nct01'] }),
    ['doi:10.1000/a', 'doi:10.1000/b', 'pmid:11', 'pmid:22', 'reg:NCT01', 'reg:NCT02'])
})

test('a value that is not an identifier of its kind is dropped, not repaired', () => {
  assert.deepEqual(identifierKeys({ doi: 'not a doi', pmid: 'abc', registryIds: ['', 'x', 'NCT 123', 'has:colon'] }), [])
  assert.deepEqual(identifierKeys(null), [])
  assert.deepEqual(identifierKeys({}), [])
  assert.deepEqual(identifierKeys({ registryIds: Array.from({ length: 30 }, (_, index) => `NCT${String(index).padStart(8, '0')}`) }).length, 20,
    'the contract allows twenty registry ids on one record')
})

test('identifiers are found in text by closed formats: DOI, PMID, NCT, ISRCTN, ChiCTR and EU CT numbers', () => {
  const keys = identifierKeysInText(
    'The trial (NCT03574597; ISRCTN12345678; ChiCTR-RCT-12002345; EU CT 2024-513060-26-00) was reported at https://doi.org/10.1056/NEJMoa2307563, PMID: 37952131.')
  assert.deepEqual(keys, [
    'doi:10.1056/nejmoa2307563', 'pmid:37952131',
    'reg:2024-513060-26-00', 'reg:CHICTR-RCT-12002345', 'reg:ISRCTN12345678', 'reg:NCT03574597',
  ])
  assert.deepEqual(identifierKeysInText('a date 2024-05-06 and a number 12345678 are not registry numbers'), [])
  assert.deepEqual(identifierKeysInText('x2024-513060-26-00 and NCT0357459 are neither'), [], 'a longer word holds none, and NCT takes eight digits')
  assert.deepEqual(identifierKeysInText(''), [])
  assert.deepEqual(identifierKeysInText(null), [])
})

test('a DOI with parentheses keeps them, a sentence full stop does not', () => {
  assert.deepEqual(identifierKeysInText('See 10.1016/S0140-6736(18)31880-4.'), ['doi:10.1016/s0140-6736(18)31880-4'])
})

test('keys are told apart by prefix; a string that is no key is neither', () => {
  assert.equal(keyKind('drug:semaglutide'), 'drug')
  assert.equal(keyKind('disease:long covid'), 'disease')
  assert.equal(keyKind('trial:select'), 'trial')
  assert.equal(keyKind('org:fda'), 'org')
  assert.equal(keyKind('doi:10.1000/a'), 'doi')
  assert.equal(keyKind('pmid:1'), 'pmid')
  assert.equal(keyKind('reg:NCT01'), 'reg')
  for (const bad of ['drug:', ':x', 'drugs:x', 'drug', 'method:meta-analysis', '', null, 42]) assert.equal(keyKind(bad), null, String(bad))
  assert.ok(isEntityKey('drug:x') && !isEntityKey('doi:10.1000/a'))
  assert.ok(isIdentifierKey('doi:10.1000/a') && !isIdentifierKey('drug:x'))
  assert.deepEqual([...ENTITY_TEXT_KINDS], ['drug', 'disease', 'trial'], 'organisations are not tagged out of text')
})

test('overlap keeps shared entities and shared identifiers apart, sorted, without repeats', () => {
  const left = ['drug:semaglutide', 'drug:metformin', 'doi:10.1000/a', 'pmid:1', 'reg:NCT01', 'trial:select', 'drug:semaglutide']
  const right = ['trial:select', 'doi:10.1000/a', 'drug:semaglutide', 'pmid:2', 'reg:NCT01', 'junk']
  assert.deepEqual(overlap(left, right), {
    entityKeys: ['drug:semaglutide', 'trial:select'],
    identifierKeys: ['doi:10.1000/a', 'reg:NCT01'],
  })
  assert.deepEqual(overlap(left, ['drug:tirzepatide']), { entityKeys: [], identifierKeys: [] })
  assert.deepEqual(overlap(null, undefined), { entityKeys: [], identifierKeys: [] })
  assert.deepEqual(splitKeys(['x', 'drug:a', 'pmid:1', 'drug:a']), { entityKeys: ['drug:a'], identifierKeys: ['pmid:1'] })
})
