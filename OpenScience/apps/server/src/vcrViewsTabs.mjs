import { vcrPredictionLimit, VCR_EFFECT_DISCOUNT_LABEL_ZH, VCR_RESULT_QUANTITY_LABELS_ZH } from "@evimed/domain";
import { vcrPopulationGenerationInput } from "./vcrSubjects.mjs";
import { presentVcrReview } from "./vcrViewsKit.mjs";
/**
 * The six data tabs of a study page, presented (contract 2026-09-29 §5).
 *
 * Each `present*Tab` maps the rows `VcrService` gathered onto exactly the type
 * the tab's component reads (`VcrPopulationTab`, `VcrPatientsTab`,
 * `VcrComparatorTab`, `VcrTrialTab`, `VcrMatchingTab`, `VcrDataTab`). See
 * `vcrViews.mjs` for the rules all of them keep.
 *
 * Hidden knowledge:
 *
 * - **Chart series are not in the database.** The engine writes its tables as
 *   files in the run's work directory and the `results` row keeps only their
 *   names and hashes. A curve, a trajectory or a power curve is therefore drawn
 *   only from the compact summary an engine result carries in `diagnostics`
 *   (`curves`, `trajectories`, `powerCurve`, `sensitivity`, `example`), read
 *   through a shape check that drops anything malformed. Where a result has no
 *   such summary the tab has `null` and shows its empty state — a chart is
 *   never reconstructed from a number that is not a series.
 * - **A count is read, not computed.** The waterfall's kept / excluded /
 *   unknown come from the rows the population step stored; the tab sums and
 *   subtracts nothing.
 * - **Nothing here ranks patients or designs.** Candidates are listed in the
 *   deterministic order of their eligibility summary, a design is `chosen`
 *   only when a decision row says so, and a clinical priority is carried with
 *   its own label 「不是获益概率」.
 *
 * @module vcrViewsTabs
 */

import {
  VCR_COMPARABILITY_DIMENSION_LABELS_ZH, VCR_COMPARABILITY_DIMENSIONS, VCR_COMPARATOR_ROUTES, VCR_COMPARATOR_ROUTE_LABELS_ZH,
  VCR_CRITERION_TYPE_LABELS_ZH, VCR_DATA_TIERS, VCR_DATA_TIER_LABELS_ZH, VCR_E10_CONDITIONS,
  VCR_E10_CONDITION_LABELS_ZH, VCR_ELIGIBILITY_SUMMARY_LABELS_ZH,
  VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_POPULATION_KIND_LABELS_ZH, VCR_ROUTE_MIN_TIER,
  VCR_SMD_FLOOR, VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH, VCR_TWIN_LABELS_ZH, VCR_VALUE_SOURCES, VCR_ESTIMAND_LABELS_ZH,
  VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_PERFORMANCE_MEASURE_LABELS_ZH, VCR_REVIEW_KIND_LABELS_ZH, parseLineageNode,
  VCR_ANALYSIS_TABLE_LABELS_ZH, VCR_MEMBER_ROLE_LABELS_ZH, VCR_RETIRED_MEMBER_ROLE_LABELS_ZH, VCR_MISSING_REASONS, VCR_MISSING_REASON_LABELS_ZH,
  VCR_QUALITY_CATEGORY_LABELS_ZH, VCR_TIME_KINDS, VCR_TIME_KIND_LABELS_ZH, VCR_VALUE_SOURCE_LABELS_ZH,
  VCR_PROGNOSTIC_QUALIFICATION, VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH, VCR_ROBUSTNESS_STAGES, VCR_ROBUSTNESS_STAGE_LABELS_ZH,
  VCR_MODEL_RISK_RULE_LABELS_ZH, VCR_RATING_LABELS_ZH, VCR_DESIGN_SUPPORT, VCR_INTENDED_USE_LABELS_ZH, knownErrorCodeMessage, vcrAppliedDefaults,
  vcrAssessmentIssues, vcrAssessmentRows,
  VCR_EFFECT_ROLE_LABELS_ZH, VCR_RESULT_CLASSES, VCR_RESULT_CLASS_LABELS_ZH, VCR_SMD_SEVERE,
  vcrApplicability, vcrResultClass, vcrResultLimits, vcrTargetTrial, VCR_TRIAL_DESIGN_LABELS_ZH,
} from "@evimed/domain";

import { vcrObjectNode } from "./vcrStore.mjs";
import { VCR_UNSUPPORTED_COMPARATOR_ROUTES } from "./vcrService.mjs";
import { constraintRows, generatedProfileRows } from "./vcrPopulationProfileView.mjs";
import { bindingUseFindings, populationBindingPremises, populationBindingView } from "./vcrPopulationBinding.mjs";
import { comparatorOriginPremises, comparatorOrigins } from "./vcrComparatorOrigins.mjs";
import { modelUseOf, modelUsePremisesOf } from "./vcrModelUsePage.mjs";
import { vcrPopulationVariables } from "./vcrModelApplicability.mjs";
import { decidedShare } from "./vcrMatching.mjs";
import { phaseLabel, registryStatusLabel } from "./vcrPatientTrials.mjs";
import { reportSchedule } from "./vcrScheduleView.mjs";
import { finishPremises, vcrPremises } from "./vcrPremises.mjs";
import { presentPopulationCheck } from "./vcrPopulationCheck.mjs";
import { presentConfirmatoryDesigns } from "./vcrConfirmatory.mjs";
import { presentDoseDesigns } from "./vcrDoseFinding.mjs";
import { presentBayesianDesigns } from "./vcrBayesianDesign.mjs";
import { presentWinRatioDesigns } from "./vcrWinRatio.mjs";
import { presentValueOfInformation } from "./vcrValueOfInformation.mjs";
import { presentPbpkInteractions } from "./vcrPbpk.mjs";
import { presentPeopleRecords } from "./vcrPeople.mjs";
import { vcrTypeOneVerdict } from "./vcrTypeOneVerdict.mjs";
import { presentPrognosticModels } from "./vcrPrognosticTraining.mjs";
import { presentProgressions } from "./vcrProgression.mjs";
import { resultQuestionInput } from "./vcrResearchQuestionView.mjs";
import { presentEvidenceSyntheses, tauPriorWords, vcrSuccessRatesPage } from "./vcrEvidenceSynthesis.mjs";
import { presentBiasAnalysis } from "./vcrBiasAnalysis.mjs";
import { presentBorrowing } from "./vcrBorrowing.mjs";
import { evidenceValueFindings } from "./vcrValueChecks.mjs";
import { presentSplineFits } from "./vcrSplineFit.mjs";
import { presentStcComparison } from "./vcrStcComparison.mjs";
import { presentTrim } from "./vcrTrimView.mjs";
import { presentImputation } from "./vcrImputationView.mjs";
import { presentTargetTrial } from "./vcrTargetTrialView.mjs";
import { localCalibrationView } from "./vcrLocalCalibration.mjs";
import {
  abilitiesOf, assumptionSummary, assumptionValue, designsSentence, nodeLabel, notEstimableDesign, presentDesigns, reviewContextOf,
  presentModelCard, registryDesignWords, resultNode, scenarioName, simonBoundaryText, valueString,
} from "./vcrViews.mjs";
import {
  allResultsOf, countsView, finite, intervalView, list, markFor, measureLabel, measureValue, naturalScale, numeric, object,
  personName, plainText, PARAMETER_LABELS, METHOD_LABELS, roundTo, scaledSeries, staleNote, text, zhDate, zhTime, VCR_ROBUSTNESS_MEASURES,
  TIME_UNIT_WORDS, zhUnit, vcrFailureSentence, vcrPageSentence, hazardLawWords,
} from "./vcrViewsKit.mjs";

/** A plain value (a number or `{ value, unit, … }` a row stored) as a page value. @param {unknown} raw @param {Record<string, any>} defaults */
function plainValue(raw, defaults) {
  const entry = object(raw);
  const value = typeof raw === "number" ? finite(raw) : finite(entry.value);
  const source = (/** @type {readonly string[]} */ (VCR_VALUE_SOURCES)).includes(String(entry.source)) ? String(entry.source) : defaults.source;
  return {
    value,
    text: value === null ? "—" : null,
    unit: text(entry.unit) ?? defaults.unit ?? null,
    source,
    interval: intervalView(entry.interval),
    mcse: finite(entry.mcse),
    review: defaults.review ?? null,
    precision: finite(entry.precision) ?? defaults.precision ?? null,
    reason: null,
    stale: defaults.stale === true,
    detail: null,
  };
}

/** The result a row points at, among the study's current results. @param {Record<string, any>} bundle @param {string | null | undefined} id */
const resultById = (bundle, id) => (id ? allResultsOf(bundle).find((/** @type {any} */ result) => result.id === id) ?? null : null);

/** The execution of a result. @param {Record<string, any>} bundle @param {Record<string, any> | null} result */
const executionOf = (bundle, result) => (result?.executionId ? bundle.executions.get(result.executionId) ?? null : null);

/**
 * A series drawn from an engine result's own summary — or nothing. A point
 * needs a finite x; a series needs a key, a label and at least one point.
 * @param {unknown} raw
 */
export function seriesView(raw) {
  const entry = object(raw);
  const points = list(entry.points).map((point) => {
    const row = object(point);
    const x = finite(row.x);
    if (x === null) return null;
    return { x, y: finite(row.y), low: finite(row.low), high: finite(row.high) };
  }).filter((point) => point !== null);
  const key = text(entry.key);
  const label = text(entry.label);
  if (!key || !label || !points.length) return null;
  const source = (/** @type {readonly string[]} */ (VCR_VALUE_SOURCES)).includes(String(entry.source)) ? String(entry.source) : "predicted";
  return {
    key, label, source, ours: entry.ours === true, pooled: entry.pooled === true, points,
    bandKind: text(entry.bandKind), bandLevel: finite(entry.bandLevel), endLabel: text(entry.endLabel), endNote: text(entry.endNote),
    atRisk: list(entry.atRisk).map((row) => ({ x: finite(object(row).x), n: finite(object(row).n) })).filter((row) => row.x !== null && row.n !== null),
    individuals: list(entry.individuals).map((line) => list(line).map((point) => ({ x: finite(object(point).x), y: finite(object(point).y) }))
      .filter((point) => point.x !== null)).filter((line) => line.length > 1),
    dashed: entry.dashed === true,
    unobserved: list(entry.unobserved).map((span) => ({ from: finite(object(span).from), to: finite(object(span).to) })).filter((span) => span.from !== null && span.to !== null),
  };
}

/** @param {unknown} raw */
const seriesList = (raw) => list(raw).map(seriesView).filter((series) => series !== null);

/**
 * What a result that stopped before it was finished says, as the one sentence its tab prints over the part that is there.
 *
 * It names the computation (`what`: 「这次模拟」), how far it got when the engine counted replicates, and why it stopped — the spent
 * compute time, a cancel, or no stated reason — in words of ours: the engine's own note (an English sentence in `diagnostics.issues`) is
 * never passed through, it stays in the record. What was kept is said by the tab showing it, so the sentence ends by pointing there.
 * @param {Record<string, any>} bundle @param {readonly string[]} kinds @param {string} what 「这次模拟」 / 「这次生成」 / 「这次分析」
 * @returns {{ sentence: string } | null}
 */
function partialOf(bundle, kinds, what) {
  const result = bundle.results.find((/** @type {any} */ entry) => kinds.includes(entry.kind) && object(entry.diagnostics).partial === true);
  if (!result) return null;
  const diagnostics = object(result.diagnostics);
  const done = numeric(diagnostics.replicatesCompleted);
  const planned = numeric(diagnostics.replicatesPlanned);
  const spent = list(diagnostics.issues).some((/** @type {any} */ issue) => object(issue).code === "cpu_budget_exhausted");
  const stopped = diagnostics.canceled === true ? "被取消了" : spent ? "到了计算时间上限" : "停下了";
  const reached = done !== null && planned !== null ? `算完了 ${done.toLocaleString("en-US")} / ${planned.toLocaleString("en-US")} 次重复` : "只算出了一部分";
  return { sentence: `${what}${reached}就${stopped}，下面是已完成部分的结果。` };
}

// --- 人群 ---------------------------------------------------------------------------------------------------------------------

/** The label code of a protocol criterion (I1…, E1…), by its kind and position. @param {readonly Record<string, any>[]} criteria */
export function criterionCodes(criteria) {
  /** @type {Map<string, string>} */
  const codes = new Map();
  let inclusion = 0;
  let exclusion = 0;
  for (const criterion of [...criteria].sort((a, b) => Number(a.ordinal) - Number(b.ordinal))) {
    codes.set(criterion.id, criterion.kind === "exclusion" ? `E${++exclusion}` : `I${++inclusion}`);
  }
  return codes;
}

/** @param {Record<string, any>} entry @param {number} index */
function waterfallEntry(entry, index) {
  const row = object(entry);
  // The engine's own steps name the rule they applied (`rule`); a rule written from a criterion is named by its code (「I1」, 「E2」).
  const rule = text(row.rule);
  return {
    key: text(row.key) ?? text(row.criterionId) ?? text(row.code) ?? rule ?? `step_${index}`,
    label: text(row.label) ?? text(row.step) ?? text(row.name) ?? rule ?? `第 ${index + 1} 步`,
    code: text(row.code) ?? (rule && /^[IE]\d+$/.test(rule) ? rule : null),
    criterionId: text(row.criterionId),
    ordinal: numeric(row.ordinal),
    denominator: numeric(row.denominator),
    grain: text(row.grain),
    indeterminateTreatment: text(row.indeterminateTreatment),
    remaining: numeric(row.remaining ?? row.kept ?? row.n),
    kept: numeric(row.kept ?? row.remaining),
    unknown: numeric(row.unknown ?? row.indeterminate),
    removed: numeric(row.removed ?? row.excluded),
    reasons: list(row.unknownReasons),
  };
}

/** The population profile's rows, in whatever list the population step stored them. @param {Record<string, any>} profile */
const profileRows = (profile) => list(profile.rows ?? profile.covariates ?? (Array.isArray(profile) ? profile : []));

/** The groups the engine cuts a column that is a number into when it describes the records easiest to recognise, and the group of a missing value, as the page says them. */
const AT_RISK_LEVEL_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ "low third": "最低的三分之一", "middle third": "中间的三分之一", "high third": "最高的三分之一", "(missing)": "缺失" }));

/**
 * The quality report as values, with no verdict word: the fixed metric set the
 * engine reports (fidelity, utility, leakage), each number with its source, and
 * the generator's training-record and copy counts (plan §5.1).
 * @param {Record<string, any>} quality
 */
export function qualityReportView(quality) {
  const report = object(quality);
  if (!Object.keys(report).length) return null;
  /** @param {string} key @param {string} label @param {unknown} raw @param {string} [unit] */
  const row = (key, label, raw, unit = "") => {
    const value = numeric(raw);
    return value === null ? null : { key, label, value: plainValue({ value, unit: unit || undefined }, { source: "synthetic", precision: null }) };
  };
  const univariate = list(object(report.fidelity).univariate).map(object);
  const ks = univariate.filter((entry) => entry.statistic === "ks_d").map((entry) => numeric(entry.value)).filter((value) => value !== null);
  const tvd = univariate.filter((entry) => entry.statistic === "tvd").map((entry) => numeric(entry.value)).filter((value) => value !== null);
  const missing = univariate.map((entry) => numeric(entry.missingRateDifference)).filter((value) => value !== null);
  const pairwise = list(object(report.fidelity).pairwise).map((entry) => numeric(object(entry).value)).filter((value) => value !== null);
  const global = object(object(report.fidelity).global);
  const unavailable = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ message) =>
    ({ key, label, value: { ...plainValue({}, { source: "synthetic", precision: null }), text: message } });
  const qualityBands = object(report.bands);
  const hasRedBand = Object.values(qualityBands).some((band) => band === "red");
  const designColumns = numeric(global.designColumns), designRows = numeric(global.n);
  const propensityUnavailable = global.available === false || qualityBands.sPMSE === "unknown" || qualityBands.propensityAuc === "unknown";
  const unavailableText = global.available === false
    ? `未计算：设计规模或数据条件不满足${designRows !== null && designColumns !== null ? `（${designRows} 行、${designColumns} 列）` : ""}`
    : "未计算：原因未记录";
  const disclosure = object(report.disclosure);
  const feasibility = object(object(report.utility).feasibility);
  const specific = Object.values(object(object(report.utility).specific)).map(object);
  const violations = list(object(report.constraints).violations ?? report.constraints).map((entry) => numeric(object(entry).violations)).filter((value) => value !== null);
  const generator = object(report.generator);
  const copiesReleased = numeric(object(report.release).copies);
  // 1.1.0 (P1, P2): the copies combined by the rules for synthetic data, the false-positive rate of an analysis on the generator's own copies, the records easiest to recognise
  const inference = object(report.inference);
  const calibration = object(inference.nullCalibration);
  const percent = (/** @type {string} */ key, /** @type {string} */ label, /** @type {Record<string, any>} */ rate) => {
    const value = numeric(rate.value);
    if (value === null) return null;
    const mcse = numeric(rate.mcse);
    return { key, label, value: { ...plainValue({ value: value * 100, unit: "%" }, { source: "synthetic", precision: 1 }), mcse: mcse === null || mcse === 0 ? null : mcse * 100 } };
  };
  const withheld = (/** @type {string} */ key, /** @type {string} */ label) => ({ key, label, value: { ...plainValue({}, { source: "synthetic", precision: null }), text: "少于 10 条（不显示）" } });
  const combinedRows = specific.flatMap((entry, index) => {
    const combined = object(entry.combined);
    if (combined.available !== true) return [];
    const interval = list(combined.interval).map(numeric);
    return [{ key: `combined_${index}`, label: `${text(entry.analysis) ?? "分析"}：${numeric(combined.copies)} 份合并后的估计`,
      value: { ...plainValue({ value: numeric(combined.estimate), interval: interval.length === 2 && interval.every((bound) => bound !== null) ? { kind: "confidence", low: interval[0], high: interval[1], level: 0.95 } : undefined }, { source: "synthetic", precision: null }) } }];
  });
  const overlapRow = (/** @type {Record<string, any>} */ entry, /** @type {number} */ index) => row(`overlap_${index}`, `${text(entry.analysis) ?? "分析"}：置信区间重叠`, object(entry.combined).confidenceIntervalOverlap ?? entry.confidenceIntervalOverlap);
  const perRecord = object(disclosure.perRecord);
  const stated = list(perRecord.riskShares).map(object).find((share) => share.stated === true);
  const attribute = object(disclosure.attributeInference);
  const worstAttribute = list(attribute.secrets).map(object).sort((a, b) => (numeric(b.riskLow) ?? -1) - (numeric(a.riskLow) ?? -1))[0] ?? null;
  const boundWords = stated ? `${numeric(stated.bound)}` : "";
  const groups = [
    { key: "fidelity", label: "保真度", rows: [
      ks.length ? row("ks", "最大 KS 距离", Math.max(...ks)) : null,
      tvd.length ? row("tvd", "最大总变异距离", Math.max(...tvd)) : null,
      missing.length ? row("missing", "缺失率的最大差", Math.max(...missing)) : null,
      pairwise.length ? row("pairwise", "相关结构的最大差", Math.max(...pairwise)) : null,
      propensityUnavailable && numeric(global.sPMSE) === null ? unavailable("spmse", "标准化 pMSE", unavailableText) : row("spmse", "标准化 pMSE", global.sPMSE),
      propensityUnavailable && numeric(global.propensityAuc) === null ? unavailable("auc", "区分真假记录的 AUC", unavailableText) : row("auc", "区分真假记录的 AUC", global.propensityAuc),
      hasRedBand ? unavailable("quality_alert", "质量检查提示", "部分质量指标超出提示范围；计算完成不代表质量结论") : null,
    ].filter((entry) => entry !== null) },
    { key: "utility", label: "可用性", rows: [
      row("joint", "入排通过率的相对差", feasibility.jointPassRateRelativeDifference),
      ...combinedRows,
      ...specific.map(overlapRow),
      violations.length ? row("violations", "硬约束违反的记录数", violations.reduce((sum, value) => sum + value, 0)) : null,
    ].filter((entry) => entry !== null) },
    { key: "inference", label: "推断是否可信", rows: calibration.available === true ? [
      percent("fp_real", "把臂标签打乱后，直接在真实表上做这个分析，误判有效的概率", object(calibration.realPermuted)),
      percent("fp_naive", "把合成表的第 1 份当真实数据做同一个分析，误判有效的概率", object(calibration.syntheticNaive)),
      percent("fp_combined", "合成表各份按规则合并后，误判有效的概率", object(calibration.syntheticCombined)),
    ].filter((entry) => entry !== null) : [] },
    { key: "leakage", label: "泄露风险", rows: disclosure.available === false ? [] : [
      row("replication", "复制率（相对留出集）", disclosure.replicationRatio),
      row("nn", "最近邻落在训练集的比例", disclosure.nearestNeighbourInTrainShare),
      row("membership", "成员推断 AUC", disclosure.membershipAuc),
      row("dcr", "到最近训练记录的距离（中位）", disclosure.dcrMedian ?? disclosure.medianDcr),
      stated && stated.trainingShare !== undefined ? (numeric(stated.trainingShare) === null ? withheld("risk_share", `真实记录里被认出来的风险高于 ${boundWords} 的`) : percent("risk_share", `真实记录里被认出来的风险高于 ${boundWords} 的占比`, { value: stated.trainingShare })) : null,
      stated && perRecord.available === true && stated.holdoutShare !== undefined ? (numeric(stated.holdoutShare) === null ? withheld("risk_share_holdout", "没进过数据的留出记录里同样高风险的（碰巧会有的水平）") : percent("risk_share_holdout", "没进过数据的留出记录里同样高风险的占比（碰巧会有的水平）", { value: stated.holdoutShare })) : null,
      worstAttribute ? percent("attribute_inference", "属性推断：最危险的一列比从没进过数据的人多猜对的部分", { value: Math.max(0, numeric(worstAttribute.risk) ?? 0) }) : null,
    ].filter((entry) => entry !== null) },
  ].filter((group) => group.rows.length);
  if (!groups.length && !Object.keys(generator).length) return null;
  const atRisk = object(perRecord.atRiskGroup);
  return {
    tag: "合成 · 探索性",
    groups,
    // 「哪些人最容易被认出来」: the kind of person the at-risk group is, by the share of each level in it; counts of 1 to 9 people are never shown and no row ever is
    atRisk: perRecord.available === true && stated ? {
      bound: numeric(stated.bound), size: numeric(atRisk.size), rows: list(atRisk.rows).map(object).map((entry) => ({
        variable: text(entry.variable) ?? "", level: AT_RISK_LEVEL_WORDS[String(entry.level)] ?? text(entry.level) ?? "", atRisk: numeric(entry.atRisk), all: numeric(entry.all),
        atRiskShare: numeric(entry.atRiskShare) === null ? null : numeric(entry.atRiskShare) * 100, allShare: numeric(entry.allShare) === null ? null : numeric(entry.allShare) * 100,
      })).filter((entry) => entry.variable && entry.level),
      described: atRisk.size !== undefined,
    } : null,
    // How the copies were combined, in a sentence the reader can check
    rule: inference.rule ? (inference.rule === "proper_synthesis"
      ? `合成表的 ${numeric(inference.copies) ?? "?"} 份按 Raab 等人的规则合并（每份都重新抽过参数）：方差里加上了生成模型本身的抽样误差。`
      : `合成表的 ${numeric(inference.copies) ?? "?"} 份按 Raab 等人的规则合并（每份用同一组参数）：方差里加上了生成模型本身的抽样误差，直接把一份当真实数据分析会低估它。`) : null,
    trainingRecords: numeric(generator.trainingObservations ?? generator.trainingRecords),
    copies: numeric(generator.syntheticCopies ?? generator.copies ?? generator.m),
    // Which table each group of numbers describes, when the generator made several copies and the release holds them all: the
    // hard-constraint count and the leakage rows read every copy stacked, the fidelity and utility rows the first.
    scope: copiesReleased !== null && copiesReleased > 1
      ? `硬约束与泄露检查读的是发布的全部 ${copiesReleased} 份合成记录（叠在一起）；保真度与可用性描述第 1 份，其余各份的数值在逐份评分里。` : null,
  };
}

