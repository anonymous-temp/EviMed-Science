/**
 * The pharmacist-owned safety rules, as data.
 *
 * Hidden knowledge: which of these rules are code and which are data. A rule
 * that names a medicine, a scenario or a phrase is data and lives in
 * `clinical-safety-rules.json`, so a pharmacist can add one without touching
 * server code; a rule that is generic (a `derived` claim may never carry
 * practical safety advice) is logic and lives in `clinicalEvidence.mjs`.
 *
 * `routingEntities` used to steer a router. There is no router any more
 * (§9.1) — the same list now works as a content trigger: seeing one of these
 * names in a deliverable or a direct reply means the clinical safety rules
 * apply to it, whatever the plan said the deliverable was.
 */

import clinicalSafetyRulesData from './clinical-safety-rules.json' with { type: 'json' }

/** The raw rules document. Readers must not mutate it. */
export const clinicalSafetyRules = Object.freeze(clinicalSafetyRulesData)

/**
 * Entities whose presence in any produced text pulls the clinical safety rules
 * in. Sorted longest-first so the regexp prefers the most specific name.
 */
export const CLINICAL_CONTENT_TRIGGER_ENTITIES = Object.freeze(
  (Array.isArray(clinicalSafetyRulesData?.routingEntities) ? clinicalSafetyRulesData.routingEntities : [])
    .filter((entity) => typeof entity === 'string' && entity.trim())
    .map((entity) => entity.trim())
    .sort((left, right) => right.length - left.length),
)

/**
 * The pharmacist-maintained closed vocabulary of high-alert medicines.
 *
 * Separate from `CLINICAL_CONTENT_TRIGGER_ENTITIES` on purpose, and the
 * separation is the whole design. A trigger entity *blocks*: naming one in a
 * non-clinical deliverable is a required issue here, and `packages/socket`'s
 * completion check raises the same code, at required severity, over every file
 * in the workspace. That is right for the two names on that list, which the
 * rules file actually has rules about. It would be wrong for a hundred more:
 * a bibliometric study of metformin literature is legitimately about metformin,
 * and a peer review of a warfarin trial is legitimately about warfarin.
 *
 * So the wide list is a notice. It measures how often a non-clinical
 * deliverable talks about a high-alert medicine, which is the distribution
 * development principle 4 asks for before anything is promoted to blocking —
 * and promotion is one line of data, moving a name up into `routingEntities`.
 *
 * Sorted longest-first for the same reason as the trigger list: prefer the most
 * specific name.
 */
export const CLINICAL_HIGH_RISK_ENTITIES = Object.freeze(
  (Array.isArray(clinicalSafetyRulesData?.highRiskEntities) ? clinicalSafetyRulesData.highRiskEntities : [])
    .filter((entity) => typeof entity === 'string' && entity.trim())
    .map((entity) => entity.trim())
    .sort((left, right) => right.length - left.length),
)

/**
 * Whole terms in which a high-alert medicine's name names physiology — 胰岛素抵抗,
 * dopamine receptor — blanked before the medicines are looked for
 * (`highRiskEntityPhysiologyTerms`). Longest first, so the most specific term
 * is the one blanked.
 */
const CLINICAL_HIGH_RISK_PHYSIOLOGY_TERMS = Object.freeze(
  (Array.isArray(clinicalSafetyRulesData?.highRiskEntityPhysiologyTerms) ? clinicalSafetyRulesData.highRiskEntityPhysiologyTerms : [])
    .filter((term) => typeof term === 'string' && term.trim())
    .map((term) => term.trim())
    .sort((left, right) => right.length - left.length),
)

/** @param {string} value @returns {string} */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A fresh matcher over the trigger entities, or null when the rules file lists
 * none. Fresh because a shared `RegExp` with the `g` flag carries `lastIndex`
 * between calls — a stateful global disguised as a constant.
 * @returns {RegExp | null}
 */
export function clinicalContentTriggerPattern() {
  if (!CLINICAL_CONTENT_TRIGGER_ENTITIES.length) return null
  return new RegExp(`(?:${CLINICAL_CONTENT_TRIGGER_ENTITIES.map(escapeRegExp).join('|')})`, 'i')
}

/**
 * Which trigger entities a text mentions. Used by `evimed_complete_run` to
 * decide whether the clinical contract applies to a deliverable that never
 * declared it, and by the server-side gate to scan a direct reply (§9.4).
 * @param {string} text
 * @returns {string[]}
 */
