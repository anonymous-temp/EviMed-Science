import assert from 'node:assert/strict'
import { test } from 'node:test'
import { geoSignalLifecycle, geoSignalHref } from '../src/geoSignals.mjs'

test('signal links use the existing project overview and reject untrusted paths', () => {
  const id = `gs_${'a'.repeat(64)}`
  assert.equal(geoSignalHref(`geo_project/signals/${id}`), `/app/geo/geo_project?signal=${id}`)
  for (const value of ['../signals/' + id, `geo/signals/${id}?next=evil`, 'geo/signals/fake', null]) assert.equal(geoSignalHref(value), null)
})

test('staging is not starting; an accepted request without its ledger stays unavailable', () => {
  assert.equal(geoSignalLifecycle({ context: { state: 'staged' } }).state, 'pending')
  assert.deepEqual(geoSignalLifecycle({ context: { state: 'bound' } }), {
    state: 'started', executionState: 'started', availability: 'unknown', reason: 'run_unavailable',
  })
})

test('exact execution status and promised result determine task completion', () => {
  const context = { state: 'bound' }
  for (const status of ['queued', 'starting']) assert.equal(geoSignalLifecycle({ context, run: { status } }).state, 'started')
  assert.equal(geoSignalLifecycle({ context, run: { status: 'running' } }).state, 'processing')
  assert.equal(geoSignalLifecycle({ context, run: { status: 'succeeded' }, resultPresent: true }).state, 'completed')
  assert.equal(geoSignalLifecycle({ context, run: { status: 'succeeded' }, resultPresent: false }).state, 'pending')
  for (const status of ['failed', 'cancelled', 'canceled', 'budget_exhausted']) {
    assert.equal(geoSignalLifecycle({ context, run: { status }, resultPresent: true }).state, 'failed_recoverable')
  }
})

test('ignore is reversible presentation, never cancellation or medical closure', () => {
  const input = { disposition: 'ignored', context: { state: 'bound' }, run: { status: 'running' } }
  assert.deepEqual(geoSignalLifecycle(input), {
    state: 'ignored', executionState: 'processing', availability: 'available', reason: null,
  })
  assert.equal(geoSignalLifecycle({ ...input, disposition: 'active' }).state, 'processing')
  assert.equal(input.run.status, 'running')
  assert.equal(geoSignalLifecycle({ businessOutcome: 'closed' }).state, 'pending')
})

test('an unreadable ledger cannot certify a finished task or offer failure recovery', () => {
  const result = geoSignalLifecycle({ context: { state: 'bound' }, run: { status: 'succeeded' }, resultPresent: true, lookupAvailable: false })
  assert.equal(result.state, 'started')
  assert.equal(result.availability, 'unknown')
})
