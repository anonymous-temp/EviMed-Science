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
  analysisScaleInput, applicabilityStratum, assumptionFromPooling, calibres, chooseCalibre, createVcrEvidencePipeline,
  defaultArmRoleOf, distributionFromPooled, evidenceResultsJson, expertSetCard, numberIsInQuote, pathIsInSource,
  poolEligibility, poolJob, precedentSimilarity, readPoolResult, seedForScenario, stratumMismatches,
  twoSidedZ, unavailableParameters, verifyExtraction,
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
  const uses = [];
  const evidence = [];
  const assumptions = [];
  const audits = [];
  let counter = 0;
  const id = (prefix) => `${prefix}_${String(counter += 1).padStart(4, "0")}`;
  return {
    precedents, evidence, assumptions, audits, uses,
    async transaction(operation) { return operation({ query: async () => ({ rows: [] }) }); },
    async audit(entry) { audits.push(entry); },
    async savePrecedent({ userId, studyId = null, precedent, recordText = "", recordHash = null }) {
      const existing = precedents.find((row) => row.user_id === userId && row.registry === precedent.registry && row.registry_id === precedent.registryId);
      const row = existing ?? { id: id("pre"), user_id: userId, study_id: studyId, registry: precedent.registry, registry_id: precedent.registryId };
      Object.assign(row, {
        title: precedent.title, pico: precedent.pico, design: precedent.design, enrollment: precedent.enrollment,
        enrollment_kind: precedent.enrollmentKind, sites: precedent.sites, eligibility_text: precedent.eligibilityText,
        endpoints: precedent.endpoints, results: precedent.results, sources: precedent.sources, fetched_at: precedent.fetchedAt,
        record_text: recordText || row.record_text || "", record_hash: recordHash ?? row.record_hash ?? null,
      });
      if (!existing) precedents.push(row);
      if (studyId && !uses.some((use) => use.study_id === studyId && use.precedent_id === row.id)) uses.push({ study_id: studyId, precedent_id: row.id });
      return row;
    },
    async precedentOfStudy({ userId, studyId, registry, registryId }) {
      const row = precedents.find((entry) => entry.user_id === userId && entry.registry === registry && entry.registry_id === registryId);
      return row && uses.some((use) => use.study_id === studyId && use.precedent_id === row.id) ? row : null;
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
          parameter: item.parameter, arm: item.arm ?? null, value: accepted ? item.value : null,
          value_text: accepted ? item.valueText : "unknown", unit: item.unit,
          ci_low: accepted ? item.ciLow : null, ci_high: accepted ? item.ciHigh : null,
          sample_size: accepted ? item.sampleSize : null, events: accepted ? item.events : null,
          value_source: item.valueSource, source_ref: item.sourceRef, quote: item.quote,
          locator: item.locator, applicability: item.applicability ?? {},
          endpoint_key: String(item.endpointKey ?? item.applicability?.endpointKey ?? "").trim(),
          arm_role: item.armRole ?? "unknown", enrollment_kind: item.enrollmentKind ?? null,
          historical_baseline: typeof item.historicalBaseline === "boolean" ? item.historicalBaseline : null,
          detail: item.detail ?? {}, created_at: counter,
        };
        evidence.push(row);
        ids.push(row.id);
        if (accepted) verifiedIds.push(row.id);
      }
      return { written: items.length, verified: items.length - refused, refused, ids, verifiedIds };
    },
    async listEvidenceItems({ userId, studyId = null, precedentId = null, parameter = null, verifiedOnly = false, latestOnly = false, limit = 500 }) {
      let rows = evidence.filter((row) => row.user_id === userId
        && (!studyId || row.study_id === studyId)
        && (!precedentId || row.precedent_id === precedentId)
        && (!parameter || row.parameter === parameter));
      if (latestOnly) {
        const newest = new Map();
        for (const row of rows) newest.set(`${row.precedent_id}|${row.parameter}|${row.arm}|${row.endpoint_key}`, row);
        rows = [...newest.values()];
      }
      return rows.filter((row) => !verifiedOnly || (row.value !== null && row.locator?.verification === "verified")).slice(0, limit);
    },
    async listPrecedents({ userId, studyId = null, limit = 50 }) {
      return precedents.filter((row) => row.user_id === userId
        && (!studyId || uses.some((use) => use.study_id === studyId && use.precedent_id === row.id))).slice(0, limit);
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
    async verifiedEvidenceIds({ userId, studyId, parameter }) {
      return evidence.filter((row) => row.user_id === userId && row.study_id === studyId && row.parameter === parameter
        && row.value !== null && row.locator?.verification === "verified").map((row) => row.id);
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

/** One engine answer for `evidence.pool`, with the engine's own measure names (`prediction_interval` is absent below k = 3). */
function poolAnswer({ pooled, low, high, i2 = 0.2, tau2 = 0.01, k = 4, scale = "identity", confidence = null }) {
  const measures = [
    { name: "pooled_estimate", value: pooled, simulated: false, ...(confidence ? { interval: { kind: "confidence", ...confidence } } : {}) },
    ...(low === undefined ? [] : [{ name: "prediction_interval", value: pooled, simulated: false, interval: { kind: "prediction", low, high } }]),
    { name: "i_squared", value: i2, simulated: false },
    { name: "tau_squared", value: tau2, simulated: false },
    { name: "k", value: k, simulated: false },
  ];
  return {
    jobId: "job_1", protocolVersion: 1, status: "succeeded", method: "evidence.pool", methodVersion: "1.0.0",
    scenarioHash: "0".repeat(64), seed: 1, measures,
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

test("E-9 every number of an extraction is checked against its quotation, and an array index anchors nothing", () => {
  const text = [
    "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].classes[0].categories[0].measurements[0].value: 18.9",
    "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].classes[0].categories[0].measurements[0].lowerLimit: 15.2",
    "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].classes[0].categories[0].measurements[0].upperLimit: 21.4",
    "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].denoms[0].counts[0].value: 279",
  ].join("\n");
  const base = "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].classes[0].categories[0].measurements[0]";
  const item = {
    parameter: "median_time", value: 18.9, unit: "months", ciLow: 15.2, ciHigh: 21.4, sampleSize: 279, valueSource: "extracted",
    quote: `${base}.value: 18.9`,
    locator: { kind: "registry_field", path: `${base}.value`, parts: {
      ciLow: { path: `${base}.lowerLimit`, quote: `${base}.lowerLimit: 15.2` },
      ciHigh: { path: `${base}.upperLimit`, quote: `${base}.upperLimit: 21.4` },
      sampleSize: { path: "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].denoms[0].counts[0].value", quote: "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].denoms[0].counts[0].value: 279" },
    } },
  };
  assert.equal(verifyExtraction({ extraction: item, sourceText: text }).verified, true);
  // A bound the source does not carry is refused even though the value is right.
  const invented = verifyExtraction({ extraction: { ...item, ciHigh: 24.0 }, sourceText: text });
  assert.equal(invented.verified, false);
  assert.equal(invented.state, "quote_missing_number");
  assert.deepEqual(invented.item.locator.unanchored, ["ciHigh"]);
  assert.equal(invented.item.ciHigh, null, "a refused item never keeps a number");
  // A sample size the source does not carry, and one that is not a whole number, are refused.
  assert.deepEqual(verifyExtraction({ extraction: { ...item, sampleSize: 300 }, sourceText: text }).item.locator.unanchored, ["sampleSize"]);
  assert.deepEqual(verifyExtraction({ extraction: { ...item, sampleSize: 279.5 }, sourceText: text }).item.locator.unanchored, ["sampleSize"]);
  // A companion with no line of its own is not anchored by the value's line.
  const bare = { ...item, locator: { kind: "registry_field", path: `${base}.value` } };
  assert.deepEqual(verifyExtraction({ extraction: bare, sourceText: text }).item.locator.unanchored, ["ciLow", "ciHigh", "sampleSize"]);

  // The position in a path is not a number of the quotation: a value of 0 or 1 cannot anchor itself to `[0]`.
  assert.equal(numberIsInQuote("protocolSection.outcomes[0].measure: response", 0), false);
  assert.equal(numberIsInQuote("protocolSection.outcomes[1].measure: response", 1), false);
  assert.equal(numberIsInQuote("locations[12].zip: 10012", 12), false);
  assert.equal(numberIsInQuote("locations[12].zip: 10012", 10012), true);
  assert.equal(numberIsInQuote("phase: PHASE1", 1), false, "the 1 of PHASE1 is part of a word");
  const zero = verifyExtraction({ extraction: { parameter: "x", value: 0, valueSource: "extracted", quote: "a.b[0].c: response", locator: { kind: "registry_field", path: "a.b[0].c" } }, sourceText: "a.b[0].c: response" });
  assert.equal(zero.verified, false, "0 is not in 「response」; the [0] does not count");
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
  assert.ok(scored.refused[0].reasons.includes("endpoint_key_missing"));
  assert.equal(scored.eligible.length, 0);
});

test("a stratum is declared, and an undeclared one never matches a target", () => {
  const stratum = applicabilityStratum({
    precedent: { sites: { countries: ["China"] }, enrollment: { milestones: { start_date: { date: "2022-03-01" } } } },
    item: { applicability: { line: "second", biomarker: "egfr_positive" } },
    target: { eraYear: 2026, eraWindowYears: 5 },
  });
  assert.deepEqual(stratum, { region: "china", includesChina: true, line: "second", era: "recent", biomarker: "egfr_positive" });

  const older = applicabilityStratum({
    precedent: { sites: { countries: ["United States"] }, enrollment: { milestones: { start_date: { date: "2009-01-01" } } } },
    item: {}, target: { eraYear: 2026 },
  });
  assert.deepEqual(older, { region: "other", includesChina: false, line: "unknown", era: "older", biomarker: "unknown" });
  assert.deepEqual(stratumMismatches(older, { region: "china", line: "second" }), ["region", "line"],
    "a study whose treatment line nobody recorded is not evidence that it matches");
  assert.deepEqual(stratumMismatches(older, {}), [], "a target that declares nothing has nothing to mismatch");
});

test("E-10 one Chinese site among thirty countries is a multinational trial that includes China, not a Chinese population", () => {
  const region = (countries) => applicabilityStratum({ precedent: { sites: { countries } }, item: {}, target: {} });
  assert.deepEqual(region(["China"]), { ...region(["China"]), region: "china", includesChina: true });
  assert.equal(region(["China", "China", "Mainland China"]).region, "china");
  assert.equal(region(["China", "Japan"]).region, "east_asia", "a trial run only in East Asia is East Asian");
  assert.equal(region(["China", "Japan"]).includesChina, true);
  const global = region(["China", "United States", "France", "Germany", "Brazil"]);
  assert.equal(global.region, "multinational");
  assert.equal(global.includesChina, true);
  assert.equal(region(["China", "United States"]).region, "multinational", "any non-Asian country beside China is not a Chinese trial");
  assert.equal(region(["United States", "Canada"]).region, "other");
  assert.equal(region([]).region, "unknown");
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

test("CS-26 pooling needs an endpoint key, the arm role being pooled, and a stated baseline", () => {
  const verified = { locator: { verification: "verified" }, value: 0.3 };
  const base = { ...verified, endpoint_key: "pfs-blinded", arm_role: "control", historical_baseline: true };
  const asked = { endpointKey: "pfs-blinded", armRole: "control" };
  assert.equal(poolEligibility({ items: [{ id: "a", ...base }], ...asked }).eligible.length, 1);
  const refusal = (patch, request = asked) => poolEligibility({ items: [{ id: "x", ...base, ...patch }], ...request }).refused[0]?.reasons;
  assert.deepEqual(refusal({ endpoint_key: "" }), ["endpoint_key_missing"]);
  assert.deepEqual(refusal({}, { endpointKey: "", armRole: "control" }), ["endpoint_key_required"], "no endpoint key asked for: the pool does not know what it pools");
  assert.deepEqual(refusal({ arm_role: "treatment" }), ["arm_role_differs"]);
  assert.deepEqual(refusal({ arm_role: "unknown" }), ["arm_role_unknown"]);
  assert.deepEqual(refusal({ historical_baseline: null }), ["baseline_standing_unknown"], "a value of unknown standing is not a baseline");
  assert.deepEqual(refusal({ historical_baseline: false }), ["estimated_not_actual"]);
  assert.equal(defaultArmRoleOf("hazard_ratio"), "contrast");
  assert.equal(defaultArmRoleOf("median_time"), "control");
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

test("the standard error is derived on the analysis scale from the value and its confidence interval, exactly", () => {
  const z = twoSidedZ(0.95);
  assert.ok(Math.abs(z - 1.959963984540054) < 1e-12, `z(0.95) = ${z}`);
  assert.ok(Math.abs(twoSidedZ(0.9) - 1.6448536269514722) < 1e-12);
  assert.ok(Math.abs(twoSidedZ(0.99) - 2.5758293035489004) < 1e-10);
  assert.throws(() => twoSidedZ(0.2), RangeError);

  // A hazard ratio: log scale, se from the log of the interval.
  const hazard = analysisScaleInput({ value: 0.46, ci_low: 0.37, ci_high: 0.57, unit: "" }, { scale: "log" });
  assert.equal(hazard.ok, true);
  assert.ok(Math.abs(hazard.estimate - Math.log(0.46)) < 1e-15);
  assert.ok(Math.abs(hazard.se - (Math.log(0.57) - Math.log(0.37)) / (2 * 1.959963984540054)) < 1e-12);

  // A proportion in percent: logit scale, on the proportion.
  const rate = analysisScaleInput({ value: 31, ci_low: 25, ci_high: 38, unit: "%" }, { scale: "logit" });
  const logit = (p) => Math.log(p / (1 - p));
  assert.ok(Math.abs(rate.estimate - logit(0.31)) < 1e-12);
  assert.ok(Math.abs(rate.se - (logit(0.38) - logit(0.25)) / (2 * 1.959963984540054)) < 1e-12);

  // A proportion with no interval but a sample size: the binomial variance of the logit.
  const binomial = analysisScaleInput({ value: 0.3, sample_size: 200, unit: "" }, { scale: "logit" });
  assert.ok(Math.abs(binomial.se - Math.sqrt(1 / (200 * 0.3 * 0.7))) < 1e-12);

  // The interval's own level is used when the record states it.
  const wide = analysisScaleInput({ value: 10, ci_low: 8, ci_high: 13, detail: { confidenceLevel: 0.9 } }, { scale: "identity" });
  assert.ok(Math.abs(wide.se - 5 / (2 * 1.6448536269514722)) < 1e-12);

  // Nothing to derive a standard error from is refused with the reason, never guessed.
  assert.deepEqual(analysisScaleInput({ value: 0.46 }, { scale: "log" }), { ok: false, reason: "se_underivable" });
  assert.deepEqual(analysisScaleInput({ value: -1, ci_low: -2, ci_high: 0 }, { scale: "log" }), { ok: false, reason: "value_off_scale" });
  assert.deepEqual(analysisScaleInput({ value: 1.4, ci_low: 1, ci_high: 2 }, { scale: "logit" }), { ok: false, reason: "proportion_not_derivable" });
});

test("a pool job is exactly the engine's contract: { studyId, estimate, se } on the analysis scale, plus method, level and scale", () => {
  const items = [
    { id: "evd_0001", value: 31, ci_low: 25, ci_high: 38, unit: "%", sample_size: 277, events: 86, arm: "SoC", source_ref: "ctgov:NCT02296125" },
    { id: "evd_0002", value: 28, ci_low: 20, ci_high: 37, unit: "%", sample_size: 180, events: 50, arm: "SoC", source_ref: "ctgov:NCT01802632" },
    { id: "evd_0003", value: 0.4, unit: "%", arm: "SoC" },
  ];
  const built = poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", armRole: "control", calibre: "closest", items });
  assert.equal(built.valid, true, JSON.stringify(built.issues));
  assert.deepEqual(validateEngineJob(built.job), []);
  assert.equal(built.job.method, "evidence.pool");
  assert.equal(built.job.methodVersion, "1.0.0");
  assert.deepEqual(Object.keys(built.job.scenario).sort(), ["level", "method", "scale", "studies"],
    "a scenario key the engine does not read is a silent parameter change, so there is none");
  assert.deepEqual(Object.keys(built.job.scenario.studies[0]).sort(), ["estimate", "se", "studyId"]);
  assert.equal(built.job.scenario.scale, "logit", "a proportion is pooled on the logit scale");
  assert.equal(built.job.scenario.method, "random_effects_reml", "REML stays REML");
  assert.equal(built.job.scenario.level, 0.95);
  assert.ok(VCR_POOLING_METHODS.includes(built.job.scenario.method));
  const logit = (p) => Math.log(p / (1 - p));
  assert.ok(Math.abs(built.job.scenario.studies[0].estimate - logit(0.31)) < 1e-12);
  assert.deepEqual(built.job.scenario.studies.map((study) => study.studyId), ["evd_0001", "evd_0002"]);
  assert.deepEqual(built.excluded, [{ id: "evd_0003", reason: "se_underivable" }], "an item whose error cannot be derived is left out and said so");
  assert.deepEqual(built.evidenceIds, ["evd_0001", "evd_0002"]);
  assert.deepEqual(built.job.inputs, [{ kind: "evidence", id: "evd_0001" }, { kind: "evidence", id: "evd_0002" }],
    "a caller names an input by what it is; a hash is only ever the control plane's");
  assert.deepEqual(built.about, { parameter: "control_event_rate", endpointKey: "orr-recist", armRole: "control", calibre: "closest", scale: "logit", method: "random_effects_reml" });
  // The seed follows from the canonical scenario bytes, so the same pool twice
  // is the same run (AC-04) and a changed study changes it.
  assert.equal(built.job.seed, seedForScenario(built.job.scenario));
  assert.equal(poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", calibre: "closest", items }).job.seed, built.job.seed);
  assert.notEqual(poolJob({ studyId: "std_1", parameter: "control_event_rate", endpointKey: "orr-recist", calibre: "closest", items: items.slice(0, 2), scale: "identity" }).job.seed, built.job.seed);

  const hazard = poolJob({ studyId: "std_1", parameter: "hazard_ratio", calibre: "overall",
    items: [{ id: "h1", value: 0.46, ci_low: 0.37, ci_high: 0.57 }, { id: "h2", value: 0.6, ci_low: 0.45, ci_high: 0.8 }] });
  assert.equal(hazard.job.scenario.scale, "log");
  assert.equal(hazard.valid, true, JSON.stringify(hazard.issues));
  const invalid = poolJob({ studyId: "", parameter: "hazard_ratio", calibre: "overall", items: [{ id: "h1", value: 0.46, ci_low: 0.37, ci_high: 0.57 }] });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.field === "studyId"));
  const none = poolJob({ studyId: "std_1", parameter: "hazard_ratio", calibre: "overall", items: [{ id: "h1", value: 0.46 }] });
  assert.equal(none.valid, false);
  assert.equal(none.issues[0].code, "no_poolable_study");
});

test("an engine answer is read by its own measure names, and no prediction interval is a finding, not a fallback", () => {
  assert.equal(readPoolResult(null).reason, "result_missing");
  assert.equal(readPoolResult({ status: "failed" }).reason, "engine_failed");
  assert.equal(readPoolResult({ status: "succeeded", measures: [] }).reason, "pooled_value_missing");
  const two = readPoolResult(poolAnswer({ pooled: 0.3, k: 2, confidence: { low: 0.28, high: 0.32 } }));
  assert.equal(two.ok, true, "a pool of two studies is a real pool");
  assert.equal(two.prediction, null, "and has no prediction interval: the confidence interval is not a stand-in for it (plan §6.1)");
  assert.equal(two.predictionAvailable, false);
  assert.deepEqual(two.confidence, { low: 0.28, high: 0.32 });
  const good = readPoolResult(poolAnswer({ pooled: 0.3, low: 0.1, high: 0.5, confidence: { low: 0.27, high: 0.33 } }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.prediction, { low: 0.1, high: 0.5 });
  assert.deepEqual(good.confidence, { low: 0.27, high: 0.33 });
  assert.equal(good.i2, 0.2);
  assert.equal(good.k, 4);
  assert.equal(good.poolingMethod, "random_effects_reml");
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
    { ok: false, reason: "no_pool_succeeded", card: null, nearest: null });
  // The default calibre has no prediction interval (k < 3): no card, and the pool is handed back for the expert setting.
  const thin = assumptionFromPooling({ key: "k", name: "n", parameter: "control_event_rate",
    pools: { overall: readPoolResult(poolAnswer({ pooled: 0.3, k: 2, confidence: { low: 0.2, high: 0.4 } })) }, evidenceIdsByCalibre: { overall: ["evd_1", "evd_2"] } });
  assert.equal(thin.ok, false);
  assert.equal(thin.reason, "prediction_interval_missing");
  assert.equal(thin.nearest?.calibre, "overall");
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
  assert.ok(bounded.distribution.range.low > 0 && bounded.distribution.range.high < 1, "a proportion stays a proportion");
  // E-13: widened on the logit scale, symmetric there — not clipped at 0 and 1, not symmetric on the natural scale.
  const logit = (p) => Math.log(p / (1 - p));
  const expit = (x) => 1 / (1 + Math.exp(-x));
  const half = ((logit(0.2) - logit(0.08)) / 2) * EXPERT_WIDEN_FACTOR;
  assert.ok(Math.abs(bounded.distribution.range.low - expit(logit(0.12) - half)) < 1e-12);
  assert.ok(Math.abs(bounded.distribution.range.high - expit(logit(0.12) + half)) < 1e-12);
  const impossible = expertSetCard({ key: "x", name: "x", parameter: "dropout_rate", nearest: { pointValue: 0, range: { low: 0, high: 0.1 } }, reason: "无证据" });
  assert.equal(impossible.distribution.family, "point", "a proportion of 0 has no logit: the point is kept and the range is not invented");
  assert.equal(impossible.distribution.range, null);

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
  assert.equal(median.endpoint_key, "pfs-blinded", "the endpoint key is the run's judgment, stored as a field");
  assert.equal(median.historical_baseline, true);
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
  const target = { region: "other", eraYear: 2016, eraWindowYears: 5 };
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs, now: () => new Date(AT) });
  await pipeline.extractPrecedent({
    userId: "u1", studyId: "std_1", registryId: "NCT02296125",
    endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
    // The registry's group titles rarely match its arm labels, so which group is the control is the run's judgment.
    armRoles: { "SoC EGFR-TKI (Global Cohort)": "control", "Osimertinib 80 mg (Global Cohort)": "treatment" },
  });
  const queued = await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", target });
  assert.equal(queued.status, "queued");
  assert.equal(queued.armRole, "control", "a median time is pooled over the control arms unless the request says otherwise");
  assert.deepEqual(queued.jobs.map((entry) => entry.calibre), ["closest", "overall"]);
  assert.equal(queued.jobs.every((entry) => entry.jobId), true);
  assert.equal(jobs.enqueued.length, 2);
  assert.equal(jobs.enqueued[0].kind, "pool_evidence");
  assert.equal(jobs.enqueued[0].idempotencyKey, `vcr-pool:std_1:median_time:pfs-blinded:control:closest:${jobs.enqueued[0].seed}`);
  assert.equal(jobs.enqueued[0].scenario.studies.length, 1, "one control arm of one trial: the treatment arm is not in the pool");
  assert.deepEqual(Object.keys(jobs.enqueued[0].scenario.studies[0]).sort(), ["estimate", "se", "studyId"]);
  assert.equal(jobs.enqueued[0].scenario.scale, "log", "a median time is pooled on the log scale");
  assert.equal(jobs.enqueued[0].inputs.every((input) => input.kind === "evidence" && input.hash === undefined), true);
  assert.equal(jobs.enqueued[0].detail.armRole, "control");
  assert.match(jobs.enqueued[0].detail.subjectId, /^pool:median_time:pfs-blinded:control:closest$/, "three calibres are three results, not one superseding the others");
  assert.deepEqual(validateEngineJob({
    jobId: "job_1", studyId: "std_1", kind: "pool_evidence", method: "evidence.pool", methodVersion: "1.0.0", protocolVersion: 1,
    seed: jobs.enqueued[0].seed, cpuSecondsLimit: 120, scenario: jobs.enqueued[0].scenario, inputs: jobs.enqueued[0].inputs,
  }), [], "the job the pipeline queues is one the engine's own schema accepts");
  assert.equal(queued.evidenceIdsByCalibre.closest.length, 1);

  // The treatment arm, asked for by name, is its own pool.
  const treatment = await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", armRole: "treatment", target });
  assert.equal(treatment.status, "queued");

  // No endpoint key, no pool: the run has to say what it pools.
  const keyless = await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "", target });
  assert.equal(keyless.status, "refused");
  assert.equal(keyless.code, "vcr_pool_endpoint_key_required");

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

test("a re-extraction replaces the value for the pool and does not double it (the latest row per precedent, parameter, arm and endpoint key)", async () => {
  const store = storeDouble();
  const jobs = jobsDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs, now: () => new Date(AT) });
  const request = { userId: "u1", studyId: "std_1", registryId: "NCT02296125",
    endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" }, armRoles: { "SoC EGFR-TKI (Global Cohort)": "control" } };
  await pipeline.extractPrecedent(request);
  await pipeline.extractPrecedent(request);
  await pipeline.extractPrecedent(request);
  assert.equal(store.evidence.filter((row) => row.parameter === "median_time" && row.arm.startsWith("SoC")).length, 3, "the ledger keeps every attempt");
  await pipeline.poolParameter({ userId: "u1", studyId: "std_1", parameter: "median_time", endpointKey: "pfs-blinded", target: {} });
  assert.equal(jobs.enqueued.find((job) => job.detail.calibre === "overall").scenario.studies.length, 1, "the same trial pooled three times is one study, not three");
});

test("CS-27 a registry that has no such record is not found, and one that could not be asked is unavailable: two different findings", async () => {
  const store = storeDouble();
  const absent = createVcrEvidencePipeline({ store, registry: { configured: true, async record() { return { status: "registry_not_found", reason: "registry_not_found", registryId: "NCT0" }; } } });
  const missing = await absent.readRegistryRecord({ registryId: "NCT00000000" });
  assert.deepEqual([missing.available, missing.status, missing.code], [false, "registry_not_found", "registry_not_found"]);
  const offline = createVcrEvidencePipeline({ store, registry: registryDouble({ outage: "ENOTFOUND" }) });
  const unreachable = await offline.readRegistryRecord({ registryId: "NCT02296125" });
  assert.deepEqual([unreachable.available, unreachable.status, unreachable.code, unreachable.reason], [false, "registry_unavailable", "registry_unavailable", "ENOTFOUND"]);
  const none = await createVcrEvidencePipeline({ store }).readRegistryRecord({ registryId: "NCT02296125" });
  assert.deepEqual([none.available, none.code, none.reason], [false, "registry_unavailable", "registry_not_configured"]);
  const ok = await createVcrEvidencePipeline({ store, registry: registryDouble(), now: () => new Date(AT) }).readRegistryRecord({ registryId: "NCT02296125" });
  assert.equal(ok.available, true);
  // A write of an unfindable record says the same thing.
  const extracted = await absent.extractPrecedent({ userId: "u1", studyId: "std_1", registryId: "NCT00000000" });
  assert.equal(extracted.status, "registry_not_found");
});

test("ChiCTR: the record asked for is the one whose own registration number it is, and the nearest is never taken instead", async () => {
  const store = storeDouble();
  const hit = { precedent: { registry: "chictr", registryId: "ChiCTR2000030000", title: "试验", pico: { conditions: [], interventions: [] }, design: {}, enrollment: {}, sites: {}, endpoints: [], results: {}, sources: [] },
    extractions: [], record: { text: "", url: "" } };
  const other = { ...hit, precedent: { ...hit.precedent, registryId: "ChiCTR2000030001" } };
  const registry = { configured: true, async searchChictr() { return { status: "ok", items: [other, hit] }; } };
  const pipeline = createVcrEvidencePipeline({ store, registry, now: () => new Date(AT) });
  const found = await pipeline.readRegistryRecord({ registry: "chictr", registryId: "chictr2000030000" });
  assert.equal(found.available, true);
  assert.equal(found.registryId, "ChiCTR2000030000");
  const nearest = await pipeline.readRegistryRecord({ registry: "chictr", registryId: "ChiCTR2000099999" });
  assert.equal(nearest.status, "registry_not_found", "three digits off is a different trial");
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

test("PA-6 a value a run read out of a preserved record is checked in code against that record before it is stored", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble(), now: () => new Date(AT) });
  const study = { userId: "u1", studyId: "std_1" };
  // The record is not in the study yet: the value has nothing to be checked against.
  const early = await pipeline.addEvidenceItem({ ...study, item: { registryId: "NCT02296125", parameter: "orr", value: 0.8, quote: "x" } });
  assert.deepEqual([early.status, early.code], ["refused", "vcr_precedent_not_in_study"]);

  await pipeline.extractPrecedent({ ...study, registryId: "NCT02296125" });
  const quote = "protocolSection.designModule.enrollmentInfo.count: 674";
  const good = await pipeline.addEvidenceItem({ ...study, item: {
    registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 674, unit: "participants", quote, endpointKey: "enrollment",
    historicalBaseline: true, locator: { path: "protocolSection.designModule.enrollmentInfo.count" },
  } });
  assert.equal(good.state, "verified");
  const row = store.evidence.find((entry) => entry.id === good.id);
  assert.equal(row.value, 674);
  assert.equal(row.locator.authoredBy, "run", "the row says it was a run's reading, verified in code");
  assert.equal(row.locator.verification, "verified");

  // A number that is not in the record is stored as unknown and can never be cited.
  const invented = await pipeline.addEvidenceItem({ ...study, item: { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 999, quote, endpointKey: "enrollment" } });
  assert.equal(invented.state, "quote_missing_number");
  assert.equal(store.evidence.find((entry) => entry.id === invented.id).value, null);
  // A sentence the record does not contain is not found.
  const fluent = await pipeline.addEvidenceItem({ ...study, item: { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 674, quote: "enrolment was 674 patients", endpointKey: "enrollment" } });
  assert.equal(fluent.state, "quote_not_found");
  // A record of another study's account is not this study's: the precedent write comes first.
  const strangerStore = await pipeline.addEvidenceItem({ userId: "u2", studyId: "std_9", item: { registryId: "NCT02296125", parameter: "x", quote, value: 674 } });
  assert.equal(strangerStore.code, "vcr_precedent_not_in_study");
});

test("a pool with fewer than three studies has no prediction interval and becomes a widened expert setting, never a card that borrows the confidence interval", async () => {
  const store = storeDouble();
  const pipeline = createVcrEvidencePipeline({ store, registry: registryDouble(), jobs: jobsDouble(), now: () => new Date(AT) });
  const saved = await pipeline.saveAssumptionFromPooling({
    userId: "u1", studyId: "std_1", key: "control_hr", name: "对照风险比", parameter: "hazard_ratio",
    results: { overall: poolAnswer({ pooled: Math.log(0.6), k: 2, scale: "log", confidence: { low: Math.log(0.45), high: Math.log(0.8) } }) },
    evidenceIdsByCalibre: { overall: ["evd_1", "evd_2"] },
  });
  assert.equal(saved.status, "expert_set");
  assert.equal(saved.card.sourceKind, "expert_set");
  assert.deepEqual(saved.card.evidenceIds, [], "an expert setting cites no extracted value");
  assert.deepEqual(saved.card.pooling.basedOn.evidenceIds, ["evd_1", "evd_2"], "but says what it was widened from");
  assert.ok(Math.abs(saved.card.pointValue - 0.6) < 1e-12, "the pooled value on the natural scale");
  const half = ((Math.log(0.8) - Math.log(0.45)) / 2) * EXPERT_WIDEN_FACTOR;
  assert.ok(Math.abs(saved.card.distribution.range.low - Math.exp(Math.log(0.6) - half)) < 1e-9);
  assert.ok(saved.card.note.startsWith(EXPERT_SET_NOTE));
  assert.equal(store.assumptions.length, 1);
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
  /** Column names of one table: its CREATE TABLE and every column added to it since. */
  const columnsOf = (table) => {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS evimed_vcr.${table} (`);
    assert.notEqual(start, -1, `the schema has no ${table}`);
    const body = schema.slice(start, schema.indexOf("\n);", start));
    const created = [...body.matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]);
    const added = [...schema.matchAll(new RegExp(`ALTER TABLE evimed_vcr\\.${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)`, "g"))].map((match) => match[1]);
    return new Set([...created, ...added]);
  };
  let checked = 0;
  for (const match of store.matchAll(/INSERT INTO \$\{VCR_SCHEMA\}\.([a-z_]+)\s*\(([^)]+)\)/g)) {
    const [, table, list] = match;
    const declared = columnsOf(table);
    for (const column of list.split(/[,\s]+/).map((word) => word.trim()).filter(Boolean)) {
      assert.ok(declared.has(column), `${table} has no column ${column}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 50, `only ${checked} columns checked — the walk stopped reading the store`);
  // And every table it touches is one the migration creates.
  const tables = new Set([...store.matchAll(/\$\{VCR_SCHEMA\}\.([a-z_]+)/g)].map((match) => match[1]));
  // `audit` is written by `VcrStoreBase`, which every package shares.
  assert.deepEqual([...tables].sort(), ["assumptions", "evidence_items", "precedents", "study_precedents"]);
});
