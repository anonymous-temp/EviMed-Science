import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_CODE_GENRES,
  FRONTIER_GENRES,
  FRONTIER_GENRE_LABELS_ZH,
  FRONTIER_INDUSTRY_KIND_LABELS_ZH,
  FRONTIER_INDUSTRY_KINDS,
  frontierGenreDecision,
  frontierGenreFallback,
  frontierIndustryKindDecision,
  frontierItemIndustryKind,
  isFrontierGenre,
  isFrontierIndustryKind,
} from '../src/frontierGenres.mjs'

test('every genre has a Chinese label and the code genres are genres', () => {
  for (const genre of FRONTIER_GENRES) assert.ok(FRONTIER_GENRE_LABELS_ZH[genre], genre)
  assert.deepEqual(Object.keys(FRONTIER_GENRE_LABELS_ZH).sort(), [...FRONTIER_GENRES].sort())
  for (const genre of FRONTIER_CODE_GENRES) assert.ok(isFrontierGenre(genre), genre)
})

test('the fallback reads what the registry, identifiers and flags already say', () => {
  const cases = /** @type {const} */ ([
    [{ flags: ['digest'], source_type: 'media' }, 'roundup'],
    [{ safety_alert: true, source_type: 'regulator' }, 'safety'],
    [{ evidence_type: 'safety-notice', source_type: 'journal' }, 'safety'],
    [{ platform: 'x', source_type: 'journal', evidence_type: 'rct' }, 'social'],
    [{ channel: 'registry', source_type: 'regulator' }, 'trial'],
    [{ source_type: 'preprint' }, 'preprint'],
    [{ source_type: 'journal', flags: ['preprint'] }, 'preprint'],
    [{ source_type: 'evidence-body', evidence_type: 'guideline' }, 'guideline'],
    [{ source_type: 'regulator', evidence_type: 'regulatory-decision' }, 'approval'],
    [{ source_type: 'regulator', evidence_type: 'other', lane: 'regulatory' }, 'policy'],
    [{ source_type: 'evidence-body', evidence_type: 'systematic-review' }, 'paper'],
    [{ source_type: 'company', evidence_type: 'press-release' }, 'industry'],
    [{ source_type: 'media', lane: 'pipeline' }, 'industry'],
    [{ platform: 'wechat', source_type: 'media', lane: 'evidence' }, 'commentary'],
    [{ source_type: 'journal', evidence_type: 'rct' }, 'paper'],
    [{ source_type: 'media', lane: 'public-health' }, 'news'],
    [null, 'news'],
  ])
  for (const [item, genre] of cases) assert.equal(frontierGenreFallback(item), genre, JSON.stringify(item))
})

test('the camelCase shape the service serves reads the same', () => {
  assert.equal(frontierGenreFallback({ sourceType: 'preprint' }), 'preprint')
  assert.equal(frontierGenreFallback({ safetyAlert: true }), 'safety')
  assert.equal(frontierGenreFallback({ evidenceType: 'regulatory-decision' }), 'approval')
})

test('the model refines a genre code is unsure of, never one it is sure of', () => {
  assert.deepEqual(frontierGenreDecision({ platform: 'wechat', source_type: 'media' }, 'conference'), { genre: 'conference', basis: 'model' })
  assert.deepEqual(frontierGenreDecision({ source_type: 'media' }, 'industry'), { genre: 'industry', basis: 'model' })
  assert.deepEqual(frontierGenreDecision({ platform: 'x' }, 'paper'), { genre: 'social', basis: 'code' })
  assert.deepEqual(frontierGenreDecision({ safety_alert: true }, 'approval'), { genre: 'safety', basis: 'code' })
  assert.deepEqual(frontierGenreDecision({ source_type: 'media' }, 'safety'), { genre: 'news', basis: 'code' })
  assert.deepEqual(frontierGenreDecision({ source_type: 'media' }, 'nonsense'), { genre: 'news', basis: 'code' })
})

test('the kinds of 行业动态 are a closed list, each with its Chinese label', () => {
  assert.deepEqual([...FRONTIER_INDUSTRY_KINDS], ['deal', 'financing', 'people', 'operations', 'pipeline', 'other'])
  assert.deepEqual(Object.keys(FRONTIER_INDUSTRY_KIND_LABELS_ZH).sort(), [...FRONTIER_INDUSTRY_KINDS].sort())
  assert.deepEqual(FRONTIER_INDUSTRY_KINDS.map((kind) => FRONTIER_INDUSTRY_KIND_LABELS_ZH[kind]),
    ['交易与授权', '融资与上市', '人事与组织', '公司经营', '研发管线', '其他'])
  for (const kind of FRONTIER_INDUSTRY_KINDS) assert.ok(isFrontierIndustryKind(kind), kind)
  // The labels are not the keys, a nearby word is not a kind, and a non-string is none.
  for (const word of ['交易与授权', 'Deal', 'merger', 'industry', '', ' deal', null, undefined, 3, ['deal']]) assert.equal(isFrontierIndustryKind(word), false, String(word))
})

test('a kind is the model\'s answer for an item of 行业动态 and nothing else; an unknown word is dropped, never guessed', () => {
  assert.equal(frontierIndustryKindDecision('industry', 'financing'), 'financing')
  assert.equal(frontierIndustryKindDecision('industry', 'other'), 'other')
  assert.equal(frontierIndustryKindDecision('industry', 'merger'), null)
  assert.equal(frontierIndustryKindDecision('industry', '融资与上市'), null)
  assert.equal(frontierIndustryKindDecision('industry', null), null)
  assert.equal(frontierIndustryKindDecision('industry', undefined), null)
  // A kind belongs to the genre: any other genre has none, whatever was said.
  for (const genre of FRONTIER_GENRES.filter((entry) => entry !== 'industry')) assert.equal(frontierIndustryKindDecision(genre, 'deal'), null, genre)
  assert.equal(frontierIndustryKindDecision(null, 'deal'), null)
})

test('the one reading rule hides a kind written before the genre changed', () => {
  assert.equal(frontierItemIndustryKind({ genre: 'industry', industry_kind: 'people' }), 'people')
  assert.equal(frontierItemIndustryKind({ genre: 'industry', industryKind: 'pipeline' }), 'pipeline')
  assert.equal(frontierItemIndustryKind({ genre: 'paper', industry_kind: 'people' }), null)
  assert.equal(frontierItemIndustryKind({ genre: null, industry_kind: 'people' }), null)
  assert.equal(frontierItemIndustryKind({ genre: 'industry', industry_kind: 'nonsense' }), null)
  assert.equal(frontierItemIndustryKind({ genre: 'industry' }), null)
  assert.equal(frontierItemIndustryKind(null), null)
})
