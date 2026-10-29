import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_CONGRESSES,
  FRONTIER_LEAD_FRESH_DAYS,
  FRONTIER_LEAD_REFUSED_DAYS,
  FRONTIER_LEAD_REFUSED_LIMIT,
  FRONTIER_LEAD_GENRE_QUERIES,
  FRONTIER_LEAD_REGULATORY_WATCH,
  FRONTIER_LEAD_SHARES,
  FRONTIER_LEAD_TRIGGERS,
  FRONTIER_MIX_GROUPS,
  FRONTIER_SPECIALTIES,
  frontierActiveCongresses,
  frontierIdentifierLeads,
  frontierLeadPlaces,
  frontierLeadQueryKey,
  frontierLeadSkipHost,
} from '../index.mjs'

test('every trigger has a share, the shares make the whole day: the watches 0.40, the outside events 0.15 (owner 2026-10-25)', () => {
  assert.deepEqual(Object.keys(FRONTIER_LEAD_SHARES).sort(), [...FRONTIER_LEAD_TRIGGERS].sort())
  const sum = Object.values(FRONTIER_LEAD_SHARES).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, String(sum))
  const watches = ['hot-tag', 'specialty', 'congress', 'regulatory-watch'].reduce((total, key) => total + FRONTIER_LEAD_SHARES[/** @type {keyof typeof FRONTIER_LEAD_SHARES} */ (key)], 0)
  assert.ok(Math.abs(watches - 0.4) < 1e-9)
  assert.equal(FRONTIER_LEAD_SHARES['outside-event'], 0.15)
  assert.deepEqual([FRONTIER_LEAD_SHARES['zh-report'], FRONTIER_LEAD_SHARES.specialty, FRONTIER_LEAD_SHARES['hot-tag']], [0.15, 0.13, 0.07])
  assert.equal(FRONTIER_LEAD_TRIGGERS[0], 'outside-event', 'a tiny cap spends its first place on an outside event')
  assert.equal(frontierLeadPlaces(120)['outside-event'], 18)
  const places = frontierLeadPlaces(120)
  assert.ok(Object.values(places).reduce((a, b) => a + b, 0) <= 120, 'never past the cap')
  assert.deepEqual(frontierLeadPlaces(0), Object.fromEntries(FRONTIER_LEAD_TRIGGERS.map((trigger) => [trigger, 0])))
  assert.equal(Object.values(frontierLeadPlaces(3)).reduce((a, b) => a + b, 0), 3, 'a tiny cap is spent once each, in order')
})