export function matchedClinicalTriggers(text) {
  const value = String(text ?? '')
  if (!value) return []
  return CLINICAL_CONTENT_TRIGGER_ENTITIES.filter((entity) => value.includes(entity))
}

/** Latin-script names are matched at word boundaries; CJK names have none. */
const ASCII_ENTITY = /^[\x20-\x7e]+$/

/**
 * Which high-alert medicines a text names, excluding the ones already reported
 * by `matchedClinicalTriggers` so one mention is never two findings.
 *
 * Word-bounded for Latin-script names — hyphen included in the boundary,
 * because `includes('Insulin')` also matches "insulin-like growth factor" and a
 * notice nobody believes is a notice nobody reads. Chinese names have no word boundary to anchor to and are
 * matched as substrings, which is how the trigger list has always worked.
 * Case-insensitive for Latin script only: 速效救心丸 has no case.
 *
 * This is a closed vocabulary of proper nouns, not a pattern over prose
 * (development principle 5): every name is enumerated in
 * `clinical-safety-rules.json` and a pharmacist adds one by adding a name.
 * @param {string} text
 * @returns {string[]}
 */
export function matchedHighRiskEntities(text) {
  const raw = String(text ?? '')
  if (!raw) return []
  const alreadyTriggered = new Set(matchedClinicalTriggers(raw))
  // A name inside a physiology term is not the medicine: blanked, each term
  // compared whole (case-insensitively for Latin script), never as a pattern.
  let value = raw
  for (const term of CLINICAL_HIGH_RISK_PHYSIOLOGY_TERMS) {
    value = value.replace(new RegExp(escapeRegExp(term), ASCII_ENTITY.test(term) ? 'gi' : 'g'), ' ')
  }
  const lower = value.toLowerCase()
  return CLINICAL_HIGH_RISK_ENTITIES.filter((entity) => {
    if (alreadyTriggered.has(entity)) return false
    if (!ASCII_ENTITY.test(entity)) return value.includes(entity)
    return new RegExp(`(?<![a-z0-9-])${escapeRegExp(entity.toLowerCase())}(?![a-z0-9-])`).test(lower)
  })
}

/**
 * Toxic Chinese materia medica: `tcmToxicHerbs` in clinical-safety-rules.json.
 *
 * Hidden knowledge: the high-alert list above is western medicines, so a TCM
 * clinician's lasting preference for 附子 at 60 g — or a shared capsule whose
 * method says so — met no checkpoint anywhere (2026-09-26 audit, M-13; the
 * CDSS's item 8). Each row is one herb with every name it is written under
 * and the source of its toxicity and dose; nothing here is a pattern over
 * prose (principle 5). Two decidable questions are asked of a text:
 *
 * - which of these herbs it names — longest name first, each found name
 *   blanked before shorter ones are looked for, so 白附子 is never 附子 and
 *   制川乌 is one mention of 川乌, not two;
 * - which stated doses exceed the row's `doseRangeG` — a format check like a
 *   DOI: a name, at most six characters that are neither digits nor clause
 *   separators, then a number (or a range, read at its top) and a gram or
 *   milligram unit.
 *
 * @typedef {{ id: string, nameZh: string, names: readonly string[], toxicity: string,
 *   doseRangeG: readonly [number, number] | null, doseNote: string, evidence: readonly CautionEvidence[] }} TcmToxicHerb
 */

/**
 * Compiles and checks the herb rows; a malformed row stops the process at load,
 * as a malformed caution does. Exported so the refusal is testable.
 * @param {unknown} data the rules document
 * @returns {readonly TcmToxicHerb[]}
 */
