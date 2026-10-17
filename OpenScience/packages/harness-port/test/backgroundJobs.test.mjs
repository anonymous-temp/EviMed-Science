// The person's stop of a background job, through the kernel's job registry (`ctx.jobs`, 0.2.1-rc.2).
//
// What matters is one ordering: the wait must be registered in the same synchronous run as the kill, before the
// producer settles, because `tool-jobs` raises a completion notice for every settlement nobody was waiting for — and on
// an idle agent that notice is a new turn.
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentJobs, stopJobQuietly } from '../index.mjs'

/** A registry that records the order of calls and settles a kill only after the call that asked for it returned. */
function registry() {
  /** @type {string[]} */ const calls = []
  /** @type {Map<string, any>} */ const store = new Map([
    ['bash-a', { id: 'bash-a', owner: 'agent-1', status: 'running', waiters: [] }],
    ['bash-b', { id: 'bash-b', owner: 'agent-1', status: 'completed', waiters: [] }],
    ['bash-c', { id: 'bash-c', owner: 'agent-1', status: 'stopping', waiters: [] }],
    ['open-1', { id: 'open-1', status: 'running', waiters: [] }],
    ['bash-x', { id: 'bash-x', owner: 'agent-2', status: 'running', waiters: [] }],
  ])
  /** @type {boolean[]} */ const awaited = []
  const settle = (/** @type {any} */ job, /** @type {string} */ status) => {
    job.status = status
    awaited.push(job.waiters.length > 0)
    for (const resolve of job.waiters.splice(0)) resolve({ id: job.id, status })
  }
  return {
    calls,
    awaited,
    settle: (/** @type {string} */ id) => settle(store.get(id), 'killed'),
    service: {
      list: (/** @type {string} */ caller) => [...store.values()].filter((job) => job.owner === undefined || job.owner === caller).map(({ id, owner, status }) => ({ id, owner, kind: 'bash', status, startedAt: 1 })),
      get(/** @type {string} */ id, /** @type {string} */ caller) {
        calls.push(`get ${id}`)
        const job = store.get(id)
        if (!job) throw new Error(`unknown job ${id}`)
        if (job.owner !== undefined && job.owner !== caller) throw new Error(`job ${id} belongs to another session`)
        return { id, status: job.status }
      },
      kill(/** @type {string} */ id, /** @type {string} */ caller, /** @type {string} */ reason) {
        calls.push(`kill ${id} ${caller} ${reason}`)
        const job = store.get(id)
        job.status = 'stopping'
        void Promise.resolve().then(() => settle(job, 'killed'))
        return 'requested'
      },
      wait(/** @type {string} */ id, /** @type {number} */ timeoutMs, /** @type {string} */ caller) {
        calls.push(`wait ${id} ${timeoutMs} ${caller}`)
        const job = store.get(id)
        if (job.status !== 'running' && job.status !== 'stopping') return Promise.resolve({ id, status: job.status })
        return new Promise((resolve) => job.waiters.push(resolve))
      },
    },
  }
}

const ctxOf = (/** @type {any} */ jobs) => ({ get: (/** @type {string} */ key) => (key === 'jobs' ? jobs : undefined) })

test('an agent\'s jobs are its own: not another agent\'s, not the unowned ones the registry shows everyone', () => {
  const r = registry()
  assert.deepEqual(agentJobs(ctxOf(r.service), 'agent-1').map((job) => job.id), ['bash-a', 'bash-b', 'bash-c'])
  assert.deepEqual(agentJobs(ctxOf(undefined), 'agent-1'), [], 'a composition without the jobs rows has none')
})

test('a running job is killed and waited for before it can settle, so its settlement is awaited and raises no notice', async () => {
  const r = registry()
  const stopped = stopJobQuietly(ctxOf(r.service), 'agent-1', 'bash-a', 'stopped by the person', 1000)
  // Both calls happened before the stop returned its promise: the kill's settlement is still a microtask away.
  assert.deepEqual(r.calls, ['get bash-a', 'kill bash-a agent-1 stopped by the person', 'wait bash-a 1000 agent-1'])
  assert.equal(await stopped, 'killed')
  assert.deepEqual(r.awaited, [true])
})

test('a job already stopping is only waited for, a settled one is left alone, and one that left the registry is absent', async () => {
  const r = registry()
  const stopping = stopJobQuietly(ctxOf(r.service), 'agent-1', 'bash-c', 'stopped by the person', 1000)
  assert.deepEqual(r.calls, ['get bash-c', 'wait bash-c 1000 agent-1'])
  r.settle('bash-c')
  assert.equal(await stopping, 'killed')
  assert.deepEqual(r.awaited, [true])
  assert.equal(await stopJobQuietly(ctxOf(r.service), 'agent-1', 'bash-b', 'x', 1000), 'completed')
  assert.equal(await stopJobQuietly(ctxOf(r.service), 'agent-1', 'bash-gone', 'x', 1000), 'absent')
  assert.equal(await stopJobQuietly(ctxOf(undefined), 'agent-1', 'bash-a', 'x', 1000), 'absent')
  assert.ok(!r.calls.some((call) => call.startsWith('kill')), 'nothing but a running job is killed')
})
