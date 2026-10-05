/**
 * The platform's one join key: what a thing is about (a drug, a disease, a
 * trial, an organisation) and which work it is (a DOI, a PMID, a trial-registry
 * number), written as strings every module can compare.
 *
 * Hidden knowledge:
 *
 * - **Two kinds of key, one namespace.** An entity key is `<kind>:<name>` with
 *   the kind one of drug, disease, trial, org — the key the frontier feed gives
 *   every item it publishes, made by the glossary (`frontierGlossary.mjs`,
 *   which owns the names). An identifier key is `doi:<doi>`, `pmid:<number>` or
 *   `reg:<REGISTRY ID>` — the spelling the frontier's `item_keys` table stores
 *   for an item (`entryKeys` in `frontierPipeline.mjs`), so a lookup by
 *   identifier key is a primary-key lookup there. A record's `entityKeys` array
 *   holds both; {@link keyKind} tells them apart by prefix.
 * - **Identifiers are matched exactly, entities by name.** An identifier names
 *   one work, so two records sharing one are about the same work; an entity key
 *   says only that two records mention the same drug. Callers that need the
 *   difference (a new study of the same drug is not the study a card cites)
 *   read {@link overlap}, which keeps the two apart.
 * - **Nothing here reads a language.** The DOI is the frontier's own
 *   canonical form (`doiOf`); the PMID and NCT/ISRCTN/ChiCTR/EU CT patterns
 *   are closed formats, checked as formats — which work a sentence is about
 *   is not decided here, and a name the glossary does not know is not made up.
 *
 * @module @evimed/domain/entity-keys
 */

import { referenceIdentifiers } from './clinicalEvidence.mjs'
import { doiOf } from './sourceUpdates.mjs'

/** The entity kinds a key can carry — the frontier's four. */
export const ENTITY_KEY_KINDS = Object.freeze(['drug', 'disease', 'trial', 'org'])

/**
 * The kinds free text is tagged with. An organisation is who said something,
 * not what a record is about — `FDA` and `WHO` stand in the text of any topic,
 * so a join through one would match half the feed. The frontier still keys its
 * own items by organisation, and {@link overlap} reports whatever keys it is
 * given.
 */
export const ENTITY_TEXT_KINDS = Object.freeze(['drug', 'disease', 'trial'])

/** The identifier kinds, in the frontier's spelling. */
export const IDENTIFIER_KEY_KINDS = Object.freeze(['doi', 'pmid', 'reg'])

/** The longest key kept; the glossary's own cut is 160. */
export const ENTITY_KEY_MAX_CHARS = 200

/** At most this many registry ids from one record, the knowledge-source contract's own limit. */
export const IDENTIFIER_REGISTRY_MAX = 20

/** At most this much text is searched for identifiers. */
const IDENTIFIER_TEXT_MAX_CHARS = 50_000

const PMID = /^\d{1,10}$/
/** A registry number once upper-cased: NCT, ISRCTN, ChiCTR, EU CT, and anything shaped like one. */
const REGISTRY_ID = /^[A-Z0-9][A-Z0-9._-]{2,63}$/
/** The registry numbers a sentence can hold beyond NCT, which `referenceIdentifiers` already reads. */
const REGISTRY_IN_TEXT = /(?<![A-Za-z0-9])(?:ISRCTN\d{8}|ChiCTR[-A-Za-z0-9]*\d{6,}|\d{4}-\d{6}-\d{2}-\d{2})(?![A-Za-z0-9-])/gi

/** @param {unknown} value @returns {unknown[]} */
const listOf = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])

/** @param {string} key @returns {string | null} the key if it fits */
const fitted = (key) => (key.length <= ENTITY_KEY_MAX_CHARS ? key : null)

/** @param {string} left @param {string} right */
const byCode = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The canonical identifier keys of what a record states, in a stable order:
 * the DOIs, then the PMIDs, then the registry numbers, each sorted. A value
 * that is not an identifier of its kind is dropped, not repaired.
 * @param {{ doi?: unknown, pmid?: unknown, registryIds?: unknown } | null | undefined} identifiers
 * @returns {string[]}
 */
