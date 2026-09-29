// Evidence parameterization: can a number in an assumption card be found,
// word for word, in the source it names (AC-25)?
//
// The record every quotation here is checked against is the one recorded from
// ClinicalTrials.gov on 2026-09-28 in `trialRegistryClient.test.mjs`, so the
// checks run against the registry's own field names and values rather than a
// shape we invented. The engine is a double on purpose: pooling belongs to
// `vcr-engine` (`evidence.pool`, cross-checked against metafor) and this
// module only assembles the job, reads the answer back and writes the card.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_ASSUMPTION_SOURCE_KINDS, VCR_DISTRIBUTIONS, VCR_POOLING_METHODS, VCR_VALUE_SOURCES, validateEngineJob, vcrStudyPackageFindings } from "@evimed/domain";

import { ctgovPrecedent } from "../src/trialRegistryClient.mjs";
import {
  EXPERT_SET_NOTE, EXPERT_WIDEN_FACTOR, HETEROGENEOUS_I2, VCR_CALIBRES, Z_95,
  applicabilityStratum, assumptionFromPooling, calibres, chooseCalibre, createVcrEvidencePipeline,
  distributionFromPooled, evidenceResultsJson, expertSetCard, numberIsInQuote, pathIsInSource,
  poolEligibility, poolJob, precedentSimilarity, readPoolResult, seedForScenario, stratumMismatches,
  unavailableParameters, verifyExtraction,
} from "../src/vcrEvidence.mjs";
import { FLAURA } from "./vcrEvidenceFixtures.mjs";

const AT = "2026-09-28T00:00:00.000Z";
const RECORD = ctgovPrecedent(FLAURA, { retrievedAt: AT });

/**
 * A store with the same bounds the real one has: it filters by study, by
 * parameter and by verification, and it honours `limit`. A double that
 * answered everything would agree with a query that had stopped filtering.
 */
function storeDouble() {
  const precedents = [];
  const evidence = [];
  const assumptions = [];
  const audits = [];
  let counter = 0;
  const id = (prefix) => `${prefix}_${String(counter += 1).padStart(4, "0")}`;
  return {
    precedents, evidence, assumptions, audits,
    async transaction(operation) { return operation({ query: async () => ({ rows: [] }) }); },
    async audit(entry) { audits.push(entry); },
    async savePrecedent({ userId, studyId = null, precedent }) {
      const existing = precedents.find((row) => row.user_id === userId && row.registry === precedent.registry && row.registry_id === precedent.registryId);
      const row = existing ?? { id: id("pre"), user_id: userId, study_id: studyId, registry: precedent.registry, registry_id: precedent.registryId };
      Object.assign(row, {
        title: precedent.title, pico: precedent.pico, design: precedent.design, enrollment: precedent.enrollment,
        enrollment_kind: precedent.enrollmentKind, sites: precedent.sites, eligibility_text: precedent.eligibilityText,
        endpoints: precedent.endpoints, results: precedent.results, sources: precedent.sources, fetched_at: precedent.fetchedAt,
      });
      if (!existing) precedents.push(row);
      return row;
    },
    async appendEvidenceItems({ userId, studyId = null, precedentId = null, items }) {
      const ids = [];
      const verifiedIds = [];
      let refused = 0;
      for (const item of items) {
        const accepted = item?.locator?.verification === "verified";
        if (!accepted) refused += 1;
        const row = {
          id: id("evd"), user_id: userId, study_id: studyId, precedent_id: precedentId,
          parameter: item.parameter, arm: item.arm, value: accepted ? item.value : null,
          value_text: accepted ? item.valueText : "unknown", unit: item.unit,
          ci_low: accepted ? item.ciLow : null, ci_high: accepted ? item.ciHigh : null,
          sample_size: accepted ? item.sampleSize : null, events: accepted ? item.events : null,
          value_source: item.valueSource, source_ref: item.sourceRef, quote: item.quote,
          locator: item.locator, applicability: item.applicability ?? {},
          historicalBaseline: item.historicalBaseline, endpointKey: item.applicability?.endpointKey ?? "",
        };
        evidence.push(row);
        ids.push(row.id);
        if (accepted) verifiedIds.push(row.id);
      }
      return { written: items.length, verified: items.length - refused, refused, ids, verifiedIds };
    },
    async listEvidenceItems({ userId, studyId = null, precedentId = null, parameter = null, verifiedOnly = false, limit = 500 }) {
      return evidence.filter((row) => row.user_id === userId
        && (!studyId || row.study_id === studyId)
        && (!precedentId || row.precedent_id === precedentId)
        && (!parameter || row.parameter === parameter)
        && (!verifiedOnly || (row.value !== null && row.locator?.verification === "verified")))
        .slice(0, limit);
    },
    async listPrecedents({ userId, studyId = null, limit = 50 }) {
      return precedents.filter((row) => row.user_id === userId && (!studyId || row.study_id === studyId)).slice(0, limit);
    },
    async saveAssumption({ userId, studyId, card }) {
      const version = assumptions.filter((row) => row.study_id === studyId && row.key === card.key).length + 1;
      const row = {
        id: id("asm"), study_id: studyId, user_id: userId, key: card.key, version, name: card.name,
        point_value: card.pointValue, distribution: card.distribution, sensitivity: card.sensitivity,
        source_kind: card.sourceKind, value_source: card.valueSource, pooling_method: card.poolingMethod,
        pooling: card.pooling, evidence_ids: card.evidenceIds, applicability: card.applicability,
        review_state: card.reviewState, note: card.note,
      };
      assumptions.push(row);
      return row;
    },
    async latestAssumptions({ studyId }) {
      const byKey = new Map();
      for (const row of assumptions.filter((entry) => entry.study_id === studyId)) {
        if (!byKey.has(row.key) || byKey.get(row.key).version < row.version) byKey.set(row.key, row);
      }
      return [...byKey.values()];
    },
    async evidenceCoverage({ userId, studyId }) {
      const groups = new Map();
      for (const row of evidence.filter((entry) => entry.user_id === userId && entry.study_id === studyId)) {
        const entry = groups.get(row.parameter) ?? { parameter: row.parameter, extracted: 0, verified: 0, refused: 0 };
        entry.extracted += 1;
        if (row.locator?.verification === "verified") entry.verified += 1; else entry.refused += 1;
        groups.set(row.parameter, entry);
      }
      return [...groups.values()];
    },
  };
}

