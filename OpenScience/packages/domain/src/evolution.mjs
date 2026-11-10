/** Closed vocabularies of the platform's evolution signal store: lead tracks, gap codes and sources, and the job kinds old rows keep (the jobs CHECK still admits them). */
export const EVOLUTION_TRACKS = Object.freeze(['E', 'P', 'M', 'U', 'X', 'T'])
export const EVOLUTION_GAP_CODES = Object.freeze(['connector', 'extraction', 'method-missing', 'method-implementation', 'routing', 'skill-instruction', 'writing', 'model-capability', 'outside-product'])
export const EVOLUTION_LEAD_SOURCES = Object.freeze(['literature', 'runtime-failure', 'evaluation', 'dataset',
  // The platform's own modules saying they could not do something (flywheel F20, 2026-10-06): the evidence programme, 循证 GEO and 虚拟临床研究.
  // Every lead of these three is reduced to a closed code and closed entity keys (`evolutionLeadSources.mjs`), never a researcher's words.
  // `evidence-programme` is retired (the programme was deleted on 2026-10-29): no module files it, the name stays for the leads it filed.
  'evidence-programme', 'communication', 'virtual-study'])
export const EVOLUTION_JOB_KINDS = Object.freeze(['evolution-event', 'evolution-scout', 'evolution-build', 'evolution-evaluate', 'evolution-decision', 'evolution-digest', 'evolution-maintain', 'evolution-plan', 'evolution-mission', 'evolution-mission-heavy', 'evolution-meta', 'evolution-research', 'evolution-audit'])
/** Public field contract, with no hidden expected values. @param {any} value */
export function evolutionMethodFields(value = {}) {
  return { validationLevel: value.validationLevel ?? 'V0', dataLevel: value.dataLevel ?? 'D0', dataRequirements: value.dataRequirements ?? null,
    holdoutCases: (value.holdoutCases ?? []).map((/** @type {any} */ item) => ({ id: item.id, sha256: item.sha256 })),
    lineage: value.lineage ?? { parents: [], papers: [], developmentRuns: [], assessments: [] },
    usage: value.usage ?? { retrieved: 0, invoked: 0, succeeded: 0, corrected: 0, costCny: 0 }, status: value.status ?? 'active', replacedBy: value.replacedBy ?? null }
}
/** Localized module errors for the shared client boundary. */
export const EVOLUTION_ERROR_MESSAGES = Object.freeze({
  'paper_gold_administrative_deferred': '评测因模型额度限制暂缓，现有进度已保留。',
  'evolution_dependency_allowlist_invalid': '循证进化的依赖白名单配置有误，已不接纳任何依赖，其他研究不受影响。',
  'evolution_execution_unavailable': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_lead_invalid': '这项研究工作暂时无法完成，请稍后重试。',
  'evolution_owner_missing': '这条研究记录已变化，请刷新后重试。',
  'evolution_setting_invalid': '循证进化的配置有误，已改用默认值，其他研究不受影响。',
  // The prediction registry (flywheel F25): a registration that is not a prediction of a trial's primary endpoint, a module that is off, a
  // registration the viewer may not see (it answers as missing, so a private prediction is not confirmed to exist).
  'prediction_invalid': '这条预测登记的内容不完整或格式不对：需要试验登记号、终点，以及估计值或成功概率。',
  'prediction_registry_disabled': '预测登记模块没有启用，其他研究不受影响。',
  'prediction_not_found': '没有找到这条预测登记。',
})
