/**
 * Evidence parameterization: from a research question to a set of assumption
 * cards whose every number can be found, word for word, in a source
 * (build plan 2026-09-28 §6.2, AC-25).
 *
 * The pipeline is five steps and each one is separately callable, because a
 * study resumes in the middle far more often than it starts at the beginning:
 *
 *   1. `findPrecedents`  — query the registries for candidates (similarity
 *      ranks candidates and decides nothing else);
 *   2. `extractPrecedent` — pull every quotable value out of one record and
 *      check each quotation against the preserved text before it is stored;
 *   3. `poolParameter`   — hand the verified values to the engine's
 *      `evidence.pool`, once per calibre;
 *   4. `saveAssumptionFromPooling` — turn the engine's pooled value,
 *      heterogeneity and prediction interval into the distribution a
 *      simulation draws from;
 *   5. `applicability`   — say how the source population differs from this
 *      study's, and which calibre is the default.
 *
 * Hidden knowledge:
 *
 * - **Nothing here estimates anything.** The pooled value, τ², I² and the
 *   prediction interval all come back from `vcr-engine` (`evidence.pool`,
 *   cross-checked against metafor). The arithmetic in this module is the
 *   closed-form change of scale a pooling job needs to be posed on — the
 *   analysis scale's estimate and standard error from a value and its
 *   confidence interval — and the closed-form re-parameterization of the
 *   engine's numbers into a distribution family (proportion → Beta by moment
 *   matching, time and hazard ratio → log-normal); `vcrEvidence.test.mjs` pins
 *   each against a hand-worked value. If the engine cannot be reached, a card
 *   is not produced: 「引擎不可用」 is an answer, a made-up mean is not.
 * - **The job is the engine's contract, not ours** (integration contract §3.1).
 *   A pooling study is `{ studyId, estimate, se }` on the analysis scale; the
 *   engine never receives a natural-scale value it must transform, and a scenario
 *   key it does not read is refused. What the pool is *about* (the parameter,
 *   the endpoint key, the calibre) travels in the job's own record, not in the
 *   scenario.
 * - **The prediction interval is the range a simulation may use**, not the
 *   confidence interval (plan §6.1). With fewer than three studies the engine
 *   states there is none, and the card says so instead of borrowing the
 *   confidence interval: the value becomes an expert setting, widened, labelled
 *   「专家设定·待补证」 — the plan's own answer to evidence too thin to justify a
 *   range (§6.2).
 * - **A quotation is checked with the platform's own comparison**
 *   (`quoteIsPresent` from `@evimed/domain/clinical-evidence`), the same one
 *   the delivery gate and the reader's ✓/⚠ use. A second implementation here
 *   would be a second verdict, and the two would disagree on the day it
 *   mattered.
 * - **A verbatim quotation is not enough: every number has to be in it.** A
 *   quote can be genuine and still not contain the figure it is offered for —
 *   that is how an unanchored number gets into a card while every check passes.
 *   `numberIsInQuote` requires the value to appear as a complete numeric token
 *   of the quotation, so 46,969 cannot be anchored to a sentence about 24; the
 *   array index in a field path (`outcomeMeasures[0]`) is not a number of the
 *   quotation, or every value of 0 and 1 would anchor itself; and a confidence
 *   bound, a sample size and an event count are each checked the same way (E-9).
 * - **Similarity ranks candidates and nothing else** (plan §6.4). Pooling
 *   eligibility is a separate, per-item decision over declared fields:
 *   same endpoint key (never empty), the arm role being pooled, an actual (not
 *   planned) figure, a verified quote. Two trials can be 0.95 similar and still
 *   not poolable because one measured investigator-assessed PFS and the other
 *   blinded review.
 * - **Which stratum a study belongs to is declared, not inferred from prose.**
 *   Treatment line and biomarker are read from structured fields the run
 *   wrote; an absent one is `unknown` and `unknown` never matches a target.
 *   Region comes from the registry's country list and era from its start date,
 *   which are a lookup and a subtraction — those stay in code (principle 1:
 *   regex never does language). A trial is 「中国」 only when China is all it
 *   ran in; one Chinese site among thirty countries is a multinational trial
 *   that includes China (E-10).
 * - **Three calibres, always; the default is chosen by a stated rule.** The
 *   closest subset, everything, and the next-closest subset are each pooled.
 *   When the strata disagree — the closest subset's pooled value falls outside
 *   the overall prediction interval, or the overall I² is at or above
 *   `HETEROGENEOUS_I2` — the default is the closest subset and the other two
 *   are sensitivity analyses; otherwise the default is the overall pool.
 *   Nothing is hidden either way (plan §6.2 step 5).
 * - **A parameter with no evidence gets a card, not a blank.** The nearest
 *   evidence widened by `EXPERT_WIDEN_FACTOR` (on the scale the quantity lives
 *   on: logit for a proportion, log for a time or a ratio), labelled
 *   「专家设定·待补证」, so a simulation can run and the gap is visible.
 * - **What no registry carries is 「不可得」, never 0** — screening failure
 *   rate, per-site accrual, site activation date (plan §6.2, attachment A2).
 * - **The job queue is injected.** `vcrJobs.mjs` belongs to another package
 *   and may not exist yet, so the pipeline takes `{ jobs }` and answers
 *   `engine_unavailable` when it is absent. The seed is derived from the
 *   canonical scenario bytes, so the same pool asked for twice reproduces
 *   (AC-04) without anyone keeping a counter.
 *
 * @module vcrEvidence
 */

import { createHash } from "node:crypto";

import {
  VCR_ASSUMPTION_KEY, VCR_ASSUMPTION_SOURCE_KINDS, VCR_DISTRIBUTIONS, VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION,
  VCR_JOB_METHODS, VCR_POOLING_METHODS, VCR_VALUE_SOURCES, canonicalScenarioJson, validateEngineJob,
} from "@evimed/domain";
import { quoteIsPresent } from "@evimed/domain/clinical-evidence";

import { REGISTRY_NOT_FOUND, REGISTRY_UNAVAILABLE, REGISTRY_UNAVAILABLE_PARAMETERS } from "./trialRegistryClient.mjs";
import { EVIDENCE_ARM_ROLES } from "./vcrEvidenceStore.mjs";

/** The two-sided 95% normal quantile every interval here is read with. */
export const Z_95 = 1.959963984540054;
/** At or above this, the strata disagree enough that the closest subset becomes the default. */
export const HETEROGENEOUS_I2 = 0.5;
/** How much an expert-set card widens the nearest evidence's spread (plan §6.2). */
export const EXPERT_WIDEN_FACTOR = 2;
/** The label an expert-set card carries until evidence replaces it. */
export const EXPERT_SET_NOTE = "专家设定·待补证";
/** The three calibres, in the order a card records them. */
export const VCR_CALIBRES = Object.freeze(["closest", "overall", "next_closest"]);
/** The stratum keys applicability is judged on (plan §6.1 「适用人群」). */
export const VCR_STRATUM_KEYS = Object.freeze(["region", "line", "era", "biomarker"]);
/** How wide one pooled parameter's evidence set may be. The engine takes 500; a card needs nowhere near it. */
export const VCR_POOL_MAX_STUDIES = 200;

/**
 * What kind of quantity each parameter is, which decides the distribution
 * family a card carries. A parameter not named here is pooled on the identity
 * scale and carries a normal distribution.
 */
export const VCR_PARAMETER_KINDS = Object.freeze({
  control_event_rate: "proportion",
  response_rate: "proportion",
  outcome_value: "proportion",
  survival_at_time: "proportion",
  dropout_rate: "proportion",
  screen_failure_rate: "proportion",
  median_time: "time",
  median_survival_months: "time",
  accrual_to_primary_completion_months: "time",
  hazard_ratio: "ratio",
  odds_ratio: "ratio",
  risk_ratio: "ratio",
  mean_value: "continuous",
  least_squares_mean: "continuous",
  mean_difference: "continuous",
  risk_difference: "continuous",
});

/** A parameter with no evidence anywhere: named, with the reason, never zeroed. */
export const VCR_NOT_IN_REGISTRY = REGISTRY_UNAVAILABLE_PARAMETERS;

/** @param {string} parameter */
export function parameterKindOf(parameter) {
  return VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (parameter)] ?? "continuous";
}

/**
 * The scale a parameter is pooled on unless the request names another one: the
 * scale on which its estimates are roughly normal.
 * @param {string} kind
 */
export function defaultScaleOf(kind) {
  return kind === "proportion" ? "logit" : kind === "ratio" || kind === "time" ? "log" : "identity";
}

/** The parameters that are a contrast between two arms rather than a quantity of one. */
const CONTRAST_PARAMETERS = Object.freeze(["hazard_ratio", "odds_ratio", "risk_ratio", "mean_difference", "risk_difference"]);

/**
 * The arm role a pool takes unless the request names one: effect ratios and
 * differences are contrasts between arms; everything else is pooled over the
 * control arms (the quantity a design most often needs from the literature).
 * @param {string} parameter
 */
export function defaultArmRoleOf(parameter) {
  return CONTRAST_PARAMETERS.includes(parameter) ? "contrast" : "control";
}

/**
 * A number, or null.
 *
 * `Number(null)`, `Number("")` and `Number([])` are all 0, and 0 is a
 * perfectly ordinary count — so the guard is on the input, not on the result.
 * Without it every date extraction (which carries text and no number) read as
 * 「值是 0」 and was refused for not having 0 in its quotation.
 * @param {unknown} value @returns {number | null}
 */
function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- the normal quantile, for reading a confidence interval on its own scale -------------

/** erf by its Maclaurin series: exact to double precision for the |x| a confidence level needs (|x| ≤ 3.5). @param {number} x */
function erf(x) {
  let term = x;
  let sum = x;
  for (let n = 1; n < 400; n += 1) {
    term *= (-x * x) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) <= 1e-17 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

/**
 * The two-sided critical value of a confidence level: `z` with
 * `P(|Z| ≤ z) = level`. Newton's iteration on the exact CDF, so no table of
 * constants stands between an interval and its standard error.
 * @param {number} level the coverage, from 0.5 to 0.9999
 */
export function twoSidedZ(level) {
  if (!(level >= 0.5 && level <= 0.9999)) throw new RangeError("A confidence level is from 0.5 to 0.9999.");
  let z = Z_95;
  for (let step = 0; step < 60; step += 1) {
    const coverage = erf(z / Math.SQRT2);
    const density = (2 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2);
    const next = z - (coverage - level) / density;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - z) < 1e-14) return next;
    z = next;
  }
  return z;
}

