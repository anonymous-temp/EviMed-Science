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

import { VCR_ASSUMPTION_KEY, VCR_LINEAGE_NODE_KINDS, VCR_STALE_REASONS } from './vcrVocabulary.mjs'

/** @typedef {{ from: string, to: string, fromKind?: string, toKind?: string, cost?: 'light'|'heavy' }} VcrEdge */

/** Which node kinds are recomputed inside a request, and which become jobs. */
export const VCR_LIGHT_NODE_KINDS = Object.freeze(['population', 'patient_set', 'matching_assessment', 'result'])
export const VCR_HEAVY_NODE_KINDS = Object.freeze(['trial_scenario', 'design_grid', 'comparator_design', 'execution'])

/**
 * A node id is `<kind>:<id>@<version>`; the version is part of the identity.
 * One grammar, everywhere a node is written: the same text is an edge end, a
 * review's node, a stale mark and — as an engine input id — a job's input, so
 * the id part is the character set an input id admits, and a version is a
 * positive integer without a leading zero.
 */
const NODE = /^[a-z_]+:[A-Za-z0-9][A-Za-z0-9_.:-]*@[1-9][0-9]*$/
/** An input id's own limit (`VCR_PATTERNS.inputId` in `vcrEngineJob.mjs`), which a node must fit. */
const NODE_MAX_LENGTH = 141

/**
 * Write a node id — and refuse one that cannot be read back. An id the lineage
 * writes but `parseLineageNode` cannot parse is a node no traversal can follow
 * and no job can name: a result whose edge is silently dead, and a stale mark
 * that never reaches it.
 * @param {string} kind @param {string} id @param {number} version
 */
export function lineageNode(kind, id, version) {
  if (!VCR_LINEAGE_NODE_KINDS.includes(kind)) throw new Error(`lineageNode: unknown kind ${kind}`)
  if (!Number.isInteger(version) || version < 1) throw new Error('lineageNode: version is a positive integer')
  if (typeof id !== 'string') throw new Error('lineageNode: id is a string')
  // An assumption's id is its key: the name the writer and the reader must both spell.
  if (kind === 'assumption' && !VCR_ASSUMPTION_KEY.test(id)) {
    throw new Error(`lineageNode: an assumption key is lowercase letters, digits and "_" (got ${JSON.stringify(id)})`)
  }
  const node = `${kind}:${id}@${version}`
  const parsed = parseLineageNode(node)
  if (!parsed || parsed.kind !== kind || parsed.id !== id || parsed.version !== version || node.length > NODE_MAX_LENGTH) {
    throw new Error(`lineageNode: ${JSON.stringify(node)} cannot be read back as a node id`)
  }
  return node
}

/** @param {string} node */
export function parseLineageNode(node) {
  if (typeof node !== 'string' || !NODE.test(node)) return null
  const at = node.lastIndexOf('@')
  const kindAndId = node.slice(0, at)
  const index = kindAndId.indexOf(':')
  return { kind: kindAndId.slice(0, index), id: kindAndId.slice(index + 1), version: Number(node.slice(at + 1)) }
}

/**
 * What a change reaches, split in two: the versions it superseded and
 * everything downstream of the change. Nothing is ever recomputed under a
 * version that exists already, so a change to an object writes a new version
 * (the seed) and makes every OLDER version of that object — in the seeds or
 * anywhere in the graph — a superseded one: a result computed from it, and a
 * review that countersigned it, no longer describe the current object.
 *
 * The newest version is never superseded by its own change, so a seed that is
 * the latest version of its object is not in `superseded` (it is what the
 * change wrote), while an older seed is.
 *
 * The walk is breadth-first with a head index rather than `shift()`, which is
 * quadratic on a long chain, and guards against cycles: a cycle in the table
 * would otherwise hang the request that reads it.
 *
 * @param {readonly VcrEdge[]} edges
 * @param {readonly string[]} changed
 * @returns {{ superseded: readonly string[], downstream: readonly string[] }}
 */
