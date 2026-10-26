import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_HIDE_REASON_LABELS_ZH,
  FRONTIER_HIDE_REASONS,
  FRONTIER_INTERACTION_DROP_REASONS,
  FRONTIER_INTERACTION_RULES,
  FRONTIER_INTERACTION_TYPES,
  FRONTIER_LIST_SURFACES,
  FRONTIER_READER_ROLE_LABELS_ZH,
  FRONTIER_READER_ROLES,
  FRONTIER_SURFACES,
  frontierInteraction,
} from '../index.mjs'

const NOW = Date.parse('2026-10-24T08:00:00Z')
const LIST = '0f8fad5b-d9cb-469f-a165-70867728950e'
const base = { id: 'evt_00000001', session: 'ses_00000001', at: NOW - 1_000 }
const check = (/** @type {Record<string, unknown>} */ raw) => frontierInteraction(raw, { now: NOW })

test('every type has a rule, every hide reason and role a Chinese label, and the list surfaces are surfaces', () => {
  assert.deepEqual(Object.keys(FRONTIER_INTERACTION_RULES).sort(), [...FRONTIER_INTERACTION_TYPES].sort())
  assert.deepEqual(Object.keys(FRONTIER_HIDE_REASON_LABELS_ZH).sort(), [...FRONTIER_HIDE_REASONS].sort())
  assert.deepEqual(Object.keys(FRONTIER_READER_ROLE_LABELS_ZH).sort(), [...FRONTIER_READER_ROLES].sort())
  for (const surface of FRONTIER_LIST_SURFACES) assert.ok(FRONTIER_SURFACES.includes(surface), surface)
  for (const label of Object.values(FRONTIER_HIDE_REASON_LABELS_ZH)) assert.match(label, /\p{Script=Han}/u)
})

