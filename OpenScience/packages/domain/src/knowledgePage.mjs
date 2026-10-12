/**
 * Knowledge pages (「知识页」): the format contract of a personal wiki that a model
 * compiles out of a project's documents and that code checks sentence by sentence.
 *
 * Hidden knowledge:
 *
 * - **A page is an index, never evidence.** Every statement a page makes carries one or
 *   more verbatim quotations from the document it comes from, written in the one
 *   citation protocol the platform already has (`<!-- evimed-source:{"sourceId":…,
 *   "quote":…} -->`, `sourceCitations.mjs`). A reply or a report that reads a page cites
 *   the document the quotation names, never the page.
 * - **The model writes language; code decides facts.** The model chooses topics, merges
 *   synonyms and words a sentence. Whether a quotation is in the document it names is a
 *   string comparison (`quoteIsPresent`, the platform's one), whether a link points at a
 *   page is a lookup, whether a claim has the quotations its kind needs is a count. None
 *   of it is read out of prose with a pattern.
 * - **The model never types the Markdown.** It hands back structured claims
 *   (`wiki-patch.json`); `renderKnowledgePage` writes the page, so the markers are exact
 *   and a page the platform wrote always parses. A page a researcher edits afterwards is
 *   parsed by the same closed format (`parseKnowledgePage`), which only knows front
 *   matter, headings, list items, paragraphs and the two comment markers.
 * - **A sentence the code cannot confirm is held, not dropped.** `settleKnowledgePage`
 *   returns the claims that stand and the claims that were held with the reason for each;
 *   the caller keeps both. Held claims are not written into the page file (which is what
 *   a search reads), so they are never recalled, and they are shown to the researcher as
 *   unconfirmed (⚠). A page is never refused as a whole for a failing sentence.
 * - **Two kinds of claim, no more.** `direct`: one document, quoted. `synthesized`: a
 *   statement across documents — at least two different documents, each quoted, and a
 *   confidence word. A compiler does not make its own estimates, so there is no `derived`.
 *
 * Pure and browser-safe, like the rest of the package.
 *
 * Citation formats used here are a subset of `sourceCitations.mjs`: this module reads and
 * writes the same comment, with `>` escaped inside the JSON so a quotation holding `-->`
 * cannot end the comment early.
 *
 * @module @evimed/domain/knowledge-page
 */

import { quoteIsPresent } from './clinicalEvidence.mjs'
import { locateSourceQuotation } from './sourceCitations.mjs'

export const KNOWLEDGE_PAGE_FOLDER = 'knowledge-base/wiki'
export const KNOWLEDGE_COMPILE_INPUT_FILE = 'knowledge-compile-input.json'
export const KNOWLEDGE_WIKI_PATCH_FILE = 'wiki-patch.json'
export const KNOWLEDGE_PATCH_VERSION = 1

/** The page types a compiler may write. The index page is the platform's, rendered from the pages (`renderKnowledgeIndex`). */
export const KNOWLEDGE_PAGE_TYPES = Object.freeze([
  { id: 'topic', label: '主题' },
  { id: 'entity', label: '实体' },
  { id: 'method', label: '方法' },
  { id: 'comparison', label: '比较' },
  { id: 'review', label: '综述' },
].map((type) => Object.freeze(type)))

/** @typedef {'topic' | 'entity' | 'method' | 'comparison' | 'review'} KnowledgePageType */

export const KNOWLEDGE_INDEX_SLUG = 'index'
export const KNOWLEDGE_INDEX_TITLE = '知识页目录'
export const KNOWLEDGE_CONFIDENCE = Object.freeze(['high', 'moderate', 'low'])
export const KNOWLEDGE_CLAIM_KINDS = Object.freeze(['direct', 'synthesized'])
export const KNOWLEDGE_PATCH_OPERATIONS = Object.freeze(['create', 'update', 'retire'])
export const KNOWLEDGE_LINT_KINDS = Object.freeze(['conflict', 'duplicate', 'gap', 'stale'])
/** The heading the compiler's additions to a researcher's page go under. */
export const KNOWLEDGE_UPDATE_HEADING = '来源更新后新增'

/**
 * Bounds of one patch and of one page. They protect the reader and the run (a page nobody can read, a patch that cannot be
 * checked in a turn), not an opinion about how much a topic deserves.
 */
export const KNOWLEDGE_PAGE_LIMITS = Object.freeze({
  pages: 16,
  sections: 10,
  claimsPerSection: 20,
  claimsPerPage: 60,
  evidencePerClaim: 5,
  related: 12,
  titleChars: 120,
  headingChars: 80,
  claimChars: 500,
  quoteMinChars: 10,
  quoteMaxChars: 600,
  lint: 24,
  noteChars: 400,
})

