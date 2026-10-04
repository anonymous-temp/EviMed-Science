/**
 * The one mechanism by which a number in a report is a value the platform
 * resolved, not prose someone typed (platform principle 10c, plan 2026-10-02
 * §11.3 N06).
 *
 * It began as the 「虚拟临研」 renderer (`apps/server/src/vcrRender.mjs`: build
 * plan 2026-09-28 §8.3, AC-20) and was lifted here, unchanged in behaviour, so
 * that a meta-analysis report, a statistical report and a study package read
 * one grammar and one set of formats rather than two that drift. The VCR
 * renderer keeps its own issue codes and Chinese sentences and calls this for
 * everything else; the result lineage (`resultLineage.mjs`) binds a rendered
 * reference to the calculation version it was read from.
 *
 * Hidden knowledge:
 *
 * - **The reference is the unit, not the number.** `{{n:values.pooled_effect|f2}}`
 *   carries what to read and how to show it. Changing the calculation changes
 *   every report that referenced it.
 * - **An unresolved reference renders 「未计算」, never zero.** A missing result
 *   is a fact about the analysis; a zero would be a claim about the world.
 * - **A number typed into a template is replaced, and reported.** What the words
 *   may say in digits is closed and small: a year, an ordinal or month up to
 *   twelve, a day of the month, a locator (`第 35 页`, `图 3`), a source's own
 *   words in 「」, a date. Anything inside a reference is not prose.
 * - **A reference that cannot be read is not passed on raw.** `{{n:` in any case
 *   the grammar does not parse would print as `{{n:…}}` in a reader's report; it
 *   renders 「未计算」 and is named.
 * - **A format that states a unit answers to the unit the result recorded.** A
 *   probability is kept as a fraction with no unit; a percentage says so. The
 *   unit travels with the reference: a percentage is printed as it stands, a
 *   fraction is scaled, and a unit the format cannot be true of renders
 *   「未计算」 and says which unit and which format, because a wrong number reads
 *   exactly like a right one.
 * - **The binding survives the rounding.** A format is a recorded
 *   transformation (`f2`, `pct1`), so what a reader sees (0.71) is linked to
 *   what the engine said (0.7134) by a name, not by a coincidence of digits.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/numberBinding
 */

import { VCR_INTERVAL_KIND_LABELS_ZH } from "./vcrVocabulary.mjs";

/**
 * A number reference in a template: `{{n:<path>}}` or `{{n:<path>|<format>}}`.
 * A path segment may carry arguments in parentheses — `measure(power)`,
 * `measure(power, scenario=scn_x)` — and inside them anything but `)` `}` `|`.
 */
export const NUMBER_REFERENCE_PATTERN = /\{\{\s*n:((?:[A-Za-z0-9_.[\]一-鿿-]|\([^)}|]*\))+?)\s*(?:\|\s*([a-z0-9]+)\s*)?\}\}/g;

/**
 * Anything that opens like a reference and is not one the grammar read: `{{n:`
 * in any case, up to the brace that closes it (never across a line or another
 * brace), so what the run meant is quotable in the issue. One that never closes
 * takes only the characters a reference is spelled with, so the sentence after
 * it is not eaten.
 */
