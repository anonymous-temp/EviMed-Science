/**
 * What the trial page says of the value of information of a decision (in-silico round 2, R35, 2026-11-09): the result of a `decision_voi` job.
 *
 * The person has a decision (which design to run, or whether to run one) and a utility for each option; some inputs are not known. The result
 * is a table of what each unknown is worth learning: the value of perfect information (EVPI), of perfect information on each input (EVPPI,
 * ranked), the value of the data a named study would give (EVSI), and, for an input given only as optimistic / base / pessimistic values, the
 * value at which the best option changes. It is a result of its own kind, filed under the decision it was asked on, that the conversation
 * computes (`vcr_simulate`, kind `decision_voi`); this module turns the engine's result into the card's payload and is the only place that
 * knows the words.
 *
 * Hidden knowledge:
 *
 * - **The page ranks nothing the engine did not rank, and recommends nothing.** The order of the inputs is the engine's (largest EVPPI
 *   first); the sentence that names the next step says "按这张表" and what it is worth, and that whether the step is worth its cost is the
 *   person's decision. No cost of a study is assumed anywhere.
 * - **An input with no distribution never gets a probability.** A range (optimistic, base, pessimistic) is shown with the decision at each of
 *   its three values and the value where the decision flips, with the error of that value; it has no EVPPI row and the card says why.
 * - **Every number is a `VcrValue`** (`measureValue`): the Monte-Carlo error rides on each. An EVPPI can exceed the EVPI by estimation error;
 *   its share of the EVPI is shown as computed, and the card says the error excludes the smoothing of the regression.
 * - **The premises are the model.** The utility, each input's distribution and its source, the independence of the inputs, what dropout does and
 *   what "success" means are rows of “这个结论的前提”; a table of draws the engine did not compute says so.
 * - **No back-office word reaches the card.** An input called `effect` is 药物效应; a column of a caller's table is shown by its own name.
 *
 * @module vcrValueOfInformation
 */

import { finishPremises } from "./vcrPremises.mjs";
import { vcrScenarioKey } from "./vcrScenarioKey.mjs";
import { personWord } from "./vcrPersonStated.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a result is filed under (the result's `subject_id`): the decision it was asked on. The same question asked again is the next version of
 * one result; another input, option or study is another result.
 * @param {Record<string, any>} scenario
 */
export function vcrVoiSubjectId(scenario) {
  return `voi:${vcrScenarioKey(scenario)}`;
}

/** @type {Record<string, string>} */
const ROLE_WORDS = Object.freeze({ effect: "药物效应", sd: "结局的标准差", dropoutShare: "脱落比例", controlProgression: "对照组的恶化幅度" });
/** @param {string} name */
const roleWord = (name) => ROLE_WORDS[name] ?? name;
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/**
 * A distribution or a fixed value, in words.
 * @param {Record<string, any>} spec
 */
function specWords(spec) {
  const n = (/** @type {string} */ key) => numeric(spec[key]);
  switch (String(spec.family ?? "")) {
    case "fixed": return n("value") === null ? null : `固定为 ${plain(/** @type {number} */ (n("value")))}`;
    case "normal": return `正态分布，均值 ${plain(Number(n("mean")))}，标准差 ${plain(Number(n("sd")))}`;
    case "lognormal": return `对数正态分布，对数的均值 ${plain(Number(n("meanlog")))}，标准差 ${plain(Number(n("sdlog")))}`;
    case "beta": return `Beta(${plain(Number(n("alpha")))}, ${plain(Number(n("beta")))}) 分布`;
    case "uniform": return `${plain(Number(n("min")))} 到 ${plain(Number(n("max")))} 之间均匀分布`;
    case "range": return `乐观 ${plain(Number(n("optimistic")))}、基线 ${plain(Number(n("base")))}、悲观 ${plain(Number(n("pessimistic")))}（只有三个值，没有概率分布）`;
    case "draws": return "你给的抽样";
    default: return null;
  }
}

/** An option as the page names it: the label it was given and, when the scenario gave a number of people per arm, what that is. @param {Record<string, any>} option */
function optionName(option) {
  const label = String(option.label);
  const n = numeric(option.nPerArm);
  return n === null ? label : `${label}（${n === 0 ? "不做试验" : `每组 ${plain(n)} 人`}）`;
}

