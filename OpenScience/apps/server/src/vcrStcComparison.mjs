/**
 * What the comparison page says of a simulated treatment comparison (algorithm round C2, review RF2 P1-2): the result of a `stc_comparator` job
 * (`comparator.stc`, the G-computation form), on the comparator tab beside the other cards of a comparison.
 *
 * The engine writes the numbers (the indirect estimate with its interval, the marginal and the conditional effect of the person's own trial, the
 * aggregate figure the other trial gave, who of the other trial's population lies outside the data); this is the only place that words them.
 *
 * Hidden knowledge:
 *
 * - **The card says what the number is a difference of.** An anchored comparison subtracts the other trial's effect against the common comparator
 *   from the person's own effect against it, in the other trial's population; an unanchored one compares two outcome levels and is a benchmark,
 *   not an effect. The first sentence is the question, the second where the estimate holds (the other trial's population, which only has
 *   summary figures).
 * - **A link-scale number is named for its scale.** A logit-link contrast is a log odds ratio, a log-link one a log risk ratio; the ratio form
 *   (the exponential, a deterministic transform in code) stands beside it for those two, with its own interval. An identity link is a difference.
 * - **The conditional effect is not the marginal one.** On a non-collapsible link they are different numbers, and only the marginal one can be
 *   subtracted from the other trial's summary effect; the conditional effect is shown beside it, set apart, because the usual regression gives it.
 * - **Extrapolation is said once, as a sentence**: the share of the other trial's population that lies outside the range of the person's own data,
 *   for the covariate with the largest share, when there is one.
 *
 * @module vcrStcComparison
 */

import { list, numeric, object } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/** The scale a link-scale number is on, in words, and the name of its ratio form. */
const LINKS = Object.freeze(/** @type {Record<string, { scale: string, ratio: string | null }>} */ ({
  logit: { scale: "对数比值比（log OR）", ratio: "比值比（OR）" },
  log: { scale: "对数相对危险度（log RR）", ratio: "相对危险度（RR）" },
  identity: { scale: "差值（结局原来的单位）", ratio: null },
}));

/**
 * @param {Record<string, any> | null | undefined} result the result the page shows
 * @param {(measure: Record<string, any>) => any} value the page's `VcrValue` maker for a measure of that result
 * @returns {Record<string, any> | null}
 */
export function presentStcComparison(result, value) {
  const diagnostics = object(object(result).diagnostics);
  if (diagnostics.method !== "g_computation") return null;
  const measures = list(object(result).measures).map(object);
  const find = (/** @type {string} */ name) => measures.find((entry) => entry.name === name && numeric(entry.value) !== null);
  const indirect = find("indirect_estimate");
  if (!indirect) return null;
  const anchored = diagnostics.anchored === true;
  const link = LINKS[String(diagnostics.link)] ? String(diagnostics.link) : "identity";
  const words = LINKS[link];
  const aggregate = object(diagnostics.aggregate);
  const marginal = object(diagnostics.marginal);
  /** @param {string} name @param {unknown} number @param {string} source */
  const exact = (name, number, source = "calculated") => (numeric(number) === null ? null : value({ name, value: Number(number), simulated: false, source }));

  const rows = [];
  if (anchored) {
    const own = find("marginal_contrast_ipd");
    if (own) rows.push({ key: "marginal", label: "我们的治疗相对共同对照的效应，放到对方人群上（边际）", value: value(own), note: null });
    if (numeric(aggregate.linkScaleEstimate) !== null) {
      rows.push({ key: "aggregate", label: "对方的治疗相对共同对照的效应（你给的汇总数）", value: exact("stc_aggregate_effect", aggregate.linkScaleEstimate, "aggregate"), note: null });
    }
    const conditional = find("conditional_contrast_ipd");
    if (conditional) {
      rows.push({ key: "conditional", label: "常规回归给出的条件效应", value: value(conditional),
        note: link === "identity" ? "在线性模型里它和边际效应相同。" : "它不是边际效应，不能直接和对方的汇总数相减；这里只是摆在旁边，以便和常规做法对照。" });
    }
  } else {
    const level = numeric(marginal.active);
    if (level !== null) {
      rows.push({ key: "expected", label: "我们的治疗放到对方人群上的预期结局",
        value: exact(link === "logit" ? "stc_expected_probability" : "stc_expected_mean", level), note: null });
    }
    if (numeric(aggregate.estimate) !== null) {
      rows.push({ key: "aggregate", label: "对方试验那一组的结局（你给的汇总数）", value: exact(link === "logit" ? "stc_aggregate_probability" : "stc_aggregate_mean", aggregate.estimate, "aggregate"), note: null });
    }
  }
  const interval = object(indirect.interval);
  const ratio = words.ratio && numeric(interval.low) !== null && numeric(interval.high) !== null
    ? value({ name: "indirect_estimate_ratio", value: Math.exp(Number(indirect.value)), simulated: false, source: "calculated",
      interval: { kind: "confidence", low: Math.exp(Number(interval.low)), high: Math.exp(Number(interval.high)), level: numeric(interval.level) ?? 0.95 } })
    : null;

  const outside = Object.entries(object(object(diagnostics.extrapolation).shareOutsideIpdRange))
    .map(([covariate, share]) => ({ covariate, share: numeric(share) })).filter((entry) => entry.share !== null && entry.share > 0)
    .sort((a, b) => Number(b.share) - Number(a.share))[0];
  return {
    question: anchored ? "放到对方试验的人群上，我们的治疗和对方的治疗相比，差多少？" : "放到对方试验的人群上，我们的治疗的预期结局，和对方那一组差多少？",
    sentence: anchored
      ? "把我们的试验数据放到对方试验的人群上，算出我们的治疗相对共同对照的效应，再减去对方的治疗相对共同对照的效应；这个估计针对的是对方试验的人群，那个人群只有汇总数。"
      : "没有共同对照把两个试验连起来，这里比的是两个结局水平，不是治疗效应；这个估计针对的是对方试验的人群，那个人群只有汇总数，所以只能当作参照。",
    anchored,
    scale: words.scale,
    estimate: value(indirect),
    ratio, ratioLabel: ratio ? words.ratio : null,
    rows,
    outside: outside ? `对方人群里约有 ${plain(Number(outside.share) * 100, 2)}% 的人，“${outside.covariate}”超出了我们数据的范围，这部分是外推。` : null,
  };
}
