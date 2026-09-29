/**
 * Lineage: what a result was computed from, and what goes stale when an input
 * changes (plan §3.4, §6.3).
 *
 * Hidden knowledge:
 *
 * - **A result references a version, never an object.** `population v3` is a
 *   different node from `population v4`, so nothing is ever silently
 *   recomputed under a result that already exists. Editing an assumption
 *   creates a new assumption version and leaves every finished result pointing
 *   at the old one — which is why staleness has to be *derived* rather than
 *   stored on the result: the result did not change, the world did.
 * - **Stale is a state, not a deletion.** A stale result keeps its numbers and
 *   its page, greyed, with the reason attached; the study package either
 *   recomputes it or says so on the cover (plan §6.3). Hiding it would make a
 *   changed assumption look like it had always been that way.
 * - **Cheap work is redone at once, heavy work queues.** `recomputePlan`
 *   splits the affected set by the cost the edge recorded, so a study whose
 *   drop-out rate changed shows a refreshed cohort profile immediately and a
 *   simulation marked 「排队重算中」.
 * - Pure functions over plain edges: the control plane owns the table, this
 *   module owns the rules, and both the server and the browser run the same
 *   traversal.
 *
 * @module @evimed/domain/vcrLineage
 */

import { VCR_LINEAGE_NODE_KINDS, VCR_STALE_REASONS } from './vcrVocabulary.mjs'

/** @typedef {{ from: string, to: string, fromKind?: string, toKind?: string, cost?: 'light'|'heavy' }} VcrEdge */

/** Which node kinds are recomputed inside a request, and which become jobs. */
export const VCR_LIGHT_NODE_KINDS = Object.freeze(['population', 'patient_set', 'matching_assessment', 'result'])
export const VCR_HEAVY_NODE_KINDS = Object.freeze(['trial_scenario', 'design_grid', 'comparator_design', 'execution'])

/** A node id is `<kind>:<id>@<version>`; the version is part of the identity. */
const NODE = /^[a-z_]+:[A-Za-z0-9_.:-]+@\d+$/

/**
 * @param {string} kind @param {string} id @param {number} version
 */
export function lineageNode(kind, id, version) {
  if (!VCR_LINEAGE_NODE_KINDS.includes(kind)) throw new Error(`lineageNode: unknown kind ${kind}`)
  if (!Number.isInteger(version) || version < 1) throw new Error('lineageNode: version is a positive integer')
  return `${kind}:${id}@${version}`
}

/** @param {string} node */
export function parseLineageNode(node) {
  if (!NODE.test(node)) return null
  const [kindAndId, version] = node.split('@')
  const index = kindAndId.indexOf(':')
  return { kind: kindAndId.slice(0, index), id: kindAndId.slice(index + 1), version: Number(version) }
}

/**
 * Everything downstream of `changed`, in breadth-first order. Cycles are
 * impossible by construction (a version only ever points at versions that
 * existed before it) but the walk guards against one anyway: a cycle in the
 * table would otherwise hang the request that reads it.
 *
 * @param {readonly VcrEdge[]} edges
 * @param {readonly string[]} changed
 * @returns {readonly string[]}
 */
export function affectedNodes(edges, changed) {
  /** @type {Map<string, string[]>} */
  const downstream = new Map()
  for (const edge of edges ?? []) {
    if (!edge?.from || !edge?.to) continue
    const list = downstream.get(edge.from) ?? []
    list.push(edge.to)
    downstream.set(edge.from, list)
  }
  const seen = new Set(changed ?? [])
  const out = []
  const queue = [...(changed ?? [])]
  while (queue.length) {
    const node = /** @type {string} */ (queue.shift())
    for (const next of downstream.get(node) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      out.push(next)
      queue.push(next)
    }
  }
  return Object.freeze(out)
}

/**
 * What to do about a change: which affected results are refreshed now and
 * which become queued jobs, with the reason each one carries.
 *
 * @param {{ edges: readonly VcrEdge[], changed: readonly string[], reason: string }} input
 * @returns {{ reason: string, light: readonly string[], heavy: readonly string[], all: readonly string[] }}
 */
export function recomputePlan({ edges, changed, reason }) {
  if (!VCR_STALE_REASONS.includes(reason)) throw new Error(`recomputePlan: unknown reason ${reason}`)
  const all = affectedNodes(edges, changed)
  const costOf = new Map()
  for (const edge of edges ?? []) if (edge?.to && edge.cost) costOf.set(edge.to, edge.cost)
  /** @type {string[]} */
  const light = []
  /** @type {string[]} */
  const heavy = []
  for (const node of all) {
    const parsed = parseLineageNode(node)
    const cost = costOf.get(node) ?? (parsed && VCR_HEAVY_NODE_KINDS.includes(parsed.kind) ? 'heavy' : 'light')
    ;(cost === 'heavy' ? heavy : light).push(node)
  }
  return { reason, light: Object.freeze(light), heavy: Object.freeze(heavy), all }
}

/**
 * Does a review still hold? A review countersigns one version of one set of
 * inputs; if any of them moved, it reads `changed_after_review` (plan §10.2,
 * AC-21).
 *
 * @param {{ reviewedNodes: readonly string[], currentNodes: readonly string[] }} input
 * @returns {'reviewed' | 'changed_after_review'}
 */
export function reviewStateFor({ reviewedNodes, currentNodes }) {
  const current = new Set(currentNodes ?? [])
  const held = (reviewedNodes ?? []).every((node) => current.has(node))
  return held ? 'reviewed' : 'changed_after_review'
}