export function compileTcmToxicHerbs(data) {
  const rows = Array.isArray(/** @type {any} */ (data)?.tcmToxicHerbs) ? /** @type {any} */ (data).tcmToxicHerbs : []
  const ids = new Set()
  const names = new Set()
  return Object.freeze(rows.map((/** @type {any} */ row, /** @type {number} */ index) => {
    const where = `tcmToxicHerbs[${index}]${row?.id ? ` (${row.id})` : ''}`
    for (const field of ['id', 'nameZh', 'toxicity']) {
      if (typeof row?.[field] !== 'string' || !row[field].trim()) throw new Error(`clinical-safety-rules.json: ${where} is missing ${field}.`)
    }
    if (ids.has(row.id)) throw new Error(`clinical-safety-rules.json: ${where} repeats an id.`)
    ids.add(row.id)
    if (!Array.isArray(row.names) || row.names.length === 0 || row.names.some((/** @type {unknown} */ name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`clinical-safety-rules.json: ${where}.names must list the herb's names.`)
    }
    for (const name of row.names) {
      // One name, one herb: a name two rows share would make a mention of it
      // two findings, or the wrong one.
      if (names.has(name)) throw new Error(`clinical-safety-rules.json: ${where} repeats the name ${name}, which another row already holds.`)
      names.add(name)
    }
    const range = row.doseRangeG
    if (range !== undefined && !(Array.isArray(range) && range.length === 2
      && range.every((/** @type {unknown} */ value) => typeof value === 'number' && value > 0) && range[0] <= range[1])) {
      throw new Error(`clinical-safety-rules.json: ${where}.doseRangeG must be [lowest, highest] grams.`)
    }
    const evidence = Array.isArray(row.evidence) ? row.evidence : []
    if (evidence.length === 0 || evidence.some((/** @type {any} */ entry) => typeof entry?.authority !== 'string' || !/^https:\/\/\S+$/.test(String(entry?.url ?? '')))) {
      throw new Error(`clinical-safety-rules.json: ${where} needs evidence entries with an authority and an https url.`)
    }
    return Object.freeze({
      id: row.id, nameZh: row.nameZh.trim(), names: Object.freeze(row.names.map((/** @type {string} */ name) => name.trim())),
      toxicity: row.toxicity, doseRangeG: range ? Object.freeze([range[0], range[1]]) : null,
      doseNote: typeof row.doseNote === 'string' ? row.doseNote : '',
      evidence: Object.freeze(evidence.map((/** @type {any} */ entry) => Object.freeze({ ...entry }))),
    })
  }))
}

/** The build's own herb rows, compiled once. */
export const TCM_TOXIC_HERBS = compileTcmToxicHerbs(clinicalSafetyRulesData)

/** Every herb name with its row, longest first. */
const TCM_HERB_NAMES = Object.freeze(TCM_TOXIC_HERBS
  .flatMap((row) => row.names.map((name) => ({ row, name })))
  .sort((left, right) => right.name.length - left.name.length))

/** Grams per unit a stated dose may be written in. */
const DOSE_UNITS = Object.freeze({ g: 1, '克': 1, mg: 0.001, '毫克': 0.001 })

/** @param {string} text @param {string} name */
function blankName(text, name) {
  return text.split(name).join(' '.repeat(name.length))
}

/**
 * The toxic herbs a text names, by their row's name, in the file's order.
 * @param {string} text
 * @returns {string[]}
 */
export function matchedTcmToxicHerbs(text) {
  let value = String(text ?? '')
  if (!value.trim()) return []
  /** @type {Set<string>} */
  const found = new Set()
  for (const { row, name } of TCM_HERB_NAMES) {
    if (!value.includes(name)) continue
    found.add(row.id)
    value = blankName(value, name)
  }
  return TCM_TOXIC_HERBS.filter((row) => found.has(row.id)).map((row) => row.nameZh)
}

/**
 * The stated doses of a toxic herb above its source's upper bound.
 * @param {string} text
 * @returns {{ herb: string, statedG: number, maxG: number, text: string }[]}
 */
export function tcmDoseFindings(text) {
  let value = String(text ?? '')
  if (!value.trim()) return []
  const findings = []
  for (const { row, name } of TCM_HERB_NAMES) {
    if (!value.includes(name)) continue
    if (row.doseRangeG) {
      const pattern = new RegExp(`${escapeRegExp(name)}[^\\d，、；。;,\\n]{0,6}?(\\d+(?:\\.\\d+)?)(?:\\s*[～~\\-－—至到]\\s*(\\d+(?:\\.\\d+)?))?\\s*(mg|毫克|g|克)(?![a-z])`, 'gi')
      for (const match of value.matchAll(pattern)) {
        const grams = Number(match[2] ?? match[1]) * DOSE_UNITS[/** @type {keyof typeof DOSE_UNITS} */ (match[3].toLowerCase())]
        const maxG = row.doseRangeG[1]
        if (Number.isFinite(grams) && grams > maxG + 1e-9) {
          findings.push({ herb: row.nameZh, statedG: Math.round(grams * 1000) / 1000, maxG, text: match[0] })
        }
      }
    }
    value = blankName(value, name)
  }
  return findings
}

/**
 * What a text says that the clinical-safety checkpoint is about: the medicines
 * it names — a trigger or high-alert medicine, or a toxic herb — and any toxic
 * herb dose above its source's bound. The one reading memory extraction and
 * the capsule import scan share, so a name is a checkpoint in both or in
 * neither.
 * @param {string} text
 * @returns {{ medicines: string[], overDose: { herb: string, statedG: number, maxG: number, text: string }[] }}
 */
export function medicationSafetyIn(text) {
  const value = String(text ?? '')
  return {
    medicines: [...new Set([...matchedClinicalTriggers(value), ...matchedHighRiskEntities(value), ...matchedTcmToxicHerbs(value)])],
    overDose: tcmDoseFindings(value),
  }
}

/**
 * Pharmacist-authored cautions: `cautionRules` in clinical-safety-rules.json.
 *
 * Hidden knowledge: a caution is the opposite of the four `rules` above it.
 * Those say what a report must not claim, as patterns over prose, and are
 * required inside the run. A caution says what a reader must be able to see
 * when a report discusses a well-established high-risk scenario — aspirin for
 * primary prevention without its bleeding risk, a teratogen in pregnancy
 * without 致畸 — and everything in it is a closed vocabulary: a medicine's
 * names (generic and brand, Chinese and English), a scenario's names, the
 * caution's own technical words. No pattern over prose (principle 5), and
 * nothing blocks (owner decision 5, 2026-09-18): a caution is advice to the
 * run and a SAFETY notice to the reader, never a reason to withhold a delivery.
 *
 * "The report mentions the caution" is decided by whether one of the caution's
 * own terms appears anywhere in the report. That proxy is lenient on purpose:
 * a report that says 出血 once is taken to have said it, so a notice fires only
 * on a report that never uses the word — the case worth a pharmacist's notice,
 * and the one with no false positive to argue about.
 *
 * Two limits keep a passing mention from setting a scene, both measured on
 * the 95 real reports in the repository (six hits before them, all false: a
 * report listing 「与抗血小板或抗凝药物的相互作用」 as an outcome, 氟西汀 and
 * 利奈唑胺 thirty paragraphs apart, 卡马西平 in a list of monitored drugs).
 * `scope: "paragraph"` asks every group to be named in one paragraph of the
 * report (or in the question) — how an interaction is actually discussed —
 * and `minMentions` asks a group to be named that many times in all, which
 * separates a report about a drug from a report that lists it.
 *
 * Matching: a term in printable ASCII matches at word boundaries,
 * case-insensitively (`aspirin` is not in `aspirinate`, and is in `low-dose
 * aspirin`); any other term — Chinese, or with ≥ — matches as a substring,
 * because Chinese has no word boundary to anchor to. A vocabulary entry that is
 * an array is one concept under several names, so `minDistinct: 2` ("two QT
 * drugs") counts 胺碘酮 and amiodarone once.
 */

/** @typedef {{ names: readonly string[], terms: readonly CautionTerm[] }} CautionConcept */
/** @typedef {{ authority: string, year?: number, url: string, quote?: string, note?: string }} CautionEvidence */
/** @typedef {{ name: string, lower: string, pattern: RegExp | null }} CautionTerm */
/** @typedef {{ concepts: readonly CautionConcept[], minDistinct: number, minMentions: number }} CautionGroup */
/**
 * @typedef {{
 *   id: string, titleZh: string, family: string, message: string, messageZh: string,
 *   scope: 'document' | 'paragraph', when: readonly CautionGroup[], mention: CautionGroup,
 *   evidence: readonly CautionEvidence[],
 * }} CautionRule
 */

/** A word boundary only where the term itself has a word character at that
 *  end: `<30` in `eGFR<30` is found, `SJS` in `SJSX` is not.
 *  @param {string} name @returns {CautionTerm} */
function cautionTerm(name) {
  const lower = name.toLowerCase()
  if (!ASCII_ENTITY.test(name)) return Object.freeze({ name, lower, pattern: null })
  const head = /^[a-z0-9]/.test(lower) ? '(?<![a-z0-9])' : ''
  const tail = /[a-z0-9]$/.test(lower) ? '(?![a-z0-9])' : ''
  return Object.freeze({ name, lower, pattern: new RegExp(`${head}${escapeRegExp(lower)}${tail}`, 'g') })
}

/** @param {CautionTerm} term @param {string} lowerText @returns {boolean} */
function termPresent(term, lowerText) {
  if (!term.pattern) return lowerText.includes(term.lower)
  term.pattern.lastIndex = 0
  return term.pattern.test(lowerText)
}

/** The text with every occurrence of `term` blanked, same length.
 *  @param {CautionTerm} term @param {string} lowerText @returns {string} */
function blanked(term, lowerText) {
  const pattern = term.pattern ?? new RegExp(escapeRegExp(term.lower), 'g')
  pattern.lastIndex = 0
  return lowerText.replace(pattern, (found) => ' '.repeat(found.length))
}

/** How often `term` occurs in `lowerText`. @param {CautionTerm} term @param {string} lowerText */
function occurrences(term, lowerText) {
  const pattern = term.pattern ?? new RegExp(escapeRegExp(term.lower), 'g')
  pattern.lastIndex = 0
  return (lowerText.match(pattern) ?? []).length
}

/**
 * Which concepts of a group a text names, and how many times in all, longest
 * name first. In Chinese one medicine's name can contain another's — 西酞普兰
 * is inside 艾司西酞普兰, 芬太尼 inside 舒芬太尼 — so each name found is blanked
 * before shorter names are looked for, or one mention of escitalopram would
 * count as two drugs.
 * @param {CautionGroup} group @param {string} lowerText
 * @returns {{ concepts: CautionConcept[], mentions: number }}
 */
function namedConcepts(group, lowerText) {
  const terms = group.concepts
    .flatMap((concept) => concept.terms.map((term) => ({ concept, term })))
    .sort((left, right) => right.term.lower.length - left.term.lower.length)
  /** @type {Set<CautionConcept>} */
  const named = new Set()
  let mentions = 0
  let text = lowerText
  for (const { concept, term } of terms) {
    const count = occurrences(term, text)
    if (!count) continue
    named.add(concept)
    mentions += count
    text = blanked(term, text)
  }
  return { concepts: group.concepts.filter((concept) => named.has(concept)), mentions }
}

/** @param {CautionGroup} group @param {string} lowerText @returns {CautionConcept[] | null} the concepts, or null when the group is not satisfied */
function satisfied(group, lowerText) {
  const { concepts, mentions } = namedConcepts(group, lowerText)
  return concepts.length >= group.minDistinct && mentions >= group.minMentions ? concepts : null
}

/**
 * @param {unknown} items a group: vocabulary references (`@name`), terms, and
 *   synonym arrays, in any mix
 * @param {Record<string, unknown>} vocabularies
 * @param {string} where for the load-time error
 * @returns {CautionConcept[]}
 */
function cautionConcepts(items, vocabularies, where) {
  if (!Array.isArray(items) || items.length === 0) throw new Error(`clinical-safety-rules.json: ${where} must be a non-empty list.`)
  /** @type {CautionConcept[]} */
  const concepts = []
  for (const item of items) {
    if (typeof item === 'string' && item.startsWith('@')) {
      const vocabulary = vocabularies[item.slice(1)]
      if (!Array.isArray(vocabulary)) throw new Error(`clinical-safety-rules.json: ${where} names unknown vocabulary ${item}.`)
      concepts.push(...cautionConcepts(vocabulary, {}, `${where} ${item}`))
      continue
    }
    const names = (Array.isArray(item) ? item : [item])
    if (!names.length || names.some((name) => typeof name !== 'string' || !name.trim() || name.startsWith('@'))) {
      throw new Error(`clinical-safety-rules.json: ${where} has an entry that is not a term or a list of terms.`)
    }
    const trimmed = names.map((name) => name.trim())
    concepts.push(Object.freeze({ names: Object.freeze(trimmed), terms: Object.freeze(trimmed.map(cautionTerm)) }))
  }
  return concepts
}

/** @param {unknown} group @param {Record<string, unknown>} vocabularies @param {string} where @returns {CautionGroup} */
function cautionGroup(group, vocabularies, where) {
  const spec = Array.isArray(group) ? { anyOf: group, minDistinct: 1 } : /** @type {Record<string, any>} */ (group ?? {})
  const minDistinct = spec.minDistinct ?? 1
  const minMentions = spec.minMentions ?? 1
  for (const [name, value] of [['minDistinct', minDistinct], ['minMentions', minMentions]]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`clinical-safety-rules.json: ${where}.${name} must be a positive integer.`)
  }
  return Object.freeze({ concepts: Object.freeze(cautionConcepts(spec.anyOf, vocabularies, where)), minDistinct, minMentions })
}

