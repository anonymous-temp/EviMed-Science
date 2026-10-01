// The one boundary between the platform's numbers and a model: everything the
// runtime can read passes through the domain's `suppressForModel` exactly once
// (integration contract §4; the review's PA-3, PB-3 and CS-6).
//
// The first build suppressed one shape — a `cells` array — that nothing in the
// system produces. These tests feed the boundary every shape the stores really
// emit (`counts`, `waterfall[]`, `diagnostics.arms[]`, `levels` maps, the
// matching cells) through the real service, for every `what` a run may read and
// for the answer to a simulate status, and assert that no head count below the
// floor survives anywhere in what a model receives — including in a payload
// nested past twelve levels.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_MIN_CELL_SIZE } from "@evimed/domain";

import { VCR_PUBLISHED_FIGURE_READS, VCR_READ_WHATS, VcrService } from "../src/vcrService.mjs";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { createTrialRegistryClient } from "../src/trialRegistryClient.mjs";
import { FLAURA } from "./vcrEvidenceFixtures.mjs";
import { Readable } from "node:stream";

const AT = "2026-09-28T00:00:00.000Z";
const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201", question: "q", dataTier: "T1", intendedUse: "exploratory",
  status: "active", steps: {}, budget: {}, outcomeSeal: {} };

/** Distinctive small counts: any of them appearing as a number in an answer is a leak (nothing else in a fixture is one of these). */
const SMALL = [5, 6, 7, 8];

/** Every finite number in a payload, at any depth. @param {any} value @param {number[]} [out] */
function numbersIn(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => numbersIn(item, out));
  return out;
}

const counts = { realPatients: 6, events: 8, effectiveSampleSize: null, generatedRecords: 2000 };
const populationRow = {
  id: "pop_1", studyId: "std_1", version: 1, name: "队列", kind: "real", definition: {}, snapshotId: null,
  counts: { realPatients: 412, events: 7 }, waterfall: [{ step: "确诊", kept: 412, excluded: 0 }, { step: "既往治疗", kept: 5, excluded: 407 }],
  profile: { levels: { A: 12, B: 6 } }, quality: {}, allowedUses: [], resultId: null, reviewState: "ai_set", createdAt: AT,
};
const resultRow = {
  id: "res_1", studyId: "std_1", executionId: "exe_1", kind: "comparator", subjectId: null, version: 1, conclusion: "limited", notEstimableRule: null,
  counts, measures: [{ name: "hr", value: 0.61, simulated: false }],
  diagnostics: { arms: [{ arm: "试验", n: 6, events: 8 }, { arm: "对照", n: 400, events: 90 }, { arm: "外部", n: 250, events: 60 }], balance: { levels: { 男: 5, 女: 250 } } },
  tables: [], intendedUse: "exploratory", useDowngrade: null, reviewState: "ai_set", supersededBy: null, createdAt: AT,
};

/** A store double answering every read the service's runtime half makes. */
const store = {
  async latestDefinition() { return { id: "def_1", version: 1, pico: {}, estimand: {}, endpointType: "time_to_event", intendedUse: "exploratory" }; },
  async definitionVersions() { return [{ version: 1, createdAt: AT }]; },
  async staleMarks() { return []; },
  async latestProtocolVersion() { return { id: "prt_1", version: 1 }; },
  async criteria() { return []; },
  async assumptions() { return []; },
  async populations() { return [populationRow]; },
  async latestPopulation() { return populationRow; },
  async patientSets() { return [{ id: "pts_1", studyId: "std_1", counts: { realPatients: 6, generatedRecords: 500 }, scenario: {}, modelId: "reference-time-to-event" }]; },
  async comparatorDesigns() { return [{ id: "cmp_1", route: "external_control", configuration: { note: "x" } }]; },
  async latestComparatorDesign() { return null; },
  async trialScenarios() { return []; },
  async latestDesignGrid() { return { id: "grd_1", cells: [{ label: "A", n: 6, power: 0.8 }, { label: "B", n: 250, power: 0.9 }, { label: "C", n: 300, power: 0.95 }] }; },
  async forecasts() { return []; },
  async results() { return [resultRow]; },
  async jobs() { return [{ id: "job_1", state: "succeeded", progress: { done: 40, total: 40 } }]; },
  async models() { return [{ id: "mdl_1", name: "reference-time-to-event", evidence: [], tier: "scenario" }]; },
  async methods() { return []; },
  async reviews() { return []; },
  async exports() { return []; },
};

