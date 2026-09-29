// 「虚拟临研」's switch, its deterministic read-model rules, and the first
// catalogue it seeds — all without a database.
//
// The rules held here are the ones a page must never ask a model about: which
// comparator routes a data tier can reach, which design is dominated on the
// team's own comparison goal, and how the four counts are read apart.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_READ_WHATS, VCR_REFERENCE_MODELS, VCR_WRITE_WHATS, seedVcrCatalogue, vcrAudienceAllows, vcrCountBand,
  vcrDominatedScenarios, vcrMetricFamilies, vcrReadiness, vcrRouteOptions,
} from "../src/vcrService.mjs";
import { VCR_COUNT_KEYS, VCR_ENGINE_METHODS, VCR_ROUTE_MIN_TIER, VCR_TABS, intendedUseCeiling, missingModelEvidence } from "@evimed/domain";

test("AC-01 the module is invisible unless it is on and open to this account", () => {
  const off = { vcrEnabled: false, vcrAudience: "all" };
  assert.equal(vcrAudienceAllows(off, { id: "u1" }), false);
  const everyone = { vcrEnabled: true, vcrAudience: "all" };
  assert.equal(vcrAudienceAllows(everyone, { id: "u1" }), true);
  const operators = { vcrEnabled: true, vcrAudience: "operators", operatorUsers: ["ops"], vcrPreviewUsers: ["preview"] };
  assert.equal(vcrAudienceAllows(operators, { id: "ops" }), true);
  assert.equal(vcrAudienceAllows(operators, { id: "preview" }), true);
  assert.equal(vcrAudienceAllows(operators, { id: "someone" }), false);
  assert.equal(vcrAudienceAllows(operators, null), false);
});

test("AC-01 the study page has exactly seven tabs, and the runtime's vocabularies are closed", () => {
  assert.deepEqual([...VCR_TABS], ["overview", "population", "patients", "comparator", "trial", "matching", "data"]);
  assert.equal(VCR_TABS.length, 7, "the design spec caps a page at seven tabs");
  // The two vocabularies a run may name. Numbers are on neither write list.
  for (const forbidden of ["results", "counts", "measures", "execution"]) {
    assert.equal(VCR_WRITE_WHATS.includes(forbidden), false, forbidden);
  }
  assert.ok(VCR_READ_WHATS.includes("results"), "a run reads results, it does not write them");
});

test("which comparator routes a data tier can reach is deterministic, not a model's opinion", () => {
  const t0 = vcrRouteOptions("T0");
  assert.deepEqual(t0.filter((option) => option.available).map((option) => option.route),
    ["literature_control", "model_comparator", "hybrid_control"]);
  const t2 = vcrRouteOptions("T2");
  assert.deepEqual(t2.filter((option) => option.available).map((option) => option.route),
    ["external_control", "literature_control", "model_comparator", "hybrid_control"]);
  const t3 = vcrRouteOptions("T3");
  assert.equal(t3.every((option) => option.available), true, "T3 reaches every route");
  // The table is the domain's, not this module's second copy of it.
  for (const option of t0) assert.equal(option.minimumTier, VCR_ROUTE_MIN_TIER[option.route]);
});

test("the four counts are read apart, and the two optional ones only appear when their route was used", () => {
  const band = vcrCountBand({ realPatients: 300, events: 138, generatedRecords: 0 });
  assert.deepEqual(Object.keys(band).sort(), [...VCR_COUNT_KEYS].sort());
  assert.equal(band.effectiveSampleSize, null, "a count nobody took is null, never 0");
  const weighted = vcrCountBand({ realPatients: 300, events: 138, effectiveSampleSize: 186, generatedRecords: 0,
    reconstructedPseudoPatients: 412 });
  assert.equal(weighted.reconstructedPseudoPatients, 412);
  assert.equal(weighted.realPatients, 300, "a reconstructed pseudo-patient is never folded into a real one");
});

test("a design is dominated only when the team's own goal makes it decidable, and a tie does not dominate", () => {
  const measures = (/** @type {Record<string, number>} */ values) => ({
    result: { measures: Object.entries(values).map(([name, value]) => ({ name, value })) },
  });
  const scenarios = [
    { id: "A", label: "单臂 + 文献对照", ...measures({ power: 0.61, duration_months: 30, cost: 1_200 }) },
    { id: "B", label: "2:1 随机", ...measures({ power: 0.71, duration_months: 26, cost: 1_000 }) },
    { id: "C", label: "1:1 随机加期中", ...measures({ power: 0.71, duration_months: 26, cost: 1_000 }) },
  ];
  // With no goal written down the platform orders nothing.
  assert.deepEqual(vcrDominatedScenarios(scenarios, {}), []);
  const goal = { measures: [{ name: "power", direction: "higher" }, { name: "duration_months", direction: "lower" }, { name: "cost", direction: "lower" }] };
  const dominated = vcrDominatedScenarios(scenarios, goal);
  assert.deepEqual(dominated.map((entry) => entry.id), ["A"], "A is worse on all three");
  assert.ok(["B", "C"].includes(dominated[0].dominatedBy));
  // B and C are equal on everything: neither dominates the other.
  assert.deepEqual(vcrDominatedScenarios(scenarios.slice(1), goal), []);
  // A measure one design does not report leaves the comparison undecidable.
  const partial = [...scenarios.slice(1), { id: "D", label: "自适应", ...measures({ power: 0.8 }) }];
  assert.deepEqual(vcrDominatedScenarios(partial, goal).map((entry) => entry.id), []);
});

