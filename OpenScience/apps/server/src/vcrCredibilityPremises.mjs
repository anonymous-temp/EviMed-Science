/**
 * What an Alzheimer result page says about how far the model can be trusted for this use (plan R27, R28; ICH M15 Step 5 sections 2.1 and 3): the credibility
 * record of `@evimed/domain` in the one block of premises the page already has.
 *
 * Hidden knowledge:
 *
 * - **Computed where it is computable, said where it is not.** The validation sentence's numbers are the domain's copy of the committed external validation
 *   (made from the result file by a script, never typed here); the applicability checks compare this run's MMSE range and last visit with what that validation
 *   covered; the verification row is what the result itself records. The person's own judgement of the model's influence on their decision and of the
 *   consequence of a wrong one is not guessed: with neither stated, no risk level is shown, and the row folded says so.
 * - **Only placebo arms were validated.** The sentence says so in its own words, so a drug effect on the page is never read as covered by it.
 * - **The second structure is a spread, not an average.** Nothing is weighted: no weights are validated.
 * - **Three to five decisive rows**: the validation sentence, and the applicability row only when a check falls outside; the rest are folded.
 *
 * @module vcrCredibilityPremises
 */

import { VCR_MODEL_RISK_RULE_LABELS_ZH, VCR_RATING_LABELS_ZH, vcrCredibilityRecord } from "@evimed/domain";
import { list, numeric, object } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} value */
const signed = (value) => (value > 0 ? `+${plain(value)}` : value < 0 ? `−${plain(Math.abs(value))}` : "0");
/** @param {any} horizon */
const horizonWords = (horizon) => `${String(horizon.weeks).replace(" to ", "–")} 周`;

/**
 * @param {Record<string, any>} progression the result's `diagnostics.progression`
 * @param {Record<string, any> | null} [assessment] the study's stored assessment of the model this result runs on (`assessmentForModel`), if it has one
 * @returns {Array<Record<string, any>>} premise rows (`key`, `label`, `value`, `source`, `decisive`), for `finishPremises`
 */
export function credibilityPremises(progression, assessment = null) {
  const population = object(progression.population);
  const extrapolation = object(progression.extrapolation);
  const treatment = object(progression.treatment);
  const mmse = list(population.mmseRange).map(Number);
  const hasDrugEffect = Math.abs(numeric(treatment.symptomaticLogitEmax) ?? 0) > 0 || (numeric(treatment.diseaseModifyingFraction) ?? 0) > 0
    || Boolean(object(treatment.reference).drug) || list(progression.effectDistributions).length > 0;
  const record = vcrCredibilityRecord({
    population: { mmseRange: mmse.length === 2 ? mmse : undefined }, lastVisitWeeks: numeric(extrapolation.lastVisit) ?? undefined,
    reproduced: list(object(progression.reproduction).reproduced), replicates: numeric(progression.trials) ?? undefined, hasDrugEffect,
    ...(assessment ? { assessment } : {}),
  });
  const field = (/** @type {string} */ name) => record.items.find((item) => item.field === name);
  const validation = object(field("validation")?.data);
  const long = object(validation.long); const short = object(validation.short);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  rows.push({
    key: "credibility:validation", label: "在晚于模型拟合的试验上的检验", decisive: true, source: "literature",
    value: `在 ${validation.arms} 项发表时间晚于模型拟合的试验的安慰剂组上，预测的 ${horizonWords(long)}变化平均偏差 ${signed(Number(long.meanBias))} 分（正数是预测比观察到的多恶化；平均绝对偏差 ${plain(Number(long.meanAbsoluteBias))} 分，预测区间包住了 ${long.covered}/${long.arms} 项），${horizonWords(short)}变化平均偏差 ${signed(Number(short.meanBias))} 分（${short.covered}/${short.arms} 项）。只检验了安慰剂组，没有检验任何药物的效果`,
  });
  // what the committed validation does not establish: the trials were published after the fit, and nobody checked that none of their arms is in the
  // data the model was fitted on (RUN-20261109 and its protocol claim no more)
  rows.push({ key: "credibility:validation-scope", label: "这些试验和拟合数据的关系", decisive: false, source: "literature",
    value: "这些试验都发表在拟合这个模型的数据之后；没有核实其中有没有哪一项已经在拟合所用的数据库里，所以只能说它们晚于模型，不能说模型从没见过它们。" });
  const second = object(validation.secondStructure);
  if (numeric(second.long) !== null && numeric(second.short) !== null) {
    rows.push({
      key: "credibility:structure", label: "换一种已发表的模型形式", decisive: false, source: "literature",
      value: `另一种已发表的模型形式（Conrado 等，2014；用同一个 CAMD 数据库，形式不同）预测的平均变化与这里相差 ${plain(Number(second.long))} 分（${horizonWords(long)}）和 ${plain(Number(second.short))} 分（${horizonWords(short)}）；两者没有取平均，因为没有经过验证的权重`,
    });
  }
  const checks = record.applicability;
  if (checks.length) {
    const out = checks.filter((check) => !check.inside);
    const words = (/** @type {{ check: string, inside: boolean, value: any, range: any }} */ c) => c.check === "mmse_range"
      ? `基线 MMSE ${plain(c.value[0])}–${plain(c.value[1])} 分${c.inside ? "在" : "超出了"}验证过的 ${plain(c.range[0])}–${plain(c.range[1])} 分内`
      : c.check === "horizon_weeks" ? `最后一次随访在第 ${plain(c.value)} 周，${c.inside ? "没有超过" : "超过了"}验证过的最长 ${plain(c.range[1])} 周`
        : "药物效果没有被这些检验覆盖（它们只看安慰剂组）";
    rows.push({
      key: "credibility:applicability", label: "这次的人群和时间落在检验过的范围里吗", decisive: out.length > 0 && out.some((c) => c.check !== "drug_effect_validated"), source: "default",
      value: checks.map(words).join("；"),
    });
  }
  // the tables the implementation reproduces are one folded row of the card itself (复现情况); the replicate count is its header and the simulation-error row
  // says what more replicates change, so neither is said a third time here
  const risk = field("model_risk");
  const level = String(risk?.data.level ?? "");
  if (risk?.basis === "computed" && level in VCR_RATING_LABELS_ZH) {
    const rating = (/** @type {string} */ name) => String(object(field(name)?.data).level ?? "");
    const word = (/** @type {string} */ value) => (/** @type {Record<string, string>} */ (VCR_RATING_LABELS_ZH))[value] ?? value;
    const rule = (/** @type {Record<string, string>} */ (VCR_MODEL_RISK_RULE_LABELS_ZH))[String(risk.data.rule)] ?? "";
    rows.push({
      key: "credibility:risk", label: "模型对决定的影响和出错的后果", decisive: risk.decisive, source: "assumed",
      value: `按研究里记下的评估：模型对决定的影响${rating("model_influence") ? word(rating("model_influence")) : "未评"}，决定出错的后果${rating("decision_consequence") ? word(rating("decision_consequence")) : "未评"}，模型风险${word(level)}。${rule}`,
    });
  } else {
    rows.push({
      key: "credibility:risk", label: "模型对决定的影响和出错的后果", decisive: false, source: "default",
      value: "模型在你的决定里占多大分量、决定出错的后果有多严重，要由你来判断；研究里没有记下评估时，这里不给模型风险等级",
    });
  }
  return rows;
}
