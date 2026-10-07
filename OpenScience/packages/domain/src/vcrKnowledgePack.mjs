/**
 * 「虚拟临床研究」's disease knowledge pack (plan 2026-09-28 §3.3): the contract a
 * pack is written to and the checks every pack — a shipped one, an AI-drafted
 * one — passes before anything reads it.
 *
 * Hidden knowledge:
 *
 * - **A pack holds definitions, never numbers a calculation uses.** Terms,
 *   phenotypes, endpoints, common eligibility criteria, data mappings and a
 *   little sourced background. An event rate, an effect size or a dropout
 *   figure is an evidence parameter and comes from the evidence side; every
 *   calculation comes from the engine. A threshold inside a criterion (「ECOG
 *   0–1」, 「HbA1c ≥ 7.0 %」) is the definition itself, not a parameter, and is
 *   written in the requirement grammar (`vcrRules.mjs`) like every other rule:
 *   data, never code.
 * - **A pack "does not mean predictive ability".** It tells a study what the
 *   disease is called, what regulators and guidelines measure, and what trials
 *   usually ask of a patient. It never says how a patient will do.
 * - **Every entry is sourced, and every source says what may be done with it.**
 *   An entry names the sources it rests on (`sources: [id]`) and each source
 *   carries its URL, title, the date it was read and a licence from the closed
 *   {@link VCR_PACK_LICENCES} table. A licence is one of three kinds of use:
 *   `attribution` (content may be reused with the licence's notices — the NCI
 *   Thesaurus and Chia are CC BY 4.0, the OHDSI PhenotypeLibrary is Apache-2.0,
 *   ClinicalTrials.gov content needs its processing date and a modification
 *   statement), `link-only` (the source is cited by link and its facts are
 *   restated in the pack's own words — CDISC guides, NCCN, CSCO, COMET and any
 *   guideline or journal article), or `own` (authored here). Nothing is ever
 *   copied from a link-only source, which is why a verbatim `definition` is
 *   refused unless an `attribution` source stands behind it.
 * - **What is restricted is not unlicensed text, it is a refusal by name.**
 *   WHO ICTRP records, ATC/DDD tables and MedDRA terms are never copied;
 *   neither are code systems a licence would have to cover (SNOMED CT, LOINC,
 *   RxNorm, CPT). A code system a pack's own sources do not publish is left
 *   unmapped — a term with no `codes` is a complete term — rather than
 *   imported from memory: an identifier is accepted only from a system in
 *   {@link VCR_PACK_CODE_SYSTEMS} and only beside a source that publishes it.
 * - **Two levels, one contract.** `draft` is the floor every pack meets: the
 *   structure, the licences, the refusals, every entry sourced, every rule in
 *   the closed grammar. `complete` is what a shipped pack meets in addition:
 *   both languages on every label, and every variable a rule names mapped to a
 *   dataset field hint. An AI draft is written to the floor and goes on; it is
 *   filled in later (plan §3.3). The status (`curated` / `ai-draft`) is who
 *   stood behind the pack, not how complete it is.
 * - **Validators return issues; they never throw.** An issue is
 *   `{ code, field, detail }` with the path of the defect, the same shape as
 *   the rule validators', so a write refuses an entry by name and the rest of
 *   the pack is still read.
 *
 * @module @evimed/domain/vcrKnowledgePack
 */

import { VCR_CRITERION_TYPES, VCR_ENDPOINT_TYPES, VCR_FIELD_ROLES } from './vcrVocabulary.mjs'
import { validateRequirement } from './vcrRules.mjs'

/** @template T @param {readonly T[]} list @returns {readonly T[]} */
const frozen = (list) => Object.freeze([...list])

/** @typedef {{ code: string, field: string, detail: string }} VcrPackIssue */

export const VCR_PACK_SCHEMA = 'evimed.vcr.knowledge-pack/1'

/** Who stands behind a pack. Written with a hyphen because that is the word the plan and the page use. */
export const VCR_PACK_STATUSES = frozen(['curated', 'ai-draft'])
export const VCR_PACK_STATUS_LABELS_ZH = Object.freeze({ curated: '已整理', 'ai-draft': 'AI 草拟' })

/** How demanding a check is: the floor every pack meets, and what a shipped pack meets in addition. */
export const VCR_PACK_LEVELS = frozen(['draft', 'complete'])

/** The six sections a pack holds, in the order a page shows them. */
export const VCR_PACK_SECTIONS = frozen(['terms', 'phenotypes', 'endpoints', 'criteria', 'mappings', 'background'])
export const VCR_PACK_SECTION_LABELS_ZH = Object.freeze({
  terms: '术语与编码', phenotypes: '表型定义', endpoints: '常用终点', criteria: '常见入排条件', mappings: '数据映射', background: '临床背景',
})

/** What a term is. `syndrome` is the dimension a TCM disease carries (plan §3.3). */
export const VCR_PACK_TERM_KINDS = frozen([
  'disease', 'histology', 'biomarker', 'stage', 'treatment', 'assessment', 'measure', 'comorbidity', 'syndrome', 'other',
])

/** What a mapped dataset field holds. */
export const VCR_PACK_MAPPING_TYPES = frozen(['number', 'date', 'text', 'code', 'flag'])

/**
 * What may be done with a source's content, by kind of use: `attribution` —
 * reuse with the licence's notices; `link-only` — cite by link, restate the
 * facts in the pack's own words, copy nothing; `own` — authored here.
 */
export const VCR_PACK_USE_CLASSES = frozen(['attribution', 'link-only', 'own'])

