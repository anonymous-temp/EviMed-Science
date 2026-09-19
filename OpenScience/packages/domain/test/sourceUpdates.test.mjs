// Retraction and correction notices, read off Crossref's own records
// (recorded 2026-09-19, fixtures/crossref/updates.json).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  SOURCE_UPDATE_KINDS,
  SOURCE_UPDATE_LABELS_ZH,
  SOURCE_UPDATE_WEIGHT,
  doiOf,
  sourceUpdatesFromCrossref,
} from '../index.mjs'

const recorded = JSON.parse(await readFile(new URL('./fixtures/crossref/updates.json', import.meta.url), 'utf8'))

test('a retracted paper carries its retraction first, then its correction, with who recorded each', () => {
  assert.deepEqual(sourceUpdatesFromCrossref(recorded.retracted), [
    { kind: 'retraction', noticeDoi: '10.1016/s0140-6736(10)60175-4', date: '2010-02-06', source: 'retraction-watch' },
    { kind: 'correction', noticeDoi: '10.1016/s0140-6736(04)15715-2', date: '2004-03-06', source: 'retraction-watch' },
  ])
})

test('the notice itself is not flagged as retracted: it is what updates, not what was updated', () => {
  assert.deepEqual(sourceUpdatesFromCrossref(recorded.notice), [])
})

test('a batch answer reads per work, and a work with no notices has none', () => {
  const byDoi = new Map(recorded.batch.map((/** @type {any} */ work) => [doiOf(work.DOI), sourceUpdatesFromCrossref(work)]))
  assert.equal(byDoi.get('10.1016/s0140-6736(97)11096-0')[0].kind, 'retraction')
  assert.deepEqual(byDoi.get('10.1056/nejmoa2204233'), [])
  assert.deepEqual(byDoi.get('10.1088/1361-6595/aaebdb').map((/** @type {any} */ update) => [update.kind, update.source]), [['correction', 'publisher']])
})

test('only the closed set of update types is shown, and one notice recorded twice is one notice', () => {
  const work = {
    'updated-by': [
      { DOI: '10.1234/erratum', type: 'erratum', source: 'publisher', updated: { 'date-parts': [[2021, 3]] } },
      { DOI: '10.1234/new', type: 'new_version', source: 'publisher' },
      { DOI: '10.1234/comment', type: 'comment', source: 'publisher' },
      { DOI: '10.1234/eoc', type: 'expression_of_concern', source: 'retraction-watch' },
      { DOI: '10.1234/eoc', type: 'expression_of_concern', source: 'publisher' },
      { DOI: 'not a doi', type: 'withdrawal', source: 'somebody' },
    ],
  }
  assert.deepEqual(sourceUpdatesFromCrossref(work), [
    { kind: 'withdrawal', noticeDoi: null, date: null, source: null },
    { kind: 'expression_of_concern', noticeDoi: '10.1234/eoc', date: null, source: 'publisher' },
    { kind: 'correction', noticeDoi: '10.1234/erratum', date: '2021-03-01', source: 'publisher' },
  ])
  assert.deepEqual(sourceUpdatesFromCrossref(null), [])
  assert.deepEqual(sourceUpdatesFromCrossref({ 'updated-by': 'x' }), [])
})

test('every kind has a Chinese label and a weight', () => {
  for (const kind of /** @type {ReadonlyArray<keyof typeof SOURCE_UPDATE_LABELS_ZH>} */ (SOURCE_UPDATE_KINDS)) {
    assert.ok(SOURCE_UPDATE_LABELS_ZH[kind], kind)
    assert.ok(['withdrawn', 'concern', 'corrected'].includes(SOURCE_UPDATE_WEIGHT[kind]), kind)
  }
})

test('a DOI is compared in one form', () => {
  assert.equal(doiOf('https://doi.org/10.1016/S0140-6736(97)11096-0.'), '10.1016/s0140-6736(97)11096-0')
  assert.equal(doiOf('doi: 10.1056/NEJMoa2204233'), '10.1056/nejmoa2204233')
  assert.equal(doiOf('PMID:12345'), null)
  assert.equal(doiOf(''), null)
})
