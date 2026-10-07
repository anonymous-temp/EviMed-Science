/**
 * What the 人群 tab says of a generated population (R10, 2026-10-07): for each variable, what the study set, what came out, and a
 * small histogram — read from the profile the engine wrote beside the table (`diagnostics.profile`, one entry per variable), and
 * nothing computed here. The engine describes its own table, from the table alone; this turns each entry into the two short phrases a
 * reader compares (「正态分布，均数 63、标准差 9」 and 「均数 63.0，标准差 8.9 …」) and passes the numbers through unchanged.
 *
 * Hidden knowledge:
 *
 * - **A withheld cell stays withheld.** An empirical synthetic table is made from real people: the engine hides a level or a
 *   histogram bin that would speak for a handful of them and says so in the entry (`suppressed`, `{ n: null, p: null, suppressed: true }`).
 *   The view keeps those as they are and says 「小样本已隐藏」 where a number would be; it never fills one in.
 * - **No model, no regex.** Every phrase is a fixed Chinese frame around the entry's own numbers and the closed list of families and
 *   parameters the scenario schema names; a family or parameter this file does not know is said by its own name, never dropped.
 * - **A profile that cannot be read is no profile.** One that fails the domain's `validatePopulationProfile` (the contract the engine
 *   writes to) is dropped as a whole: the tab then says there is none (and offers 「重新生成」); it never shows half.
 *
 * @module vcrPopulationProfileView
 */

import { validatePopulationProfile } from "@evimed/domain";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A number as the engine rounded it (four significant digits), without trailing noise. @param {number} value */
const plain = (value) => String(Number(value.toPrecision(6)));

/** The families the scenario schema names, in words. */
const FAMILY_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  normal: "正态分布", lognormal: "对数正态分布", beta: "Beta 分布", gamma: "Gamma 分布", bernoulli: "二分类", categorical: "多分类",
  uniform: "均匀分布", exponential: "指数分布",
}));

/** The parameters of those families, in words. */
const PARAM_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  mean: "均数", sd: "标准差", meanlog: "对数均值", sdlog: "对数标准差", shape: "形状", shape1: "形状 1", shape2: "形状 2", rate: "速率", scale: "尺度",
  min: "下限", max: "上限", prob: "取 1 的概率", probs: "各水平的概率", levels: "水平",
}));

/** What a binary variable's two levels read as. */
const BINARY_LEVEL_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ 0: "否", 1: "是" }));

/** @param {number} share a proportion */
const percent = (share) => `${Math.round(share * 1000) / 10}%`;

/** @param {unknown} value @returns {string} */
function paramText(value) {
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === "number" ? plain(entry) : String(entry))).join("、");
  return typeof value === "number" && Number.isFinite(value) ? plain(value) : String(value);
}

/**
 * What the scenario declared for a variable, as one phrase: the family and its parameters, then what bounds it.
 * @param {unknown} declared `{ family, params, constraints }` or null (an empirical synthetic table declares nothing)
 * @returns {string | null}
 */
export function declaredPhrase(declared) {
  if (declared === null || declared === undefined) return null;
  const entry = object(declared);
  const family = typeof entry.family === "string" ? entry.family : "";
  if (!family) return null;
  const params = object(entry.params);
  const parts = [FAMILY_WORDS[family] ?? family];
  const given = Object.entries(params).filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => (family === "bernoulli" && key === "prob" && typeof value === "number" ? `${PARAM_WORDS[key]} ${percent(value)}`
      : `${PARAM_WORDS[key] ?? key} ${paramText(value)}`));
  if (given.length) parts.push(given.join("、"));
  const bounds = list(entry.constraints).map(object).map((constraint) => {
    if (constraint.kind === "bounds") {
      const low = finite(constraint.min);
      const high = finite(constraint.max);
      if (low !== null && high !== null) return `限定在 ${plain(low)}–${plain(high)}`;
      if (low !== null) return `不小于 ${plain(low)}`;
      if (high !== null) return `不大于 ${plain(high)}`;
      return null;
    }
    return typeof constraint.name === "string" && constraint.name ? `满足「${constraint.name}」` : null;
  }).filter(Boolean);
  return [parts.join("，"), ...bounds].join("；");
}

/** @param {Record<string, any>} level @param {string} kind */
function levelView(level, kind) {
  const raw = String(level.level ?? "");
  const hidden = level.suppressed === true || level.n === null;
  return {
    level: raw,
    label: kind === "binary" ? (BINARY_LEVEL_WORDS[/** @type {0 | 1} */ (Number(raw))] ?? raw) : raw,
    n: hidden ? null : finite(level.n),
    percent: hidden || finite(level.p) === null ? null : Math.round(Number(level.p) * 1000) / 10,
    suppressed: hidden,
  };
}

