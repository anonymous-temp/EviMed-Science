/**
 * Contract kinds: what a deliverable claims to be.
 *
 * Hidden knowledge: the whole reason there is no mode router. A question is a
 * sentence and can only be guessed at; a deliverable is a directory of files
 * and can be checked. So nothing binds to the input — the plan declares a kind
 * per deliverable, and the kind decides which validator runs (§9.4).
 *
 * Adding a kind is a code change on purpose: a kind with no validator is a
 * contract nobody enforces, which is worse than no contract at all.
 */

/** @typedef {typeof CONTRACT_KINDS[number]} ContractKind */

export const CONTRACT_KINDS = Object.freeze([
  // P0/P1 — the eleven specialist packages' outputs
  'clinical-evidence-report',
  'drug-evaluation-report',
  'drug-selection-report',
  'off-label-report',
  'meta-analysis-report',
  'mendelian-randomization-report',
  'bibliometric-analysis-report',
  'peer-review-report',
  'adr-analysis-report',
  'research-topic-report',
  'dataset-scoping-package',
  'research-brief',
  // P2 — planned capabilities
  'appraisal-table',
  'manuscript-section',
  // P3 — GEO
  'geo-content-pack',
  // Reserved: regulated, ships only when product and compliance decide (§9.9)
  'clinical-decision-brief',
  // Autopilot contract kinds (§24.7)
  'episode-plan',
  'agenda-delta',
  'analysis-plan',
  'reproducibility-pack',
  'surveillance-diff',
  'hypothesis-set',
])

/** @param {string} value @returns {value is ContractKind} */
export function isContractKind(value) {
  return CONTRACT_KINDS.includes(/** @type {ContractKind} */ (String(value)))
}

/**
 * Safety class of the contract, mirrored from the capability manifest that
 * produces it. `regulated` deliverables may not be released until the
 * server-side external gate has passed them (§9.3).
 */
export const SAFETY_CLASSES = Object.freeze(['general', 'clinical', 'regulated'])

/**
 * Which kinds carry clinical content and therefore must satisfy the safety
 * content triggers even when their own validator is lenient (§9.4).
 */
export const CLINICAL_CONTRACT_KINDS = Object.freeze([
  'clinical-evidence-report',
  'drug-evaluation-report',
  'drug-selection-report',
  'off-label-report',
  'adr-analysis-report',
  'clinical-decision-brief',
  // A GEO content pack about a medicine is medicine advice. Spec 9.11 says so —
  // "含用药 / 急症指导的块必须同时满足 clinical 契约，营销文案不能绕过安全规则" —
  // and until this line existed the implementation did the opposite of what that
  // sentence asks: it rejected every such pack with
  // `clinical_content_without_clinical_contract`, advice the capability could
  // not act on, because there is no clinical GEO kind and removing the medicine
  // removes the deliverable. Found by assembling a real pack and running it
  // through the real gate.
  //
  // This line alone would have been worse than the defect. It only silences the
  // trigger check; the safety rules have to be applied by the validator, which
  // is the other half of the same change in contractRegistry.mjs. A kind that
  // calls itself clinical and enforces nothing is a label.
  'geo-content-pack',
])

/** @param {string} kind @returns {boolean} */
export function isClinicalContractKind(kind) {
  return CLINICAL_CONTRACT_KINDS.includes(String(kind))
}

/** Kinds that may only leave the platform after the server-side gate passes. */
export const REGULATED_CONTRACT_KINDS = Object.freeze(['clinical-decision-brief'])

/** @param {string} kind @returns {boolean} */
export function isRegulatedContractKind(kind) {
  return REGULATED_CONTRACT_KINDS.includes(String(kind))
}

/** Display names, Simplified Chinese baseline (§23.2 rule 11). */
export const CONTRACT_KIND_LABELS = Object.freeze({
  'clinical-evidence-report': '临床证据综述',
  'drug-evaluation-report': '药品综合评价',
  'drug-selection-report': '药品遴选报告',
  'off-label-report': '超说明书用药评估',
  'meta-analysis-report': 'Meta 分析报告',
  'mendelian-randomization-report': '孟德尔随机化报告',
  'bibliometric-analysis-report': '文献计量报告',
  'peer-review-report': '论文审稿意见',
  'adr-analysis-report': '药物安全信号分析',
  'research-topic-report': '科研选题分析',
  'dataset-scoping-package': '数据集选题包',
  'research-brief': '研究简报',
  'appraisal-table': '证据质量评价表',
  'manuscript-section': '稿件章节',
  'geo-content-pack': 'GEO 内容包',
  'clinical-decision-brief': '临床决策辅助简报',
  'episode-plan': '回合计划',
  'agenda-delta': '议程增量',
  'analysis-plan': '分析计划',
  'reproducibility-pack': '可复现包',
  'surveillance-diff': '监测差异',
  'hypothesis-set': '假说集',
})

/** @param {string} kind @returns {string} */
export function contractKindLabel(kind) {
  const text = String(kind ?? '')
  return CONTRACT_KIND_LABELS[/** @type {keyof typeof CONTRACT_KIND_LABELS} */ (text)] ?? text
}
