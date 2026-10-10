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
  VCR_CONCLUSIONS, VCR_CRITERION_TYPE_LABELS_ZH, VCR_DATA_TIERS, VCR_DATA_TIER_LABELS_ZH, VCR_E10_CONDITIONS,
  VCR_E10_CONDITION_LABELS_ZH, VCR_ELIGIBILITY_SUMMARY_LABELS_ZH, VCR_FOLLOWUP_KIND_LABELS_ZH,
  VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_POPULATION_KIND_LABELS_ZH, VCR_REFERRAL_STATES, VCR_ROUTE_MIN_TIER,
  VCR_SMD_FLOOR, VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH, VCR_TWIN_LABELS_ZH, VCR_VALUE_SOURCES, VCR_ESTIMAND_LABELS_ZH,
  VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_PERFORMANCE_MEASURE_LABELS_ZH, VCR_REVIEW_KIND_LABELS_ZH, parseLineageNode,
  VCR_ANALYSIS_TABLE_LABELS_ZH, VCR_MEMBER_ROLE_LABELS_ZH, VCR_MISSING_REASONS, VCR_MISSING_REASON_LABELS_ZH,
  VCR_QUALITY_CATEGORY_LABELS_ZH, VCR_TIME_KINDS, VCR_TIME_KIND_LABELS_ZH, VCR_VALUE_SOURCE_LABELS_ZH,
  VCR_PROGNOSTIC_QUALIFICATION, VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH, VCR_ROBUSTNESS_STAGES, VCR_ROBUSTNESS_STAGE_LABELS_ZH,
  VCR_MODEL_RISK_RULE_LABELS_ZH, VCR_RATING_LABELS_ZH, VCR_SYNTHETIC_USE_LABELS_ZH, knownErrorCodeMessage, vcrAssessmentIssues, vcrAssessmentRows,
} from "@evimed/domain";

import { vcrObjectNode } from "./vcrStore.mjs";
import { VCR_UNSUPPORTED_COMPARATOR_ROUTES } from "./vcrService.mjs";
import { POPULATION_METHOD_WORDS, PROFILE_MISSING_SENTENCE, constraintRows, generatedProfileRows } from "./vcrPopulationProfileView.mjs";
import {
  abilitiesOf, assumptionSummary, assumptionValue, designsSentence, nodeLabel, notEstimableDesign, presentDesigns, reviewContextOf,
  presentModelCard, registryDesignWords, resultNode, scenarioName, valueString,
} from "./vcrViews.mjs";
import {
  allResultsOf, countsView, finite, intervalView, letterCode, list, markFor, measureLabel, measureValue, naturalScale, numeric, object,
  personName, plainText, PARAMETER_LABELS, METHOD_LABELS, roundTo, scaledSeries, staleNote, text, zhDate, zhTime, VCR_ROBUSTNESS_MEASURES,
  vcrFailureSentence, vcrPageSentence,
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
    remaining: numeric(row.remaining ?? row.kept ?? row.n),
    kept: numeric(row.kept ?? row.remaining),
    unknown: numeric(row.unknown ?? row.indeterminate),
    removed: numeric(row.removed ?? row.excluded),
    reasons: list(row.unknownReasons),
  };
}