const SLUG = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]{0,62}$/u
const SOURCE_ID = /^src_[a-f0-9]{32}$/
const SOURCE_MARKER = /<!--\s*evimed-source:\s*(\{[^\n]{1,8000}?\})\s*-->/g
const CLAIM_MARKER = /<!--\s*evimed-claim:\s*(\{[^\n]{1,400}?\})\s*-->/g
const WIKILINK = /\[\[([^[\]|\n]{1,80})(?:\|[^[\]\n]{1,160})?\]\]/g
const HAS_WORD = /[\p{L}\p{N}]/u

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** @param {unknown} value @returns {boolean} */
export function isKnowledgePageSlug(value) {
  return typeof value === 'string' && SLUG.test(value) && value !== KNOWLEDGE_INDEX_SLUG
}

/** @param {unknown} value @returns {value is KnowledgePageType} */
export function isKnowledgePageType(value) {
  return KNOWLEDGE_PAGE_TYPES.some((type) => type.id === value)
}

/** The Chinese name of a page type; the index page's type reads 「目录」. @param {unknown} type */
export function knowledgePageTypeLabel(type) {
  if (type === 'index') return '目录'
  return KNOWLEDGE_PAGE_TYPES.find((entry) => entry.id === type)?.label ?? '主题'
}

/** Where a page of this slug lives in a project's knowledge base. @param {string} slug */
export function knowledgePagePath(slug) {
  return `${KNOWLEDGE_PAGE_FOLDER}/${slug}.md`
}