export function identifierKeys(identifiers) {
  const dois = new Set()
  for (const value of listOf(identifiers?.doi)) {
    const doi = doiOf(value)
    const key = doi ? fitted(`doi:${doi}`) : null
    if (key) dois.add(key)
  }
  const pmids = new Set()
  for (const value of listOf(identifiers?.pmid)) {
    const pmid = String(value ?? '').trim().replace(/^pmid:?\s*/i, '')
    if (PMID.test(pmid)) pmids.add(`pmid:${pmid}`)
  }
  const registered = new Set()
  for (const value of listOf(identifiers?.registryIds).slice(0, IDENTIFIER_REGISTRY_MAX)) {
    const id = String(value ?? '').trim().toUpperCase()
    if (REGISTRY_ID.test(id)) registered.add(`reg:${id}`)
  }
  return [...[...dois].sort(byCode), ...[...pmids].sort(byCode), ...[...registered].sort(byCode)]
}

/**
 * The identifier keys a text names: DOIs and PMIDs as the reference parser
 * reads them, NCT numbers (which it reads too), and the ISRCTN, ChiCTR and EU
 * CT numbers the same way a registry id is written.
 * @param {unknown} text
 * @returns {string[]}
 */
export function identifierKeysInText(text) {
  const source = String(text ?? '').slice(0, IDENTIFIER_TEXT_MAX_CHARS)
  if (!source) return []
  /** @type {{ doi: string[], pmid: string[], registryIds: string[] }} */
  const found = { doi: [], pmid: [], registryIds: [] }
  for (const key of referenceIdentifiers(source)) {
    const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (kind === 'doi') found.doi.push(value)
    else if (kind === 'pmid') found.pmid.push(value)
    else if (kind === 'nct') found.registryIds.push(value)
  }
  for (const match of source.matchAll(REGISTRY_IN_TEXT)) found.registryIds.push(match[0])
  return identifierKeys(found)
}

/**
 * What kind of key this is: an entity kind, an identifier kind, or null for a
 * string that is neither.
 * @param {unknown} key
 * @returns {'drug' | 'disease' | 'trial' | 'org' | 'doi' | 'pmid' | 'reg' | null}
 */
export function keyKind(key) {
  const text = typeof key === 'string' ? key : ''
  const colon = text.indexOf(':')
  if (colon < 1 || colon === text.length - 1) return null
  const prefix = text.slice(0, colon)
  return /** @type {any} */ ([...ENTITY_KEY_KINDS, ...IDENTIFIER_KEY_KINDS].find((candidate) => candidate === prefix) ?? null)
}

/** @param {unknown} key */
export const isIdentifierKey = (key) => IDENTIFIER_KEY_KINDS.includes(/** @type {any} */ (keyKind(key)))

/** @param {unknown} key */
export const isEntityKey = (key) => ENTITY_KEY_KINDS.includes(/** @type {any} */ (keyKind(key)))

/**
 * A record's keys split by kind, each list sorted and without repeats; a string
 * that is no key is dropped.
 * @param {unknown} keys
 * @returns {{ entityKeys: string[], identifierKeys: string[] }}
 */
export function splitKeys(keys) {
  const entities = new Set()
  const identifiers = new Set()
  for (const key of listOf(keys)) {
    if (isEntityKey(key)) entities.add(key)
    else if (isIdentifierKey(key)) identifiers.add(key)
  }
  return { entityKeys: [...entities].sort(byCode), identifierKeys: [...identifiers].sort(byCode) }
}

/**
 * The keys two records share, kept apart: a shared identifier means the same
 * work, a shared entity only the same subject.
 * @param {unknown} keysA @param {unknown} keysB
 * @returns {{ entityKeys: string[], identifierKeys: string[] }}
 */
export function overlap(keysA, keysB) {
  const right = new Set(listOf(keysB))
  return splitKeys(listOf(keysA).filter((key) => right.has(key)))
}
