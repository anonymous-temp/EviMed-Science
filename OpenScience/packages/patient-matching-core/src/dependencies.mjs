import { array, check, identifier, object, oneOf, strings, unique } from './validation.mjs'
import { assertScope, sourceIdentity, validateScope, validateSourceRef, validateSourceRefs } from './identity.mjs'
import { pairIdentity } from './contracts.mjs'

/** Targeted invalidation, retaining historical artifacts. The host owns persistence and scheduling. */
export function planReassessment({ scope, nodes, previousSources, currentSources, affectedPairs = [] }) {
  validateScope(scope)
  validateSourceRefs(previousSources, 'previousSources')
  validateSourceRefs(currentSources, 'currentSources')
  array(affectedPairs, 'affectedPairs', pairIdentity)
  array(nodes, 'nodes', (node, path) => {
    object(node, path)
    identifier(node.id, `${path}.id`)
    assertScope(scope, node.scope, `${path}.scope`)
    oneOf(node.kind, ['source', 'assessment', 'computation', 'criterion', 'decision', 'report'], `${path}.kind`)
    oneOf(node.dependencyCoverage, ['complete', 'partial'], `${path}.dependencyCoverage`)
    strings(node.dependsOn, `${path}.dependsOn`)
    unique(node.dependsOn, `${path}.dependsOn`)
    if (node.pair !== undefined) pairIdentity(node.pair)
    if (node.kind === 'source') validateSourceRef(node.source, `${path}.source`)
  })
  unique(nodes, 'nodes', (node) => node.id)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const descendants = new Map()
  for (const node of nodes) for (const dependency of node.dependsOn) {
    check(byId.has(dependency), 'nodes.dependsOn', 'unknown dependency identity', 'invalid_id_mapping')
    const children = descendants.get(dependency) ?? []
    children.push(node.id)
    descendants.set(dependency, children)
  }
  const visited = new Set()
  const visiting = new Set()
  function visit(id) {
    check(!visiting.has(id), 'nodes', 'cyclic dependency graph')
    if (visited.has(id)) return
    visiting.add(id)
    byId.get(id).dependsOn.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  nodes.forEach((node) => visit(node.id))
  const previous = new Map(previousSources.map((source) => [source.sourceId, source]))
  const current = new Map(currentSources.map((source) => [source.sourceId, source]))
  const changedSources = [...new Set([...previous.keys(), ...current.keys()])].filter((id) => {
    return !previous.has(id) || !current.has(id) || sourceIdentity(previous.get(id)) !== sourceIdentity(current.get(id))
  })
  const changed = new Set(changedSources)
  const roots = nodes.filter((node) => node.kind === 'source' && changed.has(node.source.sourceId))
  const uncovered = changedSources.filter((id) => !roots.some((node) => node.source.sourceId === id))
  check(uncovered.length === 0 || affectedPairs.length > 0, 'affectedPairs', 'changed source lacks dependency coverage; identify affected pairs', 'missing_dependency_scope')
  const invalidated = new Set()
  const queue = roots.map((node) => node.id)
  while (queue.length) {
    const id = queue.shift()
    if (invalidated.has(id)) continue
    invalidated.add(id)
    queue.push(...(descendants.get(id) ?? []))
  }
  const affected = new Map()
  for (const id of invalidated) {
    const node = byId.get(id)
    if (node.pair) affected.set(pairIdentity(node.pair), node.pair)
  }
  if (changed.size) for (const pair of affectedPairs) affected.set(pairIdentity(pair), pair)
  const incomplete = uncovered.length > 0 || nodes.some((node) => node.dependencyCoverage !== 'complete' &&
    (invalidated.has(node.id) || (node.pair && affected.has(pairIdentity(node.pair)))))
  if (incomplete) {
    check(affected.size > 0, 'affectedPairs', 'incomplete dependencies require an affected pair', 'missing_dependency_scope')
    // A partial dependency ledger cannot safely claim only a criterion/receipt needs refresh.
    for (const node of nodes) if (node.pair && affected.has(pairIdentity(node.pair))) queue.push(node.id)
    while (queue.length) {
      const id = queue.shift()
      if (invalidated.has(id)) continue
      invalidated.add(id)
      queue.push(...(descendants.get(id) ?? []))
    }
  }
  return structuredClone({ changedSources, invalidatedNodeIds: nodes.filter((node) => invalidated.has(node.id)).map((node) => node.id), reassessPairs: [...affected.values()], precise: !incomplete })
}
