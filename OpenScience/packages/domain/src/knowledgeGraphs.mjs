/**
 * The two graphs a project's compiled knowledge draws: pages and the links between them, and entities and the
 * relations between them.
 *
 * Hidden knowledge:
 *
 * - **The contract is upstream's file format, not upstream's script.** A page is a Markdown file whose front matter
 *   carries `type` and `title`; an edge of the page graph is a Markdown link from one page's body to another page. A
 *   compiled knowledge graph is `entities/*.md` (front matter `id`, `title`, `entity_type`, `description`, `aliases`,
 *   `sources`) and `relations.jsonl` (one `{from, relation, label, to, evidence}` per line). OpenViking's own
 *   `wiki_graph.py` and `knowledge_graph.py` compute the same things; their file headers are AGPL-3.0 and they load
 *   D3 from a CDN, which is why these are independent readers of the format and the picture is the product's own.
 * - **What cannot be read is named, never thrown.** A link that leads nowhere is listed under `unresolved`; a relation
 *   line that is not JSON, an entity with no front matter, an `index.md` the model left inside `entities/` are
 *   `problems`. The graph that can be drawn is drawn (a failure keeps the partial result).
 * - **A link out of the tree is provenance, not an edge.** A `viking://` address outside the wiki's own root is a
 *   source the page rests on; it is kept on the node with the quotation its title may carry.
 *
 * Both were run over every tree the lab's compiles produced (thirty wikis, ten graphs) before they were lifted here.
 *
 * @module @evimed/domain/knowledge-graphs
 */

import { okfLinkPath, okfMarkdownLinks, splitOkfFrontmatter } from './okfMarkdown.mjs'

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const RELATION = /^[a-z][a-z0-9_]*$/

/** @param {string} path @returns {string} */
function normalize(path) {
  /** @type {string[]} */
  const out = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** @param {string} path */ const dirname = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
/** @param {string} path */ const basename = (path) => path.slice(path.lastIndexOf('/') + 1)
/** @param {unknown} value @returns {string[]} */
const strings = (value) => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : [])

/**
 * @typedef {object} WikiGraphNode
 * @property {string} id      the page's path under the wiki's root
 * @property {string} path
 * @property {string} title
 * @property {string} type    the front matter's `type`, else the page's top directory
 * @property {string} description
 * @property {string[]} tags
 * @property {number} degree
 * @property {{ uri: string, text: string, quote: string | null }[]} sources  links out of the wiki: what the page rests on
 */

/**
 * Wiki pages as `{ nodes, links }`.
 * @param {ReadonlyArray<{ path: string, content: string }>} files  `path` relative to the wiki's root (`entity/Alpha 协议.md`)
 * @param {{ root?: string }} [options] `root`: the wiki's own `viking://…` address, so absolute links into it resolve
 * @returns {{ nodes: WikiGraphNode[], links: { source: string, target: string, label: string }[],
 *   unresolved: { source: string, target: string, text: string }[] }}
 */
