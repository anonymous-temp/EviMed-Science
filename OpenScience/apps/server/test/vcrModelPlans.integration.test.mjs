// The model analysis plan on PostgreSQL: a version is frozen under the study's lock and never edited, the freeze
// happens at the instant the analysis plan freezes and before the outcome columns lift, a second version says what
// changed, and the two new export kinds reach a database that already has the exports table. Skipped when
// OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { VCR_EXPORT_KINDS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createVcrModelPlans, modelPlanContentHash } from "../src/vcrModelDocuments.mjs";
import { migrateVcr } from "../src/vcrPersistence.mjs";
import { createVcrSeal, vcrSealState } from "../src/vcrSeal.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrStore} */
let store;
/** @type {VcrService} */
let service;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "mplan");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config: { vcrEnabled: true, vcrAudience: "all" } });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

let counter = 0;
/** A study with a definition, an assumption and one assessed model — the records a plan is generated from. @param {string} [intendedUse] */
async function furnish(intendedUse = "specified_analysis") {
  counter += 1;
  const study = await store.createStudy({ userId: `u_mp${counter}`, projectId: `prj_mp${counter}`, name: `EV-${counter}`, question: "外部对照能否用？", intendedUse });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, pico: { population: "二线 NSCLC" }, estimand: { kind: "ATT" }, endpointType: "time_to_event" });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median", name: "对照组中位生存", pointValue: 12, unit: "months",
    sourceKind: "external_evidence", valueSource: "aggregate" });
  await store.saveModelAssessment({ studyId: study.id, userId: study.userId, actor: "runtime", record: {
    key: "survival_projection", modelName: "reference-time-to-event", modelVersion: "1.0.0", questionOfInterest: "外部对照的生存基准能否用",
    contextOfUse: "生成对照臂事件时间", influence: "medium", influenceJustification: "与文献对照一起使用", consequence: "high",
    consequenceJustification: "错判会让无效疗法进入关键试验", riskJustification: "后果为高", impact: "low", impactJustification: "做法已有讨论",
    technicalCriteria: ["重建曲线通过质控"], appropriateness: "覆盖终点" } });
  return /** @type {any} */ (await store.studyById(study.id));
}

test("an assessment is the next version under its key, its risk is derived and a typed one is ignored, and the current version is what is read", options, async () => {
  const study = await furnish();
  const first = (await store.modelAssessments(study.id))[0];
  assert.deepEqual([first.key, first.version, first.risk, first.riskRule], ["survival_projection", 1, "high", "driven_by_consequence"]);
  await store.saveModelAssessment({ studyId: study.id, userId: study.userId, record: { ...first, risk: "low", influence: "low", consequence: "low" } });
  const [now] = await store.modelAssessments(study.id);
  assert.deepEqual([now.version, now.influence, now.risk, now.riskRule], [2, "low", "low", "both_low"], "the two ratings decide, whatever the record said");
  const rows = await database.query("SELECT version, risk FROM evimed_vcr.model_assessments WHERE study_id = $1 ORDER BY version", [study.id]);
  assert.deepEqual(rows.rows.map((row) => [row.version, row.risk]), [[1, "high"], [2, "low"]], "the first version is still there");
  await assert.rejects(database.query(`INSERT INTO evimed_vcr.model_assessments (id, study_id, user_id, key, version, risk) VALUES ('x', $1, 'u', 'k', 1, 'severe')`, [study.id]),
    /check/i, "a risk outside the three words is refused by the schema");
});

