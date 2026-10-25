/** The small set of skills whose method is part of the standing platform contract. */
/** @type {Readonly<Record<string,string>>} */
const REQUIRED = Object.freeze({
  'core:domain-check': 'system',
  'core:stats-integrity': 'system',
  'core:traceability-review': 'system',
  'evimed:open-domain-answer': 'system',
})

/** A professional workflow injects its own required skill bodies; its optional catalogue remains user controlled.
 * @param {string} id */
export function platformSkillRequirement(id) {
  const reason = REQUIRED[id] ?? (id.startsWith('loopx:') ? 'long-task-engine' : id.startsWith('geo-private:') ? 'private-workflow' : null)
  return { required: reason !== null, reason }
}

/** Only shipped catalogue identities, never a filesystem selector. @param {unknown} input @returns {string[]} */
export function normalizeDisabledPlatformSkills(input) {
  if (!Array.isArray(input) || input.length > 256 || input.some(id => typeof id !== 'string' || !/^(?:core|curated|office|community):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    || new Set(input).size !== input.length) throw new Error('extension_contract_invalid')
  return [...input].sort()
}

/** Deployment-owned client integrations the project may switch. @param {unknown} input @returns {string[]} */
export function normalizeDisabledBuiltinPlugins(input) {
  if (!Array.isArray(input) || input.length > 2 || input.some(id => !['annotation', 'mermaid'].includes(id)) || new Set(input).size !== input.length) throw new Error('extension_contract_invalid')
  return [...input].sort()
}

/**
 * Which of a project's saved disabled ids still name a skill that can be switched off. A release can remove or rename a
 * skill, or make one a workflow needs required: such an id is stale. It is never refused and never carried into a generation
 * the runtime cannot prove (the runtime would find nothing to restrict); it is reported (`stale`) and left out. `known` null
 * (the platform list could not be read) keeps every saved id that is not required, which the runtime proof tolerates.
 * @param {readonly string[]} saved @param {ReadonlySet<string>|null} known @returns {{disabled:string[],stale:string[]}}
 */
export function currentDisabledPlatformSkills(saved, known) {
  const disabled = saved.filter(id => (!known || known.has(id)) && !platformSkillRequirement(id).required)
  return { disabled, stale: saved.filter(id => !disabled.includes(id)) }
}
