// 「虚拟临研」's read models on PostgreSQL: the study list, the seven tabs, the
// runtime's reads, and who may see a study at all.
//
// The last one is why this suite needs a real database: a study's reader is
// `owner OR member`, which is a join, and a double would only prove that the
// method was called.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrService, VCR_READ_WHATS, seedVcrCatalogue } from "../src/vcrService.mjs";
import { VCR_ENGINE_METHODS, VCR_TABS } from "@evimed/domain";

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
/** @type {VcrService} */
let service;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

const config = { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 100_000,
  vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000, vcrDataPlaneDir: "" };

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrsvc_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config, jobs: new VcrJobs({ store, config }) });
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('catalogue restarts retain stored numerical provenance but never present it as current without protected proof', options, async () => {
  const method = 'design.analytic';
  const evidence = { status: 'passed', passed: 1, total: 1, numericalSourceDigest: 'a'.repeat(64), caseIds: ['synthetic-reference'] };
  const assumptions = [{ text: 'Fixture-only assumption', source: 'fixture.R:1' }];
  await store.saveMethod({ method, version: VCR_ENGINE_METHODS[method].version, endpoints: [], crossChecks: [], assumptions, numericTests: evidence });
  await seedVcrCatalogue({ store });
  const preserved = (await store.methods()).find(row => row.method === method);
  assert.deepEqual(preserved.numericTests, evidence); assert.deepEqual(preserved.assumptions, assumptions);
  const displayed = (await service.modelLibrary({ id: 'reader' })).methods.find(row => row.method === method);
  assert.equal(displayed.numeric, null); assert.equal(displayed.validation.status, 'unmeasured');
});

/** A study with something in every tab. @param {string} label */
async function furnish(label) {
  const study = await store.createStudy({ userId: `u_${label}`, projectId: `prj_${label}`, name: `EV-201 ${label}`,
    question: "单臂 II 期能不能用外部对照？", dataTier: "T0" });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, pico: { population: "二线 NSCLC" },
    estimand: { variable: "PFS" }, endpointType: "time_to_event" });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median_pfs", name: "对照组中位 PFS",
    pointValue: 4.1, unit: "月", sourceKind: "external_evidence", valueSource: "aggregate" });
  const population = await store.savePopulation({ studyId: study.id, userId: study.userId, kind: "literature",
    name: "文献人群", counts: { realPatients: null, generatedRecords: 0 },
    waterfall: [{ step: "纳入", kept: 300, excluded: 50, unknown: 12 }] });
  await store.savePatientSet({ studyId: study.id, userId: study.userId, populationId: population.id,
    name: "2000 名虚拟患者", modelId: "reference-time-to-event", modelVersion: "1.0.0", counts: { generatedRecords: 2000 } });
  await store.saveComparatorDesign({ studyId: study.id, userId: study.userId, route: "literature_control", estimand: "ATT" });
  await store.saveTrialScenario({ studyId: study.id, userId: study.userId, label: "A", design: "two_arm_fixed",
    endpointType: "time_to_event" });
  await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "EV-201 v1.0",
    criteria: [{ kind: "inclusion", criterionType: "performance_status", requirement: { field: "ecog", op: "<=", value: 1 },
      sourceText: "ECOG 0–1", sourceLocator: { page: 12 } }] });
  const result = await store.recordResult({ studyId: study.id, userId: study.userId, kind: "trial_scenario",
    conclusion: "estimable", counts: { realPatients: null, events: 138, effectiveSampleSize: null, generatedRecords: 2000 },
    measures: [{ name: "power", value: 0.712, simulated: true, mcse: 0.0031 }], requestedUse: "exploratory" });
  return { study, population, result };
}

test("a study's reader is its owner or a member; anyone else sees nothing", options, async () => {
  const { study } = await furnish("access");
  assert.equal((await store.getStudy(study.userId, study.id))?.id, study.id);
  assert.equal(await store.getStudy("stranger", study.id), null, "another account's study reads as one that never existed");
  await assert.rejects(service.requireStudy({ id: "stranger" }, study.id),
    (/** @type {any} */ error) => error.code === "vcr_study_not_found");

  // A member sees it without owning it — the reason `user_id` alone is never
  // the predicate outside deletion.
  await store.query("INSERT INTO evimed_vcr.members (study_id, user_id, role) VALUES ($1, $2, 'statistical_reviewer')",
    [study.id, "reviewer"]);
  assert.equal((await store.getStudy("reviewer", study.id))?.id, study.id);
  assert.equal((await store.listStudies("reviewer")).length, 1);
  assert.deepEqual((await store.rolesOf(study.id, "reviewer")), ["statistical_reviewer"]);
  assert.deepEqual((await store.rolesOf(study.id, study.userId)), ["lead"], "the owner is a lead from the first second");

  // The gateway's lookup is the same predicate, by project.
  assert.equal((await store.studyByControlProject(study.userId, study.projectId))?.id, study.id);
  assert.equal(await store.studyByControlProject("stranger", study.projectId), null);
});

