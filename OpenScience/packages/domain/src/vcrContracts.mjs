/**
 * 「虚拟临研」's five contracts: what a study deliverable claims to be.
 *
 * Hidden knowledge:
 *
 * - **Every finding here is a notice.** The blocking budget is six and it is
 *   spent (principle 4, plan §11.2 layer 4). These checks ship as advisory
 *   findings with an observed distribution behind them before anyone argues
 *   for promotion — and two of them would be wrong to promote at all, because
 *   the thing they describe is a legitimate delivery: a package whose
 *   conclusion is 「不可估计」 is finished work (plan §3.6), and a package with
 *   `ai_set` assumptions is the normal state of a study nobody has reviewed
 *   yet (plan §10.2).
 * - **The numbers in these packages are rendered, not typed** (plan §8.3,
 *   principle 10c). That is why `vcr-study-package` reads `results.json` and
 *   checks the prose against it rather than reading the prose alone: the
 *   report is a template bound to result fields, so a number in the prose that
 *   no result carries means the binding was bypassed. This is the one place in
 *   the platform where AC-20 is decidable from the bytes of a package.
 * - **A reconstructed pseudo-patient is never an observed one** (plan §5.3,
 *   AC-27). The counts block in a package states the four counts apart; a
 *   package that folds `reconstructedPseudoPatients` into `realPatients` is
 *   reporting a sample size it does not have.
 * - Validators take the gate's `GateInput` (a map of path → text) and answer
 *   `{ issues, metrics }`, which `contractRegistry.mjs` composes onto the
 *   shared report-shaped pass.
 *
 * @module @evimed/domain/vcrContracts
 */

import {
  VCR_CONCLUSIONS, VCR_COUNT_KEYS, VCR_CRITERION_STATES, VCR_INTERVAL_KINDS, VCR_NOT_ESTIMABLE_RULES, VCR_VALUE_SOURCES,
} from './vcrVocabulary.mjs'

/** @typedef {{ code: string, message: string, severity: 'required'|'advisory', path?: string, check?: string }} VcrIssue */
/** @typedef {{ issues: VcrIssue[], metrics: Record<string, unknown> }} VcrFindings */

/** Every finding this module raises. Registered in `contractRegistry.mjs`. */
export const VCR_CHECK_IDS = Object.freeze([
  'vcr-results-parse',
  'vcr-number-provenance',
  'vcr-counts-separated',
  'vcr-conclusion-stated',
  'vcr-interval-named',
  'vcr-assumption-source',
  'vcr-simulation-report-shape',
  'vcr-matching-state-shape',
])

/** The machine-readable result file every package ships beside its prose. */
export const VCR_RESULTS_FILE = 'results.json'
/** The simulation report's own structured companion (FDA CID checklist, plan §5.4). */
export const VCR_SIMULATION_FILE = 'simulation.json'
/** The matching assessment's structured companion (plan §7.1). */
export const VCR_MATCHING_FILE = 'matching.json'

/** @param {string} code @param {string} message @param {{path?: string, check?: string}} [extra] @returns {VcrIssue} */
const notice = (code, message, extra = {}) => ({ code, message, severity: 'advisory', ...extra })

/** @param {Map<string, string>} files @param {string} path */
function parsed(files, path) {
  const raw = files.get(path)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Markdown files of a package, in path order.
 * @param {any} files
 */
function proseOf(files) {
  return [...files.keys()].filter((path) => path.endsWith('.md')).sort()
}

/**
 * Numbers a reader sees in prose, with the year-like and list-index shapes
 * dropped: a year, a section number and a percentage of a whole are not the
 * kind of number this check is about.
 * @param {string} text
 */
export function proseNumbers(text) {
  /** @type {string[]} */
  const found = []
  const pattern = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![\w.])/g
  let match
  while ((match = pattern.exec(text))) {
    const raw = match[1]
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) continue
    if (Number.isInteger(value) && value <= 12) continue
    found.push(raw)
  }
  return found
}

/**
 * Every number a result tree carries, as strings normalized the way prose writes them.
 * @param {any} value @param {Set<string>} [out]
 */
export function resultNumbers(value, out = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(String(value))
    out.add(String(Math.round(value)))
    for (const digits of [1, 2, 3]) out.add(value.toFixed(digits))
    out.add(String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
    if (value > 0 && value < 1) {
      const percent = value * 100
      out.add(String(Number(percent.toFixed(6))))
      for (const digits of [0, 1, 2]) out.add(percent.toFixed(digits))
    }
  } else if (Array.isArray(value)) {
    for (const item of value) resultNumbers(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) resultNumbers(item, out)
  }
  return out
}

