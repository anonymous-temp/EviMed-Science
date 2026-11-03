/**
 * The population check (remediation plan D2, 2026-11-01): a generated population held against a SECOND baseline table, and what the
 * page says of it.
 *
 * Hidden knowledge:
 *
 * - **The generated side is never typed.** `populationCheckRows` copies the population job's own profile (`diagnostics.profile`: mean,
 *   SD and the levels of each variable) into the scenario when the check is queued; a caller that sends `generated` is refused. The
 *   reference side is a baseline table whose numbers the control plane has verified against quoted sources, the same way a literature
 *   population's are.
 * - **Independent means "not made from the same evidence".** `populationCheckIndependence` compares the evidence the reference table
 *   rests on with the evidence the population's own baseline rests on. Shared evidence is a comparison with the inputs, and the page
 *   says so in those words; only a table that shares none is called an independent comparison. A population whose own numbers were
 *   never bound to a source (a scenario someone stated) shares none and says that too.
 * - **The page does not say 验证 unless the data was independent, and then only to say what was not covered.** The engine compares each
 *   variable's own distribution; it does not compare the joint structure, the shape or any subgroup, and the sentence under the table
 *   names those.
 *
 * @module vcrPopulationCheck
 */

import { VCR_SMD_FLOOR } from "@evimed/domain";

