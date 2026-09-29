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
import { validateRequirement } from './vcrRules.mjs'

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
  'vcr-criteria-shape',
  'vcr-package-cover',
])

/** The machine-readable result file every package ships beside its prose. */
export const VCR_RESULTS_FILE = 'results.json'
/** The simulation report's own structured companion (FDA CID checklist, plan §5.4). */
export const VCR_SIMULATION_FILE = 'simulation.json'
/** The matching assessment's structured companion (plan §7.1). */
export const VCR_MATCHING_FILE = 'matching.json'
/** The protocol step's structured eligibility criteria (plan §7.1). */
export const VCR_CRITERIA_FILE = 'criteria.json'
/** The study package's own document, whose cover states review and sealing. */
export const VCR_PACKAGE_FILE = 'study-package.md'
/**
 * Files that are the run's own back office (principle 10a): revision notes name
 * numbers being changed, not numbers being reported, so they are not read for
 * provenance.
 */
export const VCR_BACKSTAGE_FILES = Object.freeze(['revision-notes.md'])

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
  return [...files.keys()]
    .filter((path) => path.endsWith('.md') && !VCR_BACKSTAGE_FILES.includes(String(path.split('/').pop())))
    .sort()
}

/** A confidence level written as a label: 95% CI, 95%置信区间, 90 % CrI. */
const INTERVAL_LEVEL_LABEL = /\d{1,3}(?:\.\d+)?\s*%\s*(?:CI|CrI|PI|置信区间|可信区间|预测区间|蒙特卡洛区间)/gi

/**
 * Numbers a reader sees in prose, with the year-like and list-index shapes
 * dropped: a year, a section number and a percentage of a whole are not the
 * kind of number this check is about.
 * @param {string} text
 */
