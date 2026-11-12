/**
 * Report-only broken-link checks for the learned-method library and the compiled knowledge pages.
 *
 * Hidden knowledge: both kinds of link already failed silently before this module existed.
 * `validateMethodGraph` reports a dangling pin, a moved digest, a dependency that is not in
 * effect, a cycle and a duplicate name, and the hourly consolidation pass throws its issues away;
 * `wikiPagesToGraph` and `knowledgeGraphToGraph` already name an unresolved page link and a graph
 * problem, and the knowledge service shows only the unresolved count. Nothing here decides whether
 * a method may be saved or a page may exist. These functions only name the links that lead nowhere,
 * so an operator can look at the counts.
 *
 * What the existing checkers do not cover is read here too: a reuse reference in a method's body
 * that its `depends_on` does not declare, a reference or provenance entry naming a method the
 * library does not hold, an abstract method's `derived_from`, a relation target and the sources a
 * page says it depends on.
 *
 * Pure and browser-safe: no I/O, no `node:` imports, and no throw on malformed input. A record the
 * reader cannot read becomes an `unreadable` issue rather than an exception.
 *
 * @module @evimed/domain/link-checks
 */

import { isMethodDigest, parseReuseReferences } from './methodSkill.mjs'
import { validateMethodGraph } from './methodGraph.mjs'
import { knowledgeGraphToGraph, wikiPagesToGraph } from './knowledgeGraphs.mjs'

/** The issue kinds `methodLibraryLinkIssues` can report. */
const METHOD_ISSUE_KINDS = Object.freeze([
  'dangling_dependency',
  'moved_digest',
  'dependency_not_in_effect',
  'cycle',
  'duplicate_name',
  'unparsable_digest',
  'reuse_reference_undeclared',
  'reuse_reference_missing',
  'derived_from_missing',
  'relation_target_missing',
  'merged_from_missing',
  'pending_retirement_missing',
  'unreadable',
])

/** The issue kinds `knowledgeLinkIssues` can report; `graph_problem:<name>` is added as it is found. */
const KNOWLEDGE_ISSUE_KINDS = Object.freeze(['page_link_unresolved', 'depends_on_source_missing', 'unreadable'])

/**
 * `validateMethodGraph`'s vocabulary, mapped without restating any of its rules.
 * An unknown code from a later revision of that module is reported as `unreadable`, with the
 * original code in the detail, rather than being dropped.
 * @type {Readonly<Record<string, string>>}
 */
const GRAPH_ISSUE_KINDS = Object.freeze({
  method_graph_dangling_dependency: 'dangling_dependency',
  method_graph_digest_moved: 'moved_digest',
  method_graph_dependency_not_effective: 'dependency_not_in_effect',
  method_graph_cycle: 'cycle',
  method_graph_duplicate_name: 'duplicate_name',
  method_graph_digest_unparsable: 'unparsable_digest',
})

/** @param {readonly string[]} kinds @returns {Record<string, number>} */
function emptyCounts(kinds) {
  return Object.fromEntries(kinds.map((kind) => [kind, 0]))
}

/** @param {Record<string, number>} counts @param {string} kind */
function count(counts, kind) {
  counts[kind] = (counts[kind] ?? 0) + 1
}

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}

/**
 * The body a method record carries, whichever of the shapes a caller passes.
 * @param {any} record
 * @returns {string}
 */
