/**
 * What the comparison page says of a dynamic borrowing of an external control arm (algorithm round C10, C11, C12, 2026-11-03): the result of a
 * `borrowing_prior` job (`comparator.borrowing`), and the premises its conclusion rests on.
 *
 * Hidden knowledge:
 *
 * - **The card opens with the question the person asked**, one of three by the kind of prior: 「外部每人只算 0.3 人时结论如何」 (a fixed
 *   discount), 「借用多少由数据决定时结果如何」 (the self-adapting mixture), 「数据冲突怎样换算成借用程度」 (the elastic function). The part the
 *   job did not ask for (the analysis of the current data, the table of conflict, the operating characteristics) is not on the card.
 * - **Every row has its two neighbours.** The control arm's posterior and the probability that the treatment is better are shown for no
 *   borrowing, for the prior asked about and for full borrowing, so the reader sees how far the borrowing moves the conclusion; the type I error
 *   and the power over drifts are shown with and without borrowing. A borrowing figure alone says nothing about what it bought.
 * - **The numbers are exact and say so**: every one is `calculated`, none is simulated, so none has a Monte-Carlo error.
 * - **A rate is shown as a percentage, a mean as itself**: the same engine measure has a rate-scaled name for a binary endpoint.
 * - **The function of an elastic prior is a premise with its values.** FDA's draft says a particular function may be hard to justify; the page
 *   puts the function, its two constants and the percentiles that placed it where the reader judges the conclusion, not in a footnote.
 *
 * @module vcrBorrowing
 */

import { list, numeric, object } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

const QUESTIONS = Object.freeze(/** @type {Record<string, string>} */ ({
  power: "外部对照每个人只按一部分算时，结论如何？",
  sam: "借用多少由数据决定时，结果如何？",
  elastic: "数据与历史冲突时，怎样换算成借用程度？",
}));
const KIND_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  power: "固定折扣（幂先验）", sam: "自适应混合先验（SAM）", elastic: "弹性先验",
}));

/** A number of the record in the words of its endpoint: a rate as a percentage, a mean as itself. @param {string} endpoint @param {string} name */
const cellName = (endpoint, name) => (endpoint === "binary" ? ({
  control_posterior_mean: "control_rate_mean", control_posterior_lower: "control_rate_lower", control_posterior_upper: "control_rate_upper", control_bias: "control_rate_bias",
}[name] ?? name) : name);

/** The size of a difference or a drift, in the unit of the endpoint. @param {string} endpoint @param {number} x */
const difference = (endpoint, x) => (endpoint === "binary" ? `${plain(x * 100)} 个百分点` : plain(x));

/**
 * @param {Record<string, any> | null | undefined} result
 * @param {(measure: Record<string, any>) => unknown} value measure -> the page's VcrValue
 */
export function presentBorrowing(result, value) {
  const diagnostics = object(object(result?.diagnostics).borrowing);
  if (!Object.keys(diagnostics).length) return null;
  const endpoint = String(diagnostics.endpoint);
  const kind = String(diagnostics.kind);
  const exact = (/** @type {string} */ name, /** @type {unknown} */ number) => (numeric(number) === null ? null : value({ name: cellName(endpoint, name), value: Number(number), simulated: false, source: "calculated" }));
  const cell = (/** @type {unknown} */ measure) => {
    const m = object(measure);
    return numeric(m.value) === null ? null : exact(String(m.name), m.value);
  };

  const labels = /** @type {Record<string, string>} */ ({ none: "不借用", chosen: KIND_WORDS[kind] ?? "所选先验", full: "全部借用（折扣 1）" });
  const posterior = list(object(diagnostics.posterior).rows).map(object).map((row) => ({
    label: labels[String(row.label)] ?? String(row.label),
    which: String(row.label),
    mean: cell(row.mean), lower: cell(row.lower), upper: cell(row.upper),
    probabilityBetter: cell(row.probabilityBetter),
    weight: cell(row.weight),
  }));

  const conflictRaw = object(diagnostics.conflict);
  const conflict = list(conflictRaw.rows).length ? {
    patients: numeric(conflictRaw.patients),
    delta: difference(endpoint, Number(conflictRaw.delta)),
    rows: list(conflictRaw.rows).map(object).map((row) => ({
      difference: Number(row.difference),
      differenceWords: Number(row.difference) === 0 ? "与历史一致" : `${Number(row.difference) > 0 ? "高出" : "低于"}历史 ${difference(endpoint, Math.abs(Number(row.difference)))}`,
      observed: numeric(row.observedValue),
      weight: cell(row.weight),
    })),
    note: kind === "sam"
      ? "数据与历史的差异越接近你设定的“不该再借的差异”，借用的权重越低；权重是当前对照组数据决定的，不是事先设的。"
      : "数据与历史的差异越大，借用程度越低；这条曲线是你设的函数，不是数据的结论。",
  } : null;

  const ocRaw = object(diagnostics.operatingCharacteristics);
  const oc = list(ocRaw.rows).length ? {
    nControl: numeric(ocRaw.nControl), nTreatment: numeric(ocRaw.nTreatment), effect: numeric(ocRaw.effect), alpha: numeric(ocRaw.alpha),
    rows: list(ocRaw.rows).map(object).map((row) => {
      const none = object(row.none); const chosen = object(row.chosen);
      return {
        drift: Number(row.drift), driftWords: Number(row.drift) === 0 ? "与历史一致" : `${Number(row.drift) > 0 ? "高出" : "低于"}历史 ${difference(endpoint, Math.abs(Number(row.drift)))}`,
        controlValue: numeric(row.controlValue),
        none: { typeOneError: cell(none.typeOneError), power: cell(none.power), bias: cell(none.bias) },
        chosen: { typeOneError: cell(chosen.typeOneError), power: cell(chosen.power), bias: cell(chosen.bias), weight: cell(chosen.weight) },
      };
    }),
    note: "I 类错误是对照组的真实水平偏离历史时，把无效的试验组判成更好的概率；这里的数是穷举所有可能的结果算出的，没有模拟误差。",
  } : null;

  const prior = object(diagnostics.prior);
  const elastic = object(diagnostics.elastic);
  return {
    question: QUESTIONS[kind] ?? "借用外部对照后，结论如何？",
    kind, kindWord: KIND_WORDS[kind] ?? kind, endpoint,
    weight: exact("borrowing_weight", prior.weight),
    borrowedSampleSize: exact("borrowed_sample_size", prior.borrowedSampleSize),
    posterior,
    conflict,
    operatingCharacteristics: oc,
    elastic: Object.keys(elastic).length ? { function: String(elastic.function), patients: numeric(elastic.patients) } : null,
    note: "试验组按无借用的均匀先验读；借用只加在对照组。",
  };
}