test("the study list is the browser's own row: the seven steps, a tier, a conclusion, what needs attention", options, async () => {
  const { study } = await furnish("list");
  const listed = await service.listStudies({ id: study.userId });
  const row = listed.studies.find((entry) => entry.id === study.id);
  assert.ok(row);
  assert.equal(row.tier, "T0", "the page's word is `tier`, not the row's `dataTier`");
  assert.equal(Object.keys(row.steps).length, 7);
  assert.deepEqual(Object.keys(row.steps), ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"]);
  assert.match(String(row.conclusion?.text), /功效|方案|已算出/, "a conclusion rendered from the study's own result");
  assert.equal(row.conclusion.state, "estimable");
  assert.equal(typeof row.updatedAt, "string");
  assert.ok(row.attention.every((entry) => entry.kind !== "stale"), "nothing stale yet");

  await store.markStale(study.id, ["result:res_x@1"], "assumption_changed", {});
  const again = await service.listStudies({ id: study.userId });
  const marked = again.studies.find((entry) => entry.id === study.id);
  assert.ok(marked.attention.some((entry) => entry.kind === "stale"));
  assert.match(marked.attention.find((entry) => entry.kind === "stale").text, /1 个结果已过期：假设卡已变更/);
});

test("every one of the seven tabs answers the page shape, and says plainly what is not composed here", options, async () => {
  const { study } = await furnish("tabs");
  for (const tab of VCR_TABS) {
    const view = await service.tab({ id: study.userId }, study.id, tab);
    assert.ok(view, tab);
  }
  await assert.rejects(service.tab({ id: study.userId }, study.id, "everything"),
    (/** @type {any} */ error) => error.code === "vcr_tab_not_found");

  const population = await service.tab({ id: study.userId }, study.id, "population");
  assert.deepEqual(population.criteria.map((row) => row.code), ["I1"], "the protocol's rule, numbered");
  assert.equal(population.attrition[0].unknown, 12, "「无法判断」 is its own column");
  assert.equal(population.stale, null);

  const comparator = await service.tab({ id: study.userId }, study.id, "comparator");
  assert.equal(comparator.routes.length, 5);
  assert.deepEqual(comparator.routes.filter((route) => route.state === "not_applicable").map((route) => route.route),
    ["prognostic_adjustment", "external_control"], "the routes the data tier cannot reach say so");
  assert.equal(comparator.dimensions.length, 10);

  const matching = await service.tab({ id: study.userId }, study.id, "matching");
  assert.equal(matching.available, false);
  assert.equal(matching.unavailable.code, "vcr_matching_unavailable");

  const data = await service.tab({ id: study.userId }, study.id, "data");
  assert.equal(data.assumptions.length, 1);
  assert.equal(data.assumptions[0].key, "control_median_pfs");
  assert.match(String(data.evidenceNote), /证据参数化在本部署尚未接入/, "an empty card list must not read as 「没有证据」");
  assert.equal("root" in data, false, "no server path leaves through a page");
});

test("the overview carries the counts, the results with their staleness, and the use ceiling", options, async () => {
  const { study, result } = await furnish("overview");
  const view = await service.studyView({ id: study.userId }, study.id);
  assert.equal(view.tier, "T0");
  assert.deepEqual(Object.keys(view.overview.counts).slice(0, 4), ["realPatients", "events", "effectiveSampleSize", "generatedRecords"]);
  assert.equal(view.overview.counts.events, 138);
  assert.equal(view.ceiling.ceiling, "submission_preparation", "review absence does not change the method/evidence ceiling");
  assert.equal(view.ceiling.withinCeiling, true);
  assert.equal(view.budget.limitSeconds, 100_000);
  assert.deepEqual(view.abilities.includes("run"), true, "the owner is a lead");
  assert.ok(view.abilities.includes("manage_members"));

  await store.markStale(study.id, [`result:${result.id}@${result.version}`], "source_corrected", { source: "snp_1" });
  const stale = await service.studyView({ id: study.userId }, study.id);
  assert.ok(stale.overview.attention.some((entry) => entry.kind === "stale" && /源数据已更正/.test(entry.text)));
  // A stale result keeps its numbers (the row-level view carries the mark, the page's design values carry `stale`).
  const raw = await service.studyViewOf(await store.studyById(study.id));
  assert.equal(raw.results[0].stale.reason, "source_corrected");
  assert.equal(raw.results[0].measures[0].value, 0.712, "a stale result keeps its numbers");
});

test("every runtime read answers, and the ones whose package is absent say so by name", options, async () => {
  const { study } = await furnish("runtime");
  for (const what of VCR_READ_WHATS) {
    const answer = await service.runtimeRead(study, what, { limit: 5 });
    assert.ok(answer && typeof answer === "object", what);
    if (["precedents", "matching", "snapshot_profile", "trial_registry_record"].includes(what)) {
      assert.equal(answer.available, false, what);
      assert.ok(String(answer.message).length > 0, `${what} says why`);
    }
  }
  await assert.rejects(service.runtimeRead(study, "everything", {}),
    (/** @type {any} */ error) => error.code === "vcr_read_what_invalid");

  const results = await service.runtimeRead(study, "results", {});
  assert.equal(results.results[0].counts.realPatients, null);
  assert.equal(results.results[0].measures[0].mcse, 0.0031);
  const criteria = await service.runtimeRead(study, "criteria", {});
  assert.equal(criteria.criteria[0].sourceText, "ECOG 0–1");
  assert.ok(service.counters.reads >= VCR_READ_WHATS.length);
});

test("the model library answers from the seeded catalogue, and a study may take its own model into it", options, async () => {
  const { study } = await furnish("models");
  await seedVcrCatalogue({ store });
  const library = await service.modelLibrary({ id: study.userId });
  assert.ok(library.methods.length >= 20, "every engine method is in the catalogue");
  assert.equal(library.models.filter((model) => model.tier === "scenario").length, 4, "the three reference simulators and the trajectory model");
  assert.ok(library.models.some((model) => model.name === "连续终点纵向轨迹参考仿真器" && model.tier === "scenario"), "the trajectory model is in the library");
  const reference = library.models.find((model) => model.name === "事件时间终点参考仿真器");
  assert.deepEqual(reference.missingEvidence, []);
  assert.equal(reference.twinLabel, "基线条件化预测", "the label a model has earned, never 数字孪生 by default");

  const adopted = await service.adoptModel({ id: study.userId }, {
    studyId: study.id, name: "ev201-control-weibull", version: "1.0.0",
    sources: [{ label: "KEYNOTE-010" }, { label: "OAK" }],
    evidence: ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis"],
  });
  assert.equal(adopted.tier, "literature");
  const after = await service.modelLibrary({ id: study.userId });
  const fitted = after.models.find((model) => model.version === "1.0.0" && model.tier === "literature");
  assert.equal(fitted.useCeiling, "design_support", "a literature model carries design support and no more");
  assert.match(String(fitted.scope), /KEYNOTE-010、OAK/, "its range is written from the trials it was fitted on");
});

test("deleting a study hides it from 虚拟临研 and keeps what it recorded", options, async () => {
  const { study } = await furnish("delete");
  const before = await store.one("SELECT count(*)::integer AS n FROM evimed_vcr.audit WHERE study_id = $1", [study.id]);
  assert.ok(Number(before.n) > 0, "every write that changes what a reader sees wrote an audit row");
  const deleted = await service.deleteStudy({ id: study.userId }, study.id);
  assert.deepEqual(deleted, { id: study.id, projectId: study.projectId, deleted: true });
  assert.equal(await store.getStudy(study.userId, study.id), null, "hidden from every lookup that takes an account");
  assert.equal((await service.listStudies({ id: study.userId })).studies.find((row) => row.id === study.id), undefined);
  assert.equal((await store.activeStudies()).find((row) => row.id === study.id), undefined, "and from the orchestrator's tick");

  // Deletion here is hiding, not erasing: the project's conversations and
  // files stay, the study's own rows stay, and the audit — which is what a
  // sponsor's computerized-system validation reads — is never off.
  const after = await store.one("SELECT count(*)::integer AS n FROM evimed_vcr.audit WHERE study_id = $1", [study.id]);
  assert.ok(Number(after.n) > Number(before.n), "the deletion itself is audited");
  const results = await store.one("SELECT count(*)::integer AS n FROM evimed_vcr.results WHERE study_id = $1", [study.id]);
  assert.ok(Number(results.n) > 0, "the rows are still there behind the hidden study");
});
