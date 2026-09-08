/**
 * The tool dependency graph and the unlock sampling that walks it — ToolVerse's
 * TDG and DUS, as pure functions.
 *
 * Hidden knowledge: this is the part of the evaluation corpus that must be
 * reproducible byte for byte, because a brief corpus that regenerates
 * differently is a baseline nobody can compare against. So there is no
 * `Math.random` here and no clock: every choice comes from a seed the caller
 * records in the corpus alongside the tasks.
 *
 * Two departures from the paper, both because our graph is about real tools
 * rather than generated mocks:
 *
 *  - **Only an executed edge may be sampled.** ToolVerse asks an LLM whether A
 *    can precede B and then builds tasks on the answer. Ours records how the
 *    edge was established — `schema` (the output field types match the input
 *    parameter), `model` (a model said so), `executed` (we ran the pair and it
 *    worked) — and refuses to build a task on anything but the last. An
 *    unexecuted edge produces a task that cannot be solved, and an unsolvable
 *    task in an evaluation set reads exactly like a capability regression.
 *  - **Edge removal is deterministic and recorded.** The paper's cycle rule is
 *    "delete the lowest priority edge"; ours writes down which edge and why, so
 *    a corpus diff can show that a graph change, not a model change, moved the
 *    task set.
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

/* ------------------------------------------------------------ deterministic choice */

/** FNV-1a over the seed string, so a seed can be a readable label. @param {string} text @returns {number} */
function seedHash(text) {
  let hash = 0x811c9dc5
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * mulberry32: small, fast, and — the only property that matters here — the same
 * sequence on every machine and every Node version.
 * @param {string} seed
 * @returns {() => number}
 */
export function seededRandom(seed) {
  let state = seedHash(seed) || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Sample without replacement, deterministically.
 *
 * The input is sorted first: a caller that hands us a set built by iteration
 * order would otherwise get a different corpus from the same seed, which is the
 * subtlest way a reproducible pipeline stops being one.
 * @template T
 * @param {readonly T[]} items
 * @param {number} count
 * @param {string} seed
 * @param {(item: T) => string} [key]
 * @returns {T[]}
 */
export function seededSample(items, count, seed, key = (item) => String(item)) {
  const pool = [...(items ?? [])].sort((left, right) => key(left).localeCompare(key(right)))
  const random = seededRandom(seed)
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = pool[index]
    pool[index] = pool[swap]
    pool[swap] = held
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)))
}

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

/** The edges a task may be built on. @param {ToolGraph} graph @returns {ToolGraphEdge[]} */
export function sampleableEdges(graph) {
  return [...(graph?.edges ?? [])].filter((edge) => edge.via === 'executed')
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

/* ------------------------------------------------------- dynamic unlock sampling */

/**
 * ToolVerse Algorithm 1, verbatim in structure.
 *
 * Each returned stage is one turn of a task: the tools whose dependencies are
 * all satisfied at that point, sampled down to at most `n`. The number of
 * stages is a property of the graph, not a parameter — which is exactly why
 * this produces long-horizon tasks without anybody choosing a length.
 * @param {ToolGraph} graph
 * @param {{n?: number, seed?: string}} [options]
 * @returns {{stages: string[][], unreached: string[]}}
 */
export function unlockSchedule(graph, options = {}) {
  const n = Math.max(1, options.n ?? 2)
  const seed = options.seed ?? 'evimed'
  const nodes = (graph?.nodes ?? []).map((node) => node.name)
  const edges = graph?.edges ?? []
  const degrees = inDegrees(edges)
  /** @type {Set<string>} */
  let ready = new Set(nodes.filter((name) => (degrees.get(name) ?? 0) === 0))
  const remaining = new Map(nodes.map((name) => [name, degrees.get(name) ?? 0]))
  /** @type {string[][]} */
  const stages = []
  let round = 0
  while (ready.size) {
    round += 1
    const stage = seededSample([...ready], Math.min(ready.size, n), `${seed}:${round}`)
    const chosen = new Set(stage)
    ready = new Set([...ready].filter((name) => !chosen.has(name)))
    stages.push([...stage].sort())
    for (const name of stage) {
      for (const edge of edges) {
        if (edge.from !== name) continue
        const left = (remaining.get(edge.to) ?? 0) - 1
        remaining.set(edge.to, left)
        if (left === 0) ready.add(edge.to)
      }
    }
  }
  const scheduled = new Set(stages.flat())
  return { stages, unreached: nodes.filter((name) => !scheduled.has(name)).sort() }
}

/**
 * How much of the tool surface a set of task chains actually exercises.
 *
 * Reported in the corpus rather than optimised for: the paper's own ablation
 * shows environment count buys very little (100 to 422 environments moved BFCL
 * by 2.5 points), so the honest use of this number is to say what a corpus does
 * not cover.
 * @param {ToolGraph} graph
 * @param {readonly (readonly string[])[]} chains
 * @returns {{tools: number, covered: number, ratio: number, uncovered: string[]}}
 */
export function graphCoverage(graph, chains) {
  const tools = (graph?.nodes ?? []).map((node) => node.name)
  const seen = new Set(chains.flat())
  const uncovered = tools.filter((name) => !seen.has(name)).sort()
  const covered = tools.length - uncovered.length
  return { tools: tools.length, covered, ratio: tools.length ? covered / tools.length : 0, uncovered }
}

/**
 * @typedef {object} ChainSpec
 * @property {string} id
 * @property {string[][]} stages
 * @property {string[]} tools
 * @property {string} seed
 * @property {number} n
 */

/**
 * A batch of task chains over one graph.
 *
 * `chains` is how many independent walks to take and `n` is the width of a
 * turn; both are recorded on every spec so a corpus can be rebuilt from the
 * spec alone. A chain shorter than `minStages` is dropped rather than padded —
 * a one-turn "long-horizon" task is a single tool call with extra words.
 * @param {ToolGraph} graph
 * @param {{seed?: string, chains?: number, n?: number, minStages?: number, maxStages?: number}} [options]
 * @returns {ChainSpec[]}
 */
export function chainSpecs(graph, options = {}) {
  const chains = Math.max(1, options.chains ?? 5)
  const n = Math.max(1, options.n ?? 2)
  const minStages = Math.max(1, options.minStages ?? 3)
  const maxStages = Math.max(minStages, options.maxStages ?? 7)
  const baseSeed = options.seed ?? 'evimed'
  /** @type {ChainSpec[]} */
  const specs = []
  for (let index = 0; index < chains; index += 1) {
    const seed = `${baseSeed}:chain:${index}`
    const { stages } = unlockSchedule(graph, { n, seed })
    if (stages.length < minStages) continue
    const kept = stages.slice(0, maxStages)
    specs.push({ id: `${graph?.capability ?? 'graph'}-${index}`, stages: kept, tools: [...new Set(kept.flat())].sort(), seed, n })
  }
  return specs
}
