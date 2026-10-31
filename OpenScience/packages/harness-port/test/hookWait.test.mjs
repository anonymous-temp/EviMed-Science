// A step waits on its plugins' hooks, and the kernel hears a cancel only when they return.
//
// 2026-10-30, AutoResearchBench wide-625: a turn wrote `turn/start`, spliced its inbox and made no
// model request for thirty-one minutes; the driver's cancel at the twentieth was heard eleven minutes
// later. The kernel awaits `system-prompt/assemble` and `agent/pre-step` as plain promises and looks at
// the abort signal between them, so one hook that does not return holds the step and its cancel. The
// port waits on a hook through `waitOnHook`: a cancel ends the wait, a long wait leaves a line, and a
// caller that names a deadline has its step released to go on without that hook's context.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as port from '../index.mjs'
import { waitOnHook } from '../src/hookWait.mjs'

const never = () => new Promise(() => {})
const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a hook that returns is waited for, with no line and its own value', async () => {
  const events = /** @type {any[]} */ ([])
  const waited = await waitOnHook({ name: 'hook', work: async () => 'value', fallback: 'fallback', report: (event) => events.push(event) })
  assert.deepEqual({ value: waited.value, outcome: waited.outcome }, { value: 'value', outcome: 'done' })
  assert.deepEqual(events, [])
})

test('a hook that fails fails the wait: the caller\'s own handling of it is untouched', async () => {
  await assert.rejects(waitOnHook({ name: 'hook', work: async () => { throw new Error('boom') }, fallback: 0 }), /boom/)
  await assert.rejects(waitOnHook({ name: 'hook', work: () => { throw new Error('sync boom') }, fallback: 0 }), /sync boom/)
})

test('a cancel ends the wait at once, whatever the hook is waiting for', async () => {
  const controller = new globalThis.AbortController()
  const events = /** @type {any[]} */ ([])
  const started = Date.now()
  const waiting = waitOnHook({ name: 'hook', work: never, fallback: 'cancelled', signal: controller.signal, softMs: 0, abortGraceMs: 30, report: (event) => events.push(event) })
  await pause(20)
  controller.abort()
  const waited = await waiting
  assert.equal(waited.outcome, 'aborted')
  assert.equal(waited.value, 'cancelled')
  assert.ok(Date.now() - started < 1_000, 'heard within the grace, not when the hook gives up')
  assert.deepEqual(events.map((event) => event.kind), ['aborted'])
  assert.equal(events[0].name, 'hook')
})

test('a hook that returns within the grace after a cancel still has its answer taken', async () => {
  const controller = new globalThis.AbortController()
  const waited = await waitOnHook({
    name: 'hook', fallback: 'fallback', signal: controller.signal, softMs: 0, abortGraceMs: 200,
    work: async () => { controller.abort(); await pause(20); return 'its answer' },
  })
  assert.deepEqual({ value: waited.value, outcome: waited.outcome }, { value: 'its answer', outcome: 'done' })
})

test('a signal that was already aborted never starts the wait', async () => {
  const controller = new globalThis.AbortController()
  controller.abort()
  let started = false
  const waited = await waitOnHook({ name: 'hook', work: () => { started = true; return 1 }, fallback: 0, signal: controller.signal })
  assert.equal(waited.outcome, 'aborted')
  assert.equal(started, false)
})

test('a long wait leaves one line naming what is awaited, and the hook may still return', async () => {
  const events = /** @type {any[]} */ ([])
  const waited = await waitOnHook({ name: 'agent/pre-step (evimed-capsule)', work: async () => { await pause(80); return 'late' }, fallback: 'x', softMs: 20, report: (event) => events.push(event) })
  assert.equal(waited.value, 'late')
  assert.equal(waited.outcome, 'done')
  assert.deepEqual(events.map((event) => [event.kind, event.name]), [['slow', 'agent/pre-step (evimed-capsule)']])
  assert.ok(events[0].ms >= 15)
})

test('a deadline releases the step to go on with the fallback, and says so; the late hook is not an unhandled rejection', async () => {
  const events = /** @type {any[]} */ ([])
  const waited = await waitOnHook({
    name: 'hook', fallback: 'fallback', softMs: 0, hardMs: 40, report: (event) => events.push(event),
    work: async () => { await pause(120); throw new Error('late failure nobody reads') },
  })
  assert.deepEqual({ value: waited.value, outcome: waited.outcome }, { value: 'fallback', outcome: 'deadline' })
  assert.deepEqual(events.map((event) => event.kind), ['deadline'])
  await pause(160) // the abandoned hook fails here; node would end this process on an unhandled rejection
})

