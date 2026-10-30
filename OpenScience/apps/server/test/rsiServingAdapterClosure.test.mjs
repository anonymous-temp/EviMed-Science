// The dependency closure of a surface is computed once per process: it parses the lockfile in one synchronous stretch, and
// currentTarget runs on every policy read inside the activation fence.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRsiServingAdapters } from '../src/rsiServingAdapters.mjs'

const client = { query: async () => ({ rows: [] }) }
/** @param {(surface:string)=>any} closure */
function adapters(closure) {
  const calls = []
  const serving = createRsiServingAdapters({ config: { frontierModel: 'deepseek-flash' }, service: { owner: async () => 'owner' }, database: {}, documents: {},
    computeClosure: async input => { calls.push(input); return closure(input.surface) } })
  return { serving, calls }
}
const qualified = surface => ({ qualified: true, issues: [], surface, dependencyDigest: `digest-${surface}`, entries: [], dependencies: [], provenance: {} })

test('a qualified closure is computed once per surface and process, however many reads and concurrent callers ask for it', async () => {
  const { serving, calls } = adapters(qualified)
  const targets = await Promise.all([1, 2, 3].map(() => serving.currentTarget('frontier-selection', client)))
  for (let read = 0; read < 5; read++) await serving.currentTarget('frontier-selection', client)
  assert.equal(calls.length, 1)
  assert.deepEqual(targets.map(target => target.dependencyDigest), Array(3).fill('digest-frontier-selection'))
  assert.equal(calls[0].surface, 'frontier-selection')
  assert.deepEqual(calls[0].settings, { model: 'deepseek-flash', provider: 'deepseek' }, 'the settings that bind the digest are the process\'s')
  await serving.currentTarget('autopilot-planner', client)
  assert.deepEqual(calls.map(call => call.surface), ['frontier-selection', 'autopilot-planner'], 'each surface has its own closure')
  assert.equal((await adapters(qualified).serving.currentTarget('frontier-selection', client)).dependencyDigest, 'digest-frontier-selection', 'another process computes its own')
})

test('a closure that did not qualify is not remembered: a transient unreadable file does not disqualify the process for good', async () => {
  let available = false
  const { serving, calls } = adapters(surface => available ? qualified(surface) : { qualified: false, issues: ['campaign_closure_file_unavailable'], surface, dependencyDigest: null, entries: [], dependencies: [] })
  assert.equal((await serving.currentTarget('frontier-selection', client)).qualified, false)
  assert.equal((await serving.currentTarget('frontier-selection', client)).qualified, false)
  assert.equal(calls.length, 2)
  available = true
  assert.equal((await serving.currentTarget('frontier-selection', client)).qualified, true)
  await serving.currentTarget('frontier-selection', client)
  assert.equal(calls.length, 3, 'once qualified it is kept')
})

test('an unsupported surface never reaches the closure', async () => {
  const { serving, calls } = adapters(qualified)
  assert.deepEqual((await serving.currentTarget('no-such-surface', client)).issues, ['campaign_serving_scope_unsupported'])
  assert.equal(calls.length, 0)
})