/**
 * The premises of a borrowing result: the kind of prior and what it was told, the clinical choice that places it, the elastic function with its
 * constants, and the history it borrows from. At most five are decisive.
 * @param {Record<string, any>} borrowing `diagnostics.borrowing`
 * @returns {Array<{ key: string, label: string, value: string, source: "assumed" | "literature" | "default" | "given", decisive: boolean }>}
 */
export function borrowingPremises(borrowing) {
  /** @type {Array<{ key: string, label: string, value: string, source: "assumed" | "literature" | "default" | "given", decisive: boolean }>} */
  const rows = [];
  const kind = String(borrowing.kind);
  const endpoint = String(borrowing.endpoint);
  const given = object(borrowing.given);
  const assumed = list(borrowing.assumed).map(object);
  const defaulted = (/** @type {string} */ key) => assumed.some((entry) => entry.key === key);
  const history = object(borrowing.historical);
  const n = numeric(history.n);
  rows.push({ key: "borrowingHistory", label: "借用的外部对照",
    value: endpoint === "binary"
      ? `一项历史对照：${n ?? "?"} 例中 ${numeric(history.x) ?? "?"} 例应答（${n && numeric(history.x) !== null ? plain(Number(history.x) / Number(n) * 100) : "?"}%）`
      : `一项历史对照：${n ?? "?"} 例，均值 ${plain(Number(history.mean))}，标准差 ${plain(Number(history.sd))}（按已知处理）`,
    source: "given", decisive: true });
  if (kind === "power") {
    const a0 = numeric(given.a0);
    rows.push({ key: "borrowingPrior", label: "借用的方式", value: `固定折扣：外部每人算 ${a0 === null ? "?" : plain(a0)} 人，不随当前数据改变`, source: "given", decisive: true });
  } else if (kind === "sam") {
    rows.push({ key: "borrowingPrior", label: "借用的方式", value: "自适应混合先验：当前对照组数据与历史越一致，借得越多", source: "given", decisive: true });
  } else if (kind === "elastic") {
    rows.push({ key: "borrowingPrior", label: "借用的方式", value: "弹性先验：当前数据与历史冲突越大，历史越不确定", source: "given", decisive: true });
  }
  const delta = numeric(given.delta);
  if (delta !== null) {
    rows.push({ key: "borrowingDelta", label: "不该再借的差异", value: `${difference(endpoint, delta)}：差到这么多就不借（临床上要说清的选择，不是数据的结论）`, source: "given", decisive: true });
  }
  const fn = object(borrowing.elastic);
  if (kind === "elastic" && Object.keys(fn).length) {
    const stepped = fn.function === "step";
    rows.push({ key: "borrowingFunction", label: "弹性函数",
      value: stepped
        ? `阶梯函数：一致性度量不超过 ${plain(Number(fn.tq0))} 时全借，超过则不借（q0 = ${plain(Number(fn.q0))}）`
        : `逻辑斯蒂函数 g(T) = 1 / (1 + exp(${plain(Number(fn.a))} + ${plain(Number(fn.b))}·ln T))：T 为 ${plain(Number(fn.tq0))} 时借 ${plain(Number(fn.c1) * 100)}%，T 为 ${plain(Number(fn.tq1))} 时借 ${plain(Number(fn.c2) * 100)}%（q0 = ${plain(Number(fn.q0))}，q1 = ${plain(Number(fn.q1))}）；函数的选择没有数据能证明，换一个函数结论会变`,
      source: defaulted("prior.q0") || defaulted("prior.q1") ? /** @type {const} */ ("default") : /** @type {const} */ ("assumed"), decisive: true });
  }
  // how much the history weighs against the patients of this study
  const current = numeric(given.nCurrent) ?? numeric(given.nControl);
  const borrowed = numeric(object(borrowing.prior).borrowedSampleSize);
  if (n !== null && current !== null) {
    rows.push({ key: "borrowingWeight", label: "外部对照与本研究对照组的分量",
      value: `外部 ${n} 例${borrowed !== null ? `，相当于借用 ${plain(borrowed)} 例` : ""}；本研究对照组${numeric(given.nCurrent) !== null ? "" : "（设计中）"} ${current} 例`,
      source: "given", decisive: true });
  }
  rows.push({ key: "borrowingTreatment", label: "试验组的先验", value: "不借用（均匀先验）", source: "default", decisive: false });
  return rows;
}
