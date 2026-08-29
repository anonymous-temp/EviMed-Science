/**
 * Retracted sources a deliverable cites.
 *
 * Plan F1. The Retraction Watch database has been Crossref's since 2023-09:
 * free, updated every working day, reachable through the Crossref REST API and
 * a public CSV — both hosts are already on the gateway allowlist. So the check
 * is a closed-set comparison between the DOIs and PMIDs a package cites and a
 * list of retracted ones, which is exactly the kind of question code should be
 * answering rather than a model.
 *
 * Notice first, per spec §29 and principle #4: the blocking budget is six
 * system-wide and this ships as an observation until a real distribution says
 * what it costs. Citing a retracted paper in a clinical evidence review is an
 * incident-grade defect and the intent is to promote it — after the numbers
 * exist, not before.
 *
 * This module holds only the decidable half: extracting identifiers and
 * comparing them. Fetching the list is the gateway's job, and passing it in
 * keeps this pure — the same reason `sourceArtifacts` is passed to the quote
 * check rather than read there.
 *
 * @module @evimed/domain/retraction-check
 */

/** A DOI as it appears in prose or a bibliography, normalised for comparison. */
const doiPattern = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/g
/** PMIDs are written several ways; the number is the identifier. */
const pmidPattern = /\bPMID:?\s*(\d{6,9})\b/gi
/** PMCIDs resolve to a paper too, and a preserved artifact path carries one. */
const pmcidPattern = /\bPMC(\d{6,9})\b/g

/** @param {unknown} value @returns {string} */
function normalizeDoi(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    // A trailing period is sentence punctuation far more often than part of a
    // DOI suffix, and treating it as part of the id silently misses the match.
    .replace(/[.,;)\]]+$/, '')
}

/**
 * Every source identifier a package cites, from wherever it names them.
 *
 * Reads the bibliography, the citation ledger and the evidence matrix rather
 * than the report prose alone: a claim can carry an identifier the prose never
 * spells out, and the question is what the package rests on, not what it
 * happens to print.
 *
 * @param {{ referencesText?: string, citationLedgerText?: string, matrix?: any }} input
 * @returns {{ dois: string[], pmids: string[], pmcids: string[] }}
 */
export function citedIdentifiers(input) {
  const matrixClaims = Array.isArray(input?.matrix?.claims) ? input.matrix.claims : []
  const fromClaims = matrixClaims.flatMap((/** @type {any} */ claim) => [
    claim?.identifier,
    claim?.sourceUrl,
    claim?.artifactPath,
    ...(Array.isArray(claim?.supportingSources)
      ? claim.supportingSources.flatMap((/** @type {any} */ source) => [source?.identifier, source?.sourceUrl, source?.artifactPath])
      : []),
  ])
  const haystack = [
    String(input?.referencesText ?? ''),
    String(input?.citationLedgerText ?? ''),
    ...fromClaims.filter((/** @type {unknown} */ value) => typeof value === 'string'),
  ].join('\n')

  const dois = new Set()
  for (const match of haystack.matchAll(doiPattern)) dois.add(normalizeDoi(match[0]))
  const pmids = new Set()
  for (const match of haystack.matchAll(pmidPattern)) pmids.add(String(match[1]))
  const pmcids = new Set()
  for (const match of haystack.matchAll(pmcidPattern)) pmcids.add(String(match[1]))
  return { dois: [...dois], pmids: [...pmids], pmcids: [...pmcids] }
}

/**
 * The notices a package earns for citing retracted work.
 *
 * `retracted` is the list the gateway fetched: one entry per retracted record,
 * carrying whichever identifiers Crossref holds for it. An empty list is not
 * "nothing is retracted" — it is "we did not look" — and the two must not read
 * alike, so an absent list produces the notice that says so rather than
 * silence.
 *
 * @param {{ referencesText?: string, citationLedgerText?: string, matrix?: any }} input
 * @param {readonly { doi?: string, pmid?: string, pmcid?: string, title?: string, retractionDate?: string }[] | null | undefined} retracted
 * @returns {string[]}
 */
export function retractionNotices(input, retracted) {
  if (!Array.isArray(retracted)) {
    return ['撤稿核查未执行：本次运行没有拿到撤稿名单，因此「未发现引用已撤稿文献」这句话现在不能说。']
  }
  const cited = citedIdentifiers(input)
  if (!cited.dois.length && !cited.pmids.length && !cited.pmcids.length) return []

  const byDoi = new Map()
  const byPmid = new Map()
  const byPmcid = new Map()
  for (const record of retracted) {
    if (record?.doi) byDoi.set(normalizeDoi(record.doi), record)
    if (record?.pmid) byPmid.set(String(record.pmid).replace(/\D/g, ''), record)
    if (record?.pmcid) byPmcid.set(String(record.pmcid).replace(/\D/g, ''), record)
  }

  /** @type {Map<any, string[]>} */
  const hits = new Map()
  const note = (/** @type {any} */ record, /** @type {string} */ how) => hits.set(record, [...(hits.get(record) ?? []), how])
  for (const doi of cited.dois) if (byDoi.has(doi)) note(byDoi.get(doi), `DOI ${doi}`)
  for (const pmid of cited.pmids) if (byPmid.has(pmid)) note(byPmid.get(pmid), `PMID ${pmid}`)
  for (const pmcid of cited.pmcids) if (byPmcid.has(pmcid)) note(byPmcid.get(pmcid), `PMC${pmcid}`)

  return [...hits.entries()].map(([record, how]) => (
    `本交付物引用了一篇已撤稿文献（${how.join('、')}${record?.retractionDate ? `，撤稿日期 ${record.retractionDate}` : ''}）`
    + `${record?.title ? `：《${String(record.title).slice(0, 80)}》` : ''}。`
    + '撤稿文献不能用作证据支持；请改引未撤稿的来源，或在正文中写明该文献已撤稿及其对结论的影响。'
  ))
}
