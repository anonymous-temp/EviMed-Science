/**
 * One durable fact per source identifier: what was published about a work after it was published (plan 2026-10-05
 * §5.4, B5).
 *
 * A retraction, a correction, an expression of concern or a new version used to be detected three times, by three
 * modules that never told each other: the result impact lookup (Crossref, an in-memory cache), the evidence zone's
 * editor (Europe PMC's publication status, kept on a card's source), and the frontier feed (relations that Crossref,
 * PubMed, Europe PMC and Retraction Watch asserted, kept in `item_links`). The control plane now keeps one record per
 * identifier, written by every detector and read by every module; this is its vocabulary and its pure rules. The
 * store that holds it is `apps/server/src/sourceChanges.mjs`.
 *
 * Hidden knowledge:
 *
 * - **One identifier, in the form the code already compares.** A DOI is `doiOf`'s (lower case, no resolver prefix),
 *   a PMID and a trial-registry number are the frontier's own identity keys (`doi:`, `pmid:`, `reg:`, which
 *   `entryKeys` writes), so a record found by one module is found by every other.
 * - **A change is the notice, not the work.** It is deduplicated by (kind, the notice's own identifier), and every
 *   detector that saw it is kept: Crossref's record and Retraction Watch's are two witnesses of one retraction, not
 *   two retractions. The list only grows; a later check that finds less never removes what an earlier one found.
 * - **Unknown is a value.** A work nobody asked about is `unknown`, a work asked about whose answer could not be had
 *   is still `unknown` (nothing is recorded for it), and only an answered check with nothing found is `clean`. A
 *   reader can therefore tell "not looked at" from "looked at and nothing there".
 * - **A label, never a verdict.** What a reader is shown is that the source changed and which notice says so; whether
 *   a conclusion that cites the source still stands is the report's to argue (principle 13).
 *
 * Pure, browser-safe, no I/O, no clock (the caller passes the time).
 * @module @evimed/domain/source-change
 */

import { pmidOfUrl } from './citedSources.mjs'
import { SOURCE_UPDATE_KINDS, doiOf } from './sourceUpdates.mjs'

/** What happened to the work, as a closed vocabulary. */
export const SOURCE_CHANGE_KINDS = Object.freeze(['retraction', 'correction', 'concern', 'new_version', 'withdrawal'])

/** Who saw it: the detectors that write into the record. */
export const SOURCE_CHANGE_ASSERTERS = Object.freeze(['crossref', 'pubmed', 'europepmc', 'retraction-watch', 'registry', 'operator'])

/** What a reader can know about an identifier: it changed, a check found nothing, or nothing is known. */
export const SOURCE_CHANGE_STATES = Object.freeze(['changed', 'clean', 'unknown'])

/** What an answered check says: the work is known and was read, or the checked index does not hold the work. */
export const SOURCE_CHANGE_OUTCOMES = Object.freeze(['answered', 'not_indexed'])

/**
 * How much a change alters what the work can carry: `withdrawn` — it no longer stands as published; `concern` — the
 * journal itself has doubts; `corrected` — read the corrected version; `superseded` — a newer version exists.
 */
export const SOURCE_CHANGE_WEIGHT = Object.freeze({
  retraction: 'withdrawn',
  withdrawal: 'withdrawn',
  concern: 'concern',
  correction: 'corrected',
  new_version: 'superseded',
})

/** The changes that warn a reader about the source itself. A new version is news about it, not a warning. */
export const SOURCE_CHANGE_NOTICE_KINDS = Object.freeze(['retraction', 'withdrawal', 'concern', 'correction'])

/** Chinese badge text for a change. */
export const SOURCE_CHANGE_LABELS_ZH = Object.freeze({
  retraction: '已撤稿',
  correction: '有更正',
  concern: '编辑部关注声明',
  new_version: '有新版本',
  withdrawal: '已撤回',
})

/** How many changes one identifier keeps. A work with sixty-four notices is not a case the list needs to grow for. */
export const SOURCE_CHANGE_MAX_CHANGES = 64

/** The five 时效 labels of plan §4.4. */
export const SOURCE_CURRENCY_LABELS = Object.freeze(['current', 'new_evidence_pending', 'source_changed', 'superseded', 'no_longer_updated'])

/** The labels as a reader reads them. */
export const SOURCE_CURRENCY_LABELS_ZH = Object.freeze({
  current: '现行',
  new_evidence_pending: '有新证据，尚未纳入',
  source_changed: '来源已撤稿或更正',
  superseded: '已被新版本取代',
  no_longer_updated: '不再更新',
})