export function lineageImpact(edges, changed) {
  const seeds = [...new Set(changed ?? [])]
  /** @type {Map<string, string[]>} */
  const downstream = new Map()
  /** @type {Set<string>} */
  const known = new Set(seeds)
  for (const edge of edges ?? []) {
    if (!edge?.from || !edge?.to) continue
    const list = downstream.get(edge.from) ?? []
    list.push(edge.to)
    downstream.set(edge.from, list)
    known.add(edge.from)
    known.add(edge.to)
  }
  // The newest version of each changed object among the seeds.
  /** @type {Map<string, number>} */
  const newest = new Map()
  for (const seed of seeds) {
    const parsed = parseLineageNode(seed)
    if (parsed) newest.set(`${parsed.kind}:${parsed.id}`, Math.max(newest.get(`${parsed.kind}:${parsed.id}`) ?? 0, parsed.version))
  }
  /** @type {string[]} */
  const superseded = []
  for (const node of known) {
    const parsed = parseLineageNode(node)
    const latest = parsed ? newest.get(`${parsed.kind}:${parsed.id}`) : undefined
    if (parsed && latest !== undefined && parsed.version < latest) superseded.push(node)
  }
  const seen = new Set([...seeds, ...superseded])
  /** @type {string[]} */
  const out = []
  const queue = [...seeds, ...superseded]
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of downstream.get(queue[head]) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      out.push(next)
      queue.push(next)
    }
  }
  return { superseded: Object.freeze(superseded), downstream: Object.freeze(out) }
}

/**
 * Everything a change makes stale, in order: the superseded versions, then what
 * is downstream of the change.
 * @param {readonly VcrEdge[]} edges
 * @param {readonly string[]} changed
 * @returns {readonly string[]}
 */
export function affectedNodes(edges, changed) {
  const { superseded, downstream } = lineageImpact(edges, changed)
  return Object.freeze([...superseded, ...downstream])
}

/**
 * What to do about a change: which affected results are refreshed now and
 * which become queued jobs, with the reason each one carries. `all` is what
 * to mark stale (superseded versions included); `light` and `heavy` are what to
 * recompute, and only ever downstream nodes — a superseded version is not
 * recomputed, it is what the recomputation replaces.
 *
 * A node's cost is `heavy` when any edge into it says so (a node that needs
 * heavy work is heavy, whatever else feeds it); an edge that says anything but
 * `light` or `heavy` says nothing, and the node kind decides.
 *
 * @param {{ edges: readonly VcrEdge[], changed: readonly string[], reason: string }} input
 * @returns {{ reason: string, changed: readonly string[], superseded: readonly string[], light: readonly string[], heavy: readonly string[], all: readonly string[] }}
 */
export function recomputePlan({ edges, changed, reason }) {
  if (!VCR_STALE_REASONS.includes(reason)) throw new Error(`recomputePlan: unknown reason ${reason}`)
  const { superseded, downstream } = lineageImpact(edges, changed)
  /** @type {Map<string, 'light' | 'heavy'>} */
  const costOf = new Map()
  for (const edge of edges ?? []) {
    if (!edge?.to || (edge.cost !== 'light' && edge.cost !== 'heavy')) continue
    if (edge.cost === 'heavy' || !costOf.has(edge.to)) costOf.set(edge.to, edge.cost)
  }
  /** @type {string[]} */
  const light = []
  /** @type {string[]} */
  const heavy = []
  for (const node of downstream) {
    const parsed = parseLineageNode(node)
    const cost = costOf.get(node) ?? (parsed && VCR_HEAVY_NODE_KINDS.includes(parsed.kind) ? 'heavy' : 'light')
    ;(cost === 'heavy' ? heavy : light).push(node)
  }
  return {
    reason, changed: Object.freeze([...new Set(changed ?? [])]), superseded,
    light: Object.freeze(light), heavy: Object.freeze(heavy), all: Object.freeze([...superseded, ...downstream]),
  }
}

/**
 * Does a review still hold? A review countersigns one version of one set of
 * inputs; if any of them moved — is no longer current, or has a newer version
 * of the same object beside it — it reads `changed_after_review` (plan §10.2,
 * AC-21). A review that names no node countersigned nothing: `ai_set`.
 *
 * "Beside it" matters: a caller that lists the reviewed nodes among the
 * current ones because they are not marked stale would otherwise read a
 * superseded node as still current.
 *
 * @param {{ reviewedNodes: readonly string[], currentNodes: readonly string[] }} input
 * @returns {'ai_set' | 'reviewed' | 'changed_after_review'}
 */
export function reviewStateFor({ reviewedNodes, currentNodes }) {
  if (!(reviewedNodes ?? []).length) return 'ai_set'
  const current = new Set(currentNodes ?? [])
  /** @type {Map<string, number>} */
  const newest = new Map()
  for (const node of current) {
    const parsed = parseLineageNode(node)
    if (parsed) newest.set(`${parsed.kind}:${parsed.id}`, Math.max(newest.get(`${parsed.kind}:${parsed.id}`) ?? 0, parsed.version))
  }
  const held = (reviewedNodes ?? []).every((node) => {
    if (!current.has(node)) return false
    const parsed = parseLineageNode(node)
    return !parsed || (newest.get(`${parsed.kind}:${parsed.id}`) ?? 0) <= parsed.version
  })
  return held ? 'reviewed' : 'changed_after_review'
}
