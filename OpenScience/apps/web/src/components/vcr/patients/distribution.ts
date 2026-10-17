/**
 * The outline of what a study declared for a variable, in the bins of what came out (R19, plan §5.3 「基线分布 vs 目标」).
 *
 * A small chart of a generated variable is a histogram. What makes it worth reading is the study's own declaration drawn over it:
 * the counts a variable would have if it followed what was declared, bin by bin. That is **drawing a declared curve, not
 * reporting a result**: the numbers on the page (the mean, the spread, how many records broke a limit) are the engine's and the
 * server's; this is the shape the reader compares them with.
 *
 * Hidden knowledge:
 *
 *  - **The outline is renormalised to the bins' own range.** A variable declared with a bound is generated truncated, and a plain
 *    normal curve laid over a truncated sample would look like a defect where there is none. The expected counts are the declared
 *    distribution's mass in each bin divided by its mass over all bins, times the records drawn: the same shape, on the same area.
 *  - **Only the families whose distribution function is a closed form are drawn** (normal, log-normal, uniform, exponential). A beta
 *    or a gamma has no outline here and the card says what was declared in words, as it always did.
 *  - A declaration the page cannot read (a missing parameter, a standard deviation of zero) draws nothing and says nothing.
 */
import type { VcrDeclaredSpec, VcrGeneratedRow } from "@/lib/vcrClient";
import { numberText } from "../vcrText";

/** The standard normal distribution function, Abramowitz and Stegun 7.1.26 (error under 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - poly * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

const param = (spec: VcrDeclaredSpec, name: string): number | null => {
  const value = spec.params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** The declared distribution function, or null for a family (or a parameter set) that has none here. */
export function declaredCdf(spec: VcrDeclaredSpec | null): ((x: number) => number) | null {
  if (!spec) return null;
  if (spec.family === "normal") {
    const mean = param(spec, "mean");
    const sd = param(spec, "sd");
    return mean !== null && sd !== null && sd > 0 ? (x) => normalCdf((x - mean) / sd) : null;
  }
  if (spec.family === "lognormal") {
    const meanlog = param(spec, "meanlog");
    const sdlog = param(spec, "sdlog");
    return meanlog !== null && sdlog !== null && sdlog > 0 ? (x) => (x <= 0 ? 0 : normalCdf((Math.log(x) - meanlog) / sdlog)) : null;
  }
  if (spec.family === "uniform") {
    const min = param(spec, "min");
    const max = param(spec, "max");
    return min !== null && max !== null && max > min ? (x) => Math.min(1, Math.max(0, (x - min) / (max - min))) : null;
  }
  if (spec.family === "exponential") {
    const rate = param(spec, "rate");
    return rate !== null && rate > 0 ? (x) => (x <= 0 ? 0 : 1 - Math.exp(-rate * x)) : null;
  }
  return null;
}

/**
 * How many of `total` records each bin would hold under the declaration, on the bins' own range; null when the declaration has no
 * outline here or puts no mass in the range.
 */
export function expectedCounts(spec: VcrDeclaredSpec | null, breaks: readonly number[], total: number): number[] | null {
  const cdf = declaredCdf(spec);
  if (!cdf || breaks.length < 2 || !(total > 0)) return null;
  const mass = cdf(breaks[breaks.length - 1]) - cdf(breaks[0]);
  if (!(mass > 1e-9)) return null;
  const expected: number[] = [];
  for (let index = 0; index + 1 < breaks.length; index += 1) {
    expected.push((total * (cdf(breaks[index + 1]) - cdf(breaks[index]))) / mass);
  }
  return expected;
}

/** The point of a declared distribution the card marks on its axis (its centre), when it has one. */
export function declaredCentre(spec: VcrDeclaredSpec | null): number | null {
  if (!spec) return null;
  if (spec.family === "normal") return param(spec, "mean");
  if (spec.family === "uniform") {
    const min = param(spec, "min");
    const max = param(spec, "max");
    return min !== null && max !== null ? (min + max) / 2 : null;
  }
  if (spec.family === "bernoulli") return param(spec, "prob");
  return null;
}

/** The share a binary variable was declared to have (`prob`), as a percentage; null when it was declared nothing of the kind. */
export function declaredShare(spec: VcrDeclaredSpec | null): number | null {
  if (!spec || spec.family !== "bernoulli") return null;
  const prob = param(spec, "prob");
  return prob === null ? null : Math.round(prob * 1000) / 10;
}

/** The limits a variable was declared to stay within, as a table cell says them: 「限定 18–90」, 「不小于 18」; null when it declared none. */
export function boundsText(spec: VcrDeclaredSpec | null): string | null {
  const bounds = spec?.bounds;
  if (!bounds) return null;
  if (bounds.min !== null && bounds.max !== null) return `限定 ${numberText(bounds.min)}–${numberText(bounds.max)}`;
  if (bounds.min !== null) return `不小于 ${numberText(bounds.min)}`;
  return bounds.max !== null ? `不大于 ${numberText(bounds.max)}` : null;
}

/**
 * What the engine counted of a variable's limits, as one mark and its words; null when the variable declared none (nothing was
 * checked, so neither a tick nor a warning is drawn). ✓ is `violations === 0`; ⚠ is a count above zero or the values passing a
 * declared bound — the engine's count, never worked out here.
 */
export function limitState(row: Pick<VcrGeneratedRow, "violations" | "outOfBounds">): { ok: boolean; text: string } | null {
  if (row.outOfBounds) return { ok: false, text: "超出限定" };
  if (row.violations === null) return null;
  return row.violations === 0 ? { ok: true, text: "没有记录越界" } : { ok: false, text: `违反 ${numberText(row.violations, 0)} 条` };
}