/**
 * Is this text a number of the quotation? Numeric tokens of a text, as numbers.
 * A complete token only: 4 of 46,969 is not a match, the 1 of `PHASE1` and of
 * `NCT0136` is not a number of the text, and `[0]` in a field path is a
 * position, not a value.
 */
const NUMBER_TOKEN = /(?<![\w.])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.,])[+-]?\d+(?:\.\d+)?(?![\d.])/g;

/**
 * Is a field path present in the preserved text? A rendered line starts with
 * the path and is followed by `:` (a leaf), `[` (an array) or `.` (a branch),
 * so `…locations` matches `…locations[0].country: United States` and does not
 * match `…locationsTotal: 170`.
 * @param {string} sourceText @param {string} path
 */
export function pathIsInSource(sourceText, path) {
  const wanted = String(path ?? "").trim();
  if (!wanted) return false;
  for (const line of String(sourceText ?? "").split("\n")) {
    if (!line.startsWith(wanted)) continue;
    const next = line.charAt(wanted.length);
    if (next === ":" || next === "[" || next === ".") return true;
  }
  return false;
}

/**
 * Does the quotation actually contain the number it is offered for?
 *
 * Equality is exact, then at the precision the quotation itself states: a
 * quotation reading `0.46` anchors 0.46 and 0.4600, and does not anchor 0.463.
 * Percentages are matched both ways only when the unit says so, because
 * 「12.4」 and 「0.124」 are the same rate written two ways and a card may carry
 * either. Array positions in a field path (`[0]`, `[12]`) are removed before the
 * quotation is read: they are where a value sits, never a value.
 *
 * @param {string} quote @param {number} value @param {{ unit?: string }} [options]
 */
export function numberIsInQuote(quote, value, { unit = "" } = {}) {
  const target = finite(value);
  if (target === null) return false;
  const percent = /%|percent|百分/i.test(String(unit ?? ""));
  const candidates = percent ? [target, target * 100, target / 100] : [target];
  const text = String(quote ?? "").replace(/\[\d+\]/g, "");
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const token = match[0].replace(/,/g, "");
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) continue;
    const decimals = (token.split(".")[1] ?? "").length;
    for (const candidate of candidates) {
      if (parsed === candidate) return true;
      // A stored value may be *less* precise than the quotation (0.46 against
      // 「0.460」), never more: a source that wrote two decimals is not evidence
      // for a third, and 0.463 anchored to a sentence reading 0.46 is exactly
      // the invented precision AC-25 is about.
      if (decimalsOf(candidate) <= decimals && Number(candidate.toFixed(decimals)) === parsed) return true;
    }
  }
  return false;
}

/**
 * How many decimals a number is written with, after the floating-point noise
 * of a unit conversion is taken off (0.124 × 100 is 12.400000000000002).
 * @param {number} value
 */
function decimalsOf(value) {
  const written = String(Number(value.toPrecision(12)));
  if (written.includes("e") || written.includes("E")) return Number.MAX_SAFE_INTEGER;
  return (written.split(".")[1] ?? "").length;
}

/** The numeric fields of an extraction that a quotation must anchor, besides the value. */
const COMPANION_NUMBERS = Object.freeze(["ciLow", "ciHigh", "sampleSize", "events"]);

/**
 * Check one extracted value against the text it says it came from, and return
 * the row that will be stored either way.
 *
 * A value that fails is not dropped — it is stored as `unknown` with the
 * reason, so the attempt stays on the record and the card-building reader
 * (`verifiedEvidenceIds`) passes it over. Nothing that fails here can reach an
 * assumption card (AC-25).
 *
 * Every number the item carries is checked, not only the value: a confidence
 * bound, a sample size and an event count are anchored by the item's own
 * quotation or by a line of their own in `locator.parts` (the registry keeps
 * each in a field of its own, so each has its own line). A number with neither
 * fails the item as `quote_missing_number`, with the fields named.
 *
 * @param {{ extraction: any, sourceText?: string, checkedAt?: string }} input
 */
export function verifyExtraction({ extraction, sourceText = "", checkedAt = "" }) {
  const quote = String(extraction?.quote ?? "").trim();
  const value = finite(extraction?.value);
  const valueText = String(extraction?.valueText ?? "").trim();
  // A value the analyst computed cannot be in the source — that is what
  // 「计算」 means. AC-25 asks for 「带原文位置的抽取值和汇总计算」: for a
  // derived value the check is therefore that every input it names is in the
  // preserved text, not that its own answer is. This is the same distinction
  // the clinical gate draws between a `direct` claim and a `derived` one.
  const derived = ["calculated", "imputed", "predicted"].includes(String(extraction?.valueSource ?? ""));
  const inputs = [...(extraction?.locator?.inputs ?? [])].map(String).filter(Boolean);
  /** @type {string[]} */
  const unanchored = [];
  /** @type {string} */
  let state;
  if (!quote) state = "no_quote";
  else if (!String(sourceText ?? "").trim()) state = "source_unavailable";
  else if (!quoteIsPresent(sourceText, quote)) state = "quote_not_found";
  else if (derived) {
    const missing = inputs.filter((path) => !pathIsInSource(sourceText, path));
    state = !inputs.length ? "derived_inputs_missing" : missing.length ? "derived_input_not_found" : "verified";
  } else {
    if (value !== null && !numberIsInQuote(quote, value, { unit: extraction?.unit })) unanchored.push("value");
    for (const field of COMPANION_NUMBERS) {
      const number = finite(extraction?.[field]);
      if (number === null) continue;
      if (field === "sampleSize" || field === "events") {
        if (!Number.isInteger(number) || number < 0) { unanchored.push(field); continue; }
      }
      // A confidence bound is in the value's own unit; a count is not.
      const options = field === "ciLow" || field === "ciHigh" ? { unit: extraction?.unit } : {};
      if (numberIsInQuote(quote, number, options)) continue;
      const part = extraction?.locator?.parts?.[field];
      const partQuote = String(part?.quote ?? "").trim();
      if (partQuote && quoteIsPresent(sourceText, partQuote) && numberIsInQuote(partQuote, number, options)) continue;
      unanchored.push(field);
    }
    // A value with no number carries text instead — a date, a status. It has to
    // be in the quotation the same way a number does.
    if (unanchored.length) state = "quote_missing_number";
    else if (value === null && valueText && !quoteIsPresent(quote, valueText)) state = "quote_missing_value";
    else state = "verified";
  }

  const verified = state === "verified";
  return {
    state,
    verified,
    item: {
      ...extraction,
      // A refused item keeps no number at all: the bounds, the sample size and the
      // event count travel with the value, and what could not be anchored must not
      // be handed on (the runtime reads these rows back as they are).
      value: verified ? extraction?.value ?? null : null,
      ciLow: verified ? extraction?.ciLow ?? null : null,
      ciHigh: verified ? extraction?.ciHigh ?? null : null,
      sampleSize: verified ? extraction?.sampleSize ?? null : null,
      events: verified ? extraction?.events ?? null : null,
      valueText: verified ? String(extraction?.valueText ?? "") : "unknown",
      locator: {
        ...(extraction?.locator ?? {}),
        // Stored beside the locator because it is the locator that was
        // checked: 「这个位置上确实有这句话，这句话里确实有这个数」.
        verification: verified ? "verified"
          : ["quote_missing_number", "quote_missing_value", "derived_input_not_found", "derived_inputs_missing"].includes(state)
            ? "quote_not_found" : state,
        ...(verified ? {} : { verificationDetail: state, ...(unanchored.length ? { unanchored } : {}) }),
        ...(derived ? { derivation: String(extraction?.valueSource ?? "calculated") } : {}),
        ...(checkedAt ? { checkedAt } : {}),
      },
    },
  };
}

/**
 * How close a candidate precedent is to this study. Used to order candidates
 * and for nothing else: a high score never authorizes pooling (plan §6.4).
 *
 * @param {any} precedent @param {any} target
 * @returns {{ score: number, parts: Record<string, number> }}
 */
export function precedentSimilarity(precedent, target) {
  /** @param {unknown} value */
  const words = (value) => new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean));
  /** @param {Set<string>} a @param {Set<string>} b */
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared / Math.min(a.size, b.size);
  };
  const condition = overlap(
    words([...(precedent?.pico?.conditions ?? []), ...(precedent?.pico?.keywords ?? []), ...(precedent?.pico?.mesh ?? [])].join(" ")),
    words([...(target?.conditions ?? []), target?.condition].join(" ")),
  );
  const intervention = overlap(
    words((precedent?.pico?.interventions ?? []).map((/** @type {any} */ item) => item?.name ?? item).join(" ")),
    words([...(target?.interventions ?? []), target?.intervention].join(" ")),
  );
  const phases = new Set((precedent?.design?.phases ?? []).map((/** @type {string} */ phase) => phase.toUpperCase()));
  const phase = target?.phase ? (phases.has(String(target.phase).toUpperCase()) ? 1 : 0) : 0.5;
  const design = target?.allocation
    ? (String(precedent?.design?.allocation ?? "").toUpperCase() === String(target.allocation).toUpperCase() ? 1 : 0)
    : 0.5;
  const hasResults = precedent?.design?.hasResults || precedent?.results?.hasResults ? 1 : 0;
  const parts = { condition, intervention, phase, design, hasResults };
  // The weights say what a candidate list is for: the disease and the drug
  // first, then whether the record even carries results to extract.
  const score = 0.35 * condition + 0.3 * intervention + 0.1 * phase + 0.1 * design + 0.15 * hasResults;
  return { score: Math.round(score * 1000) / 1000, parts };
}

/** How a registry spells the countries this module groups. Lowercase. */
const CHINA_NAMES = Object.freeze(["china", "mainland china", "people's republic of china", "prc"]);
const EAST_ASIA_NAMES = Object.freeze([
  ...CHINA_NAMES, "japan", "korea", "republic of korea", "south korea", "taiwan", "singapore", "hong kong", "macau", "macao",
]);

/**
 * Which stratum a precedent's values belong to, on the four keys applicability
 * is judged on. `line` and `biomarker` are read from declared fields, never
 * inferred from a title; absent means `unknown`, and `unknown` never matches.
 *
 * Region is about where the trial ran *as a whole*: `china` is a trial whose
 * every country is China; a trial that included China among others is
 * `multinational` and says so with `includesChina`; `east_asia` is a trial run
 * only in East Asia. One Chinese site among thirty countries is not a Chinese
 * population (E-10).
 *
 * @param {{ precedent?: any, item?: any, target?: any, now?: Date }} input
 */