/**
 * Compiles and checks the caution rules. Exported so the refusal is testable
 * without a malformed file on disk; the build's own rules are compiled once at
 * load, and a malformed one stops the process the way a malformed `rules`
 * entry does — a pharmacist's edit is caught by the test suite, not by a run.
 * @param {unknown} data the rules document
 * @returns {readonly CautionRule[]}
 */
export function compileCautionRules(data) {
  const document = /** @type {Record<string, any>} */ (data ?? {})
  const vocabularies = document.cautionVocabularies && typeof document.cautionVocabularies === 'object' ? document.cautionVocabularies : {}
  const rules = Array.isArray(document.cautionRules) ? document.cautionRules : []
  const seen = new Set()
  return Object.freeze(rules.map((rule, index) => {
    const where = `cautionRules[${index}]${rule?.id ? ` (${rule.id})` : ''}`
    for (const field of ['id', 'titleZh', 'family', 'message', 'messageZh']) {
      if (typeof rule?.[field] !== 'string' || !rule[field].trim()) throw new Error(`clinical-safety-rules.json: ${where} is missing ${field}.`)
    }
    if (seen.has(rule.id)) throw new Error(`clinical-safety-rules.json: ${where} repeats an id.`)
    seen.add(rule.id)
    if (!Array.isArray(rule.when) || rule.when.length === 0) throw new Error(`clinical-safety-rules.json: ${where}.when must list at least one group.`)
    const scope = rule.scope ?? 'document'
    if (scope !== 'document' && scope !== 'paragraph') throw new Error(`clinical-safety-rules.json: ${where}.scope must be "document" or "paragraph".`)
    const when = rule.when.map((/** @type {unknown} */ group, /** @type {number} */ groupIndex) => cautionGroup(group, vocabularies, `${where}.when[${groupIndex}]`))
    const mention = cautionGroup(rule.mention, vocabularies, `${where}.mention`)
    // A caution term inside a scene term is present whenever that scene term
    // is — 肾功能 inside 肾功能不全 — so the rule could never fire on it: say so
    // at load rather than ship a rule that is silently dead.
    /** @type {string[]} */
    const scene = when.flatMap((/** @type {CautionGroup} */ group) => group.concepts.flatMap((concept) => concept.names.map((name) => name.toLowerCase())))
    for (const name of mention.concepts.flatMap((concept) => concept.names)) {
      const inside = scene.find((/** @type {string} */ sceneName) => sceneName.includes(name.toLowerCase()))
      if (inside) throw new Error(`clinical-safety-rules.json: ${where} caution term "${name}" is inside scene term "${inside}", so it can never be missing.`)
    }
    const evidence = Array.isArray(rule.evidence) ? rule.evidence : []
    if (evidence.length === 0 || evidence.some((/** @type {any} */ entry) => typeof entry?.authority !== 'string' || !/^https:\/\/\S+$/.test(String(entry?.url ?? '')))) {
      throw new Error(`clinical-safety-rules.json: ${where} needs evidence entries with an authority and an https url.`)
    }
    return Object.freeze({
      id: rule.id, titleZh: rule.titleZh, family: rule.family, message: rule.message, messageZh: rule.messageZh,
      scope, when: Object.freeze(when), mention, evidence: Object.freeze(evidence.map((/** @type {any} */ entry) => Object.freeze({ ...entry }))),
    })
  }))
}

