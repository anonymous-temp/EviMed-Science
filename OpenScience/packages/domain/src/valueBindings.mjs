/**
 * Value bindings (plan 2026-10-02 §11.3 N06): every number a report, table or
 * figure prints that came from a calculation, bound to (calculation version,
 * key, unit, formatting applied).
 *
 * A number the platform rendered from a reference is bound by construction; a
 * number someone typed is bound only if it equals a machine value at the
 * precision it is written with, and is otherwise listed as unbound. Unbound is
 * a label on the result, never a gate.
 *
 * Hidden knowledge:
 *
 * - **Same run is a candidate pool, not evidence of dependency.** The
 *   calculations a printed number may be bound to are the ones the same run
 *   produced; the *binding* is the value equality (or the platform's own
 *   rendering of a reference). A file and a calculation proximate in time are
 *   never recorded as a dependency.
 * - **The binding survives the rounding.** A report prints 0.71 for a machine
 *   value of 0.7134. The binding records the format that was applied (`f2`, or
 *   `round` to two places), so a later calculation that moves the value to
 *   0.7141 is recognised as still printing 0.71, and one that moves it to 0.68
 *   as a printed number that is now out of date.
 * - **A near miss is named.** A printed number within five per cent of a value
 *   but not equal to it is `differs_from_value` with that value beside it: the
 *   shape a mistyped number, or one a changed calculation left stale, takes.
 * - **Printed means the words of the file.** Years, ordinals up to twelve,
 *   dates, locators, a source's own words, citation markers, code and addresses
 *   are not numbers of the analysis, and a figure's `<text>` nodes are what a
 *   plotted value prints. A raster figure, a PDF or a Word file is
 *   `not_checkable` — said, not skipped.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/valueBindings
 */

import {
  NUMBER_FORMATS, NUMBER_UNCOMPUTED, formatNumberValue, renderNumberTemplate, typedNumberSpans,
} from "./numberBinding.mjs";
import {
  RESULT_LINEAGE_LIMITS, boundedText as text, digestOrNull, isRecord as isObject, nonNegativeInteger as integer, pathOrNull,
} from "./resultIdentity.mjs";

export { RESULT_LINEAGE_LIMITS };

/** The version of the rendering and matching rules a binding was made under. */
export const NUMBER_BINDING_VERSION = "1";

/** How a printed number is tied to a calculation value. */
export const VALUE_BINDING_BASES = Object.freeze(["rendered", "matched"]);

/** The overall state of a version's value bindings. */
export const VALUE_BINDING_STATUSES = Object.freeze([
  "bound", "partly_bound", "unbound", "no_numbers", "no_calculation", "not_checkable", "not_checked",
]);

/** Why a printed number is not bound to a machine value. */
export const UNBOUND_REASONS = Object.freeze(["no_matching_value", "differs_from_value", "ambiguous"]);

/** The formats a binding may record besides the reference formats. */
export const MATCHED_BINDING_FORMAT = "round";

// ---------------------------------------------------------------------------
// Machine values of a results document
// ---------------------------------------------------------------------------

/**
 * Every finite number a results document holds as a `{ key, value, unit }`, the
 * key being the path to it (`analyses[0].interval.lower`) and the unit the
 * nearest enclosing object's own `unit` when it states one (the same reading as
 * `resolveNumberPath`). Booleans, strings and non-finite numbers are not values.
 * Bounded; a document with more says so.
 * @param {unknown} document
 * @returns {{ values: Array<{ key: string, value: number, unit?: string }>, truncated: boolean }}
 */