export function applicabilityStratum({ precedent = {}, item = {}, target = {}, now = new Date() }) {
  const countries = [...new Set((precedent?.sites?.countries ?? []).map((/** @type {string} */ country) => String(country).trim().toLowerCase()).filter(Boolean))];
  const includesChina = countries.some((country) => CHINA_NAMES.includes(country));
  /** @type {string} */
  let region = "unknown";
  if (countries.length) {
    if (countries.every((country) => CHINA_NAMES.includes(country))) region = "china";
    else if (countries.every((country) => EAST_ASIA_NAMES.includes(country))) region = "east_asia";
    else if (countries.length > 3 || includesChina) region = "multinational";
    else region = "other";
  }
  const startYear = Number(String(precedent?.enrollment?.milestones?.start_date?.date ?? "").slice(0, 4));
  const eraYear = Number(target?.eraYear) || now.getUTCFullYear();
  const eraWindow = Number(target?.eraWindowYears) || 5;
  const era = Number.isFinite(startYear) && startYear > 1900
    ? (eraYear - startYear <= eraWindow ? "recent" : "older")
    : "unknown";
  const declared = (/** @type {string} */ key) => {
    const value = item?.applicability?.[key] ?? precedent?.pico?.[key] ?? precedent?.applicability?.[key];
    const asText = String(value ?? "").trim().toLowerCase();
    return asText || "unknown";
  };
  return { region, includesChina, line: declared("line"), era, biomarker: declared("biomarker") };
}

/**
 * Mismatches between a stratum and the target, on the keys the target actually
 * declares. `unknown` counts as a mismatch — a study whose treatment line
 * nobody recorded is not evidence that it matches.
 * @param {Record<string, any>} stratum @param {any} target
 */
export function stratumMismatches(stratum, target) {
  /** @type {string[]} */
  const mismatches = [];
  for (const key of VCR_STRATUM_KEYS) {
    const wanted = String(target?.[key] ?? "").trim().toLowerCase();
    if (!wanted) continue;
    if (String(stratum?.[key] ?? "unknown") !== wanted) mismatches.push(key);
  }
  return mismatches;
}

/**
 * Per-item pooling eligibility: same endpoint key (never empty), the arm role
 * being pooled, verified, an actual figure rather than a sponsor's plan, and a
 * number to pool. Every refusal names its reason; nothing is dropped quietly.
 * An item whose registry standing is not stated (`historical_baseline` absent)
 * is not a baseline.
 *
 * @param {{ items: readonly any[], endpointKey?: string, armRole?: string, requireHistoricalBaseline?: boolean }} input
 */
export function poolEligibility({ items, endpointKey = "", armRole = "", requireHistoricalBaseline = true }) {
  /** @type {{ item: any, eligible: boolean, reasons: string[] }[]} */
  const verdicts = [];
  const wantedKey = String(endpointKey ?? "").trim();
  for (const item of items ?? []) {
    /** @type {string[]} */
    const reasons = [];
    const verification = String(item?.locator?.verification ?? item?.verification ?? "");
    if (verification !== "verified") reasons.push("quote_not_verified");
    if (finite(item?.value) === null) reasons.push("no_value");
    const key = String(item?.endpoint_key ?? item?.endpointKey ?? item?.detail?.endpointKey ?? item?.applicability?.endpointKey ?? "").trim();
    // Pooling needs an endpoint definition on both sides: two values that name
    // none are not known to measure the same thing.
    if (!wantedKey) reasons.push("endpoint_key_required");
    else if (!key) reasons.push("endpoint_key_missing");
    else if (key !== wantedKey) reasons.push("endpoint_key_differs");
    const role = String(item?.arm_role ?? item?.armRole ?? "unknown");
    if (armRole && role !== armRole) reasons.push(role === "unknown" ? "arm_role_unknown" : "arm_role_differs");
    const baseline = item?.historical_baseline ?? item?.historicalBaseline;
    if (requireHistoricalBaseline && baseline !== true) reasons.push(baseline === false ? "estimated_not_actual" : "baseline_standing_unknown");
    verdicts.push({ item, eligible: reasons.length === 0, reasons });
  }
  return {
    eligible: verdicts.filter((verdict) => verdict.eligible).map((verdict) => verdict.item),
    refused: verdicts.filter((verdict) => !verdict.eligible),
    verdicts,
  };
}

/** @param {number} p */
const logit = (p) => Math.log(p / (1 - p));
/** Inverse logit, used to bring a pooled logit back to the proportion scale. @param {number} value */
const expit = (value) => 1 / (1 + Math.exp(-value));

/**
 * The value on the natural scale, as a proportion: a percentage is divided by
 * a hundred, a number strictly between 0 and 1 is one already, anything else is
 * not a proportion this module will guess at.
 * @param {number | null} value @param {string} unit
 */
function asProportion(value, unit) {
  if (value === null) return null;
  const percent = /%|percent|百分/i.test(unit);
  const p = percent ? value / 100 : value;
  return p > 0 && p < 1 ? p : null;
}

/**
 * The estimate and its standard error on the analysis scale, from what the
 * registry gave: the value and its confidence interval, at the interval's own
 * level. Exact arithmetic on the scale the engine pools on — never a natural-scale
 * number the engine would have to transform, and never a standard error nobody
 * can reproduce: an item whose error cannot be read off its own interval (or,
 * for a proportion, off its own sample size) is refused with the reason.
 *
 * @param {any} item a stored evidence row
 * @param {{ scale: string }} options
 * @returns {{ ok: true, estimate: number, se: number } | { ok: false, reason: string }}
 */
export function analysisScaleInput(item, { scale }) {
  const unit = String(item?.unit ?? "");
  const value = finite(item?.value);
  const low = finite(item?.ci_low ?? item?.ciLow);
  const high = finite(item?.ci_high ?? item?.ciHigh);
  const n = finite(item?.sample_size ?? item?.sampleSize);
  const level = finite(item?.detail?.confidenceLevel ?? item?.applicability?.confidenceLevel) ?? 0.95;
  /** @param {number | null} raw */
  const on = (raw) => {
    if (raw === null) return null;
    if (scale === "identity") return raw;
    if (scale === "log") return raw > 0 ? Math.log(raw) : null;
    const p = asProportion(raw, unit);
    return p === null ? null : logit(p);
  };
  const estimate = on(value);
  if (estimate === null || !Number.isFinite(estimate)) return { ok: false, reason: scale === "logit" ? "proportion_not_derivable" : "value_off_scale" };
  const lowOn = on(low);
  const highOn = on(high);
  if (lowOn !== null && highOn !== null && highOn > lowOn) {
    if (!(level >= 0.5 && level <= 0.9999)) return { ok: false, reason: "confidence_level_invalid" };
    const se = (highOn - lowOn) / (2 * twoSidedZ(level));
    return se > 0 && Number.isFinite(se) ? { ok: true, estimate, se } : { ok: false, reason: "se_underivable" };
  }
  if (scale === "logit" && n !== null && n > 0) {
    const p = /** @type {number} */ (asProportion(value, unit));
    // The binomial variance of a logit: 1 / (n p (1 − p)).
    const se = Math.sqrt(1 / (n * p * (1 - p)));
    return se > 0 && Number.isFinite(se) ? { ok: true, estimate, se } : { ok: false, reason: "se_underivable" };
  }
  return { ok: false, reason: "se_underivable" };
}

/**
 * The three calibres of one parameter: the subset closest to this study's
 * population, everything, and the next-closest subset. Each is pooled on its
 * own; the default is chosen afterwards from the engine's answers.
 *
 * @param {{ items: readonly any[], target: any }} input
 */
export function calibres({ items, target }) {
  /** @type {{ item: any, mismatches: string[] }[]} */
  const scored = (items ?? []).map((item) => ({
    item,
    mismatches: stratumMismatches(item?.stratum ?? applicabilityStratum({ precedent: item?.precedent, item, target }), target),
  }));
  const closest = scored.filter((entry) => entry.mismatches.length === 0).map((entry) => entry.item);
  const partial = scored.filter((entry) => entry.mismatches.length > 0);
  const fewest = partial.length ? Math.min(...partial.map((entry) => entry.mismatches.length)) : 0;
  const nextClosest = partial.filter((entry) => entry.mismatches.length === fewest).map((entry) => entry.item);
  return [
    { name: "closest", items: closest, label: "最接近本研究人群的子集" },
    { name: "overall", items: [...(items ?? [])], label: "全部同类研究" },
    { name: "next_closest", items: nextClosest, label: "次接近的口径" },
  ].filter((calibre) => calibre.items.length > 0);
}

/**
 * A reproducible seed for one scenario: the first 31 bits of the sha256 of the
 * canonical bytes both sides hash. The same pool asked for twice runs the same
 * way without anybody keeping a counter (AC-04).
 * @param {unknown} scenario
 */
export function seedForScenario(scenario) {
  const digest = createHash("sha256").update(canonicalScenarioJson(scenario)).digest();
  return digest.readUInt32BE(0) & 0x7fff_ffff;
}

/**
 * The `evidence.pool` job for one calibre of one parameter, in exactly the
 * shape the domain's scenario schema and the engine read (integration contract
 * §3.1): `studies: [{ studyId, estimate, se }]` on the analysis scale, plus
 * `method`, `level` and `scale`. Validated against the engine protocol before
 * anyone queues it: a job the engine would refuse is refused here, with the
 * field named. An item whose standard error cannot be derived is left out of the
 * job and reported with its reason (`excluded`) — never pooled with a guessed
 * error.
 *
 * @param {{ studyId: string, parameter: string, endpointKey?: string, armRole?: string, calibre: string,
 *   items: readonly any[], scale?: string, poolingMethod?: string, cpuSecondsLimit?: number }} input
 */
export function poolJob({ studyId, parameter, endpointKey = "", armRole = "", calibre, items, scale = "", poolingMethod = "random_effects_reml", cpuSecondsLimit = 120 }) {
  const kind = parameterKindOf(parameter);
  const method = VCR_JOB_METHODS.pool_evidence;
  const chosenScale = scale || defaultScaleOf(kind);
  /** @type {{ studyId: string, estimate: number, se: number }[]} */
  const studies = [];
  /** @type {{ id: string, reason: string }[]} */
  const excluded = [];
  /** @type {string[]} */
  const evidenceIds = [];
  /** @type {Array<{ kind: string, id: string }>} */
  const inputs = [];
  for (const item of items ?? []) {
    const derived = analysisScaleInput(item, { scale: chosenScale });
    const id = String(item?.id ?? "");
    if (derived.ok !== true) { excluded.push({ id, reason: derived.reason }); continue; }
    studies.push({ studyId: id, estimate: derived.estimate, se: derived.se });
    evidenceIds.push(id);
    // A caller names an input by what it is; a hash is only ever the control plane's to give.
    inputs.push({ kind: "evidence", id });
  }
  const scenario = {
    studies: studies.slice(0, VCR_POOL_MAX_STUDIES),
    method: VCR_POOLING_METHODS.includes(poolingMethod) ? poolingMethod : "random_effects_reml",
    level: 0.95,
    scale: chosenScale,
  };
  const job = {
    jobId: "job_pending",
    studyId,
    kind: "pool_evidence",
    method,
    methodVersion: VCR_ENGINE_METHODS[method].version,
    protocolVersion: VCR_ENGINE_PROTOCOL_VERSION,
    seed: seedForScenario(scenario),
    cpuSecondsLimit,
    scenario,
    inputs: inputs.slice(0, VCR_POOL_MAX_STUDIES),
  };
  const issues = studies.length ? validateEngineJob(job) : [{ code: "no_poolable_study", field: "scenario.studies", detail: "No item has a standard error that can be derived." }];
  return {
    job, issues, valid: issues.length === 0, excluded, evidenceIds,
    // What the pool is about. It rides in the job's own record, not its scenario.
    about: { parameter, endpointKey, armRole, calibre, scale: chosenScale, method: scenario.method },
  };
}