/**
 * The study package: prose plus the results it renders from.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrStudyPackageFindings(input) {
  /** @type {VcrIssue[]} */
  const issues = []
  /** @type {Record<string, unknown>} */
  const metrics = {}
  const results = parsed(input.files, VCR_RESULTS_FILE)

  if (results === undefined) {
    issues.push(notice('vcr_results_unreadable', `${VCR_RESULTS_FILE} 不是有效的 JSON，报告里的数字无法对账。`,
      { path: VCR_RESULTS_FILE, check: 'vcr-results-parse' }))
    return { issues, metrics }
  }
  if (results === null) {
    issues.push(notice('vcr_results_missing', `研究包缺 ${VCR_RESULTS_FILE}：报告数字应由结果渲染（方案 §8.3）。`,
      { path: VCR_RESULTS_FILE, check: 'vcr-results-parse' }))
    return { issues, metrics }
  }

  const known = resultNumbers(results)
  let traced = 0
  let total = 0
  for (const path of proseOf(input.files)) {
    const text = input.files.get(path) ?? ''
    for (const raw of proseNumbers(text)) {
      total += 1
      if (known.has(raw) || known.has(raw.replace(/,/g, ''))) traced += 1
      else {
        issues.push(notice('vcr_number_untraced', `「${raw}」在 ${VCR_RESULTS_FILE} 里找不到对应的结果字段。`,
          { path, check: 'vcr-number-provenance' }))
      }
    }
  }
  metrics.vcrNumbersInProse = total
  metrics.vcrNumbersTraced = traced

  const counts = results.counts ?? null
  if (counts && typeof counts === 'object') {
    const stated = VCR_COUNT_KEYS.filter((key) => counts[key] !== undefined)
    metrics.vcrCountsStated = stated.length
    if (stated.length < VCR_COUNT_KEYS.length) {
      issues.push(notice('vcr_counts_incomplete',
        `四个数要分开显示，缺 ${VCR_COUNT_KEYS.filter((key) => counts[key] === undefined).join('、')}（方案 §3.5）。`,
        { path: VCR_RESULTS_FILE, check: 'vcr-counts-separated' }))
    }
    if (Number(counts.reconstructedPseudoPatients ?? 0) > 0 && counts.realPatients === undefined) {
      issues.push(notice('vcr_reconstructed_folded', '有重建伪个体时必须单独给出真实患者数（AC-27）。',
        { path: VCR_RESULTS_FILE, check: 'vcr-counts-separated' }))
    }
  } else {
    issues.push(notice('vcr_counts_missing', `${VCR_RESULTS_FILE} 没有 counts：涉及样本量的结果要分开显示四个数（方案 §3.5）。`,
      { path: VCR_RESULTS_FILE, check: 'vcr-counts-separated' }))
  }

  const conclusion = results.conclusion ?? null
  if (!VCR_CONCLUSIONS.includes(conclusion)) {
    issues.push(notice('vcr_conclusion_missing', `结果要写明科学结论（${VCR_CONCLUSIONS.join(' / ')}）。`,
      { path: VCR_RESULTS_FILE, check: 'vcr-conclusion-stated' }))
  } else if (conclusion === 'not_estimable' && !VCR_NOT_ESTIMABLE_RULES.includes(results.notEstimableRule)) {
    issues.push(notice('vcr_not_estimable_rule_missing', '「不可估计」要写明触发的确定性规则和缺口清单（方案 §5.3）。',
      { path: VCR_RESULTS_FILE, check: 'vcr-conclusion-stated' }))
  }
  metrics.vcrConclusion = conclusion ?? null

  for (const measure of Array.isArray(results.measures) ? results.measures : []) {
    if (measure?.interval && !VCR_INTERVAL_KINDS.includes(measure.interval.kind)) {
      issues.push(notice('vcr_interval_unnamed', `「${measure.name ?? '某个估计'}」的区间没有写明是哪一种（方案 §8.3）。`,
        { path: VCR_RESULTS_FILE, check: 'vcr-interval-named' }))
    }
  }

  const assumptions = Array.isArray(results.assumptions) ? results.assumptions : []
  metrics.vcrAssumptions = assumptions.length
  for (const assumption of assumptions) {
    const sources = Array.isArray(assumption?.sources) ? assumption.sources : []
    const external = assumption?.sourceKind === 'external_evidence'
    if (external && !sources.some((/** @type {any} */ source) => source?.quote && source?.locator)) {
      issues.push(notice('vcr_assumption_unanchored',
        `假设卡「${assumption?.name ?? ''}」标为外部证据，但没有带原文位置的抽取值（AC-25）。`,
        { path: VCR_RESULTS_FILE, check: 'vcr-assumption-source' }))
    }
    if (assumption?.valueSource && !VCR_VALUE_SOURCES.includes(assumption.valueSource)) {
      issues.push(notice('vcr_value_source_unknown', `未知的来源标签 ${JSON.stringify(assumption.valueSource)}。`,
        { path: VCR_RESULTS_FILE, check: 'vcr-assumption-source' }))
    }
  }
  return { issues, metrics }
}