/**
 * `GET /api/vcr/studies/:id/population`.
 * @param {Record<string, any>} bundle
 */
export function presentPopulationTab(bundle) {
  const { study, populations, stale, protocol, criteria } = bundle;
  const current = populations[0] ?? null;
  const result = current ? resultById(bundle, current.resultId) : null;
  const marks = current ? [markFor(stale, vcrObjectNode("population", current)), result ? markFor(stale, resultNode(result)) : null] : [];
  const codes = criterionCodes(criteria);
  // What the engine wrote beside the table is what the tab reads: the population row carries what was written when the object was, and
  // nothing copies a finished job's waterfall, counts or quality back onto it.
  const diagnostics = object(result?.diagnostics);
  const rowOrResult = (/** @type {unknown} */ held, /** @type {unknown} */ computed) => (Array.isArray(held) ? held.length : Object.keys(object(held)).length) ? held : computed;
  const waterfall = current ? rowOrResult(current.waterfall, diagnostics.waterfall) : [];
  const heldCounts = current ? rowOrResult(current.counts, result?.counts) : {};
  const steps = current ? list(waterfall).map(waterfallEntry) : [];
  const byCriterion = (/** @type {any} */ criterion) => steps.find((entry) => entry.criterionId === criterion.id || entry.code === codes.get(criterion.id)
    || (entry.ordinal !== null && entry.ordinal === Number(criterion.ordinal)));
  const kindSource = current ? ({ real: "observed", literature: "aggregate", scenario: "assumed", empirical_synthetic: "synthetic" }[/** @type {"real"} */ (current.kind)] ?? "assumed") : "assumed";
  const review = current?.reviewState ?? null;
  const view = current ? {
    version: `人群 v${current.version}${protocol ? `（方案 v${protocol.version}）` : ""}`,
    kind: (/** @type {Record<string, string>} */ (VCR_POPULATION_KIND_LABELS_ZH))[current.kind] ?? current.kind,
    versions: populations.map((/** @type {any} */ population) => ({
      id: population.id, version: population.version, ...(population.resultId ? { resultId: population.resultId, resultVersion: resultById(bundle, population.resultId)?.version } : {}),
      generationInput: vcrPopulationGenerationInput(population, resultById(bundle, population.resultId), executionOf(bundle, resultById(bundle, population.resultId))),
      label: `人群 v${population.version}`,
      stale: Boolean(markFor(stale, vcrObjectNode("population", population))),
      counts: countsView(population.counts, { tier: study.dataTier }),
    })),
    definition: (() => {
      const definition = object(current.definition);
      const has = ["timeZero", "evidenceWindow", "exit", "protocol"].some((key) => text(definition[key]));
      return has ? {
        timeZero: text(definition.timeZero), evidenceWindow: text(definition.evidenceWindow),
        exit: text(definition.exit), protocol: text(definition.protocol) ?? (protocol ? `方案 v${protocol.version}` : null),
      } : null;
    })(),
  } : { version: null, kind: null, versions: [], definition: null };
  // The criteria a coverage check could not put to this data (no column, an event only a record can carry): not in the count, said by name.
  const notEvaluated = new Map(list(object(object(current?.profile).coverage).notEvaluated).map(object).map((entry) => [String(entry.code), text(entry.why)]));
  const rows = criteria.map((/** @type {any} */ criterion) => {
    const entry = byCriterion(criterion);
    return {
      id: criterion.id,
      code: codes.get(criterion.id) ?? "",
      notEvaluated: notEvaluated.get(codes.get(criterion.id) ?? "") ?? null,
      name: (/** @type {Record<string, string>} */ (VCR_CRITERION_TYPE_LABELS_ZH))[criterion.criterionType] ?? "其他",
      quote: text(criterion.sourceText),
      quoteSource: vcrLocatorText(criterion.sourceLocator),
      kind: criterion.kind,
      kept: entry?.kept ?? null,
      excluded: entry?.removed ?? null,
      unknown: entry?.unknown ?? null,
      source: "extracted",
      changed: null,
    };
  });
  const outcomeCounts = object(heldCounts);
  // A cohort the engine built says it in measures: everyone who met every rule, everyone who met or could not be judged on each, and
  // how many were looked at.
  const cohortMeasure = (/** @type {string} */ name) => numeric(object(list(result?.measures).find((entry) => object(entry).name === name)).value);
  const strict = cohortMeasure("cohort_size_strict");
  const lenient = cohortMeasure("cohort_size_lenient");
  const looked = numeric(diagnostics.startingRows);
  const outcome = current && (numeric(outcomeCounts.eligible ?? outcomeCounts.kept) !== null
    || numeric(outcomeCounts.insufficient ?? outcomeCounts.indeterminate) !== null || numeric(outcomeCounts.ineligible ?? outcomeCounts.excluded) !== null)
    ? {
      eligible: numeric(outcomeCounts.eligible ?? outcomeCounts.kept),
      insufficient: numeric(outcomeCounts.insufficient ?? outcomeCounts.indeterminate),
      ineligible: numeric(outcomeCounts.ineligible ?? outcomeCounts.excluded),
    } : (strict !== null && lenient !== null && looked !== null ? { eligible: strict, insufficient: lenient - strict, ineligible: looked - lenient } : null);
  const profile = object(current?.profile);
  // A generated population is described variable by variable by the engine (`diagnostics.profile`) and, for one the engine wrote no
  // profile for, from its stored table on read — deterministic, the same shape, never a request to generate it again. A real cohort
  // is compared with the published one, row by row.
  const violations = diagnostics.constraintViolations;
  const generated = current && current.kind !== "real"
    ? generatedProfileRows(diagnostics.profile, violations) ?? generatedProfileRows(bundle.table?.profile, violations) : null;
  const profileView = generated ?? profileRows(profile).map((entry, index) => {
    const row = object(entry);
    const smd = finite(row.smd ?? row.smdAdjusted);
    return {
      key: text(row.key) ?? `row_${index}`,
      label: text(row.label) ?? text(row.covariate) ?? `特征 ${index + 1}`,
      ours: plainValue(row.ours, { source: kindSource, unit: text(row.unit), review, stale: false }),
      theirs: plainValue(row.theirs, { source: "aggregate", unit: text(row.unit), review: null, stale: false }),
      smd,
      flagged: smd !== null && Math.abs(smd) > VCR_SMD_FLOOR,
      note: text(row.note),
    };
  });
  // What limits a cohort is what each rule would do on its own, not what is left for it after the rules before it: the engine states
  // both, and the independent count is the one that ranks.
  const impact = new Map(list(diagnostics.criterionImpact).map(object).map((entry) => [String(entry.rule), entry]));
  const alone = (/** @type {Record<string, any>} */ row) => {
    const own = impact.get(row.code);
    return own ? { excluded: numeric(own.failsAlone) ?? 0, unknown: numeric(own.indeterminateAlone) ?? 0 } : { excluded: row.excluded ?? 0, unknown: row.unknown ?? 0 };
  };
  const blockers = rows
    .map((full) => { const row = { ...full, ...alone(full) }; return { row, hit: row.excluded + row.unknown }; })
    .filter((entry) => entry.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, 3)
    .map(({ row }) => ({
      code: row.code, label: row.name, quote: row.quote,
      text: (row.unknown ?? 0) >= (row.excluded ?? 0) ? `无法判断 ${row.unknown}` : `排除 ${row.excluded}`,
      tone: (row.unknown ?? 0) >= (row.excluded ?? 0) ? "attention" : "neutral",
    }));
  /** @type {Map<string, { key: string, label: string, detail: string | null, count: number }>} */
  const reasons = new Map();
  for (const step of steps) {
    for (const reason of step.reasons) {
      const item = object(reason);
      const key = text(item.key) ?? text(item.reason) ?? text(item.label);
      const count = numeric(item.count);
      if (!key || count === null) continue;
      const found = reasons.get(key) ?? { key, label: text(item.label) ?? key, detail: text(item.detail), count: 0 };
      found.count += count;
      reasons.set(key, found);
    }
  }
  const binding = current ? populationBindingView(current, { patientSets: bundle.patientSets, models: bundle.models, populations, diagnostics, counts: heldCounts,
    endpointType: bundle.definition?.endpointType ?? null }) : null;
  const first = steps[0];
  const total = numeric(first?.remaining) ?? numeric(current?.counts?.realPatients);
  return {
    version: view.version,
    selection: current ? { objectId: current.id, version: current.version, ...(result ? { resultId: result.id, resultVersion: result.version } : {}) } : null,
    kind: view.kind,
    // What the study called this population: 「按方案条件查覆盖」 for the one made from the protocol's own criteria.
    name: current ? text(current.name) : null,
    versions: view.versions,
    definition: view.definition,
    criteria: rows,
    attrition: steps.map((step) => ({
      key: step.key, label: step.label, code: step.code ?? (step.criterionId ? codes.get(step.criterionId) ?? null : null),
      remaining: step.remaining, unknown: step.unknown, removed: step.removed,
    })),
    outcome,
    profile: profileView,
    // `generated`: one row per variable, set beside what came out of it (what it declared and how many records broke it);
    // `comparison`: ours against the published cohort.
    profileKind: generated ? "generated" : profileView.length ? "comparison" : null,
    // The generated records as a list: how many, and the result the rows route reads (`GET …/population/rows?result=`). Absent
    // where the table is a real cohort's or is not kept.
    records: bundle.table && current && current.kind !== "real" ? { result: bundle.table.result, rows: bundle.table.rows } : null,
    // Only the rules no variable carries: a variable's own constraints are on its row (`violations`).
    constraints: current && current.kind !== "real" ? constraintRows(diagnostics.constraintViolations)
      .filter((row) => !profileView.some((entry) => list(object(entry.declared).constraints).some((constraint) => object(constraint).name === row.label))) : [],
    unknownReasons: [...reasons.values()].map((reason) => ({ key: reason.key, label: reason.label, detail: reason.detail, count: reason.count })),
    blockers,
    quality: current ? qualityReportView(Object.keys(object(current.quality)).length ? current.quality : diagnostics.quality) : null,
    // The generated population against a second baseline table (D2): the newest check filed under this population, when there is one.
    check: current ? presentPopulationCheck(allResultsOf(bundle).find((/** @type {any} */ entry) => entry.kind === "population_check" && entry.subjectId === current.id && !entry.supersededBy),
      { currentResultId: current.resultId ?? null }) : null,
    // 「这个结论的前提」 of a generated population: how its variables relate, how far it is the source trial's, how far its parameters moved.
    premises: current ? finishPremises([
      ...vcrPremises("population", { kind: current.kind, diagnostics, researchQuestion: resultQuestionInput(bundle, list(bundle.allResults ?? bundle.results).find((/** @type {any} */ row) => row.id === current.resultId) ?? null), modelUse: bindingUseFindings(binding, bundle.models, current) }),
      ...populationBindingPremises(binding),
    ]) : [],
    binding: binding ? {
      origin: binding.origin, originLabel: binding.originLabel, readiness: binding.readiness, model: binding.bound?.title ?? null,
      staleResults: binding.bindings.filter((entry) => entry.state !== "current").length + binding.earlier.length,
      members: binding.members,
    } : null,
    counts: current ? countsView(result?.counts && Object.keys(result.counts).length ? result.counts : current.counts, { tier: study.dataTier }) : null,
    conclusion: result?.conclusion ?? null,
    headline: outcome && total !== null && outcome.eligible !== null && outcome.insufficient !== null
      ? `按${protocol ? `方案 v${protocol.version}` : "当前方案"}，${total.toLocaleString("en-US")} 人中 ${outcome.eligible.toLocaleString("en-US")} 人全部满足、${outcome.insufficient.toLocaleString("en-US")} 人至少 1 条无法判断。`
      : null,
    stale: staleNote(marks),
    partial: partialOf(bundle, ["population"], "这次生成"),
    ...(bundle.knowledge ? { knowledge: bundle.knowledge } : {}),
  };
}

/**
 * 「第 12 页」 from a stored locator. A criterion taken from the study's knowledge pack says so, and nothing more of the pack: whether
 * the pack was drafted by a model or curated is the platform's own record (owner ruling 2026-10-10), not a label on the quotation.
 * @param {unknown} raw
 */
export function vcrLocatorText(raw) {
  const locator = object(raw);
  const parts = [];
  if (text(locator.pack)) parts.push("知识包");
  if (locator.page != null) parts.push(`第 ${locator.page} 页`);
  if (text(locator.section)) parts.push(String(locator.section));
  if (text(locator.table)) parts.push(String(locator.table));
  return parts.length ? parts.join("，") : null;
}

// --- 虚拟患者 -----------------------------------------------------------------------------------------------------------------

/**
 * The study's model assessment records (ICH M15 Appendix 1) as the page reads them: each record's rows in the guideline's order
 * with the rating and the reason, the model risk the platform derived and the one rule that settled it, who wrote this version
 * (a run, or a person by name), what the record has not said yet, and the fields the lead's edit form starts from. The frozen
 * model analysis plan, when there is one, is named so the page can say an edit does not move it.
 * @param {Record<string, any>} bundle
 */
export function presentModelAssessments(bundle) {
  const frozen = bundle.modelPlan ? object(bundle.modelPlan) : null;
  return {
    records: list(bundle.assessments).slice(0, 30).map((/** @type {any} */ record) => {
      const rule = text(record.riskRule);
      const by = text(record.by);
      // The library's own title for the model the record is about (a record names a model and, when it knows, its version): a reader
      // is told 「事件时间终点参考仿真器」, not the id the engine files it under. A model the library no longer holds keeps its id.
      const held = list(bundle.models).find((/** @type {any} */ model) => model.name === record.modelName
        && (!record.modelVersion || model.version === record.modelVersion));
      return {
        key: String(record.key), version: Number(record.version) || 1,
        modelName: String(record.modelName ?? ""), modelVersion: String(record.modelVersion ?? ""),
        modelTitle: text(object(held?.card).title) ?? String(record.modelName ?? ""),
        risk: text(record.risk), riskLabel: text(record.risk) ? (/** @type {Record<string, string>} */ (VCR_RATING_LABELS_ZH))[String(record.risk)] ?? null : null,
        riskRule: rule, riskRuleText: rule ? (/** @type {Record<string, string>} */ (VCR_MODEL_RISK_RULE_LABELS_ZH))[rule] ?? null : null,
        // The risk row's reason is the author's own; the rule that fired is said once, beside the risk.
        rows: vcrAssessmentRows(record, "submission").map((row) => ({
          key: row.key, label: row.zh, rated: row.rated, derived: row.key === "risk",
          rating: row.rating, ratingLabel: row.rating ? (/** @type {Record<string, string>} */ (VCR_RATING_LABELS_ZH))[row.rating] ?? null : null,
          entry: row.entry, justification: row.key === "risk" ? String(record.riskJustification ?? "") : row.justification,
        })),
        savedBy: !by ? null : by === "runtime" ? { kind: "run", name: "AI" } : { kind: "person", name: personName(bundle.people, by) },
        savedAt: zhDate(record.createdAt, bundle.now),
        gaps: vcrAssessmentIssues(record, "planning").map((found) => found.text),
        fields: {
          questionOfInterest: String(record.questionOfInterest ?? ""), contextOfUse: String(record.contextOfUse ?? ""),
          influence: String(record.influence ?? ""), influenceJustification: String(record.influenceJustification ?? ""),
          consequence: String(record.consequence ?? ""), consequenceJustification: String(record.consequenceJustification ?? ""),
          riskJustification: String(record.riskJustification ?? ""),
          impact: String(record.impact ?? ""), impactJustification: String(record.impactJustification ?? ""),
          technicalCriteria: list(record.technicalCriteria).map((/** @type {any} */ entry) => ({ criterion: String(entry.criterion ?? ""), rationale: String(entry.rationale ?? "") })),
          appropriateness: String(record.appropriateness ?? ""), evaluation: String(record.evaluation ?? ""), outcome: String(record.outcome ?? ""),
        },
      };
    }),
    plan: frozen ? { version: Number(frozen.version) || 1, frozenAt: zhDate(frozen.frozenAt, bundle.now) } : null,
  };
}

/**
 * `GET /api/vcr/studies/:id/patients`.
 * @param {Record<string, any>} bundle
 */