/**
 * The licences a source may name. A source under a licence outside this table
 * is refused (`pack_source_licence_unknown`): a pack states how its content
 * may be used, it never guesses. `obligations` are what the source entry must
 * itself carry (ClinicalTrials.gov's terms ask for the date its data were
 * processed and for a statement of any modification).
 *
 * The OHDSI PhenotypeLibrary is Apache-2.0 by its README and its package
 * DESCRIPTION; the repository holds no LICENSE file, so the table says what
 * the owner states and a source under it names the release it was read at.
 */
export const VCR_PACK_LICENCES = Object.freeze({
  'CC-BY-4.0': Object.freeze({
    name: 'Creative Commons Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/', use: 'attribution', obligations: frozen([]),
  }),
  'Apache-2.0': Object.freeze({
    name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0', use: 'attribution', obligations: frozen([]),
  }),
  'ctgov-terms': Object.freeze({
    name: 'ClinicalTrials.gov Terms and Conditions', url: 'https://clinicaltrials.gov/about-site/terms-conditions', use: 'attribution',
    obligations: frozen(['processed', 'modified']),
  }),
  'link-only': Object.freeze({
    name: 'Rights reserved by the publisher: cited by link, facts restated in own words', url: null, use: 'link-only', obligations: frozen([]),
  }),
  'evimed-own': Object.freeze({
    name: 'Authored for this pack', url: null, use: 'own', obligations: frozen([]),
  }),
})

/**
 * What is never copied, whatever a source says about itself: the restricted
 * host prefixes a source URL may not start with. WHO ICTRP records are barred
 * from commercial use by the ICTRP terms; ATC/DDD tables may not be copied for
 * commercial purposes; MedDRA is licensed per subscriber.
 */
export const VCR_PACK_RESTRICTED_SOURCES = Object.freeze([
  Object.freeze({ id: 'who-ictrp', prefixes: frozen(['https://trialsearch.who.int/', 'https://www.who.int/clinical-trials-registry-platform', 'https://www.who.int/tools/clinical-trials-registry-platform']), why: 'WHO ICTRP records may not be used for commercial purposes' }),
  Object.freeze({ id: 'atc-ddd', prefixes: frozen(['https://atcddd.fhi.no/', 'https://www.whocc.no/']), why: 'ATC/DDD tables may not be copied for commercial purposes' }),
  Object.freeze({ id: 'meddra', prefixes: frozen(['https://www.meddra.org/', 'https://meddra.org/', 'https://files.meddra.org/']), why: 'MedDRA terms are licensed per subscriber' }),
])

/**
 * The code systems a term may carry an identifier from, and who publishes them:
 * a code is accepted only beside a source whose URL starts with one of the
 * system's `publishers`, so an identifier always has a source that publishes it.
 */
