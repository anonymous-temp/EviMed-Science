// Run with the pinned DSH dependencies on the lab; no model/provider calls.
import assert from 'node:assert/strict'
import test from 'node:test'
import { decorateMemoryToolSource } from '../src/memoryBridge.mjs'
import { mountNativeExecutor, runNativeCall } from './helpers/nativeExecutor.mjs'

test('the pinned tool executor supplies conversation identity after strict public argument validation', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const root = new Context()
  root.provide('systemPrompt', { tools() {} })
  const runtime = new ToolRuntime(root)
  await mountNativeExecutor(root)
  /** @type {Map<string, string>} */
  const bindings = new Map()
  /** @type {(string | undefined)[]} */
  const received = []
  const dispose = decorateMemoryToolSource(/** @type {any} */ (root), bindings)
  const unregister = runtime.register({ name: 'mcp__openviking__remember', description: 'fixture',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async args => {
      const forwarded = /** @type {Record<string,string>} */ (args)
      received.push(bindings.get(forwarded.__evimed_memory_invocation))
      return {}
    } })
  try {
    for (const id of ['native-one', 'native-two']) {
      const fixture = { session: { id, header: { id } }, ctx: root }
      const agent = /** @type {import('@deepseek-ai/dsh-agent').Agent} */ (/** @type {unknown} */ (fixture))
      fixture.ctx = createScope(root, agent).ctx
      const result = await runNativeCall(runtime, { callId: id, name: 'mcp__openviking__remember', agent,
        arguments: { text: 'My own memory.' }, signal: new globalThis.AbortController().signal })
      assert.equal(result.isError, false)
    }
    assert.deepEqual(received, ['native-one', 'native-two'])
    assert.equal(bindings.size, 0)
  } finally { unregister(); dispose() }
})