/**
 * Read what `evidence.pool` answered — its own measure names: `pooled_estimate`
 * (with its confidence interval), `prediction_interval` (absent below three
 * studies, by the engine's own rule), `i_squared`, `tau_squared`, `k`. Strict
 * about the pooled value being there; tolerant about the prediction interval
 * being absent, because that is a finding (`predictionAvailable: false`), not a
 * failure: a pool of two studies is a real pool with no range to draw from.
 *
 * The first build's names (`pooled`, `prediction`) are read too, as an alias for
 * the fixtures written against them.
 *
 * @param {any} result
 * @returns {{ ok: boolean, reason?: string, scale?: string, poolingMethod?: string, k?: number | null,
 *   pooled?: number, confidence?: { low: number, high: number } | null,
 *   prediction?: { low: number, high: number } | null, predictionAvailable?: boolean, i2?: number | null, tau2?: number | null }}
 */
export function readPoolResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result_missing" };
  if (result.status && result.status !== "succeeded") return { ok: false, reason: `engine_${result.status}` };
  const measures = Array.isArray(result.measures) ? result.measures : [];
  /** @param {...string} names */
  const measure = (...names) => names.map((name) => measures.find((entry) => String(entry?.name ?? "") === name)).find(Boolean);
  const pooledMeasure = measure("pooled_estimate", "pooled");
  const pooled = finite(pooledMeasure?.value);
  if (pooled === null) return { ok: false, reason: "pooled_value_missing" };
  const predictionMeasure = measure("prediction_interval", "prediction");
  const predictionSource = predictionMeasure?.interval?.kind === "prediction" ? predictionMeasure.interval
    : pooledMeasure?.predictionInterval ?? (pooledMeasure?.interval?.kind === "prediction" ? pooledMeasure.interval : null);
  const low = finite(predictionSource?.low);
  const high = finite(predictionSource?.high);
  const predictionAvailable = low !== null && high !== null && high >= low;
  const confidenceSource = pooledMeasure?.interval?.kind === "confidence" ? pooledMeasure.interval : measure("confidence")?.interval ?? null;
  return {
    ok: true,
    scale: String(result.diagnostics?.scale ?? pooledMeasure?.unit ?? "identity"),
    poolingMethod: String(result.diagnostics?.poolingMethodApplied ?? result.diagnostics?.poolingMethod ?? "random_effects_reml"),
    k: finite(measure("k")?.value ?? result.diagnostics?.k),
    pooled,
    confidence: finite(confidenceSource?.low) !== null && finite(confidenceSource?.high) !== null
      ? { low: Number(confidenceSource.low), high: Number(confidenceSource.high) } : null,
    prediction: predictionAvailable ? { low: /** @type {number} */ (low), high: /** @type {number} */ (high) } : null,
    predictionAvailable,
    i2: finite(measure("i_squared")?.value ?? result.diagnostics?.i2),
    tau2: finite(measure("tau_squared")?.value ?? result.diagnostics?.tau2),
  };
}

/**
 * A value on the analysis scale, on the natural one.
 * @param {number} value @param {string} scale
 */
export function naturalOf(value, scale) {
  return scale === "logit" ? expit(value) : scale === "log" ? Math.exp(value) : value;
}

/**
 * The distribution a simulation draws from, from the engine's pooled value and
 * prediction interval.
 *
 * - proportion → **Beta**, matched on the mean and the prediction interval's
 *   implied standard deviation: ν = m(1−m)/s² − 1, α = mν, β = (1−m)ν. When
 *   the interval is wider than any Beta with that mean can be (ν ≤ 0), the
 *   card carries the empirical range instead of a Beta that is not there.
 * - time and ratio → **log-normal** on the log scale, `sdlog` from the
 *   prediction interval's half-width in logs.
 * - anything else → **normal**.
 *
 * @param {{ kind: string, pooled: number, prediction: { low: number, high: number }, scale?: string }} input
 */
export function distributionFromPooled({ kind, pooled, prediction, scale = "identity" }) {
  const low = Number(prediction.low);
  const high = Number(prediction.high);
  if (kind === "proportion") {
    const mean = scale === "logit" ? expit(pooled) : pooled;
    const pLow = scale === "logit" ? expit(low) : low;
    const pHigh = scale === "logit" ? expit(high) : high;
    const sd = (pHigh - pLow) / (2 * Z_95);
    const nu = sd > 0 && mean > 0 && mean < 1 ? (mean * (1 - mean)) / (sd * sd) - 1 : -1;
    if (!(nu > 0)) {
      return {
        family: "empirical",
        params: { point: mean, support: [Math.max(0, pLow), Math.min(1, pHigh)] },
        pointValue: mean,
        predictionInterval: { kind: "prediction", low: Math.max(0, pLow), high: Math.min(1, pHigh) },
        note: "预测区间比任何同均值的 Beta 分布都宽，改用经验区间",
      };
    }
    return {
      family: "beta",
      params: { alpha: mean * nu, beta: (1 - mean) * nu },
      pointValue: mean,
      predictionInterval: { kind: "prediction", low: Math.max(0, pLow), high: Math.min(1, pHigh) },
    };
  }
  if (kind === "time" || kind === "ratio") {
    const asLog = scale === "log";
    const meanlog = asLog ? pooled : pooled > 0 ? Math.log(pooled) : null;
    const logLow = asLog ? low : low > 0 ? Math.log(low) : null;
    const logHigh = asLog ? high : high > 0 ? Math.log(high) : null;
    if (meanlog === null || logLow === null || logHigh === null) {
      return { family: "empirical", params: { point: pooled, support: [low, high] }, pointValue: pooled,
        predictionInterval: { kind: "prediction", low, high }, note: "合并值或预测区间不为正，无法取对数" };
    }
    const sdlog = (logHigh - logLow) / (2 * Z_95);
    return {
      family: "lognormal",
      params: { meanlog, sdlog },
      pointValue: Math.exp(meanlog),
      predictionInterval: { kind: "prediction", low: Math.exp(logLow), high: Math.exp(logHigh) },
    };
  }
  const sd = (high - low) / (2 * Z_95);
  return {
    family: "normal",
    params: { mean: pooled, sd },
    pointValue: pooled,
    predictionInterval: { kind: "prediction", low, high },
  };
}

/**
 * Which calibre is the default, and why. The rule is stated, deterministic and
 * recorded on the card; nothing is hidden either way (plan §6.2 step 5).
 *
 * @param {Record<string, ReturnType<typeof readPoolResult>>} pools
 */
export function chooseCalibre(pools) {
  const closest = pools?.closest?.ok ? pools.closest : null;
  const overall = pools?.overall?.ok ? pools.overall : null;
  if (!closest && !overall) return { calibre: null, reason: "no_pool_succeeded", strataDiffer: false };
  if (!overall) return { calibre: "closest", reason: "only_closest_pooled", strataDiffer: false };
  if (!closest) return { calibre: "overall", reason: "no_subset_matches_this_population", strataDiffer: false };
  const outside = overall.prediction
    ? /** @type {number} */ (closest.pooled) < overall.prediction.low || /** @type {number} */ (closest.pooled) > overall.prediction.high
    : false;
  const heterogeneous = (overall.i2 ?? 0) >= HETEROGENEOUS_I2;
  const strataDiffer = outside || heterogeneous;
  return {
    calibre: strataDiffer ? "closest" : "overall",
    reason: outside ? "closest_outside_overall_prediction_interval"
      : heterogeneous ? "overall_heterogeneity_at_or_above_floor" : "strata_agree",
    strataDiffer,
  };
}

/**
 * One assumption card, from the engine's answers for every calibre. The
 * default calibre supplies the distribution; the other two become the
 * sensitivity analyses. `evidenceIds` are the verified rows only.
 *
 * When the default calibre's pool has no prediction interval (fewer than three
 * studies) there is no range to draw from and no card is made here
 * (`reason: "prediction_interval_missing"`, with the pool as `nearest`): the
 * caller writes the expert setting instead (`expertSetFromPool`).
 *
 * @param {{ key: string, name: string, parameter: string, endpoint?: string, unit?: string,
 *   pools: Record<string, ReturnType<typeof readPoolResult>>, evidenceIdsByCalibre: Record<string, string[]>,
 *   applicability?: any, note?: string }} input
 */
