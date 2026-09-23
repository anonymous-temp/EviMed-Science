/**
 * Whether each reference a report lists is the work its identifiers name.
 *
 * Hidden knowledge: every near-zero citation-error result in the literature
 * is a lookup, not a judgment — a tool-backed loop took unresolvable
 * references from 16.0% to 0.6% (arXiv 2604.03173), and it did it by asking
 * the registries, one reference at a time, all of them. Until 2026-09-23 the
 * check named `citationsResolvable` resolved nothing (URL syntax only), and the
 * in-kernel reviewer sampled forty claims with search tools.
 *
 * This module is the pure half: which identifiers a report's list carries, and
 * what the registries' answers mean for each entry. Fetching them is the
 * control plane's (`referenceResolver.mjs`), because the domain has no network
 * and a run must not be able to shape the lookup.
 *
 * Three verdicts are decidable, and only these are raised:
 * - every identifier an entry carries is unknown to its registry — a DOI the
 *   DOI handle system does not hold, a PMID PubMed does not hold;
 * - an entry's DOI and PMID name two different works;
 * - the title the registry holds is not the work the entry describes (fewer
 *   than half of the registry title's words in the entry).
 * A registry that did not answer decides nothing; an entry without an
 * identifier is counted, not judged (a policy document, a label page).
 *
 * @module @evimed/domain/referenceResolution
 */

import { parseReferenceEntry, referenceIdentifiers, referenceListBounds } from './clinicalEvidence.mjs'

/** Entries one report may send to the registries. A list longer than this is resolved in its first entries and says how many were left. */
export const REFERENCE_RESOLUTION_LIMIT = 300

/** Share of a registry title's words that must appear in the entry. */
const TITLE_COVERAGE_FLOOR = 0.5

/** Words a title shares with every other title. A closed list, not prose. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'versus', 'among', 'after', 'before', 'during', 'between',
  'of', 'in', 'on', 'at', 'to', 'by', 'as', 'an', 'or', 'vs', 'its', 'their', 'this', 'that', 'than', 'via',
])

/**
 * @typedef {object} ReferenceEntry
 * @property {number} number
 * @property {string} text
 * @property {string[]} dois   lower-case, as `referenceIdentifiers` spells them
 * @property {string[]} pmids
 */

/**
 * The numbered entries of a report's reference list, continuation lines
 * joined to their entry. `bounds` is where the list is, when the caller reads
 * a text that is not held to the report's `## 参考文献` heading (a chat reply).
 * @param {unknown} reportText @param {{ headingEnd: number, end: number } | null} [bounds]
 * @returns {ReferenceEntry[]}
 */
export function referenceEntries(reportText, bounds = referenceListBounds(String(reportText ?? ''))) {
  const text = String(reportText ?? '')
  if (!bounds) return []
  /** @type {{ number: number, lines: string[] }[]} */
  const entries = []
  const seen = new Set()
  for (const line of text.slice(bounds.headingEnd, bounds.end).split('\n')) {
    if (!line.trim()) continue
    const entry = parseReferenceEntry(line)
    if (entry && !seen.has(entry.number)) {
      seen.add(entry.number)
      entries.push({ number: entry.number, lines: [entry.text] })
    } else if (entries.length) {
      entries.at(-1)?.lines.push(line.trim())
    }
  }
  return entries.map(({ number, lines }) => {
    const body = lines.join(' ')
    const identifiers = [...referenceIdentifiers(body)]
    return {
      number,
      text: body,
      dois: identifiers.filter((id) => id.startsWith('doi:')).map((id) => id.slice(4)),
      pmids: identifiers.filter((id) => id.startsWith('pmid:')).map((id) => id.slice(5)),
    }
  })
}

/**
 * What to ask the registries for, deduplicated, in list order, bounded.
 * @param {readonly ReferenceEntry[]} entries
 * @returns {{ dois: string[], pmids: string[], truncated: number }}
 */
export function referenceLookups(entries) {
  const dois = new Set()
  const pmids = new Set()
  let kept = 0
  let truncated = 0
  for (const entry of entries) {
    if (!entry.dois.length && !entry.pmids.length) continue
    if (kept >= REFERENCE_RESOLUTION_LIMIT) {
      truncated += 1
      continue
    }
    kept += 1
    for (const doi of entry.dois) dois.add(doi)
    for (const pmid of entry.pmids) pmids.add(pmid)
  }
  return { dois: [...dois], pmids: [...pmids], truncated }
}

/**
 * One registry's answer about one identifier.
 * @typedef {{ status: 'found', title?: string, doi?: string, pmid?: string } | { status: 'not_found' } | { status: 'unknown', reason?: string }} RegistryRecord
 */

/**
 * @typedef {object} ReferenceFinding
 * @property {'reference-resolution'} check
 * @property {'reference_unresolvable'|'reference_mismatch'} kind
 * @property {number} number     the entry's number in the list
 * @property {string} location   `[n]`
 * @property {string} evidence   the entry as listed (bounded), which is in the report verbatim
 * @property {string} message
 */

/**
 * Title words, lower-case: Latin words of three letters or more that are not
 * stopwords, and CJK character pairs.
 * @param {string} value @returns {Set<string>}
 */