/** A registry double answering the recorded record, or an outage. */
function registryDouble({ outage = null } = {}) {
  return {
    configured: true,
    async search() { return outage ? { status: "registry_unavailable", reason: outage, items: [] } : { status: "ok", items: [], total: 0 }; },
    async searchChictr() { return { status: "registry_unavailable", reason: "registry_not_configured", items: [] }; },
    async record() {
      if (outage) return { status: "registry_unavailable", reason: outage };
      return { status: "ok", ...ctgovPrecedent(FLAURA, { retrievedAt: AT }) };
    },
  };
}

/** A job queue double shaped like `vcrJobs.enqueue`. */
function jobsDouble({ refuse = null } = {}) {
  const enqueued = [];
  return {
    enqueued,
    async enqueue(input) {
      if (refuse) throw Object.assign(new Error("refused"), { code: refuse });
      enqueued.push(input);
      return { job: { id: `job_${enqueued.length}`, state: "queued", seed: input.seed }, created: true };
    },
  };
}

/** One engine answer for `evidence.pool`. */
function poolAnswer({ pooled, low, high, i2 = 0.2, tau2 = 0.01, k = 4, scale = "identity", confidence = null }) {
  return {
    jobId: "job_1", protocolVersion: 1, status: "succeeded", method: "evidence.pool", methodVersion: "1.0.0",
    scenarioHash: "0".repeat(64), seed: 1,
    measures: [
      { name: "pooled", value: pooled, simulated: false, ...(confidence ? { interval: { kind: "confidence", ...confidence } } : {}) },
      { name: "prediction", value: pooled, simulated: false, interval: { kind: "prediction", low, high } },
      { name: "i_squared", value: i2, simulated: false },
      { name: "tau_squared", value: tau2, simulated: false },
      { name: "k", value: k, simulated: false },
    ],
    diagnostics: { scale, poolingMethod: "random_effects_reml" },
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "a", startedAt: AT, finishedAt: AT, cpuSeconds: 1 },
  };
}

// ---------------------------------------------------------------------------
// The quote check (AC-25)
// ---------------------------------------------------------------------------

test("every value extracted from the recorded registry record passes its own quote check", () => {
  const refused = RECORD.extractions
    .map((extraction) => verifyExtraction({ extraction, sourceText: RECORD.record.text, checkedAt: AT }))
    .filter((entry) => !entry.verified);
  assert.deepEqual(refused.map((entry) => `${entry.item.parameter}:${entry.state}`), [],
    "the client quotes what it copied, so nothing it produced should fail verification");
  assert.equal(RECORD.extractions.length, 14, "the walk read the record, not an empty one");
});

test("a value whose number is not in its quotation is refused and stored as unknown", () => {
  const enrolment = RECORD.extractions.find((item) => item.parameter === "enrollment_actual");
  const tampered = verifyExtraction({ extraction: { ...enrolment, value: 675 }, sourceText: RECORD.record.text, checkedAt: AT });
  assert.equal(tampered.verified, false);
  assert.equal(tampered.state, "quote_missing_number");
  assert.equal(tampered.item.value, null, "a refused value never reaches the numeric column");
  assert.equal(tampered.item.valueText, "unknown");
  assert.equal(tampered.item.locator.verification, "quote_not_found");
  assert.equal(tampered.item.locator.verificationDetail, "quote_missing_number");
  assert.equal(tampered.item.quote, enrolment.quote, "the attempt stays on the record, quote and all");
});

test("the four ways a quotation fails, each named", () => {
  const item = RECORD.extractions.find((entry) => entry.parameter === "enrollment_actual");
  assert.equal(verifyExtraction({ extraction: { ...item, quote: "" }, sourceText: RECORD.record.text }).state, "no_quote");
  assert.equal(verifyExtraction({ extraction: item, sourceText: "" }).state, "source_unavailable");
  assert.equal(
    verifyExtraction({ extraction: { ...item, quote: "enrollment was 674 patients in China" }, sourceText: RECORD.record.text }).state,
    "quote_not_found",
    "a fluent sentence containing the right number is still not in the source",
  );
  const date = RECORD.extractions.find((entry) => entry.parameter === "start_date");
  assert.equal(
    verifyExtraction({ extraction: { ...date, valueText: "2015-12-03" }, sourceText: RECORD.record.text }).state,
    "quote_missing_value",
    "a value with no number is held to its text the same way",
  );
});

test("a derived value is checked against the inputs it names, because it cannot be in the source itself", () => {
  const accrual = RECORD.extractions.find((item) => item.parameter === "accrual_to_primary_completion_months");
  assert.equal(accrual.valueSource, "calculated");
  const good = verifyExtraction({ extraction: accrual, sourceText: RECORD.record.text, checkedAt: AT });
  assert.equal(good.verified, true);
  assert.equal(good.item.locator.derivation, "calculated");
  assert.equal(
    verifyExtraction({ extraction: { ...accrual, locator: { ...accrual.locator, inputs: ["protocolSection.nope"] } }, sourceText: RECORD.record.text }).state,
    "derived_input_not_found",
  );
  assert.equal(
    verifyExtraction({ extraction: { ...accrual, locator: { kind: "registry_field", path: "x" } }, sourceText: RECORD.record.text }).state,
    "derived_inputs_missing",
    "a computed number with no named inputs is not 「汇总计算」, it is an unanchored figure",
  );
});