/** The refusals of the store, in the words the browser may show. The store is not a route; its callers are modules. */
export const SOURCE_CHANGE_ERROR_MESSAGES = Object.freeze({
  source_change_invalid: '这条来源变更的标识符或内容不符合要求，没有记录。',
  source_change_unavailable: '来源变更记录暂时不可用，已有内容不受影响。',
})

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Registry numbers the platform reads: ClinicalTrials.gov, ChiCTR, ISRCTN and EudraCT / EU CTR. Upper case. */
const REGISTRY_ID = /^(?:NCT\d{8}|CHICTR[-A-Z0-9]{3,40}|ISRCTN\d{8}|(?:EUCTR)?\d{4}-\d{6}-\d{2}(?:-[A-Z0-9]{2,3})?)$/

/** The registry number a ClinicalTrials.gov study page names. @param {string} text @returns {string} */
function registryIdOfUrl(text) {
  try {
    const url = new URL(text)
    if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'clinicaltrials.gov') return ''
    return /^\/study\/(NCT\d{8})\/?$/i.exec(url.pathname)?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * An identifier in the one form every module compares: `doi:<doi>`, `pmid:<digits>` or `reg:<REGISTRY NUMBER>`, the
 * frontier's own identity keys. A DOI is read the way `doiOf` reads it (a `doi.org` link, a `doi:` prefix and sentence
 * punctuation are all the same DOI), a PMID from a PubMed link or `PMID 123`, a registry number from a bare number or a
 * ClinicalTrials.gov study link. Null when the text is none of them.
 * @param {unknown} value @returns {string | null}
 */
export function canonicalSourceIdentifier(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > 600) return null
  const doi = doiOf(text)
  if (doi) return `doi:${doi}`
  const pmid = pmidOfUrl(text) || /^(?:pmid|pubmed)\s*[:：]?\s*(\d{1,10})$/i.exec(text)?.[1] || ''
  if (pmid) return `pmid:${pmid}`
  const registry = (registryIdOfUrl(text) || /^reg:\s*(.+)$/i.exec(text)?.[1] || text).trim().toUpperCase()
  return REGISTRY_ID.test(registry) ? `reg:${registry}` : null
}

/** @param {string} identifier @returns {'doi' | 'pmid' | 'reg' | null} */
export function sourceIdentifierScheme(identifier) {
  const scheme = /^(doi|pmid|reg):/.exec(String(identifier ?? ''))?.[1]
  return /** @type {'doi' | 'pmid' | 'reg' | null} */ (scheme ?? null)
}

/** The DOI of a canonical identifier, or null when it is not one. @param {string} identifier @returns {string | null} */
export function doiOfSourceIdentifier(identifier) {
  return sourceIdentifierScheme(identifier) === 'doi' ? String(identifier).slice(4) : null
}

/**
 * What names a notice: its own DOI, a PubMed record (`pmid:<digits>`), or an address. Null when the notice is not
 * named by any of them, which is how a status read from a flag rather than from a record arrives.
 * @param {unknown} value @returns {string | null}
 */
export function noticeIdentifierOf(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > 500) return null
  const doi = doiOf(text)
  if (doi) return doi
  const pmid = pmidOfUrl(text) || /^pmid:\s*(\d{1,10})$/i.exec(text)?.[1] || ''
  if (pmid) return `pmid:${pmid}`
  if (!/^https?:\/\//i.test(text)) return null
  try {
    const url = new URL(text)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** A record is plain JSON, so a JSON round trip is its copy (this module runs in the browser too). @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value))

/** @param {unknown} value @returns {string | null} */
function dayOf(value) {
  const text = typeof value === 'string' ? value : value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : ''
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null
}

/** @param {unknown} value @returns {string | null} */
const instantOf = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null)

/**
 * The short machine fields a detector returned, as they may be kept: up to twelve named fields, each a short text, a
 * number, a flag, nothing, or a short list of short texts. Anything else is dropped, not coerced.
 * @param {unknown} value @returns {Record<string, string | number | boolean | null | string[]>}
 */
function evidenceOf(value) {
  /** @type {Record<string, string | number | boolean | null | string[]>} */
  const kept = {}
  if (!isRecord(value)) return kept
  for (const [key, field] of Object.entries(value).slice(0, 12)) {
    if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(key)) continue
    if (field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))) kept[key] = field
    else if (typeof field === 'string' && field.length <= 300) kept[key] = field
    else if (Array.isArray(field) && field.length <= 10 && field.every((entry) => typeof entry === 'string' && entry.length <= 300)) kept[key] = [...field]
  }
  return kept
}

