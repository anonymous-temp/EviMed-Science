/**
 * Whether every source a report links to is a source the run recorded.
 *
 * Hidden knowledge: two things, each learned from a delivery.
 *
 * First, where this check lives. It used to be written once, inside the
 * control plane's completion verdict (`agentRuns.mjs`), and nowhere the run
 * could reach: `evimed_submit_deliverable` grades a package with `runGate`,
 * and `runGate` never ran it. The 2026-09-27 dapagliflozin evaluation
 * (evals/comprehensive-drug-evaluation/results/2026-09-27-cde-001-…) passed
 * every submission it made and was then delivered `unverified` with two
 * must-fix findings it had never been shown. A rule the run is held to and
 * cannot see is the failure `clinicalEvidenceQuality.mjs` was written to make
 * impossible; this module is the one implementation both sides call.
 *
 * Second, what "recorded" means. The snapshot was a file the model typed —
 * that run wrote a 113-line Python script to build it — so "cited but not
 * recorded" compared the model's report with the model's own list. The
 * platform keeps its own record of what the run's retrieval tools returned
 * (the socket's evidence table), and submission now writes that record into
 * the snapshot under `retrieved`, a key the run does not author. A source a
 * tool returned is therefore always recorded, whatever the model's list says,
 * and a link nothing returned is named with the line it is on.
 *
 * Only links are read from the report, as before; what a link may match is
 * wider: a `doi.org` link matches the DOI however the record writes it, a
 * PubMed link matches the PMID, and scheme, case and a trailing slash do not
 * make two addresses different. Those are identifier formats, not prose
 * (principle 5).
 *
 * @module @evimed/domain/citedSources
 */

/** The file this check reads. */
export const EVIDENCE_SNAPSHOT_FILE = 'evidence-snapshot.json'

/** The snapshot key the platform writes and the run does not: what the run's tools returned. */
export const SNAPSHOT_RETRIEVED_KEY = 'retrieved'

/** Unrecorded links named in one verdict; past it the rest are counted. */
export const UNRECORDED_LIMIT = 12

/**
 * @typedef {object} RetrievedSource
 * @property {string} sourceId
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [doi]
 * @property {string} [pmid]
 * @property {string} tool
 * @property {string} [query]
 * @property {string} [recordedAt]
 * @property {string} [status]
 * @property {string} [artifactPath]
 * @property {string} [sourceType]
 */

/**
 * Every http(s) address in a text. Trailing ASCII and CJK/full-width
 * punctuation is excluded, so a URL written in Chinese prose (…example-a。)
 * matches the same URL recorded inside JSON quotes.
 * @param {unknown} text @returns {string[]}
 */
export function citedHttpUrls(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s)\]}>"'，。；、）】》「」『』！？…]+/g)]
    .map((match) => match[0].replace(/[.,;，。；、）】》「」『』！？…]+$/, ''))
}

