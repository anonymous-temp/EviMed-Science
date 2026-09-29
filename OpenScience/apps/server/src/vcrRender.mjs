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
 * - **A number typed into the template is reported, not removed.** Some
 *   numbers legitimately belong in prose — a protocol's own 「第 12 页」, a
 *   year, a criterion's 「≥18 岁」 — so `typed` is a list the reviewer reads,
 *   not a refusal. Years, small ordinals and anything inside a reference are
 *   never counted.
 * - **An interval is never rendered bare** (plan §8.3): the `ci` format prints
 *   which kind of interval it is, in Chinese, from the interval's own `kind`.
 *   A simulated measure printed with `pm` carries its Monte-Carlo standard
 *   error, because that is the only honest way to print a simulated number
 *   (AC-28).
 * - **`vcrReportModel` is the other half.** It builds the `results.json` a
 *   package ships, from the study's own rows, so the template's references and
 *   the contract's traceability check read the same document.
 *
 * @module vcrRender
 */

import { VCR_COUNT_KEYS, VCR_INTERVAL_KIND_LABELS_ZH, VCR_VALUE_SOURCE_LABELS_ZH } from "@evimed/domain";

/**
 * A number reference in a template: `{{n:<path>}}` or `{{n:<path>|<format>}}`.
 * A path segment may carry arguments in parentheses — `measure(power)`,
 * `measure(power, scenario=scn_x)` — and inside them anything but `)` `}` `|`.
 */
export const VCR_NUMBER_PATTERN = /\{\{\s*n:((?:[A-Za-z0-9_.[\]一-鿿-]|\([^)}|]*\))+?)\s*(?:\|\s*([a-z0-9]+)\s*)?\}\}/g;

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
 * Read one path out of a results document. Understands dotted keys, array
 * indices, and `measure(<name>)` — which is how a template names a measure
 * without depending on the order the engine happened to return them in.
 * @param {unknown} root @param {string} path
 */
export function vcrReadPath(root, path) {
  let value = root;
  for (const rawSegment of String(path).split(".")) {
    if (value == null) return undefined;
    const segment = rawSegment.trim();
    if (!segment) return undefined;
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
 * Render one resolved value in the format the reference asked for.
 * @param {unknown} value @param {string} format
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export function vcrFormatValue(value, format) {
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
  switch (format) {
    case "int": return { ok: true, text: String(Math.round(number)) };
    case "f1": return { ok: true, text: fixed(number, 1) };
    case "f2": return { ok: true, text: fixed(number, 2) };
    case "f3": return { ok: true, text: fixed(number, 3) };
    case "pct0": return { ok: true, text: `${fixed(number * 100, 0)}%` };
    case "pct1": return { ok: true, text: `${fixed(number * 100, 1)}%` };
    case "pct2": return { ok: true, text: `${fixed(number * 100, 2)}%` };
    case "thousands": return { ok: true, text: grouped(number) };
    case "months": return { ok: true, text: `${fixed(number, 1)} 个月` };
    default: return { ok: true, text: String(number) };
  }
}

/**
 * Numbers a template typed instead of referencing. Years, ordinals up to
 * twelve and everything inside a `{{n:…}}` reference are not counted.
 * @param {string} template
 */
export function vcrTypedNumbers(template) {
  const withoutRefs = String(template ?? "").replace(VCR_NUMBER_PATTERN, " ");
  /** @type {string[]} */
  const found = [];
  const pattern = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![\w.])/g;
  let match;
  while ((match = pattern.exec(withoutRefs))) {
    const raw = match[1];
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    if (Number.isInteger(value) && value <= 12) continue;
    found.push(raw);
  }
  return found;
}

/**
 * Render a report template against a results document.
 *
 * @param {string} template the AI's prose with `{{n:…}}` references in it
 * @param {Record<string, any>} results the study's `results.json`
 * @returns {{ text: string, bindings: Array<{ ref: string, path: string, format: string, value: unknown, rendered: string, ok: boolean }>,
 *   issues: Array<{ code: string, path: string, message: string, severity: string }>, typed: string[] }}
 */
export function renderVcrNumbers(template, results) {
  /** @type {Array<{ ref: string, path: string, format: string, value: unknown, rendered: string, ok: boolean }>} */
  const bindings = [];
  /** @type {Array<{ code: string, path: string, message: string, severity: string }>} */
  const issues = [];
  const document = object(results);
  const text = String(template ?? "").replace(VCR_NUMBER_PATTERN, (ref, rawPath, rawFormat) => {
    const path = String(rawPath);
    const format = rawFormat && VCR_NUMBER_FORMATS.includes(String(rawFormat)) ? String(rawFormat) : "raw";
    if (rawFormat && !VCR_NUMBER_FORMATS.includes(String(rawFormat))) {
      issues.push({ code: "vcr_number_format_unknown", path,
        message: `「${rawFormat}」不是已知的数字格式，按原值呈现。`, severity: "advisory" });
    }
    const value = vcrReadPath(document, path);
    const rendered = vcrFormatValue(value, format);
    bindings.push({ ref: String(ref), path, format, value, rendered: rendered.text, ok: rendered.ok });
    if (!rendered.ok) {
      issues.push({
        code: rendered.reason === "mcse_missing" ? "vcr_number_mcse_missing"
          : rendered.reason === "interval_kind_unnamed" ? "vcr_interval_unnamed" : "vcr_number_unbound",
        path,
        message: rendered.reason === "mcse_missing" ? `「${path}」是仿真结果但没有蒙特卡洛标准误（AC-28）。`
          : rendered.reason === "interval_kind_unnamed" ? `「${path}」的区间没有写明是哪一种（方案 §8.3）。`
            : `结果里没有「${path}」，报告此处写「${VCR_UNCOMPUTED}」。`,
        severity: "advisory",
      });
    }
    return rendered.text;
  });
  const typed = vcrTypedNumbers(template);
  if (typed.length) {
    issues.push({ code: "vcr_number_typed", path: "",
      message: `模板里有 ${typed.length} 个手写数字（${typed.slice(0, 5).join("、")}${typed.length > 5 ? "…" : ""}）：报告里的数应由结果渲染（方案 §8.3）。`,
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
    definition: input.definition ? {
      version: Number(object(input.definition).version ?? 0),
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
        sources: list(card.sources).length ? list(card.sources) : list(card.evidence),
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
        return { kind: row.kind ?? null, state: row.state ?? null, reviewer: row.reviewer ?? null, nodes: list(row.nodes).map(String),
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