export const NUMBER_UNPARSED_PATTERN = /\{\{\s*n:(?:[^{}\n]{0,200}\}{1,2}|[A-Za-z0-9_.[\]()=,|-]*)/gi;

/** What a reference renders as when nothing has computed the value. */
export const NUMBER_UNCOMPUTED = "未计算";

/** The formats a reference may ask for. */
export const NUMBER_FORMATS = Object.freeze([
  "raw", "int", "f1", "f2", "f3", "pct0", "pct1", "pct2", "thousands", "ci", "pm", "months", "text",
]);

/** The formats that print a unit, and so have to agree with the one recorded. */
export const NUMBER_UNIT_FORMATS = Object.freeze(["pct0", "pct1", "pct2", "months"]);

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
export function readNumberPath(root, path) {
  return resolveNumberPath(root, path).value;
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
export function resolveNumberPath(root, path) {
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

/**
 * Render one resolved value in the format the reference asked for. `unit` is
 * what the result recorded for the value (`resolveNumberPath`); a caller that
 * has a bare number and no result behind it leaves it out.
 * @param {unknown} value @param {string} format @param {string | null} [unit]
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export function formatNumberValue(value, format, unit = null) {
  if (value === undefined || value === null) return { ok: false, text: NUMBER_UNCOMPUTED, reason: "unbound" };
  if (format === "text") return { ok: true, text: String(value) };
  if (format === "ci") {
    const interval = object(object(value).interval ?? value);
    const low = Number(interval.low);
    const high = Number(interval.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { ok: false, text: NUMBER_UNCOMPUTED, reason: "interval_incomplete" };
    const kind = String(interval.kind ?? "");
    const label = /** @type {Record<string, string>} */ (VCR_INTERVAL_KIND_LABELS_ZH)[kind];
    if (!label) return { ok: false, text: `${fixed(low, 3)}～${fixed(high, 3)}`, reason: "interval_kind_unnamed" };
    return { ok: true, text: `${label} ${fixed(low, 3)}～${fixed(high, 3)}` };
  }
  if (format === "pm") {
    const measure = object(value);
    const point = Number(measure.value);
    if (!Number.isFinite(point)) return { ok: false, text: NUMBER_UNCOMPUTED, reason: "value_missing" };
    const mcse = Number(measure.mcse);
    if (measure.simulated !== false && !Number.isFinite(mcse)) {
      return { ok: false, text: fixed(point, 3), reason: "mcse_missing" };
    }
    return { ok: true, text: Number.isFinite(mcse) ? `${fixed(point, 3)}（蒙特卡洛标准误 ${fixed(mcse, 4)}）` : fixed(point, 3) };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, text: NUMBER_UNCOMPUTED, reason: "not_a_number" };
  const word = String(unit ?? "").trim().toLowerCase();
  const recorded = UNITLESS_SCALES.has(word) ? "" : word;
  const mismatch = { ok: false, text: NUMBER_UNCOMPUTED, reason: "unit_mismatch" };
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
 * Stretches of prose whose digits are not a statement of the analysis: a
 * source's own words in 「」 or “”, and an ISO date or instant. Closed formats,
 * not a reading of language (principle 5).
 */
const QUOTED_OR_DATED = [
  /「[^」\n]*」/g,
  /“[^”\n]*”/g,
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
];

/**
 * Stretches a finished report carries that are not its statements either: a
 * numbered citation, an inline code span, a link target and a bare address.
 * Only a caller that reads a finished report asks for them (`report`): the
 * template renderer never needed them, and its behaviour must not move.
 */
const REPORT_NOISE = [
  /\[\d{1,3}(?:\s*[-–,，]\s*\d{1,3})*\]/g,
  /`[^`\n]*`/g,
  /\]\([^)\n]*\)/g,
  /https?:\/\/\S+/g,
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
 * @param {{ report?: boolean }} [options] `report`: also leave out citation markers, code spans and addresses,
 *   which a finished report carries and a template does not
 * @returns {Array<{ raw: string, start: number, end: number }>}
 */
export function typedNumberSpans(text, { report = false } = {}) {
  /** @type {Array<[number, number]>} */
  const exempt = [];
  for (const pattern of report ? [...QUOTED_OR_DATED, ...REPORT_NOISE] : QUOTED_OR_DATED) {
    for (const match of text.matchAll(pattern)) exempt.push([match.index, match.index + match[0].length]);
  }
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
export function typedNumbersOf(template) {
  const withoutRefs = String(template ?? "").replace(NUMBER_REFERENCE_PATTERN, " ");
  return typedNumberSpans(withoutRefs).map((span) => span.raw);
}

/**
 * @typedef {object} RenderedReference
 * @property {string} ref the reference as written
 * @property {string} path
 * @property {string} format the format that was applied (`raw` when none or an unknown one was named)
 * @property {unknown} value what the path resolved to
 * @property {string} rendered the words that stand in the report
 * @property {boolean} ok
 * @property {string} [unit] the unit the result recorded for the value
 * @property {string} [reason] why it did not render, when it did not
 * @property {string} [unknownFormat] a format the reference named that is not one
 */

/**
 * Render a template against a resolver. The caller decides what a path is read
 * out of — a nested results document (`resolveNumberPath`), or a calculation's
 * flat machine values — and what the words around a refusal say; this returns
 * what happened, in the order it happened.
 *
 * @param {string} template the AI's prose with `{{n:…}}` references in it
 * @param {(path: string) => { value: unknown, unit: string | null }} resolve
 * @returns {{ text: string, bindings: RenderedReference[], unparsed: string[], typed: string[] }}
 */
export function renderNumberTemplate(template, resolve) {
  /** @type {RenderedReference[]} */
  const bindings = [];
  const source = String(template ?? "");
  /** @type {string[]} */
  const typed = [];
  /** @type {string[]} */
  const unparsed = [];

  /**
   * The digits one stretch of words types, replaced and counted.
   * @param {string} words
   */
  const withoutTyped = (words) => {
    let out = "";
    let cursor = 0;
    for (const span of typedNumberSpans(words)) {
      out += words.slice(cursor, span.start) + NUMBER_UNCOMPUTED;
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
    for (const found of words.matchAll(NUMBER_UNPARSED_PATTERN)) {
      out += withoutTyped(words.slice(cursor, found.index)) + NUMBER_UNCOMPUTED;
      unparsed.push(found[0].trim());
      cursor = found.index + found[0].length;
    }
    return out + withoutTyped(words.slice(cursor));
  };

  let text = "";
  let cursor = 0;
  for (const match of source.matchAll(NUMBER_REFERENCE_PATTERN)) {
    const [ref, rawPath, rawFormat] = match;
    text += prose(source.slice(cursor, match.index));
    cursor = match.index + ref.length;
    const path = String(rawPath);
    const known = !rawFormat || NUMBER_FORMATS.includes(String(rawFormat));
    const format = rawFormat && known ? String(rawFormat) : "raw";
    const { value, unit } = resolve(path);
    const rendered = formatNumberValue(value, format, unit);
    // The unit is kept beside the binding: it is why a percentage was not scaled.
    bindings.push({ ref: String(ref), path, format, value, rendered: rendered.text, ok: rendered.ok,
      ...(unit ? { unit } : {}), ...(rendered.reason ? { reason: rendered.reason } : {}),
      ...(rawFormat && !known ? { unknownFormat: String(rawFormat) } : {}) });
    text += rendered.text;
  }
  text += prose(source.slice(cursor));
  return { text, bindings, unparsed, typed };
}
