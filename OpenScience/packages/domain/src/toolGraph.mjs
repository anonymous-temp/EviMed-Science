/**
 * The tool dependency graph — ToolVerse's TDG, as pure functions.
 *
 * Hidden knowledge: the graph is the part of the evaluation corpus that must be reproducible byte for byte, so there is no
 * `Math.random` here and no clock. It is built from the capability manifests and the research server's tool schemas
 * (`scripts/dev/build-tool-graph.mjs`, held by `pnpm check:tool-graph`) and read by 循证进化's opportunity de-duplication.
 *
 * The other half of ToolVerse — the dynamic unlock sampling that walked this graph to draft evaluation briefs
 * (`unlockSchedule`, `chainSpecs`, `scripts/dev/generate-briefs.mjs`) — was deleted on 2026-10-23: it needed executed edges,
 * the one script that collects them never ran (the corpus file is empty), and it produced no brief in its life. A walk over
 * this graph can be written again the day executed edges exist; until then it was a finished part of an algorithm with no
 * caller (development principle 8).
 *
 * One departure from the paper, because our graph is about real tools rather than generated mocks:
 *
 *  - **Edge removal is deterministic and recorded.** The paper's cycle rule is "delete the lowest priority edge"; ours writes
 *    down which edge and why, so a corpus diff can show that a graph change, not a model change, moved the task set. And an
 *    edge records how it was established — `schema` (the output field types match the input parameter), `model` (a model said
 *    so), `executed` (we ran the pair and it worked) — so that only the last may carry a task.
 */

/** How A constrains B: A's output can fill B's required parameter, or the
 *  scenario simply requires A first. */
export const TOOL_EDGE_TYPES = Object.freeze(['parameter', 'semantic'])

/** How we came to believe the edge. Only `executed` may be sampled. */
export const TOOL_EDGE_SOURCES = Object.freeze(['schema', 'model', 'executed'])

/** What running the tool does to the environment, which is what decides whether
 *  a fixture has to be reset between tasks. */
export const TOOL_EDGE_STATE_EFFECTS = Object.freeze(['none', 'writes_workspace', 'writes_ledger'])

/**
 * @typedef {object} ToolGraphNode
 * @property {string} name
 * @property {string} [description]
 * @property {unknown} [inputSchema]
 * @property {unknown} [outputSchema]
 * @property {readonly string[]} [typeTags]
 */

/**
 * @typedef {object} ToolGraphEdge
 * @property {string} from
 * @property {string} to
 * @property {string} type
 * @property {string} via
 * @property {number} [confidence]
 * @property {string | null} [validatedBy]
 * @property {string} [stateEffect]
 */

/**
 * @typedef {object} ToolGraph
 * @property {string} [capability]
 * @property {string} [version]
 * @property {readonly ToolGraphNode[]} nodes
 * @property {readonly ToolGraphEdge[]} edges
 */

/* ------------------------------------------------------------------ validation */

/**
 * @typedef {object} ToolGraphIssue
 * @property {string} code
 * @property {string} message
 */

/** Every issue this module can raise. @type {readonly string[]} */
export const TOOL_GRAPH_ISSUE_CODES = Object.freeze([
  'tool_graph_node_duplicate',
  'tool_graph_node_unnamed',
  'tool_graph_edge_unknown_node',
  'tool_graph_edge_type_unknown',
  'tool_graph_edge_source_unknown',
  'tool_graph_edge_state_effect_unknown',
  'tool_graph_edge_self_loop',
  'tool_graph_edge_unvalidated_executed',
  'tool_graph_edge_confidence_range',
])

/** @param {ToolGraph} graph @returns {{ok: boolean, issues: ToolGraphIssue[]}} */
export function validateToolGraph(graph) {
  /** @type {ToolGraphIssue[]} */
  const issues = []
  const names = new Set()
  for (const node of graph?.nodes ?? []) {
    if (!node?.name) { issues.push({ code: 'tool_graph_node_unnamed', message: 'A node has no name.' }); continue }
    if (names.has(node.name)) issues.push({ code: 'tool_graph_node_duplicate', message: `Two nodes named ${node.name}.` })
    names.add(node.name)
  }
  for (const edge of graph?.edges ?? []) {
    if (!names.has(edge?.from) || !names.has(edge?.to)) {
      issues.push({ code: 'tool_graph_edge_unknown_node', message: `Edge ${edge?.from} -> ${edge?.to} names a tool that is not a node.` })
      continue
    }
    if (edge.from === edge.to) issues.push({ code: 'tool_graph_edge_self_loop', message: `${edge.from} depends on itself.` })
    if (!TOOL_EDGE_TYPES.includes(edge.type)) issues.push({ code: 'tool_graph_edge_type_unknown', message: `Edge ${edge.from} -> ${edge.to} has type ${JSON.stringify(edge.type)}.` })
    if (!TOOL_EDGE_SOURCES.includes(edge.via)) issues.push({ code: 'tool_graph_edge_source_unknown', message: `Edge ${edge.from} -> ${edge.to} was established via ${JSON.stringify(edge.via)}.` })
    if (edge.stateEffect != null && !TOOL_EDGE_STATE_EFFECTS.includes(edge.stateEffect)) {
      issues.push({ code: 'tool_graph_edge_state_effect_unknown', message: `Edge ${edge.from} -> ${edge.to} declares state effect ${JSON.stringify(edge.stateEffect)}.` })
    }
    if (edge.via === 'executed' && !edge.validatedBy) {
      issues.push({ code: 'tool_graph_edge_unvalidated_executed', message: `Edge ${edge.from} -> ${edge.to} claims it was executed but records no run id, so the claim cannot be checked.` })
    }
    if (edge.confidence != null && !(edge.confidence >= 0 && edge.confidence <= 1)) {
      issues.push({ code: 'tool_graph_edge_confidence_range', message: `Edge ${edge.from} -> ${edge.to} has confidence ${edge.confidence}; it must be between 0 and 1.` })
    }
  }
  return { ok: issues.length === 0, issues }
}

