import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { apply } from '../plugins/capsule.mjs'
import { sha256Hex } from '../src/digest.mjs'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  /** @type {any[]} */ const calls = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); calls.push({ path: req.url, body, token: req.headers.authorization })
    const data = req.url?.endsWith('/handbook-context') ? { contexts: (body.inputs ?? []).map((/** @type {any} */ input) => ({ requestId: input.requestId, digest: 'd'.repeat(64), context: `Supplement ${input.requestId}` })) }
      : req.url?.endsWith('/handbook-attached') ? { attached: body.receipts.map((/** @type {any} */ item) => item.requestId) } : { context: '' }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  /** @type {Map<string,any>} */ const hooks = new Map()
  /** @type {string[]} */ const degraded = []
  const ctx = {
    effect: (/** @type {any} */ fn) => fn(), on: (/** @type {string} */ event, /** @type {any} */ handler) => { const previous = hooks.get(event); hooks.set(event, previous ? (/** @type {any} */ payload, /** @type {any} */ next) => handler(payload, () => previous(payload, next)) : handler); return () => {} },
    provide: () => {}, get: (/** @type {string} */ key) => key === 'fs' ? { resolve: async (/** @type {any} */ value) => value, readText: async () => 'fixture-workload' } : key === 'evimedDiagnostics' ? { degrade: (/** @type {string} */ text) => degraded.push(text) } : undefined,
    tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
  }
  await apply(ctx, { methodsDir: '', recallUrl: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/internal/capsules/v1`, tokenFile: '/workload', recallTimeoutMs: 1000 })
  return { calls, hooks, degraded }
}
/** @param {string} id @param {string} [text] @param {string} [kind] */
const input = (id, text = id, kind = 'user') => ({ role: 'user', source: { kind, rpcId: id }, content: [{ type: 'text', text }] })
/** @param {any[]} messages @param {number} [turn] @param {boolean} [child] */
const step = (messages, turn = 2, child = false) => ({ turn, step: 1, messages, agent: { id: 'agent', session: { id: 'session', header: child ? { origin: 'subagent', parentSession: 'root' } : {} }, inject: () => { throw new Error('Current context must never enter the next inbox') } } })

test('only this step input IDs receive context, are acknowledged after entering and are deduplicated within the turn', async t => {
  const f = await fixture(t)
  const payload = step([input('A')])
  const first = await f.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(first.messages[0], payload.messages[0])
  assert.equal(first.messages.at(-1).content[0].text, 'Supplement A')
  assert.deepEqual(f.calls.map(call => call.path.split('/').at(-1)), ['handbook-context', 'handbook-attached'])
  assert.deepEqual(f.calls[0].body.inputs, [{ requestId: 'A', textDigest: await sha256Hex('A') }])
  assert.ok(f.calls.every(call => call.token === 'Bearer fixture-workload'))
  await f.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(f.calls.length, 2)
  const future = step([input('B')], 3)
  const next = await f.hooks.get('agent/pre-step')(future, async () => ({ kind: 'enter', messages: future.messages }))
  assert.equal(next.messages.at(-1).content[0].text, 'Supplement B')
  assert.equal(f.calls[2].body.inputs[0].requestId, 'B')
})

test('rejected steps, plugin messages and subagent inputs do not acknowledge native context', async t => {
  const f = await fixture(t)
  const payload = step([input('A')])
  assert.equal((await f.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'reject' }))).kind, 'reject')
  assert.equal(f.calls.length, 1, 'a read alone is not an attachment')
  await f.hooks.get('agent/pre-step')(step([input('machine', 'x', 'plugin:other')]), async () => ({ kind: 'enter', messages: [] }))
  await f.hooks.get('agent/pre-step')(step([input('child')], 2, true), async () => ({ kind: 'enter', messages: [] }))
  assert.equal(f.calls.length, 1)
  await f.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(f.calls.length, 3, 'a later entering retry can attach the still-unconsumed request')
})