function bodyOf(record) {
  for (const value of [record?.body, record?.markdown, record?.payload?.body, record?.document?.payload?.body]) {
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * A method's front matter, wherever the record keeps it.
 * @param {any} record
 * @returns {Record<string, any>}
 */
function frontmatterOf(record) {
  for (const value of [record?.frontmatter, record?.payload?.frontmatter, record?.document?.payload?.frontmatter]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return {}
}

/**
 * The `metadata` block `derived_from` lives in.
 * @param {any} record
 * @returns {Record<string, any>}
 */
function metadataOf(record) {
  const metadata = frontmatterOf(record).metadata ?? record?.metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

/**
 * A record read far enough that `validateMethodGraph` and the extra checks cannot throw on it.
 * @param {unknown} raw
 * @returns {{ name: string, dependencies: {name: string, digest: string}[], raw: any } | null}
 */
function readableMethod(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  if (raw.dependencies != null && !Array.isArray(raw.dependencies)) return null
  /** @type {{name: string, digest: string}[]} */
  const dependencies = []
  for (const dependency of raw.dependencies ?? []) {
    if (!dependency || typeof dependency !== 'object' || typeof dependency.name !== 'string') return null
    dependencies.push({ name: dependency.name, digest: typeof dependency.digest === 'string' ? dependency.digest : String(dependency.digest ?? '') })
  }
  if (raw.learning != null && (typeof raw.learning !== 'object' || Array.isArray(raw.learning))) return null
  if (raw.provenance != null && (typeof raw.provenance !== 'object' || Array.isArray(raw.provenance))) return null
  return { name, dependencies, raw }
}

/**
 * The target a dependency-shaped `validateMethodGraph` issue is about. The code decides the issue;
 * this only finds which pin in the record the message was describing, so the report can name it.
 * @param {string} code
 * @param {{name: string, dependencies: {name: string, digest: string}[]}} method
 * @param {Map<string, Set<string>>} digestsByName
 * @param {Map<string, string>} statusByName
 * @returns {string | null}
 */
function graphIssueTarget(code, method, digestsByName, statusByName) {
  if (code === 'method_graph_duplicate_name') return method.name
  if (code === 'method_graph_cycle') return null
  const dependency = method.dependencies.find((entry) => {
    switch (code) {
      case 'method_graph_digest_unparsable': return !isMethodDigest(entry.digest)
      case 'method_graph_dangling_dependency': return !digestsByName.has(entry.name)
      case 'method_graph_digest_moved': return digestsByName.has(entry.name) && !digestsByName.get(entry.name)?.has(entry.digest)
      case 'method_graph_dependency_not_effective': return statusByName.has(entry.name) && statusByName.get(entry.name) !== 'approved'
      default: return false
    }
  })
  return dependency?.name ?? null
}

/**
 * Broken links in a method library.
 *
 * `records` are method records in the shape `validateMethodGraph` takes (`name`, `digest`,
 * `status`, `dependencies`, `learning`, `provenance`, `id`), as the consolidation pass builds them
 * through `methodRecordFrom`. To check the body's reuse references and `metadata.derived_from`, a
 * record may also carry `body` and `frontmatter` (or `payload.body` / `payload.frontmatter`).
 *
 * @param {unknown} records
 * @returns {{issues: {kind: string, method: string | null, target: string | null, detail: string}[], counts: Record<string, number>}}
 */
export function methodLibraryLinkIssues(records) {
  const issues = []
  const counts = emptyCounts(METHOD_ISSUE_KINDS)
  /** @type {{name: string, dependencies: {name: string, digest: string}[], raw: any}[]} */
  const readable = []
  const list = Array.isArray(records) ? records : []
  if (records != null && !Array.isArray(records)) {
    issues.push({ kind: 'unreadable', method: null, target: null, detail: 'The method library is not a list of records.' })
    count(counts, 'unreadable')
  }
  for (const raw of list) {
    try {
      const method = readableMethod(raw)
      if (!method) {
        const label = raw && typeof raw === 'object' && (typeof raw.name === 'string' || typeof raw.id === 'string')
          ? String(raw.name ?? raw.id)
          : null
        issues.push({ kind: 'unreadable', method: label, target: null, detail: 'The record has no readable method name or dependency list.' })
        count(counts, 'unreadable')
        continue
      }
      readable.push(method)
    } catch (error) {
      issues.push({ kind: 'unreadable', method: null, target: null, detail: `The record could not be read: ${messageOf(error)}` })
      count(counts, 'unreadable')
    }
  }

  const byName = new Map(readable.map((method) => [method.name, method]))
  const names = new Set(readable.map((method) => method.name))
  const ids = new Set(readable.map((method) => method.raw.id).filter((id) => typeof id === 'string' && id))
  /** @type {Map<string, Set<string>>} */
  const digestsByName = new Map()
  /** @type {Map<string, string>} */
  const statusByName = new Map()
  for (const method of readable) {
    const digests = digestsByName.get(method.name) ?? new Set()
    digests.add(typeof method.raw.digest === 'string' ? method.raw.digest : '')
    digestsByName.set(method.name, digests)
    statusByName.set(method.name, typeof method.raw.status === 'string' ? method.raw.status : 'candidate')
  }

  // The graph's own vocabulary, mapped. Its rules are not restated here.
  try {
    const graph = validateMethodGraph(readable.map((method) => ({
      name: method.name,
      digest: typeof method.raw.digest === 'string' ? method.raw.digest : '',
      status: typeof method.raw.status === 'string' ? method.raw.status : 'candidate',
      dependencies: method.dependencies,
      learning: method.raw.learning ?? { digest: '', counts: {}, observations: [], relations: [], level: 0 },
      provenance: method.raw.provenance ?? { origin: 'inferred' },
    })))
    for (const issue of graph.issues) {
      const kind = GRAPH_ISSUE_KINDS[issue.code] ?? 'unreadable'
      const method = typeof issue.method === 'string' ? byName.get(issue.method) : undefined
      const target = method ? graphIssueTarget(issue.code, method, digestsByName, statusByName) : null
      issues.push({
        kind,
        method: typeof issue.method === 'string' ? issue.method : null,
        target,
        detail: kind === 'unreadable' ? `Unmapped method graph issue ${issue.code}: ${issue.message}` : issue.message,
      })
      count(counts, kind)
    }
  } catch (error) {
    for (const method of readable) {
      issues.push({ kind: 'unreadable', method: method.name, target: null, detail: `The method graph could not be validated: ${messageOf(error)}` })
      count(counts, 'unreadable')
    }
  }

  /** @param {unknown} target @returns {boolean} */
  const exists = (target) => (typeof target === 'string' && (names.has(target) || ids.has(target)))

  for (const method of readable) {
    const record = method.raw
    const dependencyNames = new Set(method.dependencies.map((dependency) => dependency.name))

    // A reuse reference in the prose is a promise on `depends_on`; the write path checks it, the stored record may predate that.
    /** @type {ReturnType<typeof parseReuseReferences>} */
    let reuse = { references: [], malformed: [] }
    try {
      reuse = parseReuseReferences(bodyOf(record))
    } catch {
      reuse = { references: [], malformed: [] }
    }
    for (const reference of reuse.references) {
      if (!dependencyNames.has(reference.name)) {
        issues.push({ kind: 'reuse_reference_undeclared', method: method.name, target: reference.name, detail: `The body reuses ${reference.name}, but metadata.depends_on does not pin it.` })
        count(counts, 'reuse_reference_undeclared')
      }
      if (!names.has(reference.name)) {
        issues.push({ kind: 'reuse_reference_missing', method: method.name, target: reference.name, detail: `The body reuses ${reference.name}, which is not in the library.` })
        count(counts, 'reuse_reference_missing')
      }
    }

    // Only an abstract method's derived_from names a method; on the other roles it is a run or feedback id.
    const metadata = metadataOf(record)
    if (metadata.role === 'abstract' && metadata.derived_from != null) {
      const named = Array.isArray(metadata.derived_from)
        ? metadata.derived_from.map(String)
        : String(metadata.derived_from).split(',').map((entry) => entry.trim()).filter(Boolean)
      for (const target of named) {
        if (!exists(target)) {
          issues.push({ kind: 'derived_from_missing', method: method.name, target, detail: `The abstract method is derived from ${target}, which is not in the library.` })
          count(counts, 'derived_from_missing')
        }
      }
    }

    const relations = Array.isArray(record.learning?.relations) ? record.learning.relations : []
    for (const relation of relations) {
      const target = typeof relation?.target === 'string' ? relation.target : ''
      if (!exists(target)) {
        issues.push({ kind: 'relation_target_missing', method: method.name, target: target || null, detail: `The relation names ${JSON.stringify(target)}, which is not in the library.` })
        count(counts, 'relation_target_missing')
      }
    }

    const mergedFrom = Array.isArray(record.provenance?.mergedFrom) ? record.provenance.mergedFrom : []
    for (const source of mergedFrom) {
      const target = typeof source?.methodId === 'string' ? source.methodId : ''
      // A merged source that is retired is still in the library and is fine; one that does not exist at all is not.
      if (!exists(target)) {
        issues.push({ kind: 'merged_from_missing', method: method.name, target: target || null, detail: `The merge names source ${JSON.stringify(target)}, which is not in the library.` })
        count(counts, 'merged_from_missing')
      }
    }

    const pending = Array.isArray(record.provenance?.pendingRetirements) ? record.provenance.pendingRetirements : []
    for (const entry of pending) {
      const target = typeof entry?.methodId === 'string' ? entry.methodId : ''
      if (!exists(target)) {
        issues.push({ kind: 'pending_retirement_missing', method: method.name, target: target || null, detail: `The pending retirement names ${JSON.stringify(target)}, which is not in the library.` })
        count(counts, 'pending_retirement_missing')
      }
    }
  }

  return { issues, counts }
}

/** @param {unknown} value @returns {string[]} */
function dependsOnOf(value) {
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? ''))).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return []
}

/** @param {any} page @returns {string[]} */
function pageDependsOn(page) {
  return dependsOnOf(
    page?.dependsOn
    ?? page?.depends_on
    ?? page?.payload?.dependsOn
    ?? page?.record?.payload?.dependsOn
    ?? page?.document?.payload?.dependsOn,
  )
}

/** @param {unknown} sources @returns {Set<string>} */
function sourceIds(sources) {
  const list = Array.isArray(sources) ? sources : []
  /** @type {Set<string>} */
  const ids = new Set()
  for (const source of list) {
    if (typeof source === 'string' && source) ids.add(source)
    else if (source && typeof source === 'object' && typeof source.id === 'string' && source.id) ids.add(source.id)
  }
  return ids
}

/** @param {any} problem @returns {string} */
function graphProblemDetail(problem) {
  const parts = []
  if (problem?.path) parts.push(`path ${problem.path}`)
  if (problem?.line != null) parts.push(`line ${problem.line}`)
  if (Array.isArray(problem?.missing) && problem.missing.length) parts.push(`missing ${problem.missing.join(', ')}`)
  return parts.length ? `Knowledge graph problem ${problem.kind} (${parts.join('; ')}).` : `Knowledge graph problem ${problem.kind}.`
}

/**
 * Broken links in a project's compiled knowledge pages.
 *
 * `pages` is what `wikiPagesToGraph` takes — `{ path, content }` — and may also carry the mirror
 * record's `dependsOn` (or `record.payload.dependsOn`), which is the page's source links.
 * `sources` are the source ids that exist. When `graph` is given, either the compiled graph's files
 * (what `knowledgeGraphToGraph` takes) or its result, each of its `problems` becomes a
 * `graph_problem:<name>` issue.
 *
 * @param {{pages?: unknown, sources?: unknown, graph?: unknown}} [input]
 * @returns {{issues: {kind: string, page: string | null, target: string | null, detail: string}[], counts: Record<string, number>}}
 */
export function knowledgeLinkIssues(input = {}) {
  const counts = emptyCounts(KNOWLEDGE_ISSUE_KINDS)
  const issues = []
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const pagesInput = options.pages
  const list = Array.isArray(pagesInput) ? pagesInput : []
  if (pagesInput != null && !Array.isArray(pagesInput)) {
    issues.push({ kind: 'unreadable', page: null, target: null, detail: 'The page set is not a list of files.' })
    count(counts, 'unreadable')
  }

  /** @type {{path: string, content: string, raw: any}[]} */
  const pages = []
  for (const page of list) {
    try {
      if (!page || typeof page !== 'object' || Array.isArray(page) || typeof page.path !== 'string' || typeof page.content !== 'string') {
        issues.push({ kind: 'unreadable', page: page && typeof page === 'object' && typeof page.path === 'string' ? page.path : null, target: null, detail: 'The page has no readable path and content.' })
        count(counts, 'unreadable')
        continue
      }
      pages.push({ path: page.path, content: page.content, raw: page })
    } catch (error) {
      issues.push({ kind: 'unreadable', page: null, target: null, detail: `The page could not be read: ${messageOf(error)}` })
      count(counts, 'unreadable')
    }
  }

  try {
    const wiki = wikiPagesToGraph(pages.map((page) => ({ path: page.path, content: page.content })))
    for (const unresolved of wiki.unresolved) {
      issues.push({ kind: 'page_link_unresolved', page: unresolved.source, target: unresolved.target, detail: `The link ${JSON.stringify(unresolved.text)} does not resolve to a page.` })
      count(counts, 'page_link_unresolved')
    }
  } catch (error) {
    issues.push({ kind: 'unreadable', page: null, target: null, detail: `The page graph could not be read: ${messageOf(error)}` })
    count(counts, 'unreadable')
  }

  if (options.graph != null) {
    try {
      const graph = /** @type {{problems?: unknown} | null | undefined} */ (Array.isArray(options.graph) ? knowledgeGraphToGraph(options.graph) : options.graph)
      const problems = graph && typeof graph === 'object' && Array.isArray(graph.problems) ? graph.problems : []
      for (const problem of problems) {
        const kind = `graph_problem:${String(problem?.kind ?? 'unknown')}`
        const target = typeof problem?.to === 'string' ? problem.to
          : typeof problem?.id === 'string' ? problem.id
            : typeof problem?.from === 'string' ? problem.from
              : null
        issues.push({ kind, page: typeof problem?.path === 'string' ? problem.path : null, target, detail: graphProblemDetail(problem ?? {}) })
        count(counts, kind)
      }
    } catch (error) {
      issues.push({ kind: 'unreadable', page: null, target: null, detail: `The compiled graph could not be read: ${messageOf(error)}` })
      count(counts, 'unreadable')
    }
  }

  const sources = sourceIds(options.sources)
  for (const page of pages) {
    for (const sourceId of pageDependsOn(page.raw)) {
      if (sources.has(sourceId)) continue
      issues.push({ kind: 'depends_on_source_missing', page: page.path, target: sourceId, detail: `The page depends on source ${sourceId}, which is not in the knowledge base.` })
      count(counts, 'depends_on_source_missing')
    }
  }

  return { issues, counts }
}
