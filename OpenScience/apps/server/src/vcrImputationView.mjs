/**
 * What the comparison page says of missing covariates that were imputed (algorithm round C7, 2026-11-03): the answer read over the
 * completed tables, the complete-case answer beside it, and what the imputation assumed.
 *
 * The engine writes the numbers (`diagnostics.imputation`: the pooled rows with Rubin's variances, the complete-case estimates, the
 * covariates and how each was imputed, the bootstrap budget, what stopped it); this is the only place that words them.
 *
 * Hidden knowledge:
 *
 * - **The card opens with the question a person asked**: "补齐缺失值之后结论还是这样吗". The two columns are the pooled answer and the answer
 *   from the people with no missing covariate; whether they agree is a statement of code over the two intervals and the null value (0 for
 *   a difference, 1 for a ratio), never of a model.
 * - **The assumption is on the card, not in a footer**: missing at random given the other covariates, the arm and the outcome. It is
 *   also a premise of the result (`vcrPremises`).
 * - **Every number is a `VcrValue`**: the imputed ones are the result's own measures; a complete-case number is made into a measure-shaped
 *   record so that it prints through the same path (the unit, the interval, the source word).
 *
 * @module vcrImputationView
 */

import { list, measureLabel, numeric, object } from "./vcrViewsKit.mjs";

/** How each covariate was imputed, in words. */
const METHOD_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  pmm: "数值：取与它预测值最接近的几个人的实际值（预测均值匹配）",
  logreg: "0/1：按逻辑回归抽样",
  polyreg: "多分类：按多项逻辑回归抽样",
  constant: "全体已知的人只有一个取值，照用这个值",
}));

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} value */
const percent = (value) => `${plain(value * 100, 3)}%`;

/** Where the line of no effect is for a measure: 1 for a ratio, 0 for a difference. @param {string} name */
const nullOf = (name) => (/ratio$/.test(name) || name === "hazard_ratio" ? 1 : 0);

/**
 * Do two intervals say the same about the line of no effect: both leave it on the same side, or both hold it.
 * @param {{ low: number, high: number } | null} a @param {{ low: number, high: number } | null} b @param {number} at
 * @returns {'same' | 'different' | null}
 */
function agreement(a, b, at) {
  if (!a || !b) return null;
  const side = (/** @type {{ low: number, high: number }} */ x) => (x.low > at ? 1 : x.high < at ? -1 : 0);
  return side(a) === side(b) ? "same" : "different";
}

/**
 * @param {Record<string, any> | null} result the result the page shows
 * @param {(measure: any) => any} value the page's `VcrValue` maker for a measure of that result
 * @returns {Record<string, any> | null}
 */