test("a plan is frozen once per content: the same content is no new version, changed content is the next one with what changed", options, async () => {
  const study = await furnish();
  const plans = createVcrModelPlans({ store, now: () => new Date("2026-10-04T08:00:00.000Z") });
  const first = /** @type {any} */ (await plans.freeze({ studyId: study.id, actor: "orchestrator", seal: { planVersion: 1, planHash: "a".repeat(64) } }));
  assert.equal(first.created, true);
  assert.deepEqual([first.plan.version, first.plan.frozenBy, first.plan.frozenAt, first.plan.sealPlanVersion], [1, "orchestrator", "2026-10-04T08:00:00.000Z", 1]);
  assert.equal(first.plan.contentHash, modelPlanContentHash(first.plan.content));
  assert.deepEqual(first.plan.changes, [], "the first version changes nothing");
  const again = /** @type {any} */ (await plans.freeze({ studyId: study.id, actor: "runtime" }));
  assert.equal(again.created, false, "frozen again with the same content is no new version");
  assert.deepEqual([again.plan.version, again.plan.frozenBy], [1, "orchestrator"], "and the first freeze keeps its time and its author");

  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median", name: "对照组中位生存", pointValue: 15, unit: "months",
    sourceKind: "external_evidence", valueSource: "aggregate" });
  const second = /** @type {any} */ (await plans.freeze({ studyId: study.id, actor: "runtime" }));
  assert.equal(second.created, true);
  assert.equal(second.plan.version, 2);
  assert.deepEqual(second.plan.changes.map((/** @type {any} */ entry) => entry.text), ["假设「对照组中位生存」的取值由 12 改为 15"]);
  const versions = await store.modelPlanVersions(study.id);
  assert.deepEqual(versions.map((version) => version.version), [2, 1], "newest first, and the first is still there");
  assert.equal(JSON.stringify(versions[1].content), JSON.stringify(first.plan.content), "byte for byte what was frozen");
});

test("two freezes of the same content arriving together make one version", options, async () => {
  const study = await furnish();
  const plans = createVcrModelPlans({ store });
  const [a, b] = /** @type {any[]} */ (await Promise.all([plans.freeze({ studyId: study.id, actor: "a" }), plans.freeze({ studyId: study.id, actor: "b" })]));
  assert.equal([a, b].filter((one) => one.created).length, 1);
  assert.equal((await store.modelPlanVersions(study.id)).length, 1);
});

test("a frozen version cannot be edited: the database refuses the update, and deleting the study still takes it away", options, async () => {
  const study = await furnish();
  const frozen = /** @type {any} */ (await createVcrModelPlans({ store }).freeze({ studyId: study.id, actor: "orchestrator" }));
  for (const statement of [
    "UPDATE evimed_vcr.model_plan_versions SET content = '{}'::jsonb WHERE id = $1",
    "UPDATE evimed_vcr.model_plan_versions SET frozen_at = now() WHERE id = $1",
    "UPDATE evimed_vcr.model_plan_versions SET content_hash = 'x', frozen_by = 'someone' WHERE id = $1",
  ]) {
    await assert.rejects(database.query(statement, [frozen.plan.id]), /frozen model analysis plan is not edited/, statement);
  }
  const held = (await store.modelPlanVersions(study.id))[0];
  assert.deepEqual([held.contentHash, held.frozenBy], [frozen.plan.contentHash, "orchestrator"], "nothing moved");
  await database.query("DELETE FROM evimed_vcr.studies WHERE id = $1", [study.id]);
  assert.equal((await database.query("SELECT 1 FROM evimed_vcr.model_plan_versions WHERE study_id = $1", [study.id])).rowCount, 0, "a deleted study takes its plans with it");
});

test("the plan freezes with the analysis plan, at its instant and before the outcome columns lift; a later freeze after an outcome was read says so", options, async () => {
  const study = await furnish();
  /** @type {string[]} */
  const order = [];
  const plans = createVcrModelPlans({ store });
  const seal = createVcrSeal({
    store,
    modelPlans: { async freeze(input) { const done = await plans.freeze(input); order.push("model-plan-frozen"); return done; } },
    dataPlane: { async liftStudySeal() {
      const frozen = await store.modelPlanVersions(study.id);
      order.push(`lift(sees ${frozen.length} plan version${frozen.length === 1 ? "" : "s"})`);
      return [];
    } },
    now: () => new Date("2026-10-04T09:00:00.000Z"),
  });
  const plan = { estimand: { kind: "ATT" }, endpoint: { type: "time_to_event" }, intendedUse: "specified_analysis", assumptions: ["control_median@1"] };
  const frozen = await seal.freezePlan({ studyId: study.id, plan, actor: "orchestrator" });
  assert.deepEqual(order, ["model-plan-frozen", "lift(sees 1 plan version)"], "the model analysis plan is written before the seal lifts");
  assert.equal(frozen.modelPlan?.version, 1);
  const [first] = await store.modelPlanVersions(study.id);
  assert.equal(first.frozenAt, frozen.planFrozenAt, "the same instant as the analysis plan");
  assert.deepEqual([first.sealPlanVersion, first.sealPlanHash, first.outcomeFirstReadAt], [frozen.planVersion, frozen.planHash, null]);

  // An outcome is read; then the records move and the analysis plan freezes again: a second version, honest about when.
  await seal.recordOutcomeAccess({ studyId: study.id, fields: ["pfs_time"], actor: "analyst" });
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median", name: "对照组中位生存", pointValue: 15, unit: "months",
    sourceKind: "external_evidence", valueSource: "aggregate" });
  const second = await seal.freezePlan({ studyId: study.id, plan: { ...plan, assumptions: ["control_median@2"] }, actor: "orchestrator" });
  assert.equal(second.modelPlan?.version, 2);
  const [latest] = await store.modelPlanVersions(study.id);
  assert.notEqual(latest.outcomeFirstReadAt, null, "the version records that an outcome had been read when it was frozen");
  assert.equal(latest.sealPlanVersion, second.planVersion);
  const state = vcrSealState(/** @type {any} */ (await store.studyById(study.id)));
  assert.equal(state.planVersion, 2);
});

