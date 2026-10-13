/**
 * Knowledge pages (「知识页」): what the product knows about the pages OpenViking's Compile writes from a project's
 * documents — where their mirror lives, how one is read for a reader, and how a person's edits outlive a recompile.
 *
 * Hidden knowledge:
 *
 * - **The pages are upstream's.** They are written by the official `llm-wiki` and `knowledge-graph` skills, in
 *   upstream's layout (`index.md`, `entity/`, `concept/`, `method/`, `comparison/`, `analysis/`; `entities/*.md` and
 *   `relations.jsonl` for a graph) and upstream's format (front matter `type` / `title`, ordinary Markdown links).
 *   Until 2026-10-13 this module was a format of our own — a renderer, a patch contract, a merge — for a compiler of
 *   our own that was never released; all of that is gone. What is left is the product layer around upstream's files.
 * - **The ledger holds a mirror, and the mirror is the original for everything a person did.** Each compiled file is
 *   kept as a document under `knowledge-base/wiki/**` or `knowledge-base/kg/**`, so pages are listed, searched,
 *   versioned and exported like any document, and stay readable when the engine is down.
 * - **A person's edit does not survive a recompile unless something carries it.** Measured at v0.5.0: three
 *   hand-written passages were still there after one recompile and all gone after the second, including one that
 *   said "keep this paragraph"; named verbatim in the compile instruction they were kept 3 of 3, and dropped again the
 *   next time the instruction did not name them. So the ledger keeps what a person wrote as blocks
 *   (`diffKnowledgePageEdit`), every instruction carries them, and after each compile the ones the engine dropped are
 *   put back (`applyKnowledgePageEdits`) — by code, so it does not depend on the model's attention.
 * - **128 typed pages is where v0.5.0 turns destructive.** Past it the compile does not fail: the model, told its
 *   bundle is over the limit, rewrote 102 existing pages into one-line stubs to get under it and the task reported
 *   `completed` with no warning. The scheduler therefore counts typed pages (`isTypedKnowledgePage`) before it
 *   submits and stops at `KNOWLEDGE_PAGE_SUBMIT_LIMIT`, well short of the engine's own number.
 *
 * Pure and browser-safe, like the rest of the package.
 *
 * @module @evimed/domain/knowledge-page
 */

import { okfLinkPath, okfMarkdownLinks, splitOkfFrontmatter } from './okfMarkdown.mjs'

/** Where the mirror of a project's wiki lives in its knowledge base, and where the mirror of its graph does. */
export const KNOWLEDGE_PAGE_FOLDER = 'knowledge-base/wiki'
export const KNOWLEDGE_GRAPH_FOLDER = 'knowledge-base/kg'

/** The two compiled trees of a project: the `llm-wiki` target and the `knowledge-graph` target. */
export const KNOWLEDGE_TREES = Object.freeze(['wiki', 'kg'])
/** @typedef {'wiki' | 'kg'} KnowledgeTree */

/** The engine's own bound on typed pages in one target (v0.5.0), and where this platform stops submitting. */
export const KNOWLEDGE_PAGE_ENGINE_LIMIT = 128
export const KNOWLEDGE_PAGE_SUBMIT_LIMIT = 100

/** The page types upstream's `llm-wiki` writes, with the names the product shows; any other type is shown as written. */
export const KNOWLEDGE_PAGE_TYPES = Object.freeze([
  { id: 'index', label: '目录' },
  { id: 'entity', label: '实体' },
  { id: 'concept', label: '概念' },
  { id: 'method', label: '方法' },
  { id: 'comparison', label: '比较' },
  { id: 'analysis', label: '分析' },
  { id: 'summary', label: '摘要' },
].map((type) => Object.freeze(type)))

/** The Chinese name of a page type, or the type as upstream wrote it. @param {unknown} type */
export function knowledgePageTypeLabel(type) {
  return KNOWLEDGE_PAGE_TYPES.find((entry) => entry.id === type)?.label ?? (String(type ?? '').trim() || '页面')
}

/** Bounds on what a person's edits may add to a compile instruction and to a page's record. */
export const KNOWLEDGE_USER_EDIT_LIMITS = Object.freeze({ blocks: 40, blockChars: 4000, removed: 40 })

const FOLDERS = Object.freeze({ wiki: KNOWLEDGE_PAGE_FOLDER, kg: KNOWLEDGE_GRAPH_FOLDER })

