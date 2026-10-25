import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_PRACTICE_ELIGIBLE,
  FRONTIER_PRACTICE_LIMITS,
  FRONTIER_REPUBLISHERS,
  FRONTIER_SCORE_MAXIMA,
  FRONTIER_SCORE_TIERS,
  frontierAuthorityScore,
  frontierFloorEligible,
  frontierIsStreamSource,
  frontierMixSelect,
  frontierPracticeAdmissible,
  frontierPracticeAdmit,
  frontierPracticeCap,
  frontierPracticeReason,
  frontierRepublisher,
  frontierScoreCeilings,
  frontierScoreTier,
  frontierSourceDisplayName,
} from '../index.mjs'

const full = { authority: 18, impact: 30, novelty: 20, relevance: 20 }

test('a ceiling lowers a part the model gave and never raises one; what lowered it is named', () => {
  const trial = frontierScoreCeilings({ parts: full, genre: 'trial' })
  assert.deepEqual(trial.parts, { authority: 18, impact: 12, novelty: 20, relevance: 20 })
  assert.deepEqual(trial.reasons, ['genre:trial'])
  const low = { authority: 18, impact: 6, novelty: 4, relevance: 8 }
  assert.deepEqual(frontierScoreCeilings({ parts: low, genre: 'trial' }), { parts: low, reasons: [] }, 'under the ceiling: nothing changes, nothing is named')
  assert.deepEqual(frontierScoreCeilings({ parts: full, genre: 'roundup' }).parts, full, 'a roundup is the prompt\'s anchor, not a code ceiling: its genre is not code\'s alone')
})

test('the ceilings read the genre, a decided evidence type, a registry-class source and the study design', () => {
  assert.equal(frontierScoreCeilings({ parts: full, genre: 'trial' }).parts.impact, 12)
  assert.deepEqual(frontierScoreCeilings({ parts: full, genre: 'preprint', preprint: true }).parts, { authority: 18, impact: 18, novelty: 14, relevance: 20 })
  // A press release's impact is capped only when code decided the evidence type (a company's newsroom): the model's own guess is no ground.
  assert.equal(frontierScoreCeilings({ parts: full, evidenceType: 'press-release', evidenceFixed: true }).parts.impact, 18)
  assert.equal(frontierScoreCeilings({ parts: full, evidenceType: 'review-opinion', evidenceFixed: false }).parts.impact, 30, 'a model-guessed evidence type lowers nothing')
  assert.equal(frontierScoreCeilings({ parts: full, evidenceType: 'review-opinion', evidenceFixed: true }).parts.impact, 16)
  assert.equal(frontierScoreCeilings({ parts: full, sourceId: 'prepare-guideline-registry' }).parts.impact, 12)
  assert.equal(frontierScoreCeilings({ parts: full, sourceId: 'some-journal' }).parts.impact, 30)
})

test('study facts lower a part only when c3-faith has read them; without them the score is the model\'s', () => {
  const without = frontierScoreCeilings({ parts: full, genre: 'paper', evidenceType: 'rct', studyFacts: null })
  assert.deepEqual(without, { parts: full, reasons: [] })
  assert.equal(frontierScoreCeilings({ parts: full, genre: 'paper', studyFacts: { design: 'case-report', n: 1 } }).parts.impact, 8)
  assert.equal(frontierScoreCeilings({ parts: full, genre: 'paper', studyFacts: { design: 'animal', n: null } }).parts.impact, 10)
  const small = frontierScoreCeilings({ parts: full, genre: 'paper', studyFacts: { design: 'rct', n: 24 } })
  assert.equal(small.parts.impact, 16)
  assert.deepEqual(small.reasons, ['small-study'])
  assert.equal(frontierScoreCeilings({ parts: full, genre: 'paper', studyFacts: { design: 'rct', n: 2400 } }).parts.impact, 30, 'a large trial is the model\'s call')
  assert.equal(frontierScoreCeilings({ parts: full, genre: 'paper', studyFacts: { design: 'meta-analysis', n: 12 } }).parts.impact, 30, 'a design the table does not name lowers nothing')
})

test('a republisher\'s authority is capped, it takes no floor place, and its table is data', () => {
  const bdHub = 'discovered-29e04956f24c862b4024'
  assert.ok(FRONTIER_REPUBLISHERS[bdHub])
  assert.equal(frontierRepublisher(bdHub)?.name, 'BD HUB')
  assert.equal(frontierRepublisher('prnewswire-health'), null)
  assert.equal(frontierFloorEligible(bdHub), false)
  assert.equal(frontierFloorEligible('prnewswire-health'), true)
  assert.equal(frontierFloorEligible(undefined), true)
  const authority = frontierAuthorityScore({ authority: 3, evidenceType: 'press-release' })
  const capped = frontierScoreCeilings({ parts: { authority, impact: 20, novelty: 12, relevance: 14 }, sourceId: bdHub, authority: 3, evidenceType: 'press-release' })
  assert.equal(capped.parts.authority, frontierAuthorityScore({ authority: 1, evidenceType: 'press-release' }))
  assert.deepEqual(capped.reasons, ['republisher'])
})