test('an impression from a list keeps its list, slot and position; absent optional fields read as null', () => {
  const result = check({ ...base, type: 'impression', surface: 'for-you', item: 'abcdef123456', list: LIST, slot: 'explore', position: 3, value: 1_200 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.event, { ...base, type: 'impression', surface: 'for-you', item: 'abcdef123456', event: null, list: LIST,
    slot: 'explore', position: 3, value: 1_200, detail: null, view: null, device: null })
  // A hot list's entry is an event.
  assert.equal(check({ ...base, type: 'impression', surface: 'hot', event: '9f3c2a1b4d5e6f70', list: LIST, position: 0 }).ok, true)
})

test('an impression is seen: at least one second, on a list, about one item or one event', () => {
  const impression = { ...base, type: 'impression', surface: 'feed', item: 'abcdef123456' }
  assert.deepEqual(check({ ...impression, value: 999 }), { ok: false, reason: 'bad-value' })
  assert.deepEqual(check({ ...impression, surface: 'reader' }), { ok: false, reason: 'bad-surface' })
  assert.deepEqual(check({ ...impression, event: '9f3c2a1b4d5e6f70' }), { ok: false, reason: 'bad-target' })
  assert.deepEqual(check({ ...base, type: 'impression', surface: 'feed' }), { ok: false, reason: 'bad-target' })
})

test('reader events need their view and carry no list; dwell and read depth need their value', () => {
  const reader = { ...base, surface: 'reader', item: 'abcdef123456', view: 'view_0000001' }
  assert.equal(check({ ...reader, type: 'dwell', value: 42_000 }).ok, true)
  assert.deepEqual(check({ ...reader, type: 'dwell' }), { ok: false, reason: 'bad-value' })
  assert.deepEqual(check({ ...reader, type: 'dwell', value: 42_000, view: undefined }), { ok: false, reason: 'bad-view' })
  assert.deepEqual(check({ ...reader, type: 'dwell', value: 42_000, list: LIST }), { ok: false, reason: 'bad-list' })
  assert.equal(check({ ...reader, type: 'read-depth', value: 75 }).ok, true)
  assert.deepEqual(check({ ...reader, type: 'read-depth', value: 70 }), { ok: false, reason: 'bad-value' })
  assert.equal(check({ ...reader, type: 'reach-end' }).ok, true)
  assert.equal(check({ ...reader, type: 'toggle-translation', detail: 'original' }).ok, true)
  assert.deepEqual(check({ ...reader, type: 'toggle-translation', detail: 'fr' }), { ok: false, reason: 'bad-detail' })
})

test('a hide names a closed reason or none; a filter change names its control and never its value; onboarding happens in 与我相关', () => {
  const item = { ...base, surface: 'feed', item: 'abcdef123456' }
  assert.equal(check({ ...item, type: 'hide' }).ok, true)
  assert.equal(check({ ...item, type: 'hide', detail: 'promotional' }).ok, true)
  assert.deepEqual(check({ ...item, type: 'hide', detail: '我不喜欢' }), { ok: false, reason: 'bad-detail' })
  assert.equal(check({ ...base, type: 'filter-change', surface: 'feed', detail: 'specialty' }).ok, true)
  // c3-track: the 追踪 view's agency filter is a control of its own, on its own surface.
  assert.equal(check({ ...base, type: 'filter-change', surface: 'track', detail: 'agency' }).ok, true)
  assert.deepEqual(check({ ...base, type: 'filter-change', surface: 'feed', detail: 'cardiology' }), { ok: false, reason: 'bad-detail' })
  assert.deepEqual(check({ ...base, type: 'filter-change', surface: 'feed', detail: 'view', view: 'view_0000001' }), { ok: false, reason: 'bad-view' })
  assert.equal(check({ ...base, type: 'onboarding-skipped', surface: 'for-you', detail: 'specialties' }).ok, true)
  assert.deepEqual(check({ ...base, type: 'onboarding-done', surface: 'feed' }), { ok: false, reason: 'bad-surface' })
})

test('what is not the vocabulary is dropped with its reason: a type, a field, an id, a clock, a position', () => {
  const ok = { ...base, type: 'open', surface: 'feed', item: 'abcdef123456' }
  assert.equal(check(ok).ok, true)
  assert.deepEqual(check({ ...ok, type: 'scroll' }), { ok: false, reason: 'unknown-type' })
  assert.deepEqual(check({ ...ok, url: 'https://example.org/?q=x' }), { ok: false, reason: 'unexpected-field' })
  assert.deepEqual(check({ ...ok, id: 'short' }), { ok: false, reason: 'bad-id' })
  assert.deepEqual(check({ ...ok, session: undefined }), { ok: false, reason: 'bad-session' })
  assert.deepEqual(check({ ...ok, at: NOW - 25 * 3_600_000 }), { ok: false, reason: 'stale' })
  assert.deepEqual(check({ ...ok, at: NOW + 10 * 60_000 }), { ok: false, reason: 'stale' })
  assert.deepEqual(check({ ...ok, position: -1 }), { ok: false, reason: 'bad-position' })
  assert.deepEqual(check({ ...ok, slot: 'sponsored' }), { ok: false, reason: 'bad-slot' })
  assert.deepEqual(check({ ...ok, list: 'not-a-list' }), { ok: false, reason: 'bad-list' })
  assert.deepEqual(check({ ...ok, item: 'ABC' }), { ok: false, reason: 'bad-target' })
  assert.deepEqual(check({ ...ok, surface: 'home' }), { ok: false, reason: 'bad-surface' })
  assert.equal(check({ ...ok, device: 'narrow' }).ok, true)
  assert.deepEqual(check({ ...ok, device: 'iPhone 15' }), { ok: false, reason: 'bad-device' })
  assert.deepEqual(frontierInteraction(null, { now: NOW }), { ok: false, reason: 'not-an-object' })
  for (const raw of [{ ...ok, type: 'scroll' }, { ...ok, url: 'x' }, { ...ok, id: 'x' }]) {
    const result = check(raw)
    assert.ok(!result.ok && FRONTIER_INTERACTION_DROP_REASONS.includes(result.reason))
  }
})
