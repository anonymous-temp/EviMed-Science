// The study lead's edit of a model assessment record, through the real routes and the real store (F3): the edit is the next
// version of the record by that person, the risk is derived again and never typed, a frozen model analysis plan keeps what it
// was frozen with, and the next freeze lists the change. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrRoutes } from "../src/vcrRoutes.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { migrateVcr } from "../src/vcrPersistence.mjs";
import { createVcrModelPlans } from "../src/vcrModelDocuments.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [] };

/** @type {any} */ let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */ let isolated = null;
/** @type {VcrStore} */ let store;
/** @type {VcrService} */ let service;
let who = "";

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "massess");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** The routes over the real service and store; only the platform's session is a stub. */
function routes() {
  return createVcrRoutes({
    store: /** @type {any} */ ({ async ensureSessionUser() { return { user: { id: who } }; }, async assertCsrf() {} }),
    vcrStore: store, service, config, maxJsonBytes: 65_536,
  });
}

/** @param {string} method @param {string} url @param {unknown} [body] */
async function call(method, url, body) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { "content-type": "application/json" } });
  const res = { status: 0, body: "", writeHead(/** @type {number} */ status) { this.status = status; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); } };
  try {
    await routes()(req, res);
  } catch (error) {
    const refused = /** @type {any} */ (error);
    return { status: refused.status ?? 500, body: { code: refused.code ?? null } };
  }
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

let counter = 0;
async function furnish() {
  counter += 1;
  const study = await store.createStudy({ userId: `u_ma${counter}`, projectId: `prj_ma${counter}`, name: `EV-${counter}`, question: "外部对照能否用？", intendedUse: "specified_analysis" });
  await store.saveDefinition({ studyId: study.id, userId: study.userId, pico: { population: "二线 NSCLC" }, estimand: { kind: "ATT" }, endpointType: "time_to_event" });
  await store.saveModelAssessment({ studyId: study.id, userId: study.userId, actor: "runtime", record: {
    key: "survival_projection", modelName: "reference-time-to-event", modelVersion: "1.0.0", questionOfInterest: "外部对照的生存基准能否用",
    contextOfUse: "生成对照臂事件时间", influence: "medium", influenceJustification: "与文献对照一起使用", consequence: "high",
    consequenceJustification: "错判会让无效疗法进入关键试验", riskJustification: "后果为高", impact: "low", impactJustification: "做法已有讨论",
    technicalCriteria: ["重建曲线通过质控"], appropriateness: "覆盖终点" } });
  return /** @type {any} */ (await store.studyById(study.id));
}

test("an edit is the next version by the person; the risk follows the two ratings; the run's version stays", options, async () => {
  const study = await furnish();
  who = study.userId;
  const S = `/api/vcr/studies/${study.id}`;
  const edited = await call("POST", `${S}/model-assessments`, { key: "survival_projection", influence: "high", influenceJustification: "唯一依据" });
  assert.equal(edited.status, 201);
  assert.deepEqual([edited.body.data.version, edited.body.data.risk, edited.body.data.riskRule], [2, "high", "both_high"]);

  const rows = (await database.query("SELECT version, risk, saved_by FROM evimed_vcr.model_assessments WHERE study_id = $1 ORDER BY version", [study.id])).rows;
  assert.deepEqual(rows.map((row) => [row.version, row.risk, row.saved_by]), [[1, "high", "runtime"], [2, "high", study.userId]], "both versions are kept, each says who wrote it");
  const [now] = await store.modelAssessments(study.id);
  assert.deepEqual([now.version, now.by, now.influence, now.influenceJustification, now.consequence], [2, study.userId, "high", "唯一依据", "high"]);
  assert.deepEqual([now.modelName, now.technicalCriteria.length, now.appropriateness], ["reference-time-to-event", 1, "覆盖终点"], "what the edit did not name is the record as it stood");

  // The risk is the platform's to work out: a typed one is refused, and two lower ratings lower it.
  assert.equal((await call("POST", `${S}/model-assessments`, { key: "survival_projection", risk: "low" })).status, 400);
  const lowered = await call("POST", `${S}/model-assessments`, { key: "survival_projection", influence: "low", consequence: "low" });
  assert.deepEqual([lowered.body.data.version, lowered.body.data.risk, lowered.body.data.riskRule], [3, "low", "both_low"]);
  assert.equal((await call("POST", `${S}/model-assessments`, { key: "not_a_record", influence: "low" })).body.code, "vcr_assessment_not_found");
});

test("a frozen model analysis plan is not changed by a later edit, and the next freeze lists it", options, async () => {
  const study = await furnish();
  who = study.userId;
  const S = `/api/vcr/studies/${study.id}`;
  const plans = createVcrModelPlans({ store, now: () => new Date("2026-10-04T08:00:00.000Z") });
  const first = /** @type {any} */ (await plans.freeze({ studyId: study.id, actor: "orchestrator" }));
  assert.equal(first.created, true);
  const frozenBytes = JSON.stringify(first.plan.content);

  const edited = await call("POST", `${S}/model-assessments`, { key: "survival_projection", consequence: "low", consequenceJustification: "只用于设计阶段的功效模拟" });
  assert.equal(edited.status, 201);
  const [held] = await store.modelPlanVersions(study.id);
  assert.equal(held.version, 1, "no version was added by the edit");
  assert.equal(JSON.stringify(held.content), frozenBytes, "the frozen plan is byte for byte what was frozen");
  assert.equal((await plans.freeze({ studyId: study.id, actor: "orchestrator" })).created, true, "the changed record is changed content");

  const second = (await store.modelPlanVersions(study.id))[0];
  assert.equal(second.version, 2);
  const lines = second.changes.map((/** @type {any} */ change) => change.text);
  assert.ok(lines.some((line) => /评估记录「survival_projection」的.*由 .* 改为 /.test(line)), `the next freeze lists the change: ${lines.join(" | ")}`);

  // The page shows the person's version, by them, and says the plan is frozen.
  const view = await service.tab({ id: study.userId }, study.id, "patients");
  const record = view.assessments.records[0];
  assert.deepEqual([record.key, record.version, record.savedBy.kind, record.risk, record.riskRule], ["survival_projection", 2, "person", "medium", "driven_by_influence"]);
  assert.equal(view.assessments.plan.version, 2);
  assert.ok(record.riskRuleText && record.rows.some((row) => row.key === "risk" && row.derived));
});

test("a database that already holds assessments gains the writer column in place, and a version written before it names nobody", options, async () => {
  const study = await furnish();
  await database.query("ALTER TABLE evimed_vcr.model_assessments DROP COLUMN saved_by");
  const reopened = new ControlPlaneDatabase({ databaseUrl: /** @type {any} */ (isolated).url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateVcr(reopened);
    const rows = (await reopened.query("SELECT version, saved_by FROM evimed_vcr.model_assessments WHERE study_id = $1", [study.id])).rows;
    assert.deepEqual(rows.map((row) => [row.version, row.saved_by]), [[1, ""]], "the existing version is kept and names nobody");
    const [record] = await new VcrStore({ database: reopened }).modelAssessments(study.id);
    assert.equal(record.by, null, "not the run, not a person: unknown");
  } finally {
    await reopened.close();
  }
});
