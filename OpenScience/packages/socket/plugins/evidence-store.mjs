/**
 * The run mirror and its projection.
 *
 * Hidden knowledge: the shape of run-side durable state, and the fact that
 * nobody outside this process may read it in that shape. DSH's storage format
 * carries no compatibility promise — rc.8 changed the SQLite format with no
 * migration path — so the four tables are projected into one workspace file,
 * `.evimed-run/state.json`, which is what the control plane and the browser
 * read. The path guard makes that file unwritable by the model, so it is a
 * projection of what happened rather than a claim about it.
 *
 * @module @evimed/dsh-socket/plugins/evidence-store
 */

import { workspaceLayout } from '@evimed/domain'
import { configSchema, onDomainChanged, openDomain, writeWorkspaceFile } from '@evimed/harness-port'
import { RUN_DOMAIN_NAME, RUN_DOMAIN_SPEC, projectRunState } from '../src/runMirror.mjs'

const Schema = await configSchema()

export const name = 'evimed-evidence-store'

export const inject = ['storageDomain']

/**
 * @typedef {object} Config
 * @property {number} projectionDebounceMs
 */

export const Config = Schema.object({
  // Thirty subagents writing evidence produce bursts; rewriting the projection
  // per record would serialize them behind a file write. A deployment on slow
  // storage raises it.
  projectionDebounceMs: Schema.number().default(250)
    .description('How long to coalesce durable changes before rewriting the projection. Raise on slow storage.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const domain = await openDomain(ctx, RUN_DOMAIN_SPEC)
  const store = {
    domain,
    // camelCase handle, snake_case table: the medium requires the latter and
    // every reader in this bundle was written against the former.
    runMirror: domain.table('run_mirror'),
    planIndex: domain.table('plan_index'),
    evidence: domain.table('evidence'),
    gateRuns: domain.table('gate_runs'),
    /** @type {Set<string>} */
    qualityNotices: new Set(),
    /** @type {Set<string>} */
    degraded: new Set(),
    /** @type {Map<string, Record<string, any>>} */
    subagents: new Map(),
  }
  ctx.provide('evimedRun', store, true)
  ctx.provide('evimedDiagnostics', {
    /** @param {string} line */
    degrade(line) {
      store.degraded.add(line)
    },
    /** @param {string} line */
    notice(line) {
      store.qualityNotices.add(line)
    },
  }, true)

  /** @type {ReturnType<typeof setTimeout> | null} */
  let pending = null
  const flush = async () => {
    pending = null
    const run = [...store.runMirror.entries()][0]?.[1]
    if (!run) return
    const projection = projectRunState({
      run,
      planIndex: [...store.planIndex.entries()][0]?.[1],
      evidence: [...store.evidence.entries()].map(([, value]) => value),
      gateRuns: [...store.gateRuns.entries()].map(([, value]) => value),
      subagents: [...store.subagents.values()],
      qualityNotices: [...store.qualityNotices],
      degraded: [...store.degraded],
      now: new Date().toISOString(),
    })
    // isolated: evimed_run_projection_failures_total — a projection that cannot
    // be written must not end the run that produced it; the control plane
    // already treats an absent projection as "no run-side detail available".
    try {
      await writeWorkspaceFile(ctx, String(run.cwd ?? ctx.get('workspaceCwd') ?? '.'), workspaceLayout.runStateFile, `${JSON.stringify(projection, null, 2)}\n`)
    } catch {
      store.degraded.add('run-state projection unwritable')
    }
  }
  const schedule = () => {
    if (pending) return
    pending = setTimeout(() => {
      void flush()
    }, config.projectionDebounceMs)
  }

  ctx.effect(() => {
    const off = onDomainChanged(ctx, (change) => {
      if (change.domain !== RUN_DOMAIN_NAME) return
      schedule()
    })
    return async () => {
      off()
      if (pending) clearTimeout(pending)
      await flush()
      await domain.close()
    }
  })
}