export function presentPatientsTab(bundle) {
  const { study, patientSets, models, stale } = bundle;
  const current = patientSets[0] ?? null;
  const result = current ? resultById(bundle, current.resultId) : null;
  const marks = current ? [markFor(stale, vcrObjectNode("patient_set", current)), result ? markFor(stale, resultNode(result)) : null] : [];
  const modelRow = current ? models.find((/** @type {any} */ model) => model.name === current.modelId || model.id === current.modelId) ?? null : null;
  const model = modelRow ? presentModelCard(modelRow, []) : null;
  const diagnostics = object(result?.diagnostics);
  const execution = executionOf(bundle, result);
  const trajectories = object(diagnostics.trajectories);
  const example = object(diagnostics.example);
  const sensitivity = object(diagnostics.sensitivity);
  const trajectorySeries = seriesList(trajectories.series);
  const panels = list(diagnostics.panels).map((panel, index) => {
    const entry = object(panel);
    return {
      key: text(entry.key) ?? `panel_${index}`,
      title: text(entry.title) ?? "",
      kind: entry.kind === "time_to_event" ? "time_to_event" : "binary",
      note: text(entry.note) ?? "模型预测，非观察",
      rows: list(entry.rows).map((row) => ({ label: text(object(row).label) ?? "", value: plainValue(object(row).value, { source: "predicted", unit: text(object(object(row).value).unit), review: result?.reviewState ?? null }) })),
      series: seriesList(entry.series),
      footnote: text(entry.footnote),
    };
  }).filter((panel) => panel.title);
  // The measures of the run itself are panel rows too: the numbers the engine
  // computed for this patient set, each with its source and error.
  const measureRows = result ? list(result.measures).map((measure) => ({
    label: measureLabel(String(object(measure).name)),
    value: measureValue(measure, { kind: "patient_set", result, execution, staleMark: marks[1], context: {}, tab: "patients" }),
  })) : [];
  if (measureRows.length) {
    panels.unshift({ key: "run_measures", title: "这次运行的结果", kind: "binary", note: "模型预测，非观察", rows: measureRows, series: [], footnote: null });
  }
  // The generated people: how many and in which arms, how each variable is distributed, and what was generated beside what the study
  // declared — all read from the table itself (`bundle.table`), so the page has patients and not one example.
  const table = bundle.table ?? null;
  const described = table ? generatedProfileRows(table.profile) : null;
  return {
    model,
    // 「这个结论的前提」 of a model-based result: what the model was and was not validated for, in the same block as every other page's
    premises: modelRow ? modelUsePremisesOf(models, modelRow, { endpoint: text(diagnostics.endpoint) ?? text(bundle.definition?.endpointType), mode: "conditional_forecast",
      variables: vcrPopulationVariables(list(bundle.populations).find((/** @type {any} */ row) => row.id === current?.populationId) ?? null) }) : [],
    selection: current ? { objectId: current.id, version: current.version, ...(result ? { resultId: result.id, resultVersion: result.version } : {}) } : null,
    records: table ? { result: table.result, rows: table.rows, arms: list(table.calibration?.arms) } : null,
    profile: described ?? [],
    profileKind: described ? "generated" : null,
    calibration: table?.calibration ? { endpoint: table.calibration.endpoint, rows: table.calibration.rows } : null,
    assessments: presentModelAssessments(bundle),
    twin: modelRow || current?.twinLabel ? {
      label: (/** @type {Record<string, string>} */ (VCR_TWIN_LABELS_ZH))[String(current?.twinLabel ?? model?.twin ?? "baseline_conditioned_prediction")],
      reason: model?.twinReason ?? null,
    } : null,
    headline: text(diagnostics.headline),
    trajectories: trajectorySeries.length ? {
      xLabel: text(trajectories.xLabel), yLabel: text(trajectories.yLabel), ticks: list(trajectories.ticks).map(String), series: trajectorySeries,
    } : null,
    example: text(example.id) ? {
      // 「示例患者 · 年龄 62 岁 · ECOG 1」: the person is told who they are, not an identifier; the engine's own id and the line of how
      // it was made are the record's (`record`, read by the drawer) and are not a line of the page.
      title: ["示例患者", ...list(example.baseline).slice(0, 2).map((row) => [text(object(row).label), String(object(row).value ?? "")].filter(Boolean).join(" "))]
        .filter(Boolean).join(" · "),
      record: {
        id: String(example.id),
        source: (/** @type {readonly string[]} */ (VCR_VALUE_SOURCES)).includes(String(example.source)) ? String(example.source) : "synthetic",
        origin: text(example.origin),
      },
      baseline: list(example.baseline).map((row) => ({
        label: text(object(row).label) ?? "", value: String(object(row).value ?? ""),
        source: (/** @type {readonly string[]} */ (VCR_VALUE_SOURCES)).includes(String(object(row).source)) ? String(object(row).source) : "synthetic",
      })),
      inScope: object(example.inScope).text ? { ok: object(example.inScope).ok === true, text: String(object(example.inScope).text) } : null,
      scenarios: seriesList(object(example.scenarios).series).length ? {
        note: text(object(example.scenarios).note), series: seriesList(object(example.scenarios).series), difference: text(object(example.scenarios).difference),
      } : null,
      note: text(example.note),
    } : null,
    panels,
    sensitivity: list(sensitivity.rows).length ? {
      measure: text(sensitivity.measure),
      base: finite(object(sensitivity.base).value) === null ? null : plainValue(sensitivity.base, { source: "predicted", review: result?.reviewState ?? null }),
      rows: list(sensitivity.rows).map((row) => ({
        label: text(object(row).label) ?? "", range: text(object(row).range), low: finite(object(row).low) ?? 0, high: finite(object(row).high) ?? 0,
      })).filter((row) => row.label),
    } : null,
    counts: current ? countsView(result?.counts && Object.keys(result.counts).length ? result.counts : current.counts, { tier: study.dataTier, scope: current.name || null }) : null,
    stale: staleNote(marks),
    partial: partialOf(bundle, ["patient_set"], "这次生成"),
    // Population-level progression simulations (P4) the conversation computed: a card each, curves and power.
    progressions: presentProgressions(bundle, { nodeOf: resultNode }),
    // The records of virtual people the study holds: how many, made from what, for which model, how many outside the fitted range, and what ran on them.
    peopleRecords: presentPeopleRecords(bundle),
    // A published PBPK model of a drug after a perpetrator (R38) the conversation computed: a card each, the curves alone and after.
    pbpkInteractions: presentPbpkInteractions(bundle, { nodeOf: resultNode }),
    // Survival fits with a spline (C13) the conversation computed: the curve beyond the data, with how far beyond, and the premises.
    splineFits: presentSplineFits(bundle, { nodeOf: resultNode }),
    sets: patientSets.map((/** @type {any} */ set) => ({ id: set.id, version: set.version, ...(set.resultId ? { resultId: set.resultId, resultVersion: resultById(bundle, set.resultId)?.version } : {}), label: `虚拟患者集 v${set.version}`, stale: Boolean(markFor(stale, vcrObjectNode("patient_set", set))) })),
  };
}

/** How the unit of a result's times was settled, in the words of someone who must be able to check it. */
const TIME_UNIT_BASIS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  stated: "方案里写明", evidence: "取自证据里的单位", assumed: "没有写明，按月计算",
}));

// --- 对照 -------------------------------------------------------------------------------------------------------------------------

// --- robustness methods ---
/**
 * What a comparator's result says beside the comparison itself: the numbers of the robustness methods (a negative-control screen, a
 * tipping-point analysis, a prognostic-adjusted effect), a sentence for each robustness analysis that could not be computed, and the
 * sentence that no regulator has qualified prognostic adjustment for the endpoint, which every prognostic result carries
 * (`diagnostics.regulatoryStatus`, said by the domain's closed word and never by the engine's English). Null when there is none of them.
 * @param {Record<string, any> | null} result @param {(measure: any) => any} value
 */
function robustnessView(result, value) {
  if (!result) return null;
  const diagnostics = object(result.diagnostics);
  const stageResults = object(diagnostics.stageResults);
  const regulatory = [diagnostics, ...Object.values(stageResults).map((entry) => object(object(entry).diagnostics))]
    .map((entry) => object(entry.regulatoryStatus)).find((status) => status.qualification !== undefined);
  const qualification = regulatory?.qualification === VCR_PROGNOSTIC_QUALIFICATION ? VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH : null;
  // `survival_difference_at_tau` is also the weighted comparators' own number; it is listed here only for a prognostic result.
  const names = new Set(["e_value", "e_value_confidence_limit", ...VCR_ROBUSTNESS_MEASURES, ...(regulatory ? ["survival_difference_at_tau"] : [])]);
  const rows = list(result.measures).filter((measure) => names.has(String(object(measure).name)))
    .map((measure) => ({ key: String(object(measure).name), label: measureLabel(String(object(measure).name)), value: value(measure) }));
  const notes = VCR_ROBUSTNESS_STAGES.flatMap((stage) => {
    const entry = object(stageResults[stage]);
    if (entry.conclusion !== "not_estimable") return [];
    const rule = (/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH))[String(entry.notEstimableRule)];
    return [`${(/** @type {Record<string, string>} */ (VCR_ROBUSTNESS_STAGE_LABELS_ZH))[stage]}没有算出${rule ? `：${rule}` : ""}`];
  });
  return rows.length || notes.length || qualification ? { rows, notes, qualification } : null;
}
// --- end robustness methods ---

/**
 * `GET /api/vcr/studies/:id/comparator`.
 * @param {Record<string, any>} bundle
 */
export function presentComparatorTab(bundle) {
  const { study, comparators, stale, now } = bundle;
  // The comparison a link named, when it is one of this study's; else the newest.
  const current = (typeof bundle.askedComparator === "string" ? comparators.find((design) => design.id === bundle.askedComparator) : null) ?? comparators[0] ?? null;
  // The newest version whose compute failed has no result of its own. The page keeps the
  // last version of the same route that has one — its numbers stay on the page — and says
  // so: a route that lost its numbers because the latest edit did not compute would read
  // as one that was never computed.
  const lastGood = current && !current.resultId
    ? comparators.find((design) => design.id !== current.id && design.route === current.route && design.resultId && resultById(bundle, design.resultId)) ?? null
    : null;
  const shown = lastGood ?? current;
  const result = shown ? resultById(bundle, shown.resultId) : null;
  const marks = current ? [markFor(stale, vcrObjectNode("comparator", current)), result ? markFor(stale, resultNode(result)) : null] : [];
  const diagnostics = object(result?.diagnostics);
  const execution = executionOf(bundle, result);
  const tierIndex = VCR_DATA_TIERS.indexOf(study.dataTier);
  const latestByRoute = new Map();
  for (const design of comparators) if (!latestByRoute.has(design.route)) latestByRoute.set(design.route, design);
  // A route this version cannot compute is not one of the choices — unless a design somebody wrote earlier names it, which is then shown as what it found.
  const routes = VCR_COMPARATOR_ROUTES.filter((route) => !VCR_UNSUPPORTED_COMPARATOR_ROUTES.includes(route) || latestByRoute.has(route)).map((route) => {
    const minimum = /** @type {Record<string, string>} */ (VCR_ROUTE_MIN_TIER)[route];
    const reachable = tierIndex >= 0 && tierIndex >= VCR_DATA_TIERS.indexOf(minimum);
    const design = latestByRoute.get(route) ?? null;
    const designResult = design ? resultById(bundle, design.resultId) : null;
    const conclusion = design ? (designResult?.conclusion ?? design.conclusion ?? null) : null;
    // The class a reader gets: the conclusion, or 仅基准 for a result that is a benchmark (a literature curve, an unanchored MAIC, a
    // model's prediction); the engine's conclusion is stored as it was.
    const readAs = conclusion && designResult
      ? vcrResultClass({ conclusion, method: executionOf(bundle, designResult)?.method ?? null, route, diagnostics: designResult.diagnostics, measures: designResult.measures })
      : conclusion;
    const gaps = design ? list(design.gapList).length : 0;
    /** @type {string} */
    let state;
    // A route somebody evaluated says what it found, whatever its tier: an
    // external control at T0 that was judged not estimable is a result.
    if (readAs && (/** @type {readonly string[]} */ (VCR_RESULT_CLASSES)).includes(readAs)) state = readAs;
    else if (!reachable) state = "not_applicable";
    else state = route === "model_comparator" ? "scenario" : "design_only";
    const rule = designResult?.notEstimableRule ? (/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH))[designResult.notEstimableRule] ?? null : null;
    return {
      route, state,
      reason: state === "not_estimable" ? (gaps ? `缺 ${gaps} 项数据，见下方清单` : rule)
        : state === "not_applicable" ? `需要 ${(/** @type {Record<string, string>} */ (VCR_DATA_TIER_LABELS_ZH))[minimum]}` : null,
      note: null,
      selected: current ? current.route === route : false,
    };
  });
  const curves = seriesList(diagnostics.curves);
  // One arm's reconstruction is one quality-control object; two arms are a list of two (control, then treatment),
  // each with its own checks — the page reads both, each row saying whose it is.
  const qcArms = Array.isArray(diagnostics.qualityControl) ? diagnostics.qualityControl.map(object) : [object(diagnostics.qualityControl)];
  const armNames = qcArms.length > 1 ? ["对照组", "试验组"] : [""];
  const qc = qcArms.flatMap((arm, index) => Object.entries(object(arm.checks)).map(([key, check]) => {
    const row = qcRow(key, object(check));
    return row && armNames[index] ? { ...row, key: `${key}_${index === 0 ? "control" : "treatment"}`, label: `${armNames[index]}：${row.label}` } : row;
  })).filter((row) => row !== null);
  const reconstruction = reconstructionLevelView(diagnostics);
  const measureOf = (/** @type {string} */ name) => list(result?.measures).find((measure) => String(object(measure).name) === name);
  const rmstMeasure = measureOf("rmst_difference") ?? measureOf("rmst_control");
  // A two-arm reconstruction names its medians per arm; the comparator page is about the control arm,
  // and the treatment arm's median is one of the rows beside it.
  const medianMeasure = measureOf("median_survival") ?? measureOf("median_survival_control");
  const value = (/** @type {any} */ measure) => measureValue(measure, { kind: "comparator", result, execution, staleMark: marks[1],
    context: { route: shown?.route }, tab: "comparator" });
  const measureRowsOf = (/** @type {readonly string[]} */ names) => names.map((name) => measureOf(name)).filter((measure) => measure !== undefined)
    .map((measure) => ({ key: String(object(measure).name), label: measureLabel(String(object(measure).name)), value: value(measure) }));
  // What only some routes produce: the treatment arm's median (a number of the comparison, which stays with the weighting rows), and
  // a MAP prior's own numbers — how much information the borrowed prior is worth, which is a different thing from the weights'
  // effective sample size and is drawn in a card of its own (`prior`).
  const routeRows = measureRowsOf(["median_survival_treatment"]);
  const priorRows = measureRowsOf(["map_mean", "map_sd", "prior_effective_sample_size_moment",
    "prior_effective_sample_size_elir", "map_effective_sample_size_moment", "map_effective_sample_size_elir",
    "prior_effective_sample_size_ceiling", "tau_posterior_median"]);
  // Why the newest version has no numbers, in the compute's own words.
  const failure = lastGood ? failureOfNode(bundle, vcrObjectNode("comparator", /** @type {any} */ (current))) : null;
  const balance = list(diagnostics.balance).map(object);
  const enrolmentYear = enrolmentYearView(diagnostics.enrolmentYear);
  // The gap list belongs to the route that could not be estimated, which is
  // not always the route the page is about.
  const blocked = notEstimableDesign(comparators, allResultsOf(bundle));
  const blockedResult = blocked ? resultById(bundle, blocked.resultId) : null;
  const gapList = blocked ? (list(blocked.gapList).length ? list(blocked.gapList) : list(object(blockedResult?.diagnostics).gaps)) : [];
  const gaps = blocked ? {
    title: `${(/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[blocked.route] ?? "对照"}：不可估计`,
    needs: `需要 ${(/** @type {Record<string, string>} */ (VCR_DATA_TIER_LABELS_ZH))[/** @type {Record<string, string>} */ (VCR_ROUTE_MIN_TIER)[blocked.route]] ?? ""}`,
    items: gapList.map((gap) => {
      const entry = object(gap);
      return { title: text(entry.title) ?? text(entry.name) ?? (typeof gap === "string" ? gap : ""), detail: text(entry.detail), answers: text(entry.answers) };
    }).filter((item) => item.title),
    conclusion: text(object(blockedResult?.diagnostics).gapConclusion),
    rule: blockedResult?.notEstimableRule ? (/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH))[blockedResult.notEstimableRule] ?? null : null,
  } : null;
  const dimensions = VCR_COMPARABILITY_DIMENSIONS.map((key) => {
    const found = list(diagnostics.comparabilityDimensions).map(object).find((entry) => entry.key === key)
      ?? list(current?.configuration?.comparability).map(object).find((entry) => entry.key === key);
    const state = text(found?.state);
    return {
      key, label: (/** @type {Record<string, string>} */ (VCR_COMPARABILITY_DIMENSION_LABELS_ZH))[key],
      state: state && ["exact", "approximate", "not_simulable"].includes(state) ? state : "unknown",
      reason: text(found?.reason),
    };
  });
  const e10 = list(current?.configuration?.e10).map(object);
  const weights = object(diagnostics.weights);
  const support = object(diagnostics.support);
  const diagnosticRows = [
    ["ess", "有效样本量", weights.effectiveSampleSize, "例"], ["max", "最大权重", weights.max, ""],
    ["cv", "权重变异系数", weights.coefficientOfVariation, ""], ["top1", "前 1% 权重占比", weights.topOnePercentShare, "%"],
    ["overlap", "重叠系数", support.overlapCoefficient, ""], ["outside", "共同支持域外的比例", support.outsideShare, "%"],
  ].map(([key, label, raw, unit]) => {
    const v = numeric(raw);
    return v === null ? null : { key, label, value: plainValue({ value: unit === "%" ? roundTo(v * 100, 4) : v, unit: unit || undefined }, { source: "calculated", review: result?.reviewState ?? null }) };
  }).filter((row) => row !== null);
  // The estimand is the method's own: the one its result says it computed (the weighting comparisons state ATT, ATE or ATO; the augmented
  // estimate is the effect among the trial's people; a target-trial emulation, a simulated treatment comparison and a borrowed control read
  // none of the three). The object's `estimand` is a default the comparison was written with, and what a method that does not read it
  // would then be labelled with is a statement it never made (review RF2 P1-8).
  const ownEstimand = text(diagnostics.estimand) !== null && Object.hasOwn(VCR_ESTIMAND_LABELS_ZH, String(diagnostics.estimand)) ? String(diagnostics.estimand) : null;
  const estimandLabel = current && ownEstimand ? (/** @type {Record<string, string>} */ (VCR_ESTIMAND_LABELS_ZH))[ownEstimand] : null;
  const rmstValue = rmstMeasure ? value(rmstMeasure) : null;
  // The unit τ is in is the one the engine echoed (months when it echoed none); a spelling the unit table does not hold is left unnamed, never called months.
  const echoedUnit = diagnostics.timeUnit === undefined ? TIME_UNIT_WORDS.months : TIME_UNIT_WORDS[String(diagnostics.timeUnit)] ?? null;
  const tauWords = numeric(diagnostics.tau) !== null && echoedUnit ? `${diagnostics.tau} ${echoedUnit.after} ` : "";
  const conclusion = result?.conclusion ?? shown?.conclusion ?? null;
  const origins = comparatorOrigins({ route: shown?.route ?? null, method: execution?.method ?? null, diagnostics, counts: object(result?.counts) });
  // What the reader is told: the conclusion, or 仅基准 for a result that is a benchmark (A8).
  const readAs = conclusion && result
    ? vcrResultClass({ conclusion, method: execution?.method ?? null, route: shown?.route, diagnostics, measures: result.measures })
    : conclusion;
  // Why the result is read with care, in sentences: the weighted balance (decision 2: the estimate is delivered with it, limited above
  // 0.10 and severe above 0.25), the reasons the comparator's own records give (A7), and what a benchmark is a benchmark of (A8).
  // A not-estimable result has its gap list instead.
  const limits = result ? vcrResultLimits({ conclusion, method: execution?.method ?? null, route: shown?.route, diagnostics, measures: result.measures }) : [];
  // The target trial, as one record whichever shape it was written in.
  const targetTrial = current ? vcrTargetTrial(current.targetTrial, current.configuration?.targetTrial) : null;
  // The owned execution identifies a sensitivity-only run. An E-value measure alongside
  // another method's effect estimate must not relabel that comparison.
  // A bias analysis alone is the same (a stand-alone one has no stage beside it); one filed as a stage of a comparison is not that comparison's method.
  const sensitivityOnly = execution?.method === "comparator.evalue"
    || (execution?.method === "comparator.bias_analysis" && list(diagnostics.stages).every((/** @type {any} */ stage) => object(stage).stage === "bias_analysis"));
  return {
    versions: comparators.map(row => ({ objectId: row.id, version: row.version, label: row.name || `对照版本 ${row.version}`, ...(row.resultId ? { resultId: row.resultId, resultVersion: resultById(bundle, row.resultId)?.version } : {}) })),
    selection: shown ? { id: shown.id, version: shown.version, resultId: result?.id ?? null, resultVersion: result?.version ?? null, route: shown.route } : null,
    predictionBenchmark: shown?.route === "model_comparator" && execution?.method === "model.prognostic_apply" ? {
      sourceCondition: diagnostics.sourceCondition ?? null, endpoint: diagnostics.endpoint ?? null,
      mean: measureOf("predicted_population_mean") ? value(measureOf("predicted_population_mean")) : null,
      outcomeSd: measureOf("predicted_outcome_sd") ? value(measureOf("predicted_outcome_sd")) : null,
      relativeScore: measureOf("mean_relative_score") ? value(measureOf("mean_relative_score")) : null,
      absoluteRiskAvailable: diagnostics.absoluteRiskAvailable === true, causalEffectIdentified: false,
      limits: [...list(diagnostics.limits).map(vcrPredictionLimit),
        // an equation the person's own data trained says so wherever its predictions are read
        ...(object(object(diagnostics.sourceModel).source).kind === "trained_result" ? [{ code: "trained_on_own_data" }] : [])],
      // Held against the outcome the table itself has (D3): the calibration intercept and slope, or why the slope is not there.
      calibration: localCalibrationView(diagnostics.localCalibration),
    } : null,
    headline: shown && conclusion && conclusion !== "not_estimable"
      ? sensitivityOnly
        ? `未测量混杂敏感性分析：${conclusion === "limited" ? "结果有限制" : "已计算"}；输入效应值的来源需另行核实${diagnostics.inputsAssumed === true ? "，输入为假设" : ""}。`
        : `${(/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[shown.route] ?? "对照"}：${(/** @type {Record<string, string>} */ (VCR_RESULT_CLASS_LABELS_ZH))[String(readAs)] ?? ""}${rmstValue && rmstValue.value !== null ? `，${tauWords}RMST ${valueString(rmstValue)}` : ""}${diagnostics.inputsAssumed === true ? "，输入为假设" : ""}。`
      : null,
    routes,
    curves,
    rmst: rmstValue ? { value: rmstValue, tau: numeric(diagnostics.tau), label: numeric(diagnostics.tau) !== null ? `τ = ${diagnostics.tau}${echoedUnit ? ` ${echoedUnit.after}` : ""}` : null } : null,
    median: medianMeasure ? value(medianMeasure) : null,
    qc,
    // What the paper gave a reconstruction (its information level), shown beside its checks whether they passed or not.
    reconstruction,
    // The method by its Chinese name (`METHOD_LABELS`); an id the table does not hold is shown as a plain word, never as the engine's own.
    methods: execution ? [{ label: METHOD_LABELS[String(execution.method)] ?? "引擎计算", version: execution.methodVersion ? `v${execution.methodVersion}` : null, note: sensitivityOnly ? "基于输入效应值评估未测量混杂的敏感性，不估计治疗效应，也不建立对照组。" : null, passed: result?.conclusion !== "not_estimable" }] : [],
    e10: e10.map((entry) => ({
      key: text(entry.key) ?? "", label: (/** @type {Record<string, string>} */ (VCR_E10_CONDITION_LABELS_ZH))[String(entry.key)] ?? text(entry.label) ?? "",
      state: ["met", "partial", "doubtful"].includes(String(entry.state)) ? String(entry.state) : "doubtful", note: text(entry.note),
    })).filter((entry) => (VCR_E10_CONDITIONS).includes(entry.key)),
    // The estimand, and the target trial in its seven components (A6): each says how far the comparison can emulate it. What the premise
    // block (above) shows of it is the components that are not exact; this is the whole record, folded into the section.
    estimand: current ? {
      rows: [
        ...(estimandLabel ? [{ label: "估计目标", value: estimandLabel }] : []),
        ...(targetTrial?.components ?? []).map((entry) => ({ label: entry.label, value: [entry.statusLabel, entry.text].filter(Boolean).join("：") || "没有写" })),
        ...(targetTrial?.other ?? []).map((entry) => ({ label: entry.item, value: entry.status ? (/** @type {Record<string, string>} */ ({ exact: "可精确复现", approximate: "只能近似", not_possible: "无法复现" }))[entry.status] : "没有写" })),
      ],
      note: targetTrial?.note ?? null,
      source: "assumed",
    } : null,
    comparability: [
      ...balance.map((row, index) => {
        const smd = finite(row.smdAdjusted);
        return {
          key: text(row.covariate) ?? `row_${index}`, label: text(row.covariate) ?? `特征 ${index + 1}`,
          ours: plainValue(null, { source: "observed" }), theirs: plainValue(null, { source: "observed" }),
          smd, smdBefore: finite(row.smdUnadjusted), flagged: smd !== null && Math.abs(smd) > VCR_SMD_FLOOR, note: null,
        };
      }),
      ...(enrolmentYear.row ? [enrolmentYear.row] : []),
    ],
    comparabilityNote: balance.length || enrolmentYear.row
      ? [balance.length ? `标准化差异是加权之后的；界值 ${VCR_SMD_FLOOR}，超过 ${VCR_SMD_SEVERE} 为严重失衡。` : null, enrolmentYear.note].filter(Boolean).join("")
      : enrolmentYear.note,
    dimensions,
    diagnostics: [...diagnosticRows, ...routeRows],
    prior: priorRows,
    // A borrowing route's rejection probabilities over the drifts of the true control rate (`comparator.map_prior`), with their errors.
    operatingCharacteristics: operatingCharacteristicsView(diagnostics),
    // 「这个结论的前提」: the list and its rules are `vcrPremises`'s; the comparator's facts are filled in beside the route's own rows.
    premises: finishPremises([...vcrPremises("comparator", {
      researchQuestion: resultQuestionInput(bundle, result),
      route: shown?.route ?? null, estimand: ownEstimand, estimandStated: ownEstimand !== null && shown ? shown.estimand !== "ATT" && shown.estimand === ownEstimand : false, diagnostics,
      measures: Object.fromEntries(list(result?.measures).map(object).map((measure) => [String(measure.name), numeric(measure.value)])),
      applicability: shown ? vcrApplicability(shown.configuration) : null,
      targetTrial: shown ? vcrTargetTrial(shown.targetTrial, shown.configuration?.targetTrial) : null,
      covariates: list(shown?.configuration?.covariates).length ? list(shown?.configuration?.covariates).map(String) : balance.map((row) => String(row.covariate ?? "")),
      anchored: typeof diagnostics.anchored === "boolean" ? diagnostics.anchored : null,
      // a comparison that predicts its control with a model says what that model was validated for, in the same block
      modelUse: execution?.method === "model.prognostic_apply" || shown?.route === "model_comparator"
        ? modelUseOf(bundle.models, diagnostics.sourceModel, { mode: "conditional_forecast", endpoint: text(diagnostics.endpoint),
          variables: vcrPopulationVariables(list(bundle.populations).find((/** @type {any} */ row) => row.id === text(object(shown?.configuration).populationId)) ?? null) }) : [],
    }), ...(shown && result ? comparatorOriginPremises(origins) : [])]),
    // Where the control comes from: real people, a published summary, a reconstruction, a model's prediction or a simulation, with the
    // number of observed people it holds (never a simulated member).
    origins: shown && result ? { origin: origins.origin, origins: origins.origins, observedPeople: origins.observedPeople,
      reconstructedPseudoPatients: origins.reconstructedPseudoPatients, simulatedMembers: origins.simulatedMembers, modelConditional: origins.modelConditional } : null,
    limits,
    robustness: robustnessView(result, value),
    // Quantitative bias analysis (C1, C2) and who a propensity trimming left (C14): cards of the comparison, null when the result has neither.
    biasAnalysis: presentBiasAnalysis(result, value),
    // Dynamic borrowing of an external control arm (C10-C12): the posterior beside no and full borrowing, the conflict table, the operating characteristics.
    borrowing: presentBorrowing(result, value),
    // Prognostic models trained on the person's own table (P3): a card each, with the out-of-fold figures and the table of sample-size savings.
    prognosticModels: presentPrognosticModels(bundle, { nodeOf: resultNode }),
    trim: presentTrim(diagnostics.trim),
    // Missing covariates that were imputed (C7): the pooled answer beside the complete-case one, and what it assumed.
    imputation: presentImputation(result, value),
    // A target-trial emulation (C3, C4): the question, which estimand was computed, and the two arms' risks beside the difference.
    targetTrialEmulation: presentTargetTrial(result, value),
    // A simulated treatment comparison (C2): the indirect estimate, the marginal and the conditional effect, and the population it is about.
    stcComparison: presentStcComparison(result, value),
    gaps,
    counts: current ? countsView(result?.counts && Object.keys(result.counts).length ? result.counts : {}, { tier: study.dataTier }) : null,
    verdict: shown ? { conclusion: readAs } : null,
    at: shown ? zhTime(shown.createdAt, now) : null,
    stale: staleNote(marks),
    // One sentence, and no version numbers: the page says that these are the previous design's numbers, not which version that was.
    partial: lastGood ? {
      sentence: `最新一版对照设计没有算成${failure ? `：${failure.replace(/[。.]$/u, "")}` : ""}。这里显示的是上一版的结果，不是最新一版的。`,
    } : partialOf(bundle, ["comparator"], "这次分析"),
  };
}

