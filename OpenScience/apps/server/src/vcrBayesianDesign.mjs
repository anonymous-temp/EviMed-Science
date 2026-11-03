/**
 * What the trial page says of a Bayesian design without MCMC (algorithm round T8, T10, 2026-11-03): the result of a `design_bayesian` job.
 *
 * Three kinds, one card each: the Bayesian optimal phase II design (`bop2`), predictive-probability monitoring (`predictive_monitoring`),
 * and the calibration of a posterior-probability success threshold (`threshold_calibration`). Like a confirmatory design, a result of this
 * kind belongs to no object of the study and is filed under the design and what it was asked about; the trial tab lists the current one of
 * each key as a card. This module turns the engine's result into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **Every number is exact.** The phase II designs are a dynamic programme over the looks and the responses, the calibration a closed form
 *   or a quadrature: no number on these cards has a Monte-Carlo error, and none is called a simulation.
 * - **A phase II design is always read beside Simon's.** The engine returns Simon's optimal and minimax designs at the same alpha and
 *   power; the saving in expected patients is the difference of two numbers the card carries. The card says which objective the search
 *   had (the largest power that keeps alpha, or the fewest expected patients at the power asked for), because the two give different
 *   designs and the saving means something different under each.
 * - **A predictive design's final threshold is an interval.** Any threshold between two posterior probabilities gives the same rule; the
 *   card states the interval, not one value.
 * - **A calibrated threshold on a discrete endpoint is the smallest that keeps the level**, and the achieved type I error is stated
 *   beside it, because the error is a step function of the threshold.
 * - **A default the person did not state is a premise** (`premises`): the engine lists what it assumed and this module words each one.
 * - **No back-office word reaches the card.**
 *
 * @module vcrBayesianDesign
 */

import { finishPremises } from "./vcrPremises.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a Bayesian-design result is filed under: the design and what it was asked about (the two rates and the size of a phase II
 * design; the endpoint of a calibration).
 * @param {Record<string, any>} scenario
 */
export function vcrBayesianSubjectId(scenario) {
  const design = object(scenario?.design);
  const truth = object(scenario?.truth);
  const kind = String(design.kind ?? "unknown");
  if (kind === "threshold_calibration") return `bayes:${kind}:${String(object(scenario?.endpoint).type ?? "unknown")}`;
  return `bayes:${kind}:${truth.nullRate ?? "?"}-${truth.alternativeRate ?? "?"}-${design.maxN ?? "?"}`;
}

const KIND_WORDS = Object.freeze(/** @type {Record<string, { title: string, question: string }>} */ ({
  bop2: { title: "贝叶斯最优 II 期设计（BOP2）", question: "单臂 II 期每隔几人看一次，何时停，比 Simon 两阶段设计少多少人" },
  predictive_monitoring: { title: "预测概率监测", question: "单臂 II 期按预测成功的概率决定何时停，比 Simon 两阶段设计少多少人" },
  threshold_calibration: { title: "成功阈值的校准", question: "用这个先验和阈值，I 类错误和功效是多少，要把 I 类错误校到规定水平，阈值应取多少" },
}));
const ENDPOINT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ continuous: "连续型终点（均值差）", binary: "二分类终点（率差）", time_to_event: "事件时间终点（风险比）" }));

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} fraction */
const percent = (fraction) => `${plain(fraction * 100)}%`;

/**
 * The label of a cell or a headline number the engine named. `null` for a name this page does not word.
 * @param {string} name @returns {string | null}
 */
export function cellLabel(name) {
  const fixed = /** @type {Record<string, string>} */ ({
    type_one_error: "I 类错误（无效应时仍判成功的概率）", power: "功效（有效应时判成功的概率）", expected_sample_size: "有效应时的期望样本量",
    expected_sample_size_null: "无效应时的期望样本量", futility_stop_probability: "中途因无效停止的概率", early_stop_efficacy_probability: "中途提前宣布成功的概率",
    stop_futility_probability: "在这次分析因无效停止的概率", stop_efficacy_probability: "在这次分析提前宣布成功的概率", max_patients: "最多患者数",
    simon_expected_sample_size_null: "Simon 最优设计无效应时的期望样本量", expected_sample_size_saving_null: "无效应时比 Simon 最优设计少的期望样本量",
    success_threshold: "成功阈值（后验概率）", calibrated_threshold: "校准后的成功阈值", type_one_error_stated: "你给的阈值下的 I 类错误", power_stated: "你给的阈值下的功效",
  });
  return fixed[name] ?? null;
}