export function presentImputation(result, value) {
  const diagnostics = object(object(result).diagnostics);
  const imputation = object(diagnostics.imputation);
  if (!Object.keys(imputation).length) return null;
  const question = "有缺失值的协变量，补齐之后结论还是这样吗？";
  if (imputation.performed !== true) {
    return imputation.reason === "no_missing_covariate"
      ? { question, sentence: "被分析的人里没有协变量缺失，所以没有做插补，分析照常进行。", assumption: null, covariates: [], rows: [], completeCase: null, budget: null, stopped: null, few: null }
      : null;
  }
  const completed = numeric(imputation.completed) ?? 0;
  const requested = numeric(imputation.requested) ?? completed;
  const share = numeric(imputation.shareIncomplete);
  const incomplete = numeric(imputation.rowsIncomplete) ?? 0;
  const analysed = numeric(imputation.rowsAnalysed) ?? 0;
  const measures = list(object(result).measures).map(object);
  const completeCase = object(imputation.completeCase);
  const ccRows = new Map(list(completeCase.estimates).map(object).map((row) => [String(row.name), row]));
  const rows = list(imputation.pooled).map(object).flatMap((row) => {
    const name = String(row.name ?? "");
    const measure = measures.find((entry) => entry.name === name);
    if (!measure) return [];
    const imputed = object(row.imputed);
    const cc = ccRows.get(name);
    const ccMeasure = cc ? { name, value: cc.estimate, simulated: false, source: "calculated", unit: measure.unit,
      interval: { kind: "confidence", low: cc.lower, high: cc.upper, level: 0.95 } } : null;
    const low = numeric(imputed.lower);
    const high = numeric(imputed.upper);
    const ccLow = cc ? numeric(cc.lower) : null;
    const ccHigh = cc ? numeric(cc.upper) : null;
    const verdict = agreement(low !== null && high !== null ? { low, high } : null, ccLow !== null && ccHigh !== null ? { low: ccLow, high: ccHigh } : null, nullOf(name));
    const fmi = numeric(row.fractionMissingInformation);
    return [{
      key: name, label: measureLabel(name), imputed: value(measure), completeCase: ccMeasure ? value(ccMeasure) : null,
      agreement: verdict,
      loss: fmi === null ? null : `缺失造成的信息损失约 ${percent(Math.min(1, Math.max(0, fmi)))}`,
    }];
  });
  const suggested = share === null ? null : Math.ceil(share * 100);
  const few = suggested !== null && requested < suggested
    ? `补齐的份数（${requested}）少于有缺失的人所占的百分比（${suggested}），份数偏少，合并后的区间可能不稳；可以加到 ${suggested} 份以上。` : null;
  const bootstrap = object(imputation.bootstrap);
  const stoppedBy = imputation.stoppedBy ? String(imputation.stoppedBy) : null;
  return {
    question,
    sentence: `${analysed} 人里有 ${incomplete} 人（${share === null ? "—" : percent(share)}）至少缺一个协变量。只用完整病例会把他们丢掉；这里把缺失值补齐 ${completed} 次，每次在补齐的数据上重做同样的分析，再按 Rubin 规则合并，旁边是只用完整病例的结果。`,
    assumption: "前提是缺失与否只取决于已经看到的协变量、治疗分组和结局（随机缺失）；如果缺失本身与没有看到的值有关，补齐的结果仍会有偏。",
    covariates: list(imputation.covariates).map(object).map((entry) => ({
      name: String(entry.name ?? ""), missing: numeric(entry.missing) ?? 0, share: numeric(entry.share) === null ? "—" : percent(Number(entry.share)),
      method: METHOD_WORDS[String(entry.method)] ?? "",
    })),
    rows,
    completeCase: completeCase.available === true || numeric(completeCase.rows) !== null
      ? { rows: numeric(completeCase.rows) ?? 0, dropped: numeric(completeCase.droppedRows) ?? 0,
          sentence: completeCase.available === true
            ? `只用完整病例：剩 ${numeric(completeCase.rows) ?? 0} 人，去掉 ${numeric(completeCase.droppedRows) ?? 0} 人。`
            : `只用完整病例（${numeric(completeCase.rows) ?? 0} 人）算不出结果，补齐之后才有结果。` }
      : null,
    budget: numeric(bootstrap.perRun) === null ? null
      : `区间按 Rubin 规则从每份补齐数据的自助法标准误合并而来；自助法的重抽样次数由 ${numeric(bootstrap.runs) ?? completed + 1} 次计算分摊（每次 ${numeric(bootstrap.perRun)} 次），补齐的份数多不会让计算变慢。`,
    stopped: stoppedBy
      ? `计算时间用完了：只用了 ${completed} 份（计划 ${requested} 份）合并，区间比计划的粗。`
      : null,
    few,
    note: "平衡表、权重和生存曲线取自第一份补齐的数据。",
  };
}

/**
 * The premise a result that imputed rests on: how much was missing, how many times it was filled, and the assumption about why.
 * @param {Record<string, any> | null | undefined} diagnostics the result's diagnostics
 * @returns {{ key: string, label: string, value: string, source: 'assumed', decisive: boolean } | null}
 */
export function imputationPremise(diagnostics) {
  const imputation = object(object(diagnostics).imputation);
  if (imputation.performed !== true) return null;
  const share = numeric(imputation.shareIncomplete);
  return { key: "missingAtRandom", label: "缺失的协变量", decisive: true, source: "assumed",
    value: `${share === null ? "" : `${percent(share)} 的人至少缺一个协变量；`}补齐 ${numeric(imputation.completed) ?? 0} 次；假定缺失只取决于已看到的协变量、分组和结局（随机缺失）` };
}