/**
 * Why an object's compute did not produce a result, in the words the compute
 * gave: the refusal the orchestrator recorded before any job (an unread field, a
 * model that does not cover the study) or the newest failed job of the node.
 * @param {Record<string, any>} bundle @param {string} node
 */
function failureOfNode(bundle, node) {
  const mark = list(bundle.jobMarks).map(object).find((entry) => entry.state === "failed" && object(entry.detail).node === node);
  const job = list(bundle.jobs).map(object).find((entry) => entry.state === "failed" && object(entry.checkpoint).node === node);
  const said = vcrPageSentence(object(mark?.detail).message) ?? knownErrorCodeMessage(String(object(mark?.detail).error ?? ""))
    ?? (job?.error ? vcrFailureSentence(job.error) : null);
  // Long enough for a refusal that names the keys of the place it was refused (`readsHint` in the orchestrator): that list is what
  // a run repairs from, and the same words are what the researcher's page shows.
  return said ? said.slice(0, 400) : null;
}

/** One reconstruction check as a row: the largest difference, the way the paper's own table states it. @param {string} key @param {Record<string, any>} check */
function qcRow(key, check) {
  const labels = /** @type {Record<string, string>} */ ({ atRisk: "各时点风险人数", events: "总事件数", median: "中位数", logHazardRatio: "|Δlog HR|" });
  const label = labels[key] ?? text(check.name) ?? key;
  // A check the paper gave nothing to check against is listed, not dropped: a reconstruction that passed without it reads differently
  // from one that passed with it (the information level says which).
  if (check.status === "not_reported" || check.status === "not_checked") {
    return { key, label, value: check.status === "not_reported" ? "论文没有给，没有核对" : "没有可比的重建值，没有核对", threshold: null, passed: false, notChecked: true };
  }
  const reported = check.reported;
  const reconstructed = check.reconstructed;
  const passed = check.pass === true;
  if (Array.isArray(reported) && Array.isArray(reconstructed)) {
    const diffs = reported.map((value, index) => Math.abs(Number(reconstructed[index]) - Number(value))).filter((value) => Number.isFinite(value));
    if (!diffs.length) return null;
    return { key, label, value: `最大差 ${roundTo(Math.max(...diffs), 1)} 人`, threshold: null, passed };
  }
  const a = numeric(reported);
  const b = numeric(reconstructed);
  if (a === null || b === null) return null;
  if (key === "logHazardRatio") return { key, label, value: String(roundTo(Math.abs(b - a), 2)), threshold: null, passed };
  return { key, label, value: a === 0 ? String(roundTo(b - a, 2)) : `${roundTo(Math.abs(b - a) / Math.abs(a) * 100, 1)}%`, threshold: null, passed };
}

// --- 试验 --------------------------------------------------------------------------------------------------------------------------

/**
 * The ADEMP lines, from the study and the headline scenario; the unit its times are in is one of them where the platform settled it
 * (`diagnostics.timeUnitBasis`): a result that read an unstated unit as months says so, where the researcher reads the numbers.
 * @param {Record<string, any>} bundle @param {Record<string, any> | null} scenario @param {Record<string, any>} [diagnostics] the headline result's
 */
function adempOf(bundle, scenario, diagnostics = {}, stages = {}) {
  const { study, definition } = bundle;
  const configuration = object(scenario?.configuration);
  const truth = object(configuration.truth);
  const analysis = object(configuration.analysis);
  const performance = list(configuration.performance).map(String);
  const designWord = scenario ? (/** @type {Record<string, string>} */ (VCR_ESTIMAND_LABELS_ZH))[String(object(definition?.estimand).kind)] : null;
  /** @type {Array<{ key: string, label: string, text: string }>} */
  const lines = [];
  if (text(study.question)) lines.push({ key: "aim", label: "目的", text: String(study.question) });
  if (scenario) {
    // The data generation says how patients enter and leave, and which of those numbers the platform filled in: a dropout of 0 that
    // nobody wrote is a part of how the data were made (A2, A12).
    const defaulted = new Set(list(appliedDefaultsOf(scenario, stages)).map((entry) => String(object(entry).path)));
    const accrual = object(configuration.accrual);
    const survival = scenario.endpointType === "time_to_event";
    const unit = (/** @type {Record<string, { after: string }>} */ (TIME_UNIT_WORDS))[String(object(diagnostics.timeUnitBasis).unit ?? configuration.timeUnit ?? "months")]?.after ?? "个月";
    const dropout = survival ? (numeric(accrual.dropoutAnnual) ?? (defaulted.has("accrual.dropoutAnnual") ? 0 : null)) : null;
    const dataGeneration = [
      (/** @type {Record<string, string>} */ (VCR_ENDPOINT_TYPE_LABELS_ZH))[scenario.endpointType] ?? scenario.endpointType,
      ...Object.entries(truth).filter(([, value]) => typeof value === "number").map(([key, value]) => `${TRUTH_LABELS[key] ?? key} ${value}`),
      ...(survival && hazardLawWords(truth.treatmentHazardRatios, unit) ? [`风险比随时间变化：${hazardLawWords(truth.treatmentHazardRatios, unit)}`] : []),
      ...(survival && numeric(accrual.duration) !== null ? [`入组 ${accrual.duration} ${unit}`] : []),
      ...(survival && numeric(accrual.followup) !== null ? [`随访 ${accrual.followup} ${unit}`] : []),
      ...(dropout !== null ? [`脱落 ${roundTo(dropout * 100, 1)}%/年${defaulted.has("accrual.dropoutAnnual") ? "（默认）" : ""}`] : []),
    ].join(" · ");
    lines.push({ key: "data", label: "怎么生成数据", text: dataGeneration });
  }
  const estimand = text(object(definition?.estimand).text) ?? text(object(definition?.estimand).variable) ?? designWord;
  if (estimand) lines.push({ key: "estimate", label: "估计什么", text: estimand });
  if (Object.keys(analysis).length) {
    lines.push({ key: "analysis", label: "怎么分析", text: [text(analysis.method), numeric(analysis.alpha) !== null ? `α = ${analysis.alpha}` : null,
      numeric(analysis.sided) !== null ? `${analysis.sided} 侧` : null].filter(Boolean).join(" · ") || "已设定" });
  }
  if (performance.length) {
    lines.push({ key: "measures", label: "看哪些指标", text: performance.map((name) => (/** @type {Record<string, string>} */ (VCR_PERFORMANCE_MEASURE_LABELS_ZH))[name] ?? measureLabel(name)).join("、") });
  }
  const basis = object(diagnostics.timeUnitBasis);
  const unit = TIME_UNIT_WORDS[String(basis.unit)];
  if (unit) lines.push({ key: "timeUnit", label: "时间单位", text: `${unit.bare}（${TIME_UNIT_BASIS_ZH[String(basis.basis)] ?? "按月计算"}）` });
  const replicates = replicateReasons(bundle, stages);
  if (replicates.length) lines.push({ key: "replicates", label: "模拟次数", text: replicates.join("；") });
  return lines;
}

/**
 * The defaults a design's run took: the run's own record when it has one (`diagnostics.appliedDefaults`, written when the job was
 * frozen), else what the same scenario would have taken — a result from before the record was kept still says its dropout was 0.
 * @param {Record<string, any>} scenario @param {Record<string, any>} stages the design's stages (`designStages`)
 * @returns {Array<{ path: string, value?: unknown }>}
 */
function appliedDefaultsOf(scenario, stages) {
  const recorded = (stages.simulation ?? stages.analytic)?.diagnostics?.appliedDefaults;
  if (Array.isArray(recorded)) return recorded;
  const configuration = object(scenario?.configuration);
  const merged = { ...configuration, design: { ...object(configuration.design), kind: scenario?.design ?? object(configuration.design).kind },
    endpoint: { ...object(configuration.endpoint), type: scenario?.endpointType ?? object(configuration.endpoint).type } };
  return vcrAppliedDefaults("design.simulate", merged);
}

/**
 * Why each simulated stage ran as many replicates as it did, in the reader's words: the default of its case, the intended use, a
 * design that borrows, or the precision the scenario asked for. The count is the execution's own; the reason is the plan the job was
 * frozen with (`replicatePlan`).
 * @param {Record<string, any>} bundle @param {Record<string, any>} stages
 */
function replicateReasons(bundle, stages) {
  /** @type {string[]} */
  const out = [];
  for (const [name, word] of /** @type {const} */ ([["simulation", "备择情景"], ["simulation_null", "零效应情景"]])) {
    const stage = stages[name];
    if (!stage) continue;
    const plan = object(stage.diagnostics?.replicatePlan);
    const run = stage.jobId ? [...(bundle.executions?.values?.() ?? [])].find((/** @type {any} */ entry) => entry.jobId === stage.jobId) : null;
    const count = numeric(run?.replicates) ?? numeric(plan.floor);
    if (count === null) continue;
    const floor = numeric(plan.floor);
    const why = plan.basis === "intended_use" ? `${(/** @type {Record<string, string>} */ (VCR_INTENDED_USE_LABELS_ZH))[String(plan.intendedUse)] ?? "该用途"}的零效应情景至少 ${floor?.toLocaleString("en-US")} 次`
      : plan.basis === "borrowing" ? `借用外部数据的设计，零效应情景至少 ${floor?.toLocaleString("en-US")} 次`
        : plan.basis === "target_mcse" ? `按要求的蒙特卡洛误差 ${plan.targetMcse} 需要 ${floor?.toLocaleString("en-US")} 次`
          : floor !== null ? `${name === "simulation_null" ? "零效应" : "备择"}情景的默认下限 ${floor.toLocaleString("en-US")} 次` : null;
    out.push(`${word} ${count.toLocaleString("en-US")} 次${why ? `（${why}）` : ""}`);
  }
  return out;
}

const TRUTH_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  effect: "真实效应", sd: "标准差", hazardRatio: "真实 HR", controlMedian: "对照组中位", controlRate: "对照事件率", treatmentRate: "试验事件率",
  // The keys a binary design and a single-arm design state their truth with (found live 2026-11-04: a non-inferiority sample size and a Simon
  // two-stage design printed `riskDifference 0` and `nullRate 0.2` in the first line of the data generation).
  riskDifference: "真实率差", oddsRatio: "真实优势比", responseRate: "真实应答率", nullRate: "零假设应答率", alternativeRate: "备择应答率",
  baselineCorrelation: "基线相关",
}));

/**
 * What a design needs, in the words of the first sentence: the events and patients the closed form computed, or -- for Simon's two-stage design,
 * which has neither -- its answer: the stage sizes, the boundaries, the expected size and the chance of stopping early under the null, the type I
 * error and the power. `named` adds what the design is after its letter, for a page that speaks of one design among many.
 * @param {Record<string, any>} design @param {boolean} [named]
 */
function designNeeds(design, named = false) {
  const word = `方案 ${design.code}${named && text(design.name) && design.name !== `方案 ${design.code}` ? `（${design.name}）` : ""}`;
  const simon = design.simon?.optimal;
  if (simon) {
    const percent = (/** @type {unknown} */ x, /** @type {number} */ decimals = 1) => (numeric(x) === null ? null : `${roundTo(Number(x) * 100, decimals)}%`);
    const tail = [numeric(simon.expectedNull) !== null ? `零假设下期望入组 ${roundTo(Number(simon.expectedNull), 1)} 例` : null,
      percent(simon.earlyStopNull) ? `第一阶段就停止的概率 ${percent(simon.earlyStopNull)}` : null].filter(Boolean).join("，");
    const error = [percent(simon.typeOneError, 2) ? `I 类错误 ${percent(simon.typeOneError, 2)}` : null, percent(simon.power) ? `功效 ${percent(simon.power)}` : null].filter(Boolean).join("，");
    const minimax = design.simon.minimax ? `；总例数最少的设计共 ${design.simon.minimax.n} 例` : "";
    return `${word} 的 Simon 两阶段最优设计：${simonBoundaryText(simon)}${tail ? `；${tail}` : ""}${error ? `；${error}` : ""}${minimax}`;
  }
  const events = numeric(design.measures.required_events?.value);
  const patients = design.measures.sample_size?.source === "calculated" ? numeric(design.measures.sample_size?.value) : null;
  if (events === null && patients === null) return null;
  return `${word} 需要 ${[events !== null ? `${Math.round(events).toLocaleString("en-US")} 例事件` : null,
    patients !== null ? `${Math.round(patients).toLocaleString("en-US")} 名患者` : null].filter(Boolean).join("、")}`;
}

/**
 * The trial tab's first sentence. Up to three designs, each says what it needs where the closed form computed it, then how the designs did
 * where they were simulated. More than three designs, or a link that names one (`object=`), is about ONE design -- the one named, else the most
 * recent -- the same the premises and the data-generation lines read, with the others a count: a sentence of the first three was about designs the
 * page was no longer reading. Every number is a measure of the design's own results, formatted here.
 * @param {ReadonlyArray<Record<string, any>>} designs @param {{ primary?: Record<string, any> | null, asked?: boolean }} [options]
 */
export function trialHeadline(designs, { primary = null, asked = false } = {}) {
  const live = designs.filter((design) => !design.dominated);
  if (primary && (asked || live.length > 3)) {
    const own = designNeeds(primary, true);
    const others = live.filter((design) => design.id !== primary.id).length;
    return own ? `${own}${others ? `；页面上另有 ${others} 个方案，各在下面的表里` : ""}。` : null;
  }
  const needs = live.map((design) => designNeeds(design)).filter(Boolean).slice(0, 3);
  const sentence = designsSentence(designs);
  const parts = [...needs, ...(sentence && designs.some((design) => design.measures.power || design.measures.assurance) ? [sentence] : [])];
  return parts.length ? `${parts.join("；")}。` : (sentence ? `${sentence}。` : null);
}

/**
 * The first sentence of a page whose subject is a card of a design the conversation computed (a re-estimation, a dose-finding comparison, a
 * Bayesian design, a hierarchical composite): the card's own title and its first numbers, and the fixed designs of the page as the baselines
 * they are. The composite's number comes first: the single-endpoint sizes beside it are what it is read against.
 * @param {Record<string, any>} card @param {ReadonlyArray<Record<string, any>>} designs
 */
function cardHeadline(card, designs) {
  const numbers = list(card.headline).map(object).slice(0, 3).map((entry) => `${entry.label} ${valueString(object(entry.value))}`);
  if (!numbers.length) return null;
  const baselines = designs.filter((design) => !design.dominated).map((design) => designNeeds(design)).filter(Boolean).slice(0, 3);
  return `${card.title}：${numbers.join("；")}${baselines.length ? `。作为对照，${baselines.join("；")}` : ""}。`;
}