test('every ceiling in the table is a whole number within its part\'s scale', async () => {
  const table = (await import('../src/frontier-selection.json', { with: { type: 'json' } })).default
  /** @type {Array<Record<string, any>>} */
  const rows = [...Object.values(table.ceilings.genre), ...Object.values(table.ceilings.evidenceType), ...Object.values(table.ceilings.sourceClass),
    ...Object.values(table.ceilings.design), table.ceilings.smallStudy]
  for (const row of rows) for (const part of /** @type {const} */ (['impact', 'novelty', 'relevance'])) {
    if (row[part] === undefined) continue
    assert.ok(Number.isInteger(row[part]) && row[part] >= 0 && row[part] <= FRONTIER_SCORE_MAXIMA[part], `${part} ${row[part]}`)
  }
})

test('the tiers: high from 76, medium from 60; a selected card (line 68) reads medium at least', () => {
  assert.deepEqual({ ...FRONTIER_SCORE_TIERS }, { high: 76, medium: 60 })
  assert.equal(frontierScoreTier(76), 'high')
  assert.equal(frontierScoreTier(75.9), 'medium')
  assert.equal(frontierScoreTier(60), 'medium')
  assert.equal(frontierScoreTier(59), 'low')
  assert.equal(frontierScoreTier('68'), 'medium')
  for (const nothing of [null, undefined, '', 'n/a']) assert.equal(frontierScoreTier(nothing), null)
})

test('the practice label is rare: at most three a day and 5 % of the day, one when anything qualifies', () => {
  assert.equal(FRONTIER_PRACTICE_LIMITS.perDay, 3)
  assert.equal(frontierPracticeCap(0), 1)
  assert.equal(frontierPracticeCap(20), 1)
  assert.equal(frontierPracticeCap(40), 2)
  assert.equal(frontierPracticeCap(60), 3)
  assert.equal(frontierPracticeCap(400), 3, 'never above the daily limit')
})

test('only a decision or a result from a source that can carry it is admissible', () => {
  const ok = { genre: 'approval', evidenceType: 'regulatory-decision', authority: 5, preprint: false, flags: [] }
  assert.equal(frontierPracticeAdmissible(ok), true)
  assert.equal(frontierPracticeAdmissible({ ...ok, genre: 'industry' }), false, 'a company\'s news is not a decision')
  assert.equal(frontierPracticeAdmissible({ ...ok, genre: 'social' }), false)
  assert.equal(frontierPracticeAdmissible({ ...ok, genre: 'paper', evidenceType: 'observational' }), false, 'observational work does not change practice by itself')
  assert.equal(frontierPracticeAdmissible({ ...ok, authority: 2 }), false)
  assert.equal(frontierPracticeAdmissible({ ...ok, preprint: true }), false)
  assert.equal(frontierPracticeAdmissible({ ...ok, flags: ['press-release'] }), false)
  assert.equal(frontierPracticeAdmissible({ ...ok, flags: ['retracted'] }), false)
  assert.ok(FRONTIER_PRACTICE_ELIGIBLE.genres.includes('paper') && !FRONTIER_PRACTICE_ELIGIBLE.genres.includes('preprint'))
})

test('the day\'s labels: the best scored proposals up to the cap; an admitted label stays and counts', () => {
  const c = (/** @type {string} */ id, /** @type {number} */ score, extra = {}) => ({ id, score, proposed: true, admissible: true, ...extra })
  assert.deepEqual(frontierPracticeAdmit([c('a', 80), c('b', 90), c('c', 70), c('d', 85)], { selectedCount: 60 }), { admit: ['b', 'd', 'a'], cap: 3 })
  assert.deepEqual(frontierPracticeAdmit([c('a', 80), c('b', 90)], { selectedCount: 20 }), { admit: ['b'], cap: 1 })
  assert.deepEqual(frontierPracticeAdmit([c('old', 60, { admitted: true }), c('a', 80), c('b', 90)], { selectedCount: 40 }), { admit: ['b'], cap: 2 }, 'the one admitted counts against the cap')
  assert.deepEqual(frontierPracticeAdmit([c('a', 80, { proposed: false }), c('b', 90, { admissible: false })], { selectedCount: 60 }).admit, [])
  assert.deepEqual(frontierPracticeAdmit([], { selectedCount: 0 }), { admit: [], cap: 1 })
})

test('the reason is one line within its limit, or nothing', () => {
  assert.equal(frontierPracticeReason('  国内首个获批  \n 用于HER2阳性患者 '), '国内首个获批 用于HER2阳性患者')
  assert.equal(frontierPracticeReason(''), null)
  assert.equal(frontierPracticeReason(null), null)
  assert.equal(frontierPracticeReason('长'.repeat(FRONTIER_PRACTICE_LIMITS.reasonChars + 1)), null)
  assert.equal(frontierPracticeReason('长'.repeat(FRONTIER_PRACTICE_LIMITS.reasonChars)), '长'.repeat(FRONTIER_PRACTICE_LIMITS.reasonChars))
})