export function proseNumbers(text) {
  /** @type {string[]} */
  const found = []
  // 「95% CI」 and 「95%置信区间」 name the interval's level, not a result: the
  // label is read past, so the 95 in it is not a number to trace.
  const unlabelled = String(text).replace(INTERVAL_LEVEL_LABEL, ' ')
  const pattern = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![\w.])/g
  let match
  while ((match = pattern.exec(unlabelled))) {
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
  // A number that arrives as a numeric string ("0.81") is the same number to a
  // reader; a template bound to it renders it the same way.
  const numeric = typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/.test(value) ? Number(value) : value
  if (typeof numeric === 'number' && Number.isFinite(numeric)) {
    // Prose writes the magnitude and the sign apart (「偏倚 -0.12」, 「−0.12」,
    // 「下降 0.12」), and the scan reads the digits, so a negative is known by
    // its absolute value too.
    const magnitude = Math.abs(numeric)
    for (const each of numeric === magnitude ? [numeric] : [numeric, magnitude]) {
      out.add(String(each))
      out.add(String(Math.round(each)))
      for (const digits of [1, 2, 3]) out.add(each.toFixed(digits))
      out.add(String(Math.round(each)).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
      if (each > 0 && each < 1) {
        const percent = each * 100
        out.add(String(Number(percent.toFixed(6))))
        for (const digits of [0, 1, 2]) out.add(percent.toFixed(digits))
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) resultNumbers(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) resultNumbers(item, out)
  }
  return out
}

/**
 * What every package that renders from a `results.json` shares: the results
 * parse, the numbers in prose trace to them, the four counts are apart, the
 * conclusion is stated, intervals are named, assumptions are anchored. The
 * comparator and cohort packages are exactly this plus their own section.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
function packageFindings(input) {
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
    // Say which field, and what is wrong with it: 「不可估计」 is a finished
    // result and the rule that fired is what makes it one (plan §5.3).
    const present = results.notEstimableRule !== undefined && results.notEstimableRule !== null && results.notEstimableRule !== ''
    issues.push(notice('vcr_not_estimable_rule_missing',
      present
        ? `${VCR_RESULTS_FILE} 的 notEstimableRule 是「${String(results.notEstimableRule)}」，不在确定性规则的词表里（${VCR_NOT_ESTIMABLE_RULES.join(' / ')}）（方案 §5.3）。`
        : `${VCR_RESULTS_FILE} 缺 notEstimableRule 字段：结论为 not_estimable 时要写明触发的确定性规则（${VCR_NOT_ESTIMABLE_RULES.join(' / ')}）（方案 §5.3）。`,
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

/** How many findings of one kind a package reports in full before it summarises the rest. */
const FINDING_DETAIL_CAP = 5

/**
 * The criteria a protocol step wrote (`criteria.json`): every one is a
 * requirement the matching step can evaluate, kept beside the sentence it came
 * from (plan §7.1). A requirement outside the closed grammar would read 「未知」
 * for every patient without saying why, and a criterion without its source
 * sentence cannot be checked against the protocol.
 * @param {Map<string, string>} files @param {VcrIssue[]} issues @param {Record<string, unknown>} metrics
 */
function criteriaFindings(files, issues, metrics) {
  const criteria = parsed(files, VCR_CRITERIA_FILE)
  if (criteria === null) return
  if (criteria === undefined) {
    issues.push(notice('vcr_criteria_unreadable', `${VCR_CRITERIA_FILE} 不是有效的 JSON，入排条件无法核对。`, { path: VCR_CRITERIA_FILE, check: 'vcr-criteria-shape' }))
    return
  }
  const list = Array.isArray(criteria) ? criteria : Array.isArray(criteria?.criteria) ? criteria.criteria : null
  if (!list) {
    issues.push(notice('vcr_criteria_not_list', `${VCR_CRITERIA_FILE} 应是入排条件的数组。`, { path: VCR_CRITERIA_FILE, check: 'vcr-criteria-shape' }))
    return
  }
  let invalid = 0
  let unanchored = 0
  list.forEach((/** @type {any} */ criterion, /** @type {number} */ index) => {
    const at = `criteria[${index}]`
    const requirement = criterion?.requirement
    const found = requirement && typeof requirement === 'object' ? validateRequirement(requirement, { path: `${at}.requirement` }) : null
    if (!found || found.length) {
      invalid += 1
      if (invalid <= FINDING_DETAIL_CAP) {
        const first = found?.[0]
        issues.push(notice('vcr_criterion_requirement_invalid',
          `第 ${index + 1} 条入排条件的 requirement ${first ? `不符合封闭语法（${first.code}，位置 ${first.field}）` : '缺失'}；判不了的条件写成 { "op": "language", "text": "…" }（契约 §2.2）。`,
          { path: VCR_CRITERIA_FILE, check: 'vcr-criteria-shape' }))
      }
    }
    const text = typeof criterion?.sourceText === 'string' && criterion.sourceText.trim().length > 0
    const locator = criterion?.sourceLocator && typeof criterion.sourceLocator === 'object' && Object.keys(criterion.sourceLocator).length > 0
    if (!text || !locator) {
      unanchored += 1
      if (unanchored <= FINDING_DETAIL_CAP) {
        issues.push(notice('vcr_criterion_source_missing',
          `第 ${index + 1} 条入排条件缺${[!text ? '原句 sourceText' : null, !locator ? '出处 sourceLocator' : null].filter(Boolean).join('和')}：原文要照抄并指回位置，才能对照方案检查（方案 §7.1）。`,
          { path: VCR_CRITERIA_FILE, check: 'vcr-criteria-shape' }))
      }
    }
  })
  for (const [count, what] of [[invalid, 'requirement 不合语法'], [unanchored, '缺原句或出处']]) {
    if (/** @type {number} */ (count) > FINDING_DETAIL_CAP) {
      issues.push(notice('vcr_criteria_more', `另有 ${/** @type {number} */ (count) - FINDING_DETAIL_CAP} 条入排条件${what}。`, { path: VCR_CRITERIA_FILE, check: 'vcr-criteria-shape' }))
    }
  }
  metrics.vcrCriteria = list.length
  metrics.vcrCriteriaInvalid = invalid
  metrics.vcrCriteriaUnanchored = unanchored
}

/**
 * The cover of a study package states two things the reader cannot otherwise
 * see: whether anyone reviewed it, and — under a confirmatory use — when the
 * analysis plan was frozen and when the outcome was first read (plan §10.2,
 * AC-32). Both are read from the structured `results.json` the cover is
 * rendered from, never from the prose.
 * @param {Map<string, string>} files @param {any} results @param {VcrIssue[]} issues @param {Record<string, unknown>} metrics
 */
function coverFindings(files, results, issues, metrics) {
  if (!files.has(VCR_PACKAGE_FILE) || !results || typeof results !== 'object') return
  const at = { path: VCR_RESULTS_FILE, check: 'vcr-package-cover' }
  if (!results.review || typeof results.review !== 'object') {
    issues.push(notice('vcr_cover_review_missing', `封面缺复核状态：${VCR_RESULTS_FILE} 没有 review 字段；未复核也要照实写成「未复核」（方案 §10.2）。`, at))
  }
  const use = String(results.intendedUse ?? results.study?.intendedUse ?? '')
  const confirmatory = use === 'specified_analysis' || use === 'submission_preparation'
  metrics.vcrConfirmatory = confirmatory
  if (confirmatory && String(results.study?.dataTier ?? 'T1') !== 'T0') {
    const seal = results.seal && typeof results.seal === 'object' ? results.seal : {}
    for (const field of ['planFrozenAt', 'outcomeFirstReadAt']) {
      if (typeof seal[field] !== 'string' || !seal[field]) {
        issues.push(notice('vcr_cover_seal_missing',
          `确证性用途的封面要并列两个封存时间戳，${VCR_RESULTS_FILE} 的 seal.${field} 缺失（${field === 'planFrozenAt' ? '分析计划冻结时间' : '结局字段首次读取时间'}）（方案 §8.1，AC-32）。`, at))
      }
    }
  }
}

/**
 * The study package: prose plus the results it renders from, the criteria the
 * protocol step structured, and the cover's review and sealing statements.
 * @param {{ files: Map<string, string> }} input
 * @returns {VcrFindings}
 */
export function vcrStudyPackageFindings(input) {
  const base = packageFindings(input)
  const results = parsed(input.files, VCR_RESULTS_FILE)
  criteriaFindings(input.files, base.issues, base.metrics)
  coverFindings(input.files, results, base.issues, base.metrics)
  return base
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
  const base = packageFindings(input)
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
  const base = packageFindings(input)
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