export function assumptionFromPooling({ key, name, parameter, endpoint = "", unit = "", pools, evidenceIdsByCalibre, applicability = {}, note = "" }) {
  const kind = parameterKindOf(parameter);
  const chosen = chooseCalibre(pools);
  if (!chosen.calibre) return { ok: false, reason: chosen.reason, card: null, nearest: null };
  const pool = pools[chosen.calibre];
  if (!pool.prediction) return { ok: false, reason: "prediction_interval_missing", card: null, nearest: { calibre: chosen.calibre, pool } };
  const distribution = distributionFromPooled({ kind, pooled: /** @type {number} */ (pool.pooled), prediction: pool.prediction, scale: pool.scale });
  /** @type {any[]} */
  const sensitivity = [];
  for (const calibre of VCR_CALIBRES) {
    const other = pools?.[calibre];
    if (calibre === chosen.calibre || !other?.ok || !other.prediction) continue;
    const otherDistribution = distributionFromPooled({ kind, pooled: /** @type {number} */ (other.pooled), prediction: other.prediction, scale: other.scale });
    sensitivity.push({
      calibre,
      pointValue: otherDistribution.pointValue,
      range: otherDistribution.predictionInterval,
      k: other.k ?? null,
      i2: other.i2 ?? null,
      studies: (evidenceIdsByCalibre?.[calibre] ?? []).length,
    });
  }
  return {
    ok: true,
    reason: null,
    nearest: null,
    card: {
      key,
      name,
      endpoint,
      unit,
      pointValue: distribution.pointValue,
      distribution: {
        family: distribution.family,
        params: distribution.params,
        // The range a simulation may use is the prediction interval, never the
        // confidence interval (plan §6.1).
        range: distribution.predictionInterval,
        ...(distribution.note ? { note: distribution.note } : {}),
      },
      sensitivity: {
        range: distribution.predictionInterval,
        calibres: sensitivity,
      },
      sourceKind: "external_evidence",
      valueSource: "aggregate",
      poolingMethod: pool.poolingMethod,
      pooling: {
        calibre: chosen.calibre,
        calibreReason: chosen.reason,
        strataDiffer: chosen.strataDiffer,
        scale: pool.scale,
        k: pool.k ?? null,
        i2: pool.i2 ?? null,
        tau2: pool.tau2 ?? null,
        pooledOnScale: pool.pooled,
        confidenceInterval: pool.confidence ? { kind: "confidence", ...pool.confidence } : null,
        predictionInterval: distribution.predictionInterval,
      },
      evidenceIds: [...(evidenceIdsByCalibre?.[chosen.calibre] ?? [])],
      applicability: { ...applicability, calibre: chosen.calibre },
      reviewState: "ai_set",
      note,
    },
  };
}

/**
 * A parameter no evidence reached: the nearest evidence, widened, and told
 * plainly that it is an expert setting waiting for its source (plan §6.2).
 *
 * The spread is widened on the scale the quantity lives on: the log scale for a
 * time or a ratio (a hazard ratio of 0.5 to 2 is symmetric about 1, not about
 * 1.25), the logit scale for a proportion (which keeps it inside 0 to 1 without
 * a clip that would pile mass on the bound), the natural scale otherwise. A
 * value or a bound that is not positive on a log scale, or not inside 0 to 1 on
 * a logit one, has no honest widening: the card carries the point and says the
 * range is unavailable (E-13).
 *
 * @param {{ key: string, name: string, parameter?: string, unit?: string, nearest: any,
 *   reason: string, applicability?: any, basedOn?: unknown }} input
 */
export function expertSetCard({ key, name, parameter = "", unit = "", nearest, reason, applicability = {}, basedOn = undefined }) {
  const kind = parameterKindOf(parameter);
  const point = finite(nearest?.pointValue ?? nearest?.value);
  const low = finite(nearest?.range?.low ?? nearest?.low);
  const high = finite(nearest?.range?.high ?? nearest?.high);
  const scale = defaultScaleOf(kind);
  /** @param {number} value */
  const forward = (value) => (scale === "log" ? (value > 0 ? Math.log(value) : null)
    : scale === "logit" ? (value > 0 && value < 1 ? logit(value) : null) : value);
  /** @param {number} value */
  const backward = (value) => (scale === "log" ? Math.exp(value) : scale === "logit" ? expit(value) : value);
  /** @type {any} */
  let distribution;
  if (point === null) {
    distribution = { family: "empirical", params: {}, range: null };
  } else if (low !== null && high !== null && high > low) {
    const centre = forward(point);
    const lowOn = forward(low);
    const highOn = forward(high);
    if (centre === null || lowOn === null || highOn === null) {
      distribution = { family: "point", params: { point }, range: null, note: "取值或区间不在这个量的合法范围内，无法加宽，只保留点值" };
    } else {
      const halfWidth = ((highOn - lowOn) / 2) * EXPERT_WIDEN_FACTOR;
      const widened = { low: backward(centre - halfWidth), high: backward(centre + halfWidth) };
      distribution = {
        family: "empirical",
        params: { point, support: [widened.low, widened.high], widenedBy: EXPERT_WIDEN_FACTOR },
        range: { kind: "prediction", ...widened },
      };
    }
  } else {
    distribution = { family: "point", params: { point }, range: null };
  }
  return {
    key,
    name,
    endpoint: "",
    unit,
    pointValue: point,
    distribution,
    sensitivity: { range: distribution.range, calibres: [] },
    sourceKind: "expert_set",
    valueSource: "assumed",
    poolingMethod: null,
    // What it was widened from travels in `pooling`, not in `evidenceIds`: an
    // expert setting cites no extracted value, on purpose — it is not evidence
    // and must not read as if it were (AC-25).
    pooling: { basedOn: basedOn ?? nearest?.source ?? nearest?.key ?? null, widenedBy: EXPERT_WIDEN_FACTOR, reason },
    evidenceIds: [],
    applicability: { ...applicability, pending: true },
    reviewState: "ai_set",
    note: `${EXPERT_SET_NOTE}：${reason}`,
  };
}

/** The quantities no registry carries, as the rows a page prints as 「不可得」. */
export function unavailableParameters(extra = {}) {
  return Object.entries({ ...VCR_NOT_IN_REGISTRY, ...extra })
    .map(([parameter, reason]) => ({ parameter, value: null, display: "不可得", reason }));
}

/**
 * The `results.json` an evidence deliverable ships beside its prose, in the
 * shape `vcrStudyPackageFindings` reads. Every number in the report is
 * rendered from this file, so a figure nobody can trace is a binding that was
 * bypassed rather than a typo (plan §8.3, principle 10c).
 *
 * @param {{ cards: readonly any[], evidenceById?: Map<string, any> | Record<string, any>,
 *   precedents?: readonly any[], counts?: any, conclusion?: string, notEstimableRule?: string | null,
 *   unavailable?: readonly any[] }} input
 */
export function evidenceResultsJson({ cards, evidenceById = new Map(), precedents = [], counts = {}, conclusion = "estimable", notEstimableRule = null, unavailable = unavailableParameters() }) {
  /** @param {string} id */
  const lookup = (id) => (evidenceById instanceof Map ? evidenceById.get(id) : evidenceById?.[id]);
  return {
    conclusion,
    ...(notEstimableRule ? { notEstimableRule } : {}),
    counts: {
      realPatients: counts.realPatients ?? null,
      events: counts.events ?? null,
      effectiveSampleSize: counts.effectiveSampleSize ?? null,
      generatedRecords: counts.generatedRecords ?? 0,
      ...(counts.reconstructedPseudoPatients !== undefined ? { reconstructedPseudoPatients: counts.reconstructedPseudoPatients } : {}),
    },
    measures: (cards ?? []).map((card) => ({
      name: card?.name ?? card?.key,
      value: card?.pointValue ?? null,
      simulated: false,
      interval: card?.pooling?.predictionInterval ?? card?.distribution?.range ?? undefined,
    })).filter((measure) => Number.isFinite(Number(measure.value))),
    assumptions: (cards ?? []).map((card) => ({
      key: card?.key,
      name: card?.name,
      unit: card?.unit ?? "",
      pointValue: card?.pointValue ?? null,
      distribution: card?.distribution ?? null,
      sensitivity: card?.sensitivity ?? null,
      sourceKind: card?.sourceKind,
      valueSource: card?.valueSource,
      poolingMethod: card?.poolingMethod ?? null,
      pooling: card?.pooling ?? null,
      reviewState: card?.reviewState ?? "ai_set",
      applicability: card?.applicability ?? {},
      note: card?.note ?? "",
      sources: [...(card?.evidenceIds ?? [])].map((id) => {
        const row = lookup(String(id));
        return {
          evidenceId: String(id),
          sourceRef: row?.source_ref ?? row?.sourceRef ?? "",
          quote: row?.quote ?? "",
          locator: row?.locator ?? null,
          value: row?.value ?? null,
        };
      }).filter((source) => source.quote && source.locator),
    })),
    precedents: (precedents ?? []).map((precedent) => ({
      registry: precedent?.registry,
      registryId: precedent?.registry_id ?? precedent?.registryId,
      title: precedent?.title,
      plannedEnrollment: precedent?.enrollment?.planned ?? null,
      actualEnrollment: precedent?.enrollment?.actual ?? null,
      accrualMonths: precedent?.enrollment?.accrualToPrimaryCompletionMonths ?? null,
      sites: precedent?.sites?.count ?? null,
      hasResults: Boolean(precedent?.results?.hasResults ?? precedent?.design?.hasResults),
    })),
    unavailable: [...unavailable],
  };
}

/** What a pooling request may name of the study it pools for: the four strata. Closed. */
export const VCR_POOL_TARGET_KEYS = Object.freeze(["region", "line", "biomarker", "eraYear", "eraWindowYears"]);

/**
 * A pool request's `target`, as a plain object of the four strata and nothing
 * else. Anything outside them is dropped by name: a request cannot smuggle a
 * key into applicability.
 * @param {unknown} raw
 */
export function poolTargetOf(raw) {
  /** @type {Record<string, string | number>} */
  const target = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of VCR_POOL_TARGET_KEYS) {
      const value = /** @type {any} */ (raw)[key];
      if (typeof value === "string" && value.trim() && value.length <= 80) target[key] = value.trim();
      else if (Number.isFinite(value) && (key === "eraYear" || key === "eraWindowYears")) target[key] = Number(value);
    }
  }
  return target;
}

/**
 * The pipeline. Everything it needs is injected: the store, the registry
 * client and the job queue (which belongs to another package and may not exist
 * yet — its absence is answered, not assumed).
 *
 * @param {{ store: any, registry?: any, jobs?: any, now?: () => Date, logger?: any }} options
 */