test("a number is in a quotation only as a complete token", () => {
  assert.equal(numberIsInQuote("count: 46969", 46969), true);
  assert.equal(numberIsInQuote("count: 46,969", 46969), true);
  assert.equal(numberIsInQuote("count: 46969", 4), false, "4 is not in 46969");
  assert.equal(numberIsInQuote("count: 46969", 969), false);
  assert.equal(numberIsInQuote("paramValue: 0.46", 0.46), true);
  assert.equal(numberIsInQuote("paramValue: 0.460", 0.46), true, "a value may be written less precisely than the source");
  assert.equal(numberIsInQuote("paramValue: 0.46", 0.463), false, "and never more: 0.463 is not what the source wrote");
  assert.equal(numberIsInQuote("ORR 12.4", 0.124, { unit: "%" }), true, "a rate written two ways is the same rate");
  assert.equal(numberIsInQuote("ORR 12.4", 0.124), false, "and only when the unit says so");
});

test("a field path is present only as a whole path segment", () => {
  assert.equal(pathIsInSource(RECORD.record.text, "protocolSection.contactsLocationsModule.locations"), true);
  assert.equal(pathIsInSource(RECORD.record.text, "protocolSection.designModule.enrollmentInfo.count"), true);
  assert.equal(pathIsInSource("protocolSection.locationsTotal: 170", "protocolSection.locations"), false);
  assert.equal(pathIsInSource(RECORD.record.text, ""), false);
});

// ---------------------------------------------------------------------------
// Candidates, strata, calibres
// ---------------------------------------------------------------------------

test("similarity ranks candidates and authorizes nothing", () => {
  const target = { condition: "non small cell lung cancer", intervention: "osimertinib", phase: "PHASE3", allocation: "RANDOMIZED" };
  const near = precedentSimilarity(RECORD.precedent, target);
  const far = precedentSimilarity({ pico: { conditions: ["Type 2 Diabetes"], interventions: [{ name: "metformin" }] }, design: { phases: ["PHASE4"], allocation: "NA", hasResults: false } }, target);
  assert.ok(near.score > far.score, `${near.score} should beat ${far.score}`);
  assert.ok(near.parts.condition > 0 && near.parts.hasResults === 1);
  // Similarity is not an input to pooling: the eligibility check never reads it.
  const scored = poolEligibility({ items: [{ value: 1, locator: { verification: "verified" }, similarity: near }], endpointKey: "pfs-investigator" });
  assert.deepEqual(scored.refused[0].reasons, ["endpoint_key_missing"]);
});

test("a stratum is declared, and an undeclared one never matches a target", () => {
  const stratum = applicabilityStratum({
    precedent: { sites: { countries: ["China", "Japan"] }, enrollment: { milestones: { start_date: { date: "2022-03-01" } } } },
    item: { applicability: { line: "second", biomarker: "egfr_positive" } },
    target: { eraYear: 2026, eraWindowYears: 5 },
  });
  assert.deepEqual(stratum, { region: "china", line: "second", era: "recent", biomarker: "egfr_positive" });

  const older = applicabilityStratum({
    precedent: { sites: { countries: ["United States"] }, enrollment: { milestones: { start_date: { date: "2009-01-01" } } } },
    item: {}, target: { eraYear: 2026 },
  });
  assert.deepEqual(older, { region: "other", line: "unknown", era: "older", biomarker: "unknown" });
  assert.deepEqual(stratumMismatches(older, { region: "china", line: "second" }), ["region", "line"],
    "a study whose treatment line nobody recorded is not evidence that it matches");
  assert.deepEqual(stratumMismatches(older, {}), [], "a target that declares nothing has nothing to mismatch");
});

test("pooling eligibility refuses a planned figure, an unverified quote and a different endpoint", () => {
  const verified = { locator: { verification: "verified" } };
  const { eligible, refused } = poolEligibility({
    items: [
      { id: "a", value: 0.3, ...verified, applicability: { endpointKey: "pfs-blinded" }, historicalBaseline: true },
      { id: "b", value: 0.4, ...verified, applicability: { endpointKey: "pfs-investigator" }, historicalBaseline: true },
      { id: "c", value: 0.5, ...verified, applicability: { endpointKey: "pfs-blinded" }, historicalBaseline: false },
      { id: "d", value: 0.6, locator: { verification: "quote_not_found" }, applicability: { endpointKey: "pfs-blinded" }, historicalBaseline: true },
      { id: "e", value: null, ...verified, applicability: { endpointKey: "pfs-blinded" }, historicalBaseline: true },
    ],
    endpointKey: "pfs-blinded",
  });
  assert.deepEqual(eligible.map((item) => item.id), ["a"]);
  assert.deepEqual(refused.map((entry) => [entry.item.id, entry.reasons]), [
    ["b", ["endpoint_key_differs"]],
    ["c", ["estimated_not_actual"]],
    ["d", ["quote_not_verified"]],
    ["e", ["no_value"]],
  ], "every refusal names its reason; nothing is dropped quietly");
});