/**
 * One variable's entry as a row of the tab: the engine's own fields, untouched, and the two phrases a reader compares.
 * @param {unknown} raw @param {number} index
 * @returns {Record<string, any> | null} null for an entry that is not a variable's description
 */
function entryView(raw, index) {
  const entry = object(raw);
  const variable = typeof entry.variable === "string" ? entry.variable : "";
  const kind = ["continuous", "binary", "categorical"].includes(String(entry.kind)) ? String(entry.kind) : "";
  if (!variable || !kind) return null;
  const n = finite(entry.n);
  const missing = finite(entry.missing);
  const withheld = list(entry.suppressed).map(String);
  /** @type {Record<string, any>} */
  const row = {
    key: variable || `variable_${index}`,
    variable,
    label: typeof entry.label === "string" && entry.label ? entry.label : variable,
    kind,
    declared: entry.declared === undefined ? null : entry.declared,
    declaredText: declaredPhrase(entry.declared),
    n, missing,
    missingText: missing !== null && missing > 0 && n ? `缺失 ${missing.toLocaleString("en-US")} 条（${percent(missing / n)}）` : null,
    suppressed: withheld,
  };
  if (kind === "continuous") {
    for (const key of ["mean", "sd", "median", "q1", "q3", "min", "max"]) row[key] = finite(entry[key]);
    const histogram = object(entry.histogram);
    row.histogram = list(histogram.breaks).length && list(histogram.counts).length
      ? { breaks: list(histogram.breaks).map((edge) => finite(edge)), counts: list(histogram.counts).map((count) => (count === null ? null : finite(count))) } : null;
    const stated = [
      row.mean !== null ? `均数 ${plain(row.mean)}` : null, row.sd !== null ? `标准差 ${plain(row.sd)}` : null,
      row.median !== null ? `中位 ${plain(row.median)}${row.q1 !== null && row.q3 !== null ? `（四分位 ${plain(row.q1)}–${plain(row.q3)}）` : ""}` : null,
      row.min !== null && row.max !== null ? `范围 ${plain(row.min)}–${plain(row.max)}` : null,
    ].filter(Boolean);
    row.generatedText = stated.length ? stated.join("，") : (withheld.length ? "小样本已隐藏" : null);
    row.levels = null;
  } else {
    row.levels = list(entry.levels).map(object).map((level) => levelView(level, kind));
    row.histogram = null;
    const shown = row.levels.filter((/** @type {any} */ level) => level.percent !== null);
    // A binary variable is its 「是」: the variable's own words, then how many were.
    const yes = kind === "binary" ? row.levels.find((/** @type {any} */ level) => level.level === "1") : null;
    row.generatedText = yes && yes.percent !== null ? `${row.label} ${yes.percent}%`
      : shown.length ? `${shown.map((/** @type {any} */ level) => `${level.label} ${level.percent}%`).join("，")}${row.levels.some((/** @type {any} */ level) => level.suppressed) ? "，其余小样本已隐藏" : ""}`
        : (typeof entry.withheld === "string" || withheld.length ? "小样本已隐藏" : null);
    row.withheld = typeof entry.withheld === "string" ? entry.withheld : null;
  }
  return row;
}

/**
 * The rows of a generated population's profile, or null when the result carries none the page can read.
 * @param {unknown} profile `diagnostics.profile` of a population result
 * @returns {Array<Record<string, any>> | null}
 */
export function generatedProfileRows(profile) {
  if (!Array.isArray(profile) || !profile.length) return null;
  // The contract of the block is the domain's (the engine writes it, the page reads it): a profile that fails it is no profile.
  if (validatePopulationProfile(profile).length) return null;
  const rows = profile.map(entryView).filter((row) => row !== null);
  return rows.length === profile.length ? /** @type {Array<Record<string, any>>} */ (rows) : null;
}

/** How a population was generated, in the reader's words. */
export const POPULATION_METHOD_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  scenario: "按设定的分布和相关性抽样", literature: "按文献基线表生成", empirical_synthetic: "按真实数据经验合成",
}));

/** What a population whose result carries no profile says, with the way to get one. */
export const PROFILE_MISSING_SENTENCE = "这个人群生成时还没有画像：点“重新生成”，按同样的设定再生成一次，就能看到每个变量的分布。";

/**
 * The constraint checks of a generated population, as rows: what each rule is called and how many generated records broke it.
 * @param {unknown} violations `diagnostics.constraintViolations` (a table of rule and count)
 * @returns {Array<{ label: string, violations: number }>}
 */
export function constraintRows(violations) {
  return (Array.isArray(violations) ? violations : violations ? [violations] : []).map(object).map((row, index) => {
    const count = finite(row.violations);
    const label = [row.name, row.constraint, row.rule].find((word) => typeof word === "string" && word) ?? `约束 ${index + 1}`;
    return count === null ? null : { label: String(label), violations: count };
  }).filter((row) => row !== null);
}
