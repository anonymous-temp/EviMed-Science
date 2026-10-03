import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { HOST_PLUGIN_IDS, PLUGIN_SPECIFIERS } from '../index.mjs'

test('the specialist execution context bridge is always mounted at host scope', async () => {
  assert.ok(HOST_PLUGIN_IDS.includes('evimed-engine-context'))
  assert.equal(PLUGIN_SPECIFIERS['evimed-engine-context'], './plugins/engine-context.mjs')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: evimed-engine-context\s+name: '@evimed\/dsh-socket\/plugins\/engine-context'/)
  const plugin = await import('../plugins/engine-context.mjs')
  assert.deepEqual(plugin.inject, ['tools'])
})

test('the mounted plugin injects native calculation context and discards model assertions', async () => {
  const plugin = await import('../plugins/engine-context.mjs')
  /** @type {any} */ let received
  const original = async (/** @type {any} */ args, /** @type {any} */ _execution) => { received = args; return { id: 'durable-job' } }
  const definition = { name: 'mcp__evimed__research_calculate', execute: original }
  let dispose = () => {}
  plugin.apply({
    tools: { get: (/** @type {string} */ name) => name === definition.name ? definition : undefined },
    on: () => () => {},
    effect: (/** @type {() => () => void} */ effect) => { dispose = effect() },
  })
  const args = Object.freeze({ method: 'meta.dl', inputPath: 'input.json',
    __evimed_execution_context: Object.freeze({ sessionId: 'forged', callId: 'forged' }) })
  const execution = { callId: 'native-call', rootCallId: 'root-call', agent: { session: {
    id: 'native-session', requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  } } }
  assert.deepEqual(await definition.execute(args, execution), { id: 'durable-job' })
  assert.deepEqual(received.__evimed_execution_context, { v: 1, sessionId: 'native-session',
    callId: 'native-call', rootCallId: 'root-call', provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(args.__evimed_execution_context.sessionId, 'forged')
  await definition.execute(args, { callId: 'no-session' })
  assert.equal(received.__evimed_execution_context, undefined, 'missing native context never forwards a forged one')
  dispose()
  assert.equal(definition.execute, original)
})