export function titleTokens(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b10\.\d{4,9}\/\S+/g, ' ')
  /** @type {Set<string>} */
  const tokens = new Set()
  for (const word of normalized.match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (!TITLE_STOPWORDS.has(word)) tokens.add(word.replace(/-+$/, ''))
  }
  for (const run of normalized.match(/[㐀-鿿]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * How much of a registry title the entry carries, or null when the two are in
 * different scripts (a Chinese entry for an English article says nothing
 * about which article it is, word for word).
 * @param {string} registryTitle @param {string} entryText @returns {number | null}
 */
export function titleCoverage(registryTitle, entryText) {
  const title = titleTokens(registryTitle)
  if (title.size < 3) return null
  const entry = titleTokens(entryText)
  const latinTitle = [...title].some((token) => /^[a-z]/.test(token))
  const latinEntry = [...entry].some((token) => /^[a-z]/.test(token))
  if (latinTitle !== latinEntry) return null
  let shared = 0
  for (const token of title) if (entry.has(token)) shared += 1
  return shared / title.size
}

/** @param {string} value */
function bounded(value) {
  return value.length > 240 ? `${value.slice(0, 237)}…` : value
}

/**
 * What the registries' answers mean for each entry.
 *
 * @param {readonly ReferenceEntry[]} entries
 * @param {{ doi: ReadonlyMap<string, RegistryRecord>, pmid: ReadonlyMap<string, RegistryRecord> }} resolved
 * @returns {{ findings: ReferenceFinding[], metrics: { references: number, withIdentifier: number, resolved: number, unresolvable: number, mismatched: number, undecided: number, truncated: number } }}
 */
export function referenceResolutionFindings(entries, resolved) {
  /** @type {ReferenceFinding[]} */
  const findings = []
  const metrics = { references: entries.length, withIdentifier: 0, resolved: 0, unresolvable: 0, mismatched: 0, undecided: 0, truncated: 0 }
  let considered = 0
  for (const entry of entries) {
    if (!entry.dois.length && !entry.pmids.length) continue
    metrics.withIdentifier += 1
    if (considered >= REFERENCE_RESOLUTION_LIMIT) {
      metrics.truncated += 1
      continue
    }
    considered += 1
    /** @type {{ scheme: 'DOI'|'PMID', id: string, record: RegistryRecord }[]} */
    const answers = [
      ...entry.dois.map((id) => ({ scheme: /** @type {const} */ ('DOI'), id, record: resolved.doi.get(id) ?? { status: /** @type {const} */ ('unknown') } })),
      ...entry.pmids.map((id) => ({ scheme: /** @type {const} */ ('PMID'), id, record: resolved.pmid.get(id) ?? { status: /** @type {const} */ ('unknown') } })),
    ]
    const found = answers.filter((answer) => answer.record.status === 'found')
    const missing = answers.filter((answer) => answer.record.status === 'not_found')
    const location = `[${entry.number}]`
    const evidence = bounded(entry.text)
    if (!found.length) {
      if (missing.length === answers.length) {
        metrics.unresolvable += 1
        findings.push({
          check: 'reference-resolution',
          kind: 'reference_unresolvable',
          number: entry.number,
          location,
          evidence,
          message: `参考文献 ${location} 的 ${missing.map((answer) => `${answer.scheme} ${answer.id}`).join('、')} 在登记处查无此条（${missing.some((answer) => answer.scheme === 'DOI') ? 'DOI 解析系统' : ''}${missing.some((answer) => answer.scheme === 'DOI') && missing.some((answer) => answer.scheme === 'PMID') ? '与' : ''}${missing.some((answer) => answer.scheme === 'PMID') ? 'PubMed' : ''}）。核对标识符是否抄错；找不到出处的文献不能留在参考文献表里。`,
        })
      } else {
        metrics.undecided += 1
      }
      continue
    }
    metrics.resolved += 1
    // Two identifiers, two works: the PMID's own DOI is not the entry's DOI.
    const pubmed = found.find((answer) => answer.scheme === 'PMID')
    const pubmedDoi = pubmed && pubmed.record.status === 'found' ? String(pubmed.record.doi ?? '').toLowerCase() : ''
    if (pubmedDoi && entry.dois.length && !entry.dois.includes(pubmedDoi)) {
      metrics.mismatched += 1
      findings.push({
        check: 'reference-resolution',
        kind: 'reference_mismatch',
        number: entry.number,
        location,
        evidence,
        message: `参考文献 ${location} 的 PMID ${pubmed?.id} 在 PubMed 登记的 DOI 是 ${pubmedDoi}，与条目写的 ${entry.dois.join('、')} 不是同一篇。两个标识符至少有一个抄错了。`,
      })
      continue
    }
    // The registry's title, against the words the entry actually lists.
    const titled = found.find((answer) => answer.record.status === 'found' && String(answer.record.title ?? '').trim())
    if (titled && titled.record.status === 'found') {
      const coverage = titleCoverage(String(titled.record.title), entry.text)
      if (coverage !== null && coverage < TITLE_COVERAGE_FLOOR) {
        metrics.mismatched += 1
        findings.push({
          check: 'reference-resolution',
          kind: 'reference_mismatch',
          number: entry.number,
          location,
          evidence,
          message: `参考文献 ${location} 的 ${titled.scheme} ${titled.id} 指向《${bounded(String(titled.record.title))}》，与条目所列的题名不是同一篇（题名词重合 ${Math.round(coverage * 100)}%）。按标识符改题名，或换成条目真正要引的那篇。`,
        })
      }
    }
  }
  return { findings, metrics }
}
