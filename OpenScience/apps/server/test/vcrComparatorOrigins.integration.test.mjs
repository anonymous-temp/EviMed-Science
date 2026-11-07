// Where a control comes from and what a population is bound to, on the REAL store of a real PostgreSQL (in silico plan T07 and T13;
// A03, A04, A11, A13): the pages read what the store holds, so a model or population change leaves only the results that read the old
// one, a simulated control never adds an observed person, and a method that cannot estimate keeps saying so beside its origin.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { presentComparatorTab, presentPatientsTab, presentPopulationTab } from "../src/vcrViewsTabs.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrStore} */
let store;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrorg_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

async function furnish() {
  const userId = `u_${randomUUID().slice(0, 8)}`;
  const created = await store.createStudy({ userId, projectId: `prj_${randomUUID().slice(0, 8)}`, name: "来源", question: "q" });
  await store.saveDefinition({ studyId: created.id, userId, pico: { population: "成人" }, endpointType: "time_to_event", intendedUse: "specified_analysis" });
  return { study: /** @type {any} */ (await store.studyById(created.id)), userId };
}

const write = (/** @type {any} */ study, /** @type {string} */ what, /** @type {any} */ data) =>
  vcrRuntimeWrite({ store, service: /** @type {any} */ ({}), orchestrator: null, study, what, items: null, data });

/** The page's bundle as the service assembles it from the store. */
async function bundleOf(/** @type {any} */ study, /** @type {string} */ userId, extra = {}) {
  const [results, allResults, comparators, populations, patientSets, models] = await Promise.all([
    store.results(study.id), store.allResults(study.id), store.comparatorDesigns(study.id, 20), store.populations(study.id, 20), store.patientSets(study.id, 20), store.models(userId)]);
  const executionRows = await store.rows(`SELECT id, job_id, method, method_version FROM evimed_vcr.executions WHERE study_id = $1`, [study.id]);
  const executions = new Map(executionRows.map((/** @type {any} */ row) => [String(row.id), { id: String(row.id), jobId: String(row.job_id), method: String(row.method), methodVersion: String(row.method_version ?? ""), inputs: [] }]));
  return { now: new Date(), study, definition: await store.latestDefinition(study.id), results, allResults, stale: [], reviews: [], jobs: [], budget: null, assumptions: [], members: [], exports: [],
    decisions: [], roles: [], scenarios: [], comparators, comparator: comparators[0] ?? null, populations, patientSets, grid: null, forecasts: [], models, executions, protocol: null,
    criteria: [], jobMarks: [], currentNodes: new Set(), assessments: [], people: new Map(), ...extra };
}

const card = (/** @type {Record<string, any>} */ over = {}) => ({ title: "阿尔茨海默病进展模型", executable: true, executableModes: ["factual_forecast", "conditional_forecast", "intervention_comparison"],
  useEvidence: [{ mode: "factual_forecast", endpoint: "ADAS-cog 11", horizonHours: 8766, evidenceRef: "paper-1", independent: true }], ...over });