export function wikiPagesToGraph(files, { root = '' } = {}) {
  const wikiRoot = String(root || '').replace(/\/+$/, '')
  /** @type {{ path: string, body: string, node: WikiGraphNode }[]} */
  const pages = []
  for (const file of files) {
    const path = normalize(String(file.path))
    if (!/\.md$/i.test(path) || basename(path).startsWith('.')) continue
    const { data, body } = splitOkfFrontmatter(file.content)
    const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(body)
    pages.push({
      path, body,
      node: {
        id: path, path,
        title: String(data.title || (heading ? heading[1] : basename(path).replace(/\.md$/i, ''))),
        type: String(data.type || (path.includes('/') ? path.split('/')[0] : basename(path).replace(/\.md$/i, '')) || 'other'),
        description: typeof data.description === 'string' ? data.description : '',
        tags: strings(data.tags),
        degree: 0,
        sources: [],
      },
    })
  }
  const byPath = new Map(pages.map((page) => [page.path, page]))
  /** @type {Map<string, string | null>} a file name to its one path; null when two pages share the name */
  const byBasename = new Map()
  for (const page of pages) {
    const name = basename(page.path)
    byBasename.set(name, byBasename.has(name) ? null : page.path)
  }
  /** @type {{ source: string, target: string, label: string }[]} */
  const links = []
  const seen = new Set()
  /** @type {{ source: string, target: string, text: string }[]} */
  const unresolved = []
  for (const page of pages) {
    for (const link of okfMarkdownLinks(page.body)) {
      const raw = okfLinkPath(link.target)
      if (!raw) continue
      /** @type {string | null} */
      let target = null
      if (raw.startsWith('viking://')) {
        if (wikiRoot && raw.startsWith(`${wikiRoot}/`)) target = normalize(raw.slice(wikiRoot.length + 1))
        else {
          page.node.sources.push({ uri: raw, text: link.text, quote: link.title })
          continue
        }
      } else if (SCHEME.test(raw)) {
        continue // http(s), mailto …: not part of the graph
      } else {
        target = normalize(`${raw.startsWith('/') ? '' : `${dirname(page.path)}/`}${raw}`)
      }
      if (!byPath.has(target)) target = byBasename.get(basename(target)) ?? null
      if (!target) {
        unresolved.push({ source: page.path, target: link.target, text: link.text })
        continue
      }
      if (target === page.path) continue
      const key = `${page.path}\u0000${target}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: page.path, target, label: link.text })
    }
  }
  for (const link of links) {
    for (const id of [link.source, link.target]) {
      const page = byPath.get(id)
      if (page) page.node.degree += 1
    }
  }
  return { nodes: pages.map((page) => page.node), links, unresolved }
}

/**
 * @typedef {object} KnowledgeGraphNode
 * @property {string} id
 * @property {string} path
 * @property {string} title
 * @property {string} entityType  open snake_case upstream; `other` when the file names none
 * @property {string} description
 * @property {string[]} aliases
 * @property {string[]} sources   the files the entity was read from, as the file names them
 * @property {string} body
 * @property {number} degree
 */

/**
 * @typedef {object} KnowledgeGraphLink
 * @property {string} source
 * @property {string} target
 * @property {string} relation  the stable snake_case predicate
 * @property {string} label     its display name
 * @property {string[]} evidence
 */

/**
 * A compiled knowledge graph as `{ nodes, links }`.
 * @param {ReadonlyArray<{ path: string, content: string }>} files  paths relative to the graph's root
 * @returns {{ nodes: KnowledgeGraphNode[], links: KnowledgeGraphLink[],
 *   relationCounts: { relation: string, label: string, count: number }[], problems: Record<string, any>[] }}
 */
export function knowledgeGraphToGraph(files) {
  /** @type {Record<string, any>[]} */
  const problems = []
  /** @type {KnowledgeGraphNode[]} */
  const nodes = []
  /** @type {Map<string, KnowledgeGraphNode>} */
  const byId = new Map()
  for (const file of files) {
    const match = /^entities\/([^/]+)\.md$/i.exec(String(file.path))
    if (!match) continue
    const { data, body, hasFrontmatter } = splitOkfFrontmatter(file.content)
    // Seen in a real run: the model kept its `index.md` inside entities/. A file that declares another artifact kind is not a node.
    if (hasFrontmatter && data.type && String(data.type) !== 'entity') {
      problems.push({ kind: 'non_entity_file_in_entities', path: file.path, type: String(data.type) })
      continue
    }
    const id = String(data.id || match[1])
    if (!hasFrontmatter) problems.push({ kind: 'entity_without_frontmatter', path: file.path })
    if (data.id && String(data.id) !== match[1]) problems.push({ kind: 'entity_id_differs_from_filename', path: file.path, id: String(data.id) })
    if (byId.has(id)) {
      problems.push({ kind: 'duplicate_entity_id', path: file.path, id })
      continue
    }
    /** @type {KnowledgeGraphNode} */
    const node = {
      id, path: file.path,
      title: String(data.title || id),
      entityType: String(data.entity_type || 'other'),
      description: typeof data.description === 'string' ? data.description : '',
      aliases: strings(data.aliases),
      sources: strings(data.sources),
      body: body.trim(),
      degree: 0,
    }
    if (!node.sources.length) problems.push({ kind: 'entity_without_sources', path: file.path, id })
    byId.set(id, node)
    nodes.push(node)
  }
  const relations = files.find((file) => String(file.path) === 'relations.jsonl')
  /** @type {KnowledgeGraphLink[]} */
  const links = []
  /** @type {Map<string, KnowledgeGraphLink>} */
  const byTriple = new Map()
  /** @type {Map<string, string>} */
  const labels = new Map()
  if (!relations) problems.push({ kind: 'relations_file_missing' })
  else {
    String(relations.content).split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return
      const at = index + 1
      /** @type {any} */
      let edge
      try { edge = JSON.parse(line) } catch { problems.push({ kind: 'relation_line_not_json', line: at }); return }
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) { problems.push({ kind: 'relation_line_not_object', line: at }); return }
      const from = typeof edge.from === 'string' ? edge.from.trim() : ''
      const to = typeof edge.to === 'string' ? edge.to.trim() : ''
      const relation = typeof edge.relation === 'string' ? edge.relation.trim() : ''
      if (!from || !to || !relation) { problems.push({ kind: 'relation_missing_field', line: at }); return }
      if (!RELATION.test(relation)) problems.push({ kind: 'relation_not_snake_case', line: at, relation })
      /** @type {string[]} */
      const evidence = Array.isArray(edge.evidence) ? edge.evidence.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim()) : []
      if (!evidence.length) problems.push({ kind: 'relation_without_evidence', line: at })
      if (!byId.has(from) || !byId.has(to)) {
        problems.push({ kind: 'relation_endpoint_unknown', line: at, from, to, missing: [from, to].filter((id) => !byId.has(id)) })
        return
      }
      const label = typeof edge.label === 'string' && edge.label.trim() ? edge.label.trim() : relation
      if (labels.has(relation) && labels.get(relation) !== label) problems.push({ kind: 'relation_label_inconsistent', line: at, relation, labels: [labels.get(relation), label] })
      if (!labels.has(relation)) labels.set(relation, label)
      const key = `${from}\u0000${relation}\u0000${to}`
      const existing = byTriple.get(key)
      if (existing) {
        // The skill's own rule: one line per triple, evidence merged.
        problems.push({ kind: 'relation_duplicate_triple', line: at })
        existing.evidence = [...new Set([...existing.evidence, ...evidence])]
        return
      }
      const link = { source: from, target: to, relation, label: /** @type {string} */ (labels.get(relation)), evidence }
      byTriple.set(key, link)
      links.push(link)
    })
  }
  for (const link of links) {
    for (const id of [link.source, link.target]) {
      const node = byId.get(id)
      if (node) node.degree += 1
    }
  }
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const link of links) counts.set(link.relation, (counts.get(link.relation) ?? 0) + 1)
  const relationCounts = [...counts].map(([relation, count]) => ({ relation, label: labels.get(relation) ?? relation, count }))
    .sort((left, right) => right.count - left.count || (left.relation < right.relation ? -1 : 1))
  return { nodes, links, relationCounts, problems }
}
