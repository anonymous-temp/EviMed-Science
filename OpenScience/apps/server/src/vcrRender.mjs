/**
 * Report numbers are rendered from results, not typed (build plan 2026-09-28
 * §8.3, platform principle 10c, AC-20).
 *
 * A 「虚拟临研」 report is a template: the words are the AI's, and every number
 * in it is a reference to a field of the study's saved results, resolved here
 * by code. That is the whole mechanism. It is not a checker that reads a
 * finished report and looks for numbers it cannot account for — that check
 * exists too (`vcrContracts.mjs`), and it exists as a *second* line, because a
 * report whose numbers were rendered cannot fail it by construction.
 *
 * Hidden knowledge:
 *
 * - **The reference is the unit, not the number.** `{{n:trial.power|pct1}}`
 *   carries what to read and how to show it. Changing a result changes every
 *   report that referenced it, and 「改一个数」 stops being a sweep operation
 *   over every dependent sentence (principle 10c's standing debt).
 * - **An unresolved reference renders 「未计算」, never zero** (plan §9.6). A
 *   missing result is a fact about the study, and a zero would be a claim
 *   about the world. The issue is advisory: the report still delivers, with
 *   the gap visible in it.
 * - **A number typed into the template is reported and does not reach the
 *   report.** The mechanism is that every number in a report is a reference; a
 *   digit the words carry instead is exactly what the mechanism exists to
 *   remove, so the stored report writes 「未计算」 where it stood and the issue
 *   tells the run to bind it. The delivery is never withheld (the gap is
 *   visible in the report, as any unbound reference's is). What the words may
 *   say in digits is closed and small: a year, an ordinal or month up to twelve,
 *   a day of the month, a locator (`第 35 页`, `图 3`), a source's own words in
 *   「」, a date; anything inside a reference is not prose.
 * - **A reference that cannot be read is not passed on raw.** `{{n:` in any
 *   case that the grammar does not parse (a capital format, a space in a path, a
 *   missing brace) would print as `{{n:…}}` in a reader's report; it renders
 *   「未计算」 and is named in `vcr_number_unparsed`.
 * - **An interval is never rendered bare** (plan §8.3): the `ci` format prints
 *   which kind of interval it is, in Chinese, from the interval's own `kind`.
 *   A simulated measure printed with `pm` carries its Monte-Carlo standard
 *   error, because that is the only honest way to print a simulated number
 *   (AC-28).
 * - **A format that states a unit answers to the unit the result recorded.**
 *   The engine keeps a probability as a fraction with no unit (a power of 0.712)
 *   and one summary as a percentage that says so (a generated arm's event rate:
 *   46.08, unit 「%」). `pct1` multiplied both by a hundred, and a package went
 *   out saying 「试验组事件率 4608.0%」 in Word, PDF and HTML (pilot acceptance,
 *   2026-10-03). The number's unit travels with the reference now: a percentage
 *   is printed as it stands, a fraction is scaled, and a unit the format cannot
 *   be true of — months as a percentage, weeks as 「个月」, a log scale as
 *   either — renders 「未计算」 and says which unit and which format, because a
 *   wrong number reads exactly like a right one.
 * - **`vcrReportModel` is the other half.** It builds the `results.json` a
 *   package ships, from the study's own rows, so the template's references and
 *   the contract's traceability check read the same document.
 *
 * @module vcrRender
 */

import { createHash } from "node:crypto";
import { documentExportDigest, VCR_COUNT_KEYS, VCR_INTERVAL_KIND_LABELS_ZH, VCR_VALUE_SOURCE_LABELS_ZH } from "@evimed/domain";

/**
 * A number reference in a template: `{{n:<path>}}` or `{{n:<path>|<format>}}`.
 * A path segment may carry arguments in parentheses — `measure(power)`,
 * `measure(power, scenario=scn_x)` — and inside them anything but `)` `}` `|`.
 */
