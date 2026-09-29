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
 *   4. `assumptionFromPooling` — turn the engine's pooled value, heterogeneity
 *      and prediction interval into the distribution a simulation draws from;
 *   5. `applicability`   — say how the source population differs from this
 *      study's, and which calibre is the default.
 *
 * Hidden knowledge:
 *
 * - **Nothing here estimates anything.** The pooled value, τ², I² and the
 *   prediction interval all come back from `vcr-engine` (`evidence.pool`,
 *   cross-checked against metafor). The only arithmetic in this module is the
 *   closed-form re-parameterization of those numbers into a distribution
 *   family — proportion → Beta by moment matching, time and hazard ratio →
 *   log-normal — and `vcrEvidence.test.mjs` pins each one against a
 *   hand-worked value. If the engine cannot be reached, a card is not
 *   produced: 「引擎不可用」 is an answer, a made-up mean is not.
 * - **The prediction interval is the range a simulation may use**, not the
 *   confidence interval (plan §6.1). A confidence interval says where the
 *   average of these studies lies; a simulation is asking where *the next
 *   study* lands, and with real heterogeneity the two differ by a lot. Cards
 *   are built from the prediction interval and the confidence interval is kept
 *   only for display.
 * - **A quotation is checked with the platform's own comparison**
 *   (`quoteIsPresent` from `@evimed/domain/clinical-evidence`), the same one
 *   the delivery gate and the reader's ✓/⚠ use. A second implementation here
 *   would be a second verdict, and the two would disagree on the day it
 *   mattered.
 * - **A verbatim quotation is not enough: the number has to be in it.** A
 *   quote can be genuine and still not contain the figure it is offered for —
 *   that is how an unanchored number gets into a card while every check passes.
 *   `numberIsInQuote` requires the value to appear as a complete numeric token
 *   of the quotation, so 46,969 cannot be anchored to a sentence about 24.
 * - **Similarity ranks candidates and nothing else** (plan §6.4). Pooling
 *   eligibility is a separate, per-item decision over declared fields:
 *   same endpoint key, an actual (not planned) figure, a verified quote. Two
 *   trials can be 0.95 similar and still not poolable because one measured
 *   investigator-assessed PFS and the other blinded review.
 * - **Which stratum a study belongs to is declared, not inferred from prose.**
 *   Treatment line and biomarker are read from structured fields the run
 *   wrote; an absent one is `unknown` and `unknown` never matches a target.
 *   Region comes from the registry's country list and era from its start date,
 *   which are a lookup and a subtraction — those stay in code (principle 1:
 *   regex never does language).
 * - **Three calibres, always; the default is chosen by a stated rule.** The
 *   closest subset, everything, and the next-closest subset are each pooled.
 *   When the strata disagree — the closest subset's pooled value falls outside
 *   the overall prediction interval, or the overall I² is at or above
 *   `HETEROGENEOUS_I2` — the default is the closest subset and the other two
 *   are sensitivity analyses; otherwise the default is the overall pool.
 *   Nothing is hidden either way (plan §6.2 step 5).
 * - **A parameter with no evidence gets a card, not a blank.** The nearest
 *   evidence widened by `EXPERT_WIDEN_FACTOR`, labelled
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
  VCR_ASSUMPTION_SOURCE_KINDS, VCR_DISTRIBUTIONS, VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION,
  VCR_JOB_METHODS, VCR_POOLING_METHODS, VCR_VALUE_SOURCES, canonicalScenarioJson, validateEngineJob,
} from "@evimed/domain";
import { quoteIsPresent } from "@evimed/domain/clinical-evidence";

import { REGISTRY_UNAVAILABLE, REGISTRY_UNAVAILABLE_PARAMETERS } from "./trialRegistryClient.mjs";

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

/** Numeric tokens of a text, as numbers. A complete token only: 4 of 46,969 is not a match. */
const NUMBER_TOKEN = /(?<![\d.])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\d.,])[+-]?\d+(?:\.\d+)?(?![\d.])/g;

/**
 * Does the quotation actually contain the number it is offered for?
 *
 * Equality is exact, then at the precision the quotation itself states: a
 * quotation reading `0.46` anchors 0.46 and 0.4600, and does not anchor 0.463.
 * Percentages are matched both ways only when the unit says so, because
 * 「12.4」 and 「0.124」 are the same rate written two ways and a card may carry
 * either.
 *
 * @param {string} quote @param {number} value @param {{ unit?: string }} [options]
 */