/** @param {Record<string, any>} measure @param {{ result: Record<string, any>, staleMark: any }} context */
const shown = (measure, { result, staleMark }) => measureValue(measure, { kind: "design_bayesian", result, tab: "trial", staleMark });
/** A number the engine computed exactly, as a `calculated` measure of the given name. @param {string} name @param {unknown} number */
const calculated = (name, number) => (numeric(number) === null ? null : { name, value: Number(number), simulated: false, source: "calculated" });

const OBJECTIVE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  max_power: "在 I 类错误不超过规定水平的设计里取功效最大的", min_expected_n: "在 I 类错误不超过规定水平、功效达到要求的设计里取无效应时期望样本量最少的",
}));

/** @param {string} key @param {unknown} raw */
function assumptionRow(key, raw) {
  const words = /** @type {Record<string, (v: any) => [string, string]>} */ ({
    "design.lookEvery": (v) => ["每隔多少人分析一次", `${plain(Number(v))} 人`],
    "analysis.alpha": (v) => ["显著性水平（单侧）", percent(Number(v))],
    "analysis.power": (v) => ["要求的功效", percent(Number(v))],
    "design.prior": (v) => ["有效率的先验", String(v)],
    "design.objective": (v) => ["搜索的目标", OBJECTIVE_WORDS[String(v)] ?? String(v)],
    "design.predictive.futility": (v) => ["预测成功的概率低于多少就停止", percent(Number(v))],
    "design.bop2": (v) => ["λ 与 γ", String(v).replace("lambda", "λ").replace("gamma", "γ").replace("found by a grid search", "由网格搜索得到")],
    "truth.sd": (v) => ["结局的标准差（视为已知）", plain(Number(v))],
    "design.allocation": (v) => ["试验组所占比例", percent(Number(v))],
    "design.priorTreatment": (v) => ["试验组有效率的先验", String(v)],
    "design.priorControl": (v) => ["对照组有效率的先验", String(v)],
  });
  const make = words[key];
  if (!make) return null;
  const [label, value] = make(raw);
  return { key: `bayes:${key}`, label, value, source: "default", decisive: false, reason: null };
}

/** @param {Record<string, any>} design */
function premisesOf(design) {
  const kind = String(design.kind);
  const given = object(design.given);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  if (kind === "threshold_calibration") {
    const details = object(design.details);
    const endpoint = String(design.endpoint);
    rows.push({ key: "endpoint", label: "终点", value: ENDPOINT_WORDS[endpoint] ?? endpoint, source: "given", decisive: false });
    if (numeric(details.standardError) !== null) rows.push({ key: "se", label: "估计量的标准误", value: plain(Number(details.standardError)), source: "assumed", decisive: true });
    if (numeric(details.nTreat) !== null) rows.push({ key: "size", label: "每组样本量", value: `试验组 ${plain(Number(details.nTreat))} 例，对照组 ${plain(Number(details.nControl))} 例`, source: "given", decisive: true });
    const sd = numeric(details.priorSd);
    if (sd !== null) rows.push({ key: "prior", label: "效应的先验", value: `均值 ${plain(Number(details.priorMean))}，标准差 ${plain(sd)}`, source: "assumed", decisive: true });
    else if (list(details.priorTreatment).length) rows.push({ key: "prior", label: "两组有效率的先验", value: `试验组 Beta(${list(details.priorTreatment).map((v) => plain(Number(v))).join(", ")})，对照组 Beta(${list(details.priorControl).map((v) => plain(Number(v))).join(", ")})`, source: "assumed", decisive: true });
    else rows.push({ key: "prior", label: "效应的先验", value: "无先验信息（平坦）", source: "default", decisive: true });
    if (numeric(details.margin) !== null) rows.push({ key: "margin", label: "后验概率要超过的效应界值", value: plain(Number(details.margin)), source: numeric(given.margin) === null ? "default" : "given", decisive: true });
    rows.push({ key: "alpha", label: "规定的 I 类错误（单侧）", value: percent(Number(design.alpha)), source: numeric(given.alpha) === null ? "default" : "given", decisive: true });
  } else {
    const rate = (/** @type {unknown} */ v) => (numeric(v) === null ? "—" : percent(Number(v)));
    const operating = list(design.operating).map(object);
    const nullRow = operating.find((row) => row.role === "null");
    const altRow = operating.find((row) => row.role === "alternative");
    rows.push({ key: "rates", label: "无效应与有效应时的有效率", value: `${rate(nullRow?.rate)} 与 ${rate(altRow?.rate)}`, source: "assumed", decisive: true });
    const looks = list(design.looks).map(object);
    if (looks.length) rows.push({ key: "looks", label: "分析时机", value: `累计 ${looks.map((look) => plain(Number(look.size))).join("、")} 人时`, source: numeric(given.lookEvery) === null ? "default" : "given", decisive: true });
    const prior = object(design.prior);
    if (numeric(prior.a) !== null) rows.push({ key: "prior", label: "有效率的先验", value: `Beta(${plain(Number(prior.a))}, ${plain(Number(prior.b))})`, source: "default", decisive: false });
    const parameters = object(design.parameters);
    if (kind === "predictive_monitoring" && numeric(parameters.futility) !== null) {
      rows.push({ key: "futility", label: "预测成功的概率低于多少就停止", value: percent(Number(parameters.futility)), source: numeric(given.futilityThreshold) === null ? "default" : "given", decisive: true });
      if (numeric(parameters.efficacy) !== null) rows.push({ key: "efficacy", label: "预测成功的概率高于多少就提前宣布成功", value: percent(Number(parameters.efficacy)), source: "given", decisive: true });
    }
    if (typeof design.objective === "string") rows.push({ key: "objective", label: "搜索的目标", value: OBJECTIVE_WORDS[design.objective] ?? design.objective, source: given.objective ? "given" : "default", decisive: true });
  }
  for (const entry of list(design.assumed).map(object)) {
    const row = assumptionRow(String(entry.key), entry.value);
    if (row && !(kind === "threshold_calibration" && ["design.prior", "design.priorTreatment", "design.priorControl"].includes(String(entry.key)))
      && !(kind !== "threshold_calibration" && ["design.prior", "design.objective", "design.predictive.futility"].includes(String(entry.key)))) rows.push(row);
  }
  return finishPremises(rows);
}