/**
 * What each input of the formula does to the sample size, one at a time, from the analytic stage of the design the page is read
 * through (C6): the rows sorted by how far they move it, and — for an event-time endpoint — the power the design keeps when its effect
 * is reduced by the published gap between a planned and a measured one. The discount row exists only where the engine computed it;
 * a binary or a continuous endpoint has none, and nothing is said about its absence.
 * @param {Record<string, any> | null} row a design row of `presentDesigns`
 */
function trialSensitivity(row) {
  const raw = object(row?._stages?.analytic?.diagnostics?.sensitivity);
  const rows = list(raw.rows).map(object).filter((entry) => text(entry.label) && finite(entry.low) !== null && finite(entry.high) !== null);
  if (!row || !rows.length) return null;
  const discount = object(raw.discount);
  return {
    design: row.code,
    measure: text(raw.measure),
    base: finite(object(raw.base).value) === null ? null : plainValue(raw.base, { source: "calculated" }),
    rows: rows.map((entry) => ({ parameter: text(entry.parameter), label: String(entry.label), range: text(entry.range), low: Number(entry.low), high: Number(entry.high) })),
    discount: finite(discount.power) === null ? null : {
      label: VCR_EFFECT_DISCOUNT_LABEL_ZH,
      power: roundTo(Number(discount.power) * 100, 1),
      targetPower: finite(discount.targetPower) === null ? null : roundTo(Number(discount.targetPower) * 100, 1),
      hazardRatio: finite(discount.hazardRatio) === null ? null : roundTo(Number(discount.hazardRatio), 2),
      planned: finite(discount.planned), observed: finite(discount.observed),
    },
  };
}

/**
 * The objective designs are compared on when nobody wrote one (C7): what the design was built to meet — the type I error at most
 * its alpha, the power at least its target — taken from the scenario's own analysis block (what it states, else what the engine
 * applied), or the researcher's own comparison goal when there is one. It is a yardstick the page draws and a sentence the
 * recommendation names a side of; it picks nothing, hides nothing and greys no design out.
 * @param {Record<string, any> | null} row the headline design row @param {string | null} statedGoal the researcher's comparison goal
 */
function trialObjective(row, statedGoal) {
  if (!row) return null;
  const analysis = object(object(row._scenario?.configuration).analysis);
  const defaults = [...list(row._stages?.analytic?.diagnostics?.appliedDefaults), ...list(row._stages?.simulation?.diagnostics?.appliedDefaults)].map(object);
  const taken = (/** @type {string} */ path) => numeric(defaults.find((entry) => entry.path === path)?.value);
  const alpha = numeric(analysis.alpha) ?? taken("analysis.alpha");
  const power = numeric(analysis.power) ?? taken("analysis.power");
  const sided = numeric(analysis.sided) ?? taken("analysis.sided");
  if (alpha === null && power === null) return null;
  const alphaPercent = alpha === null ? null : roundTo(alpha * 100, 4);
  const powerPercent = power === null ? null : roundTo(power * 100, 4);
  return {
    source: statedGoal ? "stated" : "default",
    alpha: alphaPercent, power: powerPercent, sided,
    // Said as the requirement the designs are held to, never as something a design reached (live D8: under the chart it read as design B's
    // verdict while B's own type I error was undecided).
    text: statedGoal ?? `要求：${[alphaPercent !== null ? `I 类错误不超过${sided === 2 ? "双侧" : "单侧"} ${alphaPercent}%` : null, powerPercent !== null ? `功效不低于 ${powerPercent}%` : null].filter(Boolean).join("，")}`,
  };
}

/**
 * Whether a design's own numbers meet the objective's two bounds; null where the design has not measured it. A statement about the
 * numbers, not a verdict on the design. The power is `ok`, `borderline` (inside twice the Monte-Carlo error of the bound) or `no`. The
 * type I error is an error-control bound and is judged as the lab judges one (`vcrTypeOneVerdict`, live D8): `ok` only when its
 * conservative bound is within the level, `no` when even its lower bound is above it, `undecided` between; `typeOneErrorText` says it
 * in words (「无法确定是否不超过 2.5%（模拟 2.53% ± 0.11%）」).
 * @param {Record<string, any>} measures a design's measures @param {{ alpha: number | null, power: number | null } | null} objective
 */
function trialMeets(measures, objective) {
  if (!objective) return null;
  const typeOne = measures.type_one_error && objective.alpha !== null
    ? vcrTypeOneVerdict({ value: finite(measures.type_one_error.value) === null ? null : measures.type_one_error.value / 100,
      mcse: finite(measures.type_one_error.mcse) === null ? null : measures.type_one_error.mcse / 100, bound: objective.alpha / 100 })
    : null;
  /** @param {string} name @param {number | null} bound @param {'at_most' | 'at_least'} direction */
  const read = (name, bound, direction) => {
    const value = finite(measures[name]?.value);
    if (bound === null || value === null) return null;
    const error = 2 * (finite(measures[name]?.mcse) ?? 0);
    const met = direction === "at_most" ? value <= bound : value >= bound;
    if (met) return "ok";
    return (direction === "at_most" ? value - error <= bound : value + error >= bound) ? "borderline" : "no";
  };
  const typeOneError = typeOne ? ({ pass: "ok", fail: "no", inconclusive: "undecided" })[typeOne.status] : null;
  const power = read("power", objective.power, "at_least");
  return typeOneError === null && power === null ? null : { typeOneError, power, ...(typeOne ? { typeOneErrorText: typeOne.text } : {}) };
}

/**
 * `GET /api/vcr/studies/:id/trial`.
 * @param {Record<string, any>} bundle
 */
export function presentTrialTab(bundle) {
  const { study, grid, decisions, forecasts, scenarios, now } = bundle;
  const { rows: designRows, designs } = presentDesigns(bundle);
  const live = designs.filter((design) => !design.dominated);
  // The counts belong to the design a person chose, else to the last one still in the running.
  // What the page is about. A link that names a design (`?object=`, the id of a design or of a card's subject) is about that one; else the design
  // the researcher chose; else the most recent -- of the fixed designs and of the cards the conversation computed -- and the first sentence, the
  // premises and the data-generation lines all read that one (they once read different ones once the page held more than three designs).
  const asked = typeof bundle.askedObject === "string" ? bundle.askedObject : null;
  const cards = {
    confirmatoryDesigns: presentConfirmatoryDesigns(bundle, { nodeOf: resultNode }),
    doseDesigns: presentDoseDesigns(bundle, { nodeOf: resultNode }),
    bayesianDesigns: presentBayesianDesigns(bundle, { nodeOf: resultNode }),
    winRatioDesigns: presentWinRatioDesigns(bundle, { nodeOf: resultNode }),
    valueOfInformation: presentValueOfInformation(bundle, { nodeOf: resultNode }),
  };
  const everyResult = allResultsOf(bundle);
  const cardRows = Object.values(cards).flat().map((card) => {
    const result = everyResult.find((row) => row.id === card.id);
    return { card, subjectId: text(result?.subjectId), createdAt: String(result?.createdAt ?? "") };
  });
  const askedRow = asked ? designRows.find((row) => row.id === asked && row._result) ?? null : null;
  const askedCard = asked && !askedRow ? cardRows.find((entry) => entry.subjectId === asked || entry.card.id === asked) ?? null : null;
  const chosenRow = designRows.find((row) => row.chosen && row._result) ?? null;
  const newestRow = askedRow ?? chosenRow ?? [...designRows].reverse().find((row) => !row.dominated && row._result) ?? null;
  const newestCard = asked || chosenRow ? null : [...cardRows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const primaryCard = askedCard ?? (newestCard && (!newestRow || newestCard.createdAt > String(newestRow._result?.createdAt ?? "")) ? newestCard : null);
  const headlineRow = newestRow;
  const decision = decisions[0] ?? null;
  const columnSpec = [
    ["required_events", "所需事件数", "例"], ["sample_size", "样本量", "例"], ["expected_events", "期望事件数", null], ["power", "功效", "%"], ["assurance", VCR_RESULT_QUANTITY_LABELS_ZH.assurance, "%"],
    ["type_one_error", "I 类错误", "%"], ["bias", "偏倚", null], ["coverage", "覆盖率", "%"], ["expected_sample_size", "期望样本量", "例"], ["expected_sample_size_null", "无效应时的期望样本量", "例"], ["first_stage_stop_probability_null", "无效应时在第一阶段就停止的概率", "%"], ["duration_months", "平均研究时长", "月"], ["last_patient_in_months", "末例入组（入组假设模拟）", "月"], ["cost", "成本", "万元"],
  ];
  // The type I error is a column as soon as a design waits for one (the check follows the result): a cell that says 排队中 needs its column.
  const columns = columnSpec
    .filter(([key]) => live.some((design) => design.measures[/** @type {string} */ (key)] || (key === "type_one_error" && design.nullState)))
    .map(([key, label, unit]) => ({ key, label, unit }));
  const grids = gridView(grid);
  const powerRaw = object(headlineRow?._result?.diagnostics?.powerCurve);
  // The curve's axis is a probability the page shows as a percentage, like every design measure.
  const powerSeries = (seriesList(powerRaw.series).length ? seriesList(powerRaw.series) : grids.powerSeries).map((series) => scaledSeries(series, 100));
  const marks = designRows.map((row) => row._stale).filter(Boolean);
  // What each design's last run was, as facts a record drawer reads — the method and its replicates, the seed, and the closed form held
  // against the simulation — and not as a card's sentences. A closed-form value is exact for some methods and a first-order
  // approximation for others (the log-rank power): the engine says which, and the tolerance it holds the simulation to — three
  // Monte-Carlo errors plus the approximation's documented bias.
  /** @param {Record<string, any>} row */
  const recordOf = (row) => {
    const execution = executionOf(bundle, row._result);
    const check = object(object(row._result.diagnostics).analyticCheck);
    const difference = numeric(check.difference);
    const within = check.withinTolerance ?? check.withinThreeMcse;
    return {
      method: execution ? METHOD_LABELS[String(execution.method)] ?? null : null,
      replicates: execution?.replicates != null ? Number(execution.replicates) : null,
      replicateReasons: replicateReasons(bundle, row._stages),
      seed: execution?.seed != null ? Number(execution.seed) : null,
      check: difference === null ? null : {
        analytic: numeric(check.value) !== null ? roundTo(Number(check.value) * 100, 1) : null,
        simulated: numeric(check.simulated) !== null ? roundTo(Number(check.simulated) * 100, 1) : null,
        differencePoints: roundTo(Math.abs(difference) * 100, 1),
        allowedPoints: numeric(check.tolerance) !== null ? roundTo(Number(check.tolerance) * 100, 1) : null,
        approximate: numeric(check.approximationBias) !== null && Number(check.approximationBias) > 0,
        agrees: typeof within === "boolean" ? within : null,
      },
    };
  };
  const statedGoal = text(decision?.question) ?? text(object(grid?.comparisonGoal).text) ?? null;
  const objective = trialObjective(headlineRow, statedGoal);
  const recorded = designs.map((design) => {
    const row = designRows.find((entry) => entry.id === design.id);
    const meets = design.dominated ? null : trialMeets(design.measures, objective);
    return { ...design, record: row?._result ? recordOf(row) : null, ...(meets ? { meets } : {}) };
  });
  const forecastRows = forecasts.map((forecast) => forecastView(forecast, now));
  const milestones = designRows.filter(row => !row.dominated).map(row => ({
    design: row.code, name: row.name, items: [
      ...(row.measures.duration_months ? [{ key: "trial_duration", label: "平均研究时长", value: row.measures.duration_months }] : []),
      ...(row.measures.last_patient_in_months ? [{ key: "last_patient_in", label: "末例入组（入组假设模拟）", value: row.measures.last_patient_in_months }] : []),
    ],
  })).filter(row => row.items.length);
  const accrualForecasts = allResultsOf(bundle).filter(row => row.kind === "accrual_forecast").map(result => {
    const scenario = scenarios.find(row => row.id === result.subjectId);
    const design = designs.find(row => row.id === scenario?.id);
    const read = bundle.accrualReads?.get(result.id);
    const value = name => {
      const raw = list(result.measures).map(object).find(row => row.name === name);
      return raw ? measureValue(raw, { kind: "accrual_forecast", result, tab: "trial", staleMark: markFor(bundle.stale, resultNode(result)) }) : null;
    };
    const probabilityByMonth = list(read?.probabilityByMonth ?? object(result.diagnostics).probabilityByMonth).map(object)
      .filter(row => numeric(row.month) !== null && Number(row.month) >= 0 && numeric(row.probability) !== null && Number(row.probability) >= 0 && Number(row.probability) <= 1)
      .map(row => ({ month: Number(row.month), probability: Number(row.probability) }));
    return { id: result.id, version: result.version, scenarioId: scenario?.id ?? null, scenarioVersion: scenario?.version ?? null,
      design: design?.code ?? null, name: design?.name ?? "入组假设模拟", lastPatientIn: value("last_patient_in_months"),
      targetEvents: value("target_events_months"), probabilityByMonth };
  });
  const goal = text(decision?.question) ?? text(object(grid?.comparisonGoal).text) ?? null;
  return {
    headline: (primaryCard ? cardHeadline(primaryCard.card, designs) : null) ?? trialHeadline(designs, { primary: headlineRow ? designs.find((design) => design.id === headlineRow.id) : null, asked: Boolean(askedRow) }),
    ademp: primaryCard ? adempOf(bundle, null) : adempOf(bundle, headlineRow?._scenario ?? scenarios[0] ?? null, object(headlineRow?._result?.diagnostics), headlineRow?._stages ?? {}),
    // 「这个结论的前提」: the numbers the headline design's result stands on, where each came from, and the defaults among them.
    // With no design asked for or chosen and several on the page, the block holds only what every one of them stands on: the last design's
    // numbers above a table of other designs read as the page's (live D3: the null check's hazard ratio of 1 above designs at 0.75).
    premises: primaryCard ? list(primaryCard.card.premises)
      : headlineRow ? (!asked && !chosenRow && live.filter((design) => designRows.some((row) => row.id === design.id && row._result)).length > 1
        ? premisesInCommon([headlineRow, ...designRows.filter((row) => row !== headlineRow && !row.dominated && row._result)].map((row) => vcrPremises("trial", trialPremiseInput(bundle, row))))
        : vcrPremises("trial", trialPremiseInput(bundle, headlineRow))) : [],
    // What the sample size rests on, one input at a time, and the power the effect's published shrinkage leaves (C6).
    sensitivity: trialSensitivity(headlineRow),
    // The yardstick the trade-off is drawn against when nobody wrote one: alpha and the target power (C7).
    objective,
    designs: recorded,
    columns,
    grid: grids.heat,
    footnotes: [...notRerunNotes(designRows), ...maxComboNotes(designRows)],
    powerCurve: powerSeries.length ? {
      xLabel: text(powerRaw.xLabel) ?? "真实效应", yLabel: text(powerRaw.yLabel) ?? "功效", unit: "%", series: powerSeries,
      markers: markersOf(headlineRow?._scenario), prior: list(powerRaw.prior).map(object).filter((point) => finite(point.x) !== null && finite(point.y) !== null).map((point) => ({ x: Number(point.x), y: Number(point.y) })),
    } : null,
    decision: designs.length ? {
      goal,
      chosen: designs.find((design) => design.chosen)?.id ?? null,
      chosenLabel: designs.find((design) => design.chosen)?.code ?? null,
      rationale: text(decision?.rationale),
      recordedAt: decision ? zhTime(decision.createdAt, now) : null,
      options: designs.map((design) => ({ id: design.id, label: design.code, name: design.name, disabled: design.dominated })),
    } : null,
    forecasts: forecastRows,
    accrualForecasts,
    // The base rates of development, two sources side by side, beside an assurance (E6): a reference, never this trial's probability.
    successRates: designs.some((design) => design.measures.assurance) ? vcrSuccessRatesPage() : null,
    // The confirmatory designs the conversation computed (design_confirmatory): a card each, with its own premises and baselines.
    confirmatoryDesigns: cards.confirmatoryDesigns,
    // The dose-finding designs (design_dose) and the Bayesian designs without MCMC (design_bayesian) the conversation computed: a card each.
    doseDesigns: cards.doseDesigns,
    bayesianDesigns: cards.bayesianDesigns,
    // The hierarchical composite endpoints compared by win ratio (design_win_ratio) the conversation computed: a card each.
    winRatioDesigns: cards.winRatioDesigns,
    // the value of information of a decision (decision_voi) the conversation computed: a card each
    valueOfInformation: cards.valueOfInformation,
    milestones,
    // The protocol's visit schedule (「访视日程」) and the study's regulatory contacts (「监管沟通记录」): records, not results.
    schedule: reportSchedule(bundle.schedule),
    regulatory: list(bundle.regulatory).map((contact) => ({
      id: contact.id, date: contact.date, agency: contact.agency, type: contact.type, summary: contact.summary, outcome: contact.outcome,
      attachments: list(contact.attachments), source: contact.source, recordedAt: zhTime(contact.recordedAt, now),
    })),
    counts: headlineRow ? countsView(headlineRow._result?.counts, { tier: study.dataTier, scope: `方案 ${headlineRow.code}` }) : null,
    stale: staleNote(marks),
    partial: partialOf(bundle, ["trial_scenario", "design_grid"], "这次模拟"),
  };
}

/**
 * The premises every one of several designs states alike: the same key and value in each list, as the first list (the newest design's) words them.
 * @param {ReadonlyArray<ReadonlyArray<Record<string, any>>>} lists
 * @returns {Array<Record<string, any>>}
 */
function premisesInCommon(lists) {
  const [first = [], ...others] = lists;
  const same = (/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b) => a.key === b.key && JSON.stringify(a.value) === JSON.stringify(b.value);
  return first.filter((row) => others.every((other) => other.some((entry) => same(entry, row))));
}

/**
 * What the premises of a trial result are made of: the design's scenario, the cards that were laid over it when it was computed (the
 * job's own record of them, read through the cards the study holds now), the defaults its stage took, and whether the success
 * probability is there — and, when it is not, why.
 * @param {Record<string, any>} bundle @param {Record<string, any>} row a design row of `presentDesigns`
 */
function trialPremiseInput(bundle, row) {
  const scenario = row._scenario;
  const stages = object(row._stages);
  const stage = stages.simulation ?? stages.analytic ?? null;
  const execution = bundle.executions?.get?.(stage?.result?.executionId ?? row._result?.executionId);
  const selectedJobId = stage?.jobId ?? execution?.jobId;
  // A later sensitivity run is not the evidence of this immutable result.
  const bound = list(bundle.jobs).map(object).filter(job => selectedJobId
    ? job.id === selectedJobId : object(job.checkpoint).subjectId === scenario.id)
    .flatMap(job => list(object(job.checkpoint).bound).map(object));
  const kind = String(scenario.design ?? object(object(scenario.configuration).design).kind ?? "");
  const supportsAssurance = Boolean(/** @type {Record<string, Record<string, readonly string[]>>} */ (VCR_DESIGN_SUPPORT)["design.assurance"]?.[kind]?.includes(String(scenario.endpointType)));
  const ran = Boolean(stages.simulation || stages.analytic);
  return {
    endpointType: scenario.endpointType,
    designKind: kind,
    configuration: scenario.configuration,
    diagnostics: stage?.diagnostics ?? {},
    bound,
    cards: [...list(bundle.assumptions), ...[...(bundle.assumptionVersions?.values?.() ?? [])].flat()],
    appliedDefaults: appliedDefaultsOf(scenario, stages),
    // which numbers are in the person's own messages (a conversation's design job froze it): the newest stage that has the record
    personStated: stages.simulation?.diagnostics?.personStated ?? stages.analytic?.diagnostics?.personStated ?? row._result?.diagnostics?.personStated ?? null,
    simulated: Boolean(stages.simulation),
    assuranceRan: Boolean(stages.assurance),
    hasAssurance: !(supportsAssurance && ran) || Boolean(stages.assurance),
    assuranceReason: "没有算：效应只有一个值，没有可以积分的预测分布",
    // The power the design keeps at the effect reduced by the published gap, from the analytic stage (C6); absent where there is none.
    effectDiscount: object(stages.analytic?.diagnostics?.sensitivity).discount ?? null,
    researchQuestion: resultQuestionInput(bundle, { executionId: stage?.result?.executionId ?? row._result?.executionId ?? null }),
  };
}

/**
 * The enrolment-year row of the balance plot (remediation plan D6): the two arms' mean calendar year of the time-zero date, the
 * difference before and after the weights, and how many external controls entered outside the trial's own years. The year is not
 * part of the weighting, so the row says that it is beside the balance and not in it; a result with no date column has no row and no
 * sentence, and a date column nobody could read a year from has the one sentence.
 * @param {unknown} raw `diagnostics.enrolmentYear`
 * @returns {{ row: Record<string, any> | null, note: string | null }}
 */
function enrolmentYearView(raw) {
  const entry = object(raw);
  if (!Object.keys(entry).length) return { row: null, note: null };
  if (entry.status !== "computed") {
    return { row: null, note: entry.status === "unreadable" ? "入组年份没有算：日期列里读不出年份。" : "入组年份没有算：读得出年份的人太少。" };
  }
  const treated = object(entry.treated);
  const control = object(entry.control);
  const smd = finite(entry.smdAdjusted);
  const outside = finite(object(entry.controlOutsideTrialYears).share);
  const treatedYears = finite(treated.min) !== null && finite(treated.max) !== null
    ? (treated.min === treated.max ? `${treated.min}` : `${treated.min}–${treated.max}`) : null;
  // The means ride in the sentence: a year is not a number the plot may format (2,020.1), and the two levels of a covariate row are for
  // covariates.
  const year = (/** @type {unknown} */ mean) => (finite(mean) === null ? null : String(roundTo(/** @type {number} */ (mean), 1)));
  const levels = year(treated.mean) !== null && year(control.mean) !== null ? `平均入组年份：本研究 ${year(treated.mean)}，外部对照 ${year(control.mean)}。` : "";
  return {
    row: {
      key: "enrolment_year", label: "入组年份",
      ours: plainValue(null, { source: "observed" }), theirs: plainValue(null, { source: "observed" }),
      smd, smdBefore: finite(entry.smdUnadjusted), flagged: smd !== null && Math.abs(smd) > VCR_SMD_FLOOR,
      note: `${levels}没有按它加权${outside !== null && treatedYears ? `；外部对照有 ${Math.round(outside * 100)}% 的人入组年份不在本研究的 ${treatedYears} 年之内` : ""}。`,
    },
    note: null,
  };
}

/** What a paper gave a Kaplan-Meier reconstruction, by the name the engine gives the level. */
const RECONSTRUCTION_LEVEL_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  risk_table_and_events: "论文给了风险人数表和总事件数", risk_table: "论文只给了风险人数表", events_only: "论文只给了总事件数（没有风险人数表）",
  curve_only: "论文只给了曲线和起始人数",
}));