export function flattenMachineValues(document) {
  /** @type {Array<{ key: string, value: number, unit?: string }>} */
  const values = [];
  let truncated = false;
  /** The keys whose number is in the unit its enclosing object states; every other number is on a scale of its own. */
  const unitBearing = ["value", "mcse", "low", "high", "estimate", "lower", "upper"];
  /** @param {unknown} node @param {string} key @param {string | null} unit @param {number} depth @param {string} name */
  const walk = (node, key, unit, depth, name) => {
    if (truncated || depth > 12) return;
    if (typeof node === "number") {
      if (!Number.isFinite(node) || !key) return;
      if (values.length >= RESULT_LINEAGE_LIMITS.machineValues) { truncated = true; return; }
      values.push({ key, value: node, ...(unit && unitBearing.includes(name) ? { unit } : {}) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${key}[${index}]`, unit, depth + 1, name));
      return;
    }
    if (!isObject(node)) return;
    const own = typeof node.unit === "string" && node.unit.trim() ? node.unit.trim().slice(0, 40) : unit;
    for (const [field, item] of Object.entries(node)) {
      if (!/^[A-Za-z0-9_一-鿿-]{1,80}$/.test(field) || field === "unit") continue;
      walk(item, key ? `${key}.${field}` : field, own, depth + 1, field);
    }
  };
  walk(document, "", null, 0, "");
  return { values, truncated };
}

// ---------------------------------------------------------------------------
// Value bindings
// ---------------------------------------------------------------------------

/**
 * @typedef {{ versionId: string, digest: string, path?: string | null, alias?: string | null,
 *   values: Array<{ key: string, value: number, unit?: string | null }> }} BindableCalculation
 */

/** @param {any} calculation @param {any} entry */
const calculationOf = (calculation, entry) => ({ versionId: calculation.versionId, digest: calculation.digest, key: entry.key, value: entry.value, unit: entry.unit ?? null });

/**
 * Where an offset is in a text: a 1-based line and a 0-based column. Built once
 * per text, so a report with hundreds of numbers is not rescanned for each.
 * @param {string} body
 * @returns {(offset: number) => { kind: "text", line: number, column: number }}
 */
export function locatorIndex(body) {
  /** @type {number[]} */
  const starts = [0];
  for (let index = 0; index < body.length; index += 1) if (body[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle; else high = middle - 1;
    }
    return { kind: "text", line: low + 1, column: offset - starts[low] };
  };
}

/** Decimal places a written number claims. @param {string} literal */
const placesOf = (literal) => { const dot = literal.indexOf("."); return dot === -1 ? 0 : literal.length - dot - 1; };

/**
 * Whether `value` is what `written` prints at `places` decimals. Whole numbers
 * are held to equality — a printed 46 is not an excuse to bind a weight of 46.3.
 * @param {number} value @param {number} written @param {number} places @param {boolean} percentSign
 */
function printsAs(value, written, places, percentSign) {
  if (places === 0 && !percentSign) return Number.isInteger(value) && value === written;
  return Math.abs(value - written) <= 0.5 * 10 ** -places * (1 + 1e-9);
}

/**
 * Every (calculation, key) a printed number equals, with how.
 * @param {{ written: number, places: number, percentSign: boolean, negative: boolean, grouped: boolean }} printed
 * @param {BindableCalculation[]} calculations
 */
function candidatesFor(printed, calculations) {
  /** @type {Array<{ calculation: BindableCalculation, entry: any, format: Record<string, any> }>} */
  const found = [];
  const seen = new Set();
  const signed = printed.negative ? -printed.written : printed.written;
  for (const calculation of calculations) {
    for (const entry of calculation.values) {
      for (const scale of printed.percentSign ? [1, 100] : [1]) {
        const candidate = entry.value * scale;
        const exact = printsAs(candidate, signed, printed.places, printed.percentSign);
        // A magnitude printed without its sign ("a reduction of 0.12" for -0.12) still states that value, and says it did.
        const magnitude = !exact && !printed.negative && candidate < 0 && printsAs(-candidate, printed.written, printed.places, printed.percentSign);
        if (!exact && !magnitude) continue;
        const identity = `${calculation.versionId}\u0000${entry.key}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        found.push({ calculation, entry, format: { id: MATCHED_BINDING_FORMAT, places: printed.places,
          ...(scale === 100 ? { scale: 100 } : {}), ...(printed.grouped ? { grouped: true } : {}), ...(magnitude ? { magnitude: true } : {}) } });
      }
    }
  }
  return found;
}

/**
 * The nearest machine value within five per cent of a printed number: the
 * shape a stale or mistyped number leaves.
 * @param {number} signed @param {BindableCalculation[]} calculations
 */
function nearestTo(signed, calculations) {
  /** @type {{ calculation: BindableCalculation, entry: any, distance: number } | null} */
  let best = null;
  for (const calculation of calculations) {
    for (const entry of calculation.values) {
      const scale = Math.max(Math.abs(entry.value), Math.abs(signed));
      if (scale === 0) continue;
      const distance = Math.abs(entry.value - signed) / scale;
      if (distance <= 0.05 && (!best || distance < best.distance)) best = { calculation, entry, distance };
    }
  }
  return best;
}

/** @param {string} body */
function textUnits(body) {
  // Lines outside code fences and before the reference list: the report's statements.
  const out = [];
  let fenced = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^\s*#{1,6}\s*(?:参考文献|参考来源|References?|Bibliography)\s*$/i.test(line)) break;
    out.push({ line, start });
  }
  return out;
}

