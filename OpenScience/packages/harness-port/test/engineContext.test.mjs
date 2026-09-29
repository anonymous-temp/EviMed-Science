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

test('the pinned native registry dispatches concurrent decorated bodies without bypassing scoped restrictions', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const root = new Context()
  root.provide('systemPrompt', { tools() {} })
  /** @type {any} */ const runtime = new ToolRuntime(root)
  const dispose = port.decorateEngineToolContext(root)
  const name = 'mcp__evimed__meta_analysis'
  /** @type {any[]} */ const seen = []
  const unregister = runtime.register({ name, description: 'test',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async (/** @type {any} */ args, /** @type {any} */ execution) => {
      assert.ok(Object.isFrozen(execution.arguments))
      assert.equal(execution.arguments.__evimed_execution_context, undefined)
      await new Promise(resolve => setTimeout(resolve, args.__evimed_execution_context.reasoningEffort === 'low' ? 10 : 0))
      seen.push(args.__evimed_execution_context)
      return { completed: true }
    },
  })
  const agents = ['low', 'max'].map(reasoningEffort => {
    /** @type {any} */ const agent = { session: { id: `native-${reasoningEffort}`, requestHeader: () => ({ config: {
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort,
    } }) } }
    agent.ctx = createScope(root, agent).ctx
    return agent
  })
  const results = await Promise.all(agents.map(agent => runtime.execute({ callId: agent.session.id,
    name, agent, arguments: { action: 'start' }, signal: new globalThis.AbortController().signal })))
  assert.ok(results.every(result => !result.isError), JSON.stringify(results))
  assert.deepEqual(seen.map(value => [value.sessionId, value.reasoningEffort]).sort(), [['native-low','low'], ['native-max','max']])
  const deny = agents[0].ctx.tools.restrict({ deny: [name] })
  const refused = await runtime.execute({ callId: 'blocked', name, agent: agents[0], arguments: { action: 'start' }, signal: new globalThis.AbortController().signal })
  assert.equal(refused.isError, true)
  assert.equal(seen.length, 2, 'the body must not run after a native restriction')
  deny()
  unregister()
  dispose()
})