test("three calibres, and an empty one does not become a job", () => {
  const target = { region: "china", eraYear: 2026 };
  const items = [
    { id: "a", stratum: { region: "china", era: "recent", line: "unknown", biomarker: "unknown" } },
    { id: "b", stratum: { region: "other", era: "recent", line: "unknown", biomarker: "unknown" } },
  ];
  const built = calibres({ items, target });
  assert.deepEqual(built.map((entry) => entry.name), ["closest", "overall", "next_closest"]);
  assert.deepEqual(built[0].items.map((item) => item.id), ["a"]);
  assert.deepEqual(built[1].items.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(built[2].items.map((item) => item.id), ["b"]);

  const allClose = calibres({ items: [items[0]], target });
  assert.deepEqual(allClose.map((entry) => entry.name), ["closest", "overall"], "no next-closest subset, no third job");
  assert.deepEqual(VCR_CALIBRES, ["closest", "overall", "next_closest"]);
});

// ---------------------------------------------------------------------------
// The engine job
// ---------------------------------------------------------------------------

test("a pool job is valid against the engine protocol and reproducible from its scenario", () => {
  const items = [
    { id: "evd_0001", value: 0.31, ci_low: 0.25, ci_high: 0.38, sample_size: 277, events: 86, arm: "SoC", source_ref: "ctgov:NCT02296125" },
    { id: "evd_0002", value: 0.28, ci_low: 0.2, ci_high: 0.37, sample_size: 180, events: 50, arm: "SoC", source_ref: "ctgov:NCT01802632" },
  ];
  const built = poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", calibre: "closest", items });
  assert.equal(built.valid, true, JSON.stringify(built.issues));
  assert.deepEqual(validateEngineJob(built.job), []);
  assert.equal(built.job.method, "evidence.pool");
  assert.equal(built.job.methodVersion, "1.0.0");
  assert.equal(built.job.scenario.scale, "logit", "a proportion is pooled on the logit scale");
  assert.equal(built.job.scenario.parameterKind, "proportion");
  assert.equal(built.job.scenario.predictionInterval, true, "the range a simulation uses is the prediction interval");
  assert.ok(VCR_POOLING_METHODS.includes(built.job.scenario.poolingMethod));
  assert.deepEqual(built.job.inputs.map((input) => input.id), ["evd_0001", "evd_0002"]);
  // The seed follows from the canonical scenario bytes, so the same pool twice
  // is the same run (AC-04) and a changed study changes it.
  assert.equal(built.job.seed, seedForScenario(built.job.scenario));
  assert.equal(poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", calibre: "closest", items }).job.seed, built.job.seed);
  assert.notEqual(poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", calibre: "overall", items }).job.seed, built.job.seed);

  const hazard = poolJob({ studyId: "std_1", parameter: "hazard_ratio", calibre: "overall", items });
  assert.equal(hazard.job.scenario.scale, "log");
  const invalid = poolJob({ studyId: "", parameter: "hazard_ratio", calibre: "overall", items });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.field === "studyId"));
});

test("an engine answer with no prediction interval is not a usable answer", () => {
  assert.equal(readPoolResult(null).reason, "result_missing");
  assert.equal(readPoolResult({ status: "failed" }).reason, "engine_failed");
  assert.equal(readPoolResult({ status: "succeeded", measures: [] }).reason, "pooled_value_missing");
  assert.equal(
    readPoolResult({ status: "succeeded", measures: [{ name: "pooled", value: 0.3, interval: { kind: "confidence", low: 0.28, high: 0.32 } }] }).reason,
    "prediction_interval_missing",
    "a confidence interval is not a stand-in for a prediction interval (plan §6.1)",
  );
  const good = readPoolResult(poolAnswer({ pooled: 0.3, low: 0.1, high: 0.5, confidence: { low: 0.27, high: 0.33 } }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.prediction, { low: 0.1, high: 0.5 });
  assert.deepEqual(good.confidence, { low: 0.27, high: 0.33 });
  assert.equal(good.i2, 0.2);
  assert.equal(good.k, 4);
});

// ---------------------------------------------------------------------------
// From the engine's numbers to a distribution
// ---------------------------------------------------------------------------

test("a pooled proportion becomes a Beta matched on the mean and the prediction interval", () => {
  const built = distributionFromPooled({ kind: "proportion", pooled: 0.3, prediction: { low: 0.1, high: 0.5 }, scale: "identity" });
  const sd = 0.4 / (2 * Z_95);
  const nu = (0.3 * 0.7) / (sd * sd) - 1;
  assert.equal(built.family, "beta");
  assert.equal(built.params.alpha, 0.3 * nu);
  assert.equal(built.params.beta, 0.7 * nu);
  assert.equal(built.pointValue, 0.3);
  assert.deepEqual(built.predictionInterval, { kind: "prediction", low: 0.1, high: 0.5 });

  // The same answer on the logit scale is the same Beta.
  const logit = (p) => Math.log(p / (1 - p));
  const fromLogit = distributionFromPooled({ kind: "proportion", pooled: logit(0.3), prediction: { low: logit(0.1), high: logit(0.5) }, scale: "logit" });
  assert.ok(Math.abs(fromLogit.params.alpha - built.params.alpha) < 1e-9);
  assert.ok(Math.abs(fromLogit.pointValue - 0.3) < 1e-12);
});

test("a prediction interval wider than any Beta with that mean gives the empirical range, not a fiction", () => {
  const built = distributionFromPooled({ kind: "proportion", pooled: 0.05, prediction: { low: 0, high: 0.9 }, scale: "identity" });
  assert.equal(built.family, "empirical");
  assert.deepEqual(built.params.support, [0, 0.9]);
  assert.ok(built.note.includes("Beta"));
  assert.ok(VCR_DISTRIBUTIONS.includes(built.family));
});

test("a hazard ratio and a median time become log-normals on the log scale", () => {
  const hazard = distributionFromPooled({ kind: "ratio", pooled: Math.log(0.46), prediction: { low: Math.log(0.3), high: Math.log(0.7) }, scale: "log" });
  assert.equal(hazard.family, "lognormal");
  assert.equal(hazard.params.meanlog, Math.log(0.46));
  assert.equal(hazard.params.sdlog, (Math.log(0.7) - Math.log(0.3)) / (2 * Z_95));
  assert.ok(Math.abs(hazard.pointValue - 0.46) < 1e-12);

  const time = distributionFromPooled({ kind: "time", pooled: 10.2, prediction: { low: 8, high: 13 }, scale: "identity" });
  assert.equal(time.family, "lognormal");
  assert.ok(Math.abs(time.pointValue - 10.2) < 1e-12);
  assert.equal(time.params.sdlog, (Math.log(13) - Math.log(8)) / (2 * Z_95));

  // A non-positive pooled value has no logarithm, and says so rather than NaN.
  const impossible = distributionFromPooled({ kind: "time", pooled: 0, prediction: { low: -1, high: 2 }, scale: "identity" });
  assert.equal(impossible.family, "empirical");
  assert.ok(Number.isFinite(impossible.pointValue));

  const plain = distributionFromPooled({ kind: "continuous", pooled: 2.5, prediction: { low: 1.5, high: 3.5 } });
  assert.equal(plain.family, "normal");
  assert.equal(plain.params.sd, (3.5 - 1.5) / (2 * Z_95));
});

test("the default calibre follows a stated rule, and both calibres stay on the card either way", () => {
  const agree = { closest: readPoolResult(poolAnswer({ pooled: 0.3, low: 0.2, high: 0.4, i2: 0.1 })), overall: readPoolResult(poolAnswer({ pooled: 0.31, low: 0.2, high: 0.45, i2: 0.1 })) };
  assert.deepEqual(chooseCalibre(agree), { calibre: "overall", reason: "strata_agree", strataDiffer: false });

  const outside = { closest: readPoolResult(poolAnswer({ pooled: 0.6, low: 0.5, high: 0.7, i2: 0.1 })), overall: readPoolResult(poolAnswer({ pooled: 0.31, low: 0.2, high: 0.45, i2: 0.1 })) };
  assert.deepEqual(chooseCalibre(outside), { calibre: "closest", reason: "closest_outside_overall_prediction_interval", strataDiffer: true });

  const heterogeneous = { closest: readPoolResult(poolAnswer({ pooled: 0.3, low: 0.2, high: 0.4 })), overall: readPoolResult(poolAnswer({ pooled: 0.31, low: 0.05, high: 0.7, i2: HETEROGENEOUS_I2 })) };
  assert.equal(chooseCalibre(heterogeneous).calibre, "closest");
  assert.equal(chooseCalibre(heterogeneous).reason, "overall_heterogeneity_at_or_above_floor");

  assert.equal(chooseCalibre({ overall: readPoolResult(poolAnswer({ pooled: 0.3, low: 0.2, high: 0.4 })) }).reason, "no_subset_matches_this_population");
  assert.equal(chooseCalibre({ closest: readPoolResult(poolAnswer({ pooled: 0.3, low: 0.2, high: 0.4 })) }).reason, "only_closest_pooled");
  assert.equal(chooseCalibre({}).calibre, null);
});

test("an assumption card carries the default distribution, the other calibres as sensitivity, and only its own evidence ids", () => {
  const pools = {
    closest: readPoolResult(poolAnswer({ pooled: 0.6, low: 0.5, high: 0.7, k: 3 })),
    overall: readPoolResult(poolAnswer({ pooled: 0.31, low: 0.2, high: 0.45, k: 9 })),
    next_closest: readPoolResult(poolAnswer({ pooled: 0.25, low: 0.15, high: 0.4, k: 6 })),
  };
  const built = assumptionFromPooling({
    key: "control_event_rate", name: "对照组 12 个月无进展生存率", parameter: "control_event_rate", unit: "",
    pools,
    evidenceIdsByCalibre: { closest: ["evd_1", "evd_2"], overall: ["evd_1", "evd_2", "evd_3"], next_closest: ["evd_3"] },
    applicability: { region: "china" },
  });
  assert.equal(built.ok, true);
  const card = built.card;
  assert.equal(card.pooling.calibre, "closest");
  assert.equal(card.pooling.strataDiffer, true);
  assert.equal(card.pooling.i2, 0.2);
  assert.equal(card.pooling.k, 3);
  assert.equal(card.distribution.family, "beta");
  assert.deepEqual(card.distribution.range, { kind: "prediction", low: 0.5, high: 0.7 });
  assert.deepEqual(card.sensitivity.calibres.map((entry) => entry.calibre), ["overall", "next_closest"]);
  assert.equal(card.sensitivity.calibres[0].studies, 3);
  assert.deepEqual(card.evidenceIds, ["evd_1", "evd_2"], "a card cites the calibre it used, not every row that exists");
  assert.equal(card.sourceKind, "external_evidence");
  assert.ok(VCR_ASSUMPTION_SOURCE_KINDS.includes(card.sourceKind));
  assert.equal(card.valueSource, "aggregate");
  assert.ok(VCR_VALUE_SOURCES.includes(card.valueSource));
  assert.equal(card.reviewState, "ai_set", "a card nobody reviewed says so (plan §10.2)");

  assert.deepEqual(assumptionFromPooling({ key: "k", name: "n", parameter: "control_event_rate", pools: {}, evidenceIdsByCalibre: {} }),
    { ok: false, reason: "no_pool_succeeded", card: null });
});

test("a parameter with no evidence gets the nearest evidence widened and labelled, and cites nothing", () => {
  const card = expertSetCard({
    key: "accrual_per_site_per_month", name: "每中心每月入组数", parameter: "median_time", unit: "例/中心/月",
    nearest: { pointValue: 2, range: { low: 1, high: 4 }, key: "accrual_to_primary_completion_months" },
    reason: "登记平台不记录每中心入组数",
  });
  assert.equal(card.sourceKind, "expert_set");
  assert.equal(card.valueSource, "assumed");
  assert.deepEqual(card.evidenceIds, [], "an expert setting is not evidence and must not read as if it were");
  assert.ok(card.note.startsWith(EXPERT_SET_NOTE));
  assert.equal(card.reviewState, "ai_set");
  assert.equal(card.applicability.pending, true);
  // Widened on the log scale, because a rate cannot go negative.
  const halfWidth = ((Math.log(4) - Math.log(1)) / 2) * EXPERT_WIDEN_FACTOR;
  assert.ok(Math.abs(card.distribution.range.low - Math.exp(Math.log(2) - halfWidth)) < 1e-12);
  assert.ok(card.distribution.range.high > 4, "widened means wider");

  const bounded = expertSetCard({ key: "dropout_rate", name: "脱落率", parameter: "dropout_rate", nearest: { pointValue: 0.12, range: { low: 0.08, high: 0.2 } }, reason: "无证据" });
  assert.ok(bounded.distribution.range.low >= 0 && bounded.distribution.range.high <= 1, "a proportion stays a proportion");

  const nothing = expertSetCard({ key: "x", name: "x", nearest: {}, reason: "无证据" });
  assert.equal(nothing.pointValue, null, "with nothing to widen, the card is empty and says so — it does not invent a mean");
});

test("what no registry carries is printed as 「不可得」, not as 0", () => {
  const rows = unavailableParameters({ site_startup_curve: "合作方提供" });
  const byParameter = new Map(rows.map((row) => [row.parameter, row]));
  assert.equal(byParameter.get("screen_failure_rate").value, null);
  assert.equal(byParameter.get("screen_failure_rate").display, "不可得");
  assert.ok(byParameter.has("site_startup_curve"));
  assert.equal(rows.every((row) => row.value !== 0), true);
});

// ---------------------------------------------------------------------------
// The deliverable's results.json, read by the contract
// ---------------------------------------------------------------------------

test("the results file an evidence deliverable ships passes the contract, and loses its pass when a card is unanchored", () => {
  const evidenceById = new Map([
    ["evd_1", { id: "evd_1", source_ref: "ctgov:NCT02296125", quote: "protocolSection.designModule.enrollmentInfo.count: 674", locator: { kind: "registry_field", path: "protocolSection.designModule.enrollmentInfo.count", verification: "verified" }, value: 674 }],
  ]);
  const card = assumptionFromPooling({
    key: "control_event_rate", name: "对照组 12 个月无进展生存率", parameter: "control_event_rate",
    pools: { overall: readPoolResult(poolAnswer({ pooled: 0.31, low: 0.2, high: 0.45 })) },
    evidenceIdsByCalibre: { overall: ["evd_1"] },
  }).card;
  const results = evidenceResultsJson({
    cards: [card], evidenceById, precedents: [RECORD.precedent],
    counts: { realPatients: 674, events: 279, effectiveSampleSize: null, generatedRecords: 0 },
  });
  const files = new Map([
    ["results.json", JSON.stringify(results)],
    ["evidence-parameters.md", `对照组事件率合并值为 ${results.measures[0].value}，预测区间 ${results.assumptions[0].distribution.range.low}–${results.assumptions[0].distribution.range.high}。`],
  ]);
  const findings = vcrStudyPackageFindings({ files });
  assert.deepEqual(findings.issues.filter((issue) => issue.check === "vcr-assumption-source"), [],
    "an assumption built from a verified quotation is anchored");
  assert.deepEqual(findings.issues.filter((issue) => issue.check === "vcr-counts-separated"), []);
  assert.equal(findings.metrics.vcrAssumptions, 1);
  assert.equal(findings.issues.every((issue) => issue.severity === "advisory"), true, "every VCR finding is a notice");

  const unanchored = evidenceResultsJson({ cards: [{ ...card, evidenceIds: ["evd_missing"] }], evidenceById, counts: results.counts });
  const bad = vcrStudyPackageFindings({ files: new Map([["results.json", JSON.stringify(unanchored)], ["evidence-parameters.md", "。"]]) });
  assert.ok(bad.issues.some((issue) => issue.code === "vcr_assumption_unanchored"),
    "a card whose sources cannot be resolved is exactly what AC-25 is about");
});

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

test("extracting a precedent stores the record, the verified values and the refused ones", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble(), now: () => new Date(AT) });
  const answer = await pipeline.extractPrecedent({
    userId: "u1", studyId: "std_1", registryId: "NCT02296125",
    applicability: { line: "first", biomarker: "egfr_positive" },
    endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
  });
  assert.equal(answer.status, "ok");
  assert.equal(answer.counts.extracted, 14);
  assert.equal(answer.counts.verified, 14);
  assert.equal(answer.counts.refused, 0);
  assert.deepEqual(answer.refusals, []);
  assert.equal(store.precedents.length, 1);
  assert.equal(store.precedents[0].enrollment_kind, "actual");
  assert.equal(store.evidence.length, 14);
  assert.equal(store.evidence.every((row) => row.applicability.line === "first"), true,
    "the run's declared stratum travels with every value it extracted");
  const median = store.evidence.find((row) => row.parameter === "median_time");
  assert.equal(median.endpointKey, "pfs-blinded", "the endpoint key is the run's judgment, stored as a field");
  assert.ok(answer.unavailable.some((entry) => entry.parameter === "screen_failure_rate"));

  // Re-extracting the same record updates the precedent and appends values.
  await pipeline.extractPrecedent({ userId: "u1", studyId: "std_1", registryId: "NCT02296125" });
  assert.equal(store.precedents.length, 1, "a precedent is keyed by the registry record it is");
  assert.equal(store.evidence.length, 28, "extractions are append-only, so an old card still points at its own bytes");
});