// ───────────────────────── the mix ─────────────────────────

let serial = 0
const item = (/** @type {Record<string, any>} */ overrides = {}) => {
  serial += 1
  return { id: `s${serial}`, genre: 'paper', zh: false, score: 80, selected: false, rule: null, safety: false, sourceId: `src${serial}`, sourceCap: 3,
    eligible: true, summarized: true, besideSelected: false, eventId: null, ...overrides }
}

test('a republisher\'s item takes no place under the line, and the line itself still takes it', () => {
  const papers = Array.from({ length: 40 }, () => item({ score: 90 }))
  const under = item({ genre: 'industry', zh: true, score: 64, floorEligible: false })
  const ordinary = item({ genre: 'industry', zh: true, score: 64 })
  const above = item({ genre: 'industry', zh: true, score: 72, floorEligible: false })
  const result = frontierMixSelect({ candidates: [...papers, under, ordinary, above], threshold: 68 })
  const picked = new Set(result.picks.map((pick) => pick.id))
  assert.equal(picked.has(under.id), false, 'no floor, no Chinese margin')
  assert.equal(picked.has(ordinary.id), true)
  assert.equal(picked.has(above.id), true, 'above the line it is judged like any item')
})

test('a safety alert takes the place of an arithmetic pick of its own event, and of nothing else', () => {
  const alert = item({ genre: 'safety', safety: true, selected: true, rule: 'safety-bypass', eventId: 'e36', score: null })
  const earlier = item({ genre: 'safety', selected: true, rule: 'threshold', eventId: 'e36', score: 80 })
  const pinned = item({ genre: 'paper', selected: true, rule: 'operator-pin', eventId: 'e36', score: 80 })
  const other = item({ genre: 'paper', selected: true, rule: 'threshold', eventId: 'e9', score: 80 })
  const events = {
    e36: [alert, earlier, pinned].map((c) => ({ id: c.id, genre: c.genre, selected: true, rule: c.rule, safety: c.safety })),
    e9: [{ id: other.id, genre: 'paper', selected: true, rule: 'threshold', safety: false }],
  }
  const result = frontierMixSelect({ candidates: [alert, earlier, pinned, other], threshold: 68, events })
  assert.deepEqual(result.superseded, [{ id: earlier.id, by: alert.id, reason: 'safety-alert' }], 'a pin and an event without an alert are left alone')
  assert.deepEqual(frontierMixSelect({ candidates: [earlier], threshold: 68, events: { e36: events.e36.slice(1) } }).superseded, [])
})

// ───────────────────────── source names ─────────────────────────

test('an item of a stream is named for its journal; an item of any other source, and a stream\'s item without one, keep the institution', () => {
  const stream = { id: 'pubmed-rct-core-journals', name: 'PubMed 检索流 · 核心临床期刊 RCT', ownerEntity: 'U.S. National Library of Medicine', access: 'eutils-query' }
  assert.equal(frontierSourceDisplayName({ ...stream, journal: 'The lancet. Gastroenterology & hepatology' }), 'The lancet. Gastroenterology & hepatology')
  assert.equal(frontierSourceDisplayName({ ...stream, journal: '   ' }), 'PubMed')
  assert.equal(frontierSourceDisplayName(stream), 'PubMed')
  assert.equal(frontierSourceDisplayName({ id: 'openalex-medicine-newest', name: 'OpenAlex 医学最新', access: 'json-api', journal: 'Frontiers in immunology' }), 'Frontiers in immunology')
  assert.equal(frontierSourceDisplayName({ id: 'europepmc-medrxiv-preprints', name: 'x', access: 'europepmc', journal: 'medRxiv' }), 'medRxiv')
  assert.equal(frontierSourceDisplayName({ id: 'j-0140-6736', name: '柳叶刀', access: 'crossref-issn', journal: 'The Lancet' }), '柳叶刀', 'a journal\'s own feed is named by the registry')
  assert.equal(frontierSourceDisplayName({ id: 'fda-recalls', name: 'FDA', ownerEntity: 'U.S. Food and Drug Administration', journal: 'Anything' }), 'FDA')
  assert.equal([...frontierSourceDisplayName({ ...stream, journal: '长'.repeat(200) })].length, 80, 'a card has room for 80 characters of it')
  assert.equal(frontierIsStreamSource({ id: 'x', access: 'eutils-query' }), true)
  assert.equal(frontierIsStreamSource({ id: 'openalex-a' }), true)
  assert.equal(frontierIsStreamSource({ id: 'j-1', access: 'crossref-issn' }), false)
  assert.equal(frontierIsStreamSource(null), false)
})