/**
 * Whether a path inside a compiled tree can be kept as a file of the project under the same name: every segment a
 * plain name (no control character, no backslash, not hidden, not `.` or `..`) of a length a file system takes.
 * @param {unknown} rel @returns {boolean}
 */
export function isKnowledgeMirrorPath(rel) {
  const path = String(rel ?? '')
  if (!path || path.length > 480 || path.startsWith('/') || path.endsWith('/')) return false
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.')
    // eslint-disable-next-line no-control-regex -- the control characters are exactly what a file name must not hold
    && !/[\u0000-\u001f\u007f\\]/.test(part) && new TextEncoder().encode(part).length <= 200)
}

/** Where a file of a compiled tree lives in the project. @param {KnowledgeTree} tree @param {string} rel */
export function knowledgeMirrorPath(tree, rel) {
  return `${FOLDERS[tree]}/${rel}`
}

/**
 * The tree and the path inside it of a project file, or null for a file that is not part of a compiled tree.
 * @param {unknown} path @returns {{ tree: KnowledgeTree, rel: string } | null}
 */
export function knowledgeMirrorPathOf(path) {
  const file = String(path ?? '').replaceAll('\\', '/')
  for (const tree of KNOWLEDGE_TREES) {
    const folder = FOLDERS[/** @type {KnowledgeTree} */ (tree)]
    if (file.startsWith(`${folder}/`)) {
      const rel = file.slice(folder.length + 1)
      return isKnowledgeMirrorPath(rel) ? { tree: /** @type {KnowledgeTree} */ (tree), rel } : null
    }
  }
  return null
}

