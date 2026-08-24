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
