import assert from 'node:assert/strict'
import test from 'node:test'
import * as port from '../index.mjs'
const { injectContext, onPreStep, stepUserInputs } = port

/** @param {string} requestId @param {string} text @param {string} [kind] */
const message = (requestId, text, kind = 'user') => ({ role: 'user', source: { kind, rpcId: requestId }, content: [{ type: 'text', text }] })
test('only user inputs actually removed from this step inbox expose native request identities', () => {
  assert.deepEqual(stepUserInputs({ messages: [message('A', 'Current A'), message('B', 'Steered B'), message('A', 'Current A'), message('plugin-id', 'Injected', 'plugin:evimed'), message('', 'No identity')] }),
    [{ requestId: 'A', text: 'Current A' }, { requestId: 'B', text: 'Steered B' }])
  assert.deepEqual(stepUserInputs({ messages: [], agent: { inbox: [message('future', 'Queued future')] } }), [])
  assert.deepEqual(stepUserInputs({ messages: [message('../opaque', 'Still an opaque native identity'), message('bad\nrequest', 'Invalid')] }), [{ requestId: '../opaque', text: 'Still an opaque native identity' }])
})

test('a context acknowledgement happens only for an entering decision and rejected context is never queued into a later turn', async () => {
  /** @type {any} */ let handler
  let acknowledged = 0
  /** @type {any[]} */ const queued = []
  const agent = { id: 'agent', session: { id: 'session' }, inject: (/** @type {any} */ value) => queued.push(value) }
  onPreStep({ on: (/** @type {string} */ _event, /** @type {any} */ fn) => { handler = fn; return () => {} } }, async () => {
    injectContext(agent, 'Current input supplement', 'evimed-capsule')
    return { allow: true, discardOnReject: true, onEntered: async () => { acknowledged += 1 } }
  }, () => ({ first: true, root: true }))
  const payload = { agent, turn: 1, step: 1, messages: [message('A', 'Question')] }
  assert.equal((await handler(payload, async () => ({ kind: 'reject' }))).kind, 'reject')
  assert.equal(acknowledged, 0)
  assert.deepEqual(queued, [])
  const entered = await handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(entered.messages.length, 2)
  assert.equal(entered.messages[0], payload.messages[0], 'the native input identity is untouched')
  assert.equal(acknowledged, 1)
})

test('a step canceled while the downstream decision settles never acknowledges attachment', async () => {
  /** @type {any} */ let handler
  let acknowledged = 0
  const controller = new AbortController()
  const agent = { id: 'agent', session: { id: 'session' }, inject: () => {} }
  onPreStep({ on: (/** @type {string} */ _event, /** @type {any} */ fn) => { handler = fn; return () => {} } }, async () => {
    injectContext(agent, 'Optional supplement', 'evimed-capsule')
    return { allow: true, discardOnReject: true, onEntered: async () => { acknowledged += 1 } }
  }, () => ({ first: false, root: true }))
  await handler({ agent, turn: 1, step: 1, signal: controller.signal, messages: [message('A','Question')] }, async () => {
    controller.abort(); return { kind: 'enter', messages: [] }
  })
  assert.equal(acknowledged, 0)
})