function service(packages = {}) {
  const built = new VcrService({
    store: /** @type {any} */ (store), config: { vcrEnabled: true, vcrAudience: "all" },
    matching: { async runtimeRead() { return { summaryCells: [{ key: "eligible", n: 6 }, { key: "ineligible", n: 400 }, { key: "pending", n: 90 }], subjects: [] }; } },
    evidence: {
      async runtimeRead() { return { precedents: [], coverage: [{ parameter: "median_time", extracted: 4, verified: 3, refused: 1, precedents: 2 }] }; },
      async evidenceRead() { return { items: [{ id: "evd_1", sampleSize: 6, events: 7 }] }; },
      async registryRecord() { return { record: { values: [{ parameter: "arm_started", value: 6, sampleSize: 8 }] } }; },
    },
    dataPlane: { async runtimeProfile() { return { available: true, columns: [{ name: "sex", levels: { 男: 5, 女: 250 }, filled: 255 }] }; } },
    documents: { async subjectDocuments() { return { available: true, subjects: [{ subjectKey: "P-1", documents: 2 }] }; } },
    ...packages,
  });
  // The ceiling is the page's own computation over a bundle of a dozen more reads than this double answers;
  // `vcrEvidenceMatching.integration.test.mjs` runs the real one over the real stores.
  built.ceilingOf = async () => ({ ceiling: "design_support", requested: "exploratory", withinCeiling: true, reasons: [] });
  return built;
}

test("every `what` a run may read leaves through the boundary: no head count below the floor survives in any shape the stores emit", async () => {
  const seen = [];
  for (const what of VCR_READ_WHATS) {
    const answer = await service().runtimeRead(study, what, what === "snapshot_profile" ? { snapshotId: "snp_1" } : { registryId: "NCT02296125" });
    seen.push(what);
    // The three reads of another trial's published figures (an extracted value and its sample size, a registry
    // record's enrolment and site count) are not this study's people: the boundary leaves them whole, by `what`,
    // and the tests below prove they are neither hollowed nor a way round it.
    if (VCR_PUBLISHED_FIGURE_READS.includes(what)) continue;
    const small = numbersIn(answer).filter((value) => Number.isInteger(value) && value >= 1 && value < VCR_MIN_CELL_SIZE && SMALL.includes(value));
    // Numbers that are not people (a version, an ordinal) are not in SMALL's set by construction of the fixtures.
    assert.deepEqual(small, [], `${what} carried a small count: ${JSON.stringify(answer).slice(0, 300)}`);
  }
  assert.deepEqual(seen, [...VCR_READ_WHATS], "the walk read every `what`");
});

test("the shapes the stores emit are each suppressed as their own kind of cell", async () => {
  const population = await service().runtimeRead(study, "population");
  const [row] = population.populations;
  assert.equal(row.counts.events, null, "a standalone count is hidden");
  assert.deepEqual(row.counts.suppressed, ["events"], "and the object says which key it hid");
  assert.equal(row.counts.realPatients, 412);
  // A waterfall is a list of sibling cells: the small one is hidden with its neighbour, never alone.
  assert.equal(row.waterfall.some((step) => step.kept === 5), false);
  assert.ok(row.waterfall.every((step) => step.suppressed), "with two cells the small step and the next-smallest are both hidden: a lone hidden cell can be subtracted from the total");
  assert.ok(row.waterfall.every((step) => typeof step.step === "string"), "a hidden cell keeps its identity and loses every number");
  // A `levels` map is sibling cells too.
  assert.equal(row.profile.levels.B, null);
  assert.equal(row.profile.levels.A, null, "12 is hidden with 6: two cells at least, at least the floor");

  const results = await service().runtimeRead(study, "results");
  const arms = results.results[0].diagnostics.arms;
  const small = arms.find((arm) => arm.arm === "试验");
  assert.equal(small.n, null);
  assert.equal(small.events, null);
  assert.deepEqual(small.suppressed.sort(), ["events", "n"]);
  assert.equal(arms.find((arm) => arm.arm === "外部").n, null, "the next-smallest cell is hidden with it, so the small one cannot be got back by subtraction");
  assert.equal(arms.find((arm) => arm.arm === "对照").n, 400, "the largest is shown");
  assert.equal(results.results[0].counts.realPatients, null);
  assert.equal(results.results[0].counts.events, null);
  assert.equal(results.results[0].counts.generatedRecords, 2000, "generated records are not people");
  assert.equal(results.results[0].diagnostics.balance.levels.男, null);
  assert.equal(results.results[0].diagnostics.balance.levels.女, null);

  const grid = (await service().runtimeRead(study, "trial")).grid;
  assert.equal(grid.cells.find((cell) => cell.label === "A").n, null, "a design grid's cell is a cell like any other");
  assert.equal(grid.cells.find((cell) => cell.label === "C").n, 300);
});