/** The build's own caution rules, compiled once. */
export const CLINICAL_SAFETY_CAUTION_RULES = compileCautionRules(clinicalSafetyRulesData)

/** The check id every caution is recorded under (C2: listed for gateIssueText). */
export const CLINICAL_SAFETY_CAUTION_CHECK = 'clinical-safety-cautions'

/**
 * The cautions a report owes its reader and does not give.
 *
 * The scene is set by the question and the report together — 「≥70 岁阿司匹林一级
 * 预防」 is often said only in the brief — and the caution is looked for in the
 * report alone, because that is what the reader holds. A `paragraph`-scoped
 * rule needs its whole scene in one unit: the question, or one paragraph of
 * the report.
 *
 * @param {{ reportText?: unknown, question?: unknown, rules?: readonly CautionRule[] }} input
 * @returns {{ ruleId: string, check: string, titleZh: string, message: string, messageZh: string, matched: string[][], evidence: readonly CautionEvidence[] }[]}
 */
export function clinicalSafetyCautionHits({ reportText, question, rules = CLINICAL_SAFETY_CAUTION_RULES }) {
  const report = String(reportText ?? '').toLowerCase()
  if (!report.trim()) return []
  const asked = String(question ?? '').toLowerCase()
  const document = [`${asked}\n${report}`]
  const paragraphs = [asked, ...report.split(/\n[ \t]*\n/)].filter((unit) => unit.trim())
  const hits = []
  for (const rule of rules) {
    /** @type {string[][] | null} */
    let matched = null
    for (const unit of rule.scope === 'paragraph' ? paragraphs : document) {
      const found = rule.when.map((group) => satisfied(group, unit))
      if (found.every(Boolean)) {
        matched = found.map((concepts) => (concepts ?? []).map((concept) => concept.names[0]))
        break
      }
    }
    if (!matched) continue
    if (rule.mention.concepts.some((concept) => concept.terms.some((term) => termPresent(term, report)))) continue
    hits.push({
      ruleId: rule.id, check: CLINICAL_SAFETY_CAUTION_CHECK, titleZh: rule.titleZh,
      message: rule.message, messageZh: rule.messageZh, matched, evidence: rule.evidence,
    })
  }
  return hits
}