/**
 * @typedef {object} SourceChange
 * @property {string} kind one of SOURCE_CHANGE_KINDS
 * @property {string | null} noticeIdentifier the notice's own DOI, `pmid:` or address
 * @property {string | null} date YYYY-MM-DD, when the notice says when
 * @property {string[]} assertedBy every detector that saw it, in the order they did
 * @property {string} firstSeenAt when the first of them did
 * @property {string} lastCheckedAt when any of them last saw it
 * @property {Record<string, Record<string, any>>} evidence what each detector returned, by detector
 */

/**
 * @typedef {object} SourceChangeRecord what the ledger holds for one identifier
 * @property {1} schemaVersion
 * @property {'source-change'} recordType
 * @property {string} identifier
 * @property {SourceChange[]} changes
 * @property {string | null} lastCheckedAt the last answered check or assertion
 * @property {string | null} lastOutcome what that answer was
 * @property {number | null} seq the position of the last change appended, in the order of the feed; null while none
 */

/**
 * @typedef {object} SourceChangeFact what a reader gets for one identifier
 * @property {string} identifier
 * @property {'changed' | 'clean' | 'unknown'} state
 * @property {SourceChange[]} changes
 * @property {string | null} lastCheckedAt
 * @property {string | null} lastOutcome
 * @property {number | null} seq
 */

/**
 * One change as a detector offers it, normalized: a known kind, a notice identifier or none, a day or none, the short
 * machine fields it returned. Null when the kind is not one of the five.
 * @param {unknown} input @returns {{ kind: string, noticeIdentifier: string | null, date: string | null, evidence: Record<string, any> } | null}
 */
export function normalizeSourceChange(input) {
  if (!isRecord(input) || !SOURCE_CHANGE_KINDS.includes(input.kind)) return null
  return { kind: input.kind, noticeIdentifier: input.noticeIdentifier == null ? null : noticeIdentifierOf(input.noticeIdentifier),
    date: dayOf(input.date), evidence: evidenceOf(input.evidence) }
}

/** @param {string} identifier @returns {SourceChangeRecord} */
export function emptySourceChangeRecord(identifier) {
  return { schemaVersion: 1, recordType: 'source-change', identifier, changes: [], lastCheckedAt: null, lastOutcome: null, seq: null }
}

/**
 * Fold what a detector found into the record of an identifier. Pure: the record comes back as a new value, with what
 * the fold did named so the store can decide how to write it.
 *
 * - a change not yet held is appended (`appended`) and is what the feed announces;
 * - a change already held that another detector now also saw gains that detector (`confirmed`), and a date it lacked (`filled`);
 * - a change the same detector sees again moves only its own check time, which is a counter and not a fact.
 *
 * `outcome` is what the check that produced these entries answered; an entry list may be empty, which is how an answered
 * check with nothing found is recorded.
 * @param {SourceChangeRecord | null} record
 * @param {Array<{ assertedBy: string, kind: string, noticeIdentifier?: string | null, date?: string | null, evidence?: Record<string, any> }>} entries
 * @param {{ identifier: string, at: string, outcome?: 'answered' | 'not_indexed' }} context
 * @returns {{ record: SourceChangeRecord, appended: number, confirmed: number, filled: number, duplicates: number, rejected: number, asserters: string[] }}
 */
export function foldSourceChanges(record, entries, { identifier, at, outcome = 'answered' }) {
  const next = /** @type {SourceChangeRecord} */ (clone(record ?? emptySourceChangeRecord(identifier)))
  let appended = 0
  let confirmed = 0
  let filled = 0
  let duplicates = 0
  let rejected = 0
  /** @type {string[]} */
  const asserters = []
  for (const entry of entries) {
    const change = SOURCE_CHANGE_ASSERTERS.includes(entry?.assertedBy) ? normalizeSourceChange(entry) : null
    if (!change) { rejected += 1; continue }
    const held = next.changes.find((candidate) => candidate.kind === change.kind && candidate.noticeIdentifier === change.noticeIdentifier)
    if (!held) {
      if (next.changes.length >= SOURCE_CHANGE_MAX_CHANGES) { rejected += 1; continue }
      next.changes.push({ kind: change.kind, noticeIdentifier: change.noticeIdentifier, date: change.date, assertedBy: [entry.assertedBy],
        firstSeenAt: at, lastCheckedAt: at, evidence: { [entry.assertedBy]: change.evidence } })
      appended += 1
      asserters.push(entry.assertedBy)
      continue
    }
    held.lastCheckedAt = at
    if (!held.assertedBy.includes(entry.assertedBy)) {
      held.assertedBy.push(entry.assertedBy)
      held.evidence[entry.assertedBy] = change.evidence
      confirmed += 1
      asserters.push(entry.assertedBy)
    } else duplicates += 1
    if (!held.date && change.date) { held.date = change.date; filled += 1 }
  }
  next.lastCheckedAt = at
  next.lastOutcome = outcome
  return { record: next, appended, confirmed, filled, duplicates, rejected, asserters }
}