/** Whether a compiled file counts against the engine's page limit: Markdown whose front matter names a `type`. @param {string} rel @param {unknown} content */
export function isTypedKnowledgePage(rel, content) {
  if (!/\.md$/i.test(String(rel))) return false
  const { data, hasFrontmatter } = splitOkfFrontmatter(content)
  return hasFrontmatter && typeof data.type === 'string' && data.type.trim() !== ''
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a page

/** @param {string} path */
function normalizePath(path) {
  /** @type {string[]} */
  const out = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** @param {unknown} value @returns {string} */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * @typedef {object} KnowledgePageUnit
 * @property {number} index
 * @property {'heading' | 'item' | 'paragraph' | 'code' | 'table'} kind
 * @property {string} text     the unit as written, without the blank lines around it
 * @property {string} heading  the nearest heading above it ('' before the first); a heading unit names itself
 * @property {number} start    offset in the body
 * @property {number} end
 */

/**
 * A page's body as the units a person edits: a heading, one top-level list item with whatever is indented under it, a
 * paragraph, a table, a fenced block. The grain is what makes an edit a small thing — a person who rewrites one bullet
 * has changed one unit, not the list.
 * @param {unknown} body @returns {KnowledgePageUnit[]}
 */
export function knowledgePageUnits(body) {
  const source = String(body ?? '')
  /** @type {KnowledgePageUnit[]} */
  const units = []
  let heading = ''
  /** @type {{ kind: KnowledgePageUnit['kind'], start: number, end: number } | null} */
  let open = null
  let fence = ''
  const close = () => {
    if (!open) return
    const text = source.slice(open.start, open.end).replace(/\s+$/, '')
    if (text.trim()) {
      if (open.kind === 'heading') heading = oneLine(text.replace(/^#{1,6}[ \t]+/, ''))
      units.push({ index: units.length, kind: open.kind, text, heading, start: open.start, end: open.start + text.length })
    }
    open = null
  }
  let offset = 0
  let afterBlank = false
  for (const line of source.split('\n')) {
    const start = offset
    const end = offset + line.length
    offset = end + 1
    const wasBlank = afterBlank
    afterBlank = false
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (open) open.end = end
      if (fenceMatch && fenceMatch[1][0] === fence) { fence = ''; close() }
      continue
    }
    if (fenceMatch) { close(); fence = fenceMatch[1][0]; open = { kind: 'code', start, end }; continue }
    // A blank line ends everything but a list item, which may go on in an indented paragraph below it.
    if (!line.trim()) { if (open?.kind !== 'item') close(); afterBlank = true; continue }
    if (/^#{1,6}[ \t]+\S/.test(line)) { close(); open = { kind: 'heading', start, end }; close(); continue }
    if (/^(?:[-*+]|\d{1,3}[.)])[ \t]+/.test(line)) { close(); open = { kind: 'item', start, end }; continue }
    if (open?.kind === 'item') {
      // Indented lines belong to the item above; a line at the margin after a blank line starts something new.
      if (/^[ \t]+\S/.test(line) || !wasBlank) { open.end = end; continue }
      close()
    }
    const table = /^[ \t]*\|/.test(line)
    if (open && ((open.kind === 'table') === table)) { open.end = end; continue }
    close()
    open = { kind: table ? 'table' : 'paragraph', start, end }
  }
  close()
  return units
}

/**
 * @typedef {object} KnowledgePageLink
 * @property {'page' | 'source' | 'external'} kind
 * @property {string} text
 * @property {string} target   as written
 * @property {string | null} path  for a page link: the path it names inside the tree
 * @property {string | null} uri   for a source link: the address it names, decoded
 * @property {string | null} quote the title a source link carries
 * @property {number} index    offset of the link in the body
 * @property {number} end
 */

/**
 * One compiled page, read: its front matter, its title and type, its body's units and every link classified — to
 * another page of the tree, to a source outside it (the page's provenance), or out of the engine altogether.
 * @param {unknown} markdown
 * @param {{ path: string, root?: string }} options  `path`: the page's path in its tree; `root`: the tree's own `viking://` address
 */
export function readKnowledgePage(markdown, { path, root = '' }) {
  const { data, body, hasFrontmatter, raw } = splitOkfFrontmatter(markdown)
  const treeRoot = String(root || '').replace(/\/+$/, '')
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(body)
  const file = String(path).split('/').pop() ?? ''
  const directory = String(path).includes('/') ? String(path).slice(0, String(path).lastIndexOf('/')) : ''
  /** @type {KnowledgePageLink[]} */
  const links = []
  for (const link of okfMarkdownLinks(body)) {
    const target = okfLinkPath(link.target)
    if (!target) continue
    const base = { text: link.text, target: link.target, index: link.index, end: link.end }
    if (target.startsWith('viking://')) {
      if (treeRoot && target.startsWith(`${treeRoot}/`)) links.push({ ...base, kind: 'page', path: normalizePath(target.slice(treeRoot.length + 1)), uri: null, quote: null })
      else links.push({ ...base, kind: 'source', path: null, uri: target, quote: typeof link.title === 'string' && link.title.trim() ? link.title.trim() : null })
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      links.push({ ...base, kind: 'external', path: null, uri: null, quote: null })
    } else {
      links.push({ ...base, kind: 'page', path: normalizePath(`${target.startsWith('/') ? '' : `${directory}/`}${target}`), uri: null, quote: null })
    }
  }
  return {
    frontmatter: data, hasFrontmatter, frontmatterRaw: raw, body,
    title: String(data.title || (heading ? heading[1] : file.replace(/\.md$/i, ''))),
    type: String(data.type || (directory ? directory.split('/')[0] : file.replace(/\.md$/i, '')) || 'other'),
    description: typeof data.description === 'string' ? data.description : '',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    units: knowledgePageUnits(body), links,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A person's edits

/**
 * What a person wrote into a page, as the ledger keeps it.
 * @typedef {object} KnowledgeUserBlock
 * @property {string} id        stable for the same words: `ub_` and a digest the caller computes
 * @property {string} text      the unit as the person left it
 * @property {string} heading   the heading it sat under
 * @property {string | null} after     the unit just above it, to put it back where it was
 * @property {string | null} replaces  the engine's unit it took the place of, when it reworded one
 */

/**
 * @typedef {object} KnowledgeUserEdits
 * @property {KnowledgeUserBlock[]} blocks
 * @property {{ id: string, text: string }[]} removed  the engine's units the person took out
 * @property {Record<string, string>} frontmatter     `title` / `description` as the person set them
 */

/** @returns {KnowledgeUserEdits} */
export function emptyKnowledgeUserEdits() {
  return { blocks: [], removed: [], frontmatter: {} }
}

/** How two units are compared: by their words, whatever the spacing. @param {unknown} text */
export function knowledgeUnitKey(text) {
  return oneLine(text).normalize('NFKC')
}

/**
 * The longest run of units two bodies share, in order: pairs of positions.
 * @param {string[]} left @param {string[]} right @returns {Array<[number, number]>}
 */
function sharedUnits(left, right) {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = new Uint16Array(rows * columns)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = left[i] === right[j] ? table[(i + 1) * columns + j + 1] + 1 : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1])
    }
  }
  /** @type {Array<[number, number]>} */
  const pairs = []
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) { pairs.push([i, j]); i += 1; j += 1 } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) i += 1
    else j += 1
  }
  return pairs
}