/** @param {Record<string, any>} look @param {number} index @param {number} count */
function lookRule(look, index, count) {
  const last = index === count - 1;
  const parts = [];
  if (last) parts.push(`有效达到 ${plain(Number(look.successAtOrAbove))} 例及以上则成功，否则失败`);
  else {
    parts.push(numeric(look.futilityAtOrBelow) === null ? "不因无效而停止" : `累计有效不超过 ${plain(Number(look.futilityAtOrBelow))} 例则停止（无效）`);
    if (numeric(look.efficacyAtOrAbove) !== null) parts.push(`累计有效达到 ${plain(Number(look.efficacyAtOrAbove))} 例则提前宣布成功`);
  }
  return parts.join("；");
}

/** @param {Record<string, any>} simon @param {{ result: Record<string, any>, staleMark: any }} context */
function simonRow(simon, context) {
  if (!simon) return null;
  const rate = (/** @type {string} */ name, /** @type {unknown} */ value) => shown(/** @type {any} */ (calculated(name, value)), context);
  return {
    rule: `第一阶段 ${plain(Number(simon.n1))} 人，有效不超过 ${plain(Number(simon.r1))} 例则停止；共 ${plain(Number(simon.n))} 人，有效超过 ${plain(Number(simon.r))} 例则成功`,
    typeOneError: rate("type_one_error", simon.typeOneError), power: rate("power", simon.power),
    expectedNull: rate("expected_sample_size_null", simon.expectedN0), expectedAlt: rate("expected_sample_size", simon.expectedN1),
  };
}

/**
 * @param {Record<string, any>} result @param {any} staleMark @param {Record<string, any>} design the engine's `diagnostics.bayesianDesign`
 */