/**
 * What a reader is given for an identifier, from what the ledger holds (or nothing, for an identifier never asked about).
 * @param {string} identifier @param {SourceChangeRecord | null | undefined} record
 * @returns {SourceChangeFact}
 */
export function sourceChangeFact(identifier, record) {
  const changes = Array.isArray(record?.changes) ? /** @type {SourceChange[]} */ (clone(record.changes)) : []
  const lastCheckedAt = instantOf(record?.lastCheckedAt)
  const lastOutcome = SOURCE_CHANGE_OUTCOMES.includes(/** @type {string} */ (record?.lastOutcome)) ? /** @type {string} */ (record?.lastOutcome) : null
  const state = changes.length ? 'changed' : lastCheckedAt && lastOutcome === 'answered' ? 'clean' : 'unknown'
  return { identifier, state, changes, lastCheckedAt, lastOutcome, seq: Number.isSafeInteger(record?.seq) ? /** @type {number} */ (record?.seq) : null }
}

/** The kind a Crossref update type is, and the type it was (the legacy vocabulary of `sourceUpdates.mjs`). */
const CHANGE_KIND_OF_UPDATE = Object.freeze(/** @type {Record<string, string>} */ ({
  retraction: 'retraction',
  partial_retraction: 'retraction',
  withdrawal: 'withdrawal',
  removal: 'withdrawal',
  expression_of_concern: 'concern',
  correction: 'correction',
}))

/** The legacy type a change shows as when no detector said which of its several types it was. */
const UPDATE_KIND_OF_CHANGE = Object.freeze(/** @type {Record<string, string>} */ ({
  retraction: 'retraction',
  withdrawal: 'withdrawal',
  concern: 'expression_of_concern',
  correction: 'correction',
}))

/** @param {string} kind */
const updateRank = (kind) => { const at = SOURCE_UPDATE_KINDS.indexOf(kind); return at < 0 ? SOURCE_UPDATE_KINDS.length : at }

/**
 * The notices of a record in the shape the result impact path and the 「依据」 popover already read
 * (`SourceUpdate`): the six notice types, most serious first. A new version is not among them — the legacy vocabulary
 * says a new version does not change what a reader should make of the work, and readers of the record that do care
 * (`currencyLabel`) read the change itself.
 * @param {readonly SourceChange[]} changes
 * @returns {Array<{ kind: string, noticeDoi: string | null, date: string | null, source: 'publisher' | 'retraction-watch' | null }>}
 */
export function sourceUpdatesOfChanges(changes) {
  return changes.flatMap((change) => {
    if (!SOURCE_CHANGE_NOTICE_KINDS.includes(change.kind)) return []
    const said = Object.values(change.evidence ?? {}).map((entry) => entry?.updateKind).find((kind) => typeof kind === 'string'
      && CHANGE_KIND_OF_UPDATE[kind] === change.kind)
    /** @type {'publisher' | 'retraction-watch' | null} */
    const source = change.assertedBy.includes('crossref') ? 'publisher' : change.assertedBy.includes('retraction-watch') ? 'retraction-watch' : null
    return [{ kind: said ?? UPDATE_KIND_OF_CHANGE[change.kind], noticeDoi: doiOf(change.noticeIdentifier), date: change.date, source }]
  }).sort((left, right) => updateRank(left.kind) - updateRank(right.kind) || String(left.date ?? '').localeCompare(String(right.date ?? '')))
}

/**
 * A fact as a source update status (`sourceUpdates.mjs`): `changed` with its notices, `no_update` for an answered check
 * that found nothing, and `unknown` — with the reason — for everything else. Never `no_update` for an identifier nobody
 * checked.
 * @param {SourceChangeFact} fact
 * @returns {{ state: 'changed' | 'no_update' | 'unknown', checkedAt: string | null, reason?: string, updates: ReturnType<typeof sourceUpdatesOfChanges> }}
 */
