// The evidence pipeline and the matching flow, end to end on the REAL stores of
// a REAL PostgreSQL, composed the way the control plane composes them
// (`composeVcr`) and driven through the runtime's own write path
// (`vcrRuntimeWrite`) and gateway handler.
//
// Until the merge repair of 2026-09-29 both were libraries production never
// called: the pipeline could not be reached from a tool, and a matching job's
// assessments were computed and dropped. These tests are the proof that a run's
// writes reach the stores, that what it may not write is refused item by item,
// and that the flow's control-plane half (facts → job → assessments →
// referrals → notice) works on the tables it writes to.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr, vcrMatchingExecutor, vcrMatchingSeam } from "../src/vcrComposition.mjs";
import { createVcrGatewayHandler, vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { VCR_SCHEMA } from "../src/vcrPersistence.mjs";
import { deleteVcrStudyRows } from "../src/vcrStoreBase.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { FLAURA } from "./vcrEvidenceFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const AT = "2026-09-28T00:00:00.000Z";
const USER = "u-evm";
const OTHER_USER = "u-evm-other";

/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {ControlPlaneDatabase | null} */
let database = null;
/** @type {any} */
let vcr = null;
/** @type {any} */
let study = null;
/** @type {any} */
let otherStudy = null;
/** @type {any[]} */
const notices = [];
/** Patient documents by id, the way the plane's judged reader answers. */
const DOCUMENTS = new Map([
  ["doc-p1", { subjectKey: "P-001", text: "患者 62 岁。2026-06-28 因急性心梗入院。患者本人可理解研究内容并签署知情同意。", visibleAt: "2026-09-01T00:00:00.000Z" }],
  ["doc-p2", { subjectKey: "P-002", text: "否认心梗史。年龄 45 岁。", visibleAt: "2026-09-01T00:00:00.000Z" }],
]);
const documents = {
  async read(_study, { subjectKey, documentId }) {
    const found = DOCUMENTS.get(documentId);
    return found && found.subjectKey === subjectKey ? { id: documentId, text: found.text, visibleAt: found.visibleAt, subjectKey } : null;
  },
  // The seam's own answer for one subject (`vcrDocumentsSeam.subjectDocuments`): that subject's documents, no text.
  async subjectDocuments(_study, { subjectKey }) {
    return { available: true, documents: [...DOCUMENTS].filter(([, entry]) => entry.subjectKey === subjectKey).map(([id, entry]) => ({ id, visibleAt: entry.visibleAt })) };
  },
};

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrevm");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  const registry = async (url) => {
    // The EU CTIS portal's recorded answers (fixtures/ctis): an unknown number is 200 and an empty object, as on the wire.
    if (String(url).includes("euclinicaltrials.eu")) {
      const known = /\/retrieve\/(2024-513060-26-00)$/.exec(String(url));
      return new Response(known ? readFileSync(new URL(`./fixtures/ctis/retrieve-ended-${known[1]}.json`, import.meta.url), "utf8") : "{}", { status: 200 });
    }
    if (!String(url).includes("NCT02296125")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(FLAURA), { status: 200 });
  };
  vcr = composeVcr({
    config: { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 100_000, vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000,
      vcrDataPlaneDir: "", vcrEngineUrl: "" },
    productDatabase: database, fetchImpl: registry,
  });
  await vcr.store.ready();
  vcr.notifier = { async newCandidates(_study, facts) { notices.push(facts); return true; } };
  study = await vcr.store.createStudy({ userId: USER, projectId: "prj-evm", name: "EV-201 证据与匹配", question: "q", dataTier: "T0" });
  otherStudy = await vcr.store.createStudy({ userId: OTHER_USER, projectId: "prj-evm-other", name: "别人的研究", question: "q", dataTier: "T0" });
});

after(async () => {
  await database?.close?.().catch(() => {});
  if (isolated) await isolated.drop();
});

/** One runtime write, through the real write path with the composed module's ports. @param {string} what @param {any[]} items @param {any} [target] */
function write(what, items, target = study) {
  return vcrRuntimeWrite({
    store: vcr.store, service: vcr.service, orchestrator: null, study: target, what, items,
    evidence: vcr.evidence, evidenceStore: vcr.evidenceStore, matchStore: vcr.matchStore, matching: vcr.matching, seal: null,
    dataPlane: null, documents, report: () => {},
  });
}

/** The request a gateway handler reads. @param {string} url @param {unknown} body */
function request(url, body) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { authorization: "Bearer token" } });
}
function response() {
  return { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}
/** @param {string} operation @param {unknown} body @param {any} [overrides] */
async function gateway(operation, body, overrides = {}) {
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/x" },
    { assertActiveModelGatewayToken: () => ({ userId: USER, projectId: "prj-evm" }) },
    { vcr: { ...vcr, ...overrides } });
  const res = response();
  await handler(request(`/internal/vcr/v1/${operation}`, body), res);
  return res;
}

// ---------------------------------------------------------------------------
// Criteria: the domain's grammar, validated per item, stored where the evaluator reads it
// ---------------------------------------------------------------------------