test("an unreachable registry is reported and writes nothing", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble({ outage: "ENOTFOUND" }), jobs: jobsDouble() });
  const answer = await pipeline.extractPrecedent({ userId: "u1", studyId: "std_1", registryId: "NCT02296125" });
  assert.equal(answer.status, "registry_unavailable");
  assert.equal(answer.reason, "ENOTFOUND");
  assert.equal(store.precedents.length, 0);
  assert.equal(store.evidence.length, 0);

  const candidates = await pipeline.findPrecedents({ userId: "u1", target: { condition: "NSCLC" } });
  assert.equal(candidates.status, "registry_unavailable");
  assert.deepEqual(candidates.candidates, []);
  assert.deepEqual(candidates.registries.map((entry) => entry.status), ["registry_unavailable", "registry_unavailable"]);
});

test("the runtime's registry read answers structure, never throws, and never writes", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), now: () => new Date(AT) });
  const answer = await pipeline.readRegistryRecord({ userId: "u1", studyId: "std_1", registryId: "NCT02296125" });
  assert.equal(answer.status, "ok");
  assert.equal(answer.registryId, "NCT02296125");
  assert.equal(answer.record.values.length, 14);
  assert.equal(answer.record.values.every((value) => value.verification === "verified"), true);
  assert.ok(answer.record.text.includes("protocolSection.designModule.enrollmentInfo.count: 674"),
    "the run is handed the bytes it must quote from");
  assert.equal(answer.sources[0].registry, "clinicaltrials.gov");
  assert.equal(answer.issues.every((issue) => issue.severity === "advisory"), true);
  assert.equal(store.precedents.length, 0, "a gateway read is a read");

  const broken = createVcrEvidencePipeline({
    store,
    registry: { configured: true, async record() { throw new Error("socket hang up"); }, async search() { return { status: "ok", items: [] }; }, async searchChictr() { return { status: "ok", items: [] }; } },
  });
  const failed = await broken.readRegistryRecord({ registryId: "NCT02296125" });
  assert.equal(failed.status, "registry_unavailable");
  assert.equal(failed.record, null);
  assert.equal(failed.issues.length, 1);

  const unconfigured = createVcrEvidencePipeline({ store });
  assert.equal((await unconfigured.readRegistryRecord({ registryId: "NCT1" })).reason, "registry_not_configured");
});