/** @param {string} value @returns {URL | null} */
function parsed(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * One address in the form two spellings of it share: https, a lower-case host
 * without `www.`, no fragment, no trailing slash.
 * @param {string} value @returns {string}
 */
export function normalizedUrl(value) {
  const url = parsed(value)
  if (!url) return String(value).trim()
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.replace(/\/+$/, '')
  return `https://${host}${url.port ? `:${url.port}` : ''}${path}${url.search}`
}

/** A DOI, lower-cased, without a trailing full stop. @param {string} value @returns {string} */
function normalizedDoi(value) {
  return String(value).trim().toLowerCase().replace(/[.,;]+$/, '')
}

/** The DOI a link resolves, when it is a doi.org link. @param {string} value @returns {string} */
function doiOfUrl(value) {
  const url = parsed(value)
  if (!url || !/^(?:dx\.)?doi\.org$/i.test(url.hostname.replace(/^www\./i, ''))) return ''
  let path = url.pathname.replace(/^\/+/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // A malformed escape is left as written.
  }
  return /^10\.\d{4,9}\//.test(path) ? normalizedDoi(path) : ''
}

/** The PMID a link names, when it is a PubMed link. @param {string} value @returns {string} */
export function pmidOfUrl(value) {
  const url = parsed(value)
  if (!url) return ''
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const match = host === 'pubmed.ncbi.nlm.nih.gov'
    ? /^\/(\d{1,9})\/?$/.exec(url.pathname)
    : host === 'ncbi.nlm.nih.gov' ? /^\/pubmed\/(\d{1,9})\/?$/.exec(url.pathname) : null
  return match ? match[1] : ''
}

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>，。；、）)\]}]+/g
const PMID_IN_TEXT = /(?:\bPMID\b\s*[:：]?\s*|"pmid"\s*:\s*"?)(\d{1,9})/gi

/**
 * Every identifier a record set holds: addresses, DOIs and PMIDs, from the
 * snapshot's text wherever it writes them and from the platform's rows.
 * @param {string} snapshotText @param {readonly Record<string, any>[]} retrieved
 */
function recordedIdentifiers(snapshotText, retrieved) {
  /** @type {Set<string>} */
  const urls = new Set()
  /** @type {Set<string>} */
  const dois = new Set()
  /** @type {Set<string>} */
  const pmids = new Set()
  const addUrl = (/** @type {string} */ value) => {
    urls.add(normalizedUrl(value))
    const doi = doiOfUrl(value)
    if (doi) dois.add(doi)
    const pmid = pmidOfUrl(value)
    if (pmid) pmids.add(pmid)
  }
  for (const url of citedHttpUrls(snapshotText)) addUrl(url)
  for (const match of String(snapshotText ?? '').matchAll(DOI_IN_TEXT)) dois.add(normalizedDoi(match[0]))
  for (const match of String(snapshotText ?? '').matchAll(PMID_IN_TEXT)) pmids.add(match[1])
  for (const row of retrieved ?? []) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.url === 'string' && /^https?:\/\//i.test(row.url)) addUrl(row.url)
    if (typeof row.doi === 'string' && row.doi.trim()) dois.add(normalizedDoi(row.doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')))
    if (row.pmid != null && /^\d{1,9}$/.test(String(row.pmid).trim())) pmids.add(String(row.pmid).trim())
    const id = String(row.sourceId ?? '').trim()
    if (/^https?:\/\//i.test(id)) addUrl(id)
    const idDoi = /^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i.exec(id)
    if (idDoi) dois.add(normalizedDoi(idDoi[1]))
    const idPmid = /^pmid:?\s*(\d{1,9})$/i.exec(id)
    if (idPmid) pmids.add(idPmid[1])
  }
  return { urls, dois, pmids }
}

/**
 * @typedef {object} CitedSourceAudit
 * @property {'ok'|'missing'|'invalid'|'not-object'|'empty'|'unrecorded'} status
 * @property {{ path: string, line: number, url: string }[]} unrecorded  in neither the snapshot nor the platform's record
 * @property {{ path: string, line: number, url: string }[]} unretrieved in the run's own list only: no retrieval tool of this run returned it
 */

/**
 * The audit: every link the report files carry, against the snapshot and the
 * platform's record of what the run retrieved.
 *
 * The platform's record is the rows handed in (the run side reads them from
 * its evidence table) together with whatever the snapshot already carries
 * under `retrieved` (what submission wrote there, which is all the control
 * plane can read afterwards). A link in neither the snapshot nor that record
 * is `unrecorded` — the check this module moved here, must-fix as it always
 * was. A link only the run's own list carries is `unretrieved`: a notice, not
 * a verdict, until its distribution has been observed (principle 4); a run
 * may cite what an earlier run or the user supplied.
 *
 * @param {{ reports: readonly { path: string, text: string }[], snapshotText: string | null | undefined, retrieved?: readonly Record<string, any>[] }} input
 * @returns {CitedSourceAudit}
 */
export function auditCitedSources({ reports, snapshotText, retrieved = [] }) {
  if (snapshotText == null) return { status: 'missing', unrecorded: [], unretrieved: [] }
  let snapshot
  try {
    snapshot = JSON.parse(snapshotText)
  } catch {
    return { status: 'invalid', unrecorded: [], unretrieved: [] }
  }
  if (!snapshot || typeof snapshot !== 'object') return { status: 'not-object', unrecorded: [], unretrieved: [] }
  const platformRows = [
    ...(retrieved ?? []),
    ...(!Array.isArray(snapshot) && Array.isArray(snapshot[SNAPSHOT_RETRIEVED_KEY]) ? snapshot[SNAPSHOT_RETRIEVED_KEY] : []),
  ]
  const ownText = Array.isArray(snapshot) ? snapshotText : JSON.stringify({ ...snapshot, [SNAPSHOT_RETRIEVED_KEY]: undefined })
  const platform = recordedIdentifiers('', platformRows)
  const own = recordedIdentifiers(ownText, [])
  const size = (/** @type {ReturnType<typeof recordedIdentifiers>} */ set) => set.urls.size + set.dois.size + set.pmids.size
  if (!size(platform) && !size(own)) return { status: 'empty', unrecorded: [], unretrieved: [] }
  /** @param {ReturnType<typeof recordedIdentifiers>} set @param {string} url */
  const holds = (set, url) => {
    const doi = doiOfUrl(url)
    const pmid = pmidOfUrl(url)
    return set.urls.has(normalizedUrl(url)) || Boolean(doi && set.dois.has(doi)) || Boolean(pmid && set.pmids.has(pmid))
  }
  /** @type {{ path: string, line: number, url: string }[]} */
  const unrecorded = []
  /** @type {{ path: string, line: number, url: string }[]} */
  const unretrieved = []
  const seen = new Set()
  for (const report of reports) {
    const lines = String(report.text ?? '').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const url of citedHttpUrls(lines[index])) {
        if (seen.has(url)) continue
        seen.add(url)
        if (holds(platform, url)) continue
        if (holds(own, url)) unretrieved.push({ path: report.path, line: index + 1, url })
        else unrecorded.push({ path: report.path, line: index + 1, url })
      }
    }
  }
  return { status: unrecorded.length ? 'unrecorded' : 'ok', unrecorded, unretrieved }
}

/**
 * What the run is told about one link nothing recorded: where it is, why it
 * counts, and the three ways out.
 * @param {{ path: string, line: number, url: string }} entry @returns {string}
 */
export function unrecordedCitationMessage({ path, line, url }) {
  return `${path} line ${line} links ${url}, which no retrieval tool of this run returned and ${EVIDENCE_SNAPSHOT_FILE} does not record. `
    + 'If you read that page, read it with web_read (or fetch the record with the search tool that finds it) so the platform records it. '
    + 'A portal, home or search page is not a source: cite the record you read by its identifier (a drug label by its approval number and label id) and drop the link. '
    + 'If nothing you read supports the sentence, drop the sentence.'
}

/**
 * The notice for a link only the run's own list records.
 * @param {{ path: string, line: number, url: string }} entry @returns {string}
 */
export function unretrievedCitationMessage({ path, line, url }) {
  return `${path} line ${line} links ${url}; ${EVIDENCE_SNAPSHOT_FILE} lists it, but no retrieval tool of this run returned it. `
    + 'If this run read it, read it through a tool so the platform records it; if it came from the user or an earlier run, say so in its snapshot entry.'
}

/** What the run is told when neither the snapshot nor the platform recorded any source. */
export const EMPTY_SNAPSHOT_MESSAGE = `${EVIDENCE_SNAPSHOT_FILE} records no source address, DOI or PMID, and no retrieval tool of this run returned one. Every source the report cites must be one a tool of this run retrieved.`

/** What the run is told when the snapshot does not parse. */
export const INVALID_SNAPSHOT_MESSAGE = `${EVIDENCE_SNAPSHOT_FILE} must contain strict valid JSON; escape quotation marks correctly inside string values.`

/** What the run is told when the snapshot parses to something that is not a record. */
export const NOT_OBJECT_SNAPSHOT_MESSAGE = `${EVIDENCE_SNAPSHOT_FILE} must be a JSON object or array of source records, not a bare string or number.`

/**
 * The snapshot with the platform's record written into it, under the one key
 * the run does not author. Everything else the run wrote is kept as it was; a
 * snapshot that is an array of records becomes `{ sources: [...] }` so the key
 * has somewhere to live. A file that does not parse is returned unchanged —
 * the check says so, and overwriting it would lose what the run wrote.
 *
 * @param {string | null | undefined} snapshotText @param {readonly Record<string, any>[]} retrieved
 * @returns {{ text: string, changed: boolean, written: boolean }}
 */
export function withRetrievedSources(snapshotText, retrieved) {
  const rows = [...(retrieved ?? [])]
  /** @type {any} */
  let snapshot = {}
  if (snapshotText != null && String(snapshotText).trim()) {
    try {
      snapshot = JSON.parse(String(snapshotText))
    } catch {
      return { text: String(snapshotText), changed: false, written: false }
    }
  }
  if (Array.isArray(snapshot)) snapshot = { sources: snapshot }
  if (!snapshot || typeof snapshot !== 'object') return { text: String(snapshotText ?? ''), changed: false, written: false }
  const text = `${JSON.stringify({ ...snapshot, [SNAPSHOT_RETRIEVED_KEY]: rows }, null, 2)}\n`
  return { text, changed: text !== String(snapshotText ?? ''), written: true }
}

// ---- the manifest's `citationsResolvable` -----------------------------------
//
// Moved here from the control plane (agentRuns.mjs) on 2026-09-28 with the
// check above, for the same reason: seventeen capabilities declare it, its
// blocking half is a must-fix on the delivered package, and the run's own gate
// never applied it. The words are unchanged.

// An address nobody outside this deployment can resolve. The named internal
// route was the instance that got written down; loopback and private addresses
// are the same defect, and a citation reaches a reader who is not on this
// network. Generalized rather than listed so a second internal hostname cannot
// arrive as a second bug.
/** @param {URL} url @returns {boolean} */
export function unresolvableCitationHost(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true
  }
  if (host === "::1" || host === "0.0.0.0" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const [a, b] = ipv4.slice(1).map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

// What stops a reader checking a citation, kept apart from what merely looks
// untidy. A reader follows the link and reads the source: an address that
// cannot be resolved, or one carrying credentials that must never ship, defeats
// that and is blocking. A source published over plain HTTP does not — the
// reader opens it and reads it — so it is a notice on delivered work.
//
// Requiring HTTPS as a condition of delivery discarded two complete production
// reports over one link each: a CQVIP journal record, and
// http://purl.obolibrary.org/obo/CHEBI_28093, where http:// is the canonical
// form of the persistent identifier and rewriting it as https would have made
// the citation less correct. A URL fragment was rejected on the same footing,
// though #section-3 is how a citation points at the passage it means; that is
// not a defect at all and is no longer treated as one.
/** @param {unknown} text @returns {{ blocking: string[], advisory: string[] }} */
export function citationUrlDefects(text) {
  /** @type {string[]} */
  const blocking = []
  /** @type {string[]} */
  const advisory = []
  for (const value of citedHttpUrls(text)) {
    let url
    try {
      url = new URL(value)
    } catch {
      blocking.push(`The citation ${value} is not a resolvable URL, so a reader cannot reach the source it names.`)
      continue
    }
    if (url.username || url.password) {
      blocking.push(`The citation for ${url.hostname} carries credentials in the URL; cite the public address of the source instead.`)
      continue
    }
    if ((url.hostname === "www.evimed.com" && url.pathname.startsWith("/api-evimed/")) || unresolvableCitationHost(url)) {
      blocking.push(`The citation ${value} points inside this deployment, which a reader outside it cannot open; cite the public source the record came from.`)
      continue
    }
    if (url.protocol !== "https:") {
      advisory.push(`The citation ${value} is served over plain HTTP. The source is reachable and the claim stands; prefer the HTTPS address where the publisher offers one.`)
    }
  }
  return { blocking, advisory }
}

/**
 * `citationUrlDefects` of one file, line by line, each message opening with
 * where it is: the one wording the run-side gate and the control plane both
 * use. They used to word the same plain-HTTP link differently — only one said
 * where it was — so a delivered run carried it twice (2026-09-28
 * dapagliflozin).
 * @param {string} path the file's name in the deliverable @param {unknown} text
 * @returns {{ blocking: { line: number, message: string }[], advisory: { line: number, message: string }[] }}
 */
export function citationUrlDefectsByLine(path, text) {
  /** @type {{ line: number, message: string }[]} */
  const blocking = []
  /** @type {{ line: number, message: string }[]} */
  const advisory = []
  for (const [index, line] of String(text ?? "").split("\n").entries()) {
    const found = citationUrlDefects(line)
    for (const message of found.blocking) blocking.push({ line: index + 1, message: `${path} line ${index + 1}: ${message}` })
    for (const message of found.advisory) advisory.push({ line: index + 1, message: `${path} line ${index + 1}: ${message}` })
  }
  return { blocking, advisory }
}

// ---- EviMed's own card pages cited as a source (flywheel plan §4.3 rule 2) --------
//
// A card is the platform's reading of sources, so a report that cites one has cited the platform to itself:
// written content becomes evidence for more written content, and the loop looks more certain at each turn
// (the plan's reason for the rule; ICMJE 2026 says the same of AI-generated material). The rule is a notice,
// never a refusal: it names the address, says what to cite instead and withholds nothing. A card is found in a
// run through `frontier_search`, which returns the primary sources it stands on and asks the run to cite those
// (`evidenceCardSearch.mjs`); this is the net for the run that cites the card anyway.
//
// What is recognised is an address shape, not a host: the deployment's public host is not known to a run, is
// numeric today and will be a domain tomorrow, so a card page is the path `/evidence/c/<id>` (a card) or
// `/evidence/z/<id>` (a zone) on any host — or the same under the other member of the closed set of public base
// paths, `/evimed-evidence`, which a deployment whose own `/evidence/` belongs to another product serves them at
// (`OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH`) — the in-app page `/app/frontier/zones/<zone>/evidence/<card>` on any
// host or as a root-relative link, and — when the caller knows the configured public URL — the same paths under
// that URL's own path prefix. Identifier formats, not prose (principle 5).

/**
 * The paths the public evidence pages may be served under: `/evidence` (the default, and the address of the eventual domain) and
 * `/evimed-evidence` (a deployment on a numeric address whose `/evidence/` another product holds). A closed set: the server's lever
 * refuses anything else by name, and a card address under either member is recognised on any host.
 */
export const EVIDENCE_PUBLIC_BASE_PATHS = Object.freeze(['/evidence', '/evimed-evidence'])
const BASE_PATH_ALTERNATIVES = EVIDENCE_PUBLIC_BASE_PATHS.map((path) => path.slice(1)).join('|')

/** What a reader is told about a card cited as a source. */
export const PLATFORM_CARD_CITATION_SENTENCE = '这是 EviMed 自己的证据卡，请改引原始来源'

const CARD_ID = '[A-Za-z0-9][A-Za-z0-9_-]{5,79}'
const CARD_PAGE_PATH = new RegExp(`^/(?:${BASE_PATH_ALTERNATIVES})/[cz]/${CARD_ID}(?:/|$)`)
const IN_APP_CARD_PATH = new RegExp(`^/app/frontier/zones/${CARD_ID}/evidence/${CARD_ID}(?:/|$)`)
/** A root-relative card link in running text: never the tail of a longer path or of an absolute address. */
const RELATIVE_CARD_LINK = new RegExp(`(?<![A-Za-z0-9_./:-])(?:/(?:${BASE_PATH_ALTERNATIVES})/[cz]/${CARD_ID}|/app/frontier/zones/${CARD_ID}/evidence/${CARD_ID})(?![A-Za-z0-9_-])`, 'g')

/** The path prefix of a configured public URL, without a trailing slash; empty when it has none or is not an address. @param {unknown} publicUrl */
function publicPathPrefix(publicUrl) {
  const url = typeof publicUrl === 'string' && publicUrl.trim() ? parsed(publicUrl.trim()) : null
  return url ? url.pathname.replace(/\/+$/, '') : ''
}

/**
 * Whether an address is a page of an EviMed evidence card or zone.
 * @param {string} value @param {{ publicUrl?: string | null }} [options] `publicUrl`: the deployment's configured public URL, when the caller has it
 * @returns {boolean}
 */
export function isPlatformCardAddress(value, { publicUrl = null } = {}) {
  const url = parsed(String(value ?? '').trim())
  if (!url || !/^https?:$/.test(url.protocol)) return false
  const path = url.pathname
  if (CARD_PAGE_PATH.test(path) || IN_APP_CARD_PATH.test(path)) return true
  const prefix = publicPathPrefix(publicUrl)
  const own = typeof publicUrl === 'string' ? parsed(publicUrl.trim()) : null
  if (!prefix || !own || own.host.toLowerCase() !== url.host.toLowerCase() || !path.startsWith(`${prefix}/`)) return false
  const rest = path.slice(prefix.length)
  return CARD_PAGE_PATH.test(rest) || IN_APP_CARD_PATH.test(rest)
}

/**
 * The words a finding about one card address says: the reader-facing sentence first, then where it is.
 * @param {{ path: string, line?: number | null, url: string }} entry @returns {string}
 */
export function platformCardCitationMessage({ path, line, url }) {
  return `${PLATFORM_CARD_CITATION_SENTENCE}：${path}${line ? ` 第 ${line} 行` : ''}引用了 ${url}。`
    + '请打开这张卡列出的原始来源（论文、指南、说明书），读过之后引用它们的 DOI 或原文链接。'
}

/**
 * Every EviMed card address a text carries, by line, each address once per line: absolute links and root-relative
 * ones alike.
 * @param {unknown} text @param {{ publicUrl?: string | null }} [options]
 * @returns {{ line: number, url: string }[]}
 */
export function platformCardCitations(text, { publicUrl = null } = {}) {
  /** @type {{ line: number, url: string }[]} */
  const found = []
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    const seen = new Set()
    const urls = [
      ...citedHttpUrls(line).filter((url) => isPlatformCardAddress(url, { publicUrl })),
      ...[...line.matchAll(RELATIVE_CARD_LINK)].map((match) => match[0]),
    ]
    for (const url of urls) {
      if (seen.has(url)) continue
      seen.add(url)
      found.push({ line: index + 1, url })
    }
  }
  return found
}

/**
 * `platformCardCitations` of one file as findings, each opening with the sentence a reader is shown and then where.
 * @param {string} path the file's name in the deliverable @param {unknown} text @param {{ publicUrl?: string | null }} [options]
 * @returns {{ line: number, url: string, message: string }[]}
 */
export function platformCardCitationsByLine(path, text, options = {}) {
  return platformCardCitations(text, options).map(({ line, url }) => ({ line, url, message: platformCardCitationMessage({ path, line, url }) }))
}
