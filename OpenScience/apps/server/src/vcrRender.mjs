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
import {
  documentExportDigest, VCR_COUNT_KEYS, VCR_VALUE_SOURCE_LABELS_ZH,
  NUMBER_FORMATS, NUMBER_REFERENCE_PATTERN, NUMBER_UNCOMPUTED, NUMBER_UNIT_FORMATS,
  formatNumberValue, readNumberPath, renderNumberTemplate, resolveNumberPath, typedNumbersOf,
} from "@evimed/domain";

// The mechanism itself — the grammar, the path reader, the formats, the unit
// rules and the typed-number detector — lives in `@evimed/domain`'s
// `numberBinding.mjs`, where the meta-analysis and statistical reports read it
// too (plan 2026-10-02 §11.3 N06). What stays here is what is 「虚拟临研」's own:
// the issue codes, the Chinese sentences the run is told, and the study's
// `results.json`.

/** A number reference in a template: `{{n:<path>}}` or `{{n:<path>|<format>}}`. */
export const VCR_NUMBER_PATTERN = NUMBER_REFERENCE_PATTERN;

/** What a reference renders as when the study has no such result yet. */
export const VCR_UNCOMPUTED = NUMBER_UNCOMPUTED;

/** The formats a reference may ask for. */
export const VCR_NUMBER_FORMATS = NUMBER_FORMATS;

/** The formats that print a unit, and so have to agree with the one recorded. */
export const VCR_UNIT_FORMATS = NUMBER_UNIT_FORMATS;

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * Read one path out of a results document (see `readNumberPath`).
 * @param {unknown} root @param {string} path
 */
export const vcrReadPath = (root, path) => readNumberPath(root, path);

/**
 * Read one path and the unit the result recorded for the number it ends at (see `resolveNumberPath`).
 * @param {unknown} root @param {string} path
 * @returns {{ value: unknown, unit: string | null }}
 */
export const vcrResolvePath = (root, path) => resolveNumberPath(root, path);

/**
 * Render one resolved value in the format the reference asked for (see `formatNumberValue`).
 * @param {unknown} value @param {string} format @param {string | null} [unit]
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export const vcrFormatValue = (value, format, unit = null) => formatNumberValue(value, format, unit);

/**
 * Numbers a template typed instead of referencing. Years, ordinals up to
 * twelve and everything inside a `{{n:…}}` reference are not counted.
 * @param {string} template
 */
export const vcrTypedNumbers = (template) => typedNumbersOf(template);

/**
 * Render a report template against a results document.
 *
 * @param {string} template the AI's prose with `{{n:…}}` references in it
 * @param {Record<string, any>} results the study's `results.json`
 * @returns {{ text: string, bindings: Array<{ ref: string, path: string, format: string, value: unknown, rendered: string, ok: boolean, unit?: string }>,
 *   issues: Array<{ code: string, path: string, message: string, severity: string, reason?: string, unit?: string | null, format?: string }>, typed: string[] }}
 */
export function renderVcrNumbers(template, results) {
  /** @type {Array<{ code: string, path: string, message: string, severity: string, reason?: string, unit?: string | null, format?: string }>} */
  const issues = [];
  const document = object(results);
  const rendered = renderNumberTemplate(template, (path) => resolveNumberPath(document, path));
  const bindings = rendered.bindings.map(({ ref, path, format, value, rendered: text, ok, unit }) => ({ ref, path, format, value, rendered: text, ok, ...(unit ? { unit } : {}) }));
  for (const binding of rendered.bindings) {
    const { path, format, unit, reason, unknownFormat } = binding;
    if (unknownFormat) {
      issues.push({ code: "vcr_number_format_unknown", path,
        message: `「${unknownFormat}」不是已知的数字格式，按原值呈现。`, severity: "advisory" });
    }
    if (binding.ok) continue;
    issues.push({
      // A unit the format cannot be true of is filed with the references that
      // did not bind — the report reads 「未计算」 there just the same — and the
      // sentence says which unit and which format, so the run changes the
      // format rather than looking for a field that is not missing.
      code: reason === "mcse_missing" ? "vcr_number_mcse_missing"
        : reason === "interval_kind_unnamed" ? "vcr_interval_unnamed" : "vcr_number_unbound",
      path,
      message: reason === "mcse_missing" ? `「${path}」是仿真结果但没有蒙特卡洛标准误（AC-28）。`
        : reason === "interval_kind_unnamed" ? `「${path}」的区间没有写明是哪一种（方案 §8.3）。`
          : reason === "unit_mismatch"
            ? `「${path}」在结果里记的单位是「${unit}」，不能按 ${format} 呈现，报告此处写「${VCR_UNCOMPUTED}」；改用 f1、f2 这类不带单位的格式，单位写在文字里。`
            : `结果里没有「${path}」，报告此处写「${VCR_UNCOMPUTED}」。`,
      severity: "advisory",
      ...(reason === "unit_mismatch" ? { reason: "unit_mismatch", unit, format } : {}),
    });
  }
  for (const found of rendered.unparsed) {
    issues.push({ code: "vcr_number_unparsed", path: found.slice(0, 80),
      message: `「${found.slice(0, 80)}」读不成数字引用，报告此处写「${VCR_UNCOMPUTED}」；引用写成 {{n:路径|格式}}，格式用小写。`,
      severity: "advisory" });
  }
  if (rendered.typed.length) {
    issues.push({ code: "vcr_number_typed", path: "",
      message: `模板里有 ${rendered.typed.length} 个手写数字（${rendered.typed.slice(0, 5).join("、")}${rendered.typed.length > 5 ? "…" : ""}）：报告里这些位置写了「${VCR_UNCOMPUTED}」，数应由结果渲染（方案 §8.3）；改成引用。`,
      severity: "advisory" });
  }
  return { text: rendered.text, bindings, issues, typed: rendered.typed };
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