test("a record with no results section is read with a notice, not refused", async () => {
  const store = storeDouble();
  const thin = { protocolSection: { ...FLAURA.protocolSection }, hasResults: false };
  const pipeline = createVcrEvidencePipeline({
    store,
    registry: { configured: true, async record() { return { status: "ok", ...ctgovPrecedent(thin, { retrievedAt: AT }) }; }, async search() { return { status: "ok", items: [] }; }, async searchChictr() { return { status: "ok", items: [] }; } },
    now: () => new Date(AT),
  });
  const answer = await pipeline.readRegistryRecord({ registryId: "NCT02296125" });
  assert.equal(answer.status, "ok");
  assert.ok(answer.issues.some((issue) => issue.code === "no_results_section"));
  assert.equal(answer.record.values.some((value) => value.parameter === "median_time"), false);
  assert.equal(answer.record.values.some((value) => value.parameter === "enrollment_actual"), true,
    "design and enrolment are still there");
});

test("pooling queues one job per calibre, reproducibly, and refuses to invent an answer when the engine is absent", async () => {
  const store = storeDouble();
  const jobs = jobsDouble();
  const target = { condition: "NSCLC", region: "other", eraYear: 2016, eraWindowYears: 5 };
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs, now: () => new Date(AT) });
  await pipeline.extractPrecedent({
    userId: "u1", studyId: "std_1", registryId: "NCT02296125",
    endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
  });
  const queued = await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", target });
  assert.equal(queued.status, "queued");
  assert.deepEqual(queued.jobs.map((entry) => entry.calibre), ["closest", "overall"],
    "both extracted arms are in the closest stratum, so there is no next-closest subset to pool");
  assert.equal(queued.jobs.every((entry) => entry.jobId), true);
  assert.equal(jobs.enqueued.length, 2);
  assert.equal(jobs.enqueued[0].kind, "pool_evidence");
  assert.equal(jobs.enqueued[0].idempotencyKey, `vcr-pool:std_1:median_time:closest:${jobs.enqueued[0].seed}`);
  assert.equal(jobs.enqueued[0].scenario.studies.length, 2);
  assert.equal(queued.evidenceIdsByCalibre.closest.length, 2);

  // No queue: no card, and no number either.
  const noEngine = createVcrEvidencePipeline({ store, registry: registryDouble() });
  const refused = await noEngine.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", target });
  assert.equal(refused.status, "engine_unavailable");
  assert.deepEqual(refused.jobs, []);

  // A parameter whose values all failed their endpoint check is `no_evidence`,
  // with every refusal named.
  const other = await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "orr-recist", target });
  assert.equal(other.status, "no_evidence");
  assert.ok(other.refused.every((entry) => entry.reasons.includes("endpoint_key_differs")));

  // A queue that refuses one calibre still queues the others.
  const partial = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble({ refuse: "vcr_job_over_budget" }) });
  const budget = await partial.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", target });
  assert.equal(budget.jobs.every((entry) => entry.status === "enqueue_refused" && entry.reason === "vcr_job_over_budget"), true);
});

