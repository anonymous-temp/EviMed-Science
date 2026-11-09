/**
 * What the evidence tab says of a network meta-analysis, a dose-response meta-analysis and the empirical shrinkage of a published effect
 * (algorithm round C5, C6, E8, 2026-11-03), and the historical success rates read beside an assurance (E6). They are evidence the person uses, so
 * they land where pooled evidence lands: on the 依据 tab, a card each, filed under what they are about.
 *
 * A result of one of these kinds is the conversation's own: the run states the studies (`vcr_simulate`), the engine computes, and this module turns
 * the engine's record into the card's payload. It is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **Every card says what question it answers**, in the words a person asked it in ("这几种治疗互相比起来怎么样"), not the method's name.
 * - **A comparison line, never a replacement.** The shrinkage card shows the value the person stated first and unchanged, and the shrunken one
 *   beside it as "按 Cochrane 里这类试验的总体来看"; the success rates are "历史上这一阶段的通过率", never this trial's probability, and are
 *   printed in two columns (BIO, Wong) because the two sources count differently.
 * - **Every number is a `VcrValue`** (`measureValue`) except the published reference table, whose figures are strings of the source's own
 *   precision with the number of transitions or paths they stand on.
 * - **A default the person did not state is a premise** (the shared block 「这个结论的前提」, 3 to 5 decisive rows): the engine lists what it
 *   assumed (`assumed`) and the page words each. No back-office word reaches the card: no tool, package or method id.
 * - **Subjects.** A result is superseded only by another of the same (kind, subject). These kinds belong to no object of the study, so they are
 *   filed under the label the call gave them (the outcome, the exposure, the value), and a call without one files under "default": two analyses
 *   with different labels stand side by side, a second one with the same label is its next version.
 *
 * @module vcrEvidenceSynthesis
 */

import {
  VCR_BARTOS_2023_EFFECT_SCALE_LABELS_ZH, VCR_SUCCESS_RATE_AREAS, VCR_SUCCESS_RATE_PHASES, VCR_SUCCESS_RATE_PHASE_LABELS_ZH, VCR_SUCCESS_RATE_SOURCES,
  VCR_TURNER_COMPARISON_LABELS_ZH, VCR_TURNER_OUTCOME_LABELS_ZH, vcrSuccessRates,
} from "@evimed/domain";
import { finishPremises } from "./vcrPremises.mjs";
import { vcrScenarioKey } from "./vcrScenarioKey.mjs";
import { list, markFor, measureValue, numeric, object, text } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} fraction @param {number} [digits] */
const pct = (fraction, digits = 3) => `${plain(fraction * 100, digits)}%`;

const SUBJECT_PREFIX = Object.freeze(/** @type {Record<string, string>} */ ({ network_meta: "nm", dose_response_meta: "dr", effect_shrinkage: "es" }));

/**
 * The key a result of these kinds is filed under (the result's `subject_id`): the label the call gave it, when it gave one, and the
 * scenario it was asked on. Two analyses of two outcomes stand side by side whether or not they were labelled (two networks with no
 * label were one card with two versions); the same question asked again is the next version of one.
 * @param {string} kind a job kind @param {Record<string, any>} scenario
 */