function phase2Payload(result, staleMark, design) {
  const context = { result, staleMark };
  const kind = String(design.kind);
  const looks = list(design.looks).map(object);
  const operating = list(design.operating).map(object);
  const rowOf = (/** @type {Record<string, any>} */ row) => {
    const cells = object(row.cells);
    const isNull = row.role === "null";
    return { role: String(row.role), label: isNull ? `无效应时（有效率 ${percent(Number(row.rate))}）` : `有效应时（有效率 ${percent(Number(row.rate))}）`,
      cells: {
        success: shown(isNull ? cells.type_one_error : cells.power, context), expected: shown(cells.expected_sample_size, context),
        futility: shown(cells.futility_stop_probability, context), efficacy: cells.early_stop_efficacy_probability ? shown(cells.early_stop_efficacy_probability, context) : null,
      } };
  };
  const stops = looks.slice(0, -1).map((look, index) => {
    const at = (/** @type {Record<string, any>} */ row, /** @type {string} */ field) => {
      const byLook = list(row?.byLook).map(object)[index];
      return byLook && object(byLook[field]).value !== undefined ? shown(byLook[field], context) : null;
    };
    return { look: index + 1, size: numeric(look.size), nullFutility: at(operating.find((row) => row.role === "null") ?? {}, "futility"), alternativeFutility: at(operating.find((row) => row.role === "alternative") ?? {}, "futility") };
  });
  const parameters = object(design.parameters);
  const searched = parameters.searched === true;
  /** @type {string | null} */
  let found = null;
  if (kind === "bop2") {
    found = `λ = ${plain(Number(parameters.lambda))}，γ = ${plain(Number(parameters.gamma))}${numeric(parameters.efficacyEta) === null ? "" : `，提前成功的 η = ${plain(Number(parameters.efficacyEta))}`}${searched ? "（在网格上搜索得到）" : "（你给定的）"}`;
  } else if (numeric(parameters.finalThresholdAbove) !== null || numeric(parameters.finalThresholdAtMost) !== null) {
    const low = numeric(parameters.finalThresholdAbove); const high = numeric(parameters.finalThresholdAtMost);
    found = `最终有效达到 ${plain(Number(parameters.successResponses))} 例及以上则成功；最终后验概率阈值取在 (${low === null ? "0" : percent(low)}，${high === null ? "1" : percent(high)}] 内，得到的规则都一样`;
  }
  const simon = object(object(design.baselines).simon);
  const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
    .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shown(entry.value, context) }));
  const saving = list(result.measures).map(object).find((measure) => measure.name === "expected_sample_size_saving_null");
  return {
    id: String(result.id), version: Number(result.version), form: kind === "bop2" ? "bop2" : "predictive", design: kind,
    title: KIND_WORDS[kind]?.title ?? kind, question: KIND_WORDS[kind]?.question ?? "", headline,
    looks: looks.map((look, index) => ({ look: index + 1, size: numeric(look.size), rule: lookRule(look, index, looks.length) })),
    operating: { rows: operating.map(rowOf), stops },
    found, reachedPower: design.reachedPower === true,
    simon: simon.optimal ? { optimal: simonRow(object(simon.optimal), context), minimax: simon.minimax ? simonRow(object(simon.minimax), context) : null,
      saving: saving ? shown(saving, context) : null } : null,
    calibration: null, premises: premisesOf(design), limited: null,
  };
}

/** @param {Record<string, any>} result @param {any} staleMark @param {Record<string, any>} design */
function calibrationPayload(result, staleMark, design) {
  const context = { result, staleMark };
  const rowWords = /** @type {Record<string, string>} */ ({ calibrated: "校准后的阈值", stated: "你给的阈值", conventional: "常规阈值（1 − 规定的 I 类错误）" });
  const discrete = design.discrete === true;
  const rows = list(design.rows).map(object).map((row) => {
    const cells = object(row.cells);
    return { kind: String(row.label), label: rowWords[String(row.label)] === undefined ? String(row.label) : (String(row.label) === "calibrated" && discrete ? "校准后的阈值（I 类错误不超过规定水平的最小阈值）" : rowWords[String(row.label)]),
      threshold: shown(cells.threshold, context), typeOneError: shown(cells.type_one_error, context), power: shown(cells.power, context) };
  });
  const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
    .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shown(entry.value, context) }));
  const note = discrete
    ? "二项数据只有有限种结果，I 类错误随阈值呈阶梯形变化：这里取的是使它不超过规定水平的最小阈值，实际达到的水平写在右边。"
    : "阈值是后验概率的界限：数据好到后验概率超过它就判成功。信息性先验会让同一个阈值的 I 类错误偏离规定水平，校准就是把它拉回去。";
  return {
    id: String(result.id), version: Number(result.version), form: "calibration", design: "threshold_calibration",
    title: KIND_WORDS.threshold_calibration.title, question: KIND_WORDS.threshold_calibration.question, headline,
    looks: [], operating: null, found: null, reachedPower: false, simon: null,
    calibration: { endpoint: ENDPOINT_WORDS[String(design.endpoint)] ?? "", rows, discrete, note }, premises: premisesOf(design), limited: null,
  };
}

/**
 * The cards of the trial tab for the Bayesian-design results the study holds now, newest first.
 * @param {Record<string, any>} bundle the trial tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentBayesianDesigns(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "design_bayesian" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => {
    const design = object(object(result.diagnostics).bayesianDesign);
    const staleMark = markFor(bundle.stale ?? [], nodeOf(result));
    if (design.kind === "bop2" || design.kind === "predictive_monitoring") return phase2Payload(result, staleMark, design);
    if (design.kind === "threshold_calibration") return calibrationPayload(result, staleMark, design);
    return null;
  }).filter(Boolean);
}