export function numberIsInQuote(quote, value, { unit = "" } = {}) {
  const target = finite(value);
  if (target === null) return false;
  const percent = /%|percent|百分/i.test(String(unit ?? ""));
  const candidates = percent ? [target, target * 100, target / 100] : [target];
  for (const match of String(quote ?? "").matchAll(NUMBER_TOKEN)) {
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

/**
 * Check one extracted value against the text it says it came from, and return
 * the row that will be stored either way.
 *
 * A value that fails is not dropped — it is stored as `unknown` with the
 * reason, so the attempt stays on the record and the card-building reader
 * (`verifiedEvidenceIds`) passes it over. Nothing that fails here can reach an
 * assumption card (AC-25).
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
  /** @type {string} */
  let state;
  if (!quote) state = "no_quote";
  else if (!String(sourceText ?? "").trim()) state = "source_unavailable";
  else if (!quoteIsPresent(sourceText, quote)) state = "quote_not_found";
  else if (derived) {
    const missing = inputs.filter((path) => !pathIsInSource(sourceText, path));
    state = !inputs.length ? "derived_inputs_missing" : missing.length ? "derived_input_not_found" : "verified";
  } else if (value !== null && !numberIsInQuote(quote, value, { unit: extraction?.unit })) state = "quote_missing_number";
  // A value with no number carries text instead — a date, a status. It has to
  // be in the quotation the same way a number does.
  else if (value === null && valueText && !quoteIsPresent(quote, valueText)) state = "quote_missing_value";
  else state = "verified";

  const verified = state === "verified";
  return {
    state,
    verified,
    item: {
      ...extraction,
      value: verified ? extraction?.value ?? null : null,
      valueText: verified ? String(extraction?.valueText ?? "") : "unknown",
      locator: {
        ...(extraction?.locator ?? {}),
        // Stored beside the locator because it is the locator that was
        // checked: 「这个位置上确实有这句话，这句话里确实有这个数」.
        verification: verified ? "verified"
          : ["quote_missing_number", "quote_missing_value", "derived_input_not_found", "derived_inputs_missing"].includes(state)
            ? "quote_not_found" : state,
        ...(verified ? {} : { verificationDetail: state }),
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

/**
 * Which stratum a precedent's values belong to, on the four keys applicability
 * is judged on. `line` and `biomarker` are read from declared fields, never
 * inferred from a title; absent means `unknown`, and `unknown` never matches.
 *
 * @param {{ precedent?: any, item?: any, target?: any }} input
 */
export function applicabilityStratum({ precedent = {}, item = {}, target = {} }) {
  const countries = (precedent?.sites?.countries ?? []).map((/** @type {string} */ country) => String(country).toLowerCase());
  const region = countries.length
    ? countries.includes("china") ? "china"
      : countries.some((country) => ["japan", "korea", "republic of korea", "taiwan", "singapore", "hong kong"].includes(country)) ? "east_asia"
        : countries.length > 3 ? "multinational" : "other"
    : "unknown";
  const startYear = Number(String(precedent?.enrollment?.milestones?.start_date?.date ?? "").slice(0, 4));
  const eraYear = Number(target?.eraYear) || new Date().getUTCFullYear();
  const eraWindow = Number(target?.eraWindowYears) || 5;
  const era = Number.isFinite(startYear) && startYear > 1900
    ? (eraYear - startYear <= eraWindow ? "recent" : "older")
    : "unknown";
  const declared = (/** @type {string} */ key) => {
    const value = item?.applicability?.[key] ?? precedent?.pico?.[key] ?? precedent?.applicability?.[key];
    const asText = String(value ?? "").trim().toLowerCase();
    return asText || "unknown";
  };
  return { region, line: declared("line"), era, biomarker: declared("biomarker") };
}

/**
 * Mismatches between a stratum and the target, on the keys the target actually
 * declares. `unknown` counts as a mismatch — a study whose treatment line
 * nobody recorded is not evidence that it matches.
 * @param {Record<string, string>} stratum @param {any} target
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
 * Per-item pooling eligibility: same endpoint key, verified, an actual figure
 * rather than a sponsor's plan, and a number to pool. Every refusal names its
 * reason; nothing is dropped quietly.
 *
 * @param {{ items: readonly any[], endpointKey?: string, requireHistoricalBaseline?: boolean }} input
 */
export function poolEligibility({ items, endpointKey = "", requireHistoricalBaseline = true }) {
  /** @type {{ item: any, eligible: boolean, reasons: string[] }[]} */
  const verdicts = [];
  for (const item of items ?? []) {
    /** @type {string[]} */
    const reasons = [];
    const verification = String(item?.locator?.verification ?? item?.verification ?? "");
    if (verification !== "verified") reasons.push("quote_not_verified");
    if (finite(item?.value) === null) reasons.push("no_value");
    const key = String(item?.endpointKey ?? item?.detail?.endpointKey ?? item?.applicability?.endpointKey ?? "").trim();
    if (endpointKey) {
      if (!key) reasons.push("endpoint_key_missing");
      else if (key !== endpointKey) reasons.push("endpoint_key_differs");
    }
    if (requireHistoricalBaseline && item?.historicalBaseline === false) reasons.push("estimated_not_actual");
    verdicts.push({ item, eligible: reasons.length === 0, reasons });
  }
  return {
    eligible: verdicts.filter((verdict) => verdict.eligible).map((verdict) => verdict.item),
    refused: verdicts.filter((verdict) => !verdict.eligible),
    verdicts,
  };
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
 * The `evidence.pool` job for one calibre of one parameter. Validated against
 * the engine protocol before anyone queues it: a job the engine would refuse
 * is refused here, with the field named.
 *
 * @param {{ studyId: string, parameter: string, endpointKey?: string, calibre: string,
 *   items: readonly any[], scale?: string, poolingMethod?: string, cpuSecondsLimit?: number }} input
 */
export function poolJob({ studyId, parameter, endpointKey = "", calibre, items, scale = "", poolingMethod = "random_effects_reml", cpuSecondsLimit = 120 }) {
  const kind = VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (parameter)] ?? "continuous";
  const method = VCR_JOB_METHODS.pool_evidence;
  const chosenScale = scale || (kind === "proportion" ? "logit" : kind === "ratio" || kind === "time" ? "log" : "identity");
  const studies = (items ?? []).map((item) => ({
    evidenceId: String(item?.id ?? ""),
    value: finite(item?.value),
    ciLow: finite(item?.ci_low ?? item?.ciLow),
    ciHigh: finite(item?.ci_high ?? item?.ciHigh),
    sampleSize: finite(item?.sample_size ?? item?.sampleSize),
    events: finite(item?.events),
    arm: String(item?.arm ?? ""),
    sourceRef: String(item?.source_ref ?? item?.sourceRef ?? ""),
  }));
  const scenario = {
    parameter,
    parameterKind: kind,
    endpointKey,
    calibre,
    scale: chosenScale,
    poolingMethod: VCR_POOLING_METHODS.includes(poolingMethod) ? poolingMethod : "random_effects_reml",
    confidenceLevel: 0.95,
    predictionInterval: true,
    studies,
  };
  const inputs = studies
    .filter((study) => study.evidenceId)
    .map((study) => ({ kind: "evidence", id: study.evidenceId, hash: null, value: study }));
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
    inputs,
  };
  const issues = validateEngineJob(job);
  return { job, issues, valid: issues.length === 0 };
}

/**
 * Read what `evidence.pool` answered. Tolerant about where the numbers sit
 * (a measure's own `interval`, or a second measure named `prediction`), strict
 * about them being there: a pooled value with no prediction interval is not a
 * usable answer, and says so rather than falling back to the confidence
 * interval.
 *
 * @param {any} result
 * @returns {{ ok: boolean, reason?: string, scale?: string, poolingMethod?: string, k?: number | null,
 *   pooled?: number, confidence?: { low: number, high: number } | null,
 *   prediction?: { low: number, high: number }, i2?: number | null, tau2?: number | null }}
 */
export function readPoolResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result_missing" };
  if (result.status && result.status !== "succeeded") return { ok: false, reason: `engine_${result.status}` };
  const measures = Array.isArray(result.measures) ? result.measures : [];
  /** @param {string} name */
  const measure = (name) => measures.find((entry) => String(entry?.name ?? "") === name);
  const pooledMeasure = measure("pooled");
  const pooled = finite(pooledMeasure?.value);
  if (pooled === null) return { ok: false, reason: "pooled_value_missing" };
  const predictionMeasure = measure("prediction") ?? measure("prediction_interval");
  const predictionSource = predictionMeasure?.interval?.kind === "prediction" ? predictionMeasure.interval
    : pooledMeasure?.predictionInterval ?? (pooledMeasure?.interval?.kind === "prediction" ? pooledMeasure.interval : null);
  const low = finite(predictionSource?.low);
  const high = finite(predictionSource?.high);
  if (low === null || high === null || !(high >= low)) return { ok: false, reason: "prediction_interval_missing" };
  const confidenceSource = pooledMeasure?.interval?.kind === "confidence" ? pooledMeasure.interval : measure("confidence")?.interval ?? null;
  return {
    ok: true,
    scale: String(result.diagnostics?.scale ?? "identity"),
    poolingMethod: String(result.diagnostics?.poolingMethod ?? "random_effects_reml"),
    k: finite(measure("k")?.value ?? result.diagnostics?.k),
    pooled,
    confidence: finite(confidenceSource?.low) !== null && finite(confidenceSource?.high) !== null
      ? { low: Number(confidenceSource.low), high: Number(confidenceSource.high) } : null,
    prediction: { low, high },
    i2: finite(measure("i_squared")?.value ?? result.diagnostics?.i2),
    tau2: finite(measure("tau_squared")?.value ?? result.diagnostics?.tau2),
  };
}

/** Inverse logit, used only to bring a pooled logit back to the proportion scale. @param {number} value */
const expit = (value) => 1 / (1 + Math.exp(-value));

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
  const outside = closest.pooled < overall.prediction.low || closest.pooled > overall.prediction.high;
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
 * @param {{ key: string, name: string, parameter: string, endpoint?: string, unit?: string,
 *   pools: Record<string, ReturnType<typeof readPoolResult>>, evidenceIdsByCalibre: Record<string, string[]>,
 *   applicability?: any, note?: string }} input
 */
export function assumptionFromPooling({ key, name, parameter, endpoint = "", unit = "", pools, evidenceIdsByCalibre, applicability = {}, note = "" }) {
  const kind = VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (parameter)] ?? "continuous";
  const chosen = chooseCalibre(pools);
  if (!chosen.calibre) return { ok: false, reason: chosen.reason, card: null };
  const pool = pools[chosen.calibre];
  const distribution = distributionFromPooled({ kind, pooled: pool.pooled, prediction: pool.prediction, scale: pool.scale });
  /** @type {any[]} */
  const sensitivity = [];
  for (const calibre of VCR_CALIBRES) {
    const other = pools?.[calibre];
    if (calibre === chosen.calibre || !other?.ok) continue;
    const otherDistribution = distributionFromPooled({ kind, pooled: other.pooled, prediction: other.prediction, scale: other.scale });
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
 * @param {{ key: string, name: string, parameter?: string, unit?: string, nearest: any,
 *   reason: string, applicability?: any }} input
 */
export function expertSetCard({ key, name, parameter = "", unit = "", nearest, reason, applicability = {} }) {
  const kind = VCR_PARAMETER_KINDS[/** @type {keyof typeof VCR_PARAMETER_KINDS} */ (parameter)] ?? "continuous";
  const point = finite(nearest?.pointValue ?? nearest?.value);
  const low = finite(nearest?.range?.low ?? nearest?.low);
  const high = finite(nearest?.range?.high ?? nearest?.high);
  /** @type {any} */
  let distribution;
  if (point === null) {
    distribution = { family: "empirical", params: {}, range: null };
  } else if (low !== null && high !== null && high > low) {
    const widen = EXPERT_WIDEN_FACTOR;
    const centre = kind === "time" || kind === "ratio" ? Math.log(Math.max(point, Number.MIN_VALUE)) : point;
    const halfWidth = ((kind === "time" || kind === "ratio" ? Math.log(high) - Math.log(low) : high - low) / 2) * widen;
    const widenedLow = kind === "time" || kind === "ratio" ? Math.exp(centre - halfWidth) : centre - halfWidth;
    const widenedHigh = kind === "time" || kind === "ratio" ? Math.exp(centre + halfWidth) : centre + halfWidth;
    const bounded = kind === "proportion"
      ? { low: Math.max(0, widenedLow), high: Math.min(1, widenedHigh) }
      : { low: widenedLow, high: widenedHigh };
    distribution = {
      family: "empirical",
      params: { point, support: [bounded.low, bounded.high], widenedBy: widen },
      range: { kind: "prediction", ...bounded },
    };
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
    pooling: { basedOn: nearest?.source ?? nearest?.key ?? null, widenedBy: EXPERT_WIDEN_FACTOR, reason },
    // An expert setting cites no extracted value, on purpose: it is not
    // evidence and must not read as if it were (AC-25).
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

  const pipeline = {
    get engineReady() { return typeof jobs?.enqueue === "function"; },
    get registryReady() { return Boolean(registry?.configured); },

    /**
     * Step 1 — candidates. Registry answers are ranked by similarity and
     * nothing is decided here; a registry that could not be reached is
     * reported, never rendered as an empty library.
     * @param {{ userId: string, studyId?: string | null, target: any, limit?: number, includeChictr?: boolean }} input
     */
    async findPrecedents({ userId, studyId = null, target, limit = 20, includeChictr = true }) {
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

      if (includeChictr) {
        const chictr = await registry.searchChictr({ query: target?.condition || target?.intervention || "", limit });
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
     * writes**: a gateway read that fails is `registry_unavailable` with a
     * reason, and the writing path is `extractPrecedent`.
     *
     * `issues` are notices only (principle 4): a truncated site list, a record
     * with no results section, a value whose quotation did not check out.
     *
     * @param {{ userId?: string, studyId?: string | null, registry?: string, registryId: string }} input
     */
    async readRegistryRecord({ userId = "", studyId = null, registry: registryName = "clinicaltrials.gov", registryId }) {
      const fetchedAt = now().toISOString();
      const unreachable = (/** @type {string} */ reason) => ({
        status: REGISTRY_UNAVAILABLE,
        reason,
        registry: registryName,
        registryId: String(registryId ?? ""),
        record: null,
        sources: [],
        fetchedAt,
        issues: [{ code: reason, severity: "advisory", message: `试验登记读取未成功：${reason}` }],
      });
      if (!registry) return unreachable("registry_not_configured");
      try {
        const fetched = registryName === "chictr"
          ? await registry.searchChictr({ query: String(registryId ?? ""), limit: 1 })
          : await registry.record(String(registryId ?? ""));
        const built = registryName === "chictr" ? (fetched.items ?? [])[0] : fetched;
        if (fetched.status !== "ok" || !built?.precedent) return unreachable(fetched.reason ?? fetched.status ?? "registry_record_unreadable");

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
        return unreachable(reason);
      }
    },

    /**
     * Step 2 — one record, extracted and checked. The precedent row and every
     * extracted value are written in one transaction; a value whose quotation
     * is not in the preserved text lands as `unknown` and can never be cited.
     * @param {{ userId: string, studyId?: string | null, registry?: string, registryId: string,
     *   applicability?: any, endpointKeys?: Record<string, string> }} input
     */
    async extractPrecedent({ userId, studyId = null, registry: registryName = "clinicaltrials.gov", registryId, applicability = {}, endpointKeys = {} }) {
      if (!registry) return { status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured" };
      const fetched = registryName === "chictr"
        ? await registry.searchChictr({ query: registryId, limit: 1 })
        : await registry.record(registryId);
      const built = registryName === "chictr" ? (fetched.items ?? [])[0] : fetched;
      if (fetched.status !== "ok" || !built?.precedent) {
        return { status: fetched.status ?? REGISTRY_UNAVAILABLE, reason: fetched.reason ?? "registry_record_unreadable", registryId };
      }
      const checkedAt = now().toISOString();
      const verified = (built.extractions ?? []).map((/** @type {any} */ item) => verifyExtraction({
        extraction: {
          ...item,
          // The endpoint key is the run's judgment about what was measured,
          // stored as a field so the pooling check can be an equality.
          applicability: {
            ...applicability,
            ...(endpointKeys[String(item?.detail?.outcome ?? "")] ? { endpointKey: endpointKeys[String(item.detail.outcome)] } : {}),
          },
        },
        sourceText: built.record?.text ?? "",
        checkedAt,
      }));

      const saved = await store.transaction(async (/** @type {any} */ client) => {
        const precedentRow = await store.savePrecedent({ userId, studyId, precedent: built.precedent, client });
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
     * Step 3 — pool one parameter, once per calibre. Returns the queued jobs;
     * reading them back is step 4. With no queue this answers
     * `engine_unavailable` and produces nothing.
     * @param {{ userId: string, studyId: string, parameter: string, endpointKey?: string,
     *   target: any, poolingMethod?: string }} input
     */
    async poolParameter({ userId, studyId, parameter, endpointKey = "", target, poolingMethod = "random_effects_reml" }) {
      const rows = await store.listEvidenceItems({ userId, studyId, parameter, verifiedOnly: true });
      const eligibility = poolEligibility({ items: rows, endpointKey });
      if (!eligibility.eligible.length) {
        return { status: "no_evidence", parameter, refused: eligibility.refused.map((entry) => ({ id: entry.item?.id, reasons: entry.reasons })), jobs: [] };
      }
      if (typeof jobs?.enqueue !== "function") {
        return { status: "engine_unavailable", parameter, eligible: eligibility.eligible.length, jobs: [] };
      }
      const precedentById = new Map();
      for (const row of await store.listPrecedents({ userId, studyId, limit: 500 })) precedentById.set(row.id, row);
      const withStrata = eligibility.eligible.map((item) => ({
        ...item,
        precedent: precedentById.get(item.precedent_id) ?? null,
        stratum: applicabilityStratum({ precedent: precedentById.get(item.precedent_id) ?? {}, item, target }),
      }));

      /** @type {any[]} */
      const queued = [];
      /** @type {Record<string, string[]>} */
      const evidenceIdsByCalibre = {};
      for (const calibre of calibres({ items: withStrata, target })) {
        const built = poolJob({ studyId, parameter, endpointKey, calibre: calibre.name, items: calibre.items, poolingMethod });
        evidenceIdsByCalibre[calibre.name] = calibre.items.map((item) => String(item.id));
        if (!built.valid) {
          queued.push({ calibre: calibre.name, status: "job_invalid", issues: built.issues });
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
            idempotencyKey: `vcr-pool:${studyId}:${parameter}:${calibre.name}:${built.job.seed}`,
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
            studies: calibre.items.length,
          });
        } catch (error) {
          // One calibre the queue refused (over budget, a scenario it will not
          // take) is one calibre missing from the card, not a parameter with no
          // evidence: the others still go.
          queued.push({
            calibre: calibre.name,
            status: "enqueue_refused",
            reason: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? "enqueue_failed"),
            studies: calibre.items.length,
          });
        }
      }
      return { status: "queued", parameter, jobs: queued, evidenceIdsByCalibre, refused: eligibility.refused.map((entry) => ({ id: entry.item?.id, reasons: entry.reasons })) };
    },

    /**
     * Step 4 and 5 — read the engine's answers back, choose the calibre, and
     * save the card. `results` is `{ calibre: engineResult }`; a calibre that
     * did not succeed is simply absent, and if none did the card is not
     * written.
     * @param {{ userId: string, studyId: string, key: string, name: string, parameter: string,
     *   endpoint?: string, unit?: string, results: Record<string, any>,
     *   evidenceIdsByCalibre: Record<string, string[]>, applicability?: any, note?: string }} input
     */
    async saveAssumptionFromPooling({ userId, studyId, key, name, parameter, endpoint = "", unit = "", results, evidenceIdsByCalibre, applicability = {}, note: cardNote = "" }) {
      /** @type {Record<string, ReturnType<typeof readPoolResult>>} */
      const pools = {};
      for (const [calibre, result] of Object.entries(results ?? {})) pools[calibre] = readPoolResult(result);
      const built = assumptionFromPooling({ key, name, parameter, endpoint, unit, pools, evidenceIdsByCalibre, applicability, note: cardNote });
      if (!built.ok) return { status: "not_written", reason: built.reason, pools };
      const row = await store.saveAssumption({ userId, studyId, card: built.card });
      note("vcr.evidence.card", { userId, studyId, key, calibre: built.card.pooling.calibre });
      return { status: "ok", assumption: row, card: built.card, pools };
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
  };
  return pipeline;
}

/** Exported for the manifest and the tests: every vocabulary word this module writes. */
export const VCR_EVIDENCE_WRITES = Object.freeze({
  sourceKinds: VCR_ASSUMPTION_SOURCE_KINDS,
  valueSources: VCR_VALUE_SOURCES,
  distributions: VCR_DISTRIBUTIONS,
  poolingMethods: VCR_POOLING_METHODS,
});