/** The population profile's rows, in whatever list the population step stored them. @param {Record<string, any>} profile */
const profileRows = (profile) => list(profile.rows ?? profile.covariates ?? (Array.isArray(profile) ? profile : []));

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
  const disclosure = object(report.disclosure);
  const feasibility = object(object(report.utility).feasibility);
  const specific = Object.values(object(object(report.utility).specific)).map(object);
  const violations = list(object(report.constraints).violations ?? report.constraints).map((entry) => numeric(object(entry).violations)).filter((value) => value !== null);
  const generator = object(report.generator);
  const groups = [
    { key: "fidelity", label: "保真度", rows: [
      ks.length ? row("ks", "最大 KS 距离", Math.max(...ks)) : null,
      tvd.length ? row("tvd", "最大总变异距离", Math.max(...tvd)) : null,
      missing.length ? row("missing", "缺失率的最大差", Math.max(...missing)) : null,
      pairwise.length ? row("pairwise", "相关结构的最大差", Math.max(...pairwise)) : null,
      row("spmse", "标准化 pMSE", global.sPMSE),
      row("auc", "区分真假记录的 AUC", global.propensityAuc),
    ].filter((entry) => entry !== null) },
    { key: "utility", label: "可用性", rows: [
      row("joint", "入排通过率的相对差", feasibility.jointPassRateRelativeDifference),
      ...specific.map((entry, index) => row(`overlap_${index}`, `${text(entry.analysis) ?? "分析"}：置信区间重叠`, entry.confidenceIntervalOverlap)),
      violations.length ? row("violations", "硬约束违反的记录数", violations.reduce((sum, value) => sum + value, 0)) : null,
    ].filter((entry) => entry !== null) },
    { key: "leakage", label: "泄露风险", rows: disclosure.available === false ? [] : [
      row("replication", "复制率（相对留出集）", disclosure.replicationRatio),
      row("nn", "最近邻落在训练集的比例", disclosure.nearestNeighbourInTrainShare),
      row("membership", "成员推断 AUC", disclosure.membershipAuc),
      row("dcr", "到最近训练记录的距离（中位）", disclosure.dcrMedian ?? disclosure.medianDcr),
    ].filter((entry) => entry !== null) },
  ].filter((group) => group.rows.length);
  if (!groups.length && !Object.keys(generator).length) return null;
  return {
    tag: "合成 · 探索性",
    groups,
    trainingRecords: numeric(generator.trainingObservations ?? generator.trainingRecords),
    copies: numeric(generator.syntheticCopies ?? generator.copies ?? generator.m),
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
      id: population.id,
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
      quoteSource: vcrLocatorText(criterion.sourceLocator, { draftPack: bundle.knowledge?.pack?.status === "ai-draft" }),
      kind: criterion.kind,
      kept: entry?.kept ?? null,
      excluded: entry?.removed ?? null,
      unknown: entry?.unknown ?? null,
      review: criterion.reviewState,
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
  // A generated population is described variable by variable by the engine (`diagnostics.profile`); a real cohort is compared with the
  // published one, row by row.
  const generated = current && current.kind !== "real" ? generatedProfileRows(diagnostics.profile) : null;
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
  const first = steps[0];
  const total = numeric(first?.remaining) ?? numeric(current?.counts?.realPatients);
  return {
    version: view.version,
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
    // `generated`: one row per variable, set beside what came out of it; `comparison`: ours against the published cohort.
    profileKind: generated ? "generated" : profileView.length ? "comparison" : null,
    profileNote: generated ? null : profileView.length ? "标准化差异 |SMD| 超过 0.1 的特征已标出，它只说明两个人群不同，不说明谁对。"
      // A generated population whose result has no profile was generated before the engine wrote one: one sentence, and the way to get it.
      : current && current.kind !== "real" && result ? PROFILE_MISSING_SENTENCE : null,
    profileMissing: Boolean(current && current.kind !== "real" && result && !generated),
    // How it was made and what it may be used for: the two things a reader needs before using a synthetic table.
    method: current ? (POPULATION_METHOD_WORDS[String(current.kind)] ?? null) : null,
    allowedUses: current && current.kind !== "real"
      ? list(current.allowedUses).map(String).map((use) => ({ key: use, label: (/** @type {Record<string, string>} */ (VCR_SYNTHETIC_USE_LABELS_ZH))[use] ?? use })) : [],
    constraints: current && current.kind !== "real" ? constraintRows(diagnostics.constraintViolations) : [],
    unknownReasons: [...reasons.values()].map((reason) => ({ key: reason.key, label: reason.label, detail: reason.detail, count: reason.count })),
    blockers,
    quality: current ? qualityReportView(Object.keys(object(current.quality)).length ? current.quality : diagnostics.quality) : null,
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
 * 「第 12 页」 from a stored locator. A criterion taken from the study's knowledge pack says
 * so, and says 「AI 草拟」 when that pack is a draft: the label goes wherever a draft's content is used.
 * @param {unknown} raw @param {{ draftPack?: boolean }} [options]
 */
export function vcrLocatorText(raw, { draftPack = false } = {}) {
  const locator = object(raw);
  const parts = [];
  if (text(locator.pack)) parts.push(draftPack ? "知识包（AI 草拟）" : "知识包");
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
  return {
    model,
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
      id: String(example.id), source: (/** @type {readonly string[]} */ (VCR_VALUE_SOURCES)).includes(String(example.source)) ? String(example.source) : "synthetic",
      origin: text(example.origin),
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
    sets: patientSets.map((/** @type {any} */ set) => ({ id: set.id, label: `虚拟患者集 v${set.version}`, stale: Boolean(markFor(stale, vcrObjectNode("patient_set", set))) })),
  };
}

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
  const names = new Set([...VCR_ROBUSTNESS_MEASURES, ...(regulatory ? ["survival_difference_at_tau"] : [])]);
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
  const current = comparators[0] ?? null;
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
    const gaps = design ? list(design.gapList).length : 0;
    /** @type {string} */
    let state;
    // A route somebody evaluated says what it found, whatever its tier: an
    // external control at T0 that was judged not estimable is a result.
    if (conclusion && (/** @type {readonly string[]} */ (VCR_CONCLUSIONS)).includes(conclusion)) state = conclusion;
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
  const estimandLabel = current ? (/** @type {Record<string, string>} */ (VCR_ESTIMAND_LABELS_ZH))[current.estimand] ?? current.estimand : null;
  const rmstValue = rmstMeasure ? value(rmstMeasure) : null;
  const conclusion = result?.conclusion ?? shown?.conclusion ?? null;
  return {
    headline: shown && conclusion && conclusion !== "not_estimable"
      ? `${(/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[shown.route] ?? "对照"}：${(/** @type {Record<string, string>} */ ({ estimable: "可估计", limited: "有限制地估计" }))[conclusion] ?? ""}${rmstValue && rmstValue.value !== null ? `，${numeric(diagnostics.tau) !== null ? `${diagnostics.tau} 个月 ` : ""}RMST ${valueString(rmstValue)}` : ""}${diagnostics.inputsAssumed === true ? "，输入为假设" : ""}。`
      : null,
    routes,
    curves,
    rmst: rmstValue ? { value: rmstValue, tau: numeric(diagnostics.tau), label: numeric(diagnostics.tau) !== null ? `τ = ${diagnostics.tau} 个月` : null } : null,
    median: medianMeasure ? value(medianMeasure) : null,
    qc,
    // The method by its Chinese name (`METHOD_LABELS`); an id the table does not hold is shown as a plain word, never as the engine's own.
    methods: execution ? [{ label: METHOD_LABELS[String(execution.method)] ?? "引擎计算", version: execution.methodVersion ? `v${execution.methodVersion}` : null, note: null, passed: result?.conclusion !== "not_estimable" }] : [],
    e10: e10.map((entry) => ({
      key: text(entry.key) ?? "", label: (/** @type {Record<string, string>} */ (VCR_E10_CONDITION_LABELS_ZH))[String(entry.key)] ?? text(entry.label) ?? "",
      state: ["met", "partial", "doubtful"].includes(String(entry.state)) ? String(entry.state) : "doubtful", note: text(entry.note),
    })).filter((entry) => (VCR_E10_CONDITIONS).includes(entry.key)),
    estimand: current ? {
      rows: [
        { label: "估计目标", value: estimandLabel ?? "" },
        ...(text(object(current.targetTrial).population) ? [{ label: "目标试验的人群", value: String(object(current.targetTrial).population) }] : []),
        ...(text(object(current.targetTrial).treatment) ? [{ label: "处理策略", value: String(object(current.targetTrial).treatment) }] : []),
      ],
      note: text(object(current.targetTrial).note),
      source: "assumed",
      review: current.reviewState,
    } : null,
    comparability: balance.map((row, index) => {
      const smd = finite(row.smdAdjusted);
      return {
        key: text(row.covariate) ?? `row_${index}`, label: text(row.covariate) ?? `特征 ${index + 1}`,
        ours: plainValue(null, { source: "observed" }), theirs: plainValue(null, { source: "observed" }),
        smd, smdBefore: finite(row.smdUnadjusted), flagged: smd !== null && Math.abs(smd) > VCR_SMD_FLOOR, note: null,
      };
    }),
    comparabilityNote: balance.length ? "标准化差异是加权之后的；界值 0.1。" : null,
    dimensions,
    diagnostics: [...diagnosticRows, ...routeRows],
    prior: priorRows,
    robustness: robustnessView(result, value),
    gaps,
    counts: current ? countsView(result?.counts && Object.keys(result.counts).length ? result.counts : {}, { tier: study.dataTier }) : null,
    verdict: shown ? {
      conclusion,
      review: result?.reviewState ?? shown.reviewState,
      reviewed: (result?.reviewState ?? shown.reviewState) === "reviewed",
    } : null,
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
  const reported = check.reported;
  const reconstructed = check.reconstructed;
  const passed = check.pass === true;
  const labels = /** @type {Record<string, string>} */ ({ atRisk: "各时点风险人数", events: "总事件数", median: "中位数", logHazardRatio: "|Δlog HR|" });
  const label = labels[key] ?? text(check.name) ?? key;
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

/** The ADEMP lines, from the study and the headline scenario. @param {Record<string, any>} bundle @param {Record<string, any> | null} scenario */
function adempOf(bundle, scenario) {
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
    const dataGeneration = [
      (/** @type {Record<string, string>} */ (VCR_ENDPOINT_TYPE_LABELS_ZH))[scenario.endpointType] ?? scenario.endpointType,
      ...Object.entries(truth).filter(([, value]) => typeof value === "number").map(([key, value]) => `${TRUTH_LABELS[key] ?? key} ${value}`),
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
  return lines;
}

const TRUTH_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  effect: "真实效应", sd: "标准差", hazardRatio: "真实 HR", controlMedian: "对照组中位", controlRate: "对照事件率", treatmentRate: "试验事件率",
}));

/**
 * The trial tab's first sentence: what each design needs where the closed form computed it, then how the designs did where they
 * were simulated. Every number is a measure of the design's own results, formatted here.
 * @param {ReadonlyArray<Record<string, any>>} designs
 */
export function trialHeadline(designs) {
  const needs = designs.filter((design) => !design.dominated).map((design) => {
    const events = numeric(design.measures.required_events?.value);
    const patients = design.measures.sample_size?.source === "calculated" ? numeric(design.measures.sample_size?.value) : null;
    if (events === null && patients === null) return null;
    return `方案 ${design.code} 需要 ${[events !== null ? `${Math.round(events).toLocaleString("en-US")} 例事件` : null,
      patients !== null ? `${Math.round(patients).toLocaleString("en-US")} 名患者` : null].filter(Boolean).join("、")}`;
  }).filter(Boolean).slice(0, 3);
  const sentence = designsSentence(designs);
  const parts = [...needs, ...(sentence && designs.some((design) => design.measures.power || design.measures.assurance) ? [sentence] : [])];
  return parts.length ? `${parts.join("；")}。` : (sentence ? `${sentence}。` : null);
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
  const headlineRow = designRows.find((row) => row.chosen && row._result) ?? [...designRows].reverse().find((row) => !row.dominated && row._result) ?? null;
  const decision = decisions[0] ?? null;
  const columnSpec = [
    ["required_events", "所需事件数", "例"], ["sample_size", "样本量", "例"], ["expected_events", "期望事件数", null], ["power", "功效", "%"], ["assurance", "成功把握", "%"],
    ["type_one_error", "I 类错误", "%"], ["expected_sample_size", "期望样本量", "例"], ["duration_months", "末例入组中位", "月"], ["cost", "成本", "万元"],
  ];
  const columns = columnSpec
    .filter(([key]) => live.some((design) => design.measures[/** @type {string} */ (key)]))
    .map(([key, label, unit]) => ({ key, label, unit }));
  const grids = gridView(grid, designs);
  const powerRaw = object(headlineRow?._result?.diagnostics?.powerCurve);
  // The curve's axis is a probability the page shows as a percentage, like every design measure.
  const powerSeries = (seriesList(powerRaw.series).length ? seriesList(powerRaw.series) : grids.powerSeries).map((series) => scaledSeries(series, 100));
  const marks = designRows.map((row) => row._stale).filter(Boolean);
  const runRecord = designRows.filter((row) => row._result).map((row) => {
    const execution = executionOf(bundle, row._result);
    const diagnostics = object(row._result.diagnostics);
    const check = object(diagnostics.analyticCheck);
    const differencePoints = numeric(check.difference) !== null ? roundTo(Math.abs(Number(check.difference)) * 100, 1) : null;
    // A closed-form value is exact for some methods and a first-order approximation for others (the
    // log-rank power): the engine says which, and the tolerance it holds the simulation to — three
    // Monte-Carlo errors plus the approximation's documented bias. A run with many replicates has a
    // tiny error, and comparing an approximation to it with the error alone reads 「不一致」 for a
    // difference the approximation itself explains.
    const within = check.withinTolerance ?? check.withinThreeMcse;
    const approximate = numeric(check.approximationBias) !== null && Number(check.approximationBias) > 0;
    const allowedPoints = numeric(check.tolerance) !== null ? roundTo(Number(check.tolerance) * 100, 1) : null;
    return {
      key: `run_${row.code}`,
      title: `方案 ${row.code}：${execution ? `${METHOD_LABELS[String(execution.method)] ?? "已运行"}${execution.replicates != null ? `，${Number(execution.replicates).toLocaleString("en-US")} 次重复` : ""}` : "已运行"}`,
      detail: [
        execution?.seed != null ? `种子 ${execution.seed}` : null,
        within === true && differencePoints !== null
          ? (approximate
            ? `解析值是一阶近似，与仿真值相差 ${differencePoints} 个百分点，在容许的 ${allowedPoints} 个百分点内（3 倍蒙特卡洛标准误加近似本身的偏差）`
            : `解析值与仿真值一致（差 ${differencePoints} 个百分点，在 3 倍蒙特卡洛标准误内）`)
          : within === false && differencePoints !== null
            ? (approximate
              ? `解析值与仿真值相差 ${differencePoints} 个百分点，超出容许的 ${allowedPoints} 个百分点（3 倍蒙特卡洛标准误加近似本身的偏差）`
              : `解析值与仿真值相差 ${differencePoints} 个百分点，超出 3 倍蒙特卡洛标准误`) : null,
      ].filter(Boolean).join(" · ") || null,
      ok: within === true,
    };
  });
  const forecastRows = forecasts.map((forecast) => forecastView(forecast, now));
  const milestones = designRows.filter((row) => !row.dominated && row.measures.duration_months).map((row) => ({
    design: row.code, name: row.name, items: [{ key: "last_patient_in", label: "末例入组", value: row.measures.duration_months }],
  }));
  const goal = text(decision?.question) ?? text(object(grid?.comparisonGoal).text) ?? null;
  return {
    headline: trialHeadline(designs),
    ademp: adempOf(bundle, headlineRow?._scenario ?? scenarios[0] ?? null),
    ademReview: headlineRow?._result?.reviewState ?? null,
    designs,
    columns,
    grid: grids.heat,
    footnotes: notRerunNotes(designRows),
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
      note: "平台不自动选定方案。",
    } : null,
    runRecord,
    forecasts: forecastRows,
    milestones,
    counts: headlineRow ? countsView(headlineRow._result?.counts, { tier: study.dataTier, scope: `方案 ${headlineRow.code}` }) : null,
    stale: staleNote(marks),
    partial: partialOf(bundle, ["trial_scenario", "design_grid"], "这次模拟"),
  };
}

