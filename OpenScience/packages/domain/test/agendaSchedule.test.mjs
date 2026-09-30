import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAgendaSchedule, agendaDueOccurrence, agendaNextOccurrence, normalizeAgendaSchedule } from '../src/agendaSchedule.mjs'
/** @type {import("../src/agendaSchedule.mjs").AgendaSchedule} */
const daily = { kind: 'daily', timeZone: 'Asia/Shanghai', time: '07:35' }
test('minute precision, weekly selection and one-off dates', () => {
  assert.equal(agendaDueOccurrence(daily, null, '2026-09-29T23:34:00Z', '2026-09-29T20:00:00Z'), null)
  assert.equal(agendaDueOccurrence(daily, null, '2026-09-29T23:35:00Z')?.scheduledAt, '2026-09-29T23:35:00.000Z')
  assert.equal(agendaNextOccurrence({ ...daily, kind: 'weekly', weekdays: [1] }, null, '2026-09-29T00:00:00Z')?.localDate, '2026-10-05')
  /** @type {import("../src/agendaSchedule.mjs").AgendaSchedule} */
  const once = { ...daily, kind: 'once', date: '2026-09-30' }
  const occurrence = agendaDueOccurrence(once, null, '2026-10-10T00:00:00Z')
  assert.equal(occurrence?.localDate, '2026-09-30')
  assert.equal(agendaDueOccurrence(once, occurrence, '2026-10-11T00:00:00Z'), null)
  assert.equal(agendaNextOccurrence(once, occurrence, '2026-10-11T00:00:00Z'), null)
})
test('DST gaps use the first valid minute; overlaps run once', () => {
  /** @type {import("../src/agendaSchedule.mjs").AgendaSchedule} */
  const gap = { kind: 'once', timeZone: 'America/New_York', time: '02:30', date: '2026-03-08' }
  assert.equal(agendaDueOccurrence(gap, null, '2026-03-09T00:00:00Z')?.scheduledAt, '2026-03-08T07:00:00.000Z')
  const overlap = { ...gap, time: '01:30', date: '2026-11-01' }
  const first = agendaDueOccurrence(overlap, null, '2026-11-01T05:30:00Z')
  assert.equal(first?.scheduledAt, '2026-11-01T05:30:00.000Z')
  assert.equal(agendaDueOccurrence(overlap, first, '2026-11-01T06:30:00Z'), null)
})
test('calendar validation and legacy normalization are strict and read only', () => {
  for (const schedule of [{ ...daily, time: '24:00' }, { ...daily, timeZone: 'Invalid/Zone' },
    { ...daily, kind: 'once', date: '2026-02-30' }, { ...daily, kind: 'weekly', weekdays: [0] },
    { ...daily, weekdays: [1] }, { ...daily, extra: true }]) assert.throws(() => validateAgendaSchedule(schedule))
  const legacy = { scheduleHour: 7, timeZone: 'Asia/Shanghai', enabled: false, status: 'paused' }
  assert.deepEqual(normalizeAgendaSchedule(legacy), { ...daily, time: '07:00' })
  assert.equal(legacy.status, 'paused')
  const due = agendaDueOccurrence(daily, null, '2026-09-30T23:40:00Z')
  assert.equal(due?.localDate, '2026-10-01', 'catch-up emits only the latest occurrence')
})
