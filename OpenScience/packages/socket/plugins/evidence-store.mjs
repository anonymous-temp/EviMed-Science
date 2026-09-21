/**
 * The run mirror and its projection.
 *
 * Hidden knowledge: the shape of run-side durable state, and the fact that
 * nobody outside this process may read it in that shape. DSH's storage format
 * carries no compatibility promise — rc.8 changed the SQLite format with no
 * migration path — so the four tables are projected into one workspace file
 * per control-plane run. `.evimed-run/state.json` remains the native-turn
 * compatibility view. The control plane scopes each projection against the
 * run and observed workflow receipts, and never treats it as final provenance.
 *
 * @module @evimed/dsh-socket/plugins/evidence-store
 */

import { errorMessage } from '../src/runPolicy.mjs'
import { runStateFileFor, workspaceLayout } from '@evimed/domain'
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
    /** @type {Map<string, Set<string>>} */
    runQualityNotices: new Map(),
    /** @type {Map<string, Set<string>>} */
    runDegraded: new Map(),
    /** @type {Map<string, Record<string, any>>} */
    subagents: new Map(),
    /** Current control-plane run per root session. Historical domain rows stay
     * durable, while projections select only these run ids. */
    /** @type {Map<string, string>} */
    activeRuns: new Map(),
    /** Root and child session ids mapped to their owning run inside this
     * isolated agent store; no process-global custom service is published. */
    /** @type {Map<string, string>} */
    sessionRuns: new Map(),
    /**
     * Skill bodies this composition put into the session's own context rather
     * than leaving the model to fetch them with the `skill` tool.
     *
     * A property of the runtime, not of a run — the composition either injects
     * the persona or it does not — so it is one set, merged into every
     * projection the way `qualityNotices` is.
     * @type {Set<string>}
     */
    injectedSkills: new Set(),
    /**
     * The methods mounted into this runtime, by name and body digest — the
     * root session's own receipt of them (`evimed-capsule` reports it). One
     * set for the runtime, like `injectedSkills`: every session reads the same
     * directory.
     * @type {Map<string, string>}
     */
    mountedMethods: new Map(),
    /**
     * What a run-level tool may look at, per root session: the deliverables
     * this conversation planned, and a resolver for the claim ids they carry.
     *
     * Written by the run policy, which owns the plan; read by the reviewer,
     * which otherwise reads `deliverables/` — the whole project workspace,
     * every conversation that ever ran in it. One did: a GEO run's review came
     * back judging another conversation's aspirin claims (2026-09-20).
     * @type {Map<string, { deliverableIds: string[], resolveClaimIds: () => Promise<Set<string>> }>}
     */
    reviewScopes: new Map(),
    /** @param {string} sessionId */
    reviewScope(sessionId) { return this.reviewScopes.get(sessionId) ?? null },
    /** @param {string} sessionId @returns {string} */
    runIdForSession(sessionId) { return this.sessionRuns.get(sessionId) ?? '' },
  }
  ctx.provide('evimedRun', store, true)
  /** @param {Map<string, Set<string>>} map @param {string} runId */
  const diagnosticSet = (map, runId) => {
    let values = map.get(runId)
    if (!values) {
      values = new Set()
      map.set(runId, values)
    }
    return values
  }
  /** @param {string} runId */
  const scopedDiagnostics = (runId) => ({
    /** @param {string} line */
    degrade(line) { diagnosticSet(store.runDegraded, runId).add(line) },
    /** @param {string} line */
    notice(line) { diagnosticSet(store.runQualityNotices, runId).add(line) },
  })
  ctx.provide('evimedDiagnostics', {
    /** @param {string} line */
    degrade(line) {
      store.degraded.add(line)
    },
    /** @param {string} line */
    notice(line) {
      store.qualityNotices.add(line)
    },
    /**
     * Record that a skill body was handed to the model directly.
     *
     * Reached by `evimed-guidance`, which runs inside the agent preset's own
     * realm: a preset row may not publish a process-global service (the kernel
     * refuses to mount the preset if it tries), but it may CALL one the host
     * composition provides — which is the direction this fact travels anyway.
     * The control plane's completion gate reads the result out of the run-state
     * projection and counts an injected skill as a loaded one.
     * @param {string} skillName
     */
    injectedSkill(skillName) {
      const skill = String(skillName ?? '').trim()
      if (skill) store.injectedSkills.add(skill)
    },
    /**
     * Record the methods this runtime mounted, by name and body digest.
     * Reached by `evimed-capsule`, from inside the agent preset, for the same
     * reason as `injectedSkill`.
     * @param {readonly { name: string, digest: string }[]} methods
     */
    mountedMethods(methods) {
      for (const method of methods ?? []) {
        const methodName = String(method?.name ?? '').trim()
        const digest = String(method?.digest ?? '').trim()
        if (methodName && digest) store.mountedMethods.set(methodName, digest)
      }
    },
    /** @param {string} runId */
    forRun(runId) { return runId ? scopedDiagnostics(runId) : this },
    /** @param {string} sessionId */
    forSession(sessionId) {
      const runId = String(store.runIdForSession(sessionId) ?? '')
      return runId ? scopedDiagnostics(runId) : this
    },
  }, true)

  /** @type {ReturnType<typeof setTimeout> | null} */
  let pending = null
  const flush = async () => {
    pending = null
    const mirrors = [...store.runMirror.entries()].map(([, value]) => value)
    if (!mirrors.length) return
    const activeIds = new Set(store.activeRuns.values())
    const runs = activeIds.size ? mirrors.filter((run) => activeIds.has(String(run.runId ?? ''))) : mirrors.slice(-1)
    const projections = runs.map((run) => projectRunState({
      run,
      planIndex: [...store.planIndex.entries()].map(([, value]) => value).find((value) => value.runId === run.runId),
      evidence: [...store.evidence.entries()].map(([, value]) => value).filter((value) => value.runId === run.runId),
      gateRuns: [...store.gateRuns.entries()].map(([, value]) => value).filter((value) => value.runId === run.runId),
      subagents: [...store.subagents.values()].filter((value) => value.runId === run.runId),
      // What the composition put in front of the model without the model
      // having to ask for it. Recorded by `evimed-guidance` through the
      // diagnostics service; empty in a composition that injects nothing,
      // which the gate reads as "the model had to load it itself", exactly as
      // it did before this existed.
      injectedSkills: [...store.injectedSkills],
      mountedMethods: [...store.mountedMethods].map(([methodName, digest]) => ({ name: methodName, digest })),
      qualityNotices: [...store.qualityNotices, ...(store.runQualityNotices.get(run.runId) ?? [])],
      degraded: [...store.degraded, ...(store.runDegraded.get(run.runId) ?? [])],
      now: new Date().toISOString(),
    }))
    for (const projection of projections) {
      const run = runs.find((candidate) => candidate.runId === projection.runId)
      try {
        await writeWorkspaceFile(ctx, String(run?.cwd ?? ctx.get('workspaceCwd') ?? '.'), runStateFileFor(projection.runId), `${JSON.stringify(projection, null, 2)}\n`)
      } catch (error) {
        recordProjectionFailure(ctx, store, error)
      }
    }
    // Native UI adoption predates per-run paths. Keep the newest active run at
    // the established path while control-plane runs read their own file.
    const native = projections.filter((projection) => projection.runId.startsWith('native_'))
    const sharedCandidates = native.length ? native : projections
    const latest = sharedCandidates.toSorted((left, right) => Date.parse(
      String(runs.find((run) => run.runId === left.runId)?.startedAt ?? ''),
    ) - Date.parse(String(runs.find((run) => run.runId === right.runId)?.startedAt ?? ''))).at(-1)
    if (latest) {
      const run = runs.find((candidate) => candidate.runId === latest.runId)
      try {
        await writeWorkspaceFile(ctx, String(run?.cwd ?? ctx.get('workspaceCwd') ?? '.'), workspaceLayout.runStateFile, `${JSON.stringify(latest, null, 2)}\n`)
      } catch (error) {
        recordProjectionFailure(ctx, store, error)
      }
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

/** @param {any} ctx @param {Record<string, any>} store @param {unknown} error */
function recordProjectionFailure(ctx, store, error) {
  // The reason, not just the fact. This failure is diagnostic and must not end
  // the run whose projection could not be written.
  const reason = `run-state projection unwritable: ${errorMessage(error)}`
  store.degraded.add(reason)
  ctx.get('evimedDiagnostics')?.degrade?.(reason)
}