/** The slug of a path in the wiki folder, or null for any other path. @param {unknown} path @returns {string | null} */
export function knowledgePageSlugOfPath(path) {
  const file = String(path ?? '').replaceAll('\\', '/')
  if (!file.startsWith(`${KNOWLEDGE_PAGE_FOLDER}/`) || !file.endsWith('.md')) return null
  const slug = file.slice(KNOWLEDGE_PAGE_FOLDER.length + 1, -3)
  return slug === KNOWLEDGE_INDEX_SLUG || isKnowledgePageSlug(slug) ? slug : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing a page

/**
 * JSON for a comment: `>` and `<` are escaped, so a quotation that holds `-->` is still one comment and still the same
 * string when parsed.
 * @param {unknown} value @returns {string}
 */
function commentJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

/** @param {string} sourceId @param {string} quote @returns {string} */
export function knowledgeSourceMarker(sourceId, quote) {
  return `<!-- evimed-source:${commentJson({ sourceId, quote })} -->`
}

/**
 * @typedef {object} KnowledgeEvidence
 * @property {string} sourceId
 * @property {string} quote
 */

/**
 * @typedef {object} KnowledgeClaim
 * @property {string} text
 * @property {'direct' | 'synthesized'} [kind]
 * @property {'high' | 'moderate' | 'low'} [confidence]
 * @property {KnowledgeEvidence[]} evidence
 */

/**
 * @typedef {object} KnowledgeSection
 * @property {string} heading
 * @property {KnowledgeClaim[]} claims
 */

/**
 * @typedef {object} KnowledgePageContent
 * @property {string} type
 * @property {string} title
 * @property {KnowledgeSection[]} sections
 * @property {string[]} [related]
 */

/** One claim as a list item: its sentence, then its quotations, then — for a statement across documents — its kind.
 * @param {KnowledgeClaim} claim @returns {string} */
export function renderKnowledgeClaim(claim) {
  const markers = claim.evidence.map((entry) => knowledgeSourceMarker(entry.sourceId, entry.quote))
  const across = new Set(claim.evidence.map((entry) => entry.sourceId)).size > 1
  const kind = across ? [`<!-- evimed-claim:${commentJson({ kind: 'synthesized', ...(claim.confidence ? { confidence: claim.confidence } : {}) })} -->`] : []
  return `- ${oneLine(claim.text)} ${[...markers, ...kind].join(' ')}`
}

/**
 * The Markdown of a page. Front matter holds the closed fields (`type`, `title`); there is no summary, because a
 * sentence with no quotation has no place in a page.
 * @param {KnowledgePageContent} page @returns {string}
 */
export function renderKnowledgePage(page) {
  const lines = ['---', `type: ${page.type}`, `title: ${JSON.stringify(oneLine(page.title))}`, '---', '', `# ${oneLine(page.title)}`, '']
  for (const section of page.sections) {
    if (!section.claims.length) continue
    lines.push(`## ${oneLine(section.heading)}`, '')
    for (const claim of section.claims) lines.push(renderKnowledgeClaim(claim))
    lines.push('')
  }
  const related = [...new Set((page.related ?? []).filter((slug) => isKnowledgePageSlug(slug)))]
  if (related.length) lines.push('## 相关', '', related.map((slug) => `[[${slug}]]`).join(' · '), '')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * The index page, rendered from what the pages are: a list of links with counts the platform computed. No sentence of
 * the model's is in it.
 * @param {ReadonlyArray<{ slug: string, type: string, title: string, claims: number, sources: number }>} pages
 */
export function renderKnowledgeIndex(pages) {
  const lines = ['---', 'type: index', `title: ${JSON.stringify(KNOWLEDGE_INDEX_TITLE)}`, '---', '', `# ${KNOWLEDGE_INDEX_TITLE}`, '']
  for (const type of KNOWLEDGE_PAGE_TYPES) {
    const group = pages.filter((page) => page.type === type.id).sort((left, right) => left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0)
    if (!group.length) continue
    lines.push(`## ${type.label}`, '')
    for (const page of group) lines.push(`- [[${page.slug}|${oneLine(oneLine(page.title).replace(/[[\]|]/g, ' '))}]] · ${page.claims} 条 · ${page.sources} 份资料`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a page

/**
 * @typedef {object} KnowledgeUnit
 * @property {number} index  the unit's position among the page's units
 * @property {number} line   1-based line of its first line
 * @property {string} section the heading it sits under, or ''
 * @property {'claim' | 'nav'} kind
 * @property {string} text   its words, markers taken out
 * @property {KnowledgeEvidence[]} evidence
 * @property {{ kind: 'direct' | 'synthesized', confidence: string | null } | null} claimMeta
 * @property {string[]} links  the pages it links to
 */

/**
 * @typedef {object} ParsedKnowledgePage
 * @property {{ type: string | null, title: string | null }} frontMatter
 * @property {string | null} title the first heading, else the front matter's
 * @property {KnowledgeUnit[]} units
 */

/** @param {string} raw @returns {{ type: string | null, title: string | null, body: string[], offset: number }} */
function splitFrontMatter(raw) {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  /** @type {{ type: string | null, title: string | null }} */
  const fields = { type: null, title: null }
  if (lines[0]?.trim() !== '---') return { ...fields, body: lines, offset: 0 }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { ...fields, body: lines, offset: 0 }
  for (const line of lines.slice(1, end)) {
    const match = /^(type|title):\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.startsWith('"')) {
      try { value = String(JSON.parse(value)) } catch { /* a value that is not JSON is read as written */ }
    }
    fields[/** @type {'type' | 'title'} */ (match[1])] = value || null
  }
  return { ...fields, body: lines.slice(end + 1), offset: end + 1 }
}

/** @param {string} text @returns {KnowledgeEvidence[]} */
function evidenceOf(text) {
  /** @type {KnowledgeEvidence[]} */
  const found = []
  for (const match of text.matchAll(SOURCE_MARKER)) {
    try {
      const value = JSON.parse(match[1])
      if (isRecord(value) && typeof value.sourceId === 'string' && typeof value.quote === 'string') found.push({ sourceId: value.sourceId, quote: value.quote })
    } catch { /* a comment that is not JSON is not a citation */ }
  }
  return found
}

/** @param {string} text @returns {{ kind: 'direct' | 'synthesized', confidence: string | null } | null} */
function claimMetaOf(text) {
  for (const match of text.matchAll(CLAIM_MARKER)) {
    try {
      const value = JSON.parse(match[1])
      if (isRecord(value) && (value.kind === 'direct' || value.kind === 'synthesized')) {
        return { kind: value.kind, confidence: typeof value.confidence === 'string' ? value.confidence : null }
      }
    } catch { /* ignored */ }
  }
  return null
}

/**
 * Read a page: its units (a list item with its continuation lines, or a paragraph) with the quotations each carries.
 * The format is closed — front matter, headings, list items, paragraphs, fenced code (ignored) and the two comment
 * markers — so a page a researcher has edited in any editor is read the same way as one the platform wrote.
 * @param {string} markdown @returns {ParsedKnowledgePage}
 */
export function parseKnowledgePage(markdown) {
  const { type, title: frontTitle, body, offset } = splitFrontMatter(String(markdown ?? ''))
  /** @type {KnowledgeUnit[]} */
  const units = []
  let heading = ''
  let first = ''
  /** @type {{ line: number, parts: string[] } | null} */
  let open = null
  let fenced = false
  const close = () => {
    if (!open) return
    const raw = open.parts.join(' ')
    const evidence = evidenceOf(raw)
    const claimMeta = claimMetaOf(raw)
    const stripped = oneLine(raw.replace(SOURCE_MARKER, ' ').replace(CLAIM_MARKER, ' '))
    const links = [...stripped.matchAll(WIKILINK)].map((match) => match[1].trim())
    const words = oneLine(stripped.replace(WIKILINK, ' '))
    // A unit made of links and separators is navigation; one with neither words nor links is a rule or a stray mark.
    if (HAS_WORD.test(words)) units.push({ index: units.length, line: open.line, section: heading, kind: 'claim', text: stripped, evidence, claimMeta, links })
    else if (links.length) units.push({ index: units.length, line: open.line, section: heading, kind: 'nav', text: stripped, evidence: [], claimMeta: null, links })
    open = null
  }
  body.forEach((line, index) => {
    const number = offset + index + 1
    if (/^\s*(```|~~~)/.test(line)) { close(); fenced = !fenced; return }
    if (fenced) return
    if (!line.trim()) { close(); return }
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line)
    if (headingMatch) {
      close()
      heading = oneLine(headingMatch[1])
      if (!first && /^#\s/.test(line)) first = heading
      return
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) { close(); open = { line: number, parts: [item[1]] }; return }
    if (open) open.parts.push(line.trim())
    else open = { line: number, parts: [line.trim()] }
  })
  close()
  return { frontMatter: { type, title: frontTitle }, title: first || frontTitle, units }
}

/** The distinct documents a parsed page quotes. @param {ParsedKnowledgePage} page @returns {string[]} */
export function knowledgePageSources(page) {
  return [...new Set(page.units.flatMap((unit) => unit.evidence.map((entry) => entry.sourceId)))]
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking a page against the documents

/**
 * The reason one quotation did not stand.
 * @typedef {'quote_not_found' | 'source_unavailable' | 'quote_invalid'} KnowledgeEvidenceFailure
 */

/**
 * @typedef {object} CheckedEvidence
 * @property {string} sourceId
 * @property {string} quote
 * @property {'verified' | KnowledgeEvidenceFailure} status
 * @property {number | null} start  the quotation's UTF-16 offset when the passage is unambiguous in the document
 * @property {number | null} end
 */

/** @typedef {(sourceId: string) => { text: string } | null} KnowledgeTextResolver */

/**
 * One quotation against the document it names, by the platform's one comparison (`quoteIsPresent`).
 * @param {KnowledgeEvidence} entry @param {KnowledgeTextResolver} resolve @returns {CheckedEvidence}
 */
export function checkKnowledgeEvidence(entry, resolve) {
  const base = { sourceId: entry.sourceId, quote: entry.quote, start: null, end: null }
  if (typeof entry.quote !== 'string' || entry.quote.trim().length < KNOWLEDGE_PAGE_LIMITS.quoteMinChars
    || entry.quote.length > KNOWLEDGE_PAGE_LIMITS.quoteMaxChars || !SOURCE_ID.test(String(entry.sourceId))) return { ...base, status: 'quote_invalid' }
  const document = resolve(entry.sourceId)
  if (!document || typeof document.text !== 'string') return { ...base, status: 'source_unavailable' }
  if (!quoteIsPresent(document.text, entry.quote)) return { ...base, status: 'quote_not_found' }
  const located = locateSourceQuotation({ text: document.text, quote: entry.quote })
  return { ...base, status: 'verified', start: located.start ?? null, end: located.end ?? null }
}

/**
 * The check of a statement's quotations as a whole: every one must stand, a direct statement quotes one document, and a
 * statement across documents needs two different documents among them and a confidence word. Pure counting.
 * @param {ReadonlyArray<CheckedEvidence>} checked @param {'direct' | 'synthesized'} kind
 * @param {{ confidence?: unknown, needsConfidence?: boolean }} [options] `needsConfidence`: ask for the word (a compiler's claim; a researcher's own edit may have lost it)
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function judgeKnowledgeEvidence(checked, kind, { confidence = null, needsConfidence = false } = {}) {
  /** @type {string[]} */
  const reasons = []
  if (!checked.length) reasons.push('no_evidence')
  for (const entry of checked) if (entry.status !== 'verified') reasons.push(entry.status)
  const documents = new Set(checked.map((entry) => entry.sourceId)).size
  if (kind === 'synthesized' && documents < 2) reasons.push('single_document')
  if (kind === 'direct' && documents > 1) reasons.push('multiple_documents')
  if (kind === 'synthesized' && needsConfidence && !KNOWLEDGE_CONFIDENCE.includes(String(confidence))) reasons.push('missing_confidence')
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}

/**
 * @typedef {object} CheckedUnit
 * @property {number} index
 * @property {number} line
 * @property {string} section
 * @property {string} text
 * @property {'direct' | 'synthesized'} kind  `synthesized` when the quotations come from more than one document
 * @property {string | null} confidence
 * @property {CheckedEvidence[]} evidence
 * @property {'verified' | 'unverified' | 'unsupported'} status `unsupported`: no quotation at all (the researcher's own sentence)
 * @property {string[]} reasons
 */

/**
 * A parsed page against the documents it quotes. A researcher's own sentence — one with no quotation — is `unsupported`,
 * which is a statement about the sentence and not a failure: only a quotation that does not stand makes a sentence
 * `unverified`. An index page has nothing to check.
 * @param {ParsedKnowledgePage} page @param {KnowledgeTextResolver} resolve
 * @param {{ pages?: ReadonlySet<string> | null }} [options] `pages`: the slugs that exist, to name links that lead nowhere
 * @returns {{ units: CheckedUnit[], counts: { claims: number, verified: number, unverified: number, unsupported: number },
 *   sources: string[], dangling: string[], notices: string[] }}
 */
export function verifyKnowledgePage(page, resolve, { pages = null } = {}) {
  /** @type {CheckedUnit[]} */
  const units = []
  /** @type {Set<string>} */
  const dangling = new Set()
  /** @type {Set<string>} */
  const notices = new Set()
  if (page.frontMatter.type !== 'index') {
    for (const unit of page.units) {
      if (pages) for (const link of unit.links) if (!pages.has(link) && link !== KNOWLEDGE_INDEX_SLUG) dangling.add(link)
      if (unit.kind !== 'claim') continue
      const checked = unit.evidence.map((entry) => checkKnowledgeEvidence(entry, resolve))
      const documents = new Set(checked.map((entry) => entry.sourceId)).size
      const kind = documents > 1 ? 'synthesized' : 'direct'
      const judged = judgeKnowledgeEvidence(checked, kind)
      const status = !checked.length ? 'unsupported' : judged.ok ? 'verified' : 'unverified'
      // A statement across documents names how sure it is; one a researcher edited may have lost the word.
      if (status === 'verified' && kind === 'synthesized' && !KNOWLEDGE_CONFIDENCE.includes(String(unit.claimMeta?.confidence))) notices.add('synthesized_without_confidence')
      units.push({ index: unit.index, line: unit.line, section: unit.section, text: unit.text, kind,
        confidence: unit.claimMeta?.confidence ?? null, evidence: checked, status, reasons: status === 'unsupported' ? [] : judged.reasons })
    }
  }
  const count = (/** @type {string} */ status) => units.filter((unit) => unit.status === status).length
  return { units, counts: { claims: units.length, verified: count('verified'), unverified: count('unverified'), unsupported: count('unsupported') },
    sources: knowledgePageSources(page), dangling: [...dangling], notices: [...notices] }
}

// ---------------------------------------------------------------------------------------------------------------------
// The patch a compiler hands back

/**
 * @typedef {object} KnowledgePatchPage
 * @property {'create' | 'update' | 'retire'} op
 * @property {string} slug
 * @property {string} [type]
 * @property {string} [title]
 * @property {KnowledgeSection[]} [sections]
 * @property {string[]} [related]
 * @property {string} [mergedInto]  for `retire`: the page that now holds what this one held
 * @property {string} [reason]
 */

/**
 * @typedef {object} KnowledgeCompileInput
 * @property {number} schemaVersion
 * @property {Array<{ sourceId: string, title: string, generation?: number, textSha256?: string, text: string }>} sources
 * @property {Array<{ slug: string, type?: string, title?: string }>} [pages]  the pages that exist
 */

/**
 * @typedef {object} KnowledgePatchIssue
 * @property {string} message
 * @property {'required' | 'advisory'} severity
 * @property {string} check  `knowledge-wiki-schema` for a patch that cannot be read, `knowledge-wiki-quote` for a quotation the input does not hold
 */

/** A patch the run cannot repair its way past without changing it. @param {string} message @returns {KnowledgePatchIssue} */
function schema(message) {
  return { message, severity: 'required', check: 'knowledge-wiki-schema' }
}

/** A finding about the patch that withholds nothing. @param {string} message @returns {KnowledgePatchIssue} */
function advice(message) {
  return { message, severity: 'advisory', check: 'knowledge-wiki-schema' }
}

/** A quotation the run's input does not hold. @param {string} message @returns {KnowledgePatchIssue} */
function quoteAdvice(message) {
  return { message, severity: 'advisory', check: 'knowledge-wiki-quote' }
}

/**
 * What is wrong with a patch. A patch that cannot be read — wrong shape, a document nobody gave the compiler, a link to
 * nowhere — is `required`: the run repairs it in its own turn. A quotation the input does not hold is `advisory`: the
 * run is told which sentence and may fix it, and the control plane checks again against the whole document and holds
 * what still does not stand (`settleKnowledgePage`), so a failing sentence never withholds a page.
 * @param {unknown} patch @param {unknown} input @returns {KnowledgePatchIssue[]}
 */
export function knowledgePatchIssues(patch, input) {
  /** @type {KnowledgePatchIssue[]} */
  const issues = []
  if (!isRecord(patch)) return [schema('wiki-patch.json must be an object.')]
  if (patch.schemaVersion !== KNOWLEDGE_PATCH_VERSION) issues.push(schema(`schemaVersion must be ${KNOWLEDGE_PATCH_VERSION}.`))
  const pages = patch.pages
  if (!Array.isArray(pages) || pages.length > KNOWLEDGE_PAGE_LIMITS.pages) {
    issues.push(schema(`pages must be a list of at most ${KNOWLEDGE_PAGE_LIMITS.pages} pages.`))
    return issues
  }
  const given = isRecord(input) && Array.isArray(input.sources) ? input.sources : []
  /** @type {Map<string, string>} */
  const texts = new Map()
  for (const source of given) if (isRecord(source) && typeof source.sourceId === 'string' && typeof source.text === 'string') texts.set(source.sourceId, source.text)
  const existing = new Set((isRecord(input) && Array.isArray(input.pages) ? input.pages : []).map((page) => isRecord(page) ? String(page.slug) : ''))
  const touched = new Set()
  /** @type {Set<string>} */
  const writing = new Set()
  pages.forEach((page, position) => {
    const at = `pages[${position}]`
    if (!isRecord(page)) { issues.push(schema(`${at} must be an object.`)); return }
    if (!KNOWLEDGE_PATCH_OPERATIONS.includes(page.op)) issues.push(schema(`${at}.op must be one of ${KNOWLEDGE_PATCH_OPERATIONS.join(', ')}.`))
    if (!isKnowledgePageSlug(page.slug)) { issues.push(schema(`${at}.slug must be 1-63 lowercase letters, digits or hyphens, and not "${KNOWLEDGE_INDEX_SLUG}".`)); return }
    if (touched.has(page.slug)) issues.push(schema(`${at}.slug "${page.slug}" appears twice in this patch.`))
    touched.add(page.slug)
    if (page.op === 'create' && existing.has(page.slug)) issues.push(schema(`${at}: "${page.slug}" already exists; use op "update" to rewrite it.`))
    if ((page.op === 'update' || page.op === 'retire') && existing.size && !existing.has(page.slug)) issues.push(schema(`${at}: "${page.slug}" does not exist; use op "create".`))
    if (page.op === 'retire') {
      if (page.mergedInto != null && !isKnowledgePageSlug(page.mergedInto)) issues.push(schema(`${at}.mergedInto must be a page slug.`))
      return
    }
    writing.add(page.slug)
    if (!isKnowledgePageType(page.type)) issues.push(schema(`${at}.type must be one of ${KNOWLEDGE_PAGE_TYPES.map((type) => type.id).join(', ')}.`))
    if (typeof page.title !== 'string' || !oneLine(page.title) || oneLine(page.title).length > KNOWLEDGE_PAGE_LIMITS.titleChars) issues.push(schema(`${at}.title must be 1-${KNOWLEDGE_PAGE_LIMITS.titleChars} characters.`))
    if (!Array.isArray(page.sections) || !page.sections.length || page.sections.length > KNOWLEDGE_PAGE_LIMITS.sections) {
      issues.push(schema(`${at}.sections must be a list of 1-${KNOWLEDGE_PAGE_LIMITS.sections} sections.`))
      return
    }
    let claims = 0
    page.sections.forEach((section, sectionPosition) => {
      const where = `${at}.sections[${sectionPosition}]`
      if (!isRecord(section)) { issues.push(schema(`${where} must be an object.`)); return }
      if (typeof section.heading !== 'string' || !oneLine(section.heading) || oneLine(section.heading).length > KNOWLEDGE_PAGE_LIMITS.headingChars) issues.push(schema(`${where}.heading must be 1-${KNOWLEDGE_PAGE_LIMITS.headingChars} characters.`))
      if (!Array.isArray(section.claims) || section.claims.length > KNOWLEDGE_PAGE_LIMITS.claimsPerSection) { issues.push(schema(`${where}.claims must be a list of at most ${KNOWLEDGE_PAGE_LIMITS.claimsPerSection} claims.`)); return }
      section.claims.forEach((claim, claimPosition) => {
        claims += 1
        issues.push(...claimIssues(claim, `${where}.claims[${claimPosition}]`, texts))
      })
    })
    if (claims > KNOWLEDGE_PAGE_LIMITS.claimsPerPage) issues.push(schema(`${at} has ${claims} claims; a page holds at most ${KNOWLEDGE_PAGE_LIMITS.claimsPerPage}. Split it into pages of their own.`))
    if (page.related != null && (!Array.isArray(page.related) || page.related.length > KNOWLEDGE_PAGE_LIMITS.related || page.related.some((slug) => !isKnowledgePageSlug(slug)))) {
      issues.push(schema(`${at}.related must be a list of at most ${KNOWLEDGE_PAGE_LIMITS.related} page slugs.`))
    }
  })
  // A link to a page that is neither here nor in this patch leads nowhere.
  for (const [position, page] of pages.entries()) {
    if (!isRecord(page) || page.op === 'retire' || !Array.isArray(page.related)) continue
    for (const slug of page.related) if (isKnowledgePageSlug(slug) && !existing.has(slug) && !writing.has(slug)) issues.push(schema(`pages[${position}].related names "${slug}", which is neither an existing page nor a page of this patch.`))
  }
  if (patch.lint != null) {
    if (!Array.isArray(patch.lint) || patch.lint.length > KNOWLEDGE_PAGE_LIMITS.lint) issues.push(schema(`lint must be a list of at most ${KNOWLEDGE_PAGE_LIMITS.lint} findings.`))
    else patch.lint.forEach((finding, position) => {
      if (!isRecord(finding) || !KNOWLEDGE_LINT_KINDS.includes(finding.kind) || typeof finding.note !== 'string' || !oneLine(finding.note) || oneLine(finding.note).length > KNOWLEDGE_PAGE_LIMITS.noteChars
        || (finding.slugs != null && (!Array.isArray(finding.slugs) || finding.slugs.some((slug) => !isKnowledgePageSlug(slug))))) {
        issues.push(advice(`lint[${position}] needs a kind (${KNOWLEDGE_LINT_KINDS.join(', ')}), a note of up to ${KNOWLEDGE_PAGE_LIMITS.noteChars} characters and, optionally, page slugs.`))
      }
    })
  }
  if (!pages.length && !(Array.isArray(patch.lint) && patch.lint.length)) issues.push(advice('The patch changes no page and states no finding.'))
  return issues
}

/**
 * @param {unknown} claim @param {string} at @param {Map<string, string>} texts
 * @returns {KnowledgePatchIssue[]}
 */
function claimIssues(claim, at, texts) {
  /** @type {KnowledgePatchIssue[]} */
  const issues = []
  if (!isRecord(claim)) return [schema(`${at} must be an object.`)]
  const text = oneLine(claim.text)
  if (typeof claim.text !== 'string' || !text || text.length > KNOWLEDGE_PAGE_LIMITS.claimChars) issues.push(schema(`${at}.text must be one sentence of 1-${KNOWLEDGE_PAGE_LIMITS.claimChars} characters.`))
  else if (text.includes('<!--') || text.includes('-->')) issues.push(schema(`${at}.text must not hold a comment marker.`))
  else if (!HAS_WORD.test(text)) issues.push(schema(`${at}.text holds no words.`))
  if (!KNOWLEDGE_CLAIM_KINDS.includes(claim.kind)) issues.push(schema(`${at}.kind must be "direct" or "synthesized".`))
  const evidence = claim.evidence
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > KNOWLEDGE_PAGE_LIMITS.evidencePerClaim) {
    issues.push(schema(`${at}.evidence must list 1-${KNOWLEDGE_PAGE_LIMITS.evidencePerClaim} quotations: every statement of a page quotes its documents.`))
    return issues
  }
  const documents = new Set()
  evidence.forEach((entry, position) => {
    const where = `${at}.evidence[${position}]`
    if (!isRecord(entry) || typeof entry.sourceId !== 'string' || typeof entry.quote !== 'string') { issues.push(schema(`${where} needs a sourceId and a quote.`)); return }
    if (!SOURCE_ID.test(entry.sourceId) || (texts.size && !texts.has(entry.sourceId))) { issues.push(schema(`${where}.sourceId "${entry.sourceId}" is not one of the documents given in the input.`)); return }
    documents.add(entry.sourceId)
    const checked = checkKnowledgeEvidence({ sourceId: entry.sourceId, quote: entry.quote }, (id) => texts.has(id) ? { text: /** @type {string} */ (texts.get(id)) } : null)
    if (checked.status === 'quote_invalid') issues.push(schema(`${where}.quote must be ${KNOWLEDGE_PAGE_LIMITS.quoteMinChars}-${KNOWLEDGE_PAGE_LIMITS.quoteMaxChars} characters copied from the document.`))
    else if (checked.status === 'quote_not_found') issues.push(quoteAdvice(`${where}.quote is not in document ${entry.sourceId} word for word: "${String(entry.quote).slice(0, 80)}". Copy the passage again from the document, or leave this statement out.`))
  })
  if (claim.kind === 'synthesized') {
    if (documents.size < 2) issues.push(schema(`${at}: a synthesized claim quotes at least two different documents.`))
    if (!KNOWLEDGE_CONFIDENCE.includes(claim.confidence)) issues.push(schema(`${at}.confidence must be one of ${KNOWLEDGE_CONFIDENCE.join(', ')}.`))
  } else if (claim.kind === 'direct' && documents.size > 1) {
    issues.push(schema(`${at}: a direct claim quotes one document; a statement across documents is "synthesized".`))
  }
  return issues
}

/**
 * What a claim becomes once its quotations are checked against the whole documents.
 * @typedef {object} HeldClaim
 * @property {string} page   the page's slug
 * @property {string} heading
 * @property {string} text
 * @property {CheckedEvidence[]} evidence
 * @property {string[]} reasons
 */

/**
 * Settle one patch page against the documents: each claim is kept when every quotation stands (and a statement across
 * documents has two documents), else it is held with the reasons. The page that results holds the kept claims, in the
 * order the compiler wrote them; held claims are returned beside it, never written into it.
 * @param {{ slug: string, type: string, title: string, sections: KnowledgeSection[], related?: string[] }} page
 * @param {KnowledgeTextResolver} resolve
 * @returns {{ page: KnowledgePageContent, held: HeldClaim[], counts: { claims: number, kept: number, held: number }, sources: string[] }}
 */
export function settleKnowledgePage(page, resolve) {
  /** @type {HeldClaim[]} */
  const held = []
  let total = 0
  let kept = 0
  /** @type {Set<string>} */
  const sources = new Set()
  /** @type {KnowledgeSection[]} */
  const sections = []
  for (const section of page.sections) {
    /** @type {KnowledgeClaim[]} */
    const stand = []
    for (const claim of section.claims) {
      total += 1
      const checked = claim.evidence.map((entry) => checkKnowledgeEvidence(entry, resolve))
      // The kind the compiler claimed is the one judged: a statement it called across documents that quotes one is held.
      const kind = claim.kind === 'synthesized' || claim.kind === 'direct' ? claim.kind : new Set(checked.map((entry) => entry.sourceId)).size > 1 ? 'synthesized' : 'direct'
      const judged = judgeKnowledgeEvidence(checked, kind, { confidence: claim.confidence, needsConfidence: true })
      if (judged.ok) {
        kept += 1
        for (const entry of checked) sources.add(entry.sourceId)
        stand.push({ ...claim, kind, evidence: claim.evidence.map(({ sourceId, quote }) => ({ sourceId, quote })) })
      } else held.push({ page: page.slug, heading: section.heading, text: oneLine(claim.text), evidence: checked, reasons: judged.reasons })
    }
    sections.push({ heading: section.heading, claims: stand })
  }
  return { page: { type: page.type, title: page.title, sections, related: page.related ?? [] }, held, counts: { claims: total, kept, held: held.length }, sources: [...sources] }
}

/** @param {string} value @returns {string} */
function comparable(value) {
  return oneLine(value).normalize('NFKC').toLowerCase()
}

/**
 * A researcher's page and the compiler's newer version of it. A researcher's wording is the stronger basis and is never
 * rewritten by a compiler: the result is the researcher's page, with the compiler's statements that the page does not
 * already make added under one heading at the end. Nothing is removed, so an edit is never lost to a recompile.
 * @param {string} current the page as the researcher left it @param {string} compiled the compiler's page
 * @returns {{ markdown: string, added: number }}
 */
export function mergeUserEditedKnowledgePage(current, compiled) {
  const theirs = parseKnowledgePage(current)
  const ours = parseKnowledgePage(compiled)
  const have = new Set(theirs.units.filter((unit) => unit.kind === 'claim').map((unit) => comparable(unit.text)))
  const fresh = ours.units.filter((unit) => unit.kind === 'claim' && !have.has(comparable(unit.text)))
  if (!fresh.length) return { markdown: current.endsWith('\n') ? current : `${current}\n`, added: 0 }
  const lines = fresh.map((unit) => {
    const markers = unit.evidence.map((entry) => knowledgeSourceMarker(entry.sourceId, entry.quote))
    const across = new Set(unit.evidence.map((entry) => entry.sourceId)).size > 1
    const kind = across ? [`<!-- evimed-claim:${commentJson({ kind: 'synthesized', ...(unit.claimMeta?.confidence ? { confidence: unit.claimMeta.confidence } : {}) })} -->`] : []
    return `- ${unit.text} ${[...markers, ...kind].join(' ')}`
  })
  return { markdown: `${current.trimEnd()}\n\n## ${KNOWLEDGE_UPDATE_HEADING}\n\n${lines.join('\n')}\n`, added: fresh.length }
}