test("a card is saved with a version and the study's parameterisation reads it back", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble(), now: () => new Date(AT) });
  await pipeline.extractPrecedent({ userId: "u1", studyId: "std_1", registryId: "NCT02296125" });
  const saved = await pipeline.saveAssumptionFromPooling({
    userId: "u1", studyId: "std_1", key: "median_pfs_control", name: "对照组中位 PFS", parameter: "median_time", unit: "月",
    results: { overall: poolAnswer({ pooled: 10.2, low: 8, high: 13 }), closest: poolAnswer({ pooled: 10.5, low: 9, high: 12 }) },
    evidenceIdsByCalibre: { overall: ["evd_1", "evd_2"], closest: ["evd_1"] },
  });
  assert.equal(saved.status, "ok");
  assert.equal(saved.assumption.version, 1);
  assert.equal(saved.card.distribution.family, "lognormal");

  const second = await pipeline.saveAssumptionFromPooling({
    userId: "u1", studyId: "std_1", key: "median_pfs_control", name: "对照组中位 PFS", parameter: "median_time", unit: "月",
    results: { overall: poolAnswer({ pooled: 11, low: 9, high: 14 }) },
    evidenceIdsByCalibre: { overall: ["evd_1", "evd_2"] },
  });
  assert.equal(second.assumption.version, 2, "editing an assumption is a new version, never a rewrite");

  await pipeline.saveExpertSet({
    userId: "u1", studyId: "std_1", key: "accrual_per_site_per_month", name: "每中心每月入组数",
    nearest: { pointValue: 2, range: { low: 1, high: 4 } }, reason: "登记平台不记录",
  });
  const view = await pipeline.parameterisation({ userId: "u1", studyId: "std_1" });
  assert.equal(view.cards.length, 2, "one card per key, the latest version");
  assert.equal(view.counts.expertSet, 1);
  assert.equal(view.counts.aiSet, 2);
  assert.ok(view.coverage.some((row) => row.parameter === "median_time" && row.verified === 2));
  assert.ok(view.unavailable.some((row) => row.display === "不可得"));

  // The engine answered nothing usable: no card is written.
  const nothing = await pipeline.saveAssumptionFromPooling({
    userId: "u1", studyId: "std_1", key: "dropout_rate", name: "脱落率", parameter: "dropout_rate",
    results: { overall: { status: "failed" } }, evidenceIdsByCalibre: { overall: [] },
  });
  assert.equal(nothing.status, "not_written");
  assert.equal(store.assumptions.length, 3, "a failed pool leaves the ledger where it was");
});

