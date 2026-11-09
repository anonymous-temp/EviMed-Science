/**
 * What the Alzheimer simulation's page says about where the drug effect came from (plan R29 to R31, 2026-11-09): the tier of the effect and the claim that
 * tier can carry, in the one block of premises the page already has.
 *
 * Hidden knowledge:
 *
 * - **The tier is named, and so is the limit of what it says.** A marketed inhibitor from the posterior itself (tier A) is what the data-fitted model predicts for
 *   that class of drug; a mechanism chain (tier B) is what follows if a published chain holds; an effect from earlier evidence (tier C) is what follows if that
 *   evidence transfers. None is a probability that the drug works, and no regulatory status transfers.
 * - **The numbers are the engine's.** Every figure here is read from the result's own diagnostics; nothing is computed on this page.
 * - **The three mismatches of the chain are one sentence each**, the decisive ones: the scale, the population and the link fitted on the trials it is checked against.
 *
 * @module vcrDrugOriginPremises
 */

import { list, numeric, object, text } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

const DRUG_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ donepezil: "多奈哌齐", galantamine: "加兰他敏", rivastigmine: "卡巴拉汀", aducanumab: "aducanumab", lecanemab: "lecanemab" }));
const TIER_NAMES = Object.freeze(/** @type {Record<string, string>} */ ({ A: "第一档：已上市药物的拟合", B: "第二档：机制链（探索性）", C: "第三档：已有证据", stated: "你自己的设定" }));

/**
 * @param {Record<string, any>} progression the result's `diagnostics.progression`
 * @returns {Array<Record<string, any>>} premise rows (`key`, `label`, `value`, `source`, `decisive`), for `finishPremises`
 */
export function drugOriginPremises(progression) {
  const treatment = object(progression.treatment);
  const reference = object(treatment.reference);
  const background = object(treatment.background);
  const mechanism = object(progression.mechanism);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  if (text(reference.drug)) {
    const drug = DRUG_WORDS[String(reference.drug)] ?? String(reference.drug);
    rows.push({ key: "progression:ad:tier", label: "药效的来源", decisive: true, source: "literature",
      value: `${TIER_NAMES.A}。治疗组用${drug}，每天 ${plain(Number(reference.doseMg))} mg（参考剂量 ${plain(Number(reference.referenceDoseMg))} mg 的 ${plain(Number(reference.doseRatio))} 倍），效果取自模型自己拟合出的该药参数，${progression.uncertainty === "posterior_draws" ? "每次试验用自己抽到的那一组后验参数（上面的数字是中位数）" : "取参数的中位数"}。这是数据拟合的模型对这类药的预测，不是对任何新药的预测` });
    rows.push({ key: "progression:ad:tier-dose", label: "剂量范围", decisive: false, source: "literature",
      value: "拟合所用试验的剂量范围在引擎携带的资料里没有公布，所以按同一条剂量关系套用到任何剂量" });
    rows.push({ key: "progression:ad:tier-check", label: "与综述的对照", decisive: false, source: "literature",
      value: "多奈哌齐 10 mg 在 26 周的效果落在 Cochrane 综述（Birks 和 Harvey，2018，−2.67 分，95% 区间 −3.31 至 −2.02）的区间内；这只是核对实现没有写错，不是独立验证，因为综述汇总的正是拟合这个模型所用的那一类试验" });
  }
  if (text(background.drug)) {
    rows.push({ key: "progression:ad:background", label: "两组共同的背景用药", decisive: false, source: "given",
      value: `两组都已在用${DRUG_WORDS[String(background.drug)] ?? String(background.drug)}（每天 ${plain(Number(background.doseMg))} mg，基线前 ${plain(Number(background.weeksBefore))} 周开始），所以两组的变化里只有基线之后它多起的作用` });
  }
  if (text(mechanism.drug)) {
    const drug = DRUG_WORDS[String(mechanism.drug)] ?? String(mechanism.drug);
    const share = object(mechanism.share);
    const clinical = object(object(mechanism.clinical).pointsAtWeek);
    const typical = object(mechanism.typical);
    const change = numeric(object(typical.suvrChange).value);
    const link = object(mechanism.link);
    rows.push({ key: "progression:ad:tier", label: "药效的来源", decisive: true, source: "literature",
      value: `${TIER_NAMES.B}。如果这条机制链成立：${drug}的剂量决定血药浓度，浓度决定淀粉样蛋白 PET 的 SUVR 下降（典型患者第 ${plain(Number(mechanism.atWeek))} 周约降 ${change === null ? "?" : plain(Math.abs(change))}），再按已发表的关联换成 ADAS-Cog 的差值（约 ${numeric(clinical.value) === null ? "?" : plain(Math.abs(Number(clinical.value)))} 分，换成疾病修饰比例的中位数约 ${numeric(share.median) === null ? "?" : plain(Number(share.median) * 100)}%）。这不是药物有效的结论，页面上的把握度是对这条链的不确定性取平均的结果` });
    rows.push({ key: "progression:ad:tier-scale", label: "链与模型不一致之一：量表", decisive: true, source: "literature",
      value: "关联的证据来自混合版本的 ADAS-Cog 和 CDR-SB，这里的模型是 ADAS-cog 11" });
    rows.push({ key: "progression:ad:tier-population", label: "链与模型不一致之二：人群", decisive: true, source: "literature",
      value: "关联主要来自早期阿尔茨海默病（MMSE 20–30），模型描述的是轻中度（MMSE 14–26）" });
    rows.push({ key: "progression:ad:tier-link", label: "链与模型不一致之三：关联", decisive: true, source: "literature",
      value: `关联（每降低 0.1 的 SUVR，ADAS-Cog 的恶化少 ${numeric(link.slope) === null ? "?" : plain(Number(link.slope))} 分，95% 区间 ${numeric(link.lower) === null ? "?" : plain(Number(link.lower))}–${numeric(link.upper) === null ? "?" : plain(Number(link.upper))}）是多项试验之间的关联，不是一个人身上的因果效应，并且拟合它的试验也是用来核对这条链的试验` });
  }
  // an effect stated as a distribution names its own tier (the researcher's, a pooling's, a model's)
  if (!text(reference.drug) && !text(mechanism.drug)) {
    for (const entry of list(progression.effectDistributions).map(object)) {
      const tier = String(entry.tier ?? "");
      const source = object(entry.source);
      if (tier === "C") {
        rows.push({ key: "progression:ad:tier", label: "药效的来源", decisive: true, source: source.kind === "model_result" ? "derived" : "literature",
          value: `${TIER_NAMES.C}。药效取自${text(source.note) ?? "已有证据"}，页面上的把握度是对它的不确定性取平均的结果；那项证据回答的“估计目标”未必就是这项研究要回答的那个（ICH E9(R1) A.4），这个效应是在“如果这份证据可以推到这项研究”的前提下用的` });
        break;
      }
    }
  }
  return rows;
}
