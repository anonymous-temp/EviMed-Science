import { METHOD_HARM_TEST } from './constants.mjs'
import { DATA_CHECK_FAMILIES } from './dataSemantics.mjs'

/** Closed vocabularies and pure policy for the platform's literature-driven learning loop. */
export const EVOLUTION_TRACKS = Object.freeze(['E', 'P', 'M', 'U', 'X', 'T'])
export const EVOLUTION_DATA_LEVELS = Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4'])
export const EVOLUTION_VALIDATION_LEVELS = Object.freeze(['V0', 'V1', 'V2', 'V3', 'V4'])
export const EVOLUTION_DECISION_CLASSES = Object.freeze(['A', 'B', 'C', 'D'])
export const EVOLUTION_GAP_CODES = Object.freeze(['connector', 'extraction', 'method-missing', 'method-implementation', 'routing', 'skill-instruction', 'writing', 'model-capability', 'outside-product'])
export const EVOLUTION_LEAD_SOURCES = Object.freeze(['literature', 'runtime-failure', 'autopilot', 'evaluation', 'dataset', 'handbook'])
export const EVOLUTION_ORIGINS = Object.freeze(['literature', 'tool-result', 'platform-inference', 'user-statement'])
export const EVOLUTION_BUILD_FORMS = Object.freeze(['compose', 'extend', 'wrap', 'rewrite', 'new-capability'])
export const EVOLUTION_CASE_GROUPS = Object.freeze(['development', 'holdout', 'time-holdout', 'prospective'])
export const EVOLUTION_TOOL_STATES = Object.freeze(['staged', 'active', 'alias', 'retired'])
export const EVOLUTION_JOB_KINDS = Object.freeze(['evolution-event', 'evolution-scout', 'evolution-build', 'evolution-evaluate', 'evolution-decision', 'evolution-digest', 'evolution-maintain', 'evolution-self-check'])
/** @param {any} input */
export function evolutionDecisionClass(input) {
  if (input.overBudget || input.deleteData || input.externalSend || input.clinicalSafetyChange) return 'C'
  if (input.resourceOnly) return 'D'
  return input.directional && new Set(input.attemptedPaths ?? []).size >= 2 ? 'B' : 'A'
}
/** Adaptation only applies to reversible directional choices. @param {any[]} history */
export function evolutionAdaptiveClass(history) {
  if (history.slice(-5).filter((entry) => entry.overridden).length >= 2) return 'B'
  return history.length >= 10 && history.slice(-10).every((entry) => !entry.overridden) ? 'A' : 'B'
}
/** Independent evidence determines labels; a builder's self-report never promotes itself. @param {any[]} assessments @param {any} usage */
export function evolutionValidationLevel(assessments, usage = {}) {
  const independent = assessments.filter((a) => a.independent === true && a.passed === true
    && (a.kind === 'simulation' ? a.exposed !== true : a.exposed === false && a.retracted === false))
  if (independent.some((a) => a.kind === 'research' && Number(a.papers) >= 5)) return usage.harmState === 'clear' && Number(usage.runs) >= METHOD_HARM_TEST.minRuns ? 'V4' : 'V3'
  if (new Set(independent.filter((a) => a.kind === 'published-case').map((a) => a.caseId)).size >= 2 && independent.every((a) => a.crossImplementationPassed !== false)) return 'V2'
  if (independent.some((a) => a.kind === 'simulation' && a.preRegistered === true
    && (typeof a.monteCarloError === 'number' ? Number.isFinite(a.monteCarloError) && a.monteCarloError >= 0
      : a.monteCarloError && ['bias', 'coverage', 'falsePositive'].every(key => Number.isFinite(a.monteCarloError[key]) && a.monteCarloError[key] >= 0)))) return 'V1'
  return 'V0'
}
/** Labels govern discovery, never the execution or delivery of an already selected tool. @param {any} tool */
export function evolutionToolVisible(tool) {
  if (tool.status !== 'active') return false
  if (tool.toolKind === 'workflow') return tool.smokePassed === true
  return Number(String(tool.validationLevel).slice(1)) >= (tool.noPublishedCases === true ? 1 : 2)
}
/** Public field contract, with no hidden expected values. @param {any} value */
export function evolutionMethodFields(value = {}) {
  return { validationLevel: value.validationLevel ?? 'V0', dataLevel: value.dataLevel ?? 'D0', dataRequirements: value.dataRequirements ?? null,
    holdoutCases: (value.holdoutCases ?? []).map((/** @type {any} */ item) => ({ id: item.id, sha256: item.sha256 })),
    lineage: value.lineage ?? { parents: [], papers: [], developmentRuns: [], assessments: [] },
    usage: value.usage ?? { retrieved: 0, invoked: 0, succeeded: 0, corrected: 0, costCny: 0 }, status: value.status ?? 'active', replacedBy: value.replacedBy ?? null }
}
/** Validate structural and research requirements independently. @param {any} requirement @param {any} dataset */
export function evolutionDataMatch(requirement, dataset) {
  if (requirement?.requirementsBasis === 'legacy-prose') return { matched: false, issues: ['requirements-not-machine-verified'] }
  const contractIssues = validateEvolutionDataRequirements(requirement)
  if (contractIssues.length) return { matched: false, issues: contractIssues }
  const fields = dataset.fields ?? []
  const issues = (requirement?.schema?.fields ?? []).flatMap((/** @type {any} */ field) => {
    const found = fields.find((/** @type {any} */ item) => item.name === field.name)
    const unit = field.unit ?? requirement.units?.[field.name]
    const coding = field.coding ?? requirement.codings?.[field.name]
    if (found && unit && found.unit !== unit) return [`unit:${field.name}:${found.unit == null ? 'unknown' : 'mismatch'}`]
    if (found && field.constraints?.enum && (!Array.isArray(found.categories) || found.categories.some((/** @type {any} */ v) => !field.constraints.enum.includes(v)))) return [`categories:${field.name}:${found.categories == null ? 'unknown' : 'mismatch'}`]
    if (found && coding && found.coding !== coding) return [`coding:${field.name}:${found.coding == null ? 'unknown' : 'mismatch'}`]
    if (found && field.constraints?.minimum != null && (found.minimum == null || found.minimum < field.constraints.minimum)) return [`range:${field.name}:${found.minimum == null ? 'unknown' : 'below-minimum'}`]
    if (found && field.constraints?.maximum != null && (found.maximum == null || found.maximum > field.constraints.maximum)) return [`range:${field.name}:${found.maximum == null ? 'unknown' : 'above-maximum'}`]
    if (found && field.constraints?.required && found.missingCount > 0) return [`missing-values:${field.name}`]
    return !found && field.constraints?.required ? [`missing:${field.name}`] : found && found.type !== field.type && !(field.type === 'number' && found.type === 'integer') ? [`type:${field.name}`] : []
  })
  const rules = requirement?.researchRules ?? {}
  if (rules.minEvents && Number(dataset.events ?? 0) < rules.minEvents) issues.push(dataset.events == null ? 'events-unknown' : 'events-insufficient')
  if (rules.minFollowUp && Number(dataset.followUp ?? 0) < rules.minFollowUp) issues.push(dataset.followUp == null ? 'follow-up-unknown' : 'follow-up-insufficient')
  if (rules.population && dataset.population !== rules.population) issues.push(dataset.population == null ? 'population-unknown' : 'population-mismatch')
  if (rules.rowRepresents && dataset.rowRepresents !== rules.rowRepresents) issues.push('observation-unit-unknown')
  if (rules.requiredSemanticsChecks) {
    for (const family of rules.requiredSemanticsChecks) if (!dataset.semanticsChecks?.checkedAt || !dataset.semanticsChecks.passedFamilies?.includes(family) || dataset.semanticsChecks.attentionFamilies?.includes(family) || dataset.semanticsChecks.unavailableFamilies?.includes(family)) issues.push(`semantics:${family}:unknown-or-attention`)
  } else if (dataset.semanticsChecksPassed !== true) issues.push('semantics-unchecked')
  return { matched: issues.length === 0, issues }
}