/** @param {Record<string, any>} voi the engine's `diagnostics.voi` @param {Record<string, any> | null} record */
function premisesOf(voi, record) {
  const given = object(voi.given);
  const table = given.source === "table";
  const slowing = given.effectScale === "proportional_slowing";
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  rows.push({
    key: "decision_rule", label: "怎样选", source: "default", decisive: false,
    value: "在每个输入的不确定性下，选期望收益最大的选项；信息价值是“先弄清再选”比“现在就选”多得的期望收益",
  });
  if (table) {
    rows.push({ key: "table_source", label: "收益和输入的来源", source: personWord(record, "table", "assumed"), decisive: true,
      value: "每个选项的收益和每个输入的抽样来自你给的表，这里没有重新计算它们；这里的数字只说明在这些抽样下哪个输入最值得先弄清" });
  } else {
    const net = given.utility === "net_benefit";
    rows.push({ key: "utility", label: "收益怎么算", source: personWord(record, "utility", "assumed"), decisive: true,
      value: net
        ? `每个选项的收益 = 成功的价值 ${plain(Number(given.successValue))}${given.unit ? ` ${given.unit}` : ""} × 成功概率 − 每人成本 ${plain(Number(given.costPerPatient ?? 0))} × 入组人数；不做试验的收益是 0`
        : "每个选项的收益 = 试验得到显著结果的概率；不做试验的收益是 0" });
    for (const entry of list(given.inputs).map(object)) {
      const role = String(entry.role);
      const words = specWords(entry);
      if (!words) continue;
      const fixed = entry.family === "fixed";
      rows.push({ key: `input_${role}`, label: slowing && role === "effect" ? "药物效应（占对照组恶化幅度的比例）" : roleWord(role), value: words,
        source: personWord(record, `inputs.${role}`, "assumed"), decisive: !fixed && role === "effect" });
    }
    rows.push({ key: "success", label: "“成功”是什么意思", source: "default", decisive: false,
      value: `按这次抽到的真实效应，单侧 ${plain(Number(given.alpha ?? 0.025))} 水平下得到显著结果的概率（正态近似），不是抽一次试验的 0 或 1` });
    rows.push({ key: "dropout_model", label: "脱落怎么处理", source: "default", decisive: false, value: "脱落只减少能分析的人数，且与结局无关（完全随机脱落）" });
  }
  rows.push({ key: "independence", label: "各输入之间", source: "default", decisive: false,
    value: table ? "按你给的抽样原样使用（包括它们之间的相关）" : "彼此独立；如果它们其实相关，各自的信息价值会被高估或低估" });
  rows.push({ key: "draws", label: "抽样次数", source: "default", decisive: false, value: `${plain(Number(given.draws), 6)} 次` });
  rows.push({ key: "regression", label: "单个输入的价值怎么估", source: "default", decisive: false,
    value: "用广义可加模型（GAM）把每个选项的收益对该输入做回归（Strong 等 2014）；数字后面的“±”是抽样平均的误差，不含回归平滑本身的误差" });
  return finishPremises(rows, record);
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function cardOf(result, staleMark) {
  const voi = object(object(result.diagnostics).voi);
  const show = (/** @type {any} */ measure) => measureValue(measure?.mcse === 0 ? { ...measure, mcse: undefined } : measure, { kind: "decision_voi", result, tab: "trial", staleMark });
  const given = object(voi.given);
  const options = list(voi.options).map(object);
  if (!options.length) return null;
  const named = new Map(options.map((option) => [String(option.label), optionName(option)]));
  const nameOf = (/** @type {string} */ label) => named.get(label) ?? label;
  const headline = list(result.measures).map(object).filter((m) => ["voi_evpi", "voi_probability_wrong_decision", "voi_best_expected_utility"].includes(String(m.name)))
    .map((m) => ({ key: String(m.name), label: String(MEASURE_LABELS[String(m.name)] ?? m.name), value: show(m) }));
  const evpi = numeric(list(result.measures).map(object).find((m) => m.name === "voi_evpi")?.value);
  const inputs = list(voi.inputs).map(object).map((row) => ({
    key: String(row.input), label: list(row.members).map((m) => roleWord(String(m))).join(" + "), rank: Number(row.rank), group: row.group === true,
    evppi: show(row.evppi), share: numeric(row.shareOfEvpi) === null ? null : Number(row.shareOfEvpi) * 100,
  }));
  const thresholds = list(voi.thresholds).map(object).map((row) => ({
    key: String(row.input), label: roleWord(String(row.input)),
    stated: { optimistic: numeric(row.optimistic), base: numeric(row.base), pessimistic: numeric(row.pessimistic) },
    decisions: { optimistic: nameOf(String(object(row.decisionAt).optimistic ?? "")), base: nameOf(String(object(row.decisionAt).base ?? "")), pessimistic: nameOf(String(object(row.decisionAt).pessimistic ?? "")) },
    flips: list(row.flips).map(object).map((flip) => ({
      value: measureValue({ name: "voi_threshold", value: flip.value, mcse: flip.mcse, simulated: true, source: "synthetic" }, { kind: "decision_voi", result, tab: "trial", staleMark }),
      from: nameOf(String(flip.from)), to: nameOf(String(flip.to)),
    })),
  }));
  const studies = list(voi.studies).map(object).map((row) => ({
    key: String(row.label), label: String(row.label), observes: roleWord(String(row.observes)), size: numeric(row.size),
    evsi: show(row.evsi), share: numeric(row.shareOfEvpi) === null ? null : Number(row.shareOfEvpi) * 100,
    ceiling: numeric(row.ceiling) === null ? null : show({ name: "evppi", value: row.ceiling, unit: row.evsi && object(row.evsi).unit, source: "synthetic" }),
  }));
  const next = object(voi.next);
  // the input the engine named as the next step (the best single input), not whichever row happens to lead the table
  const top = inputs.find((row) => row.key === next.input) ?? inputs[0] ?? null;
  const lead = next.kind === "none" || !top
    ? (evpi !== null && evpi <= 1e-9
      // a go/no-go stated as the chance of success has no cost to weigh it against: any trial beats not running one, whatever is learnt
      ? (given.utility === "success_probability" && options.some((option) => numeric(option.nPerArm) === 0)
        ? "在这些假设下，弄清任何一个输入都不会改变现在的选择：收益只算成功概率时，做试验总比不做好。要看“做不做”，请写出成功的价值和每人成本，按净收益再算。"
        : "在这些假设下，弄清任何一个输入都不会改变现在的选择。")
      : null)
    : `按这张表，最值得先弄清的是“${top.label}”${top.share === null ? "" : `（约占完全信息价值的 ${plain(top.share)}%）`}${next.study ? `；在你列出的研究里，“${String(next.study)}”价值最大` : ""}。这一步划不划算要看它的成本，由你决定。`;
  const failures = list(voi.failures).map(object);
  const limited = result.conclusion === "limited" || list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
    ? "预算在算完所有输入之前用完了，表里是已经算完的那些。" : failures.length ? `有 ${failures.length} 项没有拟合成功，没有放进表里。` : null;
  return {
    id: String(result.id), version: Number(result.version), form: "value_of_information",
    title: "下一步最值得弄清什么（信息价值）",
    question: "不知道的这些输入里，哪一个先弄清楚最可能改变决定、值多少；一项研究值不值得做",
    chosen: nameOf(String(voi.chosen ?? "")), draws: numeric(given.draws), unit: given.unit ? String(given.unit) : null,
    headline, lead,
    // an option's name is the words it was given; beside it, what it is in the people it enrols (0 per arm is no trial)
    options: options.map((o) => ({ key: String(o.label), label: optionName(o), chosen: o.chosen === true, expected: show(o.expectedUtility) })),
    inputs, thresholds, studies,
    premises: premisesOf(voi, object(result.diagnostics).personStated), limited,
  };
}

/** @type {Record<string, string>} */
const MEASURE_LABELS = Object.freeze({
  voi_evpi: "完全信息的价值（EVPI）", voi_probability_wrong_decision: "按现在的最优选择会选错的概率", voi_best_expected_utility: "最优选项的期望收益",
});

/**
 * The cards of the trial tab for the results of this kind the study holds now, newest first.
 * @param {Record<string, any>} bundle the trial tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentValueOfInformation(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "decision_voi" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  // no research-question rows: a value-of-information result simulates no trial endpoint (round-2 review P1-4)
  return results.map((result) => cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)))).filter(Boolean);
}