/** What a stage of a design's result is called when it is said not to have been redone. */
const STAGE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ assurance: "成功把握", analytic: "解析计算", simulation: "仿真", reconstruct: "曲线重建", rmst: "RMST 比较" }));

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
        ? `方案 ${row.code}：成功把握不再显示——效应假设卡现在没有预测分布，没有可以积分的先验，这一项没有重算。`
        : `方案 ${row.code}：上一次的${word}没有重算，已不再显示。`);
    }
  }
  return notes;
}

/** The vertical markers of a power curve: the assumed effect, which is a setting and not an estimate. @param {Record<string, any> | null | undefined} scenario */
function markersOf(scenario) {
  const truth = object(object(scenario?.configuration).truth);
  const effect = numeric(truth.hazardRatio ?? truth.effect);
  return effect === null ? [] : [{ x: effect, label: `情景设定 ${effect}`, kind: "assumed" }];
}

/**
 * The design grid: a heat grid of one measure across designs and truths, and
 * the power-against-effect series that read off the same cells. Only cells the
 * grid actually holds are drawn.
 * @param {Record<string, any> | null} grid @param {readonly Record<string, any>[]} designs
 */
function gridView(grid, designs) {
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
  const columns = Array.from({ length: truthCount }, (_unused, index) => ({ key: `t${index}`, header: text(truths[index]?.name) ?? text(truths[index]?.label) ?? `情景 ${index + 1}` }));
  const rows = Array.from({ length: designCount }, (_row, index) => ({
    key: `d${index}`,
    header: text(dimensionDesigns[index]?.label) ?? text(dimensionDesigns[index]?.name) ?? designs[index]?.name ?? `设计 ${letterCode(index)}`,
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
        powerSeries.push({ key: `d${index}`, label: text(dimensionDesigns[index]?.label) ?? text(dimensionDesigns[index]?.name) ?? `设计 ${letterCode(index)}`, source: "predicted", ours: false, pooled: false, points,
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

/**
 * The criterion the way a coordinator reads it: the protocol's own words, the
 * patient's own sentence, and what to ask for.
 * @param {Record<string, any>} criterion @param {string} code @param {Record<string, any> | null} judgment @param {Date} now
 */
function judgementView(criterion, code, judgment, now) {
  const evidence = list(judgment?.evidence).map(object)[0] ?? null;
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
    evidence: evidence && text(evidence.quote) ? {
      quote: String(evidence.quote), locator: evidence.locator ?? null,
      source: evidence.quoteKind === "snapshot_cell" ? `数据快照字段「${object(evidence.locator).field ?? evidence.variable}」`
        : evidence.quoteKind === "verbatim" ? "病历原文" : (vcrLocatorText(evidence.locator) ?? text(evidence.source)),
      at: zhDate(evidence.at ?? evidence.occurredAt ?? object(evidence.locator).at, now),
    } : null,
    request: state === "unknown" || state === "pending_recheck" ? (needed[0] ?? null) : null,
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
 * `GET /api/vcr/studies/:id/matching`.
 * @param {Record<string, any>} bundle @param {{ view?: string | null, candidate?: string | null, direction?: string | null }} [query]
 */
export function presentMatchingTab(bundle, query = {}) {
  const { study, now, match, roles } = bundle;
  const view = ["matching", "referral", "sites", "followup"].includes(String(query.view)) ? String(query.view) : "matching";
  if (!match) {
    return { view, available: false, unavailable: { code: "vcr_matching_unavailable", message: "匹配与招募在本部署尚未接入；其余步骤照常。" },
      funnel: [], candidates: [], selected: null, gaps: [], counts: null };
  }
  const { criteria, referrals, sites, siteFunnel, followups, tallies, openByAssessment, gapsByCriterion, pendingReview, subjects, protocol } = match;
  const codes = criterionCodes(criteria);
  const criterionCode = (/** @type {string} */ id) => codes.get(id) ?? "";
  const referralBySubject = new Map(referrals.map((/** @type {any} */ referral) => [referral.subjectKey, referral]));
  const total = Object.values(tallies).reduce((sum, value) => sum + Number(value), 0);
  const count = (/** @type {string} */ key) => (key in tallies ? Number(tallies[key]) : null);
  const funnel = total ? [
    { key: "candidates", label: "已评估", count: total, note: null, tone: "neutral" },
    { key: "insufficient", label: "可能符合 · 待补证", count: (count("insufficient_evidence") ?? 0) + (count("pending") ?? 0), note: null, tone: "attention" },
    { key: "eligible", label: "符合", count: count("eligible") ?? 0, note: null, tone: "accent" },
    { key: "ineligible", label: "不符合", count: count("ineligible") ?? 0, note: null, tone: "neutral" },
  ] : [];
  const ordered = [...subjects].filter((row) => row.summary !== "ineligible").sort((a, b) =>
    SUMMARY_ORDER.indexOf(a.summary) - SUMMARY_ORDER.indexOf(b.summary) || Number(a.counts?.unknown ?? 0) - Number(b.counts?.unknown ?? 0)
      || String(a.subjectKey).localeCompare(String(b.subjectKey)));
  const candidateOf = (/** @type {any} */ row) => {
    const referral = referralBySubject.get(row.subjectKey) ?? null;
    const counts = object(row.counts);
    return {
      id: String(row.subjectKey),
      referralId: referral?.id ?? null,
      summary: `${Number(counts.satisfied ?? 0)} 条满足 · ${Number(counts.unknown ?? 0)} 条未知 · ${Number(counts.pending_recheck ?? 0)} 条待复评`,
      site: referral?.siteId ? (sites.find((/** @type {any} */ site) => site.id === referral.siteId)?.name ?? null) : null,
      eligibility: row.summary,
      open: (openByAssessment.get(row.id) ?? []).map((/** @type {any} */ open) => ({
        code: criterionCode(open.criterionId), state: open.state,
        note: open.recheckAt ? `${zhDate(open.recheckAt, now)} 复评` : null,
      })),
      priority: row.priority ? { label: text(object(row.priority).label) ?? "临床优先级（不是获益概率）", score: numeric(object(row.priority).score), rationale: text(object(row.priority).rationale) } : null,
    };
  };
  const candidates = ordered.slice(0, 50).map(candidateOf);
  const chosen = candidates.find((candidate) => candidate.id === query.candidate) ?? candidates[0] ?? null;
  const selectedAssessment = match.selected ?? null;
  const selected = chosen && selectedAssessment && selectedAssessment.subjectKey === chosen.id ? (() => {
    const judgments = new Map(list(selectedAssessment.judgments).map((/** @type {any} */ row) => [row.criterionId, row]));
    const rows = criteria.map((/** @type {any} */ criterion) => judgementView(criterion, criterionCode(criterion.id), judgments.get(criterion.id) ?? null, now));
    const verdict = verdictOf(selectedAssessment.summary, rows);
    const referral = referralBySubject.get(chosen.id) ?? null;
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
      canContact: Boolean(referral && referral.state === "contactable"),
      referralId: referral?.id ?? null,
      referralState: referral?.state ?? null,
      priority: chosen.priority,
      // The id says that somebody countersigned (the page offers the countersignature only where nobody has); the name is what is shown.
      reviewedBy: selectedAssessment.reviewedBy ?? null,
      reviewedByName: personName(bundle.people, selectedAssessment.reviewedBy),
      // Every move on the person's referral, oldest first: to where, when, by
      // whom — a name, the platform's own hand, or the neutral label for an
      // account that is gone; never an account id — and what was said with it.
      trace: list(match.referralEvents).map((/** @type {any} */ event) => ({
        state: event.toState, at: zhTime(event.occurredAt, now), by: personName(bundle.people, event.actor), note: text(event.note),
      })),
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
  const ledgerCounts = new Map(VCR_REFERRAL_STATES.map((state) => [state, 0]));
  for (const referral of referrals) ledgerCounts.set(referral.state, (ledgerCounts.get(referral.state) ?? 0) + 1);
  const ledger = referrals.length ? VCR_REFERRAL_STATES.map((state) => ({
    state, count: ledgerCounts.get(state) ?? 0, note: null, waiting: state === "contactable" && (ledgerCounts.get(state) ?? 0) > 0,
  })) : [];
  const forecastResult = match.forecastResult
    ?? (bundle.forecastResults ?? []).find((/** @type {any} */ result) => !bundle.scenarios.some((/** @type {any} */ scenario) => scenario.id === result.subjectId)) ?? null;
  const forecast = forecastResult ? {
    target: numeric(object(object(forecastResult.diagnostics).model).target),
    xLabels: [], actual: [], median: [], band: [], markers: [],
    rows: list(forecastResult.measures).filter((measure) => ["last_patient_in_months", "target_events_months", "expected_completion_time"].includes(String(object(measure).name))
      || String(object(measure).name).startsWith("probability_by_")).slice(0, 4).map((measure) => ({
      key: String(object(measure).name), label: measureLabel(String(object(measure).name)),
      value: measureValue(measure, { kind: "accrual_forecast", result: forecastResult, tab: "matching" }), note: null, lead: String(object(measure).name) === "last_patient_in_months",
    })),
    basis: [
      ...(sites.length ? [`${sites.length} 个中心`] : []),
      ...(referrals.some((/** @type {any} */ referral) => referral.state === "enrolled")
        ? [`已入组 ${referrals.filter((/** @type {any} */ referral) => referral.state === "enrolled").length} 例`] : []),
    ],
    at: zhTime(forecastResult.createdAt, now),
  } : null;
  const siteRows = sites.map((/** @type {any} */ site) => {
    const funnelRow = siteFunnel.find((/** @type {any} */ entry) => entry.siteId === site.id);
    const states = object(funnelRow?.states);
    const verified = site.verifiedAt ? new Date(site.verifiedAt).getTime() : null;
    const days = verified === null ? null : Math.floor((now.getTime() - verified) / 86_400_000);
    const stale = days === null || days > 90;
    const slots = numeric(object(site.capacity).slots);
    const used = numeric(object(site.capacity).used) ?? 0;
    return {
      id: site.id,
      name: site.name,
      place: text(object(site.capability).place ?? object(site.capability).city),
      state: site.activatedOn ? "已启动" : "未启动",
      stateNote: site.activatedOn ? zhDate(site.activatedOn, now) : null,
      // A capacity nobody has checked is not a capacity: number and date, or neither.
      capacity: !stale && slots !== null ? `剩余 ${Math.max(0, slots - used)} 个名额` : null,
      competing: list(site.competing).length ? `${list(site.competing).length} 项` : null,
      referred: numeric(states.referred) ?? 0,
      waiting: numeric(states.contacted) ?? 0,
      enrolled: numeric(states.enrolled) ?? 0,
      checkedAt: site.verifiedAt ? zhDate(site.verifiedAt, now) : null,
      alert: stale ? (days === null ? "资料还没有核实过" : `资料已 ${days} 天没有核实`) : null,
      needs: list(object(site.capability).unmet).map(String),
      contacts: list(site.contacts).length,
    };
  });
  const followup = followups.map((episode) => ({
    id: episode.id,
    label: (/** @type {Record<string, string>} */ (VCR_FOLLOWUP_KIND_LABELS_ZH))[episode.kind] ?? episode.kind,
    kind: (/** @type {Record<string, string>} */ (VCR_FOLLOWUP_KIND_LABELS_ZH))[episode.kind] ?? episode.kind,
    detail: `${episode.subjectKey}${episode.exitReason ? ` · ${episode.exitReason}` : ""}`,
    at: zhDate(episode.windowStart ?? episode.createdAt, now),
  }));
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
      at: fact.occurredAt ?? null, assertion: fact.clinical?.assertion ?? fact.polarity, experiencer: fact.clinical?.experiencer ?? null,
      medicationState: fact.clinical?.medication?.state ?? null, correctionOf: fact.clinical?.correctionOf ?? null,
      superseded: fact.superseded === true, conflictFactIds: fact.conflicts ?? [], correctionReason: fact.clinical?.correctionReason ?? null,
      quote: fact.source?.quote ?? null, locator: fact.source ? { documentId: fact.source.documentId, start: fact.source.start, end: fact.source.end } : null })),
    headline: total ? `${total.toLocaleString("en-US")} 人已评估，${(eligible ?? 0).toLocaleString("en-US")} 人全部满足，${insufficient.toLocaleString("en-US")} 人至少有 1 条未知或待复评。` : null,
    partner: total ? { name: null, candidates: total, tier: study.dataTier, snapshotAt: match.snapshotAt ? zhDate(match.snapshotAt, now) : null } : null,
    // One direction: from the protocol to the patients. 「给患者找试验」 has no data path (the evaluator only ever writes this direction), so
    // it is not offered and a request for it reads the same view.
    direction: "trial_to_patient",
    directions: ["trial_to_patient"],
    funnel,
    candidates,
    selected,
    gaps,
    pendingReview: pendingReview.length ? { count: pendingReview.length, subjects: pendingReview.slice(0, 20) } : null,
    ledger,
    forecast,
    sites: siteRows,
    followup,
    protocol: protocol ? { version: protocol.version, title: text(protocol.title) } : null,
    abilities: { contact: abilitiesOf(roles ?? []).includes("contact_patients") },
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
  // says which (针对版本 1) beside 「复核后有变更」.
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
  const cards = assumptions.map((/** @type {any} */ card) => {
    const items = evidenceFor(card);
    const value = assumptionValue(card, { now, evidence: items });
    const pooling = object(card.pooling);
    const versions = (bundle.assumptionVersions?.get?.(card.key) ?? []).map((/** @type {any} */ row) => ({
      version: row.version, at: zhTime(row.createdAt, now), text: text(row.note) ?? `${row.name || row.key}${row.pointValue != null ? ` = ${row.pointValue}` : ""}`,
      note: row.afterFreeze === true ? "冻结后新增，不影响已冻结的计划" : row.reviewState === "reviewed" ? "已复核" : null,
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
      applicability: applicabilityText(card),
      sensitivity: sensitivityText(card),
      review: reviewOf(card),
      ...(newEvidence ? { newEvidence } : {}),
      // What an edit starts from. A person's value is an expert setting: it keeps the card's endpoint and applicability but not the pooled
      // evidence, which no longer supports the number (AC-25).
      edit: { pointValue: numeric(card.pointValue), unit: text(card.unit), note: text(card.note), endpoint: text(card.endpoint), applicability: object(card.applicability) },
      detail: {
        subtitle: [text(card.endpoint), text(pooling.calibre) ? `汇总口径：${CALIBRE_LABELS[String(pooling.calibre)] ?? pooling.calibre}` : null].filter(Boolean).join(" · ") || null,
        stats: [
          ...(numeric(pooling.k) !== null ? [{ label: "研究数", value: String(numeric(pooling.k)) }] : []),
          ...(numeric(pooling.i2) !== null ? [{ label: "I²", value: `${roundTo(Number(pooling.i2) <= 1 ? Number(pooling.i2) * 100 : Number(pooling.i2), 0)}%` }] : []),
          ...(numeric(pooling.tau2) !== null ? [{ label: "τ²", value: String(roundTo(Number(pooling.tau2), 3)) }] : []),
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
    return { ...presentPrecedentRow(row), usedFor: [...new Set(items.map((/** @type {any} */ item) => PARAMETER_LABELS[String(item.parameter)]).filter(Boolean))].slice(0, 3).join("、") || null };
  });
  const snapshots = presentDataSnapshots(dataPlane, now);
  const aiSet = cards.filter((card) => card.value.review === "ai_set").length;
  return {
    headline: cards.length ? `${cards.length} 张假设卡${aiSet ? `，其中 ${aiSet} 张由 AI 设定、还没有复核` : ""}。` : null,
    status: [
      ...(precedents.length ? [{ label: "试验先例", value: `${precedents.length} 项` }] : []),
      ...(cards.length ? [{ label: "假设卡", value: `${cards.length} 张` }] : []),
      { label: "患者级数据", value: study.dataTier === "T0" ? "未接入" : (snapshots.length ? `${snapshots.length} 个快照` : "未接入") },
    ],
    ...(evidence?.registryCoverage?.length ? { registryCoverage: evidence.registryCoverage } : {}),
    assumptions: cards,
    reviews: list(bundle.reviews).map((/** @type {any} */ review) => presentVcrReview(review, reviewContextOf(bundle))),
    selectedId: cards.find((card) => card.id === query.card || card.key === query.card)?.id ?? null,
    precedents,
    precedentSources: precedents.length ? `${precedents.length} 项试验先例` : null,
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
        // A record converted from PDF or Word: what it was, how many pages, how many had no text layer.
        sourceFormat: text(file.sourceFormat), pages: numeric(file.pages), blankPages: numeric(file.blankPages),
        // A table a FHIR, OMOP or ADaM import produced.
        importFormat: text(file.importFormat),
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
        const role = grantee.startsWith("role:") ? (/** @type {Record<string, string>} */ (VCR_MEMBER_ROLE_LABELS_ZH))[grantee.slice(5)] : null;
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