/**
 * What a save changed: the page as it stood (`before`) against the page as the person left it (`after`), folded into
 * the edits the ledger already held. A unit the person added or reworded becomes a block; an engine unit they took out
 * is remembered as removed; a block of theirs they took out is forgotten; the title and the description are kept when
 * they changed them. `digest` names a block by its words, so the same passage keeps its id across saves.
 *
 * @param {unknown} before @param {unknown} after @param {KnowledgeUserEdits | null | undefined} held
 * @param {{ digest: (text: string) => string }} options
 * @returns {{ edits: KnowledgeUserEdits, added: number, removed: number, dropped: number }}
 *   `dropped`: blocks beyond `KNOWLEDGE_USER_EDIT_LIMITS` that could not be kept
 */
export function diffKnowledgePageEdit(before, after, held, { digest }) {
  const was = splitOkfFrontmatter(before)
  const now = splitOkfFrontmatter(after)
  const left = knowledgePageUnits(was.body)
  const right = knowledgePageUnits(now.body)
  const leftKeys = left.map((unit) => knowledgeUnitKey(unit.text))
  const rightKeys = right.map((unit) => knowledgeUnitKey(unit.text))
  const pairs = sharedUnits(leftKeys, rightKeys)
  const edits = { blocks: [...(held?.blocks ?? [])], removed: [...(held?.removed ?? [])], frontmatter: { ...(held?.frontmatter ?? {}) } }
  const mine = new Map(edits.blocks.map((block) => [knowledgeUnitKey(block.text), block]))
  let added = 0
  let removed = 0
  let dropped = 0
  let i = 0
  let j = 0
  for (const [nextLeft, nextRight] of [...pairs, /** @type {[number, number]} */ ([left.length, right.length])]) {
    const gone = left.slice(i, nextLeft)
    const fresh = right.slice(j, nextRight)
    fresh.forEach((unit, position) => {
      const key = knowledgeUnitKey(unit.text)
      const old = gone[position]
      const oldKey = old ? knowledgeUnitKey(old.text) : null
      // A block of the person's own that they reworded is that block, with new words.
      const previous = oldKey ? mine.get(oldKey) : undefined
      const block = {
        id: `ub_${digest(key)}`, text: unit.text.slice(0, KNOWLEDGE_USER_EDIT_LIMITS.blockChars), heading: unit.kind === 'heading' ? (right[unit.index - 1]?.heading ?? '') : unit.heading,
        after: unit.index > 0 ? right[unit.index - 1].text : null,
        replaces: previous ? previous.replaces : old ? old.text : null,
      }
      if (previous) edits.blocks = edits.blocks.filter((entry) => entry !== previous)
      edits.blocks = edits.blocks.filter((entry) => entry.id !== block.id)
      if (edits.blocks.length >= KNOWLEDGE_USER_EDIT_LIMITS.blocks) { dropped += 1; return }
      edits.blocks.push(block)
      // Words the person brought back are no longer words they took out.
      edits.removed = edits.removed.filter((entry) => knowledgeUnitKey(entry.text) !== key)
      added += 1
    })
    gone.slice(fresh.length).forEach((unit) => {
      const key = knowledgeUnitKey(unit.text)
      const own = mine.get(key)
      if (own) { edits.blocks = edits.blocks.filter((entry) => entry !== own); removed += 1; return }
      if (edits.removed.some((entry) => knowledgeUnitKey(entry.text) === key)) return
      edits.removed = [...edits.removed, { id: `ur_${digest(key)}`, text: unit.text.slice(0, KNOWLEDGE_USER_EDIT_LIMITS.blockChars) }].slice(-KNOWLEDGE_USER_EDIT_LIMITS.removed)
      removed += 1
    })
    i = nextLeft + 1
    j = nextRight + 1
  }
  for (const key of ['title', 'description']) {
    const value = now.data[key]
    if (typeof value === 'string' && value !== was.data[key]) edits.frontmatter[key] = value
  }
  return { edits, added, removed, dropped }
}

