/** The small set of skills whose method is part of the standing platform contract. */
/** @type {Readonly<Record<string,string>>} */
const REQUIRED = Object.freeze({
  'core:domain-check': 'system',
  'core:stats-integrity': 'system',
  'core:traceability-review': 'system',
  'evimed:open-domain-answer': 'system',
})

/**
 * The platform skills a professional workflow tells the model to load by name with the `skill` tool, which a project
 * therefore cannot switch off: once one is off the native consumer refuses the load and the workflow's documented step
 * fails mid-run. A closed vocabulary, so it is code (principle 1): every backticked name of a skill in a switchable root
 * (core, curated, office, community) that a capability's own body or one of the shared bodies its manifest injects names,
 * and that the manifest does not inject itself. `apps/server/test/workflowLoadedSkills.test.mjs` derives the same set from
 * `capabilities/` and `capability-skills/` and fails when a capability names one that is not here, or one here is no longer
 * named. What a workflow injects (its manifest's `skills`) needs no entry: it travels with the workflow.
 */
export const WORKFLOW_LOADED_PLATFORM_SKILLS = Object.freeze([
  'core:humanizer', 'core:humanizer-zh', 'core:manuscript-humanize', 'curated:statistical-analysis',
  'office:docx', 'office:pdf', 'office:pptx', 'office:xlsx',
])

/** The few standing platform methods, the long-task engine, the module's private pack and the skills a professional
 * workflow loads by name (`WORKFLOW_LOADED_PLATFORM_SKILLS`) are required; the rest of the catalogue is user controlled.
 * @param {string} id */
export function platformSkillRequirement(id) {
  const reason = REQUIRED[id] ?? (WORKFLOW_LOADED_PLATFORM_SKILLS.includes(id) ? 'workflow'
    : id.startsWith('loopx:') ? 'long-task-engine' : id.startsWith('geo-private:') ? 'private-workflow' : null)
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