export const VCR_PACK_CODE_SYSTEMS = Object.freeze({
  NCIt: Object.freeze({
    name: 'NCI Thesaurus', pattern: '^C[0-9]{1,8}$', publishers: frozen(['https://evs.nci.nih.gov/', 'https://ncit.nci.nih.gov/', 'https://ncithesaurus.nci.nih.gov/']),
  }),
  OMOP: Object.freeze({
    name: 'OMOP standard concept id, as the OHDSI PhenotypeLibrary publishes it', pattern: '^[1-9][0-9]{0,9}$',
    publishers: frozen(['https://github.com/OHDSI/PhenotypeLibrary', 'https://raw.githubusercontent.com/OHDSI/PhenotypeLibrary/', 'https://ohdsi.github.io/PhenotypeLibrary/']),
  }),
  'ICD-10-CM': Object.freeze({
    name: 'ICD-10-CM (US clinical modification)', pattern: '^[A-Z][0-9][0-9A-Z](\\.[0-9A-Z]{1,4})?$',
    publishers: frozen(['https://www.cdc.gov/nchs/', 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/']),
  }),
})

/**
 * Code systems that are never imported: licensed vocabularies and the tables
 * the restrictions above name. A term that needs one is left unmapped.
 */
export const VCR_PACK_REFUSED_CODE_SYSTEMS = frozen([
  'ATC', 'ATC/DDD', 'DDD', 'MedDRA', 'WHO-ICTRP', 'ICTRP', 'SNOMED CT', 'SNOMEDCT', 'LOINC', 'RxNorm', 'CPT', 'CPT4',
])

export const VCR_PACK_LIMITS = Object.freeze({
  sources: 100, terms: 200, phenotypes: 100, endpoints: 100, criteria: 200, mappings: 200, background: 50,
  codesPerTerm: 8, aliases: 30, fieldNames: 30, entrySources: 8, label: 200, short: 120, text: 1_200, definition: 2_000, url: 2_048,
})

/** An id of a pack, a source or an entry: lowercase, digits and `_`. */
export const VCR_PACK_ID_PATTERN = '^[a-z][a-z0-9_]{0,63}$'
const ID = new RegExp(VCR_PACK_ID_PATTERN)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const URL_HTTP = /^https?:\/\/[^\s/?#]+[^\s]*$/

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @param {number} max */
const isText = (value, max) => typeof value === 'string' && value.trim().length >= 1 && [...value].length <= max
/** @param {unknown} value */
const isDate = (value) => typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))
/** @param {string} path @param {string} key */
const at = (path, key) => (path ? `${path}.${key}` : key)

/**
 * Whether a source URL falls under a restricted prefix, and which.
 * @param {unknown} url
 */
export function vcrPackRestrictedSource(url) {
  if (typeof url !== 'string') return null
  const lowered = url.trim().toLowerCase()
  return VCR_PACK_RESTRICTED_SOURCES.find((entry) => entry.prefixes.some((prefix) => lowered.startsWith(prefix.toLowerCase()))) ?? null
}

/**
 * The section keys a pack document may carry beside its head.
 */
const HEAD_KEYS = frozen(['schema', 'id', 'disease', 'version', 'status', 'updated', 'sources', ...VCR_PACK_SECTIONS])
const DISEASE_KEYS = frozen(['key', 'name', 'nameZh', 'aliases', 'aliasesZh'])
const SOURCE_KEYS = frozen(['id', 'title', 'url', 'accessed', 'licence', 'publisher', 'version', 'processed', 'modified', 'note'])
const TERM_KEYS = frozen(['id', 'label', 'labelZh', 'kind', 'definition', 'concept', 'codes', 'synonyms', 'sources'])
const PHENOTYPE_KEYS = frozen(['id', 'label', 'labelZh', 'type', 'rule', 'text', 'textZh', 'terms', 'sources'])
const ENDPOINT_KEYS = frozen(['id', 'label', 'labelZh', 'type', 'definition', 'definitionZh', 'assessment', 'standard', 'setting', 'terms', 'sources'])
const CRITERION_KEYS = frozen(['id', 'kind', 'criterionType', 'requirement', 'applicability', 'text', 'textZh', 'terms', 'sources'])
const MAPPING_KEYS = frozen(['id', 'concept', 'label', 'labelZh', 'type', 'role', 'unit', 'fieldNames', 'codes', 'sources'])
const BACKGROUND_KEYS = frozen(['id', 'text', 'textZh', 'sources'])
const CODE_KEYS = frozen(['system', 'code', 'display'])
const STANDARD_KEYS = frozen(['name', 'version', 'url'])
const MAPPING_CODE_KEYS = frozen(['means', 'accepts'])

/**
 * Validate a knowledge pack. Returns every defect found (bounded by the pack's
 * own size limits), each with the path it lives at.
 *
 * @param {unknown} pack
 * @param {{ level?: 'draft' | 'complete' }} [options] `complete` is what a shipped pack meets
 * @returns {readonly VcrPackIssue[]}
 */
export function validateKnowledgePack(pack, { level = 'draft' } = {}) {
  /** @type {VcrPackIssue[]} */
  const issues = []
  /** @param {string} code @param {string} field @param {string} detail */
  const raise = (code, field, detail) => { issues.push({ code, field, detail }) }
  const complete = level === 'complete'
  const limits = VCR_PACK_LIMITS

  if (!isObject(pack)) {
    return frozen([{ code: 'pack_shape_invalid', field: '', detail: 'A knowledge pack is an object.' }])
  }
  for (const key of Object.keys(pack)) {
    if (!HEAD_KEYS.includes(key)) raise('pack_shape_invalid', key, `A pack does not take ${JSON.stringify(key)}.`)
  }
  if (pack.schema !== undefined && pack.schema !== VCR_PACK_SCHEMA) {
    raise('pack_shape_invalid', 'schema', `schema is ${VCR_PACK_SCHEMA}.`)
  }
  if (typeof pack.id !== 'string' || !ID.test(pack.id)) raise('pack_shape_invalid', 'id', 'id is a lowercase name of letters, digits and "_".')
  if (pack.status !== undefined && !VCR_PACK_STATUSES.includes(pack.status)) {
    raise('pack_shape_invalid', 'status', `status is one of ${VCR_PACK_STATUSES.join(', ')}.`)
  }
  if (pack.version !== undefined && !(Number.isInteger(pack.version) && pack.version >= 1)) {
    raise('pack_shape_invalid', 'version', 'version is a positive whole number.')
  }
  if (pack.updated !== undefined && !isDate(pack.updated)) raise('pack_shape_invalid', 'updated', 'updated is an ISO date (YYYY-MM-DD).')

  // --- the disease ---------------------------------------------------------------
  const disease = pack.disease
  if (!isObject(disease)) {
    raise('pack_shape_invalid', 'disease', 'disease is { key, name, nameZh?, aliases? }.')
  } else {
    for (const key of Object.keys(disease)) {
      if (!DISEASE_KEYS.includes(key)) raise('pack_shape_invalid', at('disease', key), `disease does not take ${JSON.stringify(key)}.`)
    }
    if (typeof disease.key !== 'string' || !ID.test(disease.key)) raise('pack_shape_invalid', 'disease.key', 'disease.key is a lowercase name of letters, digits and "_".')
    if (!isText(disease.name, limits.label) && !isText(disease.nameZh, limits.label)) {
      raise('pack_label_missing', 'disease.name', 'The disease is named (name or nameZh).')
    }
    if (complete && !(isText(disease.name, limits.label) && isText(disease.nameZh, limits.label))) {
      raise('pack_label_missing', 'disease.nameZh', 'A complete pack names its disease in both languages.')
    }
    for (const key of ['aliases', 'aliasesZh']) {
      const list = disease[key]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.length > limits.aliases || !list.every((item) => isText(item, limits.label))) {
        raise('pack_shape_invalid', at('disease', key), `${key} is a list of at most ${limits.aliases} short names.`)
      }
    }
  }

  // --- the sources ---------------------------------------------------------------
  /** @type {Map<string, Record<string, any>>} */
  const sources = new Map()
  if (!Array.isArray(pack.sources) || pack.sources.length < 1 || pack.sources.length > limits.sources) {
    raise('pack_source_missing', 'sources', `A pack lists the sources it rests on (1 to ${limits.sources}).`)
  } else {
    pack.sources.forEach((/** @type {unknown} */ source, /** @type {number} */ i) => {
      const where = `sources[${i}]`
      if (!isObject(source)) { raise('pack_shape_invalid', where, 'A source is an object.'); return }
      for (const key of Object.keys(source)) {
        if (!SOURCE_KEYS.includes(key)) raise('pack_shape_invalid', at(where, key), `A source does not take ${JSON.stringify(key)}.`)
      }
      if (typeof source.id !== 'string' || !ID.test(source.id)) raise('pack_shape_invalid', at(where, 'id'), 'A source id is a lowercase name of letters, digits and "_".')
      else if (sources.has(source.id)) raise('pack_id_duplicate', at(where, 'id'), `Source id ${source.id} is used twice.`)
      else sources.set(source.id, source)
      if (!isText(source.title, limits.label)) raise('pack_source_incomplete', at(where, 'title'), 'A source has a title.')
      if (!isText(source.url, limits.url) || !URL_HTTP.test(source.url)) raise('pack_source_incomplete', at(where, 'url'), 'A source has an http(s) URL.')
      else {
        const restricted = vcrPackRestrictedSource(source.url)
        if (restricted) raise('pack_source_restricted', at(where, 'url'), `${restricted.why}; the pack does not copy or cite it as a source.`)
      }
      if (!isDate(source.accessed)) raise('pack_source_incomplete', at(where, 'accessed'), 'A source says when it was read (accessed, YYYY-MM-DD).')
      const licence = typeof source.licence === 'string' ? /** @type {Record<string, any> | undefined} */ (VCR_PACK_LICENCES[/** @type {keyof typeof VCR_PACK_LICENCES} */ (source.licence)]) : undefined
      if (!licence) {
        raise('pack_source_licence_unknown', at(where, 'licence'), `licence is one of ${Object.keys(VCR_PACK_LICENCES).join(', ')}.`)
      } else {
        if (licence.obligations.includes('processed') && !isDate(source.processed)) {
          raise('pack_source_incomplete', at(where, 'processed'), 'A ClinicalTrials.gov source states the date its data were processed (processed, YYYY-MM-DD).')
        }
        if (licence.obligations.includes('modified') && source.modified !== true) {
          raise('pack_source_incomplete', at(where, 'modified'), 'A ClinicalTrials.gov source states that its content was modified here (modified: true).')
        }
      }
      for (const key of ['publisher', 'version', 'note']) {
        if (source[key] !== undefined && !isText(source[key], limits.text)) raise('pack_shape_invalid', at(where, key), `${key} is a short text.`)
      }
    })
  }

  // --- entries -------------------------------------------------------------------
  /** @type {Map<string, string>} id → section, for references across sections */
  const entryIds = new Map()
  /** @type {Set<string>} */
  const mappedConcepts = new Set()
  /** @type {Array<{ where: string, node: any }>} */
  const rules = []

  /**
   * The common checks of an entry: shape, id, label, sources. Returns the
   * resolved source objects, or an empty list when the entry cannot be read.
   * @param {string} section @param {unknown} entry @param {number} i @param {readonly string[]} keys
   */
  const readEntry = (section, entry, i, keys) => {
    const where = `${section}[${i}]`
    if (!isObject(entry)) { raise('pack_shape_invalid', where, 'An entry is an object.'); return null }
    for (const key of Object.keys(entry)) {
      if (!keys.includes(key)) raise('pack_shape_invalid', at(where, key), `A ${section} entry does not take ${JSON.stringify(key)}.`)
    }
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) raise('pack_shape_invalid', at(where, 'id'), 'An entry id is a lowercase name of letters, digits and "_".')
    else if (entryIds.has(entry.id)) raise('pack_id_duplicate', at(where, 'id'), `Entry id ${entry.id} is used twice (${entryIds.get(entry.id)}).`)
    else entryIds.set(entry.id, section)
    const cited = entry.sources
    /** @type {Array<Record<string, any>>} */
    const resolved = []
    if (!Array.isArray(cited) || cited.length < 1 || cited.length > limits.entrySources) {
      raise('pack_entry_source_missing', at(where, 'sources'), `Every entry cites 1 to ${limits.entrySources} of the pack's sources.`)
    } else {
      cited.forEach((/** @type {unknown} */ id, /** @type {number} */ k) => {
        const source = typeof id === 'string' ? sources.get(id) : undefined
        if (!source) raise('pack_entry_source_unknown', `${at(where, 'sources')}[${k}]`, `${JSON.stringify(id)} is not one of the pack's sources.`)
        else resolved.push(source)
      })
    }
    return { where, entry, resolved }
  }

  /**
   * A label in each language: at least one on a draft, both on a complete pack.
   * @param {string} where @param {Record<string, any>} entry @param {string} base @param {string} zh @param {number} max
   */
  const labelled = (where, entry, base, zh, max) => {
    const hasBase = isText(entry[base], max)
    const hasZh = isText(entry[zh], max)
    for (const key of [base, zh]) {
      if (entry[key] !== undefined && !isText(entry[key], max)) raise('pack_shape_invalid', at(where, key), `${key} is a text of at most ${max} characters.`)
    }
    if (!hasBase && !hasZh) raise('pack_label_missing', at(where, base), `The entry has ${base} or ${zh}.`)
    else if (complete && !(hasBase && hasZh)) raise('pack_label_missing', at(where, hasBase ? zh : base), `A complete pack carries ${base} and ${zh}.`)
  }

  /** @param {string} where @param {Record<string, any>} entry @param {string} key */
  const termRefs = (where, entry, key = 'terms') => {
    const list = entry[key]
    if (list === undefined) return
    if (!Array.isArray(list) || list.length > limits.codesPerTerm * 4 || !list.every((id) => typeof id === 'string')) {
      raise('pack_shape_invalid', at(where, key), `${key} is a list of term ids.`)
      return
    }
    termChecks.push({ where: at(where, key), ids: list })
  }
  /** @type {Array<{ where: string, ids: string[] }>} resolved after every section is read */
  const termChecks = []

  /** The entries of one section, or none when it is absent or not a list within its limit. @param {string} name */
  const section = (name) => {
    const list = pack[name]
    const max = /** @type {Record<string, number>} */ (limits)[name]
    if (list === undefined) return []
    if (!Array.isArray(list) || list.length > max) {
      raise('pack_shape_invalid', name, `${name} is a list of at most ${max} entries.`)
      return []
    }
    return list
  }

  // terms
  section('terms').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('terms', raw, i, TERM_KEYS)
    if (!read) return
    const { where, entry, resolved } = read
    labelled(where, entry, 'label', 'labelZh', limits.label)
    if (entry.kind !== undefined && !VCR_PACK_TERM_KINDS.includes(entry.kind)) {
      raise('pack_shape_invalid', at(where, 'kind'), `kind is one of ${VCR_PACK_TERM_KINDS.join(', ')}.`)
    }
    if (entry.definition !== undefined) {
      if (!isText(entry.definition, limits.definition)) raise('pack_shape_invalid', at(where, 'definition'), `definition is a text of at most ${limits.definition} characters.`)
      else if (!resolved.some((source) => /** @type {Record<string, any>} */ (VCR_PACK_LICENCES)[source.licence]?.use === 'attribution')) {
        raise('pack_text_not_reusable', at(where, 'definition'), 'A verbatim definition needs a source whose licence allows reuse with attribution; a link-only source is restated in own words (a label, or a phenotype).')
      }
    }
    if (entry.concept !== undefined && !(typeof entry.concept === 'string' && ID.test(entry.concept))) {
      raise('pack_shape_invalid', at(where, 'concept'), 'concept is the variable name the term stands for (lowercase letters, digits and "_").')
    }
    if (entry.synonyms !== undefined && (!Array.isArray(entry.synonyms) || entry.synonyms.length > limits.aliases || !entry.synonyms.every((/** @type {unknown} */ item) => isText(item, limits.label)))) {
      raise('pack_shape_invalid', at(where, 'synonyms'), `synonyms is a list of at most ${limits.aliases} short names.`)
    }
    if (entry.codes !== undefined) {
      if (!Array.isArray(entry.codes) || entry.codes.length > limits.codesPerTerm) {
        raise('pack_shape_invalid', at(where, 'codes'), `codes is a list of at most ${limits.codesPerTerm} identifiers.`)
      } else {
        entry.codes.forEach((/** @type {unknown} */ code, /** @type {number} */ k) => {
          const place = `${at(where, 'codes')}[${k}]`
          if (!isObject(code)) { raise('pack_shape_invalid', place, 'A code is { system, code, display? }.'); return }
          for (const key of Object.keys(code)) {
            if (!CODE_KEYS.includes(key)) raise('pack_shape_invalid', at(place, key), `A code does not take ${JSON.stringify(key)}.`)
          }
          const system = typeof code.system === 'string' ? code.system : ''
          if (VCR_PACK_REFUSED_CODE_SYSTEMS.some((refused) => refused.toLowerCase() === system.toLowerCase())) {
            raise('pack_code_system_restricted', at(place, 'system'), `${system} is licensed or restricted and is never imported; leave the term unmapped.`)
            return
          }
          const known = /** @type {Record<string, any> | undefined} */ (VCR_PACK_CODE_SYSTEMS[/** @type {keyof typeof VCR_PACK_CODE_SYSTEMS} */ (system)])
          if (!known) {
            raise('pack_code_system_unknown', at(place, 'system'), `system is one of ${Object.keys(VCR_PACK_CODE_SYSTEMS).join(', ')}; leave the term unmapped otherwise.`)
            return
          }
          if (typeof code.code !== 'string' || !new RegExp(known.pattern).test(code.code)) {
            raise('pack_code_invalid', at(place, 'code'), `A ${system} code looks like ${known.pattern}.`)
          }
          if (code.display !== undefined && !isText(code.display, limits.label)) raise('pack_shape_invalid', at(place, 'display'), 'display is a short text.')
          // The identifier is accepted beside a source that publishes it.
          if (!resolved.some((source) => typeof source.url === 'string' && known.publishers.some((/** @type {string} */ prefix) => source.url.startsWith(prefix)))) {
            raise('pack_code_unpublished', at(place, 'system'), `A ${system} code is cited with a source that publishes ${system} (${known.publishers[0]}…).`)
          }
        })
      }
    }
  })

  // phenotypes
  section('phenotypes').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('phenotypes', raw, i, PHENOTYPE_KEYS)
    if (!read) return
    const { where, entry } = read
    labelled(where, entry, 'label', 'labelZh', limits.label)
    if (entry.type !== undefined && !VCR_CRITERION_TYPES.includes(entry.type)) {
      raise('pack_shape_invalid', at(where, 'type'), `type is one of ${VCR_CRITERION_TYPES.join(', ')}.`)
    }
    labelled(where, entry, 'text', 'textZh', limits.text)
    if (entry.rule === undefined) raise('pack_rule_missing', at(where, 'rule'), 'A phenotype carries its rule in the requirement grammar.')
    else rules.push({ where: at(where, 'rule'), node: entry.rule })
    termRefs(where, entry)
  })

  // endpoints
  section('endpoints').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('endpoints', raw, i, ENDPOINT_KEYS)
    if (!read) return
    const { where, entry } = read
    labelled(where, entry, 'label', 'labelZh', limits.label)
    if (!VCR_ENDPOINT_TYPES.includes(entry.type)) raise('pack_shape_invalid', at(where, 'type'), `type is one of ${VCR_ENDPOINT_TYPES.join(', ')}.`)
    labelled(where, entry, 'definition', 'definitionZh', limits.text)
    if (entry.assessment !== undefined && !isText(entry.assessment, limits.text)) raise('pack_shape_invalid', at(where, 'assessment'), 'assessment is a short text.')
    if (entry.setting !== undefined && !isText(entry.setting, limits.short)) raise('pack_shape_invalid', at(where, 'setting'), 'setting is a short text.')
    const standard = entry.standard
    if (!isObject(standard)) {
      raise('pack_standard_missing', at(where, 'standard'), 'An endpoint names the standard it is assessed by: { name, version?, url? }.')
    } else {
      for (const key of Object.keys(standard)) {
        if (!STANDARD_KEYS.includes(key)) raise('pack_shape_invalid', at(at(where, 'standard'), key), `standard does not take ${JSON.stringify(key)}.`)
      }
      if (!isText(standard.name, limits.label)) raise('pack_standard_missing', at(at(where, 'standard'), 'name'), 'The standard has a name (「RECIST 1.1」).')
      if (standard.version !== undefined && !isText(standard.version, limits.short)) raise('pack_shape_invalid', at(at(where, 'standard'), 'version'), 'version is a short text.')
      if (standard.url !== undefined && !(isText(standard.url, limits.url) && URL_HTTP.test(standard.url))) raise('pack_shape_invalid', at(at(where, 'standard'), 'url'), 'url is an http(s) link.')
    }
    termRefs(where, entry)
  })

  // criteria
  section('criteria').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('criteria', raw, i, CRITERION_KEYS)
    if (!read) return
    const { where, entry } = read
    if (entry.kind !== 'inclusion' && entry.kind !== 'exclusion') raise('pack_shape_invalid', at(where, 'kind'), 'kind is inclusion or exclusion.')
    if (!VCR_CRITERION_TYPES.includes(entry.criterionType)) raise('pack_shape_invalid', at(where, 'criterionType'), `criterionType is one of ${VCR_CRITERION_TYPES.join(', ')}.`)
    labelled(where, entry, 'text', 'textZh', limits.text)
    if (entry.requirement === undefined) raise('pack_rule_missing', at(where, 'requirement'), 'A criterion carries its requirement in the requirement grammar.')
    else rules.push({ where: at(where, 'requirement'), node: entry.requirement })
    if (entry.applicability !== undefined) rules.push({ where: at(where, 'applicability'), node: entry.applicability })
    termRefs(where, entry)
  })

  // mappings
  section('mappings').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('mappings', raw, i, MAPPING_KEYS)
    if (!read) return
    const { where, entry } = read
    if (typeof entry.concept !== 'string' || !ID.test(entry.concept)) raise('pack_shape_invalid', at(where, 'concept'), 'concept is the variable name a rule uses (lowercase letters, digits and "_").')
    else if (mappedConcepts.has(entry.concept)) raise('pack_id_duplicate', at(where, 'concept'), `Concept ${entry.concept} is mapped twice.`)
    else mappedConcepts.add(entry.concept)
    labelled(where, entry, 'label', 'labelZh', limits.label)
    if (!VCR_PACK_MAPPING_TYPES.includes(entry.type)) raise('pack_shape_invalid', at(where, 'type'), `type is one of ${VCR_PACK_MAPPING_TYPES.join(', ')}.`)
    if (entry.role !== undefined && !VCR_FIELD_ROLES.includes(entry.role)) raise('pack_shape_invalid', at(where, 'role'), `role is one of ${VCR_FIELD_ROLES.join(', ')}.`)
    if (entry.unit !== undefined && !isText(entry.unit, 32)) raise('pack_shape_invalid', at(where, 'unit'), 'unit is a short text.')
    if (!Array.isArray(entry.fieldNames) || entry.fieldNames.length < 1 || entry.fieldNames.length > limits.fieldNames
      || !entry.fieldNames.every((/** @type {unknown} */ name) => isText(name, 128))) {
      raise('pack_shape_invalid', at(where, 'fieldNames'), `fieldNames is a list of 1 to ${limits.fieldNames} column names a dataset commonly uses for the concept.`)
    }
    if (entry.codes !== undefined) {
      const ok = Array.isArray(entry.codes) && entry.codes.length <= 20 && entry.codes.every((/** @type {unknown} */ code) => isObject(code)
        && Object.keys(code).every((key) => MAPPING_CODE_KEYS.includes(key)) && isText(code.means, limits.short)
        && Array.isArray(code.accepts) && code.accepts.length >= 1 && code.accepts.length <= 20 && code.accepts.every((/** @type {unknown} */ word) => isText(word, 64)))
      if (!ok) raise('pack_shape_invalid', at(where, 'codes'), 'codes is a list of { means, accepts: [words a dataset writes for it] }.')
    }
  })

  // background
  section('background').forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const read = readEntry('background', raw, i, BACKGROUND_KEYS)
    if (!read) return
    labelled(read.where, read.entry, 'text', 'textZh', limits.text)
  })

  // --- what refers to what ----------------------------------------------------------
  for (const { where, ids } of termChecks) {
    ids.forEach((id, k) => {
      if (entryIds.get(id) !== 'terms') raise('pack_term_unknown', `${where}[${k}]`, `${JSON.stringify(id)} is not one of the pack's terms.`)
    })
  }
  for (const { where, node } of rules) {
    for (const problem of validateRequirement(node, { path: where })) raise('pack_rule_malformed', problem.field || where, problem.detail)
    if (complete) {
      for (const variable of vcrRequirementVariables(node)) {
        if (!mappedConcepts.has(variable)) {
          raise('pack_variable_unmapped', where, `The rule names ${JSON.stringify(variable)}, which no mapping realises; a complete pack maps every variable it uses.`)
        }
      }
    }
  }
  if (complete) {
    for (const key of ['terms', 'endpoints', 'criteria', 'mappings']) {
      if (!Array.isArray(pack[key]) || pack[key].length < 1) raise('pack_section_empty', key, `A complete pack has ${key}.`)
    }
    if (pack.status !== undefined && pack.status !== 'curated') raise('pack_shape_invalid', 'status', 'A shipped pack is curated.')
  }
  return frozen(issues)
}