export const VCR_NUMBER_PATTERN = /\{\{\s*n:((?:[A-Za-z0-9_.[\]一-鿿-]|\([^)}|]*\))+?)\s*(?:\|\s*([a-z0-9]+)\s*)?\}\}/g;

/**
 * Anything that opens like a reference and is not one the grammar read: `{{n:`
 * in any case, up to the brace that closes it (never across a line or another
 * brace), so what the run meant is quotable in the issue. One that never closes
 * takes only the characters a reference is spelled with, so the sentence after
 * it is not eaten.
 */
const VCR_UNPARSED_PATTERN = /\{\{\s*n:(?:[^{}\n]{0,200}\}{1,2}|[A-Za-z0-9_.[\]()=,|-]*)/gi;

/** What a reference renders as when the study has no such result yet. */
export const VCR_UNCOMPUTED = "未计算";

/** The formats a reference may ask for. */
export const VCR_NUMBER_FORMATS = Object.freeze([
  "raw", "int", "f1", "f2", "f3", "pct0", "pct1", "pct2", "thousands", "ci", "pm", "months", "text",
]);

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The keys whose number is in the unit its own object records: a measure's or a
 * card's `value`, the Monte-Carlo error beside it, and the two ends of an
 * interval or a range that belongs to it. An interval's `level` (0.95) and a
 * distribution's parameters are not: they are numbers about the value, on
 * scales of their own.
 */
const UNIT_BEARING_KEYS = Object.freeze(["value", "mcse", "low", "high"]);

/**
 * Read one path out of a results document. Understands dotted keys, array
 * indices, and `measure(<name>)` — which is how a template names a measure
 * without depending on the order the engine happened to return them in.
 * @param {unknown} root @param {string} path
 */
export function vcrReadPath(root, path) {
  return vcrResolvePath(root, path).value;
}

/**
 * Read one path and the unit the result recorded for the number it ends at:
 * the `unit` of the nearest object the path passed through that states one —
 * the `{ value, unit }` cell itself, the measure an interval belongs to, the
 * card a range belongs to. `null` when nothing on the way records a unit, or
 * when the path ends at a key a unit does not speak for.
 * @param {unknown} root @param {string} path
 * @returns {{ value: unknown, unit: string | null }}
 */
export function vcrResolvePath(root, path) {
  /** @type {unknown[]} every object the path passed through, outermost first */
  const passed = [];
  let lastKey = "";
  const value = walkPath(root, path, (holder, key) => { passed.push(holder); lastKey = key; });
  if (value === undefined || !UNIT_BEARING_KEYS.includes(lastKey)) return { value, unit: null };
  for (const holder of passed.reverse()) {
    const unit = Array.isArray(holder) ? null : object(holder).unit;
    if (typeof unit === "string" && unit.trim()) return { value, unit: unit.trim() };
  }
  return { value, unit: null };
}

/**
 * @param {unknown} root @param {string} path
 * @param {(holder: unknown, key: string) => void} visit called for each step with what it read from and by which key
 */
function walkPath(root, path, visit) {
  let value = root;
  for (const rawSegment of String(path).split(".")) {
    if (value == null) return undefined;
    const segment = rawSegment.trim();
    if (!segment) return undefined;
    visit(value, segment);
    const selector = /^measure\((.+)\)$/.exec(segment);
    if (selector) {
      // `measure(power)` is the headline result's measure of that name;
      // `measure(power, scenario=scn_x)` is the same measure of one trial
      // scenario, by its id — a study has many scenarios and a report compares
      // them, so a name alone cannot say which one is meant.
      const [rawName, ...rawOptions] = selector[1].split(",").map((part) => part.trim());
      const name = rawName;
      const scenarioId = rawOptions.map((option) => /^scenario\s*=\s*(\S+)$/.exec(option)?.[1]).find(Boolean) ?? null;
      let measures = Array.isArray(value) ? value : list(object(value).measures);
      if (scenarioId) {
        const scenarioResult = object(object(root).scenarioResults)[scenarioId];
        if (!scenarioResult) return undefined;
        measures = list(object(scenarioResult).measures);
      }
      value = measures.find((measure) => String(object(measure).name) === name);
      continue;
    }
    const indexed = /^([A-Za-z0-9_一-鿿-]*)\[(\d+)\]$/.exec(segment);
    if (indexed) {
      const base = indexed[1] ? /** @type {any} */ (value)[indexed[1]] : value;
      value = Array.isArray(base) ? base[Number(indexed[2])] : undefined;
      continue;
    }
    value = /** @type {any} */ (value)[segment];
  }
  return value;
}

/** @param {number} value @param {number} digits */
const fixed = (value, digits) => value.toFixed(digits);
/** @param {number} value */
const grouped = (value) => Math.round(value).toLocaleString("en-US");

/**
 * How a recorded unit reads to a format that states a unit of its own. Closed
 * vocabularies, compared trimmed and lower-cased: the engine's own spellings
 * (`%`, `月`, `months`) and the ones a card is written with. A value with no
 * unit is the engine's fraction and a bare duration, which is what both formats
 * were written for. The pooling engine writes the scale where a unit goes, and
 * `identity` is the natural scale — it says nothing about the unit — while a
 * `log` or `logit` value is not the quantity itself. Every other word is a unit
 * the format is not about: a mismatch, never a guess.
 */
const PERCENT_UNITS = new Set(["percent", "pct", "百分比"]);
const FRACTION_UNITS = new Set(["proportion", "fraction", "probability", "比例", "概率"]);
const MONTH_UNITS = new Set(["months", "month", "月", "个月"]);
const UNITLESS_SCALES = new Set(["identity"]);
/** A percentage, or a percentage per something: 「%」, and 「%/年」 as a dropout card is kept. @param {string} unit */
const isPercentUnit = (unit) => PERCENT_UNITS.has(unit) || unit.startsWith("%") || unit.startsWith("％");

/** The formats that print a unit, and so have to agree with the one recorded. */
export const VCR_UNIT_FORMATS = Object.freeze(["pct0", "pct1", "pct2", "months"]);

/**
 * Render one resolved value in the format the reference asked for. `unit` is
 * what the result recorded for the value (`vcrResolvePath`); a caller that has
 * a bare number and no result behind it leaves it out.
 * @param {unknown} value @param {string} format @param {string | null} [unit]
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export function vcrFormatValue(value, format, unit = null) {
  if (value === undefined || value === null) return { ok: false, text: VCR_UNCOMPUTED, reason: "unbound" };
  if (format === "text") return { ok: true, text: String(value) };
  if (format === "ci") {
    const interval = object(object(value).interval ?? value);
    const low = Number(interval.low);
    const high = Number(interval.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { ok: false, text: VCR_UNCOMPUTED, reason: "interval_incomplete" };
    const kind = String(interval.kind ?? "");
    const label = /** @type {Record<string, string>} */ (VCR_INTERVAL_KIND_LABELS_ZH)[kind];
    if (!label) return { ok: false, text: `${fixed(low, 3)}～${fixed(high, 3)}`, reason: "interval_kind_unnamed" };
    return { ok: true, text: `${label} ${fixed(low, 3)}～${fixed(high, 3)}` };
  }
  if (format === "pm") {
    const measure = object(value);
    const point = Number(measure.value);
    if (!Number.isFinite(point)) return { ok: false, text: VCR_UNCOMPUTED, reason: "value_missing" };
    const mcse = Number(measure.mcse);
    if (measure.simulated !== false && !Number.isFinite(mcse)) {
      return { ok: false, text: fixed(point, 3), reason: "mcse_missing" };
    }
    return { ok: true, text: Number.isFinite(mcse) ? `${fixed(point, 3)}（蒙特卡洛标准误 ${fixed(mcse, 4)}）` : fixed(point, 3) };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, text: VCR_UNCOMPUTED, reason: "not_a_number" };
  const word = String(unit ?? "").trim().toLowerCase();
  const recorded = UNITLESS_SCALES.has(word) ? "" : word;
  const mismatch = { ok: false, text: VCR_UNCOMPUTED, reason: "unit_mismatch" };
  switch (format) {
    case "int": return { ok: true, text: String(Math.round(number)) };
    case "f1": return { ok: true, text: fixed(number, 1) };
    case "f2": return { ok: true, text: fixed(number, 2) };
    case "f3": return { ok: true, text: fixed(number, 3) };
    case "pct0": case "pct1": case "pct2": {
      const digits = Number(format.slice(3));
      // Already a percentage: printed as it stands. A fraction, said or unsaid: scaled.
      if (isPercentUnit(recorded)) return { ok: true, text: `${fixed(number, digits)}%` };
      if (recorded && !FRACTION_UNITS.has(recorded)) return mismatch;
      return { ok: true, text: `${fixed(number * 100, digits)}%` };
    }
    case "thousands": return { ok: true, text: grouped(number) };
    case "months":
      if (recorded && !MONTH_UNITS.has(recorded)) return mismatch;
      return { ok: true, text: `${fixed(number, 1)} 个月` };
    default: return { ok: true, text: String(number) };
  }
}