export function vcrSynthesisSubjectId(kind, scenario) {
  const label = String(scenario?.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${SUBJECT_PREFIX[kind] ?? "ev"}:${label || "default"}:${vcrScenarioKey(scenario)}`;
}

// ---------------------------------------------------------------------------
// A network meta-analysis
// ---------------------------------------------------------------------------

const MEASURE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  odds_ratio: "比值比（OR）", risk_ratio: "相对危险度（RR）", log_ratio: "比值（如风险比）", mean_difference: "均值差", difference: "差值",
}));
const DIRECTION_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ lower_better: "数值越小越好", higher_better: "数值越大越好" }));
const MODEL_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ random: "随机效应（研究之间允许有差异）", common: "共同效应（假定研究之间没有差异）" }));

/**
 * @param {Record<string, any>} result the result the page shows
 * @param {(measure: any) => any} value the page's `VcrValue` maker for a measure of that result
 */
export function presentNetworkMeta(result, value) {
  const net = object(object(result?.diagnostics).network);
  if (!Object.keys(net).length) return null;
  const given = object(net.given);
  const ratio = String(given.scale) === "log";
  const nullLine = ratio ? 1 : 0;
  const level = numeric(given.level) ?? 0.95;
  const model = String(given.model) === "common" ? "common" : "random";
  const block = object(net[model]);
  const cells = list(block.cells).map(object);
  const cell = (/** @type {string} */ row, /** @type {string} */ column) => cells.find((entry) => entry.row === row && entry.column === column) ?? null;
  const effect = (/** @type {Record<string, any>} */ entry) => value({
    name: "network_effect", value: Number(entry.natural), simulated: false, source: "aggregate",
    interval: { kind: "confidence", low: Number(entry.naturalLower), high: Number(entry.naturalUpper), level },
  });
  const excludesNull = (/** @type {Record<string, any>} */ entry) => Number(entry.naturalLower) > nullLine || Number(entry.naturalUpper) < nullLine;
  const pscores = object(block.pscores);
  const order = list(net.order).map(String);
  const studiesOf = new Map(list(net.treatments).map(object).map((entry) => [String(entry.name), Number(entry.studies)]));
  const reference = String(given.reference ?? "");
  const vsReference = new Map(list(block.vsReference).map(object).map((entry) => [String(entry.row), entry]));
  const measureOf = (/** @type {string} */ name) => list(result.measures).map(object).find((measure) => measure.name === name);
  const shown = (/** @type {string} */ name) => { const measure = measureOf(name); return measure ? value(measure) : null; };

  const ranking = order.map((name, index) => {
    const own = vsReference.get(name) ?? null;
    return {
      rank: index + 1, treatment: name, studies: studiesOf.get(name) ?? 0,
      score: value({ name: "network_p_score", value: Number(pscores[name]), simulated: false, source: "aggregate" }),
      versusReference: own ? { value: effect(own), excludesNull: excludesNull(own) } : null,
      isReference: name === reference,
    };
  });
  const league = {
    treatments: order,
    meaning: "每格是“行”这种治疗比“列”这种治疗的效应",
    rows: order.map((row) => ({
      treatment: row,
      cells: order.map((column) => {
        if (row === column) return null;
        const entry = cell(row, column);
        return entry ? { value: effect(entry), directStudies: Number(entry.directStudies), excludesNull: excludesNull(entry) } : null;
      }),
    })),
  };

  const het = object(net.heterogeneity);
  const inc = object(net.inconsistency);
  const dfBetween = numeric(inc.dfBetweenDesigns) ?? 0;
  const pBetween = numeric(inc.pBetweenDesigns);
  let consistencySentence;
  if (dfBetween <= 0 || pBetween === null) {
    consistencySentence = "这张网络里没有环：每一对治疗只有一条证据通路，无法检验直接证据和间接证据是否一致。";
  } else {
    const q = `Q = ${plain(Number(inc.qBetweenDesigns))}，自由度 ${dfBetween}，P = ${plain(pBetween)}`;
    consistencySentence = pBetween < 0.05
      ? `不同比较组合之间的结果不一致（${q}）：直接证据和间接证据对不上，网络里的估计要谨慎读。`
      : `没有发现不同比较组合之间不一致的证据（${q}）；研究少的时候这个检验把握不大，不等于证明一致。`;
  }
  const consistency = {
    sentence: consistencySentence,
    betweenDesigns: dfBetween > 0 ? { q: numeric(inc.qBetweenDesigns), df: dfBetween, p: value({ name: "p_inconsistency", value: pBetween, simulated: false, source: "aggregate" }) } : null,
    withinDesigns: numeric(inc.dfWithinDesigns) ? { q: numeric(inc.qWithinDesigns), df: numeric(inc.dfWithinDesigns), p: numeric(inc.pWithinDesigns) } : null,
    basis: "按共同效应模型拆分总的 Q：同一比较组合内部的差异，和不同组合之间的差异",
  };
  const heterogeneity = {
    sentence: `研究之间的差异：I² = ${plain(Number(het.i2) * 100, 3)}%，τ² = ${plain(Number(het.tau2))}${numeric(het.p) === null ? "" : `（总体 Q 检验 P = ${plain(Number(het.p))}）`}。`,
    tau2: shown("tau_squared"), i2: shown("i_squared"),
  };

  /** @type {Array<Record<string, any>>} */
  const rows = [
    { key: "transitivity", label: "间接比较成立的前提", value: "各研究的人群和设计足够相似，没有哪种效应修饰因素只偏向某一种治疗", source: "assumed", decisive: true },
    { key: "direction", label: "排序的方向", value: `${DIRECTION_WORDS[String(given.direction)] ?? "—"}（排序得分按此计算）`, source: "given", decisive: true },
    { key: "model", label: "研究之间差异的处理", value: `${MODEL_WORDS[model]}；τ² = ${plain(Number(het.tau2))}`, source: list(net.assumed).some((entry) => object(entry).key === "model") ? "default" : "given", decisive: true },
    { key: "measure", label: "比较的量", value: `${MEASURE_WORDS[String(given.measure)] ?? "—"}${ratio ? "，在对数尺度上合并" : ""}`, source: "given", decisive: false },
  ];
  for (const entry of list(net.assumed).map(object)) {
    if (entry.key === "reference") rows.push({ key: "reference", label: "对照的治疗", value: `${String(entry.value)}（研究最多的一种；排序和联赛表不受它影响）`, source: "default", decisive: false });
    if (entry.key === "continuityCorrection") {
      rows.push({ key: "continuity", label: "零事件研究的校正", value: `${plain(Number(entry.value))}${text(entry.basis) ? `：${String(entry.basis).replace(/^.*?: /, "")}` : ""}`, source: "default", decisive: true });
    }
  }
  return {
    id: String(result.id), version: Number(result.version), label: text(given.label),
    title: text(given.label) ? `网络荟萃分析：${given.label}` : "网络荟萃分析",
    question: "这几种治疗互相比起来怎么样？证据前后一致吗？谁排在前面？",
    measure: MEASURE_WORDS[String(given.measure)] ?? "", direction: DIRECTION_WORDS[String(given.direction)] ?? "", model: MODEL_WORDS[model], modelKey: model,
    counts: { studies: shown("k"), treatments: shown("treatments"), designs: numeric(given.designs), multiArmStudies: numeric(given.multiArmStudies) },
    reference, ranking, league, consistency, heterogeneity,
    scoreNote: "排序得分是一种治疗好过其他每一种的平均概率，按点估计和精度算出，不是“最好”的概率；研究少的治疗排名靠的证据很薄。",
    premises: finishPremises(rows),
  };
}

// ---------------------------------------------------------------------------
// A dose-response meta-analysis
// ---------------------------------------------------------------------------

const RATIO_KIND_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ relative_risk: "相对危险度", odds_ratio: "比值比", hazard_ratio: "风险比" }));
const STAGE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ two: "两步法：先各研究分别拟合，再合并", one: "一步法：所有研究放在一个模型里" }));
const FIT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ reml: "限制性最大似然", ml: "最大似然", fixed: "固定效应" }));

/**
 * @param {Record<string, any>} result @param {(measure: any) => any} value
 */
export function presentDoseResponse(result, value) {
  const dr = object(object(result?.diagnostics).doseResponse);
  if (!Object.keys(dr).length) return null;
  const given = object(dr.given);
  const model = object(given.model);
  const spline = String(model.kind) === "spline";
  const unit = text(given.doseUnit) ?? "";
  const ratioWord = RATIO_KIND_WORDS[String(given.ratioKind)] ?? "相对危险度";
  const level = numeric(given.level) ?? 0.95;
  const reference = numeric(given.referenceDose) ?? 0;
  const measureOf = (/** @type {string} */ name) => list(result.measures).map(object).find((measure) => measure.name === name);
  const shown = (/** @type {string} */ name) => { const measure = measureOf(name); return measure ? value(measure) : null; };
  const ratioCell = (/** @type {Record<string, any>} */ row) => value({
    name: "dose_response_ratio", value: Number(row.ratio), simulated: false, source: "aggregate", interval: { kind: "confidence", low: Number(row.lower), high: Number(row.upper), level },
  });
  const predictions = list(dr.predictions).map(object).map((row) => ({ dose: Number(row.dose), isReference: Number(row.dose) === reference, value: ratioCell(row) }));
  const curve = list(dr.curve).map(object).filter((row) => numeric(row.dose) !== null && numeric(row.ratio) !== null)
    .map((row) => ({ dose: Number(row.dose), ratio: Number(row.ratio), lower: Number(row.lower), upper: Number(row.upper) }));
  const tests = object(dr.tests);
  const first = numeric(dr.firstDoseAwayFromReference);
  const step = numeric(given.perDose);
  let headline;
  if (!spline) {
    const per = measureOf("ratio_per_dose_step");
    const interval = object(per?.interval);
    headline = per && step !== null
      ? `剂量每增加 ${plain(step)}${unit ? ` ${unit}` : ""}，${ratioWord}变为 ${plain(Number(per.value))}（${pct(level, 2)}区间 ${plain(Number(interval.low))} 到 ${plain(Number(interval.high))}）。`
      : null;
  } else {
    const nl = object(tests.nonlinearity);
    headline = numeric(nl.p) === null ? null
      : Number(nl.p) < 0.05
        ? `剂量和效应不是一条直线（非线性检验 P = ${plain(Number(nl.p))}）：看下面的曲线，不要只看每单位的斜率。`
        : `没有发现偏离直线的证据（非线性检验 P = ${plain(Number(nl.p))}），但研究少时这个检验把握不大。`;
  }
  const firstKind = String(dr.firstDoseKind ?? "");
  // a line leaves 1 at every dose when its slope is significant, and so does a curve whose slope at the reference is: then the first dose above the
  // reference is only the first step of the grid, and the page says there is no starting dose to name (review stats2 finding 6)
  const firstSentence = firstKind === "at_once"
    ? `参照剂量以上的每个剂量，${ratioWord}的区间都不包含 1：刚越过 ${plain(reference)}${unit ? ` ${unit}` : ""}，曲线就已经离开 1，所以数据指不出一个“起效的剂量”。要问多大剂量才有意义，就看下面曲线上想要的${ratioWord}落在哪个剂量。`
    : first === null
    ? `在数据覆盖的剂量范围内，相对于 ${plain(reference)}${unit ? ` ${unit}` : ""}，${ratioWord}的区间没有离开 1。`
    : `从大约 ${plain(first)}${unit ? ` ${unit}` : ""} 起，相对于 ${plain(reference)}${unit ? ` ${unit}` : ""}，${ratioWord}的区间不再包含 1；这是对拟合曲线逐点的读法，不是数据确定下来的起效剂量。`;
  const heterogeneity = object(dr.heterogeneity);
  const excluded = list(dr.excluded).map(object);
  /** @type {Array<Record<string, any>>} */
  const rows = [
    { key: "model", label: "剂量和效应的关系", value: spline ? `限制性立方样条，节点在剂量 ${list(model.knots).map((knot) => plain(Number(knot))).join("、")}` : "一条直线（对数比值随剂量线性变化）", source: "given", decisive: true },
    { key: "reference", label: "比较的参照剂量", value: `${plain(reference)}${unit ? ` ${unit}` : ""}`, source: list(dr.assumed).some((entry) => object(entry).key === "referenceDose") ? "default" : "given", decisive: true },
    { key: "covariance", label: "同一研究里各水平的相关性",
      value: String(given.covariance) === "indep" ? "按相互独立处理（有的水平没写病例数或人数）：区间比用上病例数时更窄"
        : String(given.covariance) === "mixed" ? `用各水平的病例数和人数还原（Greenland–Longnecker 的方法）；研究 ${list(given.independentStudies).map(String).join("、")} 没写全病例数或人数，它的各水平按相互独立处理，合并后的区间比全都用上病例数时更窄`
        : "用各水平的病例数和人数还原（Greenland–Longnecker 的方法）",
      source: list(dr.assumed).some((entry) => object(entry).key === "covariance" && ["indep", "mixed"].includes(String(object(entry).value))) ? "default" : "given",
      decisive: ["indep", "mixed"].includes(String(given.covariance)) },
    { key: "stage", label: "合并方式", value: `${STAGE_WORDS[String(given.stage)] ?? ""}；${FIT_WORDS[String(given.method)] ?? ""}`, source: "default", decisive: false },
  ];
  if (excluded.length) {
    rows.push({ key: "excluded", label: "没能纳入的研究", value: `${excluded.map((entry) => String(entry.studyId)).join("、")}：水平太少，放不进这个模型（一步法可以纳入）`, source: "given", decisive: true });
  }
  return {
    id: String(result.id), version: Number(result.version), label: text(given.label),
    title: text(given.label) ? `剂量反应：${given.label}` : "剂量反应荟萃分析",
    question: "从多大剂量开始有效？随着剂量增加，是一直上升还是趋于平缓？",
    ratioWord, doseUnit: unit || null, referenceDose: reference, modelKind: spline ? "spline" : "linear",
    counts: { studies: shown("k"), levels: numeric(given.levels) },
    headline, firstDose: { dose: first, sentence: firstSentence },
    predictions, curve,
    tests: {
      overall: numeric(object(tests.overall).p) === null ? null : { p: shown("p_dose_response"), sentence: `剂量与效应有关的总体检验 P = ${plain(Number(object(tests.overall).p))}` },
      nonlinearity: spline && numeric(object(tests.nonlinearity).p) !== null ? { p: shown("p_nonlinearity") } : null,
    },
    heterogeneity: numeric(heterogeneity.i2) === null ? null : { i2: shown("i_squared"), sentence: `研究之间的差异：I² = ${plain(Number(heterogeneity.i2) * 100, 3)}%${numeric(heterogeneity.p) === null ? "" : `（Q 检验 P = ${plain(Number(heterogeneity.p))}）`}。` },
    excluded: excluded.map((entry) => ({ studyId: String(entry.studyId), levels: numeric(entry.levels), needed: numeric(entry.needed) })),
    note: "这是研究之间的剂量反应关系，说的是人群，不是对某一个人的预测。",
    premises: finishPremises(rows),
  };
}

// ---------------------------------------------------------------------------
// The empirical shrinkage of a published effect
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} result @param {(measure: any) => any} value
 */
export function presentEffectShrinkage(result, value) {
  const shrinkage = object(object(result?.diagnostics).shrinkage);
  if (!Object.keys(shrinkage).length) return null;
  const given = object(shrinkage.given);
  const ratio = String(given.scale) === "log";
  const level = numeric(given.level) ?? 0.95;
  const alpha = numeric(given.alpha) ?? 0.05;
  const natural = (/** @type {number} */ x) => (ratio ? Math.exp(x) : x);
  const calc = (/** @type {string} */ name, /** @type {unknown} */ number, /** @type {Record<string, any>} */ extra = {}) =>
    (numeric(number) === null ? null : value({ name, value: Number(number), simulated: false, source: "calculated", ...extra }));
  const rows = list(shrinkage.rows).map(object).map((row) => {
    const degenerate = row.degenerate === true;
    const quartiles = list(row.exaggerationQuartiles).map(Number);
    const interval = list(row.naturalInterval).map(Number);
    return {
      id: String(row.id),
      stated: { value: calc("shrinkage_stated", row.natural), z: calc("z_statistic", row.z), p: calc("p_value", row.p) },
      shrunken: degenerate ? null : {
        value: calc("shrunken_estimate", row.shrunkenNatural, interval.length === 2 ? { interval: { kind: "credible", low: interval[0], high: interval[1], level } } : {}),
        factor: calc("shrinkage_factor", row.shrinkageFactor),
      },
      exaggeration: degenerate || quartiles.length !== 3 ? null : {
        median: calc("exaggeration_median", quartiles[1]),
        quartiles: { low: calc("exaggeration_median", quartiles[0]), high: calc("exaggeration_median", quartiles[2]) },
        estimateLarger: calc("estimate_larger_probability", row.estimateLargerThanTruth),
      },
      correctSign: calc("correct_sign_probability", row.correctSign),
      replication: degenerate ? null : calc("replication_probability", row.replication),
      futureSuccess: degenerate || numeric(row.futureSe) === null ? null : { se: Number(row.futureSe), value: calc("future_trial_success_probability", row.futureSuccess) },
      degenerate,
      sentence: degenerate ? "估计恰为 0，没有方向可言：只能说方向对错各一半。" : sentenceOf(row, { ratio, natural, alpha }),
    };
  });
  const reference = object(shrinkage.reference);
  /** @type {Array<Record<string, any>>} */
  const premiseRows = [
    { key: "population", label: "拿来对照的总体", value: "Cochrane 数据库里 23,551 项随机对照试验的主要疗效结果（van Zwet 等，2023）：各种干预、各种样本量，不是某一种药", source: "literature", decisive: true },
    { key: "scale", label: "估计的尺度", value: ratio ? "比值取对数后（零效应在 0）" : "差值（零效应在 0）", source: "given", decisive: true },
    { key: "replication", label: "“重复”指什么", value: `用同样精度、同样的真实效应再做一次，双侧 P < ${plain(alpha)} 且方向与原来一致`, source: list(shrinkage.assumed).some((entry) => object(entry).key === "alpha") ? "default" : "given", decisive: false },
  ];
  return {
    id: String(result.id), version: Number(result.version), label: text(given.label),
    title: text(given.label) ? `已发表效应的对照：${given.label}` : "已发表效应的对照",
    question: "这个已发表的效应，放到 Cochrane 里同类试验的总体中看，会打几折？再做一次还能不能成功？",
    scaleWord: ratio ? "比值" : "差值",
    rows,
    population: text(reference.population),
    note: "这是一条对照线：你写的值保持原样，设计和假设卡不会改用它。它描述的是总体中“这样的 z 统计量”的试验，不是这一种药；机制很强的药，它可能收缩得过多。",
    premises: finishPremises(premiseRows),
  };
}

/** @param {Record<string, any>} row @param {{ ratio: boolean, natural: (x: number) => number, alpha: number }} words */
function sentenceOf(row, { ratio, natural, alpha }) {
  const stated = natural(Number(row.estimate));
  const shrunk = natural(Number(row.shrunken));
  const factor = Number(row.shrinkageFactor);
  const exaggeration = numeric(list(row.exaggerationQuartiles)[1]);
  const parts = [
    `你写的值是 ${plain(stated)}（z = ${plain(Number(row.z))}）；Cochrane 里同类试验的总体读下来，真实的${ratio ? "比值" : "差值"}更可能是 ${plain(shrunk)}，保留了估计中约 ${pct(factor, 2)} 的效应`,
    exaggeration === null ? null : `估计比真实效应大的倍数，中位约 ${plain(exaggeration, 2)}`,
    `方向正确的概率约 ${pct(Number(row.correctSign), 2)}`,
    numeric(row.replication) === null ? null : `同样精度的试验再做一次，仍然显著（P < ${plain(alpha)}）且方向一致的概率约 ${pct(Number(row.replication), 2)}`,
  ];
  if (numeric(row.futureSuccess) !== null) parts.push(`新试验的标准误是 ${plain(Number(row.futureSe))} 时，这个概率约 ${pct(Number(row.futureSuccess), 2)}`);
  return `${parts.filter(Boolean).join("；")}。`;
}

// ---------------------------------------------------------------------------
// Historical success rates (E6)
// ---------------------------------------------------------------------------

/** One rate as the page prints it: the figure at the source's precision and the number it stands on. @param {unknown} rate @param {unknown} n */
const rateView = (rate, n) => (numeric(rate) === null ? null : { text: `${plain(Number(rate) * 100, 3)}%`, n: numeric(n) });

/**
 * The reference table for the page, whole: every area, both sources, every phase. The page picks the area and the phase.
 */
export function vcrSuccessRatesPage() {
  return {
    title: "历史上这一阶段的通过率",
    note: "这是过去的研发项目通过这个阶段的比例，不是这个试验成功的概率。两个来源统计的方法不同，所以并排列出，不要合并。",
    sources: Object.entries(VCR_SUCCESS_RATE_SOURCES).map(([id, source]) => ({ id, label: source.labelZh, citation: source.citation, data: source.dataZh, method: source.methodZh, endpoint: source.endpointZh })),
    phases: VCR_SUCCESS_RATE_PHASES.map((id) => ({ id, label: VCR_SUCCESS_RATE_PHASE_LABELS_ZH[id] })),
    areas: VCR_SUCCESS_RATE_AREAS.map((area) => {
      const read = vcrSuccessRates({ area: area.id });
      return {
        id: area.id, label: area.zh, wongGroup: read?.wongGroup?.zh ?? null,
        phases: Object.fromEntries((read?.phases ?? []).map((phase) => [phase.id, {
          bio: phase.bio ? {
            toNext: rateView(phase.bio.toNext?.[1], phase.bio.toNext?.[0]), toFiling: rateView(phase.bio.toFiling?.[1], phase.bio.toFiling?.[0]),
            toApproval: rateView(phase.bio.toApproval?.[1], phase.bio.toApproval?.[0]),
          } : null,
          wong: phase.wong ? {
            toNext: Array.isArray(phase.wong.toNext) ? rateView(phase.wong.toNext[1], phase.wong.toNext[0]) : null,
            toApproval: Array.isArray(phase.wong.toApproval) ? rateView(phase.wong.toApproval[1], phase.wong.toApproval[0]) : rateView(phase.wong.toApproval, phase.wong.paths ?? null),
          } : null,
        }])),
      };
    }),
  };
}

/**
 * What `vcr_read what: success_rates` answers: the table for the phase and area asked (`filter.kind` is a phase id, `filter.query` an area id or its
 * name), or for every phase of all indications when none is named; the figures are the sources' own with the endpoint each counts to.
 * @param {Record<string, any>} filter
 */
export function vcrSuccessRatesRead(filter = {}) {
  const phase = typeof filter.kind === "string" && VCR_SUCCESS_RATE_PHASES.includes(filter.kind) ? filter.kind : null;
  const asked = typeof filter.query === "string" ? filter.query.trim() : "";
  const area = asked ? VCR_SUCCESS_RATE_AREAS.find((entry) => entry.id === asked || entry.zh === asked) ?? null : null;
  const read = vcrSuccessRates({ phase, area: area?.id ?? "all" });
  return {
    reference: "这些是过去研发项目通过各阶段的比例，不是任何一个试验成功的概率。两个来源方法不同，报告时并排写，不要合并或取平均。",
    area: read?.area ?? null, wongGroup: read?.wongGroup ?? null, phases: read?.phases ?? [], sources: VCR_SUCCESS_RATE_SOURCES,
    ...(asked && !area ? { unknownArea: asked, areas: VCR_SUCCESS_RATE_AREAS.map((entry) => ({ id: entry.id, name: entry.zh })) } : {}),
    ...(filter.kind && !phase ? { unknownPhase: String(filter.kind), phases_available: [...VCR_SUCCESS_RATE_PHASES] } : {}),
  };
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

/**
 * The cards of the evidence tab for the results of these kinds the study holds now, newest first.
 * @param {Record<string, any>} bundle the data tab's bundle (`allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentEvidenceSyntheses(bundle, { nodeOf }) {
  const current = (/** @type {string} */ kind) => list(bundle.allResults ?? bundle.results).map(object)
    .filter((row) => row.kind === kind && !row.supersededBy).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  const maker = (/** @type {Record<string, any>} */ result, /** @type {string} */ kind) => (/** @type {any} */ measure) =>
    measureValue(measure, { kind, result, tab: "data", staleMark: markFor(bundle.stale ?? [], nodeOf(result)) });
  const cards = (/** @type {string} */ kind, /** @type {(r: any, v: any) => any} */ present) => current(kind).map((result) => present(result, maker(result, kind))).filter(Boolean);
  return {
    networkMeta: cards("network_meta", presentNetworkMeta),
    doseResponses: cards("dose_response_meta", presentDoseResponse),
    effectShrinkages: cards("effect_shrinkage", presentEffectShrinkage),
  };
}

/** The words of the Turner setting and the Bartos scale in a card's premise: the table the prior came from, named for a person. @param {Record<string, any>} tauPrior the engine's `diagnostics.tauPrior` */
export function tauPriorWords(tauPrior) {
  const kind = String(tauPrior?.kind ?? "");
  const setting = object(tauPrior?.setting);
  if (kind === "turner_2015") {
    return `Cochrane 里二分类结局的荟萃分析（Turner 等，2015）：${VCR_TURNER_COMPARISON_LABELS_ZH[String(setting.comparison)] ?? ""}，${VCR_TURNER_OUTCOME_LABELS_ZH[String(setting.outcome)] ?? ""}`;
  }
  if (kind === "turner_2015_generic") return "Cochrane 里二分类结局的荟萃分析的总体情况（Turner 等，2015）";
  if (kind === "bartos_2023") return `Cochrane 里${VCR_BARTOS_2023_EFFECT_SCALE_LABELS_ZH[String(setting.effectScale)] ?? ""}结局的荟萃分析（Bartoš 等，2023）`;
  return "研究者自己设定的先验";
}