/**
 * The variable names a requirement tree mentions, in order of first use.
 * Walks only what `validateRequirement` has accepted: an unreadable node
 * contributes nothing.
 * @param {unknown} node @param {Set<string>} [found]
 * @returns {string[]}
 */
export function vcrRequirementVariables(node, found = new Set()) {
  if (!isObject(node)) return [...found]
  if (typeof node.variable === 'string') found.add(node.variable)
  if (Array.isArray(node.operands)) for (const child of node.operands) vcrRequirementVariables(child, found)
  if (node.operand !== undefined) vcrRequirementVariables(node.operand, found)
  return [...found]
}

/**
 * The sources an entry rests on, resolved from the pack's table: each with its
 * licence's name and kind of use, which is what a page shows beside the entry.
 * @param {Record<string, any>} pack @param {Record<string, any>} entry
 */
export function vcrPackEntrySources(pack, entry) {
  const table = new Map((Array.isArray(pack?.sources) ? pack.sources : []).map((/** @type {Record<string, any>} */ source) => [source.id, source]))
  return (Array.isArray(entry?.sources) ? entry.sources : []).flatMap((/** @type {string} */ id) => {
    const source = /** @type {Record<string, any> | undefined} */ (table.get(id))
    if (!source) return []
    const licence = /** @type {Record<string, any> | undefined} */ (VCR_PACK_LICENCES[/** @type {keyof typeof VCR_PACK_LICENCES} */ (source.licence)])
    return [{
      id: String(source.id), title: String(source.title), url: String(source.url), accessed: String(source.accessed),
      licence: String(source.licence), licenceName: licence?.name ?? '', use: licence?.use ?? 'link-only',
      ...(source.processed ? { processed: String(source.processed) } : {}),
      ...(source.modified === true ? { modified: true } : {}),
      ...(source.version ? { version: String(source.version) } : {}),
    }]
  })
}

