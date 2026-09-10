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