/**
 * The information level of a reconstruction (A10): which of the numbers a reconstruction can be held to the paper gave. Levels 3 and 4
 * have no risk table to check censoring against and say so; at level 4 the hazard ratio is not estimable, while the survival curves and
 * the medians are delivered.
 * @param {Record<string, any>} diagnostics
 */
function reconstructionLevelView(diagnostics) {
  const level = object(diagnostics.informationLevel);
  const key = text(level.key);
  if (!key || !RECONSTRUCTION_LEVEL_WORDS[key]) return null;
  const arms = list(level.arms).map(object).filter((arm) => RECONSTRUCTION_LEVEL_WORDS[String(arm.key)]);
  const names = ["对照组", "试验组"];
  return {
    level: numeric(level.level), key, label: RECONSTRUCTION_LEVEL_WORDS[key],
    arms: arms.length > 1 ? arms.map((arm, index) => ({ name: names[index] ?? String(arm.name ?? ""), label: RECONSTRUCTION_LEVEL_WORDS[String(arm.key)] })) : [],
    hazardRatio: object(diagnostics.hazardRatio).status === "not_estimable" ? "风险比不可估计：没有风险人数表，也没有总事件数" : null,
    limited: numeric(level.level) !== null && Number(level.level) >= 3,
  };
}

/** The priors of a MAP operating-characteristics table, by the name the engine gives them. */
const OC_PRIOR_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ none: "不借用（只用本研究对照）" }));

/**
 * A MAP prior's table of operating characteristics as the comparator page draws it: one row per drift, prior and case (no effect: the
 * type I error at that drift; an effect: the power), the rejection probability as a percentage with its Monte-Carlo error, and the
 * replicates behind it — with the reason it ran that many (a borrowing design is held to the null floor). Null where the result has none.
 * @param {Record<string, any>} diagnostics
 */
function operatingCharacteristicsView(diagnostics) {
  const table = object(diagnostics.operatingCharacteristics);
  const rows = list(table.rows).map(object).flatMap((row) => {
    const drift = finite(row.drift);
    const rejection = finite(row.rejection);
    const scenario = row.scenario === "null" || row.scenario === "alternative" ? row.scenario : null;
    if (drift === null || rejection === null || !scenario) return [];
    const prior = String(row.prior ?? "");
    const weight = /^robust_(.+)$/.exec(prior)?.[1];
    const mcse = finite(row.mcse);
    return [{
      drift, prior, priorLabel: OC_PRIOR_WORDS[prior] ?? (weight ? `借用（稳健权重 ${weight}）` : prior), scenario,
      rejection: roundTo(rejection * 100, 2), mcse: mcse === null ? null : roundTo(mcse * 100, 2), replicates: finite(row.replicates),
    }];
  });
  if (!rows.length) return null;
  const plan = object(diagnostics.replicatePlan);
  const floor = finite(plan.floor);
  const reason = plan.basis === "borrowing" && floor !== null ? `借用历史数据的设计，零效应的各行至少 ${floor.toLocaleString("en-US")} 次`
    : plan.basis === "intended_use" && floor !== null ? `按研究用途，零效应的各行至少 ${floor.toLocaleString("en-US")} 次` : null;
  return { replicates: finite(table.replicates), asked: finite(table.asked), capped: table.capped === true, reason, rows };
}

/** What a stage of a design's result is called when it is said not to have been redone. */
const STAGE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ assurance: VCR_RESULT_QUANTITY_LABELS_ZH.assurance, analytic: "解析计算", simulation: "仿真", reconstruct: "曲线重建", rmst: "RMST 比较" }));

/**
 * The notes under the design table: a stage the design had and its latest
 * computation did not run again is not left on the page as if it were current
 * — it is dropped, and said. The usual case is a design whose effect card lost
 * its prediction distribution: there is no prior to integrate over any more, and
 * the success assurance it once had described a belief that is gone.
 * @param {ReadonlyArray<Record<string, any>>} designRows
 */
function notRerunNotes(designRows) {
  /** @type {string[]} */
  const notes = [];
  for (const row of designRows) {
    for (const entry of list(object(row._result?.diagnostics).notRerun).map(object)) {
      const word = STAGE_WORDS[String(entry.stage)] ?? String(entry.stage);
      notes.push(entry.stage === "assurance"
        ? `方案 ${row.code}：${VCR_RESULT_QUANTITY_LABELS_ZH.assurance}不再显示——效应假设卡现在没有预测分布，没有可以积分的先验，这一项没有重算。`
        : `方案 ${row.code}：上一次的${word}没有重算，已不再显示。`);
    }
  }
  return notes;
}

/**
 * What a MaxCombo run says beside its own power (T13): the log-rank power of the same replicates and the strong null — a world in which the
 * treatment is never better and is worse early on — where both tests are asked how often they call the treatment better. Information in
 * the table's notes, not a verdict.
 * @param {ReadonlyArray<Record<string, any>>} designRows
 */
export function maxComboNotes(designRows) {
  /** @type {string[]} */
  const notes = [];
  for (const row of designRows) {
    if (row.dominated) continue;
    const measures = list(row._stages?.simulation?.measures).map(object);
    const find = (/** @type {string} */ name) => measures.find((entry) => entry.name === name) ?? null;
    // three significant digits: a rejection probability of 0.03% is not "0%"
    const percent = (/** @type {Record<string, any> | null} */ entry) => (entry && numeric(entry.value) !== null
      ? `${plainNumber(Number(entry.value) * 100)}%${numeric(entry.mcse) !== null ? `（±${plainNumber(Number(entry.mcse) * 100)}）` : ""}` : null);
    const logrank = percent(find("power_logrank") ?? find("type_one_error_logrank"));
    if (logrank) notes.push(`方案 ${row.code}：同样的模拟里，log-rank 检验的${find("power_logrank") ? "功效" : "I 类错误"}是 ${logrank}。`);
    const strong = percent(find("type_one_error_strong_null"));
    const strongLogrank = percent(find("type_one_error_strong_null_logrank"));
    if (strong && strongLogrank) {
      const law = object(row._stages?.simulation?.diagnostics?.strongNull);
      const ratios = list(law.ratios).map(Number).filter(Number.isFinite);
      const when = ratios.length === 2 && numeric(law.breaks) !== null ? `试验组前 ${plainNumber(Number(law.breaks))} ${TIME_UNIT_WORDS[String(law.timeUnit)]?.after ?? "个月"}的风险比为 ${plainNumber(ratios[0])}、之后与对照相同` : "试验组从不优于对照";
      notes.push(`方案 ${row.code}：在“${when}”的情形里（试验组从未更好），MaxCombo 判为试验组更优的概率是 ${strong}，log-rank 是 ${strongLogrank}；名义水平 ${plainNumber(Number(law.alpha ?? 0.025) * 100)}%。`);
    }
  }
  return notes;
}

/** @param {number} value */
const plainNumber = (value) => String(Number(value.toPrecision(3)));

/** The vertical markers of a power curve: the assumed effect, which is a setting and not an estimate. @param {Record<string, any> | null | undefined} scenario */
function markersOf(scenario) {
  const truth = object(object(scenario?.configuration).truth);
  const effect = numeric(truth.hazardRatio ?? truth.effect);
  return effect === null ? [] : [{ x: effect, label: `情景设定 ${effect}`, kind: "assumed" }];
}

/**
 * A grid row's name when the grid gave it none: the row's own size, and its kind when the row states one. Live D3 (2026-11-07): the
 * three rows of a 150/200/250-per-arm grid were each called by the name of the page's design at the same position (“固定样本两组比较，
 * 风险比 0.75”), and the size that tells them apart was nowhere on the page.
 * @param {Record<string, any>} design one entry of the grid's `designs`
 * @returns {string | null}
 */
function gridDesignLabel(design) {
  const kind = /** @type {Record<string, string>} */ (VCR_TRIAL_DESIGN_LABELS_ZH)[String(design.kind)] ?? null;
  const treat = numeric(design.nTreat);
  const control = numeric(design.nControl);
  const total = numeric(design.n);
  const first = numeric(design.n1);
  const size = treat !== null && control !== null
    ? (treat === control ? `每组 ${treat} 例` : `试验组 ${treat} 例、对照组 ${control} 例`)
    : total !== null ? `共 ${total} 例${first !== null ? `（第一阶段 ${first} 例）` : ""}` : null;
  return [kind, size].filter(Boolean).join("，") || null;
}

/**
 * A grid column's name when the grid gave the truth none: the effect it states, and that it is the null when it says so. A column called
 * 「情景 2」 said nothing of the truth it held.
 * @param {Record<string, any>} truth one entry of the grid's truths
 * @returns {string | null}
 */
function gridTruthLabel(truth) {
  const value = (/** @type {string} */ key) => numeric(truth[key]);
  const rate = (/** @type {number} */ x) => `${roundTo(x * 100, 1)}%`;
  const effect = value("hazardRatio") !== null ? `风险比 ${value("hazardRatio")}`
    : value("effect") !== null ? `效应 ${value("effect")}`
    : value("oddsRatio") !== null ? `比值比 ${value("oddsRatio")}`
    : value("riskDifference") !== null ? `率差 ${value("riskDifference")}`
    : value("treatmentRate") !== null ? `试验组率 ${rate(/** @type {number} */ (value("treatmentRate")))}`
    : value("responseRate") !== null ? `有效率 ${rate(/** @type {number} */ (value("responseRate")))}`
    : null;
  const none = truth.null === true ? "无效应" : null;
  return effect && none ? `${effect}（${none}）` : effect ?? none;
}

/**
 * The design grid: a heat grid of one measure across designs and truths, and
 * the power-against-effect series that read off the same cells. Only cells the
 * grid actually holds are drawn.
 * @param {Record<string, any> | null} grid
 */
function gridView(grid) {
  // A cell is addressed the way the engine numbers it: the first design under the first truth is
  // (1, 1) — R's own — so the position on the page is the index less one, and a cell numbered 0
  // is not one of this grid's (it would be the design before the first).
  const cells = list(grid?.cells).map(object).filter((cell) => (finite(cell.designIndex) ?? 0) >= 1 && (finite(cell.truthIndex) ?? 0) >= 1);
  if (!grid || !cells.length) return { heat: null, powerSeries: [] };
  const truths = list(grid.truthScenarios).map(object);
  const dimensionDesigns = list(object(grid.dimensions).designs).map(object);
  const measureOf = (/** @type {any} */ cell, /** @type {string[]} */ names) => list(cell.measures).map(object).find((measure) => names.includes(String(measure.name)));
  const designCount = Math.max(...cells.map((cell) => Number(cell.designIndex)));
  const truthCount = Math.max(...cells.map((cell) => Number(cell.truthIndex)));
  // A column is named by what the grid says of its truth, else by the effect the truth states.
  const columns = Array.from({ length: truthCount }, (_unused, index) => ({ key: `t${index}`,
    header: text(truths[index]?.name) ?? text(truths[index]?.label) ?? (truths[index] ? gridTruthLabel(truths[index]) : null) ?? `情景 ${index + 1}` }));
  // A row is named by what the grid says of it, else by its own size, never by the page's design at the same position (live 2026-11-07: a
  // row the grid's list did not hold was called 「固定样本两组比较，风险比 0.75」, the name of another object); with neither it is numbered.
  const rowName = (/** @type {number} */ index) => text(dimensionDesigns[index]?.label) ?? text(dimensionDesigns[index]?.name)
    ?? (dimensionDesigns[index] ? gridDesignLabel(dimensionDesigns[index]) : null);
  const rowHeader = (/** @type {number} */ index) => rowName(index) ?? `设计 ${index + 1}`;
  const rows = Array.from({ length: designCount }, (_row, index) => ({
    key: `d${index}`,
    header: rowHeader(index),
    cells: Array.from({ length: truthCount }, (_unused, truthIndex) => {
      const cell = cells.find((entry) => Number(entry.designIndex) === index + 1 && Number(entry.truthIndex) === truthIndex + 1);
      const measure = cell ? measureOf(cell, ["power", "type_one_error"]) : null;
      const value = measure ? finite(measure.value) : null;
      if (value === null) return { value: null, text: "—", hint: "没有算出" };
      const mcse = finite(measure?.mcse);
      return {
        value, text: `${roundTo(value * 100, 1)}%`,
        hint: `${measureLabel(String(measure?.name))} ${roundTo(value * 100, 1)}%${mcse !== null ? `（蒙特卡洛标准误 ±${roundTo(mcse * 100, 2)}）` : ""}`,
      };
    }),
  }));
  const measureName = cells.some((cell) => measureOf(cell, ["power"])) ? "功效" : "I 类错误";
  /** @type {any[]} */
  const powerSeries = [];
  const effects = truths.map((truth) => finite(truth.effect ?? truth.hazardRatio));
  if (effects.every((effect) => effect !== null) && truthCount >= 3) {
    for (let index = 0; index < designCount; index += 1) {
      const points = Array.from({ length: truthCount }, (_unused, truthIndex) => {
        const cell = cells.find((entry) => Number(entry.designIndex) === index + 1 && Number(entry.truthIndex) === truthIndex + 1);
        const measure = cell ? measureOf(cell, ["power", "type_one_error"]) : null;
        return { x: /** @type {number} */ (effects[truthIndex]), y: finite(measure?.value), low: null, high: null };
      }).filter((point) => point.y !== null).sort((a, b) => a.x - b.x);
      if (points.length >= 2) {
        powerSeries.push({ key: `d${index}`, label: rowHeader(index), source: "predicted", ours: false, pooled: false, points,
          bandKind: null, endLabel: null, endNote: null, atRisk: [], individuals: [], dashed: false, unobserved: [] });
      }
    }
  }
  return {
    heat: { measure: measureName, xLabel: "真实效应情景", yLabel: "设计", columns, rows },
    powerSeries,
  };
}

/**
 * One registered forecast, as a reader sees it: when it was made, the numbers it predicted and — once it exists — the actual beside
 * them. The registered prediction is the result's own measures (`{ measures: { power: { value, mcse } } }`, or the accrual forecast's
 * median and interval); the ids, the hash and the replicate count that make it provable are the registry's, and stay there.
 * @param {Record<string, any>} forecast @param {Date} now
 */
function forecastView(forecast, now) {
  const prediction = object(forecast.prediction);
  const actual = forecast.actual == null ? null : object(forecast.actual);
  /** @type {Array<{ key: string, label: string, predicted: string, actual: string | null }>} */
  const lines = [];
  /** @type {Array<[string, Record<string, any>]>} */
  const measures = Array.isArray(prediction.measures)
    ? prediction.measures.map(object).map((entry) => [String(entry.name ?? ""), entry])
    : Object.entries(object(prediction.measures)).map(([name, entry]) => [name, object(entry)]);
  for (const [name, entry] of measures) {
    const value = finite(entry.value);
    if (!name || value === null) continue;
    const mcse = finite(entry.mcse);
    lines.push({ key: name, label: measureLabel(name), predicted: `${plainText(name, value)}${mcse !== null ? ` ±${plainText(name, mcse).replace(/^-/, "")}` : ""}`,
      actual: actual && actual[name] != null ? plainText(name, actual[name]) : null });
  }
  // What an accrual forecast and an older registration state at the top level, in words: never an id.
  const named = lines.length ? [] : Object.entries(prediction).filter(([key, value]) => typeof value === "number" && !["version", "replicates"].includes(key)).slice(0, 6);
  for (const [key, value] of named) {
    lines.push({ key, label: measureLabel(key), predicted: plainText(key, value), actual: actual && actual[key] != null ? plainText(key, actual[key]) : null });
  }
  return {
    id: String(forecast.id),
    label: forecast.kind === "accrual" ? "入组预测" : forecast.kind === "trial" ? "方案预测" : String(forecast.kind),
    version: Number(forecast.version),
    frozenAt: zhTime(forecast.createdAt, now),
    comparedAt: forecast.comparedAt ? zhTime(forecast.comparedAt, now) : null,
    lines,
  };
}

// --- 匹配与招募 ---------------------------------------------------------------------------------------------------------------------

const SUMMARY_ORDER = Object.freeze(["eligible", "insufficient_evidence", "pending", "ineligible"]);
/** The most citations a criterion row shows under its verdict. */
const EVIDENCE_SHOWN = 3;

/**
 * The words under a citation for what it did not print: a unit read by the domain's table (`unitBasis`), a date taken from another
 * line of the same record (`dateLocator`). Neither is ever shown as if the quotation said it.
 * @param {Record<string, any>} evidence @returns {string | null}
 */
function evidenceNote(evidence) {
  const parts = [];
  if (evidence.unitBasis === "conventional" && text(evidence.unit)) parts.push(`单位 ${evidence.unit} 是按惯例读出的，原文没有印`);
  // A date from the record's header has its own words, beside the date (`dateNote`); this one is for a date read from some other line.
  if (evidence.dateLocator && evidence.dateBasis !== "record_header") parts.push("日期取自同一份病历的另一处，不是这句话里印的");
  return parts.length ? parts.join("；") : null;
}

/**
 * The words beside a date the fact did not print itself but took from the header of the record it sits in (`source.dateBasis`), and for a
 * past event that this is only the latest it could have been (`dateBound`): a scientist judging a window verdict needs both. Null for a date the
 * quotation or a quotation for that very fact printed.
 * @param {unknown} basis @param {unknown} bound @returns {string | null}
 */
function dateNote(basis, bound) {
  if (basis !== "record_header") return null;
  return bound === "no_later_than" ? "日期取自病历抬头，事件发生不晚于这一天" : "日期取自病历抬头";
}

/**
 * The criterion the way a coordinator reads it: the protocol's own words, the
 * patient's own sentence, and what to ask for.
 * @param {Record<string, any>} criterion @param {string} code @param {Record<string, any> | null} judgment @param {Date} now
 */
function judgementView(criterion, code, judgment, now, documentNames = new Map()) {
  // Every citation the verdict rests on, not only the first: an `unknown` that waits on a prescription also shows the administration it
  // was set against. Each says what it quotes, where (the document by the name the data tab lists it under, never a person's), and
  // when what it records happened.
  const cited = list(judgment?.evidence).map(object).filter((item) => text(item.quote)).slice(0, EVIDENCE_SHOWN).map((evidence) => ({
    quote: String(evidence.quote), locator: evidence.locator ?? null,
    source: evidence.quoteKind === "snapshot_cell" ? `数据快照字段「${object(evidence.locator).field ?? evidence.variable}」`
      : evidence.quoteKind === "verbatim" ? (documentNames.get(String(object(evidence.locator).documentId)) ?? "病历原文") : (vcrLocatorText(evidence.locator) ?? text(evidence.source)),
    at: zhDate(evidence.at ?? evidence.occurredAt ?? object(evidence.locator).at, now),
    // Where the date came from when no quotation of the fact printed it: the header of the record, said beside the date.
    dateNote: dateNote(evidence.dateBasis, evidence.dateBound),
    // What the quotation does not itself say, said beside it: a unit the domain's table supplied, a date taken from another line.
    note: evidenceNote(evidence),
  }));
  const state = judgment?.overrideState ?? judgment?.state ?? "unknown";
  const needed = list(criterion.evidenceNeeded).map((item) => (typeof item === "string" ? item : text(object(item).description) ?? text(object(item).text) ?? text(object(item).variable))).filter(Boolean);
  return {
    // What a re-judgment is addressed to; `code` is only the label the page derives from position.
    criterionId: text(criterion.id),
    code,
    kind: criterion.kind,
    text: text(criterion.sourceText) ?? "",
    state,
    applicable: judgment ? judgment.applicable !== false : true,
    evidence: cited[0] ?? null,
    evidenceItems: cited,
    request: state === "unknown" || state === "pending_recheck" ? (needed[0] ?? null) : null,
    // Why it is not decided, in the assessment's own words (缺登记原文, 单位对不上, …): the first reason the criterion's gaps give.
    reason: state === "unknown" || state === "pending_recheck" ? (text(object(list(judgment?.missing)[0]).label) ?? null) : null,
    requestNote: state === "pending_recheck" && judgment?.recheckAt ? `${zhDate(judgment.recheckAt, now)} 起可复评` : null,
    decidedBy: judgment?.decidedBy ?? null,
    overridden: Boolean(judgment?.overrideState),
  };
}