test("criteria are validated against the domain's grammar per criterion, and the valid ones are written as one protocol version", options, async () => {
  const result = await write("criteria", [{
    title: "EV-201 v1.0",
    criteria: [
      { kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁", sourceLocator: { page: 12 },
        requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
      // The first build's teaching: a `{ field, op: "<=", value }` node, which the evaluator answers 未知 for every patient.
      { kind: "inclusion", criterionType: "performance_status", sourceText: "ECOG 0–1", requirement: { field: "ecog", op: "<=", value: 1 } },
      { kind: "exclusion", criterionType: "time_window", sourceText: "近 6 个月内发生过心肌梗死者除外", sourceLocator: { page: 12 },
        requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
      { kind: "exclusion", criterionType: "pregnancy", sourceText: "妊娠或哺乳期女性除外",
        requirement: { op: "absent", variable: "pregnancy" }, applicability: { op: "compare", variable: "sex", comparator: "in", value: ["female"] } },
      { kind: "inclusion", criterionType: "consent_capacity", sourceText: "能够理解研究内容并签署知情同意书",
        requirement: { op: "language", text: "受试者能够理解研究内容并签署知情同意书", key: "consent" } },
      // A kind that is neither inclusion nor exclusion is refused, not coerced into an inclusion.
      { kind: "maybe", criterionType: "other", sourceText: "x", requirement: { op: "present", variable: "x" } },
      // A field outside the criterion's closed list is refused by name.
      { kind: "inclusion", criterionType: "other", sourceText: "y", requirement: { op: "present", variable: "y" }, weight: 3 },
    ],
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.ids.length, 1, "one protocol version, not one per criterion");
  const byField = Object.fromEntries(result.issues.map((issue) => [issue.field, issue.code]));
  assert.equal(byField["criteria[1].requirement"], "vcr_criterion_malformed", "the old grammar is refused per item, the rest written");
  assert.equal(byField["criteria[5].kind"], "vcr_write_value_invalid");
  assert.equal(byField["criteria[6].weight"], "vcr_write_field_forbidden");
  assert.equal(result.issues.length, 3);
  assert.equal(result.results[0].refused, 3);
  assert.match(result.results[0].note, /整套再写一次/, "the run is told a corrected write carries the whole set");

  const criteria = await vcr.matchStore.listCriteria({ studyId: study.id });
  assert.deepEqual(criteria.map((criterion) => criterion.sourceText), ["年龄 ≥ 18 岁", "近 6 个月内发生过心肌梗死者除外", "妊娠或哺乳期女性除外", "能够理解研究内容并签署知情同意书"]);
  const pregnancy = criteria.find((criterion) => criterion.criterionType === "pregnancy");
  assert.deepEqual(pregnancy.applicability, { op: "compare", variable: "sex", comparator: "in", value: ["female"] }, "applicability is stored where the evaluator reads it");
  assert.equal(Object.hasOwn(pregnancy.requirement, "applicability"), false, "and never inside the requirement, which the grammar would refuse on the way back in");
  assert.equal(criteria.find((criterion) => criterion.criterionType === "demographic").sourceLocator.page, 12);

  // A second write is version 2, and the default reading is the latest version only.
  const second = await write("criteria", [{ criteria: [{ kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 20 岁",
    requirement: { op: "compare", variable: "age", comparator: "gte", value: 20 } }] }]);
  assert.equal(second.ok, true);
  const latest = await vcr.matchStore.listCriteria({ studyId: study.id });
  assert.deepEqual(latest.map((criterion) => criterion.sourceText), ["年龄 ≥ 20 岁"], "matching evaluates against the latest protocol by default");
  const all = await vcr.matchStore.listCriteria({ studyId: study.id, allVersions: true });
  assert.equal(all.length, 5, "and the earlier version is still there (AC-05)");
  const seen = await vcr.service.runtimeRead(study, "criteria", {});
  assert.equal(seen.protocol.version, 2);
  assert.equal(seen.criteria[0].applicability, null);
  // The whole batch of one item that has no valid criterion writes nothing.
  const none = await write("criteria", [{ criteria: [{ kind: "inclusion", criterionType: "other", sourceText: "z", requirement: { free_text: "x" } }] }]);
  assert.equal(none.ok, false);
  assert.equal(none.issues[0].code, "vcr_criterion_malformed");
});

test("the protocol write takes the same grammar and the same one-version rule: this is the protocol the matching tests below read", options, async () => {
  const written = await write("protocol", [{ title: "EV-201 修订", criteria: [
    { kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
    { kind: "exclusion", criterionType: "time_window", sourceText: "近 6 个月内发生过心肌梗死者除外", requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
    { kind: "exclusion", criterionType: "pregnancy", sourceText: "妊娠或哺乳期女性除外", requirement: { op: "absent", variable: "pregnancy" },
      applicability: { op: "compare", variable: "sex", comparator: "in", value: ["female"] } },
    { kind: "inclusion", criterionType: "consent_capacity", sourceText: "能够理解研究内容并签署知情同意书",
      requirement: { op: "language", text: "受试者能够理解研究内容并签署知情同意书", key: "consent" } },
    { kind: "inclusion", criterionType: "diagnosis", sourceText: "x", requirement: { op: "compare", variable: "Stage", comparator: "eq", value: "IV" } },
  ] }]);
  assert.equal(written.ok, true);
  assert.deepEqual(written.issues.map((issue) => [issue.field, issue.code]), [["criteria[4].requirement", "vcr_criterion_malformed"]]);
  const criteria = await vcr.matchStore.listCriteria({ studyId: study.id });
  assert.equal(criteria.length, 4);
  assert.deepEqual(await vcr.matching.languageKeys(study), ["consent"]);
});

// ---------------------------------------------------------------------------
// Assumptions: a key the lineage can carry, and no number a run typed into a card of the literature
// ---------------------------------------------------------------------------

test("an assumption key is a name the lineage can carry, refused by name otherwise; a distribution is checked, not trusted", options, async () => {
  const result = await write("assumption", [
    { key: "dropout_rate", name: "脱落率", pointValue: 0.12, unit: "", sourceKind: "expert_set", distribution: { family: "beta", params: { alpha: 3, beta: 20 } } },
    { key: "Dropout Rate", name: "x", pointValue: 1 },
    { key: "9lives", name: "x", pointValue: 1 },
    { key: "a".repeat(65), name: "x", pointValue: 1 },
    { key: "hr_typed", name: "x", pointValue: 0.61, sourceKind: "external_evidence", evidenceIds: ["evd_invented"], parameter: "hazard_ratio" },
    { key: "dist_bad", name: "x", pointValue: 1, distribution: { family: "weibull-ish" } },
    { key: "dist_nan", name: "x", pointValue: 1, distribution: { family: "normal", params: { mean: "abc" } } },
    { key: "value_source_typed", name: "x", pointValue: 1, valueSource: "observed" },
  ]);
  assert.equal(result.ids.length, 1);
  const byIndex = Object.fromEntries(result.issues.map((issue) => [issue.index, `${issue.field}:${issue.code}`]));
  assert.match(byIndex[1], /^key:vcr_write_value_invalid$/);
  assert.match(byIndex[2], /^key:/);
  assert.match(byIndex[3], /^key:/);
  assert.match(byIndex[4], /^(evidenceIds|pointValue|distribution):/, "an external_evidence card cannot carry a number the run typed");
  assert.equal(result.issues.filter((issue) => issue.index === 4)[0].code, "vcr_write_field_forbidden");
  assert.match(byIndex[5], /^distribution\.family:/);
  assert.match(byIndex[6], /^distribution\.params\.mean:/);
  assert.match(byIndex[7], /^valueSource:/, "a run cannot label its own number as observed");
  const cards = await vcr.store.assumptions(study.id);
  assert.deepEqual(cards.map((card) => card.key), ["dropout_rate"]);
  assert.equal(cards[0].reviewState, "ai_set");
  assert.equal(cards[0].valueSource, "assumed");
});

test("PA-14 a model-typed number cannot enter through a write at any depth: population, grid, forecast and comparator", options, async () => {
  const population = await write("population", [
    { kind: "real", name: "队列", waterfall: [{ step: "a", kept: 4 }] },
    { kind: "real", name: "队列", profile: { levels: {} } },
    { kind: "real", name: "队列", definition: { rules: [{ name: "r", counts: { kept: 3 } }] } },
    { kind: "literature", name: "文献人群", definition: { note: "ok" } },
  ]);
  assert.equal(population.ids.length, 1);
  assert.deepEqual(population.issues.map((issue) => [issue.index, issue.code]), [[0, "vcr_write_field_forbidden"], [1, "vcr_write_field_forbidden"], [2, "vcr_write_field_forbidden"]]);
  assert.equal(population.issues[2].field, "definition.rules[0].counts", "a forbidden key is found at any depth");
  const grid = await write("design_grid", [{ dimensions: { n: [100, 200] }, cells: [{ power: 0.9 }] }, { dimensions: { n: [100, 200] }, truthScenarios: [{ label: "null", isNull: true }] }]);
  assert.equal(grid.ids.length, 1);
  assert.equal(grid.issues[0].field, "cells");
  const forecast = await write("forecast", [{ kind: "accrual", prediction: { last_patient_in_months: 14 } }, { kind: "accrual", resultId: "res_of_someone_else" }]);
  assert.equal(forecast.ids.length, 0);
  assert.deepEqual(forecast.issues.map((issue) => issue.field), ["prediction", "resultId"], "a forecast is registered from a saved result of this study, never from a number typed");
  assert.deepEqual(forecast.issues.map((issue) => issue.code), ["vcr_write_field_forbidden", "vcr_write_value_invalid"],
    "a typed number is a forbidden field; a result that is not this study's is an invalid value — resultId itself is a field a forecast takes");
  const comparator = await write("comparator", [{ route: "literature_control", estimand: "ATT", configuration: { tau: 24 } }, { route: "external_control", configuration: { measures: [] } }]);
  assert.equal(comparator.ids.length, 1);
  assert.equal(comparator.issues[0].field, "configuration.measures");
});

test("AC-23 a forecast is registered from a saved result of this study: its measures are the result's own, and a version is a new row", options, async () => {
  const saved = await vcr.store.recordResult({
    studyId: study.id, userId: USER, kind: "trial_scenario", conclusion: "estimable",
    counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [{ name: "last_patient_in_months", value: 14.2, simulated: true, mcse: 0.05, interval: { kind: "prediction", low: 11, high: 18 } }],
    models: [], requestedUse: "exploratory",
  });
  const foreign = await vcr.store.recordResult({
    studyId: otherStudy.id, userId: OTHER_USER, kind: "trial_scenario", conclusion: "estimable",
    counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [{ name: "last_patient_in_months", value: 99, simulated: true, mcse: 0.05 }], models: [], requestedUse: "exploratory",
  });
  const first = await write("forecast", [{ kind: "accrual", resultId: saved.id }]);
  assert.equal(first.ok, true, JSON.stringify(first.issues));
  const [registered] = await vcr.store.forecasts(study.id);
  assert.match(registered.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(registered.version, 1);
  assert.equal(registered.actual, null, "registered before the outcome exists");
  assert.equal(registered.prediction.resultId, saved.id);
  assert.equal(registered.prediction.measures[0].value, 14.2, "the prediction is the saved result's own measure, never a number the run typed");

  const again = await write("forecast", [{ kind: "accrual", resultId: saved.id }]);
  assert.equal(again.ok, true);
  assert.deepEqual((await vcr.store.forecasts(study.id)).map((row) => row.version).sort(), [1, 2], "a change is a new version; the first stands");
  assert.ok((await vcr.store.forecasts(study.id)).every(row => row.public === false), 'The first release retains private forecasts only.');

  const refused = await write("forecast", [
    { kind: "accrual", resultId: foreign.id },
    { kind: "accrual", resultId: saved.id, prediction: { last_patient_in_months: 1 } },
    { kind: "accrual", resultId: { nested: 1 } },
    { kind: "accrual", resultId: saved.id, public: "yes" },
    { kind: "accrual" },
  ], study);
  assert.equal(refused.ids.length, 0);
  assert.deepEqual(refused.issues.map((issue) => [issue.index, issue.field, issue.code]), [
    [0, "resultId", "vcr_write_value_invalid"],
    [1, "prediction", "vcr_write_field_forbidden"],
    [2, "resultId", "vcr_write_field_forbidden"],
    [3, "public", "vcr_write_field_forbidden"],
    [4, "resultId", "vcr_write_value_invalid"],
  ]);
});

test("CS-37 a reference to an id that is not this study's is refused, and a database error is one item's issue, not a failed batch", options, async () => {
  const foreignSnapshot = await write("population", [{ kind: "real", name: "队列", snapshotId: "snp_of_another_study" }]);
  assert.equal(foreignSnapshot.ok, false);
  assert.equal(foreignSnapshot.issues[0].field, "snapshotId");
  // A patient set that names a population of another study.
  const foreign = await vcr.store.savePopulation({ studyId: otherStudy.id, userId: OTHER_USER, name: "别人的人群", kind: "literature", definition: {}, reviewState: "ai_set" });
  const patient = await write("patient_set", [{ populationId: foreign.id, name: "x" }, { name: "ok", modelId: "reference-time-to-event" }]);
  assert.equal(patient.issues.length >= 1, true);
  assert.equal(patient.issues[0].field, "populationId");
  // An invalid enum is refused, not coerced.
  const scenario = await write("trial_scenario", [{ label: "A", design: "two_arm_fixed", endpointType: "time_to_event" }, { label: "B", design: "two_arm_fixed", endpointType: "ordinal" },
    { label: "C", design: "two_arm_fixed", endpointType: "binary", comparatorId: foreign.id }]);
  assert.equal(scenario.ids.length, 1);
  assert.deepEqual(scenario.issues.map((issue) => [issue.index, issue.field]), [[1, "endpointType"], [2, "comparatorId"]]);
  // An item the store itself refuses (a version collision the constraint names) is that item's issue.
  /** @type {string[]} */
  const reported = [];
  const flaky = {
    ...vcr.store,
    savePopulation: async (input) => {
      if (input.name === "boom") throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return vcr.store.savePopulation(input);
    },
  };
  const outcome = await vcrRuntimeWrite({ store: /** @type {any} */ (flaky), service: vcr.service, orchestrator: null, study, what: "population",
    items: [{ kind: "literature", name: "boom" }, { kind: "literature", name: "fine" }], evidence: null, evidenceStore: null, matchStore: null,
    report: (code) => reported.push(code) });
  assert.equal(outcome.ids.length, 1, "the other item was written");
  assert.equal(outcome.issues[0].code, "vcr_write_refused");
  assert.deepEqual(reported, ["40P01"], "the SQLSTATE goes to the operator, not to the run");
  assert.equal(JSON.stringify(outcome.issues).includes("deadlock"), false);
});

// ---------------------------------------------------------------------------
// Evidence: the precedent, the verified value, the pool, the card
// ---------------------------------------------------------------------------

test("a precedent is fetched, its values verified in code, and a run's own reading is checked against the preserved record", options, async () => {
  const fetched = await write("precedent", [
    { registryId: "NCT02296125", endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
      armRoles: { "SoC EGFR-TKI (Global Cohort)": "control", "Osimertinib 80 mg (Global Cohort)": "treatment" }, line: "first", biomarker: "egfr_positive" },
    { registryId: "NCT00000000" },
    { registryId: "not a number" },
    { registryId: "NCT02296125", armRoles: { "x": "sponsor" } },
  ]);
  assert.equal(fetched.ids.length, 1);
  assert.equal(fetched.results[0].verified, fetched.results[0].extracted, "every value the client copied passes its own check");
  assert.deepEqual(fetched.issues.map((issue) => [issue.index, issue.code]), [[1, "registry_not_found"], [2, "vcr_write_value_invalid"], [3, "vcr_write_value_invalid"]]);

  // The precedent belongs to the account's library and to this study's use of it.
  const [precedent] = await vcr.evidenceStore.listPrecedents({ userId: USER, studyId: study.id });
  assert.equal(precedent.registry_id, "NCT02296125");
  assert.equal((await vcr.evidenceStore.getPrecedent(USER, precedent.id, { withText: true })).record_text.includes("enrollmentInfo.count: 674"), true);
  assert.equal((await vcr.evidenceStore.listPrecedents({ userId: USER })).every((row) => row.record_text === undefined), true, "a list never carries the preserved text");

  // A run's own reading of the same record: verified in code against it.
  const quote = "protocolSection.designModule.enrollmentInfo.count: 674";
  const item = await write("evidence_item", [
    { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 674, unit: "participants", quote, endpointKey: "enrollment", historicalBaseline: true },
    { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 999, unit: "participants", quote, endpointKey: "enrollment" },
    { registryId: "NCT02296125", parameter: "enrollment_actual", armRole: "overall", value: 674, quote: "enrolment was 674", endpointKey: "enrollment" },
    { registryId: "NCT02296125", parameter: "x", armRole: "sponsor", value: 1, quote },
    { registryId: "NCT02296125", parameter: "x", armRole: "overall", value: 1, quote, verification: "verified" },
    { registryId: "NCT11111111", parameter: "x", armRole: "overall", value: 1, quote },
  ]);
  assert.deepEqual(item.results.map((entry) => [entry.index, entry.verified, entry.state]), [[0, true, "verified"], [1, false, "quote_missing_number"], [2, false, "quote_not_found"]]);
  assert.deepEqual(item.issues.filter((issue) => issue.code === "vcr_evidence_unverified").map((issue) => issue.index), [1, 2]);
  assert.equal(item.issues.some((issue) => issue.index === 3 && issue.field === "armRole"), true);
  assert.equal(item.issues.some((issue) => issue.index === 4 && issue.field === "verification" || issue.code === "vcr_write_field_forbidden"), true, "a run cannot write the verdict of its own check");
  assert.equal(item.issues.some((issue) => issue.index === 5 && issue.field === "registryId"), true, "a record the study does not hold has nothing to be checked against");
  const rows = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "enrollment_actual" });
  assert.equal(rows.filter((row) => row.locator?.authoredBy === "run" && row.value !== null).length, 1, "only the verified reading has a number in the table");
  assert.equal(rows.find((row) => row.locator?.authoredBy === "run" && row.locator.verification !== "verified").value, null);
});

test("CS-4 a precedent is the account's: a second study using it does not re-point it, and deleting a study leaves what another uses", options, async () => {
  const second = await vcr.store.createStudy({ userId: USER, projectId: "prj-evm-2", name: "第二个研究", question: "q", dataTier: "T0" });
  const first = (await vcr.evidenceStore.listPrecedents({ userId: USER, studyId: study.id }))[0];
  const fetched = await write("precedent", [{ registryId: "NCT02296125" }], second);
  assert.equal(fetched.ids.length, 1);
  assert.equal(fetched.ids[0], first.id, "the same record is the same row, whoever fetches it");
  const row = await vcr.evidenceStore.getPrecedent(USER, first.id);
  assert.equal(row.study_id, study.id, "the first study still owns the row; the second only uses it");
  assert.equal((await vcr.evidenceStore.listPrecedents({ userId: USER, studyId: second.id })).length, 1);
  assert.equal((await vcr.evidenceStore.listPrecedents({ userId: USER, studyId: study.id })).length, 1);
  // Deleting the second study takes its use and its evidence rows and leaves the library and the first study's evidence.
  const before = (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id })).length;
  await database.transaction((client) => deleteVcrStudyRows(client, second.id));
  assert.equal((await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id })).length, before);
  assert.equal((await vcr.evidenceStore.getPrecedent(USER, first.id)).registry_id, "NCT02296125");
  // And deleting the first study — the row's own study — leaves the record another study might use.
  const third = await vcr.store.createStudy({ userId: USER, projectId: "prj-evm-3", name: "第三个", question: "q", dataTier: "T0" });
  await write("precedent", [{ registryId: "NCT02296125" }], third);
  await database.transaction((client) => deleteVcrStudyRows(client, third.id));
  assert.equal((await vcr.evidenceStore.getPrecedent(USER, first.id)).registry_id, "NCT02296125");
});

test("CS-26 the pool reads the latest row per (precedent, parameter, arm, endpoint key), one arm role, and refuses an empty endpoint key", options, async () => {
  await write("precedent", [{ registryId: "NCT02296125", endpointKeys: { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
    armRoles: { "SoC EGFR-TKI (Global Cohort)": "control", "Osimertinib 80 mg (Global Cohort)": "treatment" } }]);
  const all = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time" });
  const latest = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", latestOnly: true, verifiedOnly: true });
  assert.ok(all.length > latest.length, "the ledger keeps every attempt, the pool reads the newest of each");
  assert.equal(latest.length, 2, "the two arms, once each");
  assert.deepEqual(latest.map((row) => row.arm_role).sort(), ["control", "treatment"]);
  const noKey = await vcr.evidence.poolParameter({ userId: USER, studyId: study.id, parameter: "median_time", endpointKey: "", target: {} });
  assert.equal(noKey.code, "vcr_pool_endpoint_key_required");
  const asked = [];
  const queue = { enqueue: async (input) => { asked.push(input); return { job: { id: `job_${asked.length}`, state: "queued" }, created: true }; } };
  const pooled = await createPipeline(queue).poolParameter({ userId: USER, studyId: study.id, parameter: "median_time", endpointKey: "pfs-blinded", target: {} });
  assert.equal(pooled.status, "queued");
  assert.equal(asked[0].scenario.studies.length, 1, "one control arm of one trial");
  assert.equal(asked[0].scenario.studies[0].studyId, latest.find((row) => row.arm_role === "control").id);
});

/** The evidence pipeline over the real stores and a queue double. @param {any} jobs */
function createPipeline(jobs) {
  return createVcrEvidencePipeline({ store: vcr.evidenceStore, registry: vcr.registry, jobs, now: () => new Date(AT) });
}

test("E-11 two saves of one assumption card at once serialize instead of colliding on the version", options, async () => {
  const saves = await Promise.all(Array.from({ length: 6 }, (_, index) => vcr.evidenceStore.saveAssumption({
    userId: USER, studyId: study.id, card: { key: "race_card", name: "竞态", pointValue: index, sourceKind: "expert_set", valueSource: "assumed", distribution: {}, sensitivity: {}, evidenceIds: [], applicability: {}, reviewState: "ai_set" },
  })));
  assert.deepEqual(saves.map((row) => row.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], "six writers, six versions, no unique-violation");
  assert.equal((await vcr.evidenceStore.latestAssumption({ studyId: study.id, key: "race_card" })).version, 6);
});

test("AC-25 an assumption of external evidence must cite the ids verifiedEvidenceIds returns, and takes its number from the row, never from the run", options, async () => {
  // The two arms' rows are written in the same instant and sorted by their random ids, so which
  // comes first is chance: the control arm is asked for by name.
  const control = (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", latestOnly: true, verifiedOnly: true }))
    .find((row) => row.arm_role === "control");
  assert.ok(control);
  const typed = await write("assumption", [{ key: "pfs_ctl", name: "对照 PFS", sourceKind: "external_evidence", parameter: "median_time", evidenceIds: [control.id], pointValue: 99 }]);
  assert.equal(typed.ok, false);
  assert.equal(typed.issues[0].code, "vcr_write_field_forbidden", "a number typed beside the citation is refused, not overwritten quietly");
  const invented = await write("assumption", [{ key: "pfs_ctl", name: "对照 PFS", sourceKind: "external_evidence", parameter: "median_time", evidenceIds: ["evd_not_a_row"] }]);
  assert.equal(invented.issues[0].code, "vcr_evidence_unverified");
  const otherStudyRow = (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id }))[0];
  const crossStudy = await write("assumption", [{ key: "pfs_ctl", name: "x", sourceKind: "external_evidence", parameter: otherStudyRow.parameter, evidenceIds: [otherStudyRow.id] }], otherStudy);
  assert.equal(crossStudy.issues[0].code, "vcr_evidence_unverified", "another study's evidence is not this study's");
  const many = await write("assumption", [{ key: "pfs_ctl", name: "x", sourceKind: "external_evidence", parameter: "median_time",
    evidenceIds: (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", verifiedOnly: true })).slice(0, 2).map((row) => row.id) }]);
  assert.match(many.issues[0].message, /fromPooling/, "several values are the engine's to pool, and the run is told so");
  const ok = await write("assumption", [{ key: "pfs_ctl", name: "对照 PFS", unit: "月", sourceKind: "external_evidence", parameter: "median_time", evidenceIds: [control.id] }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  const card = await vcr.evidenceStore.latestAssumption({ studyId: study.id, key: "pfs_ctl" });
  assert.equal(Number(card.point_value), Number(control.value), "the number is the verified row's");
  assert.deepEqual(card.evidence_ids, [control.id]);
  assert.equal(card.value_source, "extracted");
  assert.equal(card.review_state, "ai_set");
});

test("simulate pool_evidence builds the engine job from this study's verified extractions, and the status carries the platform's reading of the result", options, async () => {
  // Three trials' worth of control-arm values, verified rows written the way a run's reading is.
  const quote = (field, value) => `resultsSection.outcomeMeasuresModule.outcomeMeasures[0].classes[0].categories[0].measurements[0].${field}: ${value}`;
  void quote;
  const queued = await gateway("simulate", { action: "start", kind: "pool_evidence", scenario: { parameter: "median_time", endpointKey: "pfs-blinded" } });
  assert.equal(queued.status, 200, queued.body);
  const data = queued.json().data;
  assert.ok(data.jobId, JSON.stringify(data));
  const job = await vcr.jobs.get(study.id, data.jobId);
  assert.equal(job.kind, "pool_evidence");
  const row = await vcr.store.one(`SELECT scenario, inputs, checkpoint FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [data.jobId]);
  assert.deepEqual(Object.keys(row.scenario).sort(), ["level", "method", "scale", "studies"]);
  assert.equal(row.checkpoint.armRole, "control");
  assert.match(row.checkpoint.subjectId, /^pool:median_time:pfs-blinded:control:/);
  assert.deepEqual(row.inputs.map((input) => input.kind), Array(row.inputs.length).fill("evidence"));

  // What a run may not say in a pool request.
  const smuggled = await gateway("simulate", { action: "start", kind: "pool_evidence", scenario: { parameter: "median_time", endpointKey: "pfs-blinded", studies: [{ studyId: "x", estimate: 1, se: 0.1 }] } });
  assert.equal(smuggled.status, 400);
  assert.equal(smuggled.json().code, "vcr_simulate_payload_invalid");
  const keyless = await gateway("simulate", { action: "start", kind: "pool_evidence", scenario: { parameter: "median_time" } });
  assert.equal(keyless.status, 400);
  const nothing = await gateway("simulate", { action: "start", kind: "pool_evidence", scenario: { parameter: "hazard_ratio", endpointKey: "os" } });
  assert.equal(nothing.json().data.state, "not_started", "no verified extraction of a parameter is no pool, said plainly");
  assert.equal(nothing.json().data.reason, "no_evidence");
});

test("C2-14 a newer hand-entered row that failed its check never supersedes a verified extraction, and the pool names every study it left out", options, async () => {
  const CONTROL = "SoC EGFR-TKI (Global Cohort)";
  const before = (await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", latestOnly: true, verifiedOnly: true }))
    .find((row) => row.arm === CONTROL && row.endpoint_key === "pfs-blinded");
  assert.ok(before, "the registry extraction of the control arm's median is verified");
  // A run types a number for the same precedent, arm and endpoint; its quotation is not in the record.
  const typed = await write("evidence_item", [{ registryId: "NCT02296125", parameter: "median_time", arm: CONTROL, armRole: "control", endpointKey: "pfs-blinded",
    value: 14.2, unit: "months", quote: "Median PFS was 14.2 months" }]);
  assert.equal(typed.issues.some((entry) => entry.code === "vcr_evidence_unverified"), true, "the typed value failed its check");
  const all = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time" });
  const failed = all.filter((row) => row.locator?.authoredBy === "run" && row.locator.verification !== "verified");
  assert.ok(failed.length >= 1 && failed[failed.length - 1].created_at >= before.created_at, "the failed attempt is newer than the verified extraction");

  // The newest row of that key that counts is still the verified extraction, verified filter or not.
  for (const verifiedOnly of [true, false]) {
    const latest = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", latestOnly: true, verifiedOnly });
    const control = latest.filter((row) => row.arm === CONTROL && row.endpoint_key === "pfs-blinded");
    assert.equal(control.length, 1, `one row for the key (verifiedOnly ${verifiedOnly})`);
    assert.equal(control[0].id, before.id, `the verified extraction stands (verifiedOnly ${verifiedOnly})`);
    assert.equal(control[0].value === null, false);
  }
  // Where only a failed hand-entered row exists for a key, it is that key's newest and is read as such.
  await write("evidence_item", [{ registryId: "NCT02296125", parameter: "dropout_rate", armRole: "control", endpointKey: "dropout-any", value: 12, unit: "人", quote: "twelve withdrew" }]);
  const alone = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "dropout_rate", latestOnly: true });
  assert.equal(alone.filter((row) => row.endpoint_key === "dropout-any").length, 1);
  assert.equal(alone.find((row) => row.endpoint_key === "dropout-any").locator.verification === "verified", false);

  // The pool takes the verified extraction in, and reports every row it refused with the reason — the unverified ones included.
  const asked = [];
  const queue = { enqueue: async (input) => { asked.push(input); return { job: { id: `job_pool_${asked.length}`, state: "queued" }, created: true }; } };
  const pooled = await createPipeline(queue).poolParameter({ userId: USER, studyId: study.id, parameter: "median_time", endpointKey: "pfs-blinded", target: {} });
  assert.equal(pooled.status, "queued");
  assert.ok(asked.length >= 1);
  assert.equal(asked[0].scenario.studies.some((entry) => entry.studyId === before.id), true, "the control arm's verified extraction is one of the pooled studies");
  const noDropout = await createPipeline(queue).poolParameter({ userId: USER, studyId: study.id, parameter: "dropout_rate", endpointKey: "dropout-any", target: {} });
  assert.equal(noDropout.status, "no_evidence");
  assert.ok(noDropout.refused.some((entry) => entry.reasons.includes("quote_not_verified")), "an unverified study is refused by name, not dropped without a trace");
});

test("C2-14 a single-study card takes only the arm its parameter needs: a control-arm median is not the treatment arm's", options, async () => {
  const rows = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "median_time", latestOnly: true, verifiedOnly: true });
  const treatment = rows.find((row) => row.arm_role === "treatment");
  const control = rows.find((row) => row.arm_role === "control");
  assert.ok(treatment && control);
  const wrongArm = await write("assumption", [{ key: "pfs_ctl_wrong", name: "对照 PFS", sourceKind: "external_evidence", parameter: "median_time", evidenceIds: [treatment.id] }]);
  assert.equal(wrongArm.ok, false);
  assert.equal(wrongArm.issues[0].field, "evidenceIds");
  assert.match(wrongArm.issues[0].message, /treatment.*control/, "the run is told which arm the parameter needs");
  assert.equal(await vcr.evidenceStore.latestAssumption({ studyId: study.id, key: "pfs_ctl_wrong" }), null, "nothing was written");
  const right = await write("assumption", [{ key: "pfs_ctl_right", name: "对照 PFS", sourceKind: "external_evidence", parameter: "median_time", evidenceIds: [control.id] }]);
  assert.equal(right.ok, true, JSON.stringify(right.issues));
});

test("what the package skill tells a run to write on the cover is in what the reads return: the study's ceiling is the page's own, with its reasons", options, async () => {
  const skill = await readFile(new URL("../../../capabilities/vcr-package/SKILL.md", import.meta.url), "utf8");
  for (const field of ["intendedUseCeiling", "useDowngrade", "intendedUse"]) assert.ok(skill.includes(field), `the skill names ${field}`);
  const read = await vcr.service.runtimeRead(study, "study", {});
  const page = await vcr.service.studyView({ id: USER }, study.id);
  assert.deepEqual(read.intendedUseCeiling, page.ceiling, "the run reads the ceiling the page shows, not a second computation of it");
  assert.deepEqual(Object.keys(read.intendedUseCeiling).sort(), ["ceiling", "reasons", "requested", "withinCeiling"]);
  assert.ok(read.intendedUseCeiling.reasons.every((reason) => reason.code && reason.detail), "and it says why");
  const recorded = await vcr.store.recordResult({
    studyId: study.id, userId: USER, kind: "trial_scenario", conclusion: "estimable", counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [{ name: "power", value: 0.8, simulated: true, mcse: 0.01 }], models: [], requestedUse: "exploratory",
  });
  const results = await vcr.service.runtimeRead(study, "results", {});
  const mine = results.results.find((entry) => entry.id === recorded.id);
  for (const field of ["intendedUse", "useDowngrade"]) assert.ok(field in mine, `each result carries ${field}`);
});

// ---------------------------------------------------------------------------
// The matching flow: facts and judgments in, assessments, referrals and a notice out
// ---------------------------------------------------------------------------

/** @param {string} text @param {string} quote */
const span = (text, quote) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });

test("a fact is verified in code against the data-plane copy of its document, with the platform's own clock as the floor of its visibility", options, async () => {
  const chart = DOCUMENTS.get("doc-p1").text;
  const mi = "2026-06-28 因急性心梗入院";
  const good = { subjectKey: "P-001", variable: "myocardial_infarction", polarity: "affirmed", occurredAt: "2026-06-28T00:00:00Z", visibleAt: "2026-09-02T00:00:00Z",
    surface: "急性心梗", documentId: "doc-p1", ...span(chart, mi), quote: mi };
  const age = { subjectKey: "P-001", variable: "age", value: 62, unit: "year", polarity: "affirmed", surface: "62 岁", documentId: "doc-p1", ...span(chart, "患者 62 岁"), quote: "患者 62 岁" };
  const result = await write("fact", [
    good, age,
    { ...good, variable: "other", quote: "2026-06-28 因慢性心衰入院" },
    { ...good, variable: "other2", value: 3, ...span(chart, "患者 62 岁"), quote: "患者 62 岁", surface: "62 岁" },
    { ...good, subjectKey: "P-002" },
    { ...good, variable: "early", visibleAt: "2026-08-01T00:00:00Z" },
    { ...good, variable: "UPPER" },
    { ...good, extractedBy: "code" },
    { ...good, variable: "ok_again" },
  ]);
  assert.deepEqual(result.ids.length, 3, `written: ${JSON.stringify(result.issues)}`);
  const fields = Object.fromEntries(result.issues.map((issue) => [issue.index, issue.field]));
  assert.equal(fields[2], "documentId", "a quotation the document does not carry is void");
  assert.equal(result.issues.find((issue) => issue.index === 2).code, "vcr_evidence_unverified");
  assert.equal(result.issues.find((issue) => issue.index === 3).code, "vcr_evidence_unverified", "a value that is not printed in the span is void");
  assert.equal(fields[4], "documentId", "a document of another subject is not found");
  assert.equal(fields[5], "visibleAt", "a fact cannot have been visible before its document");
  assert.equal(fields[6], "variable");
  assert.equal(fields[7], "extractedBy", "extractedBy is set in code, not by the run");
  const again = await write("fact", [good]);
  assert.equal(again.ok, true);
  assert.equal(again.ids[0], result.ids[0], "the same located fact written twice is one fact");
  const facts = await vcr.matchStore.listFacts({ studyId: study.id, subjectKey: "P-001" });
  assert.equal(facts.every((fact) => fact.extractedBy === "model"), true);
  assert.equal((await vcr.matchStore.listFacts({ studyId: study.id, visibleBy: "2026-08-31T00:00:00Z" })).length, 0, "nothing is visible before it was");
  assert.equal((await vcr.matchStore.listFacts({ studyId: study.id, visibleBy: "2026-09-01T12:00:00Z" })).length, 1, "the fact with no time of its own is visible when its document was");
  // Another study cannot see these facts, and a run of another study cannot write against this one's documents by naming them.
  assert.equal((await vcr.matchStore.listFacts({ studyId: otherStudy.id })).length, 0);
});

test("a run that cannot count characters may leave the offsets out: the platform finds a quotation that occurs once, and asks for an offset when it occurs twice", options, async () => {
  const unique = await write("fact", [{ subjectKey: "P-001", variable: "admission_reason", polarity: "affirmed", surface: "急性心梗", documentId: "doc-p1", quote: "因急性心梗入院" }]);
  assert.equal(unique.ok, true, JSON.stringify(unique.issues));
  const [stored] = (await vcr.matchStore.listFacts({ studyId: study.id, subjectKey: "P-001" })).filter((fact) => fact.variable === "admission_reason");
  const chart = DOCUMENTS.get("doc-p1").text;
  assert.equal(chart.slice(stored.source.start, stored.source.end), "因急性心梗入院", "the offsets in the ledger are the platform's, and exact");
  const twice = await write("fact", [
    { subjectKey: "P-001", variable: "twice", surface: "患者", documentId: "doc-p1", quote: "患者" },
    { subjectKey: "P-001", variable: "absent", surface: "无此句", documentId: "doc-p1", quote: "无此句" },
    { subjectKey: "P-001", variable: "half", surface: "急性心梗", documentId: "doc-p1", start: 3, quote: "急性心梗" },
    { subjectKey: "P-001", variable: "wrong_offset", surface: "急性心梗", documentId: "doc-p1", start: 0, end: 4, quote: "急性心梗" },
  ]);
  assert.equal(twice.ids.length, 0);
  assert.match(twice.issues[0].message, /不止一次（起点 \d+、\d+）/);
  assert.equal(twice.issues[1].code, "vcr_evidence_unverified");
  assert.equal(twice.issues[2].field, "end");
  assert.equal(twice.issues[3].code, "vcr_evidence_unverified");
});

test("a language-only criterion is answered with anchored evidence, for a key the protocol actually has", options, async () => {
  const chart = DOCUMENTS.get("doc-p1").text;
  const sentence = "患者本人可理解研究内容并签署知情同意";
  const anchored = [{ documentId: "doc-p1", ...span(chart, sentence), quote: sentence }];
  const result = await write("language_judgment", [
    { subjectKey: "P-001", criterionKey: "consent", state: "satisfied", evidence: anchored },
    { subjectKey: "P-001", criterionKey: "nonexistent", state: "satisfied", evidence: anchored },
    { subjectKey: "P-001", criterionKey: "consent", state: "satisfied", evidence: [] },
    { subjectKey: "P-001", criterionKey: "consent", state: "satisfied", evidence: [{ documentId: "doc-p1", start: 0, end: 4, quote: "无法理解" }] },
    { subjectKey: "P-001", criterionKey: "consent", state: "maybe", evidence: anchored },
  ]);
  assert.equal(result.ids.length, 1, JSON.stringify(result.issues));
  assert.deepEqual(result.issues.map((issue) => issue.index), [1, 2, 3, 4]);
  assert.match(result.issues[0].message, /language/);
  const stored = await vcr.matchStore.latestLanguageJudgments({ studyId: study.id });
  assert.equal(stored.get("P-001").consent.state, "satisfied");
});

test("the flow: the platform freezes the protocol and the instant, a job evaluates what the study holds, and the finish persists assessments, makes candidates referrals and tells the coordinators", options, async () => {
  // P-002 has a document with a denial of MI and an age.
  const chart = DOCUMENTS.get("doc-p2").text;
  await write("fact", [
    { subjectKey: "P-002", variable: "myocardial_infarction", polarity: "negated", surface: "否认心梗史", documentId: "doc-p2", ...span(chart, "否认心梗史"), quote: "否认心梗史", visibleAt: "2026-09-02T00:00:00Z" },
    { subjectKey: "P-002", variable: "age", value: 45, unit: "year", polarity: "affirmed", surface: "45 岁", documentId: "doc-p2", ...span(chart, "年龄 45 岁"), quote: "年龄 45 岁", visibleAt: "2026-09-02T00:00:00Z" },
  ]);
  const built = await vcr.matching.matchScenario(study);
  assert.equal(built.ok, true);
  const job = { id: "job_match_1", studyId: study.id, kind: "match_criteria", scenario: built.scenario, inputs: built.inputs, scenarioHash: "c".repeat(64), seed: 3 };
  // The plane's documents are the test's own copies; the executor is the composed one otherwise.
  const executor = vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents });
  const result = await executor({ job, onProgress: async () => {} });
  assert.deepEqual(result.assessments.map((row) => row.subjectKey).sort(), ["P-001", "P-002"]);
  const p2 = result.assessments.find((row) => row.subjectKey === "P-002");
  assert.equal(p2.summary, "insufficient_evidence", "the age is known, the MI is denied, and the pregnancy test and the consent are still owed: not eligible");
  const p1 = result.assessments.find((row) => row.subjectKey === "P-001");
  assert.ok(p1.judgments.find((judgment) => judgment.decidedBy === "model"), "the consent criterion is the model's, and its quote was re-read in the document");

  const finished = await vcr.matching.onJobFinished({ action: "finished", state: "succeeded", job: { id: job.id, studyId: study.id, kind: "match_criteria", state: "succeeded" }, engineResult: result });
  assert.equal(finished.persisted, 2);
  const tallies = await vcr.matchStore.assessmentTallies(study.id);
  assert.equal(Object.values(tallies).reduce((sum, n) => sum + n, 0), 2);
  const referrals = await vcr.matchStore.listReferrals({ studyId: study.id });
  assert.equal(referrals.length >= 1, true, "the candidates became referrals");
  assert.equal(referrals.every((referral) => ["candidate", "needs_evidence"].includes(referral.state)), true, "in `candidate`, made by the control plane, never in a contact state");
  assert.equal(referrals.every((referral) => referral.contactApprovedBy === null), true);
  assert.equal(notices.length, 1, "the coordinators were told once");
  assert.equal(notices[0].candidates, referrals.length);

  // A second run of the same subjects makes no second notice and no second referral.
  const again = await vcr.matching.onJobFinished({ action: "finished", state: "succeeded", job: { id: "job_match_2", studyId: study.id, kind: "match_criteria", state: "succeeded" }, engineResult: result });
  assert.equal(again.candidates, 0);
  assert.equal(notices.length, 1);
  assert.equal((await vcr.matchStore.listReferrals({ studyId: study.id })).length, referrals.length);
  // A job of another kind, or one that failed, persists nothing.
  assert.equal((await vcr.matching.onJobFinished({ state: "succeeded", job: { kind: "design_simulation", studyId: study.id }, engineResult: result })).persisted, 0);
  assert.equal((await vcr.matching.onJobFinished({ state: "failed", job: { kind: "match_criteria", studyId: study.id }, engineResult: result })).persisted, 0);
});

test("M-17 a re-saved assessment keeps a person's override, drops a criterion the protocol no longer has, and keeps a countersignature only while its summary stands", options, async () => {
  const [assessment] = await vcr.matchStore.listAssessments({ studyId: study.id, subjectKey: "P-002", limit: 1 });
  const full = await vcr.matchStore.getAssessment(assessment.id, study.id);
  const judgment = full.judgments[0];
  const overridden = await vcr.matching.overrideJudgment({ id: "coordinator-1" }, study, { assessmentId: assessment.id, criterionId: judgment.criterionId, state: "satisfied", note: "电话核实" });
  assert.equal(overridden.overrideState, "satisfied");
  assert.equal(overridden.overriddenBy, "coordinator-1", "by the session's account");
  await vcr.matching.reviewAssessment({ id: "coordinator-1" }, study, { assessmentId: assessment.id });
  // The same assessment saved again.
  const saved = await vcr.matchStore.saveAssessment({ userId: USER, assessment: {
    studyId: study.id, protocolVersionId: assessment.protocolVersionId, subjectKey: "P-002", asOf: assessment.asOf, summary: assessment.summary,
    counts: assessment.counts, evidenceGaps: [], judgments: full.judgments.slice(0, 1).map((entry) => ({ criterionId: entry.criterionId, state: "unknown", applicable: true, decidedBy: "code", evidence: [] })),
  } });
  const after = await vcr.matchStore.getAssessment(saved.id, study.id);
  assert.equal(after.judgments.length, 1, "a criterion dropped from the assessment takes its judgment with it");
  assert.equal(after.judgments[0].overrideState, "satisfied", "the person's answer survives the re-save");
  assert.equal(after.reviewedBy, "coordinator-1", "the summary it signed is the summary still");
  const changed = await vcr.matchStore.saveAssessment({ userId: USER, assessment: {
    studyId: study.id, protocolVersionId: assessment.protocolVersionId, subjectKey: "P-002", asOf: assessment.asOf, summary: "ineligible",
    counts: assessment.counts, evidenceGaps: [], judgments: [] } });
  assert.equal((await vcr.matchStore.getAssessment(changed.id, study.id)).reviewedBy, null, "a signature on a different verdict is not a signature");
});

test("CS-35 M-14 the store's lookups are study-scoped: another study's assessment, judgment, site and referral are not found", options, async () => {
  const [assessment] = await vcr.matchStore.listAssessments({ studyId: study.id, limit: 1 });
  assert.equal(await vcr.matchStore.getAssessment(assessment.id, otherStudy.id), null);
  await assert.rejects(() => vcr.matching.overrideJudgment({ id: "x" }, otherStudy, { assessmentId: assessment.id, criterionId: "any", state: "satisfied" }),
    (error) => /** @type {any} */ (error).code === "vcr_assessment_not_found");
  await assert.rejects(() => vcr.matching.reviewAssessment({ id: "x" }, otherStudy, { assessmentId: assessment.id }), (error) => /** @type {any} */ (error).code === "vcr_assessment_not_found");
  await assert.rejects(() => vcr.matchStore.overrideJudgment({ assessmentId: assessment.id, criterionId: "c", state: "maybe", by: "x", userId: USER, studyId: study.id }),
    (error) => /** @type {any} */ (error).code === "vcr_write_value_invalid", "an unknown state is refused, not stored");
  const [referral] = await vcr.matchStore.listReferrals({ studyId: study.id, limit: 1 });
  assert.equal(await vcr.matchStore.getReferral(referral.id, otherStudy.id), null);
  assert.equal((await vcr.matchStore.getReferral(referral.id, study.id)).id, referral.id);
});

test("PA-12 a site is written into this study only, without a verification a run cannot give, and a follow-up keeps the restricted fields restricted", options, async () => {
  const sites = await write("site", [
    { name: "北京协和医院", capacity: { slots: 20, activationPlannedOn: "2026-10-15" }, contacts: [{ name: "张医生" }], activatedOn: "2026-05-01",
      accrualPrior: { alpha: 2, beta: 4, screenFailureRate: 0.3 }, verifiedAt: "2026-09-01" },
    { name: "复旦大学附属肿瘤医院", accrualPrior: { alpha: -1, beta: 1 } },
    { name: "x", accrualPrior: { alpha: 2, beta: 4, history: { enrolled: 99 } } },
    { id: "ste_of_another_study", name: "y" },
  ]);
  assert.equal(sites.ids.length, 0, "no item of that batch is a site this study may write");
  assert.deepEqual(sites.issues.map((issue) => [issue.index, issue.field]), [[0, "verifiedAt"], [1, "accrualPrior.alpha"], [2, "accrualPrior.history"], [3, "id"]]);
  const written = await write("site", [{ name: "北京协和医院", capacity: { slots: 20, activationPlannedOn: "2026-10-15" }, contacts: [{ name: "张医生" }], activatedOn: "2026-05-01", accrualPrior: { alpha: 2, beta: 4, screenFailureRate: 0.3 } }]);
  assert.equal(written.ok, true);
  const [site] = await vcr.matchStore.listSites(study.id);
  assert.equal(site.verifiedAt, null, "a profile with no verification makes no capacity claim");
  assert.deepEqual(await vcr.matchStore.listSites(otherStudy.id), []);

  const follow = await write("followup", [
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-01", exitReason: "患者要求退出" },
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-01", exitReason: "退出", observations: [{ variable: "progression_date", value: "2026-07-01" }] },
    { subjectKey: "P-001", kind: "study_specific" },
    { subjectKey: "P-001", kind: "post_exit", windowStart: "2026-08-02", observations: [{ variable: "ecog", value: 1, at: "2026-08-10" }] },
    { subjectKey: "P-001", kind: "routine_care", exitReason: "x", derived: true },
  ]);
  assert.equal(follow.ids.length, 2);
  assert.deepEqual(follow.issues.map((issue) => issue.index), [1, 2, 4]);
  const episodes = await vcr.matchStore.listFollowupEpisodes({ studyId: study.id, subjectKey: "P-001" });
  const trial = episodes.find((episode) => episode.kind === "study_specific");
  assert.equal(trial.exitReason, "患者要求退出", "the exit is recorded as it was given");
  assert.equal(trial.restricted.progression_date.reason, "restricted_in_trial", "and never converted into a progression date");
  // Trying to turn the exit into a trial fact is refused by the exit rule's own name, and the run is told why in words.
  const derived = follow.issues.find((issue) => issue.index === 1);
  assert.equal(derived.code, "vcr_exit_field_not_derivable");
  assert.match(derived.message, /不可见，也不能从出组记录推出/);
  assert.doesNotMatch(derived.message, /方案\s*§|AC-\d/);

  // The exit stands as first recorded: a different one for the same subject is appended, reported, never written over.
  const restated = await write("followup", [
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-09", exitReason: "患者要求退出" },
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-01", exitReason: "疾病进展" },
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-01", exitReason: "患者要求退出" },
    { subjectKey: "P-001", kind: "study_specific", exitDate: "2026-08-01", exitReason: "患者要求退出", windowEnd: "2026-09-30" },
  ]);
  assert.equal(restated.ids.length, 3, "a different exit is appended (three written), a window that ends after the exit is refused");
  assert.deepEqual(restated.issues.map((issue) => [issue.index, issue.field, issue.code]), [
    [0, "exitDate", "vcr_exit_date_rewritten"],
    [1, "exitReason", "vcr_exit_reason_rewritten"],
    [3, "windowEnd", "vcr_write_value_invalid"],
  ]);
  const after = await vcr.matchStore.listFollowupEpisodes({ studyId: study.id, subjectKey: "P-001" });
  assert.equal(after.find((episode) => episode.kind === "study_specific" && episode.exitReason === "患者要求退出").exitReason, "患者要求退出", "the first record is untouched");
  assert.ok(after.filter((episode) => episode.kind === "study_specific").length >= 4, "nothing was overwritten: every write is a row");
});

test("PA-26 the accrual forecast is built from the referral ledger in exactly the engine's shape, and the backtest reads the registered forecasts", options, async () => {
  const referrals = await vcr.matchStore.listReferrals({ studyId: study.id });
  assert.ok(referrals.length >= 1);
  const [site] = await vcr.matchStore.listSites(study.id);
  await vcr.matchStore.upsertSite({ userId: USER, site: { ...site, studyId: study.id, id: site.id, verifiedAt: null } });
  const built = await vcr.matching.accrualScenario(study, { target: 40, byTimes: [6, 12] });
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(Object.keys(built.scenario).sort(), ["byTimes", "sites", "target"], "screenFailure only where the ledger has screening history");
  assert.deepEqual(Object.keys(built.scenario.sites[0]).sort(), ["alpha", "beta", "enrolled", "exposureTime", "id", "startTime"]);
  assert.equal(built.scenario.sites[0].alpha, 2 + built.scenario.sites[0].enrolled, "the site's posterior is its prior plus what the ledger says it enrolled");
  const refused = await vcr.matching.accrualScenario(study, { target: 0 });
  assert.equal(refused.ok, false);
  assert.equal((await vcr.matching.accrualScenario(study, { target: 10, eventTarget: 5 })).ok, false, "an event target needs its hazard");
  assert.equal((await vcr.matching.accrualScenario(study, { target: 10, byTimes: [12, 6] })).ok, false);
  const empty = await vcr.matching.accrualScenario(otherStudy, { target: 10 });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /中心/);
  const backtest = await vcr.matching.accrualBacktest(study);
  assert.equal(backtest.slices, 0);
  assert.equal(backtest.coverage, null, "no registered forecast, no coverage: nothing is invented");
});

test("the runtime read of matching is aggregates and pseudonymous keys, and one subject's own assessment: no reviewer, no note", options, async () => {
  const overview = await vcr.service.runtimeRead(study, "matching", {});
  assert.ok(overview.criteria.length >= 1);
  assert.ok(Array.isArray(overview.summaryCells));
  assert.ok(overview.subjects.every((subject) => /^P-\d+$/.test(subject.subjectKey)));
  const one = await vcr.service.runtimeRead(study, "matching", { subjectKey: "P-002" });
  assert.ok(one.assessment);
  const text = JSON.stringify({ overview, one });
  for (const leak of ["coordinator-1", "电话核实", "reviewedBy", "overriddenBy", "overrideNote"]) assert.equal(text.includes(leak), false, `${leak} must not reach a run`);
  assert.equal(one.requests.some((request) => request.criterionKey === "consent"), true, "P-002 still owes the consent answer");
  assert.equal((await vcr.service.runtimeRead(otherStudy, "matching", {})).protocol, null, "another study's run reads nothing of this one");
});

test("the funnel and the tallies are computed over the complete data, and the referral funnel counts a withdrawal at the step it reached", options, async () => {
  const funnel = await vcr.matchStore.criterionFunnelRows(study.id);
  assert.ok(funnel.length >= 1);
  assert.ok(funnel.every((row) => row.satisfied + row.not_satisfied + row.unknown + row.pending_recheck + row.notApplicable >= 1));
  const [referral] = await vcr.matchStore.listReferrals({ studyId: study.id, limit: 1 });
  const moves = ["contactable", "contacted", "withdrawn"];
  const { decideReferralTransition } = await import("../src/vcrRecruit.mjs");
  await vcr.matchStore.approveContact({ referralId: referral.id, studyId: study.id, approvedBy: USER, userId: USER });
  for (const to of moves) {
    const moved = await vcr.matchStore.transitionReferral({ referralId: referral.id, studyId: study.id, to, actor: USER, userId: USER,
      guard: (current) => decideReferralTransition({ referral: current, to, role: "lead" }) });
    assert.equal(moved.ok, true, `${to}: ${JSON.stringify(moved)}`);
  }
  const progress = await vcr.matchStore.referralProgress(study.id);
  assert.equal(progress.get(referral.id), "contacted");
  const tab = await vcr.matching.tab(study);
  assert.ok(tab.funnel.reachedContact >= 1, "the withdrawn patient was contacted");
  assert.deepEqual(Object.keys(tab.tallies).every((key) => ["eligible", "ineligible", "insufficient_evidence", "pending"].includes(key)), true);
});

test("a deferral that has come due is re-evaluated by the recheck, once per study, and nothing due is nothing enqueued", options, async () => {
  const queued = [];
  const jobs = { enqueue: async (input) => { queued.push(input); return { job: { id: `job_r${queued.length}`, state: "queued" }, created: true }; } };
  const seam = vcrMatchingSeam({ matchStore: vcr.matchStore, store: vcr.store, jobs, now: () => new Date("2026-12-01T00:00:00Z") });
  assert.deepEqual(await seam.recheckDue(), { studies: 0, enqueued: 0 });
  // A washout that ends 2026-11-03, saved as a deferral on the newest assessment of P-001.
  const [criterion] = await vcr.matchStore.listCriteria({ studyId: study.id });
  const [assessment] = await vcr.matchStore.listAssessments({ studyId: study.id, subjectKey: "P-001", limit: 1, latestOnly: true });
  await vcr.matchStore.saveAssessment({ userId: USER, assessment: { studyId: study.id, protocolVersionId: assessment.protocolVersionId, subjectKey: "P-001",
    asOf: new Date(Date.parse(assessment.asOf) + 3_600_000).toISOString(), summary: "pending", counts: {}, evidenceGaps: [],
    judgments: [{ criterionId: criterion.id, state: "pending_recheck", applicable: true, decidedBy: "code", evidence: [], recheckAt: "2026-11-03T00:00:00.000Z" }] } });
  const due = await vcr.matchStore.dueRecheckSubjects({ studyId: study.id, now: new Date("2026-12-01T00:00:00Z") });
  assert.deepEqual(due.map((entry) => entry.subjectKey), ["P-001"]);
  assert.deepEqual(await vcr.matchStore.dueRecheckSubjects({ studyId: study.id, now: new Date("2026-10-01T00:00:00Z") }), [], "before its date it is not due, and never evaluates as satisfied early");
  const ran = await seam.recheckDue();
  assert.deepEqual(ran, { studies: 1, enqueued: 1 });
  assert.equal(queued[0].kind, "match_criteria");
  assert.equal(queued[0].idempotencyKey, `vcr:${study.id}:recheck`);
  assert.ok(queued[0].inputs.some((input) => input.id.startsWith("matching:asof:2026-12-01T00:00:00")));
});

test("simulate match_criteria on the real queue: the frozen scenario is accepted, the local executor computes it and the finish hook persists its assessments", options, async () => {
  const started = await gateway("simulate", { action: "start", kind: "match_criteria" });
  assert.equal(started.status, 200, started.body);
  const { jobId, state } = started.json().data;
  assert.ok(jobId);
  assert.ok(["queued", "running", "succeeded"].includes(state), state);
  const row = await vcr.store.one(`SELECT kind, scenario, inputs FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [jobId]);
  assert.equal(row.kind, "match_criteria");
  assert.ok(row.scenario.criteria.length >= 1);
  const asOf = row.inputs.find((input) => input.id.startsWith("matching:asof:")).id.slice("matching:asof:".length);

  // The plane's documents are the test's own copies; everything else is the composed queue.
  const composed = vcr.jobs.localExecutors["matching.evaluate"];
  vcr.jobs.localExecutors["matching.evaluate"] = vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents });
  try {
    for (let pass = 0; pass < 6; pass += 1) {
      const claimed = await vcr.jobs.claim({ limit: 4 });
      if (!claimed.length) break;
      for (const job of claimed) { await vcr.jobs.advance(job); await vcr.jobs.advance(job); }
    }
  } finally {
    vcr.jobs.localExecutors["matching.evaluate"] = composed;
  }
  const status = await gateway("simulate", { action: "status", jobId });
  assert.equal(status.status, 200, status.body);
  assert.equal(status.json().data.state, "succeeded", status.body);
  const latest = await vcr.matchStore.listAssessments({ studyId: study.id, subjectKey: "P-002", limit: 1, latestOnly: true });
  assert.equal(Date.parse(latest[0].asOf), Date.parse(asOf), "the assessment is the one of the frozen instant, persisted by the hook");
});

test("simulate accrual_forecast on the real queue: the scenario built from the ledger passes the engine's own schema, and only its table is kept", options, async () => {
  const started = await gateway("simulate", { action: "start", kind: "accrual_forecast", scenario: { target: 40, byTimes: [6, 12] } });
  assert.equal(started.status, 200, started.body);
  const { jobId } = started.json().data;
  const row = await vcr.store.one(`SELECT kind, scenario, checkpoint FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [jobId]);
  assert.equal(row.kind, "accrual_forecast");
  assert.deepEqual(Object.keys(row.scenario).sort(), ["byTimes", "sites", "target"]);
  assert.deepEqual(row.checkpoint.keepTables, ["probability_by_month"]);
  const refused = await gateway("simulate", { action: "start", kind: "accrual_forecast", scenario: { target: 40, eventTarget: 10 } });
  assert.equal(refused.status, 400, "an event target with no hazard is refused before it is queued");
});

test("simulate match_criteria hands the queue the platform's own frozen scenario and refuses a scenario or inputs from the run", options, async () => {
  const asked = [];
  const jobs = { enqueue: async (input) => { asked.push(input); return { job: { id: "job_m", state: "queued", progress: {} }, created: true }; } };
  const forged = await gateway("simulate", { action: "start", kind: "match_criteria", scenario: { subjects: [{ subjectKey: "P-X", facts: [] }] } }, { jobs });
  assert.equal(forged.status, 400);
  assert.equal(forged.json().code, "vcr_simulate_payload_invalid");
  const started = await gateway("simulate", { action: "start", kind: "match_criteria" }, { jobs });
  assert.equal(started.status, 200, started.body);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].scenario.criteria.every((criterion) => criterion.state === "unknown"), true);
  assert.ok(asked[0].inputs.some((input) => input.id.startsWith("matching:asof:")), "the instant is frozen as an input");
  assert.equal(asked[0].detail.origin, "runtime");
  const accrual = await gateway("simulate", { action: "start", kind: "accrual_forecast", scenario: { target: 40 } }, { jobs });
  assert.equal(accrual.status, 200, accrual.body);
  assert.deepEqual(asked[1].detail.keepTables, ["probability_by_month"]);
  assert.equal(accrual.json().data.notes.screenFailureUnavailable, true, "what the study cannot supply is said, not zeroed");
  const smuggled = await gateway("simulate", { action: "start", kind: "accrual_forecast", scenario: { target: 40, sites: [{ id: "x", alpha: 1, beta: 1, startTime: 0 }] } }, { jobs });
  assert.equal(smuggled.status, 400, "the rates of a site come from the ledger, not from the run");
});

// Last on purpose: the earlier tests read the account's first precedent and expect it to be the ClinicalTrials.gov one.
test("an EU CTIS precedent is fetched through the same write, its planned enrolment kept apart from any actual one, and a missing number is named", options, async () => {
  const fetched = await write("precedent", [
    { registry: "ctis", registryId: "2024-513060-26-00", line: "first" },
    { registry: "ctis", registryId: "2099-000000-00-00" },
    { registry: "ctis", registryId: "not a number" },
  ]);
  assert.equal(fetched.ids.length, 1);
  assert.equal(fetched.results[0].extracted, 18);
  assert.equal(fetched.results[0].verified, 18, "every value the client copied or counted passes its own check against the preserved record");
  assert.deepEqual(fetched.issues.map((issue) => [issue.index, issue.code]), [[1, "registry_not_found"], [2, "vcr_write_value_invalid"]]);
  const row = (await vcr.evidenceStore.listPrecedents({ userId: USER, studyId: study.id, registry: "ctis" }))[0];
  assert.equal(row.registry, "ctis");
  assert.equal(row.registry_id, "2024-513060-26-00");
  assert.equal(row.enrollment_kind, "estimated");
  assert.match((await vcr.evidenceStore.getPrecedent(USER, row.id, { withText: true })).record_text, /authorizedPartsII\[0\]\.recruitmentSubjectCount: 8\n/);
  const items = await vcr.evidenceStore.listEvidenceItems({ userId: USER, studyId: study.id, parameter: "enrollment_estimated" });
  assert.deepEqual(items.map((item) => [Number(item.value), item.enrollment_kind ?? item.enrollmentKind]).sort(), [[8, "estimated"], [8, "estimated"], [8, "estimated"]]);
  assert.ok(items.every((item) => item.historical_baseline === false || item.historicalBaseline === false), "a plan is never a baseline");
});

test("an answer names a subject the study has: an invented key is refused and never becomes a candidate", options, async () => {
  // Production, 2026-10-05 (release 5): a matching run tried the write with two keys of its own, `unknown` and no evidence.
  // Both were accepted, the next evaluation took every judged key as a candidate, and a roster of 240 read 242.
  DOCUMENTS.set("doc-p3", { subjectKey: "P-003", text: "门诊随访记录。", visibleAt: "2026-09-03T00:00:00.000Z" });
  const result = await write("language_judgment", [
    { subjectKey: "P-999-not-a-subject", criterionKey: "consent", state: "unknown", evidence: [] },
    // P-003 has no fact and no assessment, only a document in the plane: it is a subject of this study.
    { subjectKey: "P-003", criterionKey: "consent", state: "unknown", evidence: [] },
  ]);
  assert.equal(result.ids.length, 1, JSON.stringify(result.issues));
  assert.deepEqual(result.issues.map((issue) => [issue.index, issue.field]), [[0, "subjectKey"]]);
  assert.match(result.issues[0].message, /没有编号为「P-999-not-a-subject」的受试者/);
  const stored = await vcr.matchStore.latestLanguageJudgments({ studyId: study.id });
  assert.equal(stored.has("P-999-not-a-subject"), false, "nothing was written for the invented key");
  assert.equal(stored.get("P-003").consent.state, "unknown");
  // The same key against the other study, which has none of these subjects.
  assert.equal(await vcr.matchStore.holdsSubject(otherStudy.id, "P-001"), false);
  assert.equal(await vcr.matchStore.holdsSubject(study.id, "P-001"), true, "a subject with a recorded fact is held");
});