/**
 * What a page and a tool read of a pack without its sections' bodies: who it is
 * for, who stands behind it, how much it holds and what it rests on.
 * @param {Record<string, any>} pack
 */
export function vcrPackSummary(pack) {
  const count = (/** @type {string} */ key) => (Array.isArray(pack?.[key]) ? pack[key].length : 0)
  return {
    id: String(pack?.id ?? ''),
    disease: {
      key: String(pack?.disease?.key ?? ''), name: pack?.disease?.name ?? null, nameZh: pack?.disease?.nameZh ?? null,
      aliases: Array.isArray(pack?.disease?.aliases) ? pack.disease.aliases : [], aliasesZh: Array.isArray(pack?.disease?.aliasesZh) ? pack.disease.aliasesZh : [],
    },
    version: Number(pack?.version ?? 1),
    status: String(pack?.status ?? 'ai-draft'),
    updated: pack?.updated ?? null,
    counts: Object.fromEntries(VCR_PACK_SECTIONS.map((key) => [key, count(key)])),
    sources: Array.isArray(pack?.sources) ? pack.sources.map((/** @type {Record<string, any>} */ source) => ({
      id: String(source.id), title: String(source.title), url: String(source.url), licence: String(source.licence),
    })) : [],
  }
}

/**
 * Does a pack answer a search word? A case-folded containment test against the
 * disease's key, names and aliases — a closed list written in the pack. The
 * model decides which disease a study is about; this only finds the pack a name
 * was filed under, the way a catalogue search box does.
 * @param {Record<string, any>} pack @param {unknown} query
 */