/** The verdict sentence: always a reason, never a bare no. @param {string} summary @param {Array<{ code: string, kind: string, state: string }>} rows */
function verdictOf(summary, rows) {
  const unknownExclusion = rows.filter((row) => row.kind === "exclusion" && row.state === "unknown").map((row) => row.code);
  const unknownInclusion = rows.filter((row) => row.kind === "inclusion" && row.state === "unknown").map((row) => row.code);
  const failed = rows.filter((row) => row.state === "not_satisfied").map((row) => row.code);
  const pending = rows.filter((row) => row.state === "pending_recheck").map((row) => row.code);
  if (summary === "eligible") return { text: "符合：全部适用的入排条件都满足", note: null };
  if (summary === "ineligible") return { text: `不符合：${failed.join("、")} 不满足`, note: null };
  if (summary === "pending") return { text: `待复评：${pending.join("、")} 要等到复评日`, note: null };
  const codes = [...unknownExclusion, ...unknownInclusion];
  return {
    text: `不能判为符合：${unknownExclusion.length ? "排除标准" : "入选标准"} ${codes.join("、")} 未知`,
    note: pending.length ? `${pending.join("、")} 待复评` : null,
  };
}

/**
 * 「给患者找试验」: one patient's trials as the page reads them — the list in the order the platform ranked it (each with the registry id and
 * its link, the title, the phase and the status in the reader's words, the eligibility and how many criteria stand where) and the chosen
 * trial's criterion table for this patient. Nothing is ranked or judged here: the order and every state were made in code.
 * @param {Record<string, any>} bundle @param {{ available?: boolean, subjectKey: string | null, ranked: any[], detail: any }} held
 */
function presentPatientTrials(bundle, held) {
  const { now } = bundle;
  const count = (/** @type {any} */ counts, /** @type {string} */ key) => Number(object(counts)[key] ?? 0);
  const trials = held.ranked.map((entry) => {
    const counts = {
      satisfied: count(entry.counts, "satisfied"), unknown: count(entry.counts, "unknown"),
      notSatisfied: count(entry.counts, "not_satisfied"), pending: count(entry.counts, "pending_recheck"),
    };
    const decided = entry.counts ? decidedShare(entry.counts) : null;
    return {
      id: String(entry.id), kind: entry.kind, rank: entry.rank,
      registry: entry.registry ?? null, registryId: entry.registryId ?? null, url: entry.url ? String(entry.url) : null,
      // The registry's status is as of the day its record was read (the study's own protocol has none).
      title: String(entry.title), phase: phaseLabel(entry.phase), status: registryStatusLabel(entry.status),
      statusAsOf: entry.kind === "registry" && entry.retrievedAt ? zhDate(entry.retrievedAt, now) : null,
      // 已判 n/m: the criteria found satisfied or not satisfied over every one that applies; unknowns are in the m.
      decided,
      conditions: list(entry.conditions).map(String),
      sites: entry.locations ? { total: numeric(entry.locations.total), countries: list(entry.locations.countries).map(String) } : null,
      eligibility: entry.summary,
      counts,
      summary: [`${counts.satisfied} 条满足`, `${counts.unknown} 条未知`, `${counts.notSatisfied} 条不满足`, ...(counts.pending ? [`${counts.pending} 条待复评`] : [])].join(" · "),
      assessedAt: zhTime(entry.asOf, now),
    };
  });
  const detail = held.detail;
  let selected = null;
  if (detail) {
    const codes = criterionCodes(detail.criteria);
    const byCriterion = new Map(list(detail.judgments).map((/** @type {any} */ row) => [row.criterionId, row]));
    const rows = detail.criteria.map((/** @type {any} */ criterion) => judgementView(criterion, codes.get(criterion.id) ?? "", byCriterion.get(criterion.id) ?? null, now));
    selected = { id: String(detail.entry.id), criteria: rows, verdict: verdictOf(detail.entry.summary, rows), assessedAt: zhTime(detail.entry.asOf, now) };
  }
  return { available: held.available !== false, subject: held.subjectKey, trials, selected };
}

/**
 * `GET /api/vcr/studies/:id/matching`.
 * @param {Record<string, any>} bundle @param {{ view?: string | null, candidate?: string | null, direction?: string | null }} [query]
 */
export function presentMatchingTab(bundle, query = {}) {
  const { study, now, match } = bundle;
  const view = "matching";
  if (!match) {
    return { view, available: false, unavailable: { code: "vcr_matching_unavailable", message: "匹配评估在本部署尚未接入；其余步骤照常。" },
      funnel: [], candidates: [], selected: null, gaps: [], counts: null };
  }
  const { criteria, tallies, openByAssessment, gapsByCriterion, pendingReview, subjects, protocol } = match;
  /** The names the data tab lists the reviewed documents under, by the id a citation carries (the document's own or its reviewed text's). @type {Map<string, string>} */
  const documentNames = match.documentNames instanceof Map ? match.documentNames : new Map();
  const codes = criterionCodes(criteria);
  const criterionCode = (/** @type {string} */ id) => codes.get(id) ?? "";
  const total = Object.values(tallies).reduce((sum, value) => sum + Number(value), 0);
  const count = (/** @type {string} */ key) => (key in tallies ? Number(tallies[key]) : null);
  const funnel = total ? [
    { key: "candidates", label: "已评估", count: total, note: null, tone: "neutral" },
    { key: "insufficient", label: "可能符合 · 待补证", count: (count("insufficient_evidence") ?? 0) + (count("pending") ?? 0), note: null, tone: "attention" },
    { key: "eligible", label: "符合", count: count("eligible") ?? 0, note: null, tone: "accent" },
    { key: "ineligible", label: "不符合", count: count("ineligible") ?? 0, note: null, tone: "neutral" },
  ] : [];
  // Everyone assessed is listed, the not-eligible after the rest: their judgement is as readable as anyone's.
  const ordered = [...subjects].sort((a, b) =>
    Number(a.basis === "withdrawn") - Number(b.basis === "withdrawn")
      || SUMMARY_ORDER.indexOf(a.summary) - SUMMARY_ORDER.indexOf(b.summary) || Number(a.counts?.unknown ?? 0) - Number(b.counts?.unknown ?? 0)
      || String(a.subjectKey).localeCompare(String(b.subjectKey)));
  const candidateOf = (/** @type {any} */ row) => {
    const counts = object(row.counts);
    const judged = openByAssessment.get(row.id) ?? [];
    const notSatisfied = Number(counts.not_satisfied ?? 0);
    return {
      id: String(row.subjectKey),
      summary: `${Number(counts.satisfied ?? 0)} 条满足 · ${Number(counts.unknown ?? 0)} 条未知 · ${Number(counts.pending_recheck ?? 0)} 条待复评${notSatisfied > 0 ? ` · ${notSatisfied} 条不满足` : ""}`,
      eligibility: row.summary,
      // What the evaluation rested on has changed since, or was withdrawn: said as a state beside the person (依据已更新 / 已撤回).
      ...(row.basis ? { basis: row.basis } : {}),
      open: judged.filter((/** @type {any} */ open) => open.state !== "not_satisfied").map((/** @type {any} */ open) => ({
        code: criterionCode(open.criterionId), state: open.state,
        note: open.recheckAt ? `${zhDate(open.recheckAt, now)} 复评` : null,
      })),
      // The rules this person fails, by code: where to look first in their rule-by-rule judgement.
      ...(judged.some((/** @type {any} */ open) => open.state === "not_satisfied")
        ? { failed: judged.filter((/** @type {any} */ open) => open.state === "not_satisfied").map((/** @type {any} */ open) => ({ code: criterionCode(open.criterionId), state: open.state })) } : {}),
      priority: row.priority ? { label: text(object(row.priority).label) ?? "临床优先级（不是获益概率）", score: numeric(object(row.priority).score), rationale: text(object(row.priority).rationale) } : null,
    };
  };
  const candidates = ordered.slice(0, 50).map(candidateOf);
  // The person asked for by name is on the page even when 50 others rank before them.
  const askedFor = query.candidate && !candidates.some((candidate) => candidate.id === query.candidate)
    ? ordered.find((row) => String(row.subjectKey) === query.candidate) : null;
  if (askedFor) candidates.push(candidateOf(askedFor));
  const chosen = candidates.find((candidate) => candidate.id === query.candidate) ?? candidates[0] ?? null;
  const selectedAssessment = match.selected ?? null;
  const selected = chosen && selectedAssessment && selectedAssessment.subjectKey === chosen.id ? (() => {
    const judgments = new Map(list(selectedAssessment.judgments).map((/** @type {any} */ row) => [row.criterionId, row]));
    const rows = criteria.map((/** @type {any} */ criterion) => judgementView(criterion, criterionCode(criterion.id), judgments.get(criterion.id) ?? null, now, documentNames));
    const verdict = verdictOf(selectedAssessment.summary, rows);
    return {
      candidate: chosen,
      // The person's newest assessment: what a re-judgment and a countersignature are addressed to.
      assessmentId: text(selectedAssessment.id),
      facts: [
        { label: "临床资格", value: (/** @type {Record<string, string>} */ (VCR_ELIGIBILITY_SUMMARY_LABELS_ZH))[selectedAssessment.summary] ?? selectedAssessment.summary,
          tone: selectedAssessment.summary === "eligible" ? "neutral" : "attention" },
        { label: "满足", value: String(Number(object(selectedAssessment.counts).satisfied ?? 0)), tone: "neutral" },
        { label: "未知", value: String(Number(object(selectedAssessment.counts).unknown ?? 0)), tone: Number(object(selectedAssessment.counts).unknown ?? 0) > 0 ? "attention" : "neutral" },
        { label: "待复评", value: String(Number(object(selectedAssessment.counts).pending_recheck ?? 0)), tone: "neutral" },
        { label: "评估时点", value: zhDate(selectedAssessment.asOf, now) ?? "—", tone: "neutral" },
      ],
      criteria: rows,
      verdict,
      priority: chosen.priority,
      // The id says that somebody countersigned (the page offers the countersignature only where nobody has); the name is what is shown.
      reviewedBy: selectedAssessment.reviewedBy ?? null,
      reviewedByName: personName(bundle.people, selectedAssessment.reviewedBy),
    };
  })() : null;
  const ordinalOf = (/** @type {string} */ id) => Number(criteria.find((/** @type {any} */ criterion) => criterion.id === id)?.ordinal ?? 0);
  // Most undecidable first; equal counts keep the protocol's own order.
  const gaps = [...gapsByCriterion.entries()].map(([id, gap]) => ({ id, gap }))
    .sort((a, b) => b.gap.unknown - a.gap.unknown || ordinalOf(a.id) - ordinalOf(b.id)).slice(0, 5).map(({ id, gap }) => ({
      code: criterionCode(id),
      label: (/** @type {Record<string, string>} */ (VCR_CRITERION_TYPE_LABELS_ZH))[criteria.find((/** @type {any} */ c) => c.id === id)?.criterionType] ?? "其他",
      detail: text(criteria.find((/** @type {any} */ c) => c.id === id)?.sourceText),
      count: gap.unknown,
    })).filter((gap) => gap.count > 0);
  const eligible = count("eligible");
  const insufficient = (count("insufficient_evidence") ?? 0) + (count("pending") ?? 0);
  return {
    view,
    available: true,
    protocols: list(match.protocols), protocolVersionId: match.protocol?.id ?? null,
    candidateRoster: list(match.candidateRoster),
    ...(match.candidateCoverage ? {candidateCoverage: match.candidateCoverage} : {}),
    comparisons: list(match.comparisons).map(entry => ({ protocol: entry.protocol, summary: entry.assessment?.summary ?? null,
      asOf: entry.assessment?.asOf ?? null, evidenceGaps: entry.assessment?.evidenceGaps ?? [] })),
    timeline: (abilitiesOf(list(bundle.roles).map(String)).includes("read_patient_level") ? list(match.timeline) : []).map(fact => ({ id: fact.id, variable: fact.variable, value: fact.value, unit: fact.unit,
      at: fact.occurredAt ?? null, dateNote: dateNote(fact.source?.dateBasis, fact.source?.dateBound), assertion: fact.clinical?.assertion ?? fact.polarity, experiencer: fact.clinical?.experiencer ?? null,
      medicationState: fact.clinical?.medication?.state ?? null, correctionOf: fact.clinical?.correctionOf ?? null,
      superseded: fact.superseded === true, conflictFactIds: fact.conflicts ?? [], correctionReason: fact.clinical?.correctionReason ?? null,
      ...(fact.basis ? { basis: fact.basis } : {}),
      document: documentNames.get(String(fact.source?.documentId)) ?? null,
      quote: fact.source?.quote ?? null, locator: fact.source ? { documentId: fact.source.documentId, start: fact.source.start, end: fact.source.end } : null })),
    headline: total ? `${total.toLocaleString("en-US")} 人已评估，${(eligible ?? 0).toLocaleString("en-US")} 人全部满足，${insufficient.toLocaleString("en-US")} 人至少有 1 条未知或待复评。` : null,
    partner: total ? { name: null, candidates: total, tier: study.dataTier, snapshotAt: match.snapshotAt ? zhDate(match.snapshotAt, now) : null } : null,
    // Two directions, one evaluation run from either end. 「给试验找患者」 is the protocol's patients (everything below); 「给患者找试验」
    // adds `patientTrials`: one patient's trials, ranked.
    direction: match.patientTrials ? "patient_to_trial" : "trial_to_patient",
    directions: ["trial_to_patient", "patient_to_trial"],
    // A conversation's "这位患者能入哪些试验" leaves a patient and their trials and no protocol: its result is on the patient's side, and
    // the other side would open on an empty page asking for a research question.
    ...(!list(match.protocols).length && list(match.candidateRoster).length ? { opensOnPatient: String(list(match.candidateRoster)[0]) } : {}),
    ...(match.patientTrials ? { patientTrials: presentPatientTrials(bundle, match.patientTrials) } : {}),
    funnel,
    candidates,
    // The people whose evaluation rested on a basis that has since changed, for the one action the page offers: evaluate them again.
    ...(subjects.some((row) => row.basis === "updated")
      ? { basisUpdated: { count: subjects.filter((row) => row.basis === "updated").length, subjects: subjects.filter((row) => row.basis === "updated").slice(0, 50).map((row) => String(row.subjectKey)) } } : {}),
    selected,
    gaps,
    pendingReview: pendingReview.length ? { count: pendingReview.length, subjects: pendingReview.slice(0, 20) } : null,
    protocol: protocol ? { version: protocol.version, title: text(protocol.title) } : null,
    counts: total ? countsView({ realPatients: total }, { tier: study.dataTier }) : null,
  };
}

// --- 数据与证据 -------------------------------------------------------------------------------------------------------------------------

/**
 * The card's forest plot: one row per extracted study, the pooled diamond and
 * the prediction interval — read off the stored evidence and the card's own
 * pooling record, never re-pooled here.
 * @param {Record<string, any>} card @param {readonly Record<string, any>[]} evidence @param {Map<string, Record<string, any>>} precedentById
 */
function forestOf(card, evidence, precedentById) {
  const pooling = object(card.pooling);
  const scale = String(pooling.scale ?? "identity");
  const studies = evidence.filter((item) => finite(numeric(item.value)) !== null).map((item) => {
    const precedent = precedentById.get(String(item.precedent_id ?? item.precedentId));
    return {
      id: String(item.id),
      label: text(precedent?.registry_id) ?? text(item.source_ref) ?? String(item.id),
      note: text(item.arm),
      n: numeric(item.sample_size ?? item.sampleSize),
      value: numeric(item.value), low: numeric(item.ci_low ?? item.ciLow), high: numeric(item.ci_high ?? item.ciHigh),
      weight: null, highlighted: Boolean(object(item.applicability).chinesePopulation), pooled: false, prediction: false,
      // The card a run says led it to this value (flywheel F23): the page says so, and nothing about the row's check reads it.
      ...(object(item.detail).candidateFrom ? { candidateFrom: object(item.detail).candidateFrom } : {}),
    };
  });
  if (!studies.length) return [];
  const point = numeric(card.pointValue);
  const confidence = object(pooling.confidenceInterval);
  const prediction = object(pooling.predictionInterval ?? object(card.distribution).range);
  const rows = [...studies];
  if (point !== null) {
    rows.push({
      id: "pooled", label: "随机效应合并", note: null, n: null, value: point,
      low: naturalScale(scale, numeric(confidence.low)), high: naturalScale(scale, numeric(confidence.high)),
      weight: null, highlighted: false, pooled: true, prediction: false,
    });
    if (numeric(prediction.low) !== null && numeric(prediction.high) !== null) {
      rows.push({ id: "prediction", label: "预测区间", note: null, n: null, value: point, low: numeric(prediction.low), high: numeric(prediction.high),
        weight: null, highlighted: false, pooled: false, prediction: true });
    }
  }
  return rows.map((row) => ({ ...row, low: row.low === null ? null : roundTo(row.low, 4), high: row.high === null ? null : roundTo(row.high, 4) }));
}

/**
 * `GET /api/vcr/studies/:id/data`.
 * @param {Record<string, any>} bundle @param {{ card?: string | null }} [query]
 */