async function result(/** @type {any} */ study, /** @type {string} */ userId, /** @type {string} */ method, /** @type {Record<string, any>} */ over) {
  const id = `job_${randomUUID().slice(0, 8)}`;
  await store.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, method_version, state, scenario_hash, seed, replicates, progress, cpu_seconds_limit, cpu_seconds_used)
    VALUES ($1, $2, $3, $6, $4, '1.0.0', 'succeeded', $5, 1, NULL, '{}'::jsonb, 600, 1)`, [id, study.id, userId, method, createHash("sha256").update(id).digest("hex"), method === "model.prognostic_apply" ? "apply_prognostic_model" : method === "comparator.rmst" ? "rmst" : "weight_comparator"]);
  const execution = await store.recordExecution({ jobId: id, studyId: study.id, userId, method, methodVersion: "1.0.0", scenarioHash: createHash("sha256").update(id).digest("hex"), inputs: [], seed: 1 });
  return store.recordResult({ studyId: study.id, userId, kind: "comparator", executionId: execution?.id, conclusion: "estimable", method, ...over });
}

test("A03, A13: a literature population with no model is a valid descriptive object; binding it, then changing the model or the population, leaves only what read the old one", options, async () => {
  const { study, userId } = await furnish();
  const population = await store.savePopulation({ studyId: study.id, userId, name: "文献人群", kind: "literature", definition: {}, counts: { generatedRecords: 500 }, allowedUses: [] });
  let bundle = await bundleOf(study, userId);
  let view = presentPopulationTab(bundle);
  assert.equal(view.binding.readiness, "descriptive_only");
  assert.equal(view.binding.origin, "literature_constrained");
  assert.equal(view.binding.members.virtualMembers, 500, "the members the population holds, counted as members");
  assert.equal(view.binding.members.observedPeople, null, "and never as observed people");
  assert.ok(view.premises.some((/** @type {any} */ row) => row.key === "binding:readiness" && /不能直接拿来比较治疗/.test(row.value)));
  assert.ok(!view.premises.some((/** @type {any} */ row) => /推演每个人/.test(row.value)), "no false readiness claim");

  await store.saveModel({ userId, name: "ad-prog", version: "1", tier: "scenario", risk: "low", endpointType: "continuous", card: card() });
  await store.saveModel({ userId, name: "other", version: "1", tier: "scenario", risk: "low", endpointType: "binary", card: card({ executableModes: ["conditional_forecast"], useEvidence: undefined }) });
  await store.savePatientSet({ studyId: study.id, userId, populationId: population.id, name: "绑定一", modelId: "ad-prog", modelVersion: "1", scenario: { endpoint: "ADAS-cog 11" } });
  await store.savePatientSet({ studyId: study.id, userId, populationId: population.id, name: "绑定二", modelId: "other", modelVersion: "1", scenario: {} });
  bundle = await bundleOf(study, userId);
  view = presentPopulationTab(bundle);
  assert.equal(view.binding.readiness, "intervention_mapping_available");
  assert.equal(view.binding.model, "阿尔茨海默病进展模型");
  assert.equal(view.binding.staleResults, 0);
  assert.ok(view.premises.some((/** @type {any} */ row) => row.key === "use:use_not_validated"), "evidence is apart from readiness: bound and not validated for this use");

  // a new version of the first model: only the set that read it is behind
  await store.saveModel({ userId, name: "ad-prog", version: "2", tier: "scenario", risk: "low", endpointType: "continuous", card: card() });
  bundle = await bundleOf(study, userId);
  view = presentPopulationTab(bundle);
  assert.equal(view.binding.staleResults, 1);
  assert.ok(view.premises.some((/** @type {any} */ row) => row.key === "binding:stale_model"));
  assert.equal(view.binding.readiness, "transition_model_bound", "the other model still holds, the stale one is not counted");

  // another account never reads the first account's models: its page shows the binding as gone, not as a stale hit
  const foreign = presentPopulationTab({ ...bundle, models: await store.models(`u_${randomUUID().slice(0, 8)}`) });
  assert.equal(foreign.binding.readiness, "descriptive_only");
  assert.equal(foreign.binding.model, null);

  // a new version of the population: the sets made from the earlier one are reported and stay readable
  await store.savePopulation({ studyId: study.id, userId, name: "文献人群 v2", kind: "literature", definition: {}, counts: {}, allowedUses: [] });
  bundle = await bundleOf(study, userId);
  view = presentPopulationTab(bundle);
  assert.equal(view.binding.readiness, "descriptive_only");
  assert.ok(view.premises.some((/** @type {any} */ row) => row.key === "binding:stale_population" && /2 个结果/.test(row.value)));
  assert.equal(bundle.patientSets.length, 2, "history is not deleted");
});

test("A04: a model used beyond what it was validated for still produces its patients page, with the premise in the one block", options, async () => {
  const { study, userId } = await furnish();
  await store.saveModel({ userId, name: "eq", version: "1", tier: "scenario", risk: "low", endpointType: "binary", card: card() });
  const set = await store.savePatientSet({ studyId: study.id, userId, name: "患者", modelId: "eq", modelVersion: "1", scenario: {} });
  const filed = await result(study, userId, "model.prognostic_apply", { kind: "patient_set", subjectId: set.id, diagnostics: { endpoint: "ADAS-cog 11", headline: "预测完成" }, counts: { generatedRecords: 50 } });
  assert.ok(filed);
  await store.query?.(`UPDATE evimed_vcr.patient_sets SET result_id = $1 WHERE id = $2`, [filed.id, set.id]).catch(() => null);
  const bundle = await bundleOf(study, userId);
  const page = presentPatientsTab({ ...bundle, patientSets: bundle.patientSets.map((/** @type {any} */ row) => ({ ...row, resultId: filed.id })) });
  assert.equal(page.headline, "预测完成", "the result is delivered");
  assert.deepEqual(page.premises.map((/** @type {any} */ row) => row.key), ["use:use_not_validated"]);
});

test("A11: a simulated control states its origin on the page and in the export, and adds no observed subject", options, async () => {
  const { study, userId } = await furnish();
  const created = await write(study, "comparator", { route: "model_comparator", estimand: "ATT", configuration: { covariates: ["age"] } });
  assert.equal(created.ok, true, JSON.stringify(created.issues));
  const filed = await result(study, userId, "model.prognostic_apply", { subjectId: (await store.comparatorDesigns(study.id, 1))[0].id,
    diagnostics: { sourceCondition: "control", valueSourcesUsed: { weakest: "synthetic" } }, counts: { generatedRecords: 800, realPatients: 800 } });
  assert.ok(filed);
  await store.query?.(`UPDATE evimed_vcr.comparator_designs SET result_id = $1 WHERE study_id = $2`, [filed.id, study.id]).catch(() => null);
  const bundle = await bundleOf(study, userId);
  const page = presentComparatorTab({ ...bundle, comparators: bundle.comparators.map((/** @type {any} */ row) => ({ ...row, resultId: filed.id })), comparator: { ...bundle.comparator, resultId: filed.id } });
  assert.equal(page.origins.origin, "simulated");
  assert.equal(page.origins.observedPeople, 0);
  assert.equal(page.origins.modelConditional, true);
  const keys = page.premises.map((/** @type {any} */ row) => row.key);
  assert.ok(keys.includes("origin:simulated") && keys.includes("origin:transport"), keys.join(","));
  const report = vcrReportModel({ study, results: bundle.results, comparator: bundle.comparator });
  assert.equal(report.comparatorOrigins.origin, "simulated");
  assert.equal(report.comparatorOrigins.observedPeople, 0);
});

test("A11: an observed control and a reconstructed one are told apart, the target trial and the method's own non-estimability stay beside them", options, async () => {
  const { study, userId } = await furnish();
  const trial = { eligibility: { status: "approximate", text: "入排更宽" }, strategies: { status: "exact", text: "试验药对标准治疗" }, assignment: { status: "approximate", text: "靠协变量加权" },
    timeZero: { status: "approximate", text: "从开始治疗之日起算" }, outcome: { status: "exact", text: "总生存期" }, contrast: { status: "exact", text: "风险比" }, analysis: { status: "exact", text: "加权 Cox" } };
  const made = await write(study, "comparator", { route: "external_control", estimand: "ATT", targetTrial: trial,
    configuration: { covariates: ["age", "ecog"], applicability: { state: "suitable", claim: "superiority", note: "同一年代的登记库" } } });
  assert.equal(made.ok, true, JSON.stringify(made.issues));
  const row = (await store.comparatorDesigns(study.id, 1))[0];
  const observed = await result(study, userId, "comparator.entropy_balance", { subjectId: row.id, conclusion: "limited",
    diagnostics: { estimand: "ATT", valueSourcesUsed: { weakest: "calculated" }, timeUnitBasis: { unit: "months", basis: "stated" }, balance: [{ covariate: "age", smdUnadjusted: 0.6, smdAdjusted: 0.04 }] },
    counts: { realPatients: 640 } });
  assert.ok(observed);
  let bundle = await bundleOf(study, userId);
  let page = presentComparatorTab({ ...bundle, comparators: [{ ...row, resultId: observed.id }], comparator: { ...row, resultId: observed.id } });
  assert.equal(page.origins.origin, "observed");
  assert.equal(page.origins.observedPeople, 640);
  const keys = page.premises.map((/** @type {any} */ entry) => entry.key);
  assert.ok(!keys.some((/** @type {string} */ key) => /^origin:(simulated|reconstructed|model_predicted)$/.test(key)), "an observed control has no origin warning");
  assert.ok(keys.includes("origin:transport") && keys.includes("targetTrial") && keys.includes("applicability"), keys.join(","));

  // a literature route with a reconstruction that could not be estimated: the origin and the method's own rule are both on the page
  const rebuilt = await result(study, userId, "comparator.rmst", { subjectId: row.id, conclusion: "not_estimable", notEstimableRule: "tau_beyond_followup",
    diagnostics: { valueSourcesUsed: { weakest: "reconstructed" }, tau: 60, timeUnit: "months" }, counts: { realPatients: 120, reconstructedPseudoPatients: 300 } });
  assert.ok(rebuilt);
  bundle = await bundleOf(study, userId);
  const literature = { ...row, route: "literature_control", resultId: rebuilt.id, conclusion: "not_estimable" };
  page = presentComparatorTab({ ...bundle, comparators: [literature], comparator: literature });
  assert.equal(page.origins.origin, "reconstructed");
  assert.equal(page.origins.reconstructedPseudoPatients, 300);
  assert.equal(page.verdict.conclusion, "not_estimable", "the method's non-estimability is not softened by its origin");
  assert.ok(page.premises.some((/** @type {any} */ entry) => entry.key === "origin:reconstructed" && /伪个体（共 300 个）/.test(entry.value)));
  assert.ok(page.gaps !== undefined);
});