test("a model analysis plan that cannot be frozen never stops the analysis plan from freezing, and the failure is on the audit trail", options, async () => {
  const study = await furnish();
  const seal = createVcrSeal({
    store, modelPlans: { async freeze() { throw Object.assign(new Error("boom"), { code: "XX000" }); } },
  });
  const frozen = await seal.freezePlan({ studyId: study.id, plan: { intendedUse: "specified_analysis", estimand: { kind: "ATT" } }, actor: "runtime" });
  assert.ok(frozen?.planFrozenAt, "the analysis plan is frozen");
  assert.equal(frozen?.modelPlan, null);
  const audit = await database.query("SELECT action, outcome, reason FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.model_plan.freeze_failed'", [study.id]);
  assert.deepEqual(audit.rows.map((row) => [row.outcome, row.reason]), [["failed", "XX000"]]);
});

test("the report model carries the model analysis block only for the two documents, built from the same reads the freeze used", options, async () => {
  const study = await furnish();
  await createVcrModelPlans({ store }).freeze({ studyId: study.id, actor: "orchestrator" });
  const plain = await service.reportModel(study, { kind: "study_package" });
  assert.equal(plain.modelAnalysis, undefined);
  const model = await service.reportModel(study, { kind: "model_analysis_report" });
  assert.equal(model.modelAnalysis.plan.version, 1);
  assert.deepEqual(model.modelAnalysis.deviations, [], "nothing moved since the freeze: the reads agree, so no phantom deviation");
  assert.equal(model.modelAnalysis.current.assessments.length, 1);
  await store.saveAssumption({ studyId: study.id, userId: study.userId, key: "control_median", name: "对照组中位生存", pointValue: 15, unit: "months",
    sourceKind: "external_evidence", valueSource: "aggregate" });
  const moved = await service.reportModel(study, { kind: "model_analysis_report" });
  assert.deepEqual(moved.modelAnalysis.deviations.map((/** @type {any} */ entry) => entry.text), ["假设「对照组中位生存」的取值由 12 改为 15"]);
});

test("the two new export kinds reach a database that was created before them: the migration replaces the old CHECK", options, async () => {
  // Make this database look like one created by the previous release: the old four words in the exports CHECK.
  const constraint = (await database.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'evimed_vcr' AND r.relname = 'exports' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%study_package%'`)).rows[0];
  await database.query(`ALTER TABLE evimed_vcr.exports DROP CONSTRAINT "${constraint.conname}"`);
  await database.query(`ALTER TABLE evimed_vcr.exports ADD CONSTRAINT old_kinds CHECK (kind IN ('study_package', 'cde_communication_pack', 'simulation_report', 'validation_pack'))`);
  const study = await furnish();
  await assert.rejects(store.createExport({ studyId: study.id, userId: study.userId, kind: "model_analysis_plan" }), /check|violates/i, "the old database refuses a word it has never heard");
  // A new start of the control plane runs the migration again, on a database object of its own.
  const restarted = new ControlPlaneDatabase({ databaseUrl: /** @type {any} */ (isolated).url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateVcr(restarted);
    const restartedStore = new VcrStore({ database: restarted });
    for (const kind of VCR_EXPORT_KINDS) {
      const row = await restartedStore.createExport({ studyId: study.id, userId: study.userId, kind });
      assert.equal(row.kind, kind);
    }
  } finally { await restarted.close(); }
});