/**
 * The simulation report: the FDA complex-innovative-design checklist, as data.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrSimulationReportFindings(input) {
  /** @type {VcrIssue[]} */
  const issues = []
  const report = parsed(input.files, VCR_SIMULATION_FILE)
  if (report === undefined) {
    issues.push(notice('vcr_simulation_unreadable', `${VCR_SIMULATION_FILE} 不是有效的 JSON。`, { path: VCR_SIMULATION_FILE, check: 'vcr-simulation-report-shape' }))
    return { issues, metrics: {} }
  }
  if (report === null) {
    issues.push(notice('vcr_simulation_missing', `模拟报告缺 ${VCR_SIMULATION_FILE}（方案 §5.4）。`, { path: VCR_SIMULATION_FILE, check: 'vcr-simulation-report-shape' }))
    return { issues, metrics: {} }
  }
  const required = ['designSummary', 'exampleTrial', 'scenarios', 'replicates', 'operatingCharacteristics', 'sensitivity', 'code', 'summary']
  const missing = required.filter((field) => report[field] === undefined || report[field] === null)
  if (missing.length) {
    issues.push(notice('vcr_simulation_fields_missing', `模拟报告缺：${missing.join('、')}（FDA 复杂创新设计指导原则的清单）。`,
      { path: VCR_SIMULATION_FILE, check: 'vcr-simulation-report-shape' }))
  }
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : []
  if (scenarios.length && !scenarios.some((/** @type {any} */ scenario) => scenario?.isNull === true)) {
    issues.push(notice('vcr_null_scenario_missing', '情景里必须有零假设情景（方案 §5.4）。', { path: VCR_SIMULATION_FILE, check: 'vcr-simulation-report-shape' }))
  }
  const characteristics = Array.isArray(report.operatingCharacteristics) ? report.operatingCharacteristics : []
  const withoutMcse = characteristics.filter((/** @type {any} */ row) => row?.simulated !== false && (typeof row?.mcse !== 'number' || !Number.isFinite(row.mcse)))
  if (withoutMcse.length) {
    issues.push(notice('vcr_mcse_missing', `${withoutMcse.length} 个运行特征没有蒙特卡洛标准误（AC-28）。`,
      { path: VCR_SIMULATION_FILE, check: 'vcr-simulation-report-shape' }))
  }
  return { issues, metrics: { vcrScenarios: scenarios.length, vcrOperatingCharacteristics: characteristics.length } }
}

/**
 * A comparator analysis: the diagnostics that decide whether it is estimable.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrComparatorFindings(input) {
  const base = vcrStudyPackageFindings(input)
  const results = parsed(input.files, VCR_RESULTS_FILE)
  if (!results || typeof results !== 'object') return base
  const diagnostics = results.diagnostics ?? null
  if (!diagnostics) {
    base.issues.push(notice('vcr_diagnostics_missing', '对照分析要交付诊断（重叠、平衡、有效样本量、敏感性）（方案 §5.3）。',
      { path: VCR_RESULTS_FILE, check: 'vcr-conclusion-stated' }))
  }
  if (results.estimand && !['ATT', 'ATE', 'ATO'].includes(results.estimand)) {
    base.issues.push(notice('vcr_estimand_unknown', `未知的估计目标 ${JSON.stringify(results.estimand)}；换估计目标必须标明（方案 §5.3）。`,
      { path: VCR_RESULTS_FILE, check: 'vcr-conclusion-stated' }))
  }
  return base
}

/**
 * A cohort snapshot package: the population, its waterfall and its quality report.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrCohortFindings(input) {
  const base = vcrStudyPackageFindings(input)
  const results = parsed(input.files, VCR_RESULTS_FILE)
  if (!results || typeof results !== 'object') return base
  const waterfall = Array.isArray(results.waterfall) ? results.waterfall : []
  const missingUnknown = waterfall.filter((/** @type {any} */ step) => step?.unknown === undefined)
  if (waterfall.length && missingUnknown.length) {
    base.issues.push(notice('vcr_waterfall_unknown_missing', '筛选流程的每一步都要单列「无法判断」，不能并入「排除」（方案 §5.1）。',
      { path: VCR_RESULTS_FILE, check: 'vcr-counts-separated' }))
  }
  if (results.populationKind === 'empirical_synthetic' && !results.qualityReport) {
    base.issues.push(notice('vcr_quality_report_missing', '经验合成人群必须随附质量报告（保真度、可用性、泄露风险）（方案 §5.1）。',
      { path: VCR_RESULTS_FILE, check: 'vcr-conclusion-stated' }))
  }
  return base
}