/**
 * The medicine concepts, compiled once: every concept of the vocabularies
 * `medicineVocabularies` names. A load-time refusal for a name that is not a
 * vocabulary, like every other malformed entry in the pharmacist's file.
 * @type {readonly CautionConcept[]}
 */
const MEDICINE_CONCEPTS = (() => {
  const vocabularies = clinicalSafetyRulesData?.cautionVocabularies && typeof clinicalSafetyRulesData.cautionVocabularies === 'object'
    ? /** @type {Record<string, unknown>} */ (clinicalSafetyRulesData.cautionVocabularies)
    : {}
  const names = Array.isArray(/** @type {any} */ (clinicalSafetyRulesData)?.medicineVocabularies)
    ? /** @type {any} */ (clinicalSafetyRulesData).medicineVocabularies
    : []
  /** @type {CautionConcept[]} */
  const concepts = []
  for (const name of names) {
    if (typeof name !== 'string' || !Array.isArray(vocabularies[name])) {
      throw new Error(`clinical-safety-rules.json: medicineVocabularies names unknown vocabulary ${String(name)}.`)
    }
    concepts.push(...cautionConcepts(vocabularies[name], {}, `medicineVocabularies ${name}`))
  }
  return Object.freeze(concepts)
})()

/**
 * The medicines a text names: the trigger and high-alert entities, and every
 * concept of the caution vocabularies the pharmacist marked as medicines —
 * each concept once, by its first name, longest name matched first so
 * 艾司西酞普兰 is not also 西酞普兰. A closed vocabulary of proper nouns
 * (principle 5), the decidable half of "does this reply talk about a drug":
 * the independent reviewer adds its pharmacist check to a reply that does.
 * @param {string} text
 * @returns {string[]}
 */
export function mentionedMedicines(text) {
  const value = String(text ?? '')
  if (!value.trim()) return []
  const lower = value.toLowerCase()
  const { concepts } = namedConcepts({ concepts: MEDICINE_CONCEPTS, minDistinct: 1, minMentions: 1 }, lower)
  const found = new Set(concepts.map((concept) => concept.names[0]))
  // A high-alert name that is also one of a concept's names is that concept,
  // said once: 「Metformin」 and 「二甲双胍」 are one medicine.
  for (const entity of [...matchedClinicalTriggers(value), ...matchedHighRiskEntities(value)]) {
    found.add(MEDICINE_NAME_TO_CONCEPT.get(entity.toLowerCase()) ?? entity)
  }
  return [...found]
}

/** Every medicine concept's names, lower-case, to the name the concept is reported by. */
const MEDICINE_NAME_TO_CONCEPT = new Map(MEDICINE_CONCEPTS.flatMap((concept) => concept.names.map((name) => [name.toLowerCase(), concept.names[0]])))
