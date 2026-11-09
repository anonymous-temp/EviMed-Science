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
const DRUG_WORDS = Object.freeze({ midazolam: "咪达唑仑", rifampicin: "利福平", ketoconazole: "酮康唑", clarithromycin: "克拉霉素" });
/** @param {unknown} name */
const drugWord = (name) => DRUG_WORDS[String(name)] ?? String(name);
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

const MEASURES = Object.freeze(["auc_ratio", "cmax_ratio", "victim_auc_alone", "victim_auc_with_perpetrator", "victim_cmax_alone", "victim_cmax_with_perpetrator", "cyp3a4_liver_activity", "cyp3a4_gut_activity"]);

/** The defaults the engine took, as labelled rows (a key the page cannot word is dropped). @type {Record<string, string>} */
const ASSUMED_LABELS = Object.freeze({
  "victim.route": "给药途径", weightKg: "体重", "perpetrator.inhibition": "抑制模型", "perpetrator.inactivationSet": "体外灭活常数", horizonH: "观察时长", "perpetrator.intervalH": "合用药物的给药间隔", "perpetrator.gapH": "最后一次合用药物到服药的间隔",
});
/** @param {string} key @param {unknown} value */
function assumedValue(key, value) {
  if (key === "victim.route") return value === "iv" ? "静脉" : "口服";
  if (key === "perpetrator.inhibition") return INHIBITION_WORDS[String(value)] ?? null;
  if (key === "perpetrator.inactivationSet") return INACTIVATION_WORDS[String(value)] ?? null;
  if (key === "weightKg" && value === "not used") return "没有用到";
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return key === "weightKg" ? `${plain(number)} kg` : `${plain(number)} 小时`;
}

/** The three inhibition models of the ketoconazole paper, in plain words. @type {Record<string, string>} */
const INHIBITION_WORDS = Object.freeze({ competitive: "竞争性抑制", noncompetitive: "非竞争性抑制", mixed: "混合抑制" });

/** The three in-vitro constant sets of the clarithromycin inactivation, in plain words. @type {Record<string, string>} */
const INACTIVATION_WORDS = Object.freeze({
  polasek_hlm: "人肝微粒体常数（Polasek 与 Miners 2006：半数灭活浓度 29.5 μmol/L，最大灭活速率 3.0 /小时），三组体外数据的中位组",
  mayhew_hlm: "人肝微粒体常数（Mayhew 2000：5.49 μmol/L，4.32 /小时）",
  ito_hlm: "人肝微粒体常数（Ito 2003：取区间中点，39.2 μmol/L，2.65 /小时）",
});