test("the matching aggregates arrive as cells and are hidden by the same one boundary", async () => {
  const answer = await service().runtimeRead(study, "matching", {});
  const eligible = answer.summaryCells.find((cell) => cell.key === "eligible");
  assert.equal(eligible.n, null);
  assert.deepEqual(eligible.suppressed, ["n"]);
  assert.equal(answer.summaryCells.find((cell) => cell.key === "pending").n, null, "hidden together with its smallest neighbour");
  assert.equal(answer.summaryCells.find((cell) => cell.key === "ineligible").n, 400);
});

test("the snapshot profile, the evidence read, the registry read and the document listing pass the boundary too", async () => {
  const profile = await service().runtimeRead(study, "snapshot_profile", { snapshotId: "snp_1" });
  assert.equal(profile.columns[0].levels.男, null);
  // Another trial's published figures are not this study's people: an extracted value's sample size and events
  // stay as extracted (they were hollowed to nothing before, and a run could not read a precedent it was given).
  const evidence = await service().runtimeRead(study, "evidence", {});
  assert.equal(evidence.items[0].events, 7);
  assert.equal(evidence.items[0].sampleSize, 6);
  const registry = await service().runtimeRead(study, "trial_registry_record", { registryId: "NCT02296125" });
  assert.equal(registry.record.values[0].value, 6);
  assert.equal(registry.record.values[0].sampleSize, 8);
  const counted = await service({ evidence: { async registryRecord() { return { record: { values: [{ parameter: "x", events: 6 }] } }; } } })
    .runtimeRead(study, "trial_registry_record", { registryId: "NCT02296125" });
  assert.equal(counted.record.values[0].events, 6, "a published event count is a published figure");
  const documents = await service().runtimeRead(study, "subject_document", {});
  assert.equal(documents.subjects[0].documents, 2, "a document count is not a people count either");
});

test("a payload nested past twelve levels is walked all the way down, and a cycle is refused whole", async () => {
  let deep = { realPatients: 6 };
  for (let level = 0; level < 40; level += 1) deep = { inner: deep };
  const nested = service({ matching: { async runtimeRead() { return deep; } } });
  const answer = await nested.runtimeRead(study, "matching", {});
  let node = answer;
  while (node.inner) node = node.inner;
  assert.equal(node.realPatients, null, "40 levels down, the count is still hidden");
  assert.deepEqual(node.suppressed, ["realPatients"]);

  /** @type {any} */
  const cyclic = { counts: { realPatients: 400 } };
  cyclic.self = cyclic;
  await assert.rejects(() => service({ matching: { async runtimeRead() { return cyclic; } } }).runtimeRead(study, "matching", {}),
    (error) => /** @type {any} */ (error).code === "vcr_gateway_unavailable", "a payload the boundary cannot finish is not passed on unfinished");
});