/** Bounded machine-readable contract shared by upload matching and template generation. @param {any} requirement */
export function validateEvolutionDataRequirements(requirement) {
  const issues = []
  if (!requirement || !Array.isArray(requirement.schema?.fields) || requirement.schema.fields.length > 500) return ['schema-fields-invalid']
  const names = new Set()
  for (const field of requirement.schema.fields) {
    if (!field || typeof field.name !== 'string' || !field.name || names.has(field.name)) issues.push('field-name-invalid')
    names.add(field?.name)
    if (!['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'time', 'year', 'yearmonth', 'object', 'array', 'geopoint', 'geojson', 'duration', 'any'].includes(field?.type)) issues.push('field-type-invalid')
    if (field?.constraints?.enum && !Array.isArray(field.constraints.enum)) issues.push('field-enum-invalid')
    if (field?.unit != null && typeof field.unit !== 'string') issues.push('field-unit-invalid')
  }
  const rules = requirement.researchRules ?? {}
  for (const key of ['minEvents', 'minFollowUp']) if (rules[key] != null && (!Number.isFinite(rules[key]) || rules[key] < 0)) issues.push(`${key}-invalid`)
  if (rules.requiredSemanticsChecks != null && (!Array.isArray(rules.requiredSemanticsChecks) || !rules.requiredSemanticsChecks.length || rules.requiredSemanticsChecks.some(family => !DATA_CHECK_FAMILIES.includes(family)))) issues.push('semantics-check-families-invalid')
  return [...new Set(issues)]
}

/** Localized module errors for the shared client boundary. */
export const EVOLUTION_ERROR_MESSAGES = Object.freeze({
  'evolution_action_unsupported': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_assessment_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_capability_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_card_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_decision_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_decision_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_disabled': '循证进化暂未启用。',
  'evolution_dossier_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_evaluation_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_event_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_execution_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_failure_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_lead_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_merge_case_conflict': '这条研究记录已变化，请刷新后重试。',
  'evolution_merge_unverified': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_operator_required': '这项操作仅运维账号可使用。',
  'evolution_opportunity_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_option_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_output_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_output_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_override_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_owner_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_path_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_refresh_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_requirements_invalid': '科研工具的数据要求需要补全。',
  'evolution_review_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_review_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_route_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_run_timeout': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_scope_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_temporarily_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_tool_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_tool_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_version_immutable': '这条研究记录已变化，请刷新后重试。',
})
