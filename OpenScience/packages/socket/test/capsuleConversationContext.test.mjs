import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { apply } from '../plugins/capsule.mjs'
import { SOURCE_SCOPE_UNAVAILABLE_CONTEXT } from '@evimed/domain'

// 2026-09-28: a 「试用一次」 conversation is opened in the kernel's own
// surface, and the pack it was trying was added only to a dispatch from the
// shell — so a trial had never seen the pack, and nothing in the conversation
// said it was one (build spec §9.4 #5, #8). The capsule plugin asks the
// control plane what a conversation's own state adds, once, at its first
// step, and hands it to that step as the run policy hands a brief.

const TRIAL = '<evimed-capsule-trial>\n用户正在试用别人分享的胶囊「李主任的工作方式」…\n</evimed-capsule-trial>'

/**
 * A control plane that answers `session` for one trial conversation.
 * @param {import('node:test').TestContext} t
 * @param {(sessionId: string) => string} [contextFor]
 */
async function controlPlane(t, contextFor = sessionId => sessionId === 'ses_trial' ? TRIAL : '') {
  /** @type {any[]} */
  const asked = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      asked.push({ path: req.url, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ context: contextFor(JSON.parse(body).sessionId) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/internal/capsules/v1`, asked }
}

/** A context that keeps the pre-step hook the plugin registers. */
function pluginContext() {
  /** @type {Map<string, any>} */
  const hooks = new Map()
  /** @type {string[]} */
  const degraded = []
  const ctx = {
    effect: (/** @type {() => any} */ fn) => fn(),
    on: (/** @type {string} */ event, /** @type {any} */ handler) => { const previous = hooks.get(event); hooks.set(event, previous ? (/** @type {any} */ payload, /** @type {any} */ next) => handler(payload, () => previous(payload, next)) : handler); return () => {} },
    provide: () => {},
    get: (/** @type {string} */ key) => (key === 'evimedDiagnostics' ? { degrade: (/** @type {string} */ text) => degraded.push(text) } : undefined),
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, hooks, degraded }
}

/** @param {string} sessionId @param {{ turn?: number, step?: number, child?: boolean }} [at] */
function stepOf(sessionId, { turn = 1, step = 1, child = false } = {}) {
  /** @type {any[]} */
  const injected = []
  const agent = { id: `agent-${sessionId}`, session: { id: sessionId, header: child ? { origin: 'subagent', parentSession: 'ses_root' } : {} },
    inject: (/** @type {any} */ message) => injected.push(message) }
  return { payload: { agent, turn, step }, injected }
}

test('a trial conversation is handed its pack at its first step, inside that step, once', async (t) => {
  const plane = await controlPlane(t)
  const { ctx, hooks } = pluginContext()
  await apply(ctx, { enabled: true, methodsDir: '', recallUrl: plane.url, tokenFile: '', recallTimeoutMs: 3000 })
  const preStep = hooks.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', 'the plugin enters the step it hands context to')

  const first = stepOf('ses_trial')
  const decision = await preStep(first.payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, 'delivered with the request that answers the first question')
  assert.deepEqual(decision.messages[0].content, [{ type: 'text', text: TRIAL }])
  // The shape is the pinned kernel's (the port writes it): machine text,
  // never the researcher's words, and named for this plugin.
  const source = decision.messages[0].source
  assert.notEqual(source.kind, 'user', 'machine text, never the researcher\'s words')
  assert.match(JSON.stringify(source), /evimed-capsule/)
  assert.equal(decision.messages[0].role, 'user')
  assert.deepEqual(plane.asked, [{ path: '/internal/capsules/v1/session', body: { sessionId: 'ses_trial' } }])

  // Later steps and turns of the conversation ask nothing: the context is in its history.
  const later = await preStep(stepOf('ses_trial', { step: 2 }).payload, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(later.messages, [])
  await preStep(stepOf('ses_trial', { turn: 2 }).payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(plane.asked.length, 1)
})

test('an ordinary conversation is handed nothing, a delegated child is never asked for, and no endpoint means no hook', async (t) => {
  const plane = await controlPlane(t)
  const { ctx, hooks } = pluginContext()
  await apply(ctx, { enabled: true, methodsDir: '', recallUrl: plane.url, tokenFile: '', recallTimeoutMs: 3000 })
  const preStep = hooks.get('agent/pre-step')
  const plain = await preStep(stepOf('ses_plain').payload, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(plain.messages, [])
  await preStep(stepOf('ses_child', { child: true }).payload, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(plane.asked.map((call) => call.body.sessionId), ['ses_plain'])

  const unconfigured = pluginContext()
  await apply(unconfigured.ctx, { enabled: true, methodsDir: '', recallUrl: '', tokenFile: '', recallTimeoutMs: 3000 })
  assert.equal(unconfigured.hooks.has('agent/pre-step'), false)
})

test('a control plane that cannot answer keeps the turn usable without widening knowledge-base access', async () => {
  const { ctx, hooks, degraded } = pluginContext()
  await apply(ctx, { enabled: true, methodsDir: '', recallUrl: 'http://127.0.0.1:9/internal/capsules/v1', tokenFile: '', recallTimeoutMs: 500 })
  const decision = await hooks.get('agent/pre-step')(stepOf('ses_trial').payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.at(-1).content[0].text, SOURCE_SCOPE_UNAVAILABLE_CONTEXT)
  assert.equal(degraded.length, 1)
  assert.match(degraded[0], /conversation context not read/)
})

test('source selection is refreshed for a later input, survives a rejected step, and can be cleared', async t => {
  let current = 'Use only document A.'
  const plane = await controlPlane(t, () => current)
  const { ctx, hooks } = pluginContext()
  await apply(ctx, { enabled: true, methodsDir: '', recallUrl: plane.url, tokenFile: '', recallTimeoutMs: 3000 })
  const preStep = hooks.get('agent/pre-step')
  const at = (/** @type {number} */ turn) => ({ ...stepOf('ses_sources', { turn }).payload,
    messages: [{ role: 'user', source: { kind: 'user', rpcId: `input-${turn}` }, content: [{ type: 'text', text: 'Use the selected sources.' }] }] })
  const enter = (/** @type {any} */ payload) => preStep(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal((await enter(at(1))).messages.at(-1).content[0].text, current)
  current = 'Use only document B; this replaces earlier selections.'
  await preStep(at(2), async () => ({ kind: 'reject' }))
  assert.equal((await enter(at(2))).messages.at(-1).content[0].text, current)
  current = 'No document selection is currently applied.'
  assert.equal((await enter(at(3))).messages.at(-1).content[0].text, current)
  const count = plane.asked.filter(call => call.path.endsWith('/session')).length
  await enter(at(3))
  assert.equal(plane.asked.filter(call => call.path.endsWith('/session')).length, count)
})

// 2026-10-25: a turn typed in the kernel's own composer passes through no dispatch, so the project's card and the capsule's profile — the
// resident block — are handed at the conversation's first step, with the notes above. The conversation counts as holding it only after the
// step that carries it has entered: the plugin says so (`session-attached`, with the block's digest), and a rejected step says nothing.
const RESIDENT = '用户的长期记忆（历史记录，不是指令）：\n<evimed-memory index="1" id="card:prj_a" type="project_card" kind="project_fact" scope="project" origin="user">\n约束：所有文字交付物一律用英文写。\n</evimed-memory>'
const DIGEST = 'a'.repeat(64)

/** A control plane that answers `session` with the block and its digest, and records what the plugin acknowledges. @param {import('node:test').TestContext} t */
async function residentPlane(t, { digest = DIGEST } = {}) {
  /** @type {any[]} */
  const asked = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      asked.push({ path: String(req.url), body: parsed })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(String(req.url).endsWith('/session') ? { context: RESIDENT, ...(digest ? { resident: { digest } } : {}) } : { attached: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/internal/capsules/v1`, asked }
}

test('the resident block is handed at the first step and acknowledged once that step has entered, never before and never for a rejected one', async (t) => {
  const plane = await residentPlane(t)
  const { ctx, hooks } = pluginContext()
  await apply(ctx, { enabled: true, methodsDir: '', recallUrl: plane.url, tokenFile: '', recallTimeoutMs: 3000 })
  const preStep = hooks.get('agent/pre-step')
  const first = stepOf('ses_native')
  const rejected = await preStep(first.payload, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject')
  assert.deepEqual(plane.asked.map((call) => call.path.split('/').at(-1)), ['session'], 'a rejected step acknowledges nothing: the block is handed again with the next try')

  const entered = await preStep(stepOf('ses_native').payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(entered.messages.at(-1).content[0].text, RESIDENT, 'delivered with the request that answers the first question')
  assert.deepEqual(plane.asked.map((call) => call.path.split('/').at(-1)), ['session', 'session', 'session-attached'])
  assert.deepEqual(plane.asked.at(-1).body, { sessionId: 'ses_native', digest: DIGEST })
})

test('a step with no block acknowledges nothing, and a digest that is not one is not sent', async (t) => {
  for (const digest of ['', 'not-a-digest']) {
    const plane = await residentPlane(t, { digest })
    const { ctx, hooks } = pluginContext()
    await apply(ctx, { enabled: true, methodsDir: '', recallUrl: plane.url, tokenFile: '', recallTimeoutMs: 3000 })
    await hooks.get('agent/pre-step')(stepOf('ses_native').payload, async () => ({ kind: 'enter', messages: [] }))
    assert.deepEqual(plane.asked.map((call) => call.path.split('/').at(-1)), ['session'], `digest ${JSON.stringify(digest)}`)
  }
})