test('the congress calendar: dated rows with sources, ordered, each specialty a known one; the window is three days either side and the abstract days', () => {
  assert.ok(FRONTIER_CONGRESSES.length >= 40)
  for (const congress of FRONTIER_CONGRESSES) {
    assert.match(congress.start, /^\d{4}-\d{2}-\d{2}$/, congress.id)
    assert.ok(congress.end >= congress.start, congress.id)
    assert.ok(congress.keywords_zh.length && congress.keywords_en.length, congress.id)
    assert.match(congress.source_url, /^https:\/\//, congress.id)
    assert.ok(congress.specialty === null || FRONTIER_SPECIALTIES.includes(congress.specialty), `${congress.id}: ${congress.specialty}`)
  }
  assert.deepEqual(FRONTIER_CONGRESSES.map((c) => c.start), [...FRONTIER_CONGRESSES.map((c) => c.start)].sort())
  const calendar = [{ id: 'x', name_en: 'X', name_zh: 'X', start: '2026-12-12', end: '2026-12-15', abstracts_at: '2026-11-04', city: null,
    keywords_en: ['X 2026'], keywords_zh: ['X 2026'], specialty: null, source_url: 'https://example.org' }]
  const on = (/** @type {string} */ day) => frontierActiveCongresses(day, calendar).length === 1
  assert.deepEqual(['2026-12-08', '2026-12-09', '2026-12-18', '2026-12-19'].map(on), [false, true, true, false])
  assert.deepEqual(['2026-11-03', '2026-11-04', '2026-11-07', '2026-11-08'].map(on), [false, true, true, false], 'the days the abstracts go online')
  assert.deepEqual(frontierActiveCongresses('not a day'), [])
  assert.ok(frontierActiveCongresses('2026-10-24').some((c) => c.id === 'esmo-2026'), 'ESMO 2026 is on during its own congress')
})

test('the watch and the gap queries are data: Chinese, short enough for every engine, and gap groups are groups the mix has floors for', () => {
  for (const entry of FRONTIER_LEAD_REGULATORY_WATCH) {
    assert.match(entry.query, /[一-鿿]/u)
    assert.ok(entry.query.length <= 40 && entry.why.length > 0)
  }
  for (const [group, queries] of Object.entries(FRONTIER_LEAD_GENRE_QUERIES)) {
    assert.ok(/** @type {any} */ (FRONTIER_MIX_GROUPS)[group]?.min > 0, group)
    assert.ok(queries.length >= 1 && queries.every((query) => query.length <= 40))
  }
  assert.equal('research' in FRONTIER_LEAD_GENRE_QUERIES, false, 'research is never short')
})

test('a query is one query whatever its spacing and width', () => {
  assert.equal(frontierLeadQueryKey('  国家药监局　批准  上市 '), '国家药监局 批准 上市')
  assert.equal(frontierLeadQueryKey('ESMO 2026'), frontierLeadQueryKey('ｅｓｍｏ  2026'))
})

test('identifiers a report names become addresses: the columns first, then the text, each once, at most three', () => {
  assert.deepEqual(frontierIdentifierLeads({ doi: '10.1056/NEJMoa2412345', pmid: '39876543', registryIds: ['nct01234567', 'ChiCTR2400012345'] }), [
    { kind: 'doi', id: '10.1056/nejmoa2412345', url: 'https://doi.org/10.1056/nejmoa2412345' },
    { kind: 'pmid', id: '39876543', url: 'https://pubmed.ncbi.nlm.nih.gov/39876543/' },
    { kind: 'nct', id: 'NCT01234567', url: 'https://clinicaltrials.gov/study/NCT01234567' },
  ])
  const text = 'The study (doi: 10.1001/jama.2026.1234.) was registered as NCT07654321; see also https://doi.org/10.1001/jama.2026.1234 and PMID: 40012345.'
  assert.deepEqual(frontierIdentifierLeads({ text }).map((lead) => `${lead.kind}:${lead.id}`),
    ['doi:10.1001/jama.2026.1234', 'pmid:40012345', 'nct:NCT07654321'])
  assert.deepEqual(frontierIdentifierLeads({ text: '研究发表于《柳叶刀》，DOI：10.1016/S0140-6736(26)01234-5，注册号 NCT01111111。' }).map((lead) => lead.id),
    ['10.1016/s0140-6736(26)01234-5', 'NCT01111111'])
  assert.equal(frontierIdentifierLeads({ text: 'NCT01234567 NCT01234568 NCT01234569 NCT01234570' }).length, 3)
  assert.deepEqual(frontierIdentifierLeads({ doi: 'not a doi', pmid: '12', text: null }), [])
})

test('a social network\'s page is never handed over, whatever its subdomain; a news site is', () => {
  assert.equal(frontierLeadSkipHost('www.linkedin.com'), true)
  assert.equal(frontierLeadSkipHost('m.weibo.com'), true)
  assert.equal(frontierLeadSkipHost('x.com'), true)
  assert.equal(frontierLeadSkipHost('nmpa.gov.cn'), false)
  assert.equal(frontierLeadSkipHost('box.com'), false, 'a suffix that is not a whole label is no match')
})

test('what is not handed over is data: the plugin\'s freshness window and the refused-host rule', () => {
  assert.equal(FRONTIER_LEAD_FRESH_DAYS, 30, 'the plugin\'s leads.py FRESH_DAYS')
  assert.deepEqual([FRONTIER_LEAD_REFUSED_LIMIT, FRONTIER_LEAD_REFUSED_DAYS], [2, 7])
})