test('no deadline is the default: a hook may take as long as it needs (the compaction row waits for a summary)', async () => {
  const waited = await waitOnHook({ name: 'hook', work: async () => { await pause(60); return 'summary' }, fallback: 'x', softMs: 0 })
  assert.equal(waited.value, 'summary')
})

// ——— the two wrappers every plugin's first-step hook goes through ———

const message = (/** @type {string} */ requestId, /** @type {string} */ text) => ({ role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] })

/** @param {(event: string, fn: any) => void} [seen] */
function context(seen = () => {}) {
  /** @type {Record<string, any>} */ const handlers = {}
  const degraded = /** @type {string[]} */ ([])
  return {
    handlers, degraded,
    ctx: {
      on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn; seen(event, fn); return () => {} },
      get: (/** @type {string} */ name) => (name === 'evimedDiagnostics' ? { forSession: () => ({ degrade: (/** @type {string} */ line) => degraded.push(line) }) } : null),
    },
  }
}

test('a cancelled turn is refused by a pre-step hook that never returns, at the moment of the cancel', async () => {
  const { ctx, handlers } = context()
  const controller = new globalThis.AbortController()
  port.onPreStep(ctx, never, () => ({ first: true, root: true }), { label: 'evimed-test' })
  const agent = { id: 'a', session: { id: 's' }, inject: () => {} }
  const decision = handlers[port.SEAMS.events.preStep]({ agent, turn: 1, step: 1, messages: [message('A', 'q')], signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }))
  await pause(20)
  controller.abort()
  assert.equal((await decision).kind, 'reject', 'the kernel then ends the turn: it throws on the aborted signal after the hook chain returns')
})

test('a pre-step hook that names a deadline releases its step and is recorded among the run\'s degradations', async () => {
  const { ctx, handlers, degraded } = context()
  port.onPreStep(ctx, never, () => ({ first: true, root: true }), { label: 'evimed-test', hardMs: 40 })
  const agent = { id: 'a', session: { id: 's' }, inject: () => {} }
  const entered = await handlers[port.SEAMS.events.preStep]({ agent, turn: 1, step: 1, messages: [message('A', 'q')], signal: new globalThis.AbortController().signal }, async () => ({ kind: 'enter', messages: [message('A', 'q')] }))
  assert.equal(entered.kind, 'enter', 'the step goes on without what the hook would have added')
  assert.equal(degraded.length, 1)
  assert.match(degraded[0], /agent\/pre-step \(evimed-test\)/)
  assert.match(degraded[0], /went on without it/)
})

test('without a deadline a slow pre-step hook is waited for, as before', async () => {
  const { ctx, handlers, degraded } = context()
  port.onPreStep(ctx, async () => { await pause(60); return { allow: true } }, () => ({ first: true, root: true }))
  const agent = { id: 'a', session: { id: 's' }, inject: () => {} }
  const entered = await handlers[port.SEAMS.events.preStep]({ agent, turn: 1, step: 1, messages: [], signal: new globalThis.AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(entered.kind, 'enter')
  assert.deepEqual(degraded, [])
})

test('a prompt-assembly hook that names a deadline is released to the unchanged assembly, and a cancelled one is not started', async () => {
  const { ctx, handlers, degraded } = context()
  let calls = 0
  port.onClaimedPromptAssemble(ctx, () => { calls += 1; return never() }, { label: 'evimed-test', hardMs: 40 })
  const agent = { id: 'a', session: { id: 's' }, inject: () => {} }
  const assembly = { sections: [], tools: [] }
  const next = async () => 'assembled'
  assert.equal(await handlers[port.SEAMS.events.promptAssemble](assembly, { agent, signal: new globalThis.AbortController().signal }, next), 'assembled')
  assert.equal(calls, 1)
  assert.match(degraded[0] ?? '', /system-prompt\/assemble \(evimed-test\)/)
  const cancelled = new globalThis.AbortController()
  cancelled.abort()
  assert.equal(await handlers[port.SEAMS.events.promptAssemble](assembly, { agent, signal: cancelled.signal }, next), 'assembled')
  assert.equal(calls, 1, 'a turn already cancelled does not start the hook')
})

test('a prompt-assembly hook that returns changed still changes the tools, as before', async () => {
  const { ctx, handlers } = context()
  port.onClaimedPromptAssemble(ctx, async () => true)
  const agent = { id: 'a', session: { id: 's' }, inject: () => {} }
  const assembly = { sections: [], tools: [{ name: 'x' }] }
  assert.equal(await handlers[port.SEAMS.events.promptAssemble](assembly, { agent, signal: new globalThis.AbortController().signal }, async () => 'next'), 'next')
})
