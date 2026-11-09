/**
 * What the patients page says of a drug given after a perpetrator of CYP3A4 (in-silico round 2, R38, 2026-11-09): the result of a `pk_interaction` job.
 *
 * The person asks what a drug's exposure becomes when another drug has induced the enzyme that clears it. The engine runs one published
 * whole-body PBPK model (Asaumi et al. 2018: midazolam, with CYP3A4 induction by repeated rifampicin in gut wall and liver) and returns the
 * concentration curve alone and after the perpetrator, the area and peak ratios and the enzyme activity at the dose. It is a result of its own kind,
 * filed under the regimen it was asked on, that the conversation computes (`vcr_simulate`, kind `pk_interaction`); this module turns the engine's
 * result into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The ratio is the model's typical value, not a prediction.** The model has no between-person variability, genotype or disease, so the card
 *   says "a typical healthy adult" in the premises, shows no interval and says the published clinical ratios scatter between studies; a number is
 *   never presented as what a patient will have.
 * - **The model's own range is a premise when a request leaves it.** The authors fitted rifampicin 5 to 600 mg and a few midazolam doses; a request
 *   outside those runs (the model has no other limit), and the engine names what is outside (`outsideFit`) so the page says it in plain words.
 * - **A perpetrator or victim the model does not carry never gets a card**: the schema refuses it by name before any engine job exists, so
 *   there is no result to word.
 * - **No back-office word reaches the card.** Drug names are the drugs' Chinese names; the model's citation is the paper's, the code is not named.
 *
 * @module vcrPbpk
 */

import { finishPremises, withQuestionPremisesAll } from "./vcrPremises.mjs";
import { vcrScenarioKey } from "./vcrScenarioKey.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a result is filed under (the result's `subject_id`): the regimen it was asked on. The same regimen asked again is the next version of one
 * result; another dose, another weight or another timing is another result.
 * @param {Record<string, any>} scenario
 */
export function vcrPbpkSubjectId(scenario) {
  return `pk:${vcrScenarioKey(scenario)}`;
}

/** @type {Record<string, string>} */
const DRUG_WORDS = Object.freeze({ midazolam: "咪达唑仑", rifampicin: "利福平" });
/** @param {unknown} name */
const drugWord = (name) => DRUG_WORDS[String(name)] ?? String(name);
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

const MEASURES = Object.freeze(["auc_ratio", "cmax_ratio", "victim_auc_alone", "victim_auc_with_perpetrator", "victim_cmax_alone", "victim_cmax_with_perpetrator", "cyp3a4_liver_activity", "cyp3a4_gut_activity"]);

/** The defaults the engine took, as labelled rows (a key the page cannot word is dropped). @type {Record<string, string>} */
const ASSUMED_LABELS = Object.freeze({
  "victim.route": "给药途径", weightKg: "体重", horizonH: "观察时长", "perpetrator.intervalH": "合用药物的给药间隔", "perpetrator.gapH": "最后一次合用药物到服药的间隔",
});
/** @param {string} key @param {unknown} value */
function assumedValue(key, value) {
  if (key === "victim.route") return value === "iv" ? "静脉" : "口服";
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return key === "weightKg" ? `${plain(number)} kg` : `${plain(number)} 小时`;
}

/** @type {Record<string, string>} */
const OUTSIDE_WORDS = Object.freeze({
  perpetrator_dose: "利福平的剂量超出了论文拟合过的范围（5 到 600 mg），超出的部分是模型的外推。",
  victim_dose: "咪达唑仑的剂量超出了论文拟合过的范围（口服 3 到 6 mg，静脉 1 mg 或每公斤体重 0.05 mg），超出的部分是模型的外推。",
});

/**
 * @param {Record<string, any>} pbpk the engine's `diagnostics.pbpk` @param {Record<string, any> | null} record
 */