export function vcrPackMatchesName(pack, query) {
  const wanted = String(query ?? '').trim().toLowerCase()
  if (!wanted) return true
  const names = [pack?.disease?.key, pack?.disease?.name, pack?.disease?.nameZh, ...(pack?.disease?.aliases ?? []), ...(pack?.disease?.aliasesZh ?? []), pack?.id]
  return names.some((name) => typeof name === 'string' && name.trim().toLowerCase().includes(wanted))
}

/**
 * Which dataset column realises each concept of a pack's mappings, from a
 * source's field map. A column realises a concept when the field map names the
 * concept (`concept` equal to the pack's) or the column's own name is one of
 * the mapping's `fieldNames` — whole-string, case-insensitive, nothing fuzzy.
 * Concepts the field map names that the pack does not know are listed apart,
 * so a reader sees both gaps. Pure: it reads two documents and returns a third.
 *
 * @param {Record<string, any>} pack
 * @param {ReadonlyArray<{ table?: string, column: string, concept?: string }>} fieldMap
 * @returns {{ realised: Array<{ concept: string, table: string, column: string, by: 'concept' | 'name' }>, missing: string[], unknown: string[] }}
 */
export function vcrPackConceptColumns(pack, fieldMap) {
  const mappings = Array.isArray(pack?.mappings) ? pack.mappings : []
  const entries = Array.isArray(fieldMap) ? fieldMap : []
  const norm = (/** @type {unknown} */ value) => String(value ?? '').trim().toLowerCase()
  /** @type {Array<{ concept: string, table: string, column: string, by: 'concept' | 'name' }>} */
  const realised = []
  /** @type {string[]} */
  const missing = []
  const known = new Set(mappings.map((/** @type {Record<string, any>} */ mapping) => String(mapping.concept)))
  for (const mapping of mappings) {
    const names = new Set((mapping.fieldNames ?? []).map(norm))
    const byConcept = entries.filter((entry) => norm(entry.concept) === norm(mapping.concept))
    const found = byConcept.length ? byConcept.map((entry) => ({ entry, by: /** @type {const} */ ('concept') }))
      : entries.filter((entry) => names.has(norm(entry.column))).map((entry) => ({ entry, by: /** @type {const} */ ('name') }))
    if (!found.length) missing.push(String(mapping.concept))
    for (const { entry, by } of found) realised.push({ concept: String(mapping.concept), table: String(entry.table ?? ''), column: String(entry.column), by })
  }
  const unknown = [...new Set(entries.map((entry) => String(entry.concept ?? '').trim()).filter((concept) => concept && !known.has(concept)))]
  return { realised, missing, unknown }
}