/* ------------------------------------------------------------ DAG sanitisation */

/**
 * @param {readonly ToolGraphEdge[]} edges
 * @returns {Map<string, number>}
 */
function inDegrees(edges) {
  /** @type {Map<string, number>} */
  const degrees = new Map()
  for (const edge of edges) degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
  return degrees
}

/**
 * ToolVerse's removal order, made total so the result cannot depend on array
 * order: semantic edges go before parameter edges, lower confidence before
 * higher, then the edge whose removal unlocks the most nodes, then the name.
 * @param {readonly ToolGraphEdge[]} edges
 * @returns {ToolGraphEdge}
 */
function lowestPriorityEdge(edges) {
  const degrees = inDegrees(edges)
  const scored = edges.map((edge) => ({
    edge,
    typeRank: edge.type === 'semantic' ? 0 : 1,
    confidence: edge.confidence ?? 0,
    unlocks: (degrees.get(edge.to) ?? 0) === 1 ? 1 : 0,
    label: `${edge.from}->${edge.to}:${edge.type}`,
  }))
  scored.sort((left, right) => (
    left.typeRank - right.typeRank
    || left.confidence - right.confidence
    || right.unlocks - left.unlocks
    || left.label.localeCompare(right.label)
  ))
  return scored[0].edge
}

/**
 * @typedef {object} RemovedEdge
 * @property {ToolGraphEdge} edge
 * @property {string} reason
 */

/**
 * Turn a proposed graph into a DAG, keeping only edges a task may be built on.
 *
 * The paper reaches the same place by a topological sweep that keeps only edges
 * consistent with the partial order it has already committed to; Kahn's
 * algorithm plus "when it stalls, drop the lowest-priority edge in what is
 * left" is the same rule with the tie-breaks written down.
 * @param {ToolGraph} graph
 * @param {{requireExecuted?: boolean}} [options]
 * @returns {{graph: ToolGraph, removed: RemovedEdge[]}}
 */
export function sanitizeToolGraph(graph, options = {}) {
  const requireExecuted = options.requireExecuted !== false
  const nodes = [...(graph?.nodes ?? [])]
  const names = new Set(nodes.map((node) => node.name))
  /** @type {RemovedEdge[]} */
  const removed = []
  /** @type {ToolGraphEdge[]} */
  let edges = []
  for (const edge of graph?.edges ?? []) {
    if (!names.has(edge.from) || !names.has(edge.to)) { removed.push({ edge, reason: 'names a tool that is not a node' }); continue }
    if (edge.from === edge.to) { removed.push({ edge, reason: 'self loop' }); continue }
    if (requireExecuted && edge.via !== 'executed') { removed.push({ edge, reason: `established via ${edge.via}; only an executed edge may carry a task` }); continue }
    edges.push(edge)
  }
  // Collapse parallel edges: a parameter edge and a semantic edge between the
  // same pair say the same thing about order, and keeping both would let one be
  // dropped while the constraint survives, which reads as a fixed cycle.
  /** @type {Map<string, ToolGraphEdge>} */
  const byPair = new Map()
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`
    const held = byPair.get(key)
    if (!held) { byPair.set(key, edge); continue }
    const keep = held.type === 'parameter' ? held : edge
    const drop = keep === held ? edge : held
    byPair.set(key, keep)
    removed.push({ edge: drop, reason: 'duplicate of the other edge between the same pair' })
  }
  edges = [...byPair.values()]

  for (;;) {
    const degrees = inDegrees(edges)
    /** @type {string[]} */
    const queue = nodes.map((node) => node.name).filter((name) => (degrees.get(name) ?? 0) === 0).sort()
    const settled = new Set()
    while (queue.length) {
      const name = /** @type {string} */ (queue.shift())
      if (settled.has(name)) continue
      settled.add(name)
      for (const edge of edges) {
        if (edge.from !== name) continue
        const left = (degrees.get(edge.to) ?? 0) - 1
        degrees.set(edge.to, left)
        if (left === 0) queue.push(edge.to)
      }
    }
    if (settled.size === nodes.length) break
    const stuck = new Set(nodes.map((node) => node.name).filter((name) => !settled.has(name)))
    const candidates = edges.filter((edge) => stuck.has(edge.from) && stuck.has(edge.to))
    if (!candidates.length) break
    const drop = lowestPriorityEdge(candidates)
    edges = edges.filter((edge) => edge !== drop)
    removed.push({ edge: drop, reason: 'lowest-priority edge in a dependency cycle' })
  }

  return { graph: { ...graph, nodes, edges }, removed }
}