function premisesOf(pbpk, record) {
  const given = object(pbpk.given);
  const victim = object(given.victim);
  const perpetrator = object(given.perpetrator);
  const model = object(pbpk.model);
  const iv = victim.route === "iv";
  const infusion = numeric(victim.infusionH);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  rows.push({ key: "pbpk_model", label: "用的是什么模型", source: "literature", decisive: true,
    value: "已发表的全身生理药代动力学模型（Asaumi 等，2018，CPT: Pharmacometrics & Systems Pharmacology）：利福平反复给药诱导肠壁和肝脏的 CYP3A4，咪达唑仑在同一套生理参数上被代谢；参数和方程取自作者公开的模型代码，没有改动" });
  rows.push({ key: "pbpk_person", label: "模拟的是谁", source: "default", decisive: true,
    value: `一个体重 ${plain(Number(given.weightKg))} kg 的典型健康成人：没有个体差异、基因型和疾病，所以这里的倍数是模型的典型值，不是某个患者会得到的值` });
  const doses = Number(perpetrator.doses);
  rows.push({ key: "pbpk_regimen", label: "给药方案", source: "given", decisive: true,
    value: `${drugWord(perpetrator.drug)} ${plain(Number(perpetrator.doseMg))} mg，每 ${plain(Number(perpetrator.intervalH))} 小时一次，共 ${doses} 次；${drugWord(victim.drug)}${iv ? (infusion ? `静脉滴注 ${plain(infusion)} 小时` : "静脉推注") : "口服"} ${plain(Number(victim.doseMg))} mg，在最后一次${drugWord(perpetrator.drug)}后 ${plain(Number(perpetrator.gapH))} 小时给药` });
  for (const key of list(model.outsideFit).map(String)) {
    if (OUTSIDE_WORDS[key]) rows.push({ key: `pbpk_outside_${key}`, label: "超出模型验证过的范围", source: "assumed", decisive: true, value: OUTSIDE_WORDS[key] });
  }
  rows.push({ key: "pbpk_clinical", label: "和临床研究比", source: "literature", decisive: false,
    value: "已发表的临床研究里，利福平合用后口服咪达唑仑的面积比彼此相差近八倍；模型给出的是它们之间的一个典型值，对诱导最强的几项研究偏高。论文本身没有给出合用后面积比的数值，只说拟合“吻合良好”" });
  rows.push({ key: "pbpk_scope", label: "模型里有什么、没有什么", source: "default", decisive: false,
    value: "只有利福平的诱导：肠壁和肝脏 CYP3A4 的合成按它在细胞里的游离浓度上升，降解速率不变；没有抑制剂，也没有其他诱导剂" });
  for (const row of list(pbpk.assumed).map(object)) {
    const key = String(row.key);
    const label = ASSUMED_LABELS[key];
    const value = label ? assumedValue(key, row.value) : null;
    if (label && value) rows.push({ key: `assumed_${key}`, label, value: `${value}（${String(row.basis)}）`, source: "default", decisive: false });
  }
  return finishPremises(rows, record);
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function cardOf(result, staleMark) {
  const pbpk = object(object(result.diagnostics).pbpk);
  const given = object(pbpk.given);
  const victim = object(given.victim);
  const perpetrator = object(given.perpetrator);
  const measures = new Map(list(result.measures).map(object).map((m) => [String(m.name), m]));
  const ratio = measures.get("auc_ratio");
  if (!ratio) return null;
  const show = (/** @type {any} */ measure) => measureValue(measure, { kind: "pk_interaction", result, tab: "patients", staleMark });
  const headline = MEASURES.filter((name) => measures.has(name)).map((name) => ({ key: name, label: headlineLabel(name), value: show(measures.get(name)) }));
  const auc = numeric(ratio.value);
  const cmax = numeric(measures.get("cmax_ratio")?.value);
  const liver = numeric(measures.get("cyp3a4_liver_activity")?.value);
  const gut = numeric(measures.get("cyp3a4_gut_activity")?.value);
  const word = drugWord(victim.drug);
  const way = auc === null ? null : auc < 1
    ? `合用后，${word}的曲线下面积降到单用时的 ${plain(auc * 100)}%${cmax === null ? "" : `，峰浓度降到 ${plain(cmax * 100)}%`}`
    : `合用后，${word}的曲线下面积是单用时的 ${plain(auc)} 倍${cmax === null ? "" : `，峰浓度是 ${plain(cmax)} 倍`}`;
  const lead = way === null ? null : `${way}。${liver === null || gut === null ? "" : `这是酶被诱导的结果：给药时肝脏 CYP3A4 活性是用药前的 ${plain(liver)} 倍，肠壁是 ${plain(gut)} 倍。`}这是模型对典型健康成人的值。`;
  const rows = list(pbpk.curve).map(object).map((row) => ({ hour: numeric(row.hour), alone: numeric(row.alone), withPerpetrator: numeric(row.withPerpetrator) }))
    .filter((row) => row.hour !== null && row.alone !== null && row.withPerpetrator !== null);
  const line = (/** @type {string} */ key, /** @type {string} */ label, /** @type {"alone" | "withPerpetrator"} */ which, ours = false) => ({
    key, label, source: "predicted", ours, points: rows.map((row) => ({ x: /** @type {number} */ (row.hour), y: /** @type {number} */ (row[which]) })),
  });
  const series = rows.length ? [line("alone", `单用${word}`, "alone"), line("with", `${drugWord(perpetrator.drug)}合用后`, "withPerpetrator", true)] : [];
  const concentration = (/** @type {number | null} */ value) => measureValue({ name: "victim_concentration", value, unit: "ng/mL", source: "calculated" }, { kind: "pk_interaction", result, tab: "patients", staleMark });
  const table = rows.map((row) => ({ key: String(row.hour), hour: /** @type {number} */ (row.hour), alone: concentration(row.alone), withPerpetrator: concentration(row.withPerpetrator) }));
  const limited = result.conclusion === "limited" ? "预算在算完之前用完了。" : null;
  return {
    id: String(result.id), version: Number(result.version), form: "pbpk_interaction",
    title: `${drugWord(perpetrator.drug)}合用后，${word}的暴露会怎样变化`,
    question: `先用${drugWord(perpetrator.drug)}，再给${word}，药物在体内的量会比单用时多还是少、多多少`,
    victim: drugWord(victim.drug), perpetrator: drugWord(perpetrator.drug), route: victim.route === "iv" ? "iv" : "oral",
    weightKg: numeric(given.weightKg), horizonH: numeric(given.horizonH),
    headline, lead, series, table,
    citation: "Asaumi 等，2018，CPT: Pharmacometrics & Systems Pharmacology 7(3):186-196",
    premises: premisesOf(pbpk, object(result.diagnostics).personStated), limited,
  };
}

/** @type {Record<string, string>} */
const HEADLINE_LABELS = Object.freeze({
  auc_ratio: "曲线下面积之比（合用 ÷ 单用）", cmax_ratio: "峰浓度之比（合用 ÷ 单用）",
  victim_auc_alone: "单用时的曲线下面积", victim_auc_with_perpetrator: "合用后的曲线下面积", victim_cmax_alone: "单用时的峰浓度", victim_cmax_with_perpetrator: "合用后的峰浓度",
  cyp3a4_liver_activity: "给药时肝脏 CYP3A4 活性（相对用药前）", cyp3a4_gut_activity: "给药时肠壁 CYP3A4 活性（相对用药前）",
});
/** @param {string} key */
const headlineLabel = (key) => HEADLINE_LABELS[key] ?? key;

/**
 * The cards of the patients tab for the results of this kind the study holds now, newest first.
 * @param {Record<string, any>} bundle the patients tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentPbpkInteractions(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "pk_interaction" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  const cards = results.map((result) => cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)))).filter(Boolean);
  return withQuestionPremisesAll(/** @type {any[]} */ (cards), bundle, results);
}