/** One front-matter scalar set to a value, the rest of the block as it was. @param {string} raw @param {string} key @param {string} value */
function withFrontmatterValue(raw, key, value) {
  const lines = raw.split('\n')
  const at = lines.findIndex((line) => new RegExp(`^${key}:(?:[ \\t]|$)`).test(line))
  const written = `${key}: ${JSON.stringify(oneLine(value))}`
  if (at === -1) {
    const end = lines.findLastIndex((line) => /^---[ \t]*$/.test(line))
    if (end <= 0) return raw
    lines.splice(end, 0, written)
    return lines.join('\n')
  }
  let last = at
  while (last + 1 < lines.length && /^[ \t]+\S/.test(lines[last + 1])) last += 1
  lines.splice(at, last - at + 1, written)
  return lines.join('\n')
}

/**
 * A page as a compile left it, with the person's edits put back where the engine dropped them. A block still in the
 * page word for word is left alone. One that is gone goes back in the place of the unit it had reworded when that unit
 * is there again, else under the unit it used to follow, else at the end of its section, else at the end of the page.
 * A unit the person took out and the engine wrote again is taken out again.
 *
 * @param {unknown} markdown @param {KnowledgeUserEdits | null | undefined} edits
 * @returns {{ markdown: string, restored: string[], removedAgain: string[], changed: boolean }}  ids of what was put back and of what was taken out again
 */
export function applyKnowledgePageEdits(markdown, edits) {
  const original = String(markdown ?? '')
  if (!edits || (!edits.blocks?.length && !edits.removed?.length && !Object.keys(edits.frontmatter ?? {}).length)) {
    return { markdown: original, restored: [], removedAgain: [], changed: false }
  }
  const { data, body: firstBody, raw: firstRaw, hasFrontmatter } = splitOkfFrontmatter(original)
  let raw = firstRaw
  let body = firstBody
  /** @type {string[]} */
  const restored = []
  /** @type {string[]} */
  const removedAgain = []
  if (hasFrontmatter) {
    for (const [key, value] of Object.entries(edits.frontmatter ?? {})) {
      if (data[key] !== value) { raw = withFrontmatterValue(raw, key, value); restored.push(`fm_${key}`) }
    }
  }
  /** Replace `[start, end)` of the body. @param {number} start @param {number} end @param {string} text */
  const splice = (start, end, text) => { body = body.slice(0, start) + text + body.slice(end) }
  for (const entry of edits.removed ?? []) {
    const key = knowledgeUnitKey(entry.text)
    const unit = knowledgePageUnits(body).find((candidate) => knowledgeUnitKey(candidate.text) === key)
    if (!unit) continue
    // The unit and the blank line after it.
    const tail = /^\n{1,2}/.exec(body.slice(unit.end))?.[0].length ?? 0
    splice(unit.start, unit.end + tail, '')
    removedAgain.push(entry.id)
  }
  for (const block of edits.blocks ?? []) {
    const units = knowledgePageUnits(body)
    const key = knowledgeUnitKey(block.text)
    if (units.some((unit) => knowledgeUnitKey(unit.text) === key)) continue
    const find = (/** @type {string | null} */ text) => (text ? units.find((unit) => knowledgeUnitKey(unit.text) === knowledgeUnitKey(text)) : undefined)
    const replaced = find(block.replaces)
    if (replaced) splice(replaced.start, replaced.end, block.text)
    else {
      const section = units.filter((unit) => unit.heading === block.heading)
      const anchor = find(block.after) ?? (block.heading ? section.at(-1) : undefined)
      // A list item goes straight under the item it followed; anything else is its own paragraph.
      const tight = anchor?.kind === 'item' && /^(?:[-*+]|\d{1,3}[.)])[ \t]+/.test(block.text)
      if (anchor) splice(anchor.end, anchor.end, `${tight ? '\n' : '\n\n'}${block.text}`)
      else body = `${body.replace(/\s+$/, '')}\n\n${block.text}\n`
    }
    restored.push(block.id)
  }
  const result = `${raw}${body}`
  return { markdown: result, restored, removedAgain, changed: result !== original }
}
