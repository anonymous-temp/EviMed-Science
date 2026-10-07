import { METHOD_SCIENTIFIC_HARM_TEST } from './constants.mjs'
import { DATA_CHECK_FAMILIES } from './dataSemantics.mjs'

/**
 * The sequential test a published tool's real use is read with: the platform's existing harm test
 * (`methodHarmTest`), on the scientific axis's numbers.
 *
 * Not `METHOD_HARM_TEST`'s. Every bad outcome the tool loop records is a researcher correcting a result
 * the tool took part in, and `constants.mjs` says why that axis has its own background rate: a
 * correction is ordinary work (25% against a harmful 60%), where a rejected delivery is rare (10%
 * against 40%). Feeding corrections to the delivery-axis numbers let three of them retire a tool.
 */
export const EVOLUTION_TOOL_HARM_TEST = METHOD_SCIENTIFIC_HARM_TEST

/** Closed vocabularies and pure policy for the platform's literature-driven learning loop. */
export const EVOLUTION_TRACKS = Object.freeze(['E', 'P', 'M', 'U', 'X', 'T'])
export const EVOLUTION_DATA_LEVELS = Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4'])
export const EVOLUTION_VALIDATION_LEVELS = Object.freeze(['V0', 'V1', 'V2', 'V3', 'V4'])
export const EVOLUTION_DECISION_CLASSES = Object.freeze(['A', 'B', 'C', 'D'])
export const EVOLUTION_GAP_CODES = Object.freeze(['connector', 'extraction', 'method-missing', 'method-implementation', 'routing', 'skill-instruction', 'writing', 'model-capability', 'outside-product'])
export const EVOLUTION_LEAD_SOURCES = Object.freeze(['literature', 'runtime-failure', 'autopilot', 'evaluation', 'dataset', 'handbook',
  // The platform's own modules saying they could not do something (flywheel F20, 2026-10-06): the evidence programme, 循证 GEO and 虚拟临研.
  // Every lead of these three is reduced to a closed code and closed entity keys (`evolutionLeadSources.mjs`), never a researcher's words.
  'evidence-programme', 'communication', 'virtual-study'])
export const EVOLUTION_ORIGINS = Object.freeze(['literature', 'tool-result', 'platform-inference', 'user-statement'])
export const EVOLUTION_BUILD_FORMS = Object.freeze(['compose', 'extend', 'wrap', 'rewrite', 'new-capability'])
export const EVOLUTION_CASE_GROUPS = Object.freeze(['development', 'confirmation', 'audit', 'prospective'])
export const EVOLUTION_TOOL_STATES = Object.freeze(['staged', 'active', 'alias', 'retired'])
export const EVOLUTION_JOB_KINDS = Object.freeze(['evolution-event', 'evolution-scout', 'evolution-build', 'evolution-evaluate', 'evolution-decision', 'evolution-digest', 'evolution-maintain', 'evolution-self-check', 'evolution-plan', 'evolution-mission', 'evolution-mission-heavy', 'evolution-meta', 'evolution-research', 'evolution-audit'])
/**
 * What a decision's option can do, as the control plane's executor knows it (`evolutionComposition.mjs`). This list is
 * closed, and it is what stops the engine: an option whose operation is not here is refused when it is chosen, by a
 * person or by default. None of these deletes data, sends anything outside the platform, spends past the daily budget
 * or touches a clinical safety rule; the nearest to irreversible, a soft retirement, keeps every version and can be
 * restored. Adding one that does is adding it to `EVOLUTION_ONE_WAY_OPERATIONS` as well, which makes its decision a
 * one-way door that no default can take.
 */
export const EVOLUTION_EXECUTABLE_OPERATIONS = Object.freeze(['wait', 'defer', 'keep', 'build', 'retry', 'recommended', 'alternative', 'rescout',
  'maintenance-retire', 'maintenance-merge', 'maintenance-repair'])
/** Operations that cannot be taken back; a decision that offers one is class C whatever else it says (plan 9.1). */
export const EVOLUTION_ONE_WAY_OPERATIONS = Object.freeze(['delete-data', 'external-send', 'over-budget-spend', 'clinical-safety-change'])
/** @param {any} input */
export function evolutionDecisionClass(input) {
  if (input.overBudget || input.deleteData || input.externalSend || input.clinicalSafetyChange) return 'C'
  if ((input.options ?? []).some((/** @type {any} */ option) => EVOLUTION_ONE_WAY_OPERATIONS.includes(option?.operation ?? option?.id))) return 'C'
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
  if (independent.some((a) => a.kind === 'research' && Number(a.papers) >= 5)) return usage.harmState === 'clear' && Number(usage.runs) >= EVOLUTION_TOOL_HARM_TEST.minRuns && Number(usage.attributablePositiveResults) >= 1 ? 'V4' : 'V3'
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
  // A text-only handbook entry from an account's general lesson is visible once its independent re-check held (flywheel F16).
  if (tool.toolKind === 'handbook') return tool.recheckPassed === true
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
  if (rules.requiredSemanticsChecks != null && (!Array.isArray(rules.requiredSemanticsChecks) || !rules.requiredSemanticsChecks.length || rules.requiredSemanticsChecks.some((/** @type {any} */ family) => !DATA_CHECK_FAMILIES.includes(family)))) issues.push('semantics-check-families-invalid')
  return [...new Set(issues)]
}

/** Localized module errors for the shared client boundary. */
export const EVOLUTION_ERROR_MESSAGES = Object.freeze({
  'paper_gold_administrative_deferred': '评测因模型额度限制暂缓，现有进度已保留。',
  'evaluation_opaque_source_excluded': '评测期间不提供原始文件下载，请改用已解析的来源。',
  'evaluation_policy_unreadable': '评测的排除规则暂时无法读取，这次请求没有执行，请稍后重试。',
  'evaluation_source_excluded': '这个来源在本次评测中被排除，请换用其他来源。',
  'evolution_action_unsupported': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_assessment_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_capability_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_card_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_decision_executing': '这条裁决正在执行，稍后刷新再答复。',
  'evolution_decision_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_decision_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_dependency_allowlist_invalid': '循证进化的依赖白名单配置有误，该模块暂未启用，其他研究不受影响。',
  'evolution_disabled': '循证进化暂未启用。',
  'evolution_dossier_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_evaluation_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_event_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_execution_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_failure_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_job_failed': '这项研究工作暂时无法完成，请稍后重试。',
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
  'evolution_run_failed': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_run_budget_exhausted': '这项研究工作需要的模型预算超过了单次运行的上限，已记录为资源缺口，其他研究不受影响。',
  'evolution_run_timeout': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_scope_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_setting_invalid': '循证进化的配置有误，该模块暂未启用，其他研究不受影响。',
  'evolution_temporarily_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_tool_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_tool_rate_limited': '这个项目调用平台工具过于频繁，请稍后重试。',
  'evolution_tool_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_version_immutable': '这条研究记录已变化，请刷新后重试。',
  // The prediction registry (flywheel F25): a registration that is not a prediction of a trial's primary endpoint, a module that is off, a
  // registration the viewer may not see (it answers as missing, so a private prediction is not confirmed to exist).
  'prediction_invalid': '这条预测登记的内容不完整或格式不对：需要试验登记号、终点，以及估计值或成功概率。',
  'prediction_registry_disabled': '预测登记模块没有启用，其他研究不受影响。',
  'prediction_not_found': '没有找到这条预测登记。',
})