export function presentDataTab(bundle, query = {}) {
  const { study, assumptions, scenarios, stale, decisions, now, evidence, dataPlane } = bundle;
  const used = new Set(scenarios.flatMap((/** @type {any} */ scenario) => list(scenario.assumptionIds).map(String)));
  const precedentById = new Map((evidence?.precedents ?? []).map((/** @type {any} */ row) => [String(row.id), row]));
  const evidenceFor = (/** @type {any} */ card) => list(card.evidenceIds).map(String)
    .map((id) => (evidence?.items ?? []).find((/** @type {any} */ item) => String(item.id) === id)).filter(Boolean);
  // Who countersigned the card, when, and which version — read off the card, which the store
  // gives the state its countersignatures earned. A card whose signed version is an older one
  // says which (针对版本 1) in its detail; no chip on the card says reviewed or changed.
  const reviewOf = (/** @type {any} */ card) => (card.reviewedAt
    ? { by: card.reviewedBy ?? null, at: zhDate(card.reviewedAt, now), version: card.reviewedVersion ?? card.version,
      kind: (/** @type {Record<string, string>} */ (VCR_REVIEW_KIND_LABELS_ZH))[card.reviewKind] ?? null }
    : null);
  const staleNodes = new Set(stale.map((/** @type {any} */ mark) => mark.node));
  const usedBy = (/** @type {any} */ card) => {
    const node = `assumption:${card.key}@${card.version}`;
    const objects = [];
    for (const edge of bundle.edges ?? []) {
      if (edge.from !== node) continue;
      const parsed = parseLineageNode(edge.to);
      // A design is named the way the trial tab names it, not by a version number.
      const design = parsed?.kind === "trial_scenario" ? bundle.scenarios.find((/** @type {any} */ row) => row.id === parsed.id) : null;
      const label = design ? scenarioName(design) : nodeLabel(edge.to);
      if (label) objects.push({ id: edge.to, label, note: staleNodes.has(edge.to) ? "已过期" : null, tab: tabOfNode(edge.to) });
    }
    return objects.slice(0, 8);
  };
  // The numbers of the study's extracted values that do not agree with each other (E2), once; a card carries those of the evidence it cites.
  const consistency = list(evidence?.items).length ? evidenceValueFindings(list(evidence?.items)) : [];
  const cards = assumptions.map((/** @type {any} */ card) => {
    const items = evidenceFor(card);
    const value = assumptionValue(card, { now, evidence: items });
    const cited = new Set(list(card.evidenceIds).map(String));
    const valueChecks = [
      ...consistency.filter((finding) => finding.ids.some((id) => cited.has(id))).map((finding) => ({ kind: "consistency", message: finding.message })),
      // Where a second, independent reading of the passage a cited value was read from read another number (E1): both numbers and the quotation.
      ...list(evidence?.secondReads).filter((read) => cited.has(String(read.evidence_id)) && text(object(read.reading).message))
        .map((read) => ({ kind: "second_read", message: text(object(read.reading).message) })),
    ];
    const pooling = object(card.pooling);
    const versions = (bundle.assumptionVersions?.get?.(card.key) ?? []).map((/** @type {any} */ row) => ({
      version: row.version, at: zhTime(row.createdAt, now), text: text(row.note) ?? `${row.name || row.key}${row.pointValue != null ? ` = ${row.pointValue}` : ""}`,
      note: row.afterFreeze === true ? "冻结后新增，不影响已冻结的计划" : null,
      ...(row.afterFreeze === true ? { afterFreeze: true } : {}),
    }));
    // News about this card's sources (flywheel F24): open signals say what, a version after the freeze says it is already beside the frozen one.
    const signals = bundle.evidenceSignals?.get?.(card.key) ?? null;
    const newEvidence = signals && (signals.open.length || signals.afterFreeze)
      ? { label: "有新证据", open: signals.open.slice(0, 5), afterFreezeVersion: signals.afterFreeze ?? null } : null;
    return {
      id: card.id,
      key: card.key,
      name: String(card.name || card.key),
      value,
      summary: assumptionSummary(card),
      isKey: used.size ? used.has(card.key) || used.has(card.id) : false,
      version: card.version,
      sourceType: (/** @type {Record<string, string>} */ (VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH))[card.sourceKind] ?? card.sourceKind,
      sourceKind: card.sourceKind,
      // What an effect is on its card (A13): the difference worth finding, or the one realistically expected; null for a card that says none.
      effectRole: (/** @type {Record<string, string>} */ (VCR_EFFECT_ROLE_LABELS_ZH))[String(card.effectRole)] ? String(card.effectRole) : null,
      applicability: applicabilityText(card),
      sensitivity: sensitivityText(card),
      review: reviewOf(card),
      ...(newEvidence ? { newEvidence } : {}),
      // ⚠ The numbers the card is made of that do not agree: advice with the numbers named; the value stands as it was read.
      ...(valueChecks.length ? { valueChecks } : {}),
      // What an edit starts from. A person's value is an expert setting: it keeps the card's endpoint and applicability but not the pooled
      // evidence, which no longer supports the number (AC-25).
      edit: { pointValue: numeric(card.pointValue), unit: zhUnit(text(card.unit)), note: text(card.note), endpoint: text(card.endpoint), applicability: object(card.applicability) },
      detail: {
        subtitle: [text(card.endpoint), text(pooling.calibre) ? `汇总口径：${CALIBRE_LABELS[String(pooling.calibre)] ?? pooling.calibre}` : null].filter(Boolean).join(" · ") || null,
        stats: [
          ...(numeric(pooling.k) !== null ? [{ label: "研究数", value: String(numeric(pooling.k)) }] : []),
          ...(numeric(pooling.i2) !== null ? [{ label: "I²", value: `${roundTo(Number(pooling.i2) <= 1 ? Number(pooling.i2) * 100 : Number(pooling.i2), 0)}%` }] : []),
          ...(numeric(pooling.tau2) !== null ? [{ label: "τ²", value: String(roundTo(Number(pooling.tau2), 3)) }] : []),
          // A pooling with a reference for the spread between studies (two studies get a prediction interval from it): said, with where the reference is from.
          ...(text(object(pooling.tauPrior).kind) ? [{ label: "研究之间差异的参照", value: tauPriorWords(object(pooling.tauPrior)) }] : []),
        ],
        forest: forestOf(card, items, precedentById),
        forestNote: text(pooling.calibreReason) ? "汇总口径与理由已记在卡上。" : null,
        distribution: text(object(card.distribution).family) ? { family: String(object(card.distribution).family), note: text(object(card.distribution).note), points: [] } : null,
        quote: text(items.find((item) => text(item.quote))?.quote),
        quoteSource: value.detail?.quoteSource ?? null,
        quoteLink: text(precedentById.get(String(items.find((item) => text(item.quote))?.precedent_id))?.sources?.[0]?.url) ?? null,
        usedBy: usedBy(card),
        versions,
      },
    };
  });
  const precedents = (evidence?.precedents ?? []).map((/** @type {any} */ row) => {
    const items = (evidence?.items ?? []).filter((/** @type {any} */ item) => item.precedent_id === row.id);
    const isNotReported = (/** @type {any} */ item) => item.locator?.verification === "not_reported";
    // What the paper was read for and does not report (C8): said as 未取到 beside the trial, never as a value and never as a refusal.
    const notReported = [...new Set(items.filter(isNotReported).map((/** @type {any} */ item) => PARAMETER_LABELS[String(item.parameter)] ?? String(item.parameter)))];
    return { ...presentPrecedentRow(row),
      usedFor: [...new Set(items.filter((/** @type {any} */ item) => !isNotReported(item)).map((/** @type {any} */ item) => PARAMETER_LABELS[String(item.parameter)]).filter(Boolean))].slice(0, 3).join("、") || null,
      ...(notReported.length ? { notReported: notReported.slice(0, 6) } : {}) };
  });
  const snapshots = presentDataSnapshots(dataPlane, now);
  return {
    headline: cards.length ? `${cards.length} 张假设卡。` : null,
    status: [
      ...(precedents.length ? [{ label: "参考试验", value: `${precedents.length} 项` }] : []),
      ...(cards.length ? [{ label: "假设卡", value: `${cards.length} 张` }] : []),
      { label: "患者级数据", value: study.dataTier === "T0" ? "未接入" : (snapshots.length ? `${snapshots.length} 个快照` : "未接入") },
    ],
    ...(evidence?.registryCoverage?.length ? { registryCoverage: evidence.registryCoverage } : {}),
    assumptions: cards,
    reviews: list(bundle.reviews).map((/** @type {any} */ review) => presentVcrReview(review, reviewContextOf(bundle))),
    selectedId: cards.find((card) => card.id === query.card || card.key === query.card)?.id ?? null,
    precedents,
    precedentSources: precedents.length ? `${precedents.length} 项参考试验` : null,
    // Network meta-analysis, dose-response meta-analysis and the shrinkage of a published effect (the conversation computed them): a card each.
    ...presentEvidenceSyntheses(bundle, { nodeOf: resultNode }),
    precedentNote: null,
    // Trial events the feed reported for this study's subject: pointers marked as candidates, never precedents (flywheel F24).
    ...(bundle.candidates?.length ? { precedentCandidates: bundle.candidates } : {}),
    snapshots,
    // The intake flow: sources, files, field maps, snapshots, tables, grants and the seal (contract §6).
    intake: presentIntake(bundle),
    decisions: decisions.slice(0, 5).map((decision) => ({ id: decision.id, at: zhTime(decision.createdAt, now), text: decision.question })),
    // Said only when the evidence side is not composed here: an empty card list
    // must not read as 「没有证据」 when the deployment cannot look.
    evidenceNote: evidence?.available === false ? String(evidence.message ?? "") : null,
  };
}

/** How a pooling calibre is said: the whole set of trials, or the ones closest to this population. */
const CALIBRE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({ overall: "全部研究", closest: "最相近的研究" }));

/** @param {string} node */
function tabOfNode(node) {
  const kind = node.slice(0, node.indexOf(":"));
  return ({ population: "population", patient_set: "patients", comparator_design: "comparator", trial_scenario: "trial", design_grid: "trial", matching_assessment: "matching" }[/** @type {"population"} */ (kind)]) ?? null;
}

/** The precedent row in the data tab's own list (the library's shape, without the extras). @param {Record<string, any>} row */
function presentPrecedentRow(row) {
  const enrollment = object(row.enrollment);
  const sites = object(row.sites);
  const design = object(row.design);
  const pico = object(row.pico);
  const actual = numeric(enrollment.actual);
  const months = numeric(enrollment.accrualToPrimaryCompletionMonths);
  const siteCount = numeric(sites.count);
  return {
    id: String(row.id),
    registryId: String(row.registry_id ?? ""),
    registry: (/** @type {Record<string, string>} */ ({ "clinicaltrials.gov": "ClinicalTrials.gov", chictr: "ChiCTR", ctis: "EU CTIS", cde: "CDE 登记" }))[String(row.registry)] ?? text(row.registry),
    title: text(row.title),
    population: list(pico.conditions).length ? list(pico.conditions).join("、") : null,
    design: registryDesignWords(design),
    planned: numeric(enrollment.planned),
    actual,
    sites: siteCount,
    plannedMonths: null,
    actualMonths: months,
    perSitePerMonth: actual !== null && months !== null && months > 0 && siteCount !== null && siteCount > 0 ? roundTo(actual / months / siteCount, 3) : null,
    usedFor: null,
  };
}

/** @param {Record<string, any>} card */
function applicabilityText(card) {
  const applicability = object(card.applicability);
  const parts = [text(applicability.population), text(applicability.region), text(applicability.note)].filter(Boolean);
  if (applicability.chinesePopulation === true) parts.push("含中国人群的研究");
  if (applicability.pending === true) parts.push("等待来源证据");
  return parts.length ? parts.join("；") : null;
}

/** 「范围 3.0–5.6」 from the card's sensitivity record. @param {Record<string, any>} card */
function sensitivityText(card) {
  const range = object(object(card.sensitivity).range);
  const low = numeric(range.low);
  const high = numeric(range.high);
  const calibres = list(object(card.sensitivity).calibres).length;
  if (low === null && high === null && !calibres) return null;
  return [low !== null && high !== null ? `敏感性范围 ${roundTo(low, 2)}–${roundTo(high, 2)}` : null, calibres ? `另有 ${calibres} 个汇总口径作对照` : null].filter(Boolean).join("；");
}

// ---- data tab ----------------------------------------------------------------
// The data-intake half of 「数据与证据」 (contract 2026-09-29 §6): what the
// browser needs to walk a source from upload to grant. Nothing here is a path of
// the server or a row of a patient — the plane's `tabFor` never sent one — and
// every sentence the page shows about a refusal is built here or by the plane,
// not by the component.

/** Where a source stands, in words. */
const INTAKE_STATUS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({ registered: "已登记", profiled: "已上传", frozen: "已冻结", withdrawn: "已撤回" }));
/** Where its field map stands. */
const FIELD_MAP_STATE_ZH = Object.freeze(/** @type {Record<string, string>} */ ({ none: "尚未提出", proposed: "待确认", confirmed: "已确认" }));
/** What an uploaded file is. */
const FILE_ROLE_ZH = Object.freeze(/** @type {Record<string, string>} */ ({ data: "数据文件", dictionary: "数据字典", document: "患者文档" }));
/** What a column is for — the closed list the field-map editor offers. */
const FIELD_ROLE_OPTIONS = Object.freeze([
  { value: "subject_key", label: "受试者编号" }, { value: "arm", label: "治疗分组" }, { value: "covariate", label: "基线协变量" },
  { value: "outcome_time", label: "结局：时间" }, { value: "outcome_event", label: "结局：事件" }, { value: "time_zero", label: "时间零点" },
  { value: "measurement", label: "纵向测量值" }, { value: "visit_date", label: "测量日期" }, { value: "other", label: "其他（不进入分析表）" },
]);

/** @param {number | null} bytes */
function byteText(bytes) {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${roundTo(bytes / 1024, 1)} KB`;
  return `${roundTo(bytes / (1024 * 1024), 1)} MB`;
}

/** @param {Record<string, any>} window */
function windowText(window) {
  const start = text(window?.start);
  const end = text(window?.end);
  if (!start && !end) return null;
  return `${start ? start.slice(0, 10) : "不限"} 至 ${end ? end.slice(0, 10) : "不限"}`;
}

/**
 * Snapshots for the evidence half of the tab: a label, a time, a row count and
 * the five Kahn categories with how many findings each holds. The intake half
 * carries the same snapshots with their tables and seal.
 * @param {any} dataPlane @param {Date} now
 */
function presentDataSnapshots(dataPlane, now) {
  return list(dataPlane?.snapshots).map((snapshot) => {
    const entry = object(snapshot);
    return {
      id: String(entry.id),
      label: `快照 v${entry.version ?? "?"}`,
      at: zhTime(entry.frozenAt, now),
      rows: numeric(entry.rowCount),
      quality: qualityRows(entry.quality),
    };
  });
}

/** The five Kahn categories with how many findings each holds: 「一致性 10 项」. @param {unknown} quality */
function qualityRows(quality) {
  return Object.entries(object(object(quality).categories)).filter(([, count]) => typeof count === "number").map(([category, count]) => ({
    label: (/** @type {Record<string, string>} */ (VCR_QUALITY_CATEGORY_LABELS_ZH))[category] ?? category, value: `${count} 项`, passed: count === 0,
  }));
}

/**
 * The seal in one sentence, in the reader's own clock. The domain's note carries
 * the instants as ISO text for the package cover; the page says 「昨天 16:00」.
 * @param {Record<string, any>} seal @param {Date} now
 */
function sealSentence(seal, now) {
  if (seal.required !== true) return text(seal.note);
  const planned = zhTime(seal.planFrozenAt, now);
  const read = zhTime(seal.outcomeFirstReadAt, now);
  if (!planned) return "分析计划尚未冻结：结局字段仍处于封存状态。";
  return read ? `分析计划于 ${planned} 冻结，结局字段于 ${read} 首次读取。` : `分析计划于 ${planned} 冻结，结局字段尚未被读取。`;
}

/**
 * The intake block of `GET …/data`.
 * @param {Record<string, any>} bundle
 */
export function presentIntake(bundle) {
  const { dataPlane, study, now } = bundle;
  const seal = object(bundle.seal);
  if (!dataPlane || dataPlane.available === false) {
    return {
      available: false,
      message: text(dataPlane?.message) ?? (study.dataTier === "T0" ? "T0 档不需要患者级数据；有了数据，在这里接入并冻结后，研究页会提示升到 T1 及以上。" : "本部署未接入数据平面，暂不能接入患者级数据。"),
      formats: [], maxBytes: null, seal: null, sources: [], snapshots: [],
    };
  }
  const viewerCan = new Set(abilitiesOf(list(bundle.roles).map(String)));
  const sources = list(dataPlane.sources).map((raw) => {
    const source = object(raw);
    const files = list(source.files).map((file) => object(file));
    const latest = new Map();
    for (const file of files) if (file.role === "data") latest.set(file.name, file.id);
    const fieldMap = object(source.fieldMap);
    const upload = object(source.upload);
    return {
      id: String(source.id),
      name: String(source.name ?? ""),
      ownerParty: text(source.ownerParty),
      mine: source.mine === true,
      readable: source.readable === true,
      canGrant: source.mine === true,
      cloudPermission: source.cloudPermission ?? null,
      cloud: source.cloud ?? null,
      status: String(source.status ?? "registered"),
      statusLabel: INTAKE_STATUS_ZH[String(source.status)] ?? String(source.status ?? ""),
      valueSource: String(source.valueSource ?? "observed"),
      valueSourceLabel: (/** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH))[String(source.valueSource)] ?? String(source.valueSource ?? ""),
      allowedUses: list(source.allowedUses).map(String),
      window: windowText(object(source.visibleWindow)),
      retention: [text(object(source.retention).until) ? `保留至 ${String(object(source.retention).until).slice(0, 10)}` : null, text(object(source.retention).note)].filter(Boolean).join("；") || null,
      upload: {
        cloudDestinations: list(upload.cloudDestinations).map(String),
        formats: list(upload.formats).map(String), maxBytes: numeric(upload.maxBytes), maxText: byteText(numeric(upload.maxBytes)),
        // What a patient record may be: text, and PDF or Word where the deployment converts them.
        documents: {
          formats: list(object(upload.documents).formats).map(String),
          maxBytes: numeric(object(upload.documents).convertedMaxBytes),
          maxText: byteText(numeric(object(upload.documents).convertedMaxBytes)),
          converter: object(upload.documents).converter === true,
        },
        // A source held in FHIR, OMOP or ADaM: what this deployment converts, and what each is uploaded as.
        imports: {
          available: object(upload.imports).available === true,
          formats: list(object(upload.imports).formats).map((format) => ({ value: String(object(format).value), extensions: list(object(format).extensions).map(String) })),
          maxBytes: numeric(object(upload.imports).maxBytes), maxText: byteText(numeric(object(upload.imports).maxBytes)),
        },
      },
      files: files.map((file) => ({
        id: String(file.id), name: String(file.name), role: String(file.role), roleLabel: FILE_ROLE_ZH[String(file.role)] ?? String(file.role),
        format: String(file.format), size: byteText(numeric(file.bytes)), rows: numeric(file.rowCount), columnCount: numeric(file.columnCount),
        at: zhTime(file.createdAt, now), latest: file.role === "data" ? latest.get(file.name) === file.id : null,
        columns: list(file.columns).map((column) => ({
          name: String(object(column).name), type: text(object(column).type), filled: numeric(object(column).filled),
          distinct: numeric(object(column).distinct), identifying: object(column).identifying === true,
        })),
        entries: numeric(file.entries), sheets: list(file.sheets).map(String), sheetUsed: text(file.sheetUsed),
        subjectKey: text(file.subjectKey), visibleAt: text(file.visibleAt),
        // How much of a reviewed record a run was shown and how much it never was: counts, never who read it or how many reads it took.
        reading: object(file.reading).read !== undefined
          ? { chars: numeric(object(file.reading).chars), read: numeric(object(file.reading).read) ?? 0, skipped: numeric(object(file.reading).skipped), complete: object(file.reading).complete === true } : null,
        // A record converted from PDF or Word: what it was, how many pages, how many had no text layer.
        sourceFormat: text(file.sourceFormat), pages: numeric(file.pages), blankPages: numeric(file.blankPages),
        // A table a FHIR, OMOP or ADaM import produced.
        importFormat: text(file.importFormat),
        // A record whose text was erased (a withdrawal): the row stays, the words are gone. And the reviewed texts saved of it, for the one to retire.
        ...(file.erased === true ? { erased: true } : {}),
        ...(list(file.projections).length ? { projections: list(file.projections).map((projection) => ({ id: String(object(projection).id), at: zhTime(object(projection).at, now) })) } : {}),
      })),
      fieldMap: {
        state: String(fieldMap.state ?? "none"), stateLabel: FIELD_MAP_STATE_ZH[String(fieldMap.state)] ?? "",
        hash: text(fieldMap.hash), by: text(fieldMap.by) === "run" ? "AI 提议" : text(fieldMap.by) === "import" ? "按标准格式生成" : text(fieldMap.by) ? "人工填写" : null,
        confirmedBy: text(fieldMap.confirmedBy), confirmedByName: personName(bundle.people, fieldMap.confirmedBy),
        confirmedAt: zhTime(fieldMap.confirmedAt, now),
        columns: list(fieldMap.columns).map((column) => ({ ...object(column), codes: object(object(column).codes) })),
        issues: list(fieldMap.issues).map((issue) => ({
          code: String(object(issue).code), message: String(object(issue).message ?? ""), table: text(object(issue).table), column: text(object(issue).column),
        })),
      },
      grants: list(source.grants).map((raw2) => {
        const grant = object(raw2);
        const grantee = String(grant.grantee ?? "");
        const role = grantee.startsWith("role:") ? (/** @type {Record<string, string>} */ ({ ...VCR_MEMBER_ROLE_LABELS_ZH, ...VCR_RETIRED_MEMBER_ROLE_LABELS_ZH }))[grantee.slice(5)] : null;
        return {
          // A role and the whole study are words; an account is its name, or the neutral label once the account is gone — never its id.
          id: String(grant.id), grantee, granteeLabel: role ? `角色：${role}` : grantee.startsWith("study:") ? "本研究的所有成员" : personName(bundle.people, grantee) ?? "",
          role: text(grant.role), fields: list(grant.fields).map(String), fieldMode: String(grant.fieldMode ?? "allow"),
          window: windowText({ start: grant.windowStart, end: grant.windowEnd }), purposes: list(grant.purposes).map(String),
          revoked: Boolean(grant.revokedAt), revokedAt: zhTime(grant.revokedAt, now), createdAt: zhTime(grant.createdAt, now),
        };
      }),
    };
  });
  const snapshots = list(dataPlane.snapshots).map((raw) => {
    const snapshot = object(raw);
    return {
      id: String(snapshot.id), sourceId: String(snapshot.sourceId), version: numeric(snapshot.version), label: `快照 v${snapshot.version ?? "?"}`,
      at: zhTime(snapshot.frozenAt, now), rows: numeric(snapshot.rowCount), columnCount: numeric(snapshot.columnCount),
      valueSource: (/** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH))[String(snapshot.valueSource)] ?? null,
      files: list(snapshot.files).map((file) => String(object(file).name)),
      sealed: snapshot.sealed === true, sealedFields: list(snapshot.sealedFields).map(String), sealedUntil: zhTime(snapshot.sealedUntil, now),
      qualityInputs: list(snapshot.qualityInputs),
      findings: numeric(object(snapshot.quality).findings),
      quality: qualityRows(snapshot.quality),
      tables: list(snapshot.tables).map((table) => ({
        shape: String(object(table).shape), label: (/** @type {Record<string, string>} */ (VCR_ANALYSIS_TABLE_LABELS_ZH))[String(object(table).shape)] ?? String(object(table).shape),
        rows: numeric(object(table).rowCount), columns: list(object(table).columns).map(String), issues: numeric(object(table).issues) ?? 0,
        outcomeBearing: object(table).outcomeBearing === true,
      })),
    };
  });
  return {
    available: true,
    message: null,
    formats: sources[0]?.upload.formats ?? ["csv", "tsv", "json", "xlsx"],
    maxBytes: sources[0]?.upload.maxBytes ?? null,
    // What the person can do here, from the roles they hold now (the routes check for themselves).
    canManage: viewerCan.has("manage_data"),
    seal: {
      required: seal.required === true,
      planFrozenAt: zhTime(seal.planFrozenAt, now),
      outcomeFirstReadAt: zhTime(seal.outcomeFirstReadAt, now),
      ordered: seal.ordered === true,
      fields: list(seal.sealedFields).map(String),
      fieldsRead: list(seal.outcomeFieldsRead).map(String),
      note: sealSentence(seal, now),
    },
    options: {
      roles: FIELD_ROLE_OPTIONS,
      timeKinds: VCR_TIME_KINDS.map((value) => ({ value, label: (/** @type {Record<string, string>} */ (VCR_TIME_KIND_LABELS_ZH))[value] })),
      missingReasons: VCR_MISSING_REASONS.map((value) => ({ value, label: (/** @type {Record<string, string>} */ (VCR_MISSING_REASON_LABELS_ZH))[value] })),
      valueSources: ["observed", "extracted", "calculated", "imputed"].map((value) => ({ value, label: (/** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH))[value] })),
      memberRoles: Object.entries(VCR_MEMBER_ROLE_LABELS_ZH).map(([value, label]) => ({ value, label })),
    },
    sources,
    snapshots,
  };
}