/** The text of the `<text>` and `<title>` nodes of an SVG: what a plotted figure prints. @param {string} svg */
function svgTexts(svg) {
  const found = [];
  for (const match of svg.matchAll(/<(text|title)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const inner = match[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#45;|&minus;/g, "-").trim();
    if (inner) found.push(inner);
  }
  return found;
}

/** @param {string} cell */
function cellNumber(cell) {
  const trimmed = cell.trim().replace(/^"|"$/g, "").trim();
  const match = /^([-−+]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(trimmed);
  if (!match) return null;
  const literal = match[2].replace(/,/g, "");
  return { raw: match[2], negative: match[1] === "-" || match[1] === "−", literal, percentSign: match[3] === "%" };
}

/** @param {string} line @param {string} separator */
function splitDelimited(line, separator) {
  /** @type {string[]} */
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted;
    } else if (character === separator && !quoted) { cells.push(current); current = ""; } else current += character;
  }
  cells.push(current);
  return cells;
}

/**
 * The kind of file a printed number is looked for in, decided by its type: text
 * a reader reads, a delimited table, a vector figure with text in it, a results
 * document of machine values (never scanned), or a format whose numbers this
 * cannot read.
 * @param {string} path @param {string} [mimeType]
 * @returns {"text" | "table" | "svg" | "values" | "binary"}
 */
export function bindableKind(path, mimeType = "") {
  const lower = path.toLowerCase();
  if (/\.(md|markdown|txt|html?)$/.test(lower) || mimeType === "text/markdown" || mimeType === "text/html" || mimeType === "text/plain") return "text";
  if (/\.(csv|tsv)$/.test(lower) || mimeType === "text/csv") return "table";
  if (/\.svg$/.test(lower) || mimeType === "image/svg+xml") return "svg";
  if (/\.json$/.test(lower) || mimeType === "application/json") return "values";
  return "binary";
}

/**
 * Every number a file prints, in the order it prints them, each with where it stands: the one reading of "printed"
 * that binding a number to a calculation and comparing what two files print both use, so the two cannot disagree on
 * what a number of the analysis is. Text is read by its statements, a delimited table by its cells, a figure by the
 * text it draws; anything else prints nothing this reads.
 * @param {{ body: string, kind: string, path: string, skip?: Array<[number, number]>,
 *   visit: (number: { raw: string, negative: boolean, percentSign: boolean }, locator: Record<string, any>) => void,
 *   stopped?: () => boolean }} input `skip`: stretches of `body` not to read; `stopped`: whether the caller wants no more
 */
function scanPrintedNumbers({ body, kind, path, skip = [], visit, stopped = () => false }) {
  if (kind === "text") {
    const locate = locatorIndex(body);
    for (const { line, start } of textUnits(body)) {
      if (stopped()) break;
      for (const span of typedNumberSpans(line, { report: true })) {
        const at = start + span.start;
        if (skip.some(([from, to]) => at >= from && at < to)) continue;
        const before = line.slice(Math.max(0, span.start - 2), span.start);
        // A minus sign, not the dash of a range (`0.52–0.91`) or a list marker.
        const negative = /(?:^|[^\d)\]])[-−]$/.test(before);
        visit({ raw: span.raw, negative, percentSign: line[span.end] === "%" }, locate(at));
      }
    }
  } else if (kind === "table") {
    const separator = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    body.split(/\r?\n/).forEach((line, row) => {
      if (stopped()) return;
      splitDelimited(line, separator).forEach((cell, column) => {
        const number = cellNumber(cell);
        if (!number) return;
        const value = Number(number.literal);
        if (Number.isInteger(value) && value >= 1900 && value <= 2100 && !number.raw.includes(".")) return;
        visit(number, { kind: "cell", row: row + 1, column: column + 1 });
      });
    });
  } else if (kind === "svg") {
    svgTexts(body).forEach((label, index) => {
      for (const span of typedNumberSpans(label, { report: true })) {
        const before = label.slice(Math.max(0, span.start - 2), span.start);
        visit({ raw: span.raw, negative: /(?:^|[^\d)\]])[-−]$/.test(before), percentSign: label[span.end] === "%" }, { kind: "svg", index: index + 1 });
      }
    });
  }
}

