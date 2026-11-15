import assert from 'node:assert/strict'
import test from 'node:test'
import * as bridge from '../src/memoryBridge.mjs'

test('MCP invocation binds concurrent native conversations without accepting model supplied identity', async () => {
  const bindings = new Map(), seen = []
  const definition = { name: 'mcp__openviking__remember', execute: async args => {
    const receipt = args.__evimed_memory_invocation
    seen.push(bindings.get(receipt))
    assert.notEqual(receipt, 'forged')
    return receipt
  } }
  const ctx = { tools: { get: name => name === definition.name ? definition : null }, on: () => () => {} }
  const dispose = bridge.decorateMemoryToolSource(ctx, bindings)
  await Promise.all(['native-a', 'native-b'].map(id => definition.execute({ __evimed_memory_invocation: 'forged', sessionId: 'victim' }, { agent: { session: { id, header: { id } } } })))
  assert.deepEqual(seen, ['native-a', 'native-b'])
  assert.equal(bindings.size, 0)
  dispose()
})