const object = (/** @type {unknown} */ value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
const finite = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (/** @type {unknown} */ value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The kinds of variable the check compares; a profile entry of another kind is left out and the page says the check did not reach it. */
const KINDS = new Set(["continuous", "binary", "categorical"]);

/**
 * The generated side of a check: one row per variable of the population's profile, in the scenario's shape.
 * @param {unknown} profile `diagnostics.profile` of a population result
 * @returns {Array<Record<string, any>>}
 */
export function populationCheckRows(profile) {
  const rows = [];
  for (const raw of list(profile)) {
    const entry = object(raw);
    const variable = text(entry.variable);
    const kind = text(entry.kind);
    if (!variable || !kind || !KINDS.has(kind)) continue;
    const n = finite(entry.n);
    const missing = finite(entry.missing);
    const row = /** @type {Record<string, any>} */ ({ variable, kind });
    const label = text(entry.label);
    if (label) row.label = label.slice(0, 80);
    if (n !== null) row.n = Math.max(0, Math.round(n - (missing ?? 0)));
    if (kind === "continuous") {
      const mean = finite(entry.mean);
      const sd = finite(entry.sd);
      if (mean !== null) row.mean = mean;
      if (sd !== null) row.sd = sd;
    } else {
      const levels = list(entry.levels).map(object).map((cell) => ({ level: String(cell.level ?? "").slice(0, 64), p: finite(cell.p) })).filter((cell) => cell.level);
      if (!levels.length) continue;
      row.levels = levels;
    }
    rows.push(row);
    if (rows.length >= 200) break;
  }
  return rows;
}

/**
 * Whether the second table is made from other evidence than the population is.
 * @param {{ populationEvidenceIds?: unknown, referenceEvidenceIds?: unknown }} input
 * @returns {{ independent: boolean, shared: string[], populationSourced: boolean }}
 */
export function populationCheckIndependence({ populationEvidenceIds, referenceEvidenceIds }) {
  const population = new Set(list(populationEvidenceIds).map(String));
  const shared = [...new Set(list(referenceEvidenceIds).map(String))].filter((id) => population.has(id)).sort();
  return { independent: shared.length === 0, shared, populationSourced: population.size > 0 };
}

const STATE_WORDS = Object.freeze({ close: "接近", apart: "有差距", not_comparable: "没法对照" });
const REASON_WORDS = Object.freeze({
  not_in_population: "生成的人群里没有这个变量", kind_differs: "两边的变量类型不一样", levels_differ: "两边的类别对不上", value_missing: "缺少可比较的数",
});
const NOT_COMPARED_WORDS = Object.freeze({ joint_distribution: "变量之间的相关性", distribution_shape: "分布的形状和尾部" });

/** @param {number} value @param {number} [digits] */
const round = (value, digits = 2) => Number(value.toFixed(digits));
/** @param {number} value */
const percent = (value) => `${round(value * 100, 1)}%`;

/**
 * One row of the table as the page prints it.
 * @param {Record<string, any>} entry
 */
function rowView(entry) {
  const state = String(entry.state ?? "not_comparable");
  const generated = object(entry.generated);
  const reference = object(entry.reference);
  /** @type {string | null} */
  let ours = null;
  /** @type {string | null} */
  let theirs = null;
  if (entry.kind === "continuous") {
    if (finite(generated.mean) !== null) ours = `${round(generated.mean)}${finite(generated.sd) !== null ? `（SD ${round(generated.sd)}）` : ""}`;
    if (finite(reference.mean) !== null) theirs = `${round(reference.mean)}${finite(reference.sd) !== null ? `（SD ${round(reference.sd)}）` : ""}`;
  } else if (entry.kind === "binary") {
    if (finite(generated.proportion) !== null) ours = percent(generated.proportion);
    if (finite(reference.proportion) !== null) theirs = percent(reference.proportion);
  } else if (list(entry.levels).length) {
    const cells = list(entry.levels).map(object);
    ours = cells.map((cell) => `${cell.level} ${percent(Number(cell.generated))}`).join(" / ");
    theirs = cells.map((cell) => `${cell.level} ${percent(Number(cell.reference))}`).join(" / ");
  }
  const smd = finite(entry.standardizedDifference);
  const total = finite(entry.totalVariation);
  const standardError = finite(entry.standardError);
  const difference = finite(entry.difference);
  return {
    key: String(entry.variable),
    label: text(entry.label) ?? String(entry.variable),
    ours, theirs,
    smd: smd === null ? null : round(smd),
    totalVariation: total === null ? null : round(total, 3),
    state,
    stateLabel: /** @type {Record<string, string>} */ (STATE_WORDS)[state] ?? STATE_WORDS.not_comparable,
    // How far apart, in a sentence only when the reference said how many people it had; otherwise nothing is claimed about its sampling error.
    note: state === "not_comparable" ? /** @type {Record<string, string>} */ (REASON_WORDS)[String(entry.reason)] ?? null
      : standardError !== null && difference !== null && entry.withinTwoStandardErrors === false ? "差距超过了两个标准误" : null,
  };
}

/**
 * The block the population page prints for the newest check of the shown population, or null when there is none. A check made on an
 * earlier version of the population is shown with the version it was about; nothing is hidden by it.
 * @param {Record<string, any> | null | undefined} result the `population_check` result
 * @param {{ currentResultId?: string | null }} [about] the result the shown population stands on
 */
export function presentPopulationCheck(result, about = {}) {
  if (!result) return null;
  const diagnostics = object(result.diagnostics);
  const rows = list(diagnostics.rows).map(object).map(rowView);
  if (!rows.length) return null;
  const check = object(diagnostics.populationCheck);
  const coverage = object(diagnostics.coverage);
  const independent = check.independent === true;
  const compared = finite(coverage.compared) ?? rows.filter((row) => row.state !== "not_comparable").length;
  const apart = rows.filter((row) => row.state === "apart").length;
  const notCompared = list(coverage.notCompared).map((code) => /** @type {Record<string, string>} */ (NOT_COMPARED_WORDS)[String(code)]).filter(Boolean);
  const referenceOnly = list(coverage.referenceOnly).map(String);
  const generatedOnly = list(coverage.generatedOnly).map(String);
  const left = [
    ...notCompared,
    ...(referenceOnly.length ? [`对照表里有而人群里没有的变量（${referenceOnly.join("、")}）`] : []),
    ...(generatedOnly.length ? [`人群里有而对照表里没有的变量（${generatedOnly.slice(0, 8).join("、")}${generatedOnly.length > 8 ? "等" : ""}）`] : []),
  ];
  const origin = independent
    ? check.populationSourced === false
      ? "这份人群的数没有绑定证据来源；对照表有。"
      : "对照表和生成这份人群用的不是同一批证据。"
    : "对照表和生成这份人群用了同一批证据，所以这只是与输入对照，不是独立对照。";
  const covered = independent
    ? `这里没有对照的部分不算验证：${left.join("；")}。`
    : `没有对照：${left.join("；")}。`;
  return {
    title: independent ? "与第二份基线表独立对照" : "与第二份基线表对照",
    independent,
    sentence: `${compared} 个变量逐个对照了各自的分布，${apart ? `${apart} 个差距超过 ${VCR_SMD_FLOOR}` : `都在 ${VCR_SMD_FLOOR} 以内`}。${origin}`,
    covered,
    rows,
    floor: VCR_SMD_FLOOR,
    // the population version this was about, when it is not the one shown
    ofEarlierVersion: Boolean(about.currentResultId && check.populationResultId && check.populationResultId !== about.currentResultId),
    resultId: String(result.id ?? ""),
  };
}
