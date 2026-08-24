/**
 * `task-plan.json` — the only plan artifact in the system.
 *
 * Hidden knowledge: what a plan has to contain before a run may end. Two
 * things, and both are checkable. First, `clarifications[]` must be non-empty:
 * Apodex makes clarify a mandatory node, and a hosted run with question-asking
 * disabled still has to write down the assumption it proceeded on, because an
 * unstated assumption is the failure mode that produces a technically correct
 * answer to the wrong question. Second, every deliverable must name a contract
 * kind, because the kind is what decides which validator runs.
 *
 * A plan with no deliverables is legal — most questions are answered directly —
 * but it must say why, so "I forgot to plan" and "this needed no artifact" stay
 * distinguishable.
 */

import { isContractKind } from './contractKinds.mjs'
import { PLAN_ITEM_STATES } from './states.mjs'

/**
 * @typedef {object} PlanDeliverable
 * @property {string} id
 * @property {string} contractKind
 * @property {string} capability
 * @property {string} title
 * @property {readonly string[]} dependsOn
 * @property {string} [status]
 */

/**
 * @typedef {object} TaskPlan
 * @property {number} revision
 * @property {readonly string[]} clarifications
 * @property {readonly PlanDeliverable[]} deliverables
 * @property {string} [reason]
 */

/** @typedef {{ code: string, message: string, deliverableId?: string }} PlanIssue */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Validates a parsed plan. Returns issues rather than throwing: a plan the
 * model just wrote is expected to be wrong sometimes, and the model repairs it
 * from the issue list (ch.10 — define the error out of existence).
 * @param {unknown} value
 * @returns {{ ok: boolean, plan: TaskPlan | null, issues: PlanIssue[] }}
 */
export function validateTaskPlan(value) {
  /** @type {PlanIssue[]} */
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, plan: null, issues: [{ code: 'plan_invalid', message: 'task-plan.json must be a JSON object.' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const revision = Number(raw.revision ?? 1)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    issues.push({ code: 'plan_invalid', message: 'revision must be a positive integer.' })
  }
  const clarifications = Array.isArray(raw.clarifications)
    ? raw.clarifications.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []
  if (!clarifications.length) {
    issues.push({
      code: 'plan_missing_clarifications',
      message: 'clarifications[] must record the questions asked, or the assumptions taken instead.',
    })
  }
  const rawDeliverables = Array.isArray(raw.deliverables) ? raw.deliverables : []
  /** @type {PlanDeliverable[]} */
  const deliverables = []
  const seen = new Set()
  for (const entry of rawDeliverables) {
    if (!entry || typeof entry !== 'object') {
      issues.push({ code: 'plan_invalid', message: 'each deliverable must be an object.' })
      continue
    }
    const item = /** @type {Record<string, unknown>} */ (entry)
    const id = String(item.id ?? '').trim()
    if (!ID_PATTERN.test(id)) {
      issues.push({ code: 'plan_invalid', message: `deliverable id "${id}" must match ${ID_PATTERN}.` })
      continue
    }
    if (seen.has(id)) {
      issues.push({ code: 'plan_invalid', message: `duplicate deliverable id "${id}".`, deliverableId: id })
      continue
    }
    seen.add(id)
    const contractKind = String(item.contractKind ?? '').trim()
    if (!isContractKind(contractKind)) {
      issues.push({ code: 'contract_kind_unknown', message: `unknown contract kind "${contractKind}".`, deliverableId: id })
    }
    const capability = String(item.capability ?? '').trim()
    if (!capability) {
      issues.push({ code: 'plan_invalid', message: 'each deliverable must name a capability.', deliverableId: id })
    }
    const dependsOn = Array.isArray(item.dependsOn)
      ? item.dependsOn.map((dep) => String(dep ?? '').trim()).filter(Boolean)
      : []
    const status = String(item.status ?? 'planned')
    if (!PLAN_ITEM_STATES.includes(/** @type {any} */ (status))) {
      issues.push({ code: 'plan_invalid', message: `unknown deliverable status "${status}".`, deliverableId: id })
    }
    deliverables.push({
      id,
      contractKind,
      capability,
      title: String(item.title ?? id).trim(),
      dependsOn: Object.freeze(dependsOn),
      status,
    })
  }
  for (const item of deliverables) {
    for (const dep of item.dependsOn) {
      if (!seen.has(dep)) {
        issues.push({ code: 'plan_invalid', message: `deliverable "${item.id}" depends on unknown "${dep}".`, deliverableId: item.id })
      }
      if (dep === item.id) {
        issues.push({ code: 'plan_invalid', message: `deliverable "${item.id}" depends on itself.`, deliverableId: item.id })
      }
    }
  }
  const cycle = findDependencyCycle(deliverables)
  if (cycle) {
    issues.push({ code: 'plan_invalid', message: `deliverable dependency cycle: ${cycle.join(' -> ')}.` })
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  if (!deliverables.length && !reason) {
    issues.push({ code: 'plan_invalid', message: 'a plan with no deliverables must give a reason.' })
  }
  /** @type {TaskPlan} */
  const plan = {
    revision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1,
    clarifications: Object.freeze(clarifications),
    deliverables: Object.freeze(deliverables),
    ...(reason ? { reason } : {}),
  }
  return { ok: issues.length === 0, plan, issues }
}

/**
 * @param {readonly PlanDeliverable[]} deliverables
 * @returns {string[] | null}
 */
function findDependencyCycle(deliverables) {
  const byId = new Map(deliverables.map((item) => [item.id, item]))
  /** @type {Map<string, number>} */
  const mark = new Map()
  /** @type {string[]} */
  const stack = []
  /** @param {string} id @returns {string[] | null} */
  const walk = (id) => {
    const state = mark.get(id) ?? 0
    if (state === 1) return [...stack.slice(stack.indexOf(id)), id]
    if (state === 2) return null
    mark.set(id, 1)
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue
      const found = walk(dep)
      if (found) return found
    }
    stack.pop()
    mark.set(id, 2)
    return null
  }
  for (const item of deliverables) {
    const found = walk(item.id)
    if (found) return found
  }
  return null
}

/**
 * Deliverables whose dependencies are all accepted, in plan order. The compound
 * delegate tool uses it so the model never has to sequence work by hand
 * (§14 rule 13).
 * @param {TaskPlan} plan
 * @param {(id: string) => string} statusOf
 * @returns {PlanDeliverable[]}
 */
export function readyDeliverables(plan, statusOf) {
  return plan.deliverables.filter((item) => {
    const status = statusOf(item.id)
    if (status !== 'planned' && status !== 'queued' && status !== 'rejected') return false
    return item.dependsOn.every((dep) => statusOf(dep) === 'accepted')
  })
}
