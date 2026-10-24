import assert from 'node:assert/strict'
import test from 'node:test'

import { projectRunState } from '../src/runMirror.mjs'

// The receipt of what a run carried is the conversation's own, with why each card was there (2026-10-23): the runtime's mount is
// rewritten for each conversation that begins, so what it mounted last is not what an older conversation was given.

test('the run-state projection keeps why a method\'s card was there, and nothing else about a receipt it was not given', () => {
  const digest = (/** @type {string} */ letter) => `sha256:${letter.repeat(64)}`
  const projection = projectRunState({
    run: { runId: 'run_1', sessionId: 's1' }, planIndex: undefined, evidence: [], now: '2026-10-23T12:00:00.000Z',
    mountedMethods: [
      { name: 'grade-first', digest: digest('a'), reason: 'similarity' },
      { name: 'old-receipt', digest: digest('b') },
      { name: 'odd', digest: digest('c'), reason: '' },
      { name: '', digest: digest('d'), reason: 'similarity' },
    ],
  })
  assert.deepEqual(projection.mountedMethods, [
    { name: 'grade-first', digest: digest('a'), reason: 'similarity' },
    { name: 'old-receipt', digest: digest('b') },
    { name: 'odd', digest: digest('c') },
  ])
})

test('each conversation\'s projection carries the methods it was given, and a run with no conversation receipt carries the runtime\'s', async () => {
  const { apply } = await import('../plugins/evidence-store.mjs')
  /** @type {Map<string, Function[]>} */ const listeners = new Map()
  /** @type {Map<string, any>} */ const written = new Map()
  /** @type {Map<string, Map<string, any>>} */ const tables = new Map()
  const table = (/** @type {string} */ name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    const rows = /** @type {Map<string, any>} */ (tables.get(name))
    return {
      put: async (/** @type {string} */ key, /** @type {any} */ value) => { rows.set(key, value); ctx.emit('domain/changed', { domain: 'evimed_run', table: name, key, operation: 'put', value }) },
      entries: () => [...rows.entries()],
      values: () => [...rows.values()],
    }
  }
  const services = new Map([
    ['storageDomain', { open: async () => ({ table, close: async () => {} }) }],
    ['fs', { resolve: async (/** @type {string} */ relative, /** @type {any} */ options) => `${options?.cwd ?? ''}/${relative}`, writeText: async (/** @type {string} */ target, /** @type {string} */ content) => { written.set(target, content) } }],
  ])
  const ctx = {
    get: (/** @type {string} */ key) => services.get(key),
    on(/** @type {string} */ event, /** @type {Function} */ handler) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); return () => {} },
    emit: (/** @type {string} */ event, /** @type {any[]} */ ...args) => (listeners.get(event) ?? []).map((handler) => handler(...args)),
    effect(/** @type {any} */ fn) { return fn() },
    provide(/** @type {string} */ name, /** @type {any} */ value) { services.set(name, value) },
  }
  for (const key of ['storageDomain', 'fs']) Object.defineProperty(ctx, key, { get: () => services.get(key), configurable: true })
  await apply(ctx, { projectionDebounceMs: 1 })
  const store = /** @type {any} */ (ctx.get('evimedRun'))
  const diagnostics = /** @type {any} */ (ctx.get('evimedDiagnostics'))
  const digest = (/** @type {string} */ letter) => `sha256:${letter.repeat(64)}`
  // What the runtime was launched with, and what the second conversation was given when it began.
  diagnostics.mountedMethods([{ name: 'launched', digest: digest('a') }])
  diagnostics.sessionMethods('s2', [{ name: 'grade-first', digest: digest('b'), reason: 'similarity' }, { name: 'slides', digest: digest('c'), reason: 'explore' }, { name: '', digest: 'x' }])
  store.activeRuns.set('s1', 'run_1')
  store.activeRuns.set('s2', 'run_2')
  await store.runMirror.put('run_1', { runId: 'run_1', sessionId: 's1', cwd: '/workspace', startedAt: '2026-10-23T00:00:00Z' })
  await store.runMirror.put('run_2', { runId: 'run_2', sessionId: 's2', cwd: '/workspace', startedAt: '2026-10-23T00:01:00Z' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const first = JSON.parse(written.get('/workspace/.evimed-run/runs/run_1/state.json'))
  const second = JSON.parse(written.get('/workspace/.evimed-run/runs/run_2/state.json'))
  assert.deepEqual(first.mountedMethods, [{ name: 'launched', digest: digest('a') }], 'no receipt of its own: the runtime\'s')
  assert.deepEqual(second.mountedMethods, [{ name: 'grade-first', digest: digest('b'), reason: 'similarity' }, { name: 'slides', digest: digest('c'), reason: 'explore' }])
  // A conversation renewed is the new receipt, and the table is bounded.
  diagnostics.sessionMethods('s2', [{ name: 'beta', digest: digest('d'), reason: 'similarity' }])
  assert.deepEqual(store.mountedMethodsBySession.get('s2'), [{ name: 'beta', digest: digest('d'), reason: 'similarity' }])
  for (let index = 0; index < 300; index += 1) diagnostics.sessionMethods(`bulk-${index}`, [{ name: 'm', digest: digest('e') }])
  assert.ok(store.mountedMethodsBySession.size <= 256)
  assert.equal(store.mountedMethodsBySession.has('s2'), false, 'the oldest conversation is the one given up')
})
