// Arm B's first step: compile a topic's documents into knowledge pages exactly as the platform's `knowledge-compile` job would
// ask for them — the method file as the system prompt, `knowledge-compile-input.json` as the input, a `wiki-patch.json` back,
// at most two in-place repair rounds against `knowledgePatchIssues`, then `settleKnowledgePage` against the whole documents.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KNOWLEDGE_PAGE_LIMITS, isKnowledgePageSlug, isKnowledgePageType, knowledgePatchIssues, parseKnowledgePage,
  renderKnowledgeIndex, renderKnowledgePage, settleKnowledgePage, verifyKnowledgePage,
} from '@evimed/domain'
import { compileUserMessage, repairUserMessage, sha256 } from './prompts.mjs'

export const MAX_REPAIR_ROUNDS = 2

/** The frozen input the platform job hands the compiler, for a topic with no pages yet. */
export function buildCompileInput(topic) {
  return {
    schemaVersion: 1,
    sources: topic.documents.map((document) => ({ sourceId: document.sourceId, title: document.title, generation: 1, textSha256: sha256(document.text), text: document.text })),
    pages: [],
    changed: [],
    held: [],
    limits: KNOWLEDGE_PAGE_LIMITS,
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * The pure step after the model: settle every page of a patch against the whole documents. A claim that does not stand is held
 * with its reasons, a page nothing stands on is not written, and a page that cannot be read at all is skipped with the reason.
 * @param {any} patch @param {Array<{ sourceId: string, text: string }>} documents
 */
export function settlePatch(patch, documents) {
  const texts = new Map(documents.map((document) => [document.sourceId, document.text]))
  const resolve = (id) => (texts.has(id) ? { text: texts.get(id) } : null)
  const pages = []
  const held = []
  const skipped = []
  const entries = Array.isArray(patch?.pages) ? patch.pages : []
  for (const entry of entries) {
    if (!isRecord(entry)) { skipped.push({ slug: null, reason: 'not_an_object' }); continue }
    if (entry.op === 'retire') { skipped.push({ slug: entry.slug ?? null, reason: 'retire_has_nothing_to_retire' }); continue }
    if (!isKnowledgePageSlug(entry.slug)) { skipped.push({ slug: String(entry.slug ?? ''), reason: 'invalid_slug' }); continue }
    if (!isKnowledgePageType(entry.type) || !oneLine(entry.title) || !Array.isArray(entry.sections)) { skipped.push({ slug: entry.slug, reason: 'invalid_page' }); continue }
    if (pages.some((page) => page.slug === entry.slug)) { skipped.push({ slug: entry.slug, reason: 'duplicate_slug' }); continue }
    const sections = []
    for (const section of entry.sections) {
      if (!isRecord(section) || !oneLine(section.heading) || !Array.isArray(section.claims)) { skipped.push({ slug: entry.slug, reason: 'invalid_section' }); continue }
      // The claims go to the domain as the model wrote them: what is malformed or unconfirmed it holds, with the reason.
      sections.push({ heading: oneLine(section.heading), claims: section.claims })
    }
    const settled = settleKnowledgePage({ slug: entry.slug, type: entry.type, title: oneLine(entry.title), sections, related: Array.isArray(entry.related) ? entry.related.filter(isKnowledgePageSlug) : [] }, resolve)
    held.push(...settled.held.map((claim) => ({ ...claim, evidence: claim.evidence.map(({ sourceId, quote, status }) => ({ sourceId, quote, status })) })))
    if (!settled.counts.kept) { skipped.push({ slug: entry.slug, reason: 'no_claim_stands' }); continue }
    pages.push({ slug: entry.slug, content: settled.page, counts: settled.counts, sources: settled.sources })
  }
  // A link to a page that was not written leads nowhere.
  const written = new Set(pages.map((page) => page.slug))
  for (const page of pages) {
    page.content.related = page.content.related.filter((slug) => written.has(slug) && slug !== page.slug)
    page.markdown = renderKnowledgePage(page.content)
    const parsed = parseKnowledgePage(page.markdown)
    const verification = verifyKnowledgePage(parsed, resolve, { pages: written })
    page.verification = { ...verification.counts, dangling: verification.dangling }
  }
  const indexMarkdown = renderKnowledgeIndex(pages.map((page) => ({ slug: page.slug, type: page.content.type, title: page.content.title, claims: page.counts.kept, sources: page.sources.length })))
  const heldByReason = {}
  for (const claim of held) for (const reason of claim.reasons) heldByReason[reason] = (heldByReason[reason] ?? 0) + 1
  const total = pages.reduce((sum, page) => sum + page.counts.kept, 0) + held.length
  return {
    pages, indexMarkdown, held, skipped,
    counts: { pages: pages.length, claims: total, kept: total - held.length, held: held.length, heldByReason, documentsCited: new Set(pages.flatMap((page) => page.sources)).size },
  }
}

/** @param {string | null | undefined} content @returns {{ patch: any, error: string | null }} */
function parsePatch(content, finishReason) {
  if (finishReason === 'length') return { patch: null, error: 'The reply was cut off before the JSON ended. Return a complete patch with fewer or shorter claims.' }
  try {
    const patch = JSON.parse(String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return { patch, error: null }
  } catch {
    return { patch: null, error: 'The reply was not a single valid JSON object. Return only the JSON object of wiki-patch.json.' }
  }
}

/**
 * Compile a topic and settle it. Pure with respect to disk: `writeCompiled` stores the result.
 * @param {{ llm: { chat: Function }, model: string, topic: any, skillText: string, label: string, temperature?: number, thinking?: 'enabled' | 'disabled', meta?: Record<string, unknown> }} options
 */
export async function compileTopic({ llm, model, topic, skillText, label, temperature = 0.3, thinking = 'disabled', meta = {} }) {
  const input = buildCompileInput(topic)
  const messages = [{ role: 'system', content: skillText }, { role: 'user', content: compileUserMessage(JSON.stringify(input)) }]
  const rounds = []
  let patch = null
  let rawLast = ''
  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const result = await llm.chat({ label: `${round ? 'repair' : 'compile'}:${label}`, model, messages, temperature, thinking, json: true, maxTokens: 32000, timeoutMs: 600_000, meta: { ...meta, round } })
    rawLast = String(result.message.content ?? '')
    messages.push({ role: 'assistant', content: rawLast })
    const parsed = parsePatch(rawLast, result.finishReason)
    const issues = parsed.error ? [{ severity: 'required', message: parsed.error, check: 'knowledge-wiki-schema' }] : knowledgePatchIssues(parsed.patch, input)
    if (!parsed.error) patch = parsed.patch
    rounds.push({
      round, finish: result.finishReason, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, cost: result.cost,
      required: issues.filter((issue) => issue.severity === 'required').length, advisory: issues.filter((issue) => issue.severity !== 'required').length,
      issueMessages: issues.slice(0, 60).map((issue) => `${issue.severity}: ${issue.message}`),
    })
    if (!issues.length || round === MAX_REPAIR_ROUNDS) break
    messages.push({ role: 'user', content: repairUserMessage(issues) })
  }
  const settled = settlePatch(patch ?? { pages: [] }, topic.documents)
  const finalIssues = patch ? knowledgePatchIssues(patch, input) : []
  const stats = {
    rounds: rounds.length,
    promptTokens: rounds.reduce((sum, round) => sum + round.promptTokens, 0),
    completionTokens: rounds.reduce((sum, round) => sum + round.completionTokens, 0),
    cost: rounds.reduce((sum, round) => sum + round.cost, 0),
    patchPages: Array.isArray(patch?.pages) ? patch.pages.length : 0,
    unreadablePatch: patch === null,
    finalRequired: finalIssues.filter((issue) => issue.severity === 'required').length,
    finalAdvisory: finalIssues.filter((issue) => issue.severity !== 'required').length,
    documents: topic.documents.length,
    ...settled.counts,
    skipped: settled.skipped,
    verifyMismatch: settled.pages.filter((page) => page.verification.verified !== page.counts.kept || page.verification.unverified || page.verification.unsupported).length,
    roundDetails: rounds,
  }
  return { patch, rawLast, input, settled, stats }
}

/** Write a compile result under `dir`. @param {string} dir @param {Awaited<ReturnType<typeof compileTopic>>} result */
export async function writeCompiled(dir, result) {
  await mkdir(join(dir, 'pages'), { recursive: true })
  if (result.patch) await writeFile(join(dir, 'wiki-patch.json'), `${JSON.stringify(result.patch, null, 2)}\n`, 'utf8')
  else await writeFile(join(dir, 'wiki-patch.raw.txt'), result.rawLast, 'utf8')
  for (const page of result.settled.pages) await writeFile(join(dir, 'pages', `${page.slug}.md`), page.markdown, 'utf8')
  await writeFile(join(dir, 'index.md'), result.settled.indexMarkdown, 'utf8')
  await writeFile(join(dir, 'held.json'), `${JSON.stringify(result.settled.held, null, 2)}\n`, 'utf8')
  // compile.json is written last: its presence marks a compile as complete.
  await writeFile(join(dir, 'compile.json'), `${JSON.stringify({ stats: result.stats, inputSha256: sha256(JSON.stringify(result.input)) }, null, 2)}\n`, 'utf8')
}

/** A finished compile read back from disk, or null. @param {string} dir */
export async function readCompiled(dir) {
  let compile
  try { compile = JSON.parse(await readFile(join(dir, 'compile.json'), 'utf8')) } catch { return null }
  const pages = []
  let names = []
  try { names = (await readdir(join(dir, 'pages'))).filter((name) => name.endsWith('.md')).sort() } catch { /* a compile with no page */ }
  for (const name of names) {
    const markdown = await readFile(join(dir, 'pages', name), 'utf8')
    const parsed = parseKnowledgePage(markdown)
    pages.push({ slug: name.slice(0, -3), title: parsed.title ?? name.slice(0, -3), markdown })
  }
  let indexMarkdown = ''
  try { indexMarkdown = await readFile(join(dir, 'index.md'), 'utf8') } catch { /* none */ }
  return { stats: compile.stats, pages, indexMarkdown }
}