test("the deployment may raise the floor and never lower it", async () => {
  const raised = new VcrService({ store: /** @type {any} */ (store), config: { vcrMinCellSize: 30 }, });
  assert.equal(raised.minCell, 30);
  assert.equal(new VcrService({ store: /** @type {any} */ (store), config: { vcrMinCellSize: 2 } }).minCell, VCR_MIN_CELL_SIZE);
  assert.equal(new VcrService({ store: /** @type {any} */ (store), config: {} }).minCell, VCR_MIN_CELL_SIZE);
  const answer = await raised.runtimeRead(study, "results");
  assert.equal(answer.results[0].diagnostics.arms.find((arm) => arm.arm === "对照").n, 400);
  assert.equal(answer.results[0].diagnostics.arms.find((arm) => arm.arm === "外部").n, null, "250 is shown at the default floor and hidden by a deployment that raised it above the cell's smallest count");
});

/** A request the gateway handler reads. */
function request(url, body) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { authorization: "Bearer token" } });
}
function response() {
  return { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

test("the answer to a simulate status passes the boundary too: a run does not read a small arm of its own simulation", async () => {
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) };
  const jobs = {
    async get() { return { id: "job_1", state: "succeeded", method: "design.simulate", progress: {}, cpuSecondsUsed: 1, error: null }; },
  };
  const gatewayStore = {
    async studyByControlProject() { return study; },
    async one(sql) { return sql.includes("executions") ? { id: "exe_1" } : { checkpoint: {} }; },
    async allResults() { return [resultRow]; },
  };
  const svc = service();
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" }, runtimeManager,
    { vcr: { service: /** @type {any} */ (svc), store: gatewayStore, jobs } });
  const res = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_1" }), res);
  assert.equal(res.status, 200);
  const result = res.json().data.result;
  assert.equal(result.counts.realPatients, null);
  assert.equal(result.diagnostics.arms.find((arm) => arm.arm === "对照").n, 400);
  const small = numbersIn(res.json()).filter((value) => SMALL.includes(value));
  assert.deepEqual(small, []);
  assert.equal(result.diagnostics.arms.find((arm) => arm.arm === "试验").n, null);
});

test("a run is never told where a file lives or which inputs a job hashed", async () => {
  const { stripPlaneAddresses } = await import("../src/vcrService.mjs");
  const answer = { result: { tables: [{ name: "population", location: "derived/std_1/job_1/population.csv", sha256: "a".repeat(64) }],
    manifest: { inputHashes: [{ id: "snp_1:subject", hash: "b".repeat(64) }], outputHash: "c".repeat(64), signature: "d".repeat(64), packageLockHash: "e".repeat(64) } } };
  const told = /** @type {any} */ (stripPlaneAddresses(answer));
  assert.deepEqual(told.result.tables, [{ name: "population", sha256: "a".repeat(64) }]);
  assert.deepEqual(told.result.manifest, { packageLockHash: "e".repeat(64) });
});

// ---------------------------------------------------------------------------
// What the boundary hollowed and what it let out (merge verification C2-2, C3-04)
// ---------------------------------------------------------------------------

/**
 * The runtime's own read, through the real gateway handler and the real service, the way a run calls it.
 * @param {any} svc @param {Record<string, any>} body
 */
async function gatewayRead(svc, body) {
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" }, runtimeManager,
    { vcr: { service: svc, store: { async studyByControlProject() { return study; } } } });
  const res = response();
  await handler(request("/internal/vcr/v1/read", body), res);
  return res;
}