export function sourceUpdateStatusOfFact(fact) {
  const updates = sourceUpdatesOfChanges(fact.changes)
  if (updates.length) return { state: 'changed', checkedAt: fact.lastCheckedAt, updates }
  if (fact.lastCheckedAt && fact.lastOutcome === 'answered') return { state: 'no_update', checkedAt: fact.lastCheckedAt, updates: [] }
  if (fact.lastCheckedAt) return { state: 'unknown', checkedAt: fact.lastCheckedAt, reason: 'not_in_crossref', updates: [] }
  return { state: 'unknown', checkedAt: null, reason: 'never_checked', updates: [] }
}

/**
 * What a check found, with what the record already held about the same work. A notice some detector recorded is not
 * undone by a check that did not see it (a lookup that timed out, an index that lags the publisher), so a record that
 * holds notices turns any other status into `changed` and adds its notices to the ones the check named. A record that
 * holds none changes nothing: its `clean` or `unknown` is not evidence against what a fresh check found.
 * @param {any} provided a source update status (`{ state, checkedAt, updates, reason? }`)
 * @param {ReturnType<typeof sourceUpdateStatusOfFact> | null | undefined} recorded
 * @returns {any} a source update status
 */
export function mergeSourceUpdateStatus(provided, recorded) {
  if (!recorded || recorded.state !== 'changed') return provided
  /** @type {Map<string, any>} */
  const merged = new Map()
  for (const update of [...(provided?.updates ?? []), ...recorded.updates]) {
    const key = `${update?.kind}\u0000${update?.noticeDoi ?? ''}`
    if (!merged.has(key)) merged.set(key, update)
  }
  const updates = [...merged.values()].sort((left, right) => updateRank(left.kind) - updateRank(right.kind) || String(left.date ?? '').localeCompare(String(right.date ?? '')))
  const base = provided?.state === 'changed' ? provided : { state: 'changed', checkedAt: provided?.checkedAt ?? recorded.checkedAt }
  return { ...base, checkedAt: base.checkedAt ?? recorded.checkedAt, updates }
}

/**
 * The changes a Crossref answer carries, as entries to fold: the notices of `sourceUpdatesFromCrossref`, each by the
 * detector that recorded it (Retraction Watch's own records are its own witness) with the update type kept, so the
 * legacy status can be read back out of the record exactly.
 * @param {ReadonlyArray<{ kind: string, noticeDoi: string | null, date: string | null, source: string | null }>} updates
 */
export function changesFromCrossrefUpdates(updates) {
  return updates.flatMap((update) => {
    const kind = CHANGE_KIND_OF_UPDATE[update.kind]
    if (!kind) return []
    return [{ assertedBy: update.source === 'retraction-watch' ? 'retraction-watch' : 'crossref', kind, noticeIdentifier: update.noticeDoi,
      date: update.date, evidence: { updateKind: update.kind, recordedBy: update.source ?? null } }]
  })
}

/** The frontier's link kinds (`evimed_frontier.item_links.kind`) that are a change of the work they point at. */
const CHANGE_KIND_OF_FRONTIER_LINK = Object.freeze(/** @type {Record<string, string>} */ ({
  retraction: 'retraction',
  withdrawal: 'withdrawal',
  'expression-of-concern': 'concern',
  correction: 'correction',
  'new-version': 'new_version',
}))

/**
 * The change a frontier relation asserts, or null for a relation that is not one (`preprint-of`).
 * @param {{ kind: string, noticeIdentifier?: string | null, date?: string | null, assertedBy?: string }} link
 */
export function changeFromFrontierLink(link) {
  const kind = CHANGE_KIND_OF_FRONTIER_LINK[link.kind]
  if (!kind) return null
  return { assertedBy: link.assertedBy ?? 'crossref', kind, noticeIdentifier: link.noticeIdentifier ?? null, date: link.date ?? null,
    evidence: { channel: 'frontier', relation: link.kind } }
}

/** The status kinds an evidence card's source carries (`publicationStatus.kind`, evidenceCardContent.mjs). */
const CHANGE_KIND_OF_PUBLICATION_STATUS = Object.freeze(/** @type {Record<string, string>} */ ({
  retracted: 'retraction',
  corrected: 'correction',
  concern: 'concern',
}))

/**
 * The type words Europe PMC puts first in a notice, matched whole: a closed table, not a pattern over prose. A notice
 * whose first words are not in it takes the kind the status as a whole carries.
 */
