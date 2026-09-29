import assert from 'node:assert/strict'
import test from 'node:test'
import * as port from '../index.mjs'
const { injectContext, onPreStep, stepUserInputs } = port

const message = (requestId, text, kind = 'user') => ({ role: 'user', source: { kind, rpcId: requestId }, content: [{ type: 'text', text }] })
test('only user inputs actually removed from this step inbox expose native request identities', () => {
  assert.deepEqual(stepUserInputs({ messages: [message('A', 'Current A'), message('B', 'Steered B'), message('A', 'Current A'), message('plugin-id', 'Injected', 'plugin:evimed'), message('', 'No identity')] }),
    [{ requestId: 'A', text: 'Current A' }, { requestId: 'B', text: 'Steered B' }])
  assert.deepEqual(stepUserInputs({ messages: [], agent: { inbox: [message('future', 'Queued future')] } }), [])
  assert.deepEqual(stepUserInputs({ messages: [message('../opaque', 'Still an opaque native identity'), message('bad\nrequest', 'Invalid')] }), [{ requestId: '../opaque', text: 'Still an opaque native identity' }])
})

test('a context acknowledgement happens only for an entering decision and rejected context is never queued into a later turn', async () => {
  let handler
  let acknowledged = 0
  const queued = []
  const agent = { id: 'agent', session: { id: 'session' }, inject: (value) => queued.push(value) }
  onPreStep({ on: (_event, fn) => { handler = fn; return () => {} } }, async () => {
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