test("the seam vcrService mounts: a study carries the account, and a precedent read is structure only", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble(), now: () => new Date(AT) });
  // The shape `vcrService.runtimeRead` calls (build contract §3.2): a study
  // object and the gateway's already-bounded filter, never an account id.
  assert.equal(typeof pipeline.registryRecord, "function");
  assert.equal(typeof pipeline.runtimeRead, "function");

  const study = { id: "std_1", userId: "u1", name: "肝细胞癌二线" };
  await pipeline.extractPrecedent({ userId: "u1", studyId: "std_1", registryId: "NCT02296125" });

  const record = await pipeline.registryRecord(study, { registryId: "NCT02296125" });
  assert.equal(record.status, "ok");
  assert.equal(record.registryId, "NCT02296125");

  const view = await pipeline.runtimeRead(study, { limit: 10 });
  assert.equal(view.precedents.length, 1);
  const [precedent] = view.precedents;
  assert.equal(precedent.actualEnrollment, 674);
  assert.equal(precedent.plannedEnrollment, null, "planned and actual are two columns, not one");
  assert.equal(precedent.accrualMonths, 30.5);
  assert.deepEqual(Object.keys(precedent).sort(), [
    "accrualMonths", "actualEnrollment", "allocation", "countries", "hasResults", "overallStatus",
    "phases", "plannedEnrollment", "registry", "registryId", "sites", "title",
  ], "a runtime read answers structure; the preserved text and the raw record stay on this side");
  assert.ok(view.coverage.some((row) => row.parameter === "median_time"));
  assert.ok(view.unavailable.some((row) => row.display === "不可得"));

  const tab = await pipeline.tab(study, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.registryConfigured, true);
  assert.equal(tab.engineConfigured, true);
  assert.equal(tab.precedents, 1);
  assert.equal(tab.counts.cards, 0, "no card yet is a fact the page states, not an empty panel");

  const offline = createVcrEvidencePipeline({ store });
  const offlineTab = await offline.tab(study, { id: "u1" });
  assert.equal(offlineTab.registryConfigured, false);
  assert.equal(offlineTab.engineConfigured, false, "with no queue there is no card, and the page says why");

  // Another account's study reads nothing rather than someone else's library.
  const stranger = await pipeline.runtimeRead({ id: "std_1", userId: "u2" }, {});
  assert.deepEqual(stranger.precedents, []);
  assert.deepEqual(stranger.coverage, []);
});

// ---------------------------------------------------------------------------
// The store's SQL, against the schema it writes to
// ---------------------------------------------------------------------------

test("every column the evidence store writes exists in the migration that creates it", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const [schema, store] = await Promise.all([
    readFile(path.join(here, "..", "src", "vcrPersistence.mjs"), "utf8"),
    readFile(path.join(here, "..", "src", "vcrEvidenceStore.mjs"), "utf8"),
  ]);
  /** Column names of one CREATE TABLE in the schema source. */
  const columnsOf = (table) => {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS evimed_vcr.${table} (`);
    assert.notEqual(start, -1, `the schema has no ${table}`);
    const body = schema.slice(start, schema.indexOf("\n);", start));
    return new Set([...body.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]));
  };
  let checked = 0;
  for (const match of store.matchAll(/INSERT INTO \$\{VCR_SCHEMA\}\.([a-z_]+)\s*\n\s*\(([^)]+)\)/g)) {
    const [, table, list] = match;
    const declared = columnsOf(table);
    for (const column of list.split(/[,\s]+/).map((word) => word.trim()).filter(Boolean)) {
      assert.ok(declared.has(column), `${table} has no column ${column}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 45, `only ${checked} columns checked — the walk stopped reading the store`);
  // And every table it touches is one the migration creates.
  const tables = new Set([...store.matchAll(/\$\{VCR_SCHEMA\}\.([a-z_]+)/g)].map((match) => match[1]));
  // `audit` is written by `VcrStoreBase`, which every package shares; this
  // store adds no table of its own to the three the evidence side owns.
  assert.deepEqual([...tables].sort(), ["assumptions", "evidence_items", "precedents"]);
});