/** The words a printed number is shown as: its sign, its digits as written, its percent sign. @param {{ raw: string, negative: boolean, percentSign: boolean }} number */
const shownWords = (number) => `${number.negative ? "-" : ""}${number.raw}${number.percentSign ? "%" : ""}`;

/** The most numbers one file's words list holds; past it the list says it is cut and nothing is compared from it. */
const PRINTED_WORDS_LIMIT = 5000;

/**
 * The words of the numbers a file prints, in print order, with no calculation to compare them to: what two versions of
 * a file are compared by when the question is whether their numbers moved (`resultCorrection.mjs`). `checkable` is
 * false for a file whose numbers this cannot read (a results document, whose numbers are its values; a raster figure, a
 * PDF or a Word file) and for one with more numbers than the list holds: such a file is unknown, never "unchanged".
 * @param {{ body: string, path: string, mimeType?: string }} input
 * @returns {{ kind: "text" | "table" | "svg" | "values" | "binary", checkable: boolean, words: string[] }}
 */
export function printedNumberWords({ body, path, mimeType = "" }) {
  const kind = bindableKind(path, mimeType);
  if (kind === "binary" || kind === "values") return { kind, checkable: false, words: [] };
  /** @type {string[]} */
  const words = [];
  scanPrintedNumbers({ body, kind, path, visit: (number) => { words.push(shownWords(number)); }, stopped: () => words.length > PRINTED_WORDS_LIMIT });
  return words.length > PRINTED_WORDS_LIMIT ? { kind, checkable: false, words: [] } : { kind, checkable: true, words };
}

/**
 * Bind the numbers a file prints to the calculation values that state them.
 *
 * A number is bound when exactly one (calculation, key) equals it at the
 * precision it is written with — `0.71` for 0.7134, `41.2%` for 41.234 or for a
 * fraction 0.41234. More than one is `ambiguous`; none within five per cent is
 * `no_matching_value`; one that is near is `differs_from_value` with the nearest
 * value named, which is the shape a number left stale by a changed calculation
 * takes. Years, ordinals up to twelve, dates, locators, quoted source words,
 * citation markers, code and addresses are not numbers of the analysis
 * (`typedNumberSpans`), and neither are lines inside a code fence or after the
 * reference list.
 *
 * @param {{ body: string, path: string, mimeType?: string, calculations: BindableCalculation[],
 *   skip?: Array<[number, number]> }} input `skip`: stretches of `body` already bound by rendering
 */
