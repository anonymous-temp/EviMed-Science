// Arm C's pages. The harness compiles nothing: the pages are trees written by OpenViking's official `llm-wiki` skill (the
// product's compiler) and exported from the engine, one tree per topic per repetition under `<dir>/<topic>/rep<N>/`. This
// module reads a tree, turns its pages into what a search hit shows the model, and counts what the compile left behind.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkPageQuotations, isTypedKnowledgePage, knowledgeSourceIdOfUri, okfLinkPath, okfMarkdownLinks, readKnowledgePage, splitOkfFrontmatter } from '@evimed/domain'
import { sourceMarker } from './citations.mjs'

const TREE_NAME = /^rep([1-9]\d*)$/

/**
 * Every Markdown file of a directory, by its path inside it, in a fixed order. Hidden files and directories are skipped,
 * and so is everything that is not Markdown (the engine's `_listing.json` among it).
 * @param {string} dir @returns {Array<{ path: string, content: string }>}
 */
function readMarkdownFiles(dir) {
  const pages = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) pages.push({ path, content: readFileSync(join(dir, path), 'utf8') })
    }
  }
  walk('')
  return pages.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * One exported tree, or null when the directory is missing or holds no page.
 * @param {string} dir @param {string} name  the tree's name, `rep<N>`
 * @returns {{ name: string, pages: Array<{ path: string, content: string }>, sha256: string } | null}
 */
export function readUpstreamTree(dir, name) {
  if (!existsSync(dir)) return null
  const pages = readMarkdownFiles(dir)
  if (!pages.length) return null
  const hash = createHash('sha256')
  for (const page of pages) hash.update(`${page.path}\0${page.content}\0`)
  return { name, pages, sha256: hash.digest('hex') }
}

/**
 * The trees of a topic, `rep1` before `rep2` before `rep10`. A directory of another name, or one with no page, is not a tree.
 * @param {string} root @param {string} topicId
 */
export function readUpstreamTrees(root, topicId) {
  const directory = join(root, topicId)
  if (!existsSync(directory)) return []
  const names = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && TREE_NAME.test(entry.name)).map((entry) => entry.name)
  names.sort((left, right) => Number(TREE_NAME.exec(left)[1]) - Number(TREE_NAME.exec(right)[1]))
  return names.map((name) => readUpstreamTree(join(directory, name), name)).filter(Boolean)
}

/**
 * The trees a run searches for a topic. The first time the run finds any under `from`, it copies their pages into its own
 * directory (`to`, the same layout) and from then on reads only that copy: a run that is resumed after the export
 * directory changed still searches the pages its earlier answers searched, and the run directory holds what it measured.
 * @param {{ from: string, to: string, topicId: string }} options
 */
export function adoptUpstreamTrees({ from, to, topicId }) {
  const held = readUpstreamTrees(to, topicId)
  if (held.length) return held
  for (const tree of readUpstreamTrees(from, topicId)) {
    for (const page of tree.pages) {
      const target = join(to, topicId, tree.name, page.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, page.content, 'utf8')
    }
  }
  return readUpstreamTrees(to, topicId)
}

/**
 * The tree a repetition searches: one each while they last, then the same trees again in order; null when there is none.
 * @template T @param {T[]} trees @param {number} rep @returns {T | null}
 */
export function treeForRep(trees, rep) {
  return trees.length ? trees[(rep - 1) % trees.length] : null
}

/**
 * A page as a search hit shows it. Upstream writes a claim's source as a link whose title carries the supporting sentence,
 * `[title](viking://…/sources/<srcId>.md "verbatim sentence")`; the answering protocol of every arm is the evimed-source
 * comment. So each source link becomes its words followed by that comment — the same document id, the same quotation —
 * and a page tells the model what a page of arm B told it: which document to cite, and with which sentence.
 *  - a source link with no quotation keeps its words and names the document id in plain text, so it can still be searched;
 *  - any other `viking://` link — a document of no topic here, a page addressed by its absolute address — keeps its words only;
 *  - relative links between pages and links out of the engine stay as written, and so does anything the platform's link
 *    reader does not read as a link to a `viking://` address (it is not counted as a source link either).
 * @param {string} markdown @param {ReadonlySet<string>} documentIds
 */
export function rewriteSourceLinks(markdown, documentIds) {
  const { body, raw } = splitOkfFrontmatter(markdown)
  let text = ''
  let from = 0
  for (const link of okfMarkdownLinks(body)) {
    const uri = okfLinkPath(link.target)
    if (!uri.startsWith('viking://')) continue
    const sourceId = knowledgeSourceIdOfUri(uri)
    // A title the model wrapped over two lines is the same sentence on one.
    const quote = typeof link.title === 'string' ? link.title.replace(/\s+/g, ' ').trim() : ''
    let shown = link.text
    if (sourceId && documentIds.has(sourceId)) shown = quote ? `${link.text} ${sourceMarker(sourceId, quote)}` : `${link.text} (document id: ${sourceId})`
    text += body.slice(from, link.index) + shown
    from = link.end
  }
  return raw + text + body.slice(from)
}

/**
 * The pages of a tree as searchable documents beside the originals: ids `page:<prefix><path in the tree>`, so a model that
 * cites a page can be told from one that cites a document. A page's passages are its blocks (`blocks: true`): upstream
 * writes a sentence over several lines and puts its source link on the next one, and a passage cut by lines could show
 * the sentence without its source.
 * @param {{ pages: Array<{ path: string, content: string }> }} tree
 * @param {{ documentIds: ReadonlySet<string>, prefix?: string }} options
 */
export function upstreamPageRecords(tree, { documentIds, prefix = '' }) {
  return tree.pages.map((page) => ({
    id: `page:${prefix}${page.path}`, kind: 'page', blocks: true,
    title: readKnowledgePage(page.content, { path: page.path }).title,
    text: rewriteSourceLinks(page.content, documentIds),
  }))
}

/**
 * What the compile left in a tree, counted after the fact and without a model: its pages, how many are typed, its source
 * links beside claims, how many of those carry a quotation, and how many of the quotations the platform's comparison
 * finds in the document named (`checkPageQuotations`). `sourceMissing` counts links that name no document of the topic:
 * a tree exported under other document ids shows up here, not as a silently empty arm.
 * @param {{ pages: Array<{ path: string, content: string }> }} tree
 * @param {Array<{ sourceId: string, text: string }>} documents
 */
export function upstreamTreeStats(tree, documents) {
  const texts = new Map(documents.map((document) => [document.sourceId, document.text]))
  const { records, summary } = checkPageQuotations(tree.pages, { sourceText: (_uri, sourceId) => (sourceId ? texts.get(sourceId) ?? null : null) })
  return {
    ...summary,
    typedPages: tree.pages.filter((page) => isTypedKnowledgePage(page.path, page.content)).length,
    characters: tree.pages.reduce((sum, page) => sum + page.content.length, 0),
    documentsCited: new Set(records.filter((record) => record.sourceId && texts.has(record.sourceId)).map((record) => record.sourceId)).size,
    documents: documents.length,
  }
}