export function createVcrEvidencePipeline({ store, registry = null, jobs = null, now = () => new Date(), logger = null } = { store: null }) {
  if (!store) throw new TypeError("The evidence pipeline needs its store.");

  /** @param {string} message @param {Record<string, unknown>} detail */
  const note = (message, detail) => { logger?.info?.(message, detail); };

  /**
   * Items a run wrote as candidates it found through an evidence card (flywheel F23), and how many of them passed the check every item
   * passes: the share that verified is what says whether the cards are worth reading as leads.
   */
  const counters = { cardCandidates: 0, cardCandidatesVerified: 0 };

  /**
   * A registry read that did not give a record, as the answer the run reads:
   * `available: false`, the code, and whether the record is not there at all
   * (`registry_not_found`) or the registry could not be asked
   * (`registry_unavailable`) — 「没有这条记录」 and 「没能问到」 are different
   * findings (CS-27).
   * @param {{ status?: string, reason?: string }} fetched @param {string} registryName @param {string} registryId @param {string} fetchedAt
   */
  const registryFailure = (fetched, registryName, registryId, fetchedAt) => {
    const notFound = fetched?.status === REGISTRY_NOT_FOUND || fetched?.reason === REGISTRY_NOT_FOUND;
    const reason = String(fetched?.reason ?? fetched?.status ?? "registry_record_unreadable");
    return {
      available: false,
      status: notFound ? REGISTRY_NOT_FOUND : REGISTRY_UNAVAILABLE,
      code: notFound ? REGISTRY_NOT_FOUND : REGISTRY_UNAVAILABLE,
      reason: notFound ? REGISTRY_NOT_FOUND : reason,
      registry: registryName,
      registryId,
      record: null,
      sources: [],
      fetchedAt,
      issues: [{ code: notFound ? REGISTRY_NOT_FOUND : reason, severity: "advisory",
        message: notFound ? "登记平台没有这个登记号的记录。" : `试验登记读取未成功：${reason}` }],
    };
  };

  /**
   * One registry record, fetched and built — or the failure to. `userId` is whose
   * own EviMed key the ChiCTR seat may fall back to where the deployment has none.
   * @param {string} registryName @param {string} registryId @param {string} [userId]
   */
  async function fetchRecord(registryName, registryId, userId = "") {
    if (!registry) return { failure: { status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured" } };
    const wanted = String(registryId ?? "").trim().toLowerCase();
    const fetched = registryName === "chictr"
      ? await registry.searchChictr({ query: String(registryId ?? ""), limit: 5, userId })
      : registryName === "ctis"
        ? (typeof registry.recordCtis === "function" ? await registry.recordCtis(String(registryId ?? "")) : { status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured" })
        : await registry.record(String(registryId ?? ""));
    // A search answers the nearest records, not the record: the one asked for is
    // the one whose own registration number it is, and none of them being it is
    // 「没有这条记录」, never the closest one taken instead.
    const built = registryName === "chictr"
      ? (fetched.items ?? []).find((/** @type {any} */ entry) => String(entry?.precedent?.registryId ?? "").trim().toLowerCase() === wanted)
      : fetched;
    if (fetched.status === "ok" && registryName === "chictr" && !built) return { failure: { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND } };
    if (fetched.status !== "ok" || !built?.precedent) return { failure: fetched };
    return { built };
  }

  const pipeline = {
    get engineReady() { return typeof jobs?.enqueue === "function"; },
    get registryReady() { return Boolean(registry?.configured); },
    registryCoverage() { return registry?.coverage?.() ?? []; },
    /** The coverage as this researcher meets it (a ChiCTR seat whose key is theirs to bring). */
    async registryCoverageFor(/** @type {string} */ userId) { return registry?.coverageFor ? registry.coverageFor(userId) : registry?.coverage?.() ?? []; },

    /**
     * Step 1 — candidates. Registry answers are ranked by similarity and
     * nothing is decided here; a registry that could not be reached is
     * reported, never rendered as an empty library.
     * @param {{ userId: string, studyId?: string | null, target: any, limit?: number, includeChictr?: boolean, includeCtis?: boolean }} input
     */
    async findPrecedents({ userId, studyId = null, target, limit = 20, includeChictr = true, includeCtis = true }) {
      if (!registry) return { status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured", candidates: [], registries: [] };
      /** @type {any[]} */
      const registries = [];
      /** @type {any[]} */
      const candidates = [];

      const ctgov = await registry.search({
        condition: target?.condition ?? "",
        intervention: target?.intervention ?? "",
        phases: target?.phases ?? [],
        status: target?.status ?? [],
        studyType: target?.studyType ?? "",
        hasResults: target?.hasResults ?? null,
        limit,
      });
      registries.push({ registry: "clinicaltrials.gov", status: ctgov.status, reason: ctgov.reason ?? null, total: ctgov.total ?? null });
      for (const item of ctgov.items ?? []) {
        candidates.push({ ...item, similarity: precedentSimilarity({ pico: { conditions: item.conditions, interventions: item.interventions.map((/** @type {string} */ name) => ({ name })) }, design: { phases: item.phases, allocation: item.allocation, hasResults: item.hasResults } }, target) });
      }

      // The other registries are asked together: one that does not answer (a host this deployment cannot
      // reach waits out its deadline) must not hold the others, and its row says so rather than reading as empty.
      const [chictr, ctis] = await Promise.all([
        includeChictr ? registry.searchChictr({ query: target?.condition || target?.intervention || "", limit, userId }) : null,
        includeCtis && typeof registry.searchCtis === "function" ? registry.searchCtis({
          condition: target?.condition ?? "", intervention: target?.intervention ?? "", phases: target?.phases ?? [],
          hasResults: target?.hasResults ?? null, limit,
        }) : null,
      ]);
      if (chictr) {
        registries.push({ registry: "chictr", status: chictr.status, reason: chictr.reason ?? null, total: chictr.total ?? null });
        for (const built of chictr.items ?? []) {
          candidates.push({
            registry: "chictr",
            registryId: built.precedent.registryId,
            title: built.precedent.title,
            conditions: built.precedent.pico.conditions,
            interventions: built.precedent.pico.interventions.map((/** @type {any} */ item) => item.name),
            hasResults: false,
            url: built.record.url,
            similarity: precedentSimilarity(built.precedent, target),
          });
        }
      }

      if (ctis) {
        registries.push({ registry: "ctis", status: ctis.status, reason: ctis.reason ?? null, total: ctis.total ?? null });
        for (const item of ctis.items ?? []) {
          candidates.push({ ...item, similarity: precedentSimilarity({ pico: { conditions: item.conditions, interventions: item.interventions.map((/** @type {string} */ name) => ({ name })) },
            design: { phases: item.phases, allocation: "", hasResults: item.hasResults } }, target) });
        }
      }

      candidates.sort((a, b) => b.similarity.score - a.similarity.score);
      note("vcr.evidence.candidates", { userId, studyId, found: candidates.length });
      return {
        status: registries.some((entry) => entry.status === "ok") ? "ok" : REGISTRY_UNAVAILABLE,
        registries,
        candidates: candidates.slice(0, limit),
      };
    },

    /**
     * The runtime's `trial_registry_record`, served from the control plane.
     *
     * The runtime never reaches a registry itself — it names the record it
     * wants and this answers with structure: the precedent's fields, the
     * quotable values that survived their check, the preserved text the run
     * quotes from, and the named absences. It **never throws and never
     * writes**: a gateway read that fails is `available: false` with a code
     * and a reason (`registry_not_found` is not `registry_unavailable`), and
     * the writing path is `extractPrecedent`.
     *
     * `issues` are notices only (principle 4): a truncated site list, a record
     * with no results section, a value whose quotation did not check out.
     *
     * @param {{ userId?: string, studyId?: string | null, registry?: string, registryId: string }} input
     */
    async readRegistryRecord({ userId = "", studyId = null, registry: registryName = "clinicaltrials.gov", registryId }) {
      const fetchedAt = now().toISOString();
      try {
        const { built, failure } = await fetchRecord(registryName, String(registryId ?? ""), userId);
        if (!built) return registryFailure(failure ?? {}, registryName, String(registryId ?? ""), fetchedAt);

        const checked = (built.extractions ?? []).map((/** @type {any} */ item) => verifyExtraction({
          extraction: item, sourceText: built.record?.text ?? "", checkedAt: fetchedAt,
        }));
        /** @type {{ code: string, severity: string, message: string }[]} */
        const issues = [];
        if (built.precedent.sites?.listTruncated) {
          issues.push({ code: "site_list_truncated", severity: "advisory", message: "中心列表过长已截断；中心数取自登记记录自身的计数。" });
        }
        if (!built.precedent.results?.hasResults) {
          issues.push({ code: "no_results_section", severity: "advisory", message: "该登记记录没有结果模块，只能取设计与入组字段。" });
        }
        for (const entry of checked.filter((/** @type {any} */ item) => !item.verified)) {
          issues.push({ code: "value_unverified", severity: "advisory", message: `「${entry.item.parameter}」的取值未通过原文核对（${entry.state}），已记为 unknown。` });
        }
        note("vcr.evidence.registry_read", { userId, studyId, registry: registryName, registryId, verified: checked.filter((/** @type {any} */ item) => item.verified).length });
        return {
          available: true,
          status: "ok",
          registry: built.precedent.registry,
          registryId: built.precedent.registryId,
          record: {
            ...built.precedent,
            // Structure only. `values` are what may be quoted; the refused ones
            // travel as `unknown` so 「查过、没通过」 is distinguishable from
            // 「没查」 on the page as well as in the ledger.
            values: checked.map((/** @type {any} */ entry) => ({
              parameter: entry.item.parameter,
              arm: entry.item.arm,
              armRole: entry.item.armRole ?? "unknown",
              value: entry.item.value,
              valueText: entry.item.valueText,
              unit: entry.item.unit,
              ciLow: entry.item.ciLow,
              ciHigh: entry.item.ciHigh,
              sampleSize: entry.item.sampleSize,
              events: entry.item.events,
              valueSource: entry.item.valueSource,
              enrollmentKind: entry.item.enrollmentKind,
              historicalBaseline: entry.item.historicalBaseline,
              quote: entry.item.quote,
              locator: entry.item.locator,
              verification: entry.item.locator?.verification ?? "no_quote",
              detail: entry.item.detail ?? {},
            })),
            text: built.record?.text ?? "",
            unavailable: built.precedent.unavailable ?? [],
          },
          sources: built.precedent.sources ?? [],
          fetchedAt,
          issues,
        };
      } catch (error) {
        // A gateway read never throws at its caller: the runtime would see a
        // transport failure where the honest answer is 「这条记录没读到」.
        const reason = String(/** @type {any} */ (error)?.code ?? "request_failed");
        logger?.warn?.("vcr.evidence.registry_read_failed", { registryId, reason });
        return registryFailure({ status: REGISTRY_UNAVAILABLE, reason }, registryName, String(registryId ?? ""), fetchedAt);
      }
    },

    /**
     * Step 2 — one record, extracted and checked. The precedent row (with the
     * text every quotation from it is checked against later) and every
     * extracted value are written in one transaction; a value whose quotation
     * is not in the preserved text lands as `unknown` and can never be cited.
     *
     * `endpointKeys` maps an outcome's title to the endpoint definition the run
     * judged it measures, and `armRoles` maps an arm's or a group's title to
     * `control` / `treatment` (a registry's group titles rarely match its arm
     * labels, so the role is the run's judgment and is stored as a field, which
     * is what lets pooling be an equality).
     *
     * @param {{ userId: string, studyId?: string | null, registry?: string, registryId: string,
     *   applicability?: any, endpointKeys?: Record<string, string>, armRoles?: Record<string, string> }} input
     */
    async extractPrecedent({ userId, studyId = null, registry: registryName = "clinicaltrials.gov", registryId, applicability = {}, endpointKeys = {}, armRoles = {} }) {
      const { built, failure } = await fetchRecord(registryName, String(registryId ?? ""), userId);
      if (!built) {
        const notFound = failure?.status === REGISTRY_NOT_FOUND;
        return { status: notFound ? REGISTRY_NOT_FOUND : (failure?.status ?? REGISTRY_UNAVAILABLE), reason: failure?.reason ?? "registry_record_unreadable", registryId };
      }
      const checkedAt = now().toISOString();
      const verified = (built.extractions ?? []).map((/** @type {any} */ item) => {
        const endpointKey = endpointKeys[String(item?.detail?.outcome ?? "")];
        const role = armRoles[String(item?.arm ?? "")] ?? item?.armRole;
        return verifyExtraction({
          extraction: {
            ...item,
            armRole: EVIDENCE_ARM_ROLES.includes(String(role)) ? role : (item?.armRole ?? "unknown"),
            // The endpoint key is the run's judgment about what was measured,
            // stored as a field so the pooling check can be an equality.
            ...(endpointKey ? { endpointKey } : {}),
            applicability: { ...applicability, ...(endpointKey ? { endpointKey } : {}) },
          },
          sourceText: built.record?.text ?? "",
          checkedAt,
        });
      });

      const saved = await store.transaction(async (/** @type {any} */ client) => {
        const precedentRow = await store.savePrecedent({
          userId, studyId, precedent: built.precedent, recordText: built.record?.text ?? "", recordHash: built.record?.hash ?? null, client,
        });
        const appended = await store.appendEvidenceItems({
          userId, studyId, precedentId: precedentRow?.id ?? null,
          items: verified.map((/** @type {any} */ entry) => entry.item), client,
        });
        return { precedent: precedentRow, ...appended };
      });

      note("vcr.evidence.extracted", { userId, studyId, registryId, verified: saved.verified, refused: saved.refused });
      return {
        status: "ok",
        precedent: saved.precedent,
        record: built.record,
        counts: { extracted: saved.written, verified: saved.verified, refused: saved.refused },
        refusals: verified.filter((/** @type {any} */ entry) => !entry.verified)
          .map((/** @type {any} */ entry) => ({ parameter: entry.item.parameter, arm: entry.item.arm, state: entry.state, quote: entry.item.quote })),
        evidenceIds: saved.ids,
        verifiedEvidenceIds: saved.verifiedIds,
        unavailable: built.precedent.unavailable ?? [],
      };
    },

    /**
     * One value a run read out of a precedent's preserved text, checked in code
     * against that text before it is stored — the run's quotation must be in the
     * record the study holds, and every number it carries (value, bounds, sample
     * size, events) must be in the quotation. A value that fails is stored as
     * `unknown` with the reason and can never be cited. A precedent the study
     * does not hold is refused: the record is fetched with the `precedent` write
     * first, which is what preserves its text.
     *
     * @param {{ userId: string, studyId: string, item: Record<string, any> }} input
     * @returns {Promise<{ status: string, id?: string, state?: string, code?: string, message?: string }>}
     */
    async addEvidenceItem({ userId, studyId, item }) {
      const registryName = String(item.registry ?? "clinicaltrials.gov");
      const registryId = String(item.registryId ?? "");
      const precedent = await store.precedentOfStudy({ userId, studyId, registry: registryName, registryId });
      if (!precedent) {
        return { status: "refused", code: "vcr_precedent_not_in_study",
          message: `${registryId} 还不在本研究的先例里；先用 vcr_write what:"precedent" 取回这条登记记录。` };
      }
      const derived = ["calculated", "imputed", "predicted"].includes(String(item.valueSource ?? ""));
      const checkedAt = now().toISOString();
      const checked = verifyExtraction({
        extraction: {
          parameter: String(item.parameter), arm: item.arm ?? null,
          armRole: EVIDENCE_ARM_ROLES.includes(String(item.armRole)) ? item.armRole : "unknown",
          value: item.value ?? null, valueText: item.valueText ?? "", unit: item.unit ?? "",
          ciLow: item.ciLow ?? null, ciHigh: item.ciHigh ?? null, sampleSize: item.sampleSize ?? null, events: item.events ?? null,
          valueSource: derived ? String(item.valueSource) : "extracted",
          quote: String(item.quote ?? ""), sourceRef: `${registryName}:${registryId}`,
          locator: { kind: "registry_field", ...(item.locator && typeof item.locator === "object" ? {
            path: typeof item.locator.path === "string" ? item.locator.path : undefined,
            inputs: Array.isArray(item.locator.inputs) ? item.locator.inputs.map(String) : undefined,
          } : {}), authoredBy: "run" },
          endpointKey: String(item.endpointKey ?? ""),
          enrollmentKind: item.enrollmentKind ?? null,
          historicalBaseline: item.historicalBaseline === true,
          applicability: { line: item.line, biomarker: item.biomarker, endpointKey: String(item.endpointKey ?? "") },
          // `candidateFrom` and `source` are the run's own statements, kept beside the verdict and read by nothing that decides it.
          detail: { outcome: item.outcome ?? null, note: item.note ?? null,
            ...(item.candidateFrom ? { candidateFrom: item.candidateFrom } : {}), ...(item.source ? { source: String(item.source) } : {}) },
        },
        sourceText: String(precedent.record_text ?? ""),
        checkedAt,
      });
      const appended = await store.appendEvidenceItems({ userId, studyId, precedentId: precedent.id, items: [checked.item] });
      if (item.candidateFrom) {
        counters.cardCandidates += 1;
        if (checked.verified) counters.cardCandidatesVerified += 1;
      }
      return { status: "ok", id: appended.ids[0], state: checked.state };
    },

    /**
     * The precedent library as a person reads it: the account's own, by title
     * or registry id (`query`).
     * @param {{ id: string | number }} user @param {{ q?: string, limit?: number | string }} [query]
     */
    async precedents(user, query = {}) {
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(query.limit ?? ""), 10) || 100));
      return store.listPrecedents({ userId: String(user.id), search: String(query.q ?? ""), limit });
    },

    /**
     * Step 3 — pool one parameter, once per calibre. Returns the queued jobs;
     * reading them back is step 4. With no queue this answers
     * `engine_unavailable` and produces nothing.
     *
     * The job is built from this study's verified items only, the latest row per
     * `(precedent, parameter, arm, endpoint key)`, on the analysis scale. An
     * empty endpoint key is refused, and so is a pool with no arm role it can
     * name: pooling is between values that are known to measure the same thing
     * in the same arm (CS-26).
     *
     * @param {{ userId: string, studyId: string, parameter: string, endpointKey?: string, armRole?: string,
     *   target?: any, poolingMethod?: string, calibres?: readonly string[] | null, scale?: string }} input
     */
    async poolParameter({ userId, studyId, parameter, endpointKey = "", armRole = "", target = {}, poolingMethod = "random_effects_reml", calibres: wanted = null, scale = "" }) {
      const role = armRole || defaultArmRoleOf(parameter);
      if (!String(endpointKey ?? "").trim()) {
        return { status: "refused", code: "vcr_pool_endpoint_key_required", parameter,
          message: "合并需要写明终点口径（endpointKey）：口径不同的值不知道量的是不是同一件事。", jobs: [] };
      }
      // Every study's newest row, verified or not: the eligibility check names
      // the ones it leaves out and why (`quote_not_verified` among them). Reading
      // only the verified ones would drop an unverified study without a trace.
      const rows = await store.listEvidenceItems({ userId, studyId, parameter, latestOnly: true });
      const eligibility = poolEligibility({ items: rows, endpointKey, armRole: role });
      if (!eligibility.eligible.length) {
        return { status: "no_evidence", parameter, endpointKey, armRole: role, refused: eligibility.refused.map((entry) => ({ id: entry.item?.id, reasons: entry.reasons })), jobs: [] };
      }
      if (typeof jobs?.enqueue !== "function") {
        return { status: "engine_unavailable", parameter, eligible: eligibility.eligible.length, jobs: [] };
      }
      const precedentById = new Map();
      for (const row of await store.listPrecedents({ userId, studyId, limit: 500 })) precedentById.set(row.id, row);
      const asOf = now();
      const withStrata = eligibility.eligible.map((item) => ({
        ...item,
        precedent: precedentById.get(item.precedent_id) ?? null,
        stratum: applicabilityStratum({ precedent: precedentById.get(item.precedent_id) ?? {}, item, target, now: asOf }),
      }));

      /** @type {any[]} */
      const queued = [];
      /** @type {Record<string, string[]>} */
      const evidenceIdsByCalibre = {};
      /** @type {Record<string, any[]>} */
      const excludedByCalibre = {};
      for (const calibre of calibres({ items: withStrata, target })) {
        if (wanted && !wanted.includes(calibre.name)) continue;
        const built = poolJob({ studyId, parameter, endpointKey, armRole: role, calibre: calibre.name, items: calibre.items, scale, poolingMethod });
        evidenceIdsByCalibre[calibre.name] = built.evidenceIds;
        excludedByCalibre[calibre.name] = built.excluded;
        if (!built.valid) {
          queued.push({ calibre: calibre.name, status: "job_invalid", issues: built.issues, excluded: built.excluded });
          continue;
        }
        try {
          const enqueued = await jobs.enqueue({
            studyId,
            userId,
            kind: "pool_evidence",
            scenario: built.job.scenario,
            inputs: built.job.inputs,
            seed: built.job.seed,
            cpuSecondsLimit: built.job.cpuSecondsLimit,
            // The same parameter, calibre and studies asked for twice is the
            // same job; the seed already makes the answer identical.
            idempotencyKey: `vcr-pool:${studyId}:${parameter}:${endpointKey}:${role}:${calibre.name}:${built.job.seed}`,
            // What the pool is about, and the name its result is filed under:
            // three calibres are three results, not one superseding the others.
            detail: { origin: "evidence", subjectId: `pool:${parameter}:${endpointKey}:${role}:${calibre.name}`, ...built.about },
          });
          // `vcrJobs.enqueue` answers `{ job, created }`; a bare `{ jobId }`
          // is read too so a double in a test does not have to build a row.
          const row = enqueued?.job ?? enqueued;
          queued.push({
            calibre: calibre.name,
            status: String(row?.state ?? "queued"),
            jobId: row?.id ?? row?.jobId ?? null,
            created: enqueued?.created !== false,
            seed: built.job.seed,
            studies: built.evidenceIds.length,
            excluded: built.excluded,
          });
        } catch (error) {
          // One calibre the queue refused (over budget, a scenario it will not
          // take) is one calibre missing from the card, not a parameter with no
          // evidence: the others still go.
          queued.push({
            calibre: calibre.name,
            status: "enqueue_refused",
            reason: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? "enqueue_failed"),
            studies: built.evidenceIds.length,
          });
        }
      }
      return {
        status: "queued", parameter, endpointKey, armRole: role, jobs: queued, evidenceIdsByCalibre,
        refused: eligibility.refused.map((entry) => ({ id: entry.item?.id, reasons: entry.reasons })),
      };
    },

    /**
     * Step 4 and 5 — read the engine's answers back, choose the calibre, and
     * save the card. `results` is `{ calibre: engineResult }`; a calibre that
     * did not succeed is simply absent, and if none did the card is not
     * written. When the default calibre's pool has no prediction interval (k < 3)
     * the value is written as the expert setting the plan calls for — widened,
     * labelled, its source named — never as a card that borrows the confidence
     * interval for a prediction interval.
     *
     * @param {{ userId: string, studyId: string, key: string, name: string, parameter: string,
     *   endpoint?: string, unit?: string, results: Record<string, any>,
     *   evidenceIdsByCalibre: Record<string, string[]>, applicability?: any, note?: string }} input
     */
    async saveAssumptionFromPooling({ userId, studyId, key, name, parameter, endpoint = "", unit = "", results, evidenceIdsByCalibre, applicability = {}, note: cardNote = "" }) {
      /** @type {Record<string, ReturnType<typeof readPoolResult>>} */
      const pools = {};
      for (const [calibre, result] of Object.entries(results ?? {})) pools[calibre] = readPoolResult(result);
      const built = assumptionFromPooling({ key, name, parameter, endpoint, unit, pools, evidenceIdsByCalibre, applicability, note: cardNote });
      if (built.ok) {
        const row = await store.saveAssumption({ userId, studyId, card: built.card });
        note("vcr.evidence.card", { userId, studyId, key, calibre: built.card?.pooling.calibre });
        return { status: "ok", assumption: row, card: built.card, pools };
      }
      if (built.reason === "prediction_interval_missing" && built.nearest) {
        const { calibre, pool } = built.nearest;
        const scale = String(pool.scale ?? defaultScaleOf(parameterKindOf(parameter)));
        const nearest = {
          pointValue: naturalOf(/** @type {number} */ (pool.pooled), scale),
          range: pool.confidence ? { low: naturalOf(pool.confidence.low, scale), high: naturalOf(pool.confidence.high, scale) } : null,
        };
        const card = expertSetCard({
          key, name, parameter, unit, nearest, applicability: { ...applicability, calibre },
          reason: `只有 ${pool.k ?? "少数"} 项研究，合并结果没有预测区间；取合并值并按置信区间加宽`,
          basedOn: { evidenceIds: evidenceIdsByCalibre?.[calibre] ?? [], calibre, k: pool.k ?? null },
        });
        const row = await store.saveAssumption({ userId, studyId, card });
        return { status: "expert_set", reason: built.reason, assumption: row, card, pools };
      }
      return { status: "not_written", reason: built.reason, pools };
    },

    /**
     * A parameter no evidence reached. Written as a card so a simulation can
     * run and the gap stays visible (plan §6.2).
     * @param {{ userId: string, studyId: string, key: string, name: string, parameter?: string,
     *   unit?: string, nearest: any, reason: string, applicability?: any }} input
     */
    async saveExpertSet({ userId, studyId, key, name, parameter = "", unit = "", nearest, reason, applicability = {} }) {
      const card = expertSetCard({ key, name, parameter, unit, nearest, reason, applicability });
      const row = await store.saveAssumption({ userId, studyId, card });
      return { status: "ok", assumption: row, card };
    },

    /**
     * The study's current cards and the coverage behind them, for the
     * 「数据与证据」 page and for the deliverable's `results.json`.
     * @param {{ userId: string, studyId: string }} input
     */
    async parameterisation({ userId, studyId }) {
      const [cards, coverage, precedents] = await Promise.all([
        store.latestAssumptions({ studyId }),
        store.evidenceCoverage({ userId, studyId }),
        store.listPrecedents({ userId, studyId, limit: 200 }),
      ]);
      return {
        cards,
        coverage,
        precedents,
        unavailable: unavailableParameters(),
        counts: {
          cards: cards.length,
          aiSet: cards.filter((/** @type {any} */ card) => card.review_state === "ai_set").length,
          expertSet: cards.filter((/** @type {any} */ card) => card.source_kind === "expert_set").length,
        },
      };
    },

    // ---------------------------------------------------------------------
    // The seam `vcrService` mounts as `packages.evidence` (build contract
    // §3.2). Two thin adapters and nothing else: the study carries the
    // account, so a runtime read never names one, and the filter is the
    // gateway's already-bounded object.
    // ---------------------------------------------------------------------

    /**
     * The evidence half of the 「数据与证据」 tab (`vcrService.#dataTab`). The
     * page needs three things at once: which precedents this study pulled in,
     * how much of each parameter survived its quote check, and which cards
     * nobody has reviewed yet.
     * @param {any} study @param {any} [_user]
     */
    async tab(study, _user) {
      const view = await pipeline.parameterisation({ userId: String(study?.userId ?? ""), studyId: String(study?.id ?? "") });
      return {
        available: true,
        registryConfigured: Boolean(registry?.configured),
        registryCoverage: await pipeline.registryCoverageFor(String(study?.userId ?? "")),
        // The page says so rather than showing an empty pooling panel: with no
        // queue there is no card, and that is a deployment fact, not a result.
        engineConfigured: typeof jobs?.enqueue === "function",
        precedents: view.precedents.length,
        coverage: view.coverage,
        cards: view.cards,
        counts: view.counts,
        unavailable: view.unavailable,
      };
    },

    /** @param {any} study @param {Record<string, any>} [filter] */
    async registryRecord(study, filter = {}) {
      return pipeline.readRegistryRecord({
        userId: String(study?.userId ?? ""),
        studyId: study?.id ?? null,
        registry: String(filter?.registry || "clinicaltrials.gov"),
        registryId: String(filter?.registryId ?? ""),
      });
    },

    /**
     * `read { what: "precedents" }`. Aggregates and structure only: a
     * precedent is a public registry record, and what the run is handed is the
     * comparison table — planned against actual — plus how much of each
     * parameter is verified and which cards exist.
     * @param {any} study @param {Record<string, any>} [filter]
     */
    async runtimeRead(study, filter = {}) {
      const userId = String(study?.userId ?? "");
      const studyId = String(study?.id ?? "");
      const limit = Number.isSafeInteger(filter?.limit) ? Number(filter.limit) : 50;
      const [precedents, coverage, cards] = await Promise.all([
        store.listPrecedents({ userId, studyId, search: String(filter?.query ?? ""), limit, offset: Number(filter?.offset ?? 0) }),
        store.evidenceCoverage({ userId, studyId }),
        store.latestAssumptions({ studyId }),
      ]);
      return {
        precedents: precedents.map((/** @type {any} */ row) => ({
          registry: row.registry,
          registryId: row.registry_id,
          title: row.title,
          phases: row.design?.phases ?? [],
          allocation: row.design?.allocation ?? "",
          overallStatus: row.design?.overallStatus ?? "",
          hasResults: Boolean(row.results?.hasResults),
          plannedEnrollment: row.enrollment?.planned ?? null,
          actualEnrollment: row.enrollment?.actual ?? null,
          accrualMonths: row.enrollment?.accrualToPrimaryCompletionMonths ?? null,
          sites: row.sites?.count ?? null,
          countries: row.sites?.countries ?? [],
        })),
        coverage,
        assumptions: cards.map((/** @type {any} */ card) => ({
          key: card.key, version: card.version, name: card.name, pointValue: card.point_value,
          sourceKind: card.source_kind, reviewState: card.review_state,
          calibre: card.pooling?.calibre ?? null, evidenceCount: (card.evidence_ids ?? []).length,
        })),
        unavailable: unavailableParameters(),
      };
    },

    /**
     * `read { what: "evidence" }`: the study's extracted values, the ids a card
     * may cite, with each value's own words and place — a run cannot cite what it
     * cannot name, and the platform's own record of what was quoted is exactly
     * what it should read before it writes a card. Unverified values are listed
     * with their state so 「查过、没通过」 is visible.
     * @param {any} study @param {Record<string, any>} [filter]
     */
    async evidenceRead(study, filter = {}) {
      const userId = String(study?.userId ?? "");
      const studyId = String(study?.id ?? "");
      const limit = Number.isSafeInteger(filter?.limit) ? Number(filter.limit) : 50;
      const offset = Number.isSafeInteger(filter?.offset) ? Number(filter.offset) : 0;
      const rows = await store.listEvidenceItems({ userId, studyId, parameter: filter?.kind ? String(filter.kind) : null, latestOnly: true, limit: 2000 });
      const precedents = new Map((await store.listPrecedents({ userId, studyId, limit: 500 })).map((/** @type {any} */ row) => [String(row.id), row]));
      const page = rows.slice(offset, offset + limit);
      return {
        items: page.map((/** @type {any} */ row) => ({
          id: row.id, parameter: row.parameter, arm: row.arm, armRole: row.arm_role, endpointKey: row.endpoint_key,
          value: row.value === null ? null : Number(row.value), unit: row.unit,
          ciLow: row.ci_low === null ? null : Number(row.ci_low), ciHigh: row.ci_high === null ? null : Number(row.ci_high),
          sampleSize: row.sample_size, events: row.events, valueSource: row.value_source,
          verification: row.locator?.verification ?? "no_quote", historicalBaseline: row.historical_baseline,
          enrollmentKind: row.enrollment_kind, quote: row.quote, sourceRef: row.source_ref,
          ...(row.detail?.candidateFrom ? { candidateFrom: row.detail.candidateFrom } : {}),
          registry: precedents.get(String(row.precedent_id))?.registry ?? null,
          registryId: precedents.get(String(row.precedent_id))?.registry_id ?? null,
        })),
        more: rows.length > offset + limit,
      };
    },

    /**
     * The verified evidence ids of one parameter, which an `external_evidence`
     * card may cite.
     * @param {{ userId: string, studyId: string, parameter: string }} input
     */
    verifiedEvidenceIds(input) { return store.verifiedEvidenceIds(input); },

    counters,
  };
  return pipeline;
}

/** Exported for the manifest and the tests: every vocabulary word this module writes. */
export const VCR_EVIDENCE_WRITES = Object.freeze({
  sourceKinds: VCR_ASSUMPTION_SOURCE_KINDS,
  valueSources: VCR_VALUE_SOURCES,
  distributions: VCR_DISTRIBUTIONS,
  poolingMethods: VCR_POOLING_METHODS,
  assumptionKey: VCR_ASSUMPTION_KEY,
});
