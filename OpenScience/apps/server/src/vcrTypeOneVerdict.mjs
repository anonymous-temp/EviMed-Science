/**
 * A simulated type I error said as what it is: a verdict on its conservative bound, never on its estimate.
 *
 * Hidden knowledge:
 *
 * - **One rule, the lab's.** The verdict is `vcrJudgeConstraint` of `@evimed/domain` (the design-search campaign's constraint judge) on
 *   a `<=` error-control constraint at the frozen confidence 0.975: it passes only when the upper bound is at or below the level, fails
 *   only when the lower bound is above it, and is undecided in between. The trial page's rows, the inbox title and the answer a
 *   conversation reads all call this, so a design cannot be "满足" on the page and "无法确定" in the lab.
 * - **The bound is read from the Monte Carlo SE.** The trial page, the inbox and the job answer all have the estimate and its MCSE, and
 *   not always the replicate count of the stage that measured it, so the judge's normal bound (estimate ± 1.96 MCSE) is what all three
 *   use; the lab, which knows its replicates, uses the exact Clopper–Pearson bound and agrees with this except within a hair of the level.
 * - **Live D8 (2026-11-07):** a log-rank null run of 20,000 replicates at 2.53% (MCSE 0.11%) was headed "仿真支持“不超过 2.5%”" in the
 *   reply, labelled "I 类错误不超过 单侧 2.5%" under the page's chart and "I 类错误 2.5%" in the inbox. Its upper bound is 2.75%: the
 *   only true sentence is that the simulation cannot decide it.
 * - **An exact value is compared as it is** (a closed form's nominal level, a Simon design's exact size): no MCSE, no bound.
 *
 * @module vcrTypeOneVerdict
 */

import { vcrJudgeConstraint } from "@evimed/domain";

/** The confidence of the conservative bound: the campaign's default (`vcrCampaignManifest`), so the page and the lab judge alike. */
export const VCR_TYPE_ONE_CONFIDENCE = 0.975;

/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A proportion as a percentage with the given decimals, trailing zeros of a level dropped (“2.5%”, never “2.50%”). @param {number} value @param {number | null} decimals */
const percentText = (value, decimals) => {
  const scaled = value * 100;
  if (decimals === null) return `${Number(scaled.toFixed(4))}%`;
  return `${scaled.toFixed(decimals)}%`;
};

/** Two significant digits of the MCSE, in percentage points: 0.11 → 2 decimals; the estimate is printed to the same place. @param {number} mcsePercent */
const decimalsOf = (mcsePercent) => Math.min(4, Math.max(1, 1 - Math.floor(Math.log10(mcsePercent))));

/**
 * The estimate and its error to the place the error is known to (「2.53% ± 0.11%」), or the exact value (「2.5%」): what is said of a type I
 * error when there is no level to judge it against.
 * @param {{ value: unknown, mcse?: unknown }} input proportions
 * @returns {string | null}
 */
export function vcrTypeOneMeasured({ value, mcse = null }) {
  const estimate = finite(value);
  if (estimate === null) return null;
  const error = finite(mcse);
  if (error === null || error <= 0) return percentText(estimate, null);
  const decimals = decimalsOf(error * 100);
  return `${percentText(estimate, decimals)} ± ${percentText(error, decimals)}`;
}

/**
 * The verdict of a type I error against its level.
 * @param {{ value: unknown, mcse?: unknown, bound: unknown }} input proportions (0.0253, 0.0011, 0.025), the engine's own units
 * @returns {{ status: 'pass' | 'fail' | 'inconclusive', simulated: boolean, lower: number, upper: number, text: string } | null}
 *   null when the estimate or the level is missing; `text` is the phrase after 「I 类错误」:
 *   「无法确定是否不超过 2.5%（模拟 2.53% ± 0.11%）」, 「不超过 2.5%（模拟 2.28% ± 0.11%）」, 「超过 2.5%（模拟 3.10% ± 0.12%）」,
 *   or for an exact value 「不超过 2.5%（计算值 2.5%）」
 */