/** The evidence pipeline over the real registry client (recorded ClinicalTrials.gov record) and a store that answers what a read asks. */
function realEvidence() {
  const registry = createTrialRegistryClient({ fetchImpl: async () => new Response(JSON.stringify(FLAURA), { status: 200 }) });
  const evidenceRows = [
    { id: "evd_1", parameter: "median_time", arm: "对照", arm_role: "control", endpoint_key: "pfs", value: "10.2", unit: "months", ci_low: "9.6", ci_high: "11.1",
      sample_size: null, events: null, value_source: "extracted", locator: { verification: "verified" }, historical_baseline: true, enrollment_kind: "actual",
      quote: "10.2", source_ref: "clinicaltrials.gov:NCT02296125", precedent_id: "pre_1" },
    { id: "evd_2", parameter: "response_rate", arm: "试验", arm_role: "treatment", endpoint_key: "orr", value: "0.8", unit: "", ci_low: null, ci_high: null,
      sample_size: 6, events: null, value_source: "extracted", locator: { verification: "verified" }, historical_baseline: true, enrollment_kind: "actual",
      quote: "0.8", source_ref: "clinicaltrials.gov:NCT02296125", precedent_id: "pre_1" },
  ];
  const store = {
    async listEvidenceItems() { return evidenceRows; },
    async listPrecedents() { return [{ id: "pre_1", registry: "clinicaltrials.gov", registry_id: "NCT02296125", title: "FLAURA", design: { phases: ["PHASE3"] },
      results: { hasResults: true }, enrollment: { planned: 5, actual: 8 }, sites: { count: 4, countries: ["United States"] } }]; },
    async evidenceCoverage() { return [{ parameter: "median_time", extracted: 3, verified: 2, refused: 1, precedents: 1 }]; },
    async latestAssumptions() { return []; },
    async audit() {},
  };
  return createVcrEvidencePipeline({ store, registry, jobs: null });
}

test("C2-2 a registry record whose values carry an unknown `events` reaches a run whole, through the real gateway", async () => {
  const svc = service({ evidence: realEvidence() });
  const res = await gatewayRead(svc, { what: "trial_registry_record", filter: { registryId: "NCT02296125" } });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  const { record } = res.json().data;
  assert.ok(record.values.length >= 10, "the record's extracted values are all there");
  assert.equal(record.values.filter((/** @type {any} */ row) => row.suppressed).length, 0, "no row was hollowed");
  assert.ok(record.values.every((/** @type {any} */ row) => typeof row.parameter === "string" && row.quote), "every row still says what it is and quotes its source");
  const enrollment = record.values.find((/** @type {any} */ row) => row.parameter === "enrollment_actual");
  assert.equal(enrollment.value, 674, "the published enrolment is a published figure, not a small cell");
  assert.equal(record.sites.count, 4, "a registry's site count is not a head count of this study's people");
  assert.equal("suppressed" in record.sites, false);
});

test("C2-2 the study's extracted values and its precedents are read whole: an unknown `events` and a small published sample size do not hollow a row", async () => {
  const svc = service({ evidence: realEvidence() });
  const evidence = (await gatewayRead(svc, { what: "evidence" })).json().data;
  assert.equal(evidence.items.length, 2);
  assert.deepEqual(evidence.items.map((/** @type {any} */ item) => item.parameter), ["median_time", "response_rate"], "the rows keep their parameters");
  assert.equal(evidence.items[0].value, 10.2);
  assert.equal(evidence.items[1].sampleSize, 6, "a published sample size of six is what the trial reported");
  assert.ok(evidence.items.every((/** @type {any} */ item) => !item.suppressed));
  const precedents = (await gatewayRead(svc, { what: "precedents" })).json().data;
  assert.equal(precedents.precedents[0].sites, 4);
  assert.equal(precedents.precedents[0].plannedEnrollment, 5);
  assert.equal(precedents.precedents[0].actualEnrollment, 8);
});

test("C2-2 the exemption is by `what` and only three: the study's own people are still hidden wherever they appear", async () => {
  assert.deepEqual([...VCR_PUBLISHED_FIGURE_READS].sort(), ["evidence", "precedents", "trial_registry_record"]);
  // A registry record whose payload carries a study-shaped `counts` still passes untouched under its `what`; any other `what` is judged.
  const smuggling = service({ matching: { async runtimeRead() { return { records: [{ parameter: "x", events: 6, sampleSize: 8 }], counts: { realPatients: 6 } }; } } });
  const answer = (await gatewayRead(smuggling, { what: "matching" })).json().data;
  assert.equal(answer.counts.realPatients, null, "the same numbers under another read are this study's people");
  assert.equal(JSON.stringify(answer).includes("\"events\":6"), false);
});

