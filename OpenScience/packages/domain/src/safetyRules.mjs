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
  const value = String(text ?? '')
  if (!value) return []
  const lower = value.toLowerCase()
  const alreadyTriggered = new Set(matchedClinicalTriggers(value))
  return CLINICAL_HIGH_RISK_ENTITIES.filter((entity) => {
    if (alreadyTriggered.has(entity)) return false
    if (!ASCII_ENTITY.test(entity)) return value.includes(entity)
    return new RegExp(`(?<![a-z0-9-])${escapeRegExp(entity.toLowerCase())}(?![a-z0-9-])`).test(lower)
  })
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
/** @typedef {{ name: string, lower: string, pattern: RegExp | null }} CautionTerm */
/** @typedef {{ concepts: readonly CautionConcept[], minDistinct: number, minMentions: number }} CautionGroup */
/**
 * @typedef {{
 *   id: string, titleZh: string, family: string, message: string, messageZh: string,
 *   scope: 'document' | 'paragraph', when: readonly CautionGroup[], mention: CautionGroup,
 *   evidence: readonly { authority: string, year?: number, url: string }[],
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
 * @returns {{ ruleId: string, check: string, titleZh: string, message: string, messageZh: string, matched: string[][], evidence: readonly { authority: string, year?: number, url: string }[] }[]}
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