export function bindPrintedNumbers({ body, path, mimeType = "", calculations, skip = [] }) {
  const kind = bindableKind(path, mimeType);
  /** @type {Array<Record<string, any>>} */
  const items = [];
  /** @type {Array<Record<string, any>>} */
  const unbound = [];
  let examined = 0;
  let truncated = false;
  const usable = calculations.slice(0, RESULT_LINEAGE_LIMITS.calculations);
  // Past either bound the record is full: what is listed is labelled, the rest is said not to be, and the scan stops
  // rather than comparing a megabyte of numbers against every value.
  const full = () => truncated;

  /** @param {{ raw: string, negative: boolean, percentSign: boolean }} number @param {Record<string, any>} locator */
  const bindOne = (number, locator) => {
    if (full()) return;
    const literal = number.raw.replace(/,/g, "");
    const written = Number(literal);
    if (!Number.isFinite(written)) return;
    examined += 1;
    const printed = { written, places: placesOf(literal), percentSign: number.percentSign, negative: number.negative, grouped: number.raw.includes(",") };
    const shown = shownWords(number);
    const found = candidatesFor(printed, usable);
    if (found.length === 1) {
      if (items.length >= RESULT_LINEAGE_LIMITS.bindings) { truncated = true; return; }
      items.push({ basis: "matched", locator, printed: shown, calculation: calculationOf(found[0].calculation, found[0].entry), format: found[0].format });
      return;
    }
    if (unbound.length >= RESULT_LINEAGE_LIMITS.unbound) { truncated = true; return; }
    if (found.length > 1) {
      unbound.push({ locator, printed: shown, reason: "ambiguous",
        candidates: found.slice(0, RESULT_LINEAGE_LIMITS.candidates).map((hit) => ({ versionId: hit.calculation.versionId, key: hit.entry.key })) });
      return;
    }
    const near = nearestTo(number.negative ? -written : written, usable);
    unbound.push(near
      ? { locator, printed: shown, reason: "differs_from_value", candidates: [{ versionId: near.calculation.versionId, key: near.entry.key, value: near.entry.value }] }
      : { locator, printed: shown, reason: "no_matching_value" });
  };

  scanPrintedNumbers({ body, kind, path, skip, visit: bindOne, stopped: full });
  return { kind, items, unbound, examined, truncated };
}

/**
 * The state of a version's bindings, from what scanning and rendering found.
 * @param {{ kind: string, calculations: number, items: number, unbound: number, examined: number, rendered?: number }} counts
 * @returns {string}
 */
export function valueBindingStatus({ kind, calculations, items, unbound, examined, rendered = 0 }) {
  if (kind === "values") return "not_checked";
  if (calculations === 0) return "no_calculation";
  if (kind === "binary") return "not_checkable";
  if (!examined && !rendered) return "no_numbers";
  if (unbound === 0) return "bound";
  return items + rendered > 0 ? "partly_bound" : "unbound";
}

/**
 * Render a template against the machine values of named calculations, and bind
 * what is left. A reference's first path segment names the calculation (its
 * alias), the rest is the key: `{{n:pool.values.pooled_effect|f2}}`. The
 * platform writes the number, so what a reader sees is the machine value in the
 * recorded format; numbers the template typed itself stay in the text (they are
 * a researcher's own statements) and are matched or listed as unbound.
 *
 * @param {{ template: string, path: string, mimeType?: string, calculations: BindableCalculation[] }} input
 */
