/**
 * The run mirror: durable run-side state and its projection.
 *
 * Hidden knowledge: what the control plane is allowed to read. DSH's own
 * storage format carries no compatibility promise, so nothing outside this
 * process may open it. Instead the four tables below are projected into one
 * workspace file, `.evimed-run/state.json`, which the control plane and the
 * browser read — and which the path guard makes unwritable by the model.
 *
 * There is no `claims` table. A claim's binding to its sources already exists,
 * in `clinical-evidence-matrix.json`; a second copy would be a second truth.
 *
 * @module @evimed/dsh-socket/src/runMirror
 */

import { transition } from '@evimed/domain'

/** Domain name and version. A medium stamped with another version refuses to open.
 *
 *  Underscore, not hyphen: the harness validates domain names against
 *  `/^[a-z][a-z0-9_]*$/` and refuses to register one with a hyphen. This is the
 *  storage domain's identifier only — the workspace directory the projection
 *  lands in stays `.evimed-run`, because that is a path the control plane and
 *  the browser both read by name. */
export const RUN_DOMAIN_NAME = 'evimed_run'
export const RUN_DOMAIN_VERSION = 1

/**
 * The table layout, in the port's field vocabulary. Records are validated at
 * the durable boundary by the harness; their `status` fields are validated here
 * by `transition()`, which is the only writer.
 */
export const RUN_DOMAIN_SPEC = Object.freeze({
  name: RUN_DOMAIN_NAME,
  version: RUN_DOMAIN_VERSION,
  // Table names are snake_case because the medium says so: the harness
  // validates every table name against the same /^[a-z][a-z0-9_]*$/ it applies
  // to the domain name, and refuses to open a domain that breaks it. The
  // camelCase names the code reads by are mapped onto these where the handles
  // are built, so the medium's vocabulary stops at the medium.
  tables: Object.freeze({
    /** runId → the run's identity and its running totals. */
    run_mirror: Object.freeze({
      runId: 'string',
      sessionId: 'string',
      // Where the run's workspace is. The projection has to be written into it,
      // and the store is the only place that still knows after a session's own
      // state has been discarded.
      cwd: 'string',
      bundleVersion: 'string',
      domainVersion: 'string',
      briefDigest: 'string',
      attempts: 'number',
      steps: 'number',
      tokens: 'number',
      children: 'number',
      budget: 'json',
      lastTurnEnd: 'json?',
      startedAt: 'string',
    }),
    /** runId → an index over task-plan.json. Not a second plan: an index. */
    plan_index: Object.freeze({
      runId: 'string',
      revision: 'number',
      items: 'json',
    }),
    /** evidenceId → one retrieved source and how far it got. */
    evidence: Object.freeze({
      evidenceId: 'string',
      runId: 'string',
      tool: 'string',
      query: 'string',
      sourceId: 'string',
      doi: 'string?',
      artifactPath: 'string?',
      digest: 'string',
      status: 'string',
      recordedAt: 'string',
    }),
    /** `${runId}:${n}` → one gate verdict, with its four verification metrics. */
    gate_runs: Object.freeze({
      runId: 'string',
      attempt: 'number',
      deliverableId: 'string',
      contractKind: 'string',
      issues: 'json',
      // The check that raised each issue, in the same order. Without it a gate
      // run records what the gate said and never which rule said it, and no
      // per-rule false-positive rate can be computed from the ledger at all.
      checks: 'json',
      metrics: 'json',
      ok: 'boolean',
      at: 'string',
    }),
  }),
})

/**
 * Applies a status change to a plan item. Routed through the domain's
 * `transition()` so an illegal move throws where it was attempted.
 * @param {{ id: string, status: string } & Record<string, any>} item
 * @param {string} event
 * @param {Record<string, any>} [patch]
 * @returns {Record<string, any>}
 */
export function advancePlanItem(item, event, patch = {}) {
  const status = transition('planItem', item.status, event)
  return { ...item, ...patch, status }
}

