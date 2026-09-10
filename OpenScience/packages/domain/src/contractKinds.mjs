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

import capabilityContracts from './capability-contracts.json' with { type: 'json' }

/** @typedef {typeof CONTRACT_KINDS[number]} ContractKind */

export const CONTRACT_KINDS = Object.freeze([
  'source-understanding',
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
  'grant-proposal-package',
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
  // Self-evolution: the two internal packages the learning loop runs. Neither
  // is a customer deliverable — they are what `distill` and `consolidate` hand
  // back — but they go through the same gate as everything else, because a
  // proposal that edits the methods later runs are mounted with is the last
  // thing that should be graded by the job that produced it.
  'method-candidate',
  'method-relations',
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

/** Kinds that may only leave the platform after the server-side gate passes. */
export const REGULATED_CONTRACT_KINDS = Object.freeze(['clinical-decision-brief'])

/**
 * Which kinds carry clinical content and therefore must satisfy the safety
 * content triggers even when their own validator is lenient (§9.4).
 *
 * Derived, not written. This was a hand-kept list for eight months and three
 * capabilities that declare `safetyClass: clinical` were never added to it —
 * evidence-appraisal, manuscript-support and meta-analysis. The cost was not
 * theoretical: one mention of a medicine in an appraisal table or a manuscript
 * section came back as `clinical_content_without_clinical_contract`, blocking,
 * telling a capability whose whole subject is that medicine to remove it. The
 * comment in `appraisalContract.mjs` described the defect months before
 * anything fixed it, because the fix was "remember to edit the other file".
 *
 * `capability-contracts.json` is generated from `capabilities/*\/capability.yaml`
 * by `scripts/build/generate-capability-manifests.mjs`, and `--check` (wired
 * into `ci:web` as `check:capabilities`) fails when it drifts. So declaring a
 * capability clinical is now the whole action: nothing else has to be
 * remembered, and nothing else can be forgotten.
 *
 * The regulated kinds are unioned in because a regulated deliverable is clinical
 * by definition and `clinical-decision-brief` is produced by no capability yet —
 * it is reserved (§9.9). A reserved kind that silently stopped being clinical
 * the moment the list became derived would be the derivation quietly losing a
 * rule, which is worse than the hand-kept list it replaced.
 *
 * A GEO content pack about a medicine is medicine advice, which is why
 * `geo-content` declares itself clinical in its own manifest. Spec 9.11 says so —
 * "含用药 / 急症指导的块必须同时满足 clinical 契约，营销文案不能绕过安全规则".
 * Being on this list only silences the trigger check; the safety rules have to
 * be applied by the validator, which is the other half of the same change in
 * `contractRegistry.mjs`. A kind that calls itself clinical and enforces
 * nothing is a label.
 */
export const CLINICAL_CONTRACT_KINDS = Object.freeze([...new Set([
  ...(Array.isArray(capabilityContracts?.capabilities) ? capabilityContracts.capabilities : [])
    .filter((capability) => capability?.safetyClass === 'clinical')
    .flatMap((capability) => (Array.isArray(capability?.contractKinds) ? capability.contractKinds : []))
    .map((kind) => String(kind)),
  ...REGULATED_CONTRACT_KINDS,
])].sort())

/** @param {string} kind @returns {boolean} */
export function isClinicalContractKind(kind) {
  return CLINICAL_CONTRACT_KINDS.includes(String(kind))
}

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
  'grant-proposal-package': '课题申报包',
  'geo-content-pack': 'GEO 内容包',
  'clinical-decision-brief': '临床决策辅助简报',
  'episode-plan': '回合计划',
  'agenda-delta': '议程增量',
  'analysis-plan': '分析计划',
  'reproducibility-pack': '可复现包',
  'surveillance-diff': '监测差异',
  'hypothesis-set': '假说集',
  'method-candidate': '方法候选',
  'method-relations': '方法关系',
})

/** @param {string} kind @returns {string} */
export function contractKindLabel(kind) {
  const text = String(kind ?? '')
  return CONTRACT_KIND_LABELS[/** @type {keyof typeof CONTRACT_KIND_LABELS} */ (text)] ?? text
}