export function renderWithBindings({ template, path, mimeType = "", calculations }) {
  const byAlias = new Map(calculations.filter((calculation) => calculation.alias).map((calculation) => [calculation.alias, calculation]));
  const rendered = renderNumberTemplate(template, (reference) => {
    const dot = reference.indexOf(".");
    const calculation = dot > 0 ? byAlias.get(reference.slice(0, dot)) : undefined;
    const entry = calculation?.values.find((candidate) => candidate.key === reference.slice(dot + 1));
    return entry ? { value: entry.value, unit: entry.unit ?? null } : { value: undefined, unit: null };
  }, { typed: "keep" });
  /** @type {Array<Record<string, any>>} */
  const items = [];
  /** @type {Array<Record<string, any>>} */
  const unresolved = [];
  /** @type {Array<[number, number]>} */
  const skip = [];
  const locate = locatorIndex(rendered.text);
  for (const binding of rendered.bindings) {
    const dot = binding.path.indexOf(".");
    const calculation = dot > 0 ? byAlias.get(binding.path.slice(0, dot)) : undefined;
    const entry = calculation?.values.find((candidate) => candidate.key === binding.path.slice(dot + 1));
    if (!binding.ok || !calculation || !entry) {
      if (unresolved.length < RESULT_LINEAGE_LIMITS.unresolved) unresolved.push({ path: binding.path.slice(0, 200), reason: !calculation || !entry ? "no_such_value" : (binding.reason ?? "unbound") });
      continue;
    }
    skip.push([binding.offset, binding.offset + binding.rendered.length]);
    if (items.length < RESULT_LINEAGE_LIMITS.bindings) {
      items.push({ basis: "rendered", locator: locate(binding.offset), printed: binding.rendered,
        calculation: calculationOf(calculation, entry), format: { id: binding.format } });
    }
  }
  const scanned = bindPrintedNumbers({ body: rendered.text, path, mimeType, calculations, skip });
  return { text: rendered.text, unparsed: rendered.unparsed, unresolved, items: [...items, ...scanned.items],
    unbound: scanned.unbound, examined: scanned.examined, renderedCount: items.length, truncated: scanned.truncated, kind: scanned.kind };
}

/**
 * The stored shape of a version's value bindings.
 * @param {{ kind: string, calculations: BindableCalculation[], items: any[], unbound: any[], examined: number, renderedCount?: number,
 *   truncated?: boolean, unresolved?: any[] }} found
 */
export function valueBindingRecord(found) {
  const status = valueBindingStatus({ kind: found.kind, calculations: found.calculations.length, items: found.items.length,
    unbound: found.unbound.length, examined: found.examined, rendered: found.renderedCount ?? 0 });
  return projectValueBindings({ schemaVersion: 1, status, version: NUMBER_BINDING_VERSION,
    calculations: found.calculations.map((calculation) => ({ versionId: calculation.versionId, digest: calculation.digest, path: calculation.path ?? null,
      alias: calculation.alias ?? null })),
    items: found.items, unbound: found.unbound, unresolved: found.unresolved ?? [], truncated: found.truncated === true });
}

/** What a version no scan has reached says. */
export function emptyValueBindings() {
  return projectValueBindings({ status: "not_checked" });
}

/** @param {unknown} raw */
function projectLocator(raw) {
  if (!isObject(raw)) return { kind: "text", line: 1, column: 0 };
  if (raw.kind === "cell") return { kind: "cell", row: integer(raw.row) ?? 0, column: integer(raw.column) ?? 0 };
  if (raw.kind === "svg") return { kind: "svg", index: integer(raw.index) ?? 0 };
  return { kind: "text", line: integer(raw.line) ?? 1, column: integer(raw.column) ?? 0 };
}

/** @param {unknown} raw */
function projectBindingFormat(raw) {
  if (!isObject(raw)) return { id: "raw" };
  const id = typeof raw.id === "string" ? raw.id : "raw";
  if (id === MATCHED_BINDING_FORMAT) {
    return { id, places: Math.min(integer(raw.places) ?? 0, 12), ...(raw.scale === 100 ? { scale: 100 } : {}),
      ...(raw.grouped === true ? { grouped: true } : {}), ...(raw.magnitude === true ? { magnitude: true } : {}) };
  }
  return { id: NUMBER_FORMATS.includes(id) ? id : "raw" };
}

/**
 * The closed projection of stored value bindings. A binding names a calculation
 * version, a key, a value and the format that produced the printed words; it
 * carries no prose of the report beyond the number itself.
 * @param {unknown} raw
 */