test("AC-34 the intended use a result may claim follows from the tiers of the models it used", () => {
  assert.equal(intendedUseCeiling([]), "submission_preparation", "no model, no model ceiling");
  assert.equal(intendedUseCeiling(["scenario"]), "exploratory");
  assert.equal(intendedUseCeiling(["validated", "literature"]), "design_support", "the weakest model decides");
  assert.equal(intendedUseCeiling(["data"]), "specified_analysis");
  // And the evidence a model's own risk demands is separate from its tier.
  assert.deepEqual([...missingModelEvidence("none", ["code_verification", "seed_reproducible"])], []);
  assert.deepEqual([...missingModelEvidence("medium", ["code_verification", "seed_reproducible"])],
    ["input_traceable", "sensitivity_analysis", "external_validation", "model_locked", "model_analysis_plan"]);
});

test("the first catalogue seeds every engine method and the three reference simulators, idempotently", async () => {
  /** @type {any[]} */
  const methods = [];
  /** @type {any[]} */
  const models = [];
  const store = {
    async ready() { return true; },
    async saveMethod(input) { methods.push(input); return { id: `mth_${methods.length}` }; },
    async saveModel(input) { models.push(input); return { id: `mdl_${models.length}` }; },
  };
  const seeded = await seedVcrCatalogue({ store });
  assert.equal(seeded.methods, Object.keys(VCR_ENGINE_METHODS).length);
  assert.equal(seeded.models, 3);
  assert.equal(seeded.engineMismatch, null, "no engine, nothing to compare against");
  // The methods are the domain's list, at the versions the domain pins.
  assert.deepEqual(methods.map((method) => method.method).sort(), Object.keys(VCR_ENGINE_METHODS).sort());
  for (const method of methods) assert.equal(method.version, VCR_ENGINE_METHODS[method.method].version);
  // The three simulators are scenario-tier by construction: they answer 「under
  // these assumptions」 and carry no claim about any real population.
  assert.deepEqual(models.map((model) => model.name), VCR_REFERENCE_MODELS.map((model) => model.name));
  for (const model of models) {
    assert.equal(model.tier, "scenario");
    assert.equal(model.risk, "none");
    assert.deepEqual([...missingModelEvidence(model.risk, model.evidence)], [], "a reference simulator carries what its risk asks for");
    assert.match(String(model.applicability.population), /情景推演/);
    assert.ok(model.card.knownLimits.length > 0 && model.card.retirement, "a model card states its limits and its retirement rule");
  }
});

test("a catalogue the engine does not match is a notice, never a block", async () => {
  const store = { async ready() { return true; }, async saveMethod() { return {}; }, async saveModel() { return {}; } };
  const engine = {
    configured: () => true,
    async health() { return { ok: true, methods: ["design.simulate", "something.else"] }; },
  };
  const seeded = await seedVcrCatalogue({ store, engine });
  assert.ok(seeded.engineMismatch.some((line) => line.includes("引擎有目录没有：something.else")));
  assert.ok(seeded.engineMismatch.some((line) => line.includes("目录有引擎没有：comparator.rmst")));

  // An engine that cannot be reached is reported and the seeding still stands.
  /** @type {string[]} */
  const reported = [];
  const unreachable = await seedVcrCatalogue({
    store, report: (code) => reported.push(code),
    engine: { configured: () => true, async health() { const error = new Error("down"); /** @type {any} */ (error).code = "vcr_engine_unreachable"; throw error; } },
  });
  assert.equal(unreachable.engineMismatch, null);
  assert.deepEqual(reported, ["vcr_engine_unreachable"]);
});

test("readiness is red only for this module's own invariants; a missing engine is a warning", async () => {
  assert.deepEqual(await vcrReadiness({ config: { vcrEnabled: false }, vcr: null, database: null }), { enabled: false, status: "off" });
  await assert.rejects(vcrReadiness({ config: { vcrEnabled: true }, vcr: null, database: {} }),
    (/** @type {any} */ error) => error.code === "vcr_unavailable");
  await assert.rejects(vcrReadiness({ config: { vcrEnabled: true }, vcr: { service: { async ready() { const error = new Error("x"); /** @type {any} */ (error).code = "42P01"; throw error; } } }, database: {} }),
    (/** @type {any} */ error) => error.code === "vcr_migration_failed");

  const ready = await vcrReadiness({
    config: { vcrEnabled: true, vcrAudience: "operators", vcrDataPlaneDir: "" },
    vcr: { service: { async ready() { return true; }, engineMismatch: null }, engine: { configured: () => false } },
    database: {},
  });
  assert.equal(ready.status, "ok");
  assert.deepEqual(ready.warnings, ["vcr_engine_not_composed", "vcr_data_plane_not_configured"]);
  assert.equal(ready.warning, "vcr_engine_not_composed");
});

test("the metric families count what the module did, and nothing about a study", () => {
  const families = vcrMetricFamilies({ metrics: () => ({ studiesCreated: 2, reads: 9, writes: 4, writeIssues: 1, notFound: 3 }) });
  assert.deepEqual(families.map((family) => [family.name, family.value]), [
    ["evimed_vcr_studies_created_total", 2],
    ["evimed_vcr_runtime_reads_total", 9],
    ["evimed_vcr_runtime_writes_total", 4],
    ["evimed_vcr_runtime_write_issues_total", 1],
    ["evimed_vcr_study_not_found_total", 3],
  ]);
  assert.ok(families.every((family) => family.type === "counter" && family.help));
  // A service with no counters yet reports zeroes rather than throwing.
  assert.ok(vcrMetricFamilies(null).every((family) => family.value === 0));
});
