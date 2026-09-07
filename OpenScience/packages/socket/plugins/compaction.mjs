/**
 * The compaction service, replaced rather than extended.
 *
 * Hidden knowledge: this is a provider swap, not a new agent-face plugin. It
 * registers no tool, adds no prompt and changes no seam the model can see —
 * the model cannot tell this row from the one it replaces. What it changes is
 * what survives a compaction: the base engine writes a good prose summary and
 * loses the handles the run needs to carry on (the plan file, the source
 * ledger, the deliverable paths and their digests, the issue currently being
 * repaired), because prose is what it was asked for. A run that comes back from
 * a compaction without its handles does not fail; it starts inventing paths.
 *
 * The engine is resolved lazily and the base class is never imported at module
 * load. That is not tidiness: `@deepseek-ai/dsh-compaction-basic` ships in the
 * runtime image and is not installed in this workspace, so a static import
 * would make the socket bundle unloadable in every test that touches it.
 * `loadEvimedCompactionEngine` resolves the pin through the port and runs a
 * seam probe first — a renamed `summarize` hook upstream is not an error at
 * run time, it is a method nobody calls, and the run would compact with no
 * handle protection while every test still passed.
 *
 * Falling back is always allowed. Every failure path in the engine ends at the
 * base engine's own summary plus a recorded degradation, because a compaction
 * that does not happen is the context wall this whole path exists to avoid.
 *
 * @module @evimed/dsh-socket/plugins/compaction
 */

import {
  COMPACTION_POLICIES,
  compactionConfigFromEnv,
  configSchema,
  loadEvimedCompactionEngine,
  openDomain,
} from '@evimed/harness-port'
import { RUN_DOMAIN_SPEC, projectRunState } from '../src/runMirror.mjs'

const Schema = await configSchema()

export const name = 'evimed-compaction'

// The run mirror, read-only. Opening the same domain the evidence store owns is
// how the handles are read from the projection rather than from workspace files:
// a second reader of the same tables cannot go stale against them, and a file
// read could.
export const inject = ['storageDomain']

/**
 * @typedef {object} Config
 * @property {string} policy
 * @property {number} thresholdRatio
 * @property {number} retainRatio
 * @property {number} maxTokens
 */

export const Config = Schema.object({
  policy: Schema.string().default('basic')
    .description('`basic` keeps the kernel engine; `structured` preserves the run\'s durable handles across a compaction.'),
  thresholdRatio: Schema.number().default(0.8)
    .description('Fraction of the declared context window at which pressure compaction fires.'),
  retainRatio: Schema.number().default(0.16)
    .description('Fraction of the window kept verbatim after the summary node.'),
  maxTokens: Schema.number().default(8192)
    .description('Ceiling for the summary itself.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const derived = compactionConfigFromEnv({
    EVIMED_COMPACTION_POLICY: config.policy,
    EVIMED_COMPACTION_THRESHOLD_RATIO: String(config.thresholdRatio),
    EVIMED_COMPACTION_RETAIN_RATIO: String(config.retainRatio),
    EVIMED_COMPACTION_MAX_TOKENS: String(config.maxTokens),
  })
  if (!COMPACTION_POLICIES.includes(derived.policy) || derived.policy === 'basic') {
    // `basic` is not a degraded mode, it is the kernel's own engine mounted by
    // the row this one replaces. Registering nothing leaves the service exactly
    // as the kernel composed it, which is what the default has to mean while
    // the context-fidelity measurement has no distribution to argue from.
    return
  }
  const domain = await openDomain(ctx, RUN_DOMAIN_SPEC)
  const tables = {
    runMirror: domain.table('run_mirror'),
    planIndex: domain.table('plan_index'),
    evidence: domain.table('evidence'),
  }
  const Engine = await loadEvimedCompactionEngine({
    readHandles: (agent) => readRunHandles(tables, agent),
    observe: (observation) => {
      // The kernel's own observation bus is the only thing the control plane
      // can hear from in here. A degradation that is not emitted is a policy
      // that cannot be measured, and this policy may not be changed again
      // until it has been.
      ctx.emit?.(`compaction/${observation.kind}`, observation)
    },
  })
  ctx.plugin(Engine, {
    thresholdRatio: derived.config.thresholdRatio,
    ...(derived.config.retainTokens === undefined
      ? { retainRatio: derived.config.retainRatio }
      : { retainTokens: derived.config.retainTokens }),
    maxTokens: derived.config.maxTokens,
  })
}

/**
 * The handles a summary must carry forward.
 *
 * Read from the run mirror rather than from the workspace: the mirror is what
 * the run policy already keeps current, and a file read would give the
 * compaction engine a second, independently stale view of the same facts.
 * Anything unavailable is simply absent — a handle the engine cannot name is
 * one it will not demand, and a compaction that refuses to happen because the
 * projection was mid-write is worse than one that carries fewer handles.
 *
 * @param {{runMirror: any, planIndex: any, evidence: any}} tables
 * @param {any} agent
 * @returns {Promise<import('@evimed/harness-port').StateHandle[]>}
 */
export async function readRunHandles(tables, agent) {
  /** @type {import('@evimed/harness-port').StateHandle[]} */
  const handles = []
  /** @param {string} kind @param {unknown} id @param {string} [note] */
  const add = (kind, id, note) => {
    const value = typeof id === 'string' ? id.trim() : ''
    if (!value) return
    handles.push(note ? { kind, id: value, note } : { kind, id: value })
  }
  try {
    const sessionId = String(agent?.sessionId ?? agent?.session?.id ?? '')
    const rows = await tables.runMirror.select({ sessionId })
    const run = Array.isArray(rows) ? rows.at(-1) : rows
    if (!run) return handles
    const planIndex = (await tables.planIndex.select({ runId: run.runId }))?.at?.(-1) ?? null
    const evidence = (await tables.evidence.select({ runId: run.runId })) ?? []
    const state = projectRunState({ run, planIndex, evidence, now: '' })
    add('plan', 'task-plan.json', 'the plan is authoritative; this summary is not')
    for (const item of state.plan.items ?? []) {
      add('deliverable', item.deliverableId, item.state ? `plan item is ${item.state}` : undefined)
    }
    for (const record of evidence) add('source', record?.sourceId, record?.status)
    const limits = state.budget?.limits ?? {}
    if (limits.maxTokens) add('budget', `${state.budget.tokens}/${limits.maxTokens} tokens`)
  } catch {
    // isolated: evimed_compaction_handles_unavailable_total
  }
  return handles
}