export function projectValueBindings(raw) {
  const source = isObject(raw) ? raw : {};
  const status = /** @type {string} */ (VALUE_BINDING_STATUSES.includes(source.status) ? source.status : "not_checked");
  const calculations = Array.isArray(source.calculations) ? source.calculations.slice(0, RESULT_LINEAGE_LIMITS.calculations).flatMap((item) => {
    const versionId = isObject(item) && typeof item.versionId === "string" && /^rv_[a-f0-9]{64}$/.test(item.versionId) ? item.versionId : null;
    return versionId ? [{ versionId, digest: digestOrNull(item.digest), path: pathOrNull(item.path), alias: text(item.alias, 40) }] : [];
  }) : [];
  const items = Array.isArray(source.items) ? source.items.slice(0, RESULT_LINEAGE_LIMITS.bindings).flatMap((item) => {
    const calculation = isObject(item) ? item.calculation : null;
    const versionId = isObject(calculation) && typeof calculation.versionId === "string" && /^rv_[a-f0-9]{64}$/.test(calculation.versionId) ? calculation.versionId : null;
    const key = isObject(calculation) ? text(calculation.key, 512) : null;
    const printed = isObject(item) ? text(item.printed, 80) : null;
    if (!versionId || !key || !printed || !Number.isFinite(calculation?.value)) return [];
    return [{ basis: /** @type {string} */ (VALUE_BINDING_BASES.includes(item.basis) ? item.basis : "matched"), locator: projectLocator(item.locator), printed,
      calculation: { versionId, digest: digestOrNull(calculation.digest), key, value: calculation.value, unit: text(calculation.unit, 40) },
      format: projectBindingFormat(item.format) }];
  }) : [];
  const unbound = Array.isArray(source.unbound) ? source.unbound.slice(0, RESULT_LINEAGE_LIMITS.unbound).flatMap((item) => {
    const printed = isObject(item) ? text(item.printed, 80) : null;
    if (!printed) return [];
    const candidates = Array.isArray(item.candidates) ? item.candidates.slice(0, RESULT_LINEAGE_LIMITS.candidates).flatMap((/** @type {any} */ candidate) => {
      const key = isObject(candidate) ? text(candidate.key, 512) : null;
      const versionId = isObject(candidate) && typeof candidate.versionId === "string" && /^rv_[a-f0-9]{64}$/.test(candidate.versionId) ? candidate.versionId : null;
      return key && versionId ? [{ versionId, key, ...(Number.isFinite(candidate.value) ? { value: candidate.value } : {}) }] : [];
    }) : [];
    return [{ locator: projectLocator(item.locator), printed, reason: /** @type {string} */ (UNBOUND_REASONS.includes(item.reason) ? item.reason : "no_matching_value"), candidates }];
  }) : [];
  const unresolved = Array.isArray(source.unresolved) ? source.unresolved.slice(0, RESULT_LINEAGE_LIMITS.unresolved).flatMap((item) => {
    const path = isObject(item) ? text(item.path, 200) : null;
    return path ? [{ path, reason: text(item.reason, 40) ?? "unbound" }] : [];
  }) : [];
  return { schemaVersion: 1, status, version: text(source.version, 20) ?? NUMBER_BINDING_VERSION, calculations, items, unbound, unresolved,
    counts: { bound: items.length, rendered: items.filter((item) => item.basis === "rendered").length, unbound: unbound.length,
      ambiguous: unbound.filter((item) => item.reason === "ambiguous").length, unresolved: unresolved.length },
    truncated: source.truncated === true };
}

/**
 * The gaps value bindings add to a version's coverage.
 * @param {any} bindings @returns {string[]}
 */
export function bindingGaps(bindings) {
  if (!bindings) return [];
  /** @type {string[]} */
  const gaps = [];
  if (bindings.counts?.unbound > 0) gaps.push("values_unbound");
  if (bindings.counts?.unresolved > 0) gaps.push("values_unresolved");
  if (bindings.status === "not_checkable") gaps.push("values_not_checkable");
  return gaps;
}

/** The calculation versions a set of bindings (or their unbound near-misses) names, for the dependents index. @param {any} bindings */
export function bindingSources(bindings) {
  return [...new Set((bindings?.items ?? []).map((/** @type {any} */ item) => item.calculation.versionId))].slice(0, RESULT_LINEAGE_LIMITS.calculations);
}

// ---------------------------------------------------------------------------
// Change: which printed values depend on a calculation, and which of them move
// ---------------------------------------------------------------------------

