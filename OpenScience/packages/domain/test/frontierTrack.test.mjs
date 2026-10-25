import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_AGENCIES,
  FRONTIER_AGENCY_ALIASES,
  FRONTIER_APPROVAL_AGENCY_KEYS,
  FRONTIER_APPROVAL_KIND_LABELS_ZH,
  FRONTIER_APPROVAL_KINDS,
  FRONTIER_CONGRESS_ITEM_DAYS,
  FRONTIER_CONGRESS_RECENT_DAYS,
  FRONTIER_CONGRESS_UPCOMING_DAYS,
  FRONTIER_CONGRESSES,
  FRONTIER_TRACK_LIMITS,
  frontierAgencyByKey,
  frontierAgencyOfOwner,
  frontierCongressById,
  frontierCongressCode,
  frontierCongressItemWindow,
  frontierCongressRecapDays,
  frontierCongressStatus,
  frontierCongressSummary,
  frontierDayIn,
  frontierDaysBetween,
  frontierQuoteNamesAgency,
  frontierShiftDay,
} from '../index.mjs'

const ESMO = /** @type {any} */ (frontierCongressById('esmo-2026'))

test('every approval kind has its words, and the agencies the model may name are the table\'s (and `other`)', () => {
  assert.deepEqual(Object.keys(FRONTIER_APPROVAL_KIND_LABELS_ZH).sort(), [...FRONTIER_APPROVAL_KINDS].sort())
  for (const key of FRONTIER_APPROVAL_AGENCY_KEYS) assert.ok(key === 'other' || frontierAgencyByKey(key), key)
  for (const agency of FRONTIER_AGENCIES) assert.ok(['cn', 'us', 'eu', 'other'].includes(agency.region), agency.key)
  for (const key of Object.keys(FRONTIER_AGENCY_ALIASES)) assert.ok(frontierAgencyByKey(key), key)
})

test('an agency is known by its source\'s owner entity; a news site or a press-release wire is none', () => {
  assert.equal(frontierAgencyOfOwner('U.S. Food and Drug Administration')?.key, 'fda')
  assert.equal(frontierAgencyOfOwner('国家药品监督管理局')?.key, 'nmpa')
  assert.equal(frontierAgencyOfOwner('European Medicines Agency')?.key, 'ema')
  assert.equal(frontierAgencyOfOwner('Cision PR Newswire'), null)
  assert.equal(frontierAgencyOfOwner('中国医药网 Pharmnet'), null)
  assert.equal(frontierAgencyOfOwner(null), null)
})

test('a quotation names an agency by a proper name standing alone: edema is not the EMA', () => {
  assert.equal(frontierQuoteNamesAgency('The U.S. FDA has approved', 'fda'), true)
  assert.equal(frontierQuoteNamesAgency('美国食品药品监督管理局批准', 'fda'), true)
  assert.equal(frontierQuoteNamesAgency('国家药监局官网显示', 'nmpa'), true)
  assert.equal(frontierQuoteNamesAgency('The European Commission (EC) has approved', 'ec'), true)
  assert.equal(frontierQuoteNamesAgency('pulmonary edema in the USA', 'ema'), false)
  assert.equal(frontierQuoteNamesAgency('The EMA recommended', 'ema'), true)
  assert.equal(frontierQuoteNamesAgency('approved in the USA', 'fda'), false)
  assert.equal(frontierQuoteNamesAgency('anything', 'unknown'), false)
})

test('day arithmetic is on calendar days, across a month and a year', () => {
  assert.equal(frontierShiftDay('2026-10-30', 3), '2026-11-02')
  assert.equal(frontierShiftDay('2026-01-02', -3), '2025-12-30')
  assert.equal(frontierDaysBetween('2026-10-25', '2026-12-24'), 60)
  assert.equal(frontierDaysBetween('2026-10-27', '2026-10-25'), -2)
  assert.throws(() => frontierShiftDay('not a day', 1), TypeError)
})

test('the feed\'s day is Asia/Shanghai: 23:30 UTC is already the next day there', () => {
  assert.equal(frontierDayIn('2026-10-24T23:30:00Z', 'Asia/Shanghai'), '2026-10-25')
  assert.equal(frontierDayIn('2026-10-24T15:59:59Z', 'Asia/Shanghai'), '2026-10-24')
  assert.equal(frontierDayIn('2026-10-24T16:00:00Z', 'Asia/Shanghai'), '2026-10-25')
  assert.equal(frontierDayIn('2026-10-24T23:30:00Z', 'UTC'), '2026-10-24')
})