/**
 * Stretches of prose whose digits are not a statement of the study: a source's
 * own words in 「」 or “”, and an ISO date or instant. Closed formats, not a
 * reading of language (principle 5).
 */
const QUOTED_OR_DATED = [
  /「[^」\n]*」/g,
  /“[^”\n]*”/g,
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
];

/**
 * Whether the digits at `start` label something rather than measure it: a day
 * of the month (`29 日`), a locator (`第 35 页`, `图 3`, `表 2`, `#25`).
 * @param {string} text @param {number} start @param {number} end @param {number} value
 */
function isLabelNumber(text, start, end, value) {
  const after = text.slice(end);
  const before = text.slice(Math.max(0, start - 6), start);
  if (Number.isInteger(value) && value <= 31 && /^\s*[日号]/.test(after)) return true;
  if (/第\s*$/.test(before) && /^\s*(?:页|条|节|章|表|图|项)/.test(after)) return true;
  return /(?:图|表|附录|#)\s*$/.test(before);
}

/**
 * The typed numbers of one stretch of prose, with where each stands. What
 * the report may say in digits without a reference: a year, an ordinal or month
 * up to twelve, a day, a locator, a quoted source, a date.
 * @param {string} text
 * @returns {Array<{ raw: string, start: number, end: number }>}
 */
function typedNumberSpans(text) {
  /** @type {Array<[number, number]>} */
  const exempt = [];
  for (const pattern of QUOTED_OR_DATED) for (const match of text.matchAll(pattern)) exempt.push([match.index, match.index + match[0].length]);
  /** @type {Array<{ raw: string, start: number, end: number }>} */
  const found = [];
  const pattern = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![\w.])/g;
  let match;
  while ((match = pattern.exec(text))) {
    const raw = match[1];
    const start = match.index;
    const end = start + raw.length;
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    if (Number.isInteger(value) && value <= 12) continue;
    if (exempt.some(([from, to]) => start >= from && end <= to)) continue;
    if (isLabelNumber(text, start, end, value)) continue;
    found.push({ raw, start, end });
  }
  return found;
}