export function vcrTypeOneVerdict({ value, mcse = null, bound }) {
  const estimate = finite(value);
  const level = finite(bound);
  if (estimate === null || level === null || level <= 0 || level >= 1) return null;
  const error = finite(mcse);
  const simulated = error !== null && error > 0;
  const verdict = vcrJudgeConstraint(
    { space: { method: "design.simulate" } },
    { measure: "type_one_error", op: "<=", bound: level, kind: "error_control", confidence: VCR_TYPE_ONE_CONFIDENCE },
    { state: "succeeded", measures: [{ name: "type_one_error", value: estimate, mcse: simulated ? error : null, simulated }] },
    { stage: "final" },
  );
  const status = /** @type {'pass' | 'fail' | 'inconclusive'} */ (verdict.status);
  if (!["pass", "fail", "inconclusive"].includes(status)) return null;
  const levelText = percentText(level, null);
  const measured = `${simulated ? "模拟" : "计算值"} ${vcrTypeOneMeasured({ value: estimate, mcse: simulated ? error : null })}`;
  const said = status === "pass" ? `不超过 ${levelText}` : status === "fail" ? `超过 ${levelText}` : `无法确定是否不超过 ${levelText}`;
  return { status, simulated, lower: verdict.bound.lower, upper: verdict.bound.upper, text: `${said}（${measured}）` };
}

/**
 * The level a design's type I error is judged against, from what its result and scenario say: the scenario's own `analysis.alpha`, else
 * the level the engine applied as a default, else the closed form the simulation was checked against (a type I check's analytic value
 * is the test's nominal level).
 * @param {{ scenario?: Record<string, any> | null, result?: Record<string, any> | null }} facts
 * @returns {number | null}
 */
export function vcrTypeOneLevel({ scenario = null, result = null }) {
  const stated = finite(scenario?.analysis?.alpha);
  if (stated !== null) return stated;
  const diagnostics = result?.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : {};
  const applied = (Array.isArray(diagnostics.appliedDefaults) ? diagnostics.appliedDefaults : [])
    .find((/** @type {any} */ entry) => entry && entry.path === "analysis.alpha");
  const defaulted = finite(applied?.value);
  if (defaulted !== null) return defaulted;
  const check = diagnostics.analyticCheck && typeof diagnostics.analyticCheck === "object" ? diagnostics.analyticCheck : null;
  return check && check.name === "type_one_error" ? finite(check.value) : null;
}

/**
 * A result as a conversation reads it, with the verdict laid on each simulated type I error it holds: the result's own (a null run of a
 * design) as `typeOneError`, and each cell of a design grid that measured one as that cell's `typeOneError`, all `{ verdict, text }` with
 * the text the page and the inbox say. Every answer that carries such a number says it this way (live D8, 2026-11-07, phase 3: a grid's
 * null check of 2.44% ± 0.11% was read through `vcr_read results`, which carried no verdict, and the reply said 「能确认不超过 2.5%」).
 * A copy; the result is unchanged when it holds no type I error or there is no level to judge it against.
 * @param {Record<string, any>} result as the answer carries it (`measures`, `diagnostics.cells[].measures`)
 * @param {number | null} level the level of the design (`vcrTypeOneLevel`)
 * @returns {Record<string, any>}
 */
export function vcrWithTypeOneVerdicts(result, level) {
  if (!result || typeof result !== "object" || level === null) return result;
  /** @param {unknown} measures */
  const judged = (measures) => {
    const measure = (Array.isArray(measures) ? measures : []).find((/** @type {any} */ entry) => entry?.name === "type_one_error");
    const verdict = measure ? vcrTypeOneVerdict({ value: measure.value, mcse: measure.mcse, bound: level }) : null;
    return verdict ? { verdict: verdict.status, text: `I 类错误${verdict.text}` } : null;
  };
  const own = judged(result.measures);
  const diagnostics = result.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : null;
  const cells = Array.isArray(diagnostics?.cells) ? diagnostics.cells : null;
  const judgedCells = cells?.map((/** @type {any} */ cell) => {
    const verdict = cell && typeof cell === "object" ? judged(cell.measures) : null;
    return verdict ? { ...cell, typeOneError: verdict } : cell;
  });
  const cellsChanged = Boolean(judgedCells?.some((/** @type {any} */ cell, /** @type {number} */ index) => cell !== cells?.[index]));
  if (!own && !cellsChanged) return result;
  return { ...result, ...(own ? { typeOneError: own } : {}), ...(cellsChanged ? { diagnostics: { ...diagnostics, cells: judgedCells } } : {}) };
}