// ---------------------------------------------------------------------------
// Reusing a population definition on another dataset
// ---------------------------------------------------------------------------

/**
 * The column names a row rule reads, in order of first use. A rule is data: this
 * walks it, nothing is evaluated.
 * @param {unknown} rule @param {Set<string>} [found]
 * @returns {string[]}
 */
export function vcrRowRuleColumns(rule, found = new Set()) {
  if (!isObject(rule)) return [...found]
  if (typeof rule.column === 'string') found.add(rule.column)
  if (Array.isArray(rule.operands)) for (const child of rule.operands) vcrRowRuleColumns(child, found)
  if (rule.operand !== undefined) vcrRowRuleColumns(rule.operand, found)
  return [...found]
}

/**
 * A copy of a row rule with columns renamed by `columnMap` (`{ from: to }`); a
 * column the map does not name stays as it is. Pure: the input is not changed.
 * @param {any} rule @param {Readonly<Record<string, string>>} columnMap
 * @returns {any}
 */
export function vcrRemapRowRuleColumns(rule, columnMap) {
  if (!isObject(rule)) return rule
  /** @type {Record<string, any>} */
  const copy = { ...rule }
  if (typeof rule.column === 'string' && Object.hasOwn(columnMap, rule.column)) copy.column = columnMap[rule.column]
  if (Array.isArray(rule.operands)) copy.operands = rule.operands.map((/** @type {unknown} */ child) => vcrRemapRowRuleColumns(child, columnMap))
  if (rule.operand !== undefined) copy.operand = vcrRemapRowRuleColumns(rule.operand, columnMap)
  return copy
}

