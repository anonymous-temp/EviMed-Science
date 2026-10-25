import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { apply } from '../plugins/capsule.mjs'
import { sha256Hex } from '../src/digest.mjs'

// The route of an input typed in the kernel's own window (`nativeInputRoute.mjs` on the control plane) is the one thing the plugin asks the gateway
// about an input. It used to ask for the account's capability handbooks too, and to tell the gateway they had been attached; both are gone.

/** @param {import('node:test').TestContext} t */
async function fixture(t, omitRoutes = false) {
  /** @type {any[]} */ const calls = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    // The current document selection is refreshed separately; these assertions track the route reads only.
    if (!req.url?.endsWith('/session')) calls.push({ path: req.url, body, token: req.headers.authorization })
    const data = req.url?.endsWith('/native-route') ? (omitRoutes ? {} : { routes: body.inputs }) : { context: '' }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  /** @type {Map<string,any>} */ const hooks = new Map()
  /** @type {string[]} */ const degraded = []
  /** @type {Map<string,any>} */ const services = new Map()
  const ctx = {
    effect: (/** @type {any} */ fn) => fn(), on: (/** @type {string} */ event, /** @type {any} */ handler) => { const previous = hooks.get(event); hooks.set(event, previous ? (/** @type {any} */ payload, /** @type {any} */ next) => handler(payload, () => previous(payload, next)) : handler); return () => {} },
    provide: (/** @type {string} */ key, /** @type {any} */ value) => services.set(key, value), get: (/** @type {string} */ key) => key === 'fs' ? { resolve: async (/** @type {any} */ value) => value, readText: async () => 'fixture-workload' } : key === 'evimedDiagnostics' ? { degrade: (/** @type {string} */ text) => degraded.push(text) } : undefined,
    tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
  }
  await apply(ctx, { methodsDir: '', recallUrl: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/internal/capsules/v1`, tokenFile: '/workload', recallTimeoutMs: 1000 })
  return { calls, hooks, degraded, services }
}
/** @param {string} id @param {string} [text] @param {string} [kind] */
const input = (id, text = id, kind = 'user') => ({ role: 'user', source: { kind, rpcId: id }, content: [{ type: 'text', text }] })
/** @param {any[]} messages @param {number} [turn] */
const step = (messages, turn = 2) => ({ turn, step: 1, messages, agent: { id: 'agent', session: { id: 'session', header: {} }, inject: () => { throw new Error('Current context must never enter the next inbox') } } })

test('a step that enters injects nothing and asks the gateway about nothing: a native input carries no supplement', async t => {
  const f = await fixture(t)
  const payload = step([input('A')])
  const entered = await f.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(entered.messages.length, 1, 'no context is added to what enters')
  assert.deepEqual(f.calls, [], 'neither a read nor an acknowledgement of anything')
})

test('pre-assembly route service uses the workload-authenticated exact-input gateway', async t => {
  const f = await fixture(t)
  const resolve = f.services.get('evimedNativeRoute')
  assert.equal(typeof resolve, 'function')
  const inputs = [{ requestId: 'current', textDigest: await sha256Hex('current text') }]
  const routes = await resolve('session', inputs)
  assert.deepEqual(f.calls[0].body, { sessionId: 'session', inputs })
  assert.equal(f.calls[0].path.split('/').at(-1), 'native-route')
  assert.equal(f.calls[0].token, 'Bearer fixture-workload')
  assert.equal(routes[0].requestId, 'current')
  assert.equal(f.calls.length, 1)
})

test('an older control plane without route metadata cannot grant native capabilities', async t => {
  const f = await fixture(t, true)
  assert.deepEqual(await f.services.get('evimedNativeRoute')('session', [{ requestId: 'current', textDigest: await sha256Hex('current') }]), [])
})