/** @type {Record<string, string>} */
const OUTSIDE_WORDS = Object.freeze({
  perpetrator_dose: "利福平的剂量超出了论文拟合过的范围（5 到 600 mg），超出的部分是模型的外推。",
  victim_dose: "咪达唑仑的剂量超出了论文拟合过的范围（口服 3 到 6 mg，静脉 1 mg 或每公斤体重 0.05 mg），超出的部分是模型的外推。",
});
/** What is outside the doses the clarithromycin assembly was compared with (250 and 500 mg twice daily). @type {Record<string, string>} */
const OUTSIDE_WORDS_MBI = Object.freeze({
  perpetrator_dose: "只拿每天两次 250 mg 和 500 mg 的克拉霉素和临床研究比较过这个拼合模型，别的剂量是模型的外推。",
});
/** What is outside the ketoconazole paper's own validation (its Table 4: 200 mg daily for six days, intravenous midazolam 1 mg). @type {Record<string, string>} */
const OUTSIDE_WORDS_INHIBITOR = Object.freeze({
  perpetrator_dose: "论文只用每天 200 mg 的酮康唑验证过这个模型，别的剂量是模型的外推。",
  victim_route: "论文只用静脉给药的咪达唑仑验证过这个模型；口服是模型的外推（口服的肠壁代谢也被抑制，论文没有拿口服数据核对过）。",
  victim_dose: "论文只用 1 mg 静脉咪达唑仑验证过这个模型，别的剂量是模型的外推。",
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
  const inhibitor = perpetrator.drug === "ketoconazole";
  const assembled = perpetrator.drug === "clarithromycin";
  const infusion = numeric(victim.infusionH);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  rows.push({ key: "pbpk_model", label: "用的是什么模型", source: "literature", decisive: true,
    value: assembled
      ? "咪达唑仑用的是已发表的生理药代动力学模型（Chien 等 2006，参数取自 Quinney 等 2013 的补充材料）；克拉霉素是把几处已发表的数值拼在一起的，不是一个已发表的完整模型：结构和药代参数取自 Quinney 等 2010 的表 1，不可逆灭活 CYP3A 的常数取自同一篇论文表 2 的体外数据；论文自己拟合临床结果得到的常数没有用，也没有为了贴近临床结果调过任何一个数"
      : inhibitor
      ? "已发表的生理药代动力学模型（Quinney 等，2013，CPT: Pharmacometrics & Systems Pharmacology，基于 Chien 等 2006）：酮康唑可逆地抑制肠壁和肝脏的 CYP3A4，咪达唑仑经肠壁、门静脉和肝脏代谢；方程和参数取自论文的补充材料，抑制常数取自论文表 3，没有为了贴近临床结果调过任何一个数"
      : "已发表的全身生理药代动力学模型（Asaumi 等，2018，CPT: Pharmacometrics & Systems Pharmacology）：利福平反复给药诱导肠壁和肝脏的 CYP3A4，咪达唑仑在同一套生理参数上被代谢；参数和方程取自作者公开的模型代码，没有改动" });
  rows.push({ key: "pbpk_person", label: "模拟的是谁", source: "default", decisive: true,
    value: `${inhibitor || assembled ? "一个典型的健康成人（这个模型的体积和血流量是固定的，体重不是输入）" : `一个体重 ${plain(Number(given.weightKg))} kg 的典型健康成人`}：没有个体差异、基因型和疾病，所以这里的倍数是模型的典型值，不是某个患者会得到的值` });
  const doses = Number(perpetrator.doses);
  rows.push({ key: "pbpk_regimen", label: "给药方案", source: "given", decisive: true,
    value: `${drugWord(perpetrator.drug)} ${plain(Number(perpetrator.doseMg))} mg，每 ${plain(Number(perpetrator.intervalH))} 小时一次，共 ${doses} 次；${drugWord(victim.drug)}${iv ? (infusion ? `静脉滴注 ${plain(infusion)} 小时` : "静脉推注") : "口服"} ${plain(Number(victim.doseMg))} mg，在最后一次${drugWord(perpetrator.drug)}后 ${plain(Number(perpetrator.gapH))} 小时给药` });
  const outsideWords = assembled ? OUTSIDE_WORDS_MBI : inhibitor ? OUTSIDE_WORDS_INHIBITOR : OUTSIDE_WORDS;
  for (const key of list(model.outsideFit).map(String)) {
    if (outsideWords[key]) rows.push({ key: `pbpk_outside_${key}`, label: "超出模型验证过的范围", source: "assumed", decisive: true, value: outsideWords[key] });
  }
  if (assembled) {
    const kind = String(perpetrator.inactivationSet ?? "polasek_hlm");
    rows.push({ key: "pbpk_inactivation", label: "用的是哪一组灭活常数", source: "literature", decisive: true,
      value: `${INACTIVATION_WORDS[kind] ?? kind}。三组体外常数的半数灭活浓度相差五倍，对口服咪达唑仑 4 mg、克拉霉素每天两次 500 mg 共一周，三组预测的面积比大约是 3.5、4.6、11.5 倍，临床观察是 7 倍；临床数据没有选出哪一组更对，所以这里的倍数取决于常数的选择` });
    const mine = object(pbpk.perpetrator);
    const c = numeric(mine.cmaxUgL); const seen = numeric(mine.observedCmaxUgL); const a = numeric(mine.aucTauUgHL); const seenA = numeric(mine.observedAucTauUgHL);
    if (c !== null && seen !== null && a !== null && seenA !== null) {
      rows.push({ key: "pbpk_perpetrator_exposure", label: "克拉霉素自己的血药浓度", source: "literature", decisive: c / seen > 2 || seen / c > 2 || a / seenA > 2 || seenA / a > 2,
        value: `按这个方案模型算出克拉霉素稳态峰浓度 ${plain(c / 1000)} mg/L、给药间隔内面积 ${plain(a / 1000)} mg·h/L，健康受试者的实测是 ${plain(seen / 1000)} mg/L 和 ${plain(seenA / 1000)} mg·h/L；模型里克拉霉素把清除它的酶灭活得太多，所以它自己的浓度偏高，咪达唑仑的倍数里有两个方向相反的误差，不能把它读成对模型的验证` });
    }
  }
  if (inhibitor) {
    const kind = String(perpetrator.inhibition ?? "mixed");
    rows.push({ key: "pbpk_inhibition", label: "用的是哪一种抑制模型", source: "literature", decisive: true,
      value: `${INHIBITION_WORDS[kind] ?? kind}。论文用同一组体外数据给出三种抑制常数，对静脉咪达唑仑 1 mg、酮康唑每天 200 mg 共六天，三种模型预测的面积比分别是 4.5（竞争性）、2.0（非竞争性）、2.5（混合），临床观察值是 3.1；这三个数是三个模型的预测，不是同一个数的三个把握程度` });
  }
  rows.push({ key: "pbpk_clinical", label: "和临床研究比", source: "literature", decisive: false,
    value: assembled
      ? "已发表的临床研究里，克拉霉素合用后咪达唑仑的面积比：静脉约 2.1 到 2.7 倍，口服约 3.6 到 8.6 倍。模型不加调整地预测，六项比较都在两倍以内，几何平均倍数误差 1.4，口服偏低、静脉略高；用另外两组体外常数时分别偏高很多（11.5 倍）或偏低（3.5 倍）"
      : inhibitor
      ? "已发表的临床研究里，酮康唑合用后咪达唑仑的面积比：静脉约 2.7 到 4.7 倍，口服约 11 到 20 倍。模型不加调整地预测，六项比较都在两倍以内，几何平均倍数误差 1.4；对静脉 400 mg 偏高、对口服 200 mg 偏低，口服比静脉更不可靠"
      : "已发表的临床研究里，利福平合用后口服咪达唑仑的面积比彼此相差近八倍；模型给出的是它们之间的一个典型值，对诱导最强的几项研究偏高。论文本身没有给出合用后面积比的数值，只说拟合“吻合良好”" });
  rows.push({ key: "pbpk_scope", label: "模型里有什么、没有什么", source: "default", decisive: false,
    value: assembled
      ? "只有克拉霉素对 CYP3A 的不可逆灭活（肠壁和肝脏，酶按 28 小时的周转更新）和很弱的可逆抑制：没有 14-羟基代谢物，没有转运体的作用，克拉霉素的吸收分数按 1 计；红霉素、伊曲康唑等其他抑制剂没有可以完整读出来的公开参数，所以不在里面"
      : inhibitor
      ? "只有酮康唑对 CYP3A4 的可逆抑制（肠壁和肝脏）：没有时间依赖性抑制，没有诱导，没有酮康唑的代谢产物，也没有它对转运体的作用；伊曲康唑、红霉素等其他抑制剂没有可以完整读出来的公开模型，所以不在里面"
      : "只有利福平的诱导：肠壁和肝脏 CYP3A4 的合成按它在细胞里的游离浓度上升，降解速率不变；没有抑制剂，也没有其他诱导剂" });
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
  const mechanism = perpetrator.drug === "clarithromycin"
    ? (liver === null || gut === null ? "" : `这是酶被不可逆灭活的结果：给药时肝脏 CYP3A4 活性剩下用药前的 ${plain(liver * 100)}%，肠壁剩下 ${plain(gut * 100)}%。`)
    : (liver === null || gut === null ? "" : `这是酶被诱导的结果：给药时肝脏 CYP3A4 活性是用药前的 ${plain(liver)} 倍，肠壁是 ${plain(gut)} 倍。`);
  const lead = way === null ? null : `${way}。${mechanism}这是模型对典型健康成人的值。`;
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
    citation: perpetrator.drug === "clarithromycin" ? "咪达唑仑：Chien 等 2006 / Quinney 等 2013；克拉霉素：Quinney 等 2010（Drug Metab Dispos 38:241），由已发表的数值拼合，不是已发表的完整模型" : perpetrator.drug === "ketoconazole" ? "Quinney 等，2013，CPT: Pharmacometrics & Systems Pharmacology 2:e75" : "Asaumi 等，2018，CPT: Pharmacometrics & Systems Pharmacology 7(3):186-196",
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
