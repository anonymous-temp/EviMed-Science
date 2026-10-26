import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionService } from '../src/extensionService.mjs'

test('an intentionally empty catalogue remains available, while missing/failing deployment configuration has its own unavailable reason', async () => {
  const empty = await new ExtensionService(null, { catalogue: [] }).catalogue()
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.availability, { state: 'available', reason: null })
  for (const reason of ['catalogue_unconfigured', 'catalogue_unavailable']) {
    const result = await new ExtensionService(null, { catalogue: [], catalogueAvailability: { state: 'unavailable', reason } }).catalogue()
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.availability, { state: 'unavailable', reason })
  }
})