/**
 * Numbers a template typed instead of referencing. Years, ordinals up to
 * twelve and everything inside a `{{n:…}}` reference are not counted.
 * @param {string} template
 */
export function vcrTypedNumbers(template) {
  const withoutRefs = String(template ?? "").replace(VCR_NUMBER_PATTERN, " ");
  return typedNumberSpans(withoutRefs).map((span) => span.raw);
}

/**
 * Render a report template against a results document.
 *
 * @param {string} template the AI's prose with `{{n:…}}` references in it
 * @param {Record<string, any>} results the study's `results.json`
 * @returns {{ text: string, bindings: Array<{ ref: string, path: string, format: string, value: unknown, rendered: string, ok: boolean, unit?: string }>,
 *   issues: Array<{ code: string, path: string, message: string, severity: string, reason?: string, unit?: string | null, format?: string }>, typed: string[] }}
 */
export function renderVcrNumbers(template, results) {
  /** @type {Array<{ ref: string, path: string, format: string, value: unknown, rendered: string, ok: boolean, unit?: string }>} */
  const bindings = [];
  /** @type {Array<{ code: string, path: string, message: string, severity: string, reason?: string, unit?: string | null, format?: string }>} */
  const issues = [];
  const document = object(results);
  const source = String(template ?? "");

  /**
   * The digits one stretch of words types, replaced and counted.
   * @param {string} words
   */
  const withoutTyped = (words) => {
    let out = "";
    let cursor = 0;
    for (const span of typedNumberSpans(words)) {
      out += words.slice(cursor, span.start) + VCR_UNCOMPUTED;
      cursor = span.end;
      typed.push(span.raw);
    }
    return out + words.slice(cursor);
  };

  /**
   * Prose between references: the digits it types are replaced and counted,
   * and anything that opens as a reference and is not one is named and
   * replaced. Rendered references are never scanned again — a value that
   * itself contains digits or braces is a result, not prose.
   * @param {string} words
   */
  const prose = (words) => {
    let out = "";
    let cursor = 0;
    for (const found of words.matchAll(VCR_UNPARSED_PATTERN)) {
      out += withoutTyped(words.slice(cursor, found.index)) + VCR_UNCOMPUTED;
      unparsed.push(found[0].trim());
      cursor = found.index + found[0].length;
    }
    return out + withoutTyped(words.slice(cursor));
  };

  /** @type {string[]} */
  const typed = [];
  /** @type {string[]} */
  const unparsed = [];
  let text = "";
  let cursor = 0;
  for (const match of source.matchAll(VCR_NUMBER_PATTERN)) {
    const [ref, rawPath, rawFormat] = match;
    text += prose(source.slice(cursor, match.index));
    cursor = match.index + ref.length;
    const path = String(rawPath);
    const format = rawFormat && VCR_NUMBER_FORMATS.includes(String(rawFormat)) ? String(rawFormat) : "raw";
    if (rawFormat && !VCR_NUMBER_FORMATS.includes(String(rawFormat))) {
      issues.push({ code: "vcr_number_format_unknown", path,
        message: `「${rawFormat}」不是已知的数字格式，按原值呈现。`, severity: "advisory" });
    }
    const { value, unit } = vcrResolvePath(document, path);
    const rendered = vcrFormatValue(value, format, unit);
    // The unit is kept beside the binding: it is why a percentage was not scaled.
    bindings.push({ ref: String(ref), path, format, value, rendered: rendered.text, ok: rendered.ok, ...(unit ? { unit } : {}) });
    if (!rendered.ok) {
      issues.push({
        // A unit the format cannot be true of is filed with the references that
        // did not bind — the report reads 「未计算」 there just the same — and the
        // sentence says which unit and which format, so the run changes the
        // format rather than looking for a field that is not missing.
        code: rendered.reason === "mcse_missing" ? "vcr_number_mcse_missing"
          : rendered.reason === "interval_kind_unnamed" ? "vcr_interval_unnamed" : "vcr_number_unbound",
        path,
        message: rendered.reason === "mcse_missing" ? `「${path}」是仿真结果但没有蒙特卡洛标准误（AC-28）。`
          : rendered.reason === "interval_kind_unnamed" ? `「${path}」的区间没有写明是哪一种（方案 §8.3）。`
            : rendered.reason === "unit_mismatch"
              ? `「${path}」在结果里记的单位是「${unit}」，不能按 ${format} 呈现，报告此处写「${VCR_UNCOMPUTED}」；改用 f1、f2 这类不带单位的格式，单位写在文字里。`
              : `结果里没有「${path}」，报告此处写「${VCR_UNCOMPUTED}」。`,
        severity: "advisory",
        ...(rendered.reason === "unit_mismatch" ? { reason: "unit_mismatch", unit, format } : {}),
      });
    }
    text += rendered.text;
  }
  text += prose(source.slice(cursor));

  for (const found of unparsed) {
    issues.push({ code: "vcr_number_unparsed", path: found.slice(0, 80),
      message: `「${found.slice(0, 80)}」读不成数字引用，报告此处写「${VCR_UNCOMPUTED}」；引用写成 {{n:路径|格式}}，格式用小写。`,
      severity: "advisory" });
  }
  if (typed.length) {
    issues.push({ code: "vcr_number_typed", path: "",
      message: `模板里有 ${typed.length} 个手写数字（${typed.slice(0, 5).join("、")}${typed.length > 5 ? "…" : ""}）：报告里这些位置写了「${VCR_UNCOMPUTED}」，数应由结果渲染（方案 §8.3）；改成引用。`,
      severity: "advisory" });
  }
  return { text, bindings, issues, typed };
}

