import assert from 'node:assert/strict'
import test from 'node:test'
import * as port from '../index.mjs'

test('engine tool bodies receive their own request-header policy without changing public arguments or visibility', async () => {
  /** @type {any[]} */ const calls = []
  const original = async (/** @type {any} */ args, /** @type {any} */ exec) => { calls.push({ args, exec }); return { result: 'kept' } }
  const schema = { type: 'object', properties: { action: { type: 'string' } } }
  const definition = { name: 'mcp__evimed__meta_analysis', parameters: schema, execute: original, output: { render() { return [] } } }
  /** @type {Map<string, Function>} */ const listeners = new Map()
  const ctx = { tools: { get: () => definition }, on: (/** @type {string} */ name, /** @type {Function} */ fn) => {
    listeners.set(name, fn); return () => listeners.delete(name)
  } }
  assert.equal(typeof port.decorateEngineToolContext, 'function')
  const dispose = port.decorateEngineToolContext(ctx)
  const args = Object.freeze({ action: 'start', __evimed_execution_context: Object.freeze({ sessionId: 'forged', reasoningEffort: 'max' }) })
  for (const [sessionId, reasoningEffort] of [['one', 'low'], ['two', 'max']]) {
    const exec = { callId: `call-${sessionId}`, rootCallId: `root-${sessionId}`, agent: { session: {
      id: sessionId, requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort } }),
    } } }
    assert.deepEqual(await definition.execute(args, exec), { result: 'kept' })
  }
  assert.deepEqual(calls.map(call => [call.args.__evimed_execution_context.sessionId, call.args.__evimed_execution_context.reasoningEffort]), [['one','low'], ['two','max']])
  assert.equal(args.__evimed_execution_context.sessionId, 'forged')
  assert.equal(definition.parameters, schema)
  assert.equal(calls[0].exec.agent.session.id, 'one')
  dispose()
  assert.equal(definition.execute, original)
})