/**
 * The words a binding's format would print for a value now, or null when the
 * format cannot be applied to it. This is what lets a binding survive a
 * rounding: the question is never whether the machine value is the same, but
 * whether the recorded transformation still yields the printed words.
 * @param {any} format @param {number} value @param {string | null} unit
 * @returns {string | null}
 */
export function applyBindingFormat(format, value, unit) {
  if (format?.id === MATCHED_BINDING_FORMAT) {
    const scaled = (format.scale === 100 ? value * 100 : value);
    const shown = format.magnitude ? Math.abs(scaled) : scaled;
    let words = shown.toFixed(Math.min(Number(format.places) || 0, 12));
    if (format.grouped) {
      const [whole, fraction] = words.split(".");
      words = `${Number(whole).toLocaleString("en-US")}${fraction !== undefined ? `.${fraction}` : ""}`;
    }
    return words;
  }
  const rendered = formatNumberValue(value, NUMBER_FORMATS.includes(format?.id) ? format.id : "raw", unit);
  return rendered.ok && rendered.text !== NUMBER_UNCOMPUTED ? rendered.text : null;
}

/**
 * Whether two renderings are the same words. A matched number's printed words
 * keep the percent sign the text carried and the sign it was written with; the
 * format's own output has the number alone.
 * @param {string} now @param {string} printed
 */
const sameWords = (now, printed) => {
  const plain = (/** @type {string} */ words) => words.replace(/−/g, "-").replace(/%$/, "");
  return plain(now) === plain(printed);
};

/**
 * What moved under the printed values of each dependent when one calculation is
 * replaced by its successor. Only the values bound to `before` are looked at;
 * everything else — other bindings, other versions — keeps its identity and is
 * not listed.
 *
 * For each bound value: `unchanged` when the successor's value still prints the
 * same words under the recorded format (the binding survived), `changed` when
 * it prints different ones, `removed` when the successor no longer has the key,
 * `unit_changed` when it states another unit. A dependent with any value that is
 * not `unchanged` `needsSuccessor`.
 *
 * @param {{ before: { versionId: string, machineValues: any[] }, after: { versionId: string, machineValues: any[] },
 *   dependents: Array<{ versionId: string, path: string, bindings: any }> }} input
 */
export function changeImpact({ before, after, dependents }) {
  const current = new Map((after.machineValues ?? []).map((/** @type {any} */ value) => [value.key, value]));
  const rows = dependents.map((dependent) => {
    const mine = (dependent.bindings?.items ?? []).filter((/** @type {any} */ item) => item.calculation.versionId === before.versionId);
    /** @type {Array<Record<string, any>>} */
    const affected = [];
    let unchanged = 0;
    for (const item of mine) {
      const now = current.get(item.calculation.key);
      /** @type {string} */
      let status;
      /** @type {string | null} */
      let printedNow = null;
      if (!now || !Number.isFinite(now.value)) status = "removed";
      else if ((now.unit ?? null) !== (item.calculation.unit ?? null)) status = "unit_changed";
      else {
        printedNow = applyBindingFormat(item.format, now.value, now.unit ?? null);
        status = printedNow !== null && sameWords(printedNow, item.printed) ? "unchanged" : "changed";
      }
      if (status === "unchanged") { unchanged += 1; continue; }
      affected.push({ locator: item.locator, printed: item.printed, key: item.calculation.key, unit: item.calculation.unit,
        before: item.calculation.value, after: now?.value ?? null, printedNow, status });
    }
    return { versionId: dependent.versionId, path: dependent.path, bound: mine.length, affected, unchanged, needsSuccessor: affected.length > 0 };
  }).filter((row) => row.bound > 0);
  return { beforeVersionId: before.versionId, afterVersionId: after.versionId, dependents: rows,
    summary: { dependents: rows.length, affectedValues: rows.reduce((sum, row) => sum + row.affected.length, 0),
      unaffectedValues: rows.reduce((sum, row) => sum + row.unchanged, 0), needSuccessor: rows.filter((row) => row.needsSuccessor).length } };
}