/**
 * The `results.json` a package ships: what the template binds to and what the
 * contract's traceability check reads. One document, so the two can never
 * disagree about a number.
 *
 * @param {{ study: any, definition?: any, assumptions?: any[], results?: any[], seal?: any, reviews?: any[],
 *   staleMarks?: any[], models?: any[], population?: any, comparator?: any, scenarios?: any[], counts?: Record<string, any> }} input
 */
export function vcrReportModel(input) {
  const study = object(input.study);
  const results = list(input.results);
  const headline = results.find((result) => object(result).kind === "trial_scenario")
    ?? results.find((result) => object(result).kind === "comparator")
    ?? results[0] ?? null;
  const population = object(input.population);
  const comparator = object(input.comparator);

  /** @type {Record<string, any>} */
  const counts = {};
  for (const key of VCR_COUNT_KEYS) {
    const fromHeadline = object(object(headline).counts)[key];
    const fromPopulation = object(population.counts)[key];
    const fromInput = object(input.counts)[key];
    const value = fromInput ?? fromHeadline ?? fromPopulation ?? null;
    counts[key] = value == null ? null : Number(value);
  }
  for (const key of ["priorEffectiveSampleSize", "reconstructedPseudoPatients"]) {
    const value = object(object(headline).counts)[key] ?? object(population.counts)[key];
    if (value != null) counts[key] = Number(value);
  }

  const byKind = /** @type {Record<string, any>} */ ({});
  for (const result of results) {
    const kind = String(object(result).kind);
    if (!byKind[kind]) byKind[kind] = object(result);
  }

  // One result per trial scenario, by the scenario's id (and by the full
  // lineage node the job filed it under): a report compares scenarios, and
  // `measure(power, scenario=<id>)` reads one of them.
  /** @type {Record<string, any>} */
  const scenarioResults = {};
  for (const result of results) {
    const row = object(result);
    if (row.kind !== "trial_scenario" || !row.subjectId) continue;
    const subject = String(row.subjectId);
    const bare = subject.replace(/^[a-z_]+:/, "").replace(/@\d+$/, "");
    const entry = {
      id: row.id ?? null, conclusion: row.conclusion ?? null, counts: object(row.counts),
      measures: list(row.measures), diagnostics: object(row.diagnostics), intendedUse: row.intendedUse ?? null,
    };
    scenarioResults[bare] = entry;
    scenarioResults[subject] = entry;
  }

  return {
    study: {
      id: String(study.id ?? ""), name: String(study.name ?? ""), question: String(study.question ?? ""),
      dataTier: String(study.dataTier ?? "T0"), intendedUse: String(study.intendedUse ?? "exploratory"),
    },
    inputVersions: {
      population: input.population ? { id: population.id ?? null, version: population.version ?? null } : null,
      comparator: input.comparator ? { id: comparator.id ?? null, version: comparator.version ?? null } : null,
    },
    definition: input.definition ? {
      id: object(input.definition).id ?? null, version: Number(object(input.definition).version ?? 0),
      pico: object(object(input.definition).pico), estimand: object(object(input.definition).estimand),
      endpointType: object(input.definition).endpointType ?? null,
    } : null,
    conclusion: object(headline).conclusion ?? null,
    notEstimableRule: object(headline).notEstimableRule ?? null,
    estimand: comparator.estimand ?? object(object(input.definition).estimand).kind ?? null,
    intendedUse: object(headline).intendedUse ?? String(study.intendedUse ?? "exploratory"),
    useDowngrade: object(headline).useDowngrade ?? null,
    counts,
    measures: list(object(headline).measures),
    diagnostics: object(object(headline).diagnostics),
    tables: list(object(headline).tables),
    populationKind: population.kind ?? null,
    waterfall: list(population.waterfall),
    qualityReport: Object.keys(object(population.quality)).length ? object(population.quality) : null,
    assumptions: list(input.assumptions).map((assumption) => {
      const card = object(assumption);
      return {
        key: String(card.key ?? ""), name: String(card.name ?? ""), version: Number(card.version ?? 1),
        value: card.pointValue == null ? null : Number(card.pointValue), unit: card.unit ?? null,
        distribution: object(card.distribution), sourceKind: card.sourceKind ?? null,
        valueSource: card.valueSource ?? null,
        valueSourceLabel: /** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH)[String(card.valueSource)] ?? null,
        reviewState: card.reviewState ?? "ai_set",
        sources: list(card.sources).length ? list(card.sources) : list(card.evidence), evidenceIds: list(card.evidenceIds),
      };
    }),
    // Every current result, so a template may bind to any of them by kind.
    results: Object.fromEntries(Object.entries(byKind).map(([kind, result]) => [kind, {
      id: result.id ?? null, conclusion: result.conclusion ?? null, counts: object(result.counts),
      measures: list(result.measures), diagnostics: object(result.diagnostics), intendedUse: result.intendedUse ?? null,
    }])),
    scenarioResults,
    scenarios: list(input.scenarios).map((scenario) => {
      const row = object(scenario);
      return { id: row.id ?? null, label: String(row.label ?? ""), design: row.design ?? null, version: Number(row.version ?? 1) };
    }),
    models: list(input.models).map((model) => {
      const row = object(model);
      return { name: String(row.name ?? ""), version: String(row.version ?? ""), tier: row.tier ?? null, risk: row.risk ?? null,
        missingEvidence: list(row.missingEvidence).map(String) };
    }),
    review: {
      records: list(input.reviews).map((review) => {
        const row = object(review);
        return { id: row.id ?? null, reviewerName: row.reviewerName ?? null, reviewerKind: row.reviewerKind ?? "human", status: row.status ?? "done", platformReviewId: row.platformReviewId ?? null, provenance: row.provenance ?? {}, kind: row.kind ?? null, state: row.state ?? null, reviewer: row.reviewer ?? null, ...(typeof row.current === "boolean" ? { current: row.current } : {}), nodes: list(row.nodes).map(String),
          createdAt: row.createdAt ?? null };
      }),
    },
    stale: list(input.staleMarks).map((mark) => {
      const row = object(mark);
      return { node: String(row.node ?? ""), reason: String(row.reason ?? "") };
    }),
    seal: input.seal ?? null,
  };
}

/**
 * Whether an export holds a document: the results it was frozen on and at least
 * one report written against them. The one rule for what 导出 answers with, what
 * a finished export run is judged by and what the study page counts as a
 * document the reader already has — three places that must not disagree.
 * @param {any} cover
 */
export function vcrExportHoldsDocument(cover) {
  return Boolean(cover?.results?.study && (cover.reports?.length || cover.report));
}

/** Report content identity for advisory review. Rendering/job/review status is not scientific content.
 * @param {any} cover */
export function vcrReportReviewRevision(cover) {
  const reports = cover?.reports?.length ? cover.reports : cover?.report ? [cover.report] : [];
  const model = cover?.results ?? {};
  const { review: _review, ...content } = model;
  return createHash('sha256').update(documentExportDigest({ reports, model: { ...content,
    assumptions: (model.assumptions ?? []).map(({ reviewState: _state, ...assumption }) => assumption) } })).digest('hex');
}