const CHANGE_KIND_OF_NOTICE_TYPE = new Map([
  ['retracted publication', 'retraction'], ['retraction of publication', 'retraction'], ['retraction in', 'retraction'], ['retraction of', 'retraction'],
  ['expression of concern', 'concern'], ['expression of concern in', 'concern'], ['expression of concern for', 'concern'],
  ['published erratum', 'correction'], ['erratum in', 'correction'], ['erratum for', 'correction'],
  ['corrected and republished in', 'correction'], ['corrected and republished from', 'correction'],
])

/**
 * The changes a card source's `publicationStatus` records (`{ kind: 'retracted' | 'corrected' | 'concern', notices: string[] }`,
 * what the evidence zone's editor reads from Europe PMC), as entries to fold. Each notice is its own change when it
 * names its PubMed record (`… · MED:123`), and the notices that name none of one kind are one change that keeps them as
 * its evidence. A status that is not one of the three kinds records nothing; a clear status (`null`) is not a change.
 * @param {unknown} publicationStatus
 * @returns {Array<{ assertedBy: 'europepmc', kind: string, noticeIdentifier: string | null, date: null, evidence: { notices: string[] } }>}
 */
export function changesFromPublicationStatus(publicationStatus) {
  const status = isRecord(publicationStatus) ? publicationStatus : null
  const fallback = status ? CHANGE_KIND_OF_PUBLICATION_STATUS[String(status.kind)] : undefined
  if (!status || !fallback) return []
  const notices = (Array.isArray(status.notices) ? status.notices : []).filter((/** @type {unknown} */ notice) => typeof notice === 'string' && notice.trim())
  /** @type {Map<string, { kind: string, noticeIdentifier: string | null, notices: string[] }>} */
  const grouped = new Map()
  for (const notice of notices.length ? notices : [null]) {
    const parts = notice ? String(notice).split(' · ').map((part) => part.trim()) : []
    const type = (parts[0] ?? '').toLowerCase().replace(/\s+/g, ' ')
    const kind = CHANGE_KIND_OF_NOTICE_TYPE.get(type) ?? fallback
    const record = /^MED:(\d{1,10})$/.exec(parts.at(-1) ?? '')?.[1]
    const noticeIdentifier = record ? `pmid:${record}` : null
    const key = `${kind}\u0000${noticeIdentifier ?? ''}`
    const group = grouped.get(key) ?? { kind, noticeIdentifier, notices: [] }
    if (notice && group.notices.length < 5) group.notices.push(String(notice).slice(0, 300))
    grouped.set(key, group)
  }
  return [...grouped.values()].map((group) => ({ assertedBy: /** @type {'europepmc'} */ ('europepmc'), kind: group.kind,
    noticeIdentifier: group.noticeIdentifier, date: null, evidence: { notices: group.notices } }))
}

/**
 * The 时效 label of one card, or of anything built on sources (plan §4.4): one of five, decided by what is known and in
 * this order of how much a reader needs to be told first.
 *
 * - `superseded` — the card has a successor; it is the thing to read instead, whatever its sources did.
 * - `source_changed` — a source of it was retracted, withdrawn, corrected or put under an expression of concern.
 * - `no_longer_updated` — the card was retired from upkeep; its sources are still watched, which is why this comes after.
 * - `new_evidence_pending` — new evidence reached the card's entities and has not been taken up, or a source has a newer
 *   version (a source's new version is news about the evidence, not a warning about the source).
 * - `current` — none of the above.
 *
 * A label is never decided by age: a source checked long ago is not evidence that it changed, and the caller shows the
 * last check date beside the label (`lastCheckedAt` is accepted so callers can pass the whole reading, and is not part
 * of the decision).
 * @param {{ changes?: ReadonlyArray<{ kind: string }>, hasNewEvidence?: boolean, superseded?: boolean, retired?: boolean, lastCheckedAt?: string | null }} input
 * @returns {'current' | 'new_evidence_pending' | 'source_changed' | 'superseded' | 'no_longer_updated'}
 */
export function currencyLabel({ changes = [], hasNewEvidence = false, superseded = false, retired = false } = {}) {
  if (superseded) return 'superseded'
  if (changes.some((change) => SOURCE_CHANGE_NOTICE_KINDS.includes(change.kind))) return 'source_changed'
  if (retired) return 'no_longer_updated'
  if (hasNewEvidence || changes.some((change) => change.kind === 'new_version')) return 'new_evidence_pending'
  return 'current'
}