/**
 * A matching assessment: three-valued judgments with their evidence.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrMatchingFindings(input) {
  /** @type {VcrIssue[]} */
  const issues = []
  const assessment = parsed(input.files, VCR_MATCHING_FILE)
  if (assessment === undefined) {
    issues.push(notice('vcr_matching_unreadable', `${VCR_MATCHING_FILE} 不是有效的 JSON。`, { path: VCR_MATCHING_FILE, check: 'vcr-matching-state-shape' }))
    return { issues, metrics: {} }
  }
  if (assessment === null) {
    issues.push(notice('vcr_matching_missing', `匹配评估缺 ${VCR_MATCHING_FILE}（方案 §7.1）。`, { path: VCR_MATCHING_FILE, check: 'vcr-matching-state-shape' }))
    return { issues, metrics: {} }
  }
  const judgments = Array.isArray(assessment.judgments) ? assessment.judgments : []
  let unanchored = 0
  for (const judgment of judgments) {
    if (judgment?.state === 'satisfied' || judgment?.state === 'not_satisfied') {
      const evidence = Array.isArray(judgment?.evidence) ? judgment.evidence : []
      if (!evidence.some((/** @type {any} */ item) => item?.quote && item?.locator)) unanchored += 1
    }
  }
  if (unanchored) {
    issues.push(notice('vcr_judgment_unanchored', `${unanchored} 条判定没有带原文位置的证据；找不到证据的条件应记为「未知」（方案 §7.1）。`,
      { path: VCR_MATCHING_FILE, check: 'vcr-matching-state-shape' }))
  }

  // Two things a reader cannot check and the bytes can (AC-14). Neither
  // recomputes the verdict — the eligibility rule has one implementation, in
  // the control plane — they check the package against itself:
  //
  //  - 「不适用」 written where a state belongs. It is an applicability field
  //    beside the judgment, and folding it in is one of the two errors
  //    TrialGPT's own error analysis names.
  //  - a package that calls a subject 「符合」 while one of its own exclusion
  //    criteria is 「未知」. That is the invariant the plan states outright,
  //    and it is decidable here without knowing anything else.
  let badState = 0
  let blockingUnknown = 0
  for (const judgment of judgments) {
    const state = String(judgment?.state ?? '')
    if (state && !VCR_CRITERION_STATES.includes(state)) badState += 1
    if (judgment?.applicable !== false && judgment?.kind === 'exclusion' && state === 'unknown') blockingUnknown += 1
  }
  if (badState) {
    issues.push(notice('vcr_judgment_state_unknown',
      `${badState} 条判定的状态不在词表里（满足 / 不满足 / 未知 / 待复评）；「不适用」是判定旁边的适用性字段，不是第五种状态（方案 §7.1）。`,
      { path: VCR_MATCHING_FILE, check: 'vcr-matching-state-shape' }))
  }
  if (blockingUnknown && assessment.summary === 'eligible') {
    issues.push(notice('vcr_summary_contradicted',
      `summary 写的是「eligible」，但有 ${blockingUnknown} 条排除标准是「未知」——任何一条排除标准未知，整体就不能判为「符合」（AC-14）。`,
      { path: VCR_MATCHING_FILE, check: 'vcr-matching-state-shape' }))
  }
  return {
    issues,
    metrics: {
      vcrJudgments: judgments.length, vcrJudgmentsUnanchored: unanchored,
      vcrJudgmentsBadState: badState, vcrBlockingUnknowns: blockingUnknown,
      vcrMatchingSummary: assessment.summary ?? null,
    },
  }
}