/**
 * @param {{ status: string } & Record<string, any>} record
 * @param {string} event
 * @param {Record<string, any>} [patch]
 * @returns {Record<string, any>}
 */
export function advanceEvidence(record, event, patch = {}) {
  const status = transition('evidence', record.status, event)
  return { ...record, ...patch, status }
}

/**
 * @typedef {object} RunStateProjection
 * @property {number} formatVersion
 * @property {string} runId
 * @property {string} sessionId
 * @property {string} bundleVersion
 * @property {string} domainVersion
 * @property {string} updatedAt
 * @property {{ revision: number, items: Record<string, any>[] }} plan
 * @property {{ steps: number, tokens: number, children: number, limits: Record<string, number> }} budget
 * @property {{ total: number, byStatus: Record<string, number> }} evidence
 * @property {Record<string, any>[]} gateRuns
 * @property {Record<string, any>[]} subagents
 * @property {string[]} qualityNotices
 * @property {string[]} degraded
 */

/** Bumped when the projection's shape changes; readers accept N-1. */
export const RUN_STATE_FORMAT_VERSION = 1

/**
 * Builds the whole projection from the four tables. Deterministic and total:
 * a missing table is an empty section, never a thrown error, because this runs
 * on every durable change and a throw here would take out the run.
 * @param {{
 *   run: Record<string, any> | undefined,
 *   planIndex: Record<string, any> | undefined,
 *   evidence: readonly Record<string, any>[],
 *   gateRuns: readonly Record<string, any>[],
 *   subagents?: readonly Record<string, any>[],
 *   qualityNotices?: readonly string[],
 *   degraded?: readonly string[],
 *   now: string,
 * }} input
 * @returns {RunStateProjection}
 */
export function projectRunState(input) {
  const run = input.run ?? {}
  /** @type {Record<string, number>} */
  const byStatus = {}
  for (const record of input.evidence ?? []) {
    const status = String(record?.status ?? 'queued')
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  const budget = run.budget && typeof run.budget === 'object' ? run.budget : {}
  return {
    formatVersion: RUN_STATE_FORMAT_VERSION,
    runId: String(run.runId ?? ''),
    sessionId: String(run.sessionId ?? ''),
    bundleVersion: String(run.bundleVersion ?? ''),
    domainVersion: String(run.domainVersion ?? ''),
    updatedAt: input.now,
    plan: {
      revision: Number(input.planIndex?.revision ?? 0),
      items: Array.isArray(input.planIndex?.items) ? input.planIndex.items : [],
    },
    budget: {
      steps: Number(run.steps ?? 0),
      tokens: Number(run.tokens ?? 0),
      children: Number(run.children ?? 0),
      limits: {
        maxSteps: Number(budget.maxSteps ?? 0),
        maxTokens: Number(budget.maxTokens ?? 0),
        maxChildren: Number(budget.maxChildren ?? 0),
      },
    },
    evidence: { total: (input.evidence ?? []).length, byStatus },
    gateRuns: [...(input.gateRuns ?? [])].sort((left, right) => Number(left.attempt ?? 0) - Number(right.attempt ?? 0)),
    subagents: [...(input.subagents ?? [])],
    qualityNotices: [...(input.qualityNotices ?? [])],
    degraded: [...(input.degraded ?? [])],
  }
}

/**
 * Evidence older than the staleness window that never became readable. It
 * counts toward the "unresolved" verification metric, which is the only place a
 * source that quietly never arrived becomes visible.
 * @param {readonly Record<string, any>[]} evidence
 * @param {number} staleMinutes
 * @param {number} nowMs
 * @returns {Record<string, any>[]}
 */
export function staleEvidence(evidence, staleMinutes, nowMs) {
  const cutoff = nowMs - staleMinutes * 60_000
  return (evidence ?? []).filter((record) => {
    if (record?.status !== 'queued') return false
    const recordedAt = Date.parse(String(record?.recordedAt ?? ''))
    return Number.isFinite(recordedAt) && recordedAt < cutoff
  })
}