/**
 * For the columns a definition's rules read and a target dataset lacks, the one
 * column of the target that realises the same concept of the pack's mappings —
 * only when it is unambiguous. A column realises a concept when its name (or the
 * concept's own name) is one of the mapping's `fieldNames`, whole-string and
 * case-insensitive. Several candidates, or none, leave the column in `unmatched`
 * for a person to name: a guess here would silently change who is in a cohort.
 *
 * @param {Record<string, any> | null} pack the study's pack, when it has one
 * @param {readonly string[]} columns the columns the rules read
 * @param {readonly string[]} header the columns the target dataset has
 * @returns {{ suggested: Array<{ from: string, to: string, concept: string }>, unmatched: string[] }}
 */
export function vcrSuggestColumnRemap(pack, columns, header) {
  const norm = (/** @type {unknown} */ value) => String(value ?? '').trim().toLowerCase()
  const have = new Set(header)
  const mappings = Array.isArray(pack?.mappings) ? pack.mappings : []
  /** @type {Array<{ from: string, to: string, concept: string }>} */
  const suggested = []
  /** @type {string[]} */
  const unmatched = []
  for (const column of columns) {
    if (have.has(column)) continue
    const mapping = mappings.find((/** @type {Record<string, any>} */ entry) => norm(entry.concept) === norm(column)
      || (entry.fieldNames ?? []).some((/** @type {unknown} */ name) => norm(name) === norm(column)))
    const candidates = mapping
      ? header.filter((name) => norm(name) === norm(mapping.concept) || (mapping.fieldNames ?? []).some((/** @type {unknown} */ alias) => norm(alias) === norm(name)))
      : []
    if (mapping && candidates.length === 1) suggested.push({ from: column, to: candidates[0], concept: String(mapping.concept) })
    else unmatched.push(column)
  }
  return { suggested, unmatched }
}