test('a congress is ongoing from its first to its last day, upcoming within 60 days, recent within 30 after it ended', () => {
  const meeting = { start: '2026-10-23', end: '2026-10-27' }
  assert.equal(frontierCongressStatus(meeting, '2026-10-22'), 'upcoming')
  assert.equal(frontierCongressStatus(meeting, '2026-10-23'), 'ongoing')
  assert.equal(frontierCongressStatus(meeting, '2026-10-27'), 'ongoing')
  assert.equal(frontierCongressStatus(meeting, '2026-10-28'), 'recent')
  // The edges: exactly 60 days ahead is upcoming, 61 is later; exactly 30 days after the end is recent, 31 is past.
  assert.equal(frontierCongressStatus(meeting, frontierShiftDay(meeting.start, -FRONTIER_CONGRESS_UPCOMING_DAYS)), 'upcoming')
  assert.equal(frontierCongressStatus(meeting, frontierShiftDay(meeting.start, -FRONTIER_CONGRESS_UPCOMING_DAYS - 1)), 'later')
  assert.equal(frontierCongressStatus(meeting, frontierShiftDay(meeting.end, FRONTIER_CONGRESS_RECENT_DAYS)), 'recent')
  assert.equal(frontierCongressStatus(meeting, frontierShiftDay(meeting.end, FRONTIER_CONGRESS_RECENT_DAYS + 1)), 'past')
})

test('the status on a day that is read in Asia/Shanghai: ESMO 2026 opens on 23 October there, hours before it does in New York', () => {
  assert.equal(frontierCongressStatus(ESMO, frontierDayIn('2026-10-22T16:30:00Z', 'Asia/Shanghai')), 'ongoing')
  assert.equal(frontierCongressStatus(ESMO, frontierDayIn('2026-10-22T15:30:00Z', 'Asia/Shanghai')), 'upcoming')
  assert.equal(frontierCongressStatus(ESMO, frontierDayIn('2026-10-27T15:30:00Z', 'Asia/Shanghai')), 'ongoing')
  assert.equal(frontierCongressStatus(ESMO, frontierDayIn('2026-10-27T16:30:00Z', 'Asia/Shanghai')), 'recent')
})

test('a congress\'s items are those of the days from three before its start to three after its end', () => {
  assert.equal(FRONTIER_CONGRESS_ITEM_DAYS, 3)
  assert.deepEqual(frontierCongressItemWindow(ESMO), { from: '2026-10-20', to: '2026-10-30' })
  assert.deepEqual(frontierCongressItemWindow({ start: '2026-12-30', end: '2027-01-02' }), { from: '2026-12-27', to: '2027-01-05' })
})

test('a recap is written for each day of the meeting up to today, and for the last day once more on the day after it ends', () => {
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-22'), [])
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-23'), ['2026-10-23'])
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-25'), ['2026-10-23', '2026-10-24', '2026-10-25'])
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-28'), ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-29'), [])
  assert.deepEqual(frontierCongressRecapDays(ESMO, '2026-10-29', 2), ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
})

test('a congress is called by its Latin code with its year; its Chinese name when the calendar has none', () => {
  assert.equal(frontierCongressCode(ESMO), 'ESMO 2026')
  assert.equal(frontierCongressCode(/** @type {any} */ (frontierCongressById('asn-kidney-week-2026'))), 'ASN 2026')
  assert.equal(frontierCongressCode(/** @type {any} */ (frontierCongressById('gw-icc-2026'))), 'GW-ICC 2026')
  assert.equal(frontierCongressCode({ name_zh: '某大会', name_en: 'Some Meeting', keywords_zh: ['某大会'], keywords_en: [] }), '某大会')
  for (const congress of FRONTIER_CONGRESSES) assert.ok(frontierCongressCode(congress).length > 0, congress.id)
})

test('the summary a list shows has the dates, the place, the specialty and the status on the day, without the organiser\'s parenthesis', () => {
  const summary = frontierCongressSummary(ESMO, '2026-10-25')
  assert.deepEqual({ ...summary }, { id: 'esmo-2026', code: 'ESMO 2026', name: '欧洲肿瘤内科学会年会', nameEn: 'ESMO Congress 2026', start: '2026-10-23', end: '2026-10-27',
    city: 'Madrid', specialty: 'oncology', status: 'ongoing' })
  assert.equal(frontierCongressSummary(/** @type {any} */ (frontierCongressById('gw-icc-2026')), '2026-10-25').name, '第37届长城心脏病学大会暨亚洲心脏大会2026')
  assert.equal(frontierCongressSummary(/** @type {any} */ (frontierCongressById('aha-2026')), '2026-10-25').status, 'upcoming')
})

test('the extraction\'s limits keep a recommendation\'s quotation longer than a heading and a decision window of months', () => {
  assert.ok(FRONTIER_TRACK_LIMITS.recommendationQuoteMin > FRONTIER_TRACK_LIMITS.quoteMin)
  assert.ok(FRONTIER_TRACK_LIMITS.decisionMaxAgeDays >= 90)
  assert.equal(FRONTIER_TRACK_LIMITS.recommendations, 5)
})