test("C3-04 a small cohort's size does not leave as a named measure, at any depth, through the real results read", async () => {
  const measured = { ...resultRow, id: "res_2", kind: "population", counts: { realPatients: 3, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [
      { name: "cohort_size", value: 3, source: "observed", note: "3 of 412" },
      { name: "cohort_size_strict", value: 2, source: "observed" },
      { name: "cohort_size_lenient", value: 4, source: "observed" },
      { name: "training_observations", value: 7, source: "observed" },
      { name: "effective_sample_size", value: 5.5, source: "calculated" },
      { name: "hazard_ratio", value: 0.61, interval: { kind: "confidence", low: 0.4, high: 0.9 } },
    ],
    diagnostics: { startingRows: 4, keptRows: 3, waterfall: [{ rule: "确诊", kept: 3, excluded: 1, indeterminate: 0 }, { rule: "既往治疗", kept: 400, excluded: 12, indeterminate: 8 }],
      cohort: { startingRows: 9, keptRows: 8, nested: { measures: [{ name: "cohort_size", value: 6 }] } } } };
  const svc = service();
  svc.store = { ...store, async results() { return [measured]; } };
  const res = await gatewayRead(svc, { what: "results" });
  assert.equal(res.status, 200);
  const body = res.json().data;
  const [result] = body.results;
  const named = Object.fromEntries(result.measures.map((/** @type {any} */ measure) => [measure.name, measure]));
  for (const name of ["cohort_size", "cohort_size_strict", "cohort_size_lenient", "training_observations", "effective_sample_size"]) {
    assert.equal(named[name].value, null, `${name} is a head count under the floor`);
    assert.deepEqual(named[name].suppressed, ["value"]);
  }
  assert.equal(named.cohort_size.note, undefined, "a hidden measure keeps no note that could say the number");
  assert.equal(named.hazard_ratio.value, 0.61, "a measure that is not a head count is untouched");
  assert.equal(result.diagnostics.startingRows, null);
  assert.equal(result.diagnostics.keptRows, null);
  assert.equal(result.diagnostics.cohort.startingRows, null);
  assert.equal(result.diagnostics.cohort.nested.measures[0].value, null, "at any depth");
  const leaked = numbersIn(body).filter((value) => [2, 3, 4, 5.5, 6, 7, 8, 9].includes(value));
  assert.deepEqual(leaked, [], `a head count under the floor left in ${JSON.stringify(body).slice(0, 400)}`);
  assert.equal(result.counts.realPatients, null);
});

test("C3-12 a service without the boundary is a wiring fault: a simulate status is refused, never answered raw", async () => {
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_1" }) };
  const jobs = { async get() { return { id: "job_1", state: "succeeded", method: "design.simulate", progress: {}, cpuSecondsUsed: 1, error: null }; } };
  const gatewayStore = {
    async studyByControlProject() { return study; },
    async one(sql) { return sql.includes("executions") ? { id: "exe_1" } : { checkpoint: {} }; },
    async allResults() { return [resultRow]; },
  };
  const unguarded = { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 } };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" }, runtimeManager,
    { vcr: { service: /** @type {any} */ (unguarded), store: gatewayStore, jobs } });
  const res = response();
  await handler(request("/internal/vcr/v1/simulate", { action: "status", jobId: "job_1" }), res);
  assert.equal(res.status, 503);
  assert.equal(res.json().code, "vcr_gateway_unavailable");
  assert.equal(numbersIn(res.json()).filter((value) => SMALL.includes(value)).length, 0, "the raw answer was not sent");
  assert.equal(res.body.includes("realPatients"), false);
});

test("a value two branches share is stripped of its plane addresses in both, and only a real cycle is refused", async () => {
  const { stripPlaneAddresses } = await import("../src/vcrService.mjs");
  const shared = { name: "population", location: "derived/std_1/population.csv", sha256: "a".repeat(64) };
  const told = /** @type {any} */ (stripPlaneAddresses({ first: shared, second: [shared] }));
  assert.deepEqual(told.first, { name: "population", sha256: "a".repeat(64) });
  assert.deepEqual(told.second, [{ name: "population", sha256: "a".repeat(64) }], "the second branch was not passed through with its address");
  /** @type {any} */
  const cyclic = { a: {} };
  cyclic.a.back = cyclic;
  assert.throws(() => stripPlaneAddresses(cyclic), TypeError);
});
