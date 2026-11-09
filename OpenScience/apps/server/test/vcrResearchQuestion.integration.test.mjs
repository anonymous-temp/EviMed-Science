// The research question on PostgreSQL (round-2 R22): versions that are rows nobody edits, the page's route over the real service and
// store with the member roles, a job stamped with the version it answers, and a result that reads as answering an earlier version
// once the question moves on. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createVcrRoutes } from "../src/vcrRoutes.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { researchQuestionPremises, resultQuestionInput } from "../src/vcrResearchQuestionView.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [], vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1_200, vcrMaxConcurrentJobs: 1, vcrLeaseMs: 900_000 };

/** @type {any} */ let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */ let isolated = null;
/** @type {VcrStore} */ let store;
/** @type {VcrService} */ let service;
let who = "";

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "rquestion");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

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
  const study = await store.createStudy({ userId: `u_rq${counter}`, projectId: `prj_rq${counter}`, name: `AD-${counter}`, question: "多奈哌齐能否延缓恶化？" });
  return /** @type {any} */ (store.studyById(study.id));
}

test("a patch is the next version row, the row says who wrote each field, an identical patch writes nothing, and the person's edit is kept over a run's write", options, async () => {
  const study = await furnish();
  const ids = { studyId: study.id, userId: study.userId };
  const first = await store.saveResearchQuestion({ ...ids, actor: "runtime", basis: "person_stated", patch: { question: "多奈哌齐在 78 周能否延缓恶化？", variable: { endpoint: "ADAS-Cog 11" } } });
  assert.deepEqual([first.created, first.question?.version, first.question?.id], [true, 1, "main"]);
  const same = await store.saveResearchQuestion({ ...ids, actor: "runtime", basis: "model_assembled", patch: { question: "多奈哌齐在 78 周能否延缓恶化？" } });
  assert.deepEqual([same.created, same.question?.version], [false, 1]);

  who = study.userId;
  const edited = await call("POST", `/api/vcr/studies/${study.id}/research-question`, { question: "页面上改过的问题" });
  assert.equal(edited.status, 201);
  assert.equal(edited.body.data.question.version, 2);
  const run = await store.saveResearchQuestion({ ...ids, actor: "runtime", basis: "person_stated", patch: { question: "对话里又说了一遍", population: { text: "轻中度 AD" } } });
  assert.deepEqual(run.kept, [{ field: "question", basis: "person_edited" }]);
  assert.equal(run.question?.version, 3);
  assert.equal(run.question?.fields.question, "页面上改过的问题", "the page's edit stands");
  assert.deepEqual(run.question?.bases, { question: "person_edited", variable: "person_stated", population: "person_stated" });

  const rows = (await database.query("SELECT version, saved_by, written FROM evimed_vcr.research_questions WHERE study_id = $1 ORDER BY version", [study.id])).rows;
  assert.deepEqual(rows.map((row) => [row.version, row.saved_by, row.written]), [[1, "runtime", ["question", "variable"]], [2, study.userId, ["question"]], [3, "runtime", ["population"]]],
    "every version is kept, each says who wrote it and which fields it changed");
  const audits = (await database.query("SELECT detail FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.research_question.save'", [study.id])).rows;
  assert.equal(audits.length, 3);
});

test("two writes arriving together make two versions in an order, never two rows of one version", options, async () => {
  const study = await furnish();
  const ids = { studyId: study.id, userId: study.userId, actor: "runtime", basis: "model_assembled" };
  const done = await Promise.all(Array.from({ length: 6 }, (_, at) => store.saveResearchQuestion({ ...ids, patch: { assumptions: [{ text: `假设 ${at}`, source: "" }] } })));
  assert.equal(done.filter((entry) => entry.created).length, 6);
  const versions = (await database.query("SELECT version FROM evimed_vcr.research_questions WHERE study_id = $1 ORDER BY version", [study.id])).rows.map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
});

test("members read, only a writer edits, and another account's study reads as one that does not exist", options, async () => {
  const study = await furnish();
  const S = `/api/vcr/studies/${study.id}/research-question`;
  await database.query("INSERT INTO evimed_vcr.members (study_id, user_id, role, invited_by) VALUES ($1, 'u_viewer', 'viewer', $2)", [study.id, study.userId]);
  who = study.userId;
  assert.equal((await call("POST", S, { question: "q" })).status, 201);

  who = "u_viewer";
  const read = await call("GET", S);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.questions[0].fields.question, "q");
  const denied = await call("POST", S, { question: "改一下" });
  assert.deepEqual([denied.status, denied.body.code], [403, "vcr_forbidden"]);

  who = "u_stranger";
  for (const method of ["GET", "POST"]) {
    const refused = await call(method, S, method === "POST" ? { question: "x" } : undefined);
    assert.deepEqual([refused.status, refused.body.code], [404, "vcr_study_not_found"], method);
  }
  assert.equal((await store.researchQuestions(study.id))[0]?.version, 1, "nothing of the refused calls was written");
});

test("a job records the version of the question it answers; the same request after the question moved answers the current one; marks follow", options, async () => {
  const study = await furnish();
  const jobs = new VcrJobs({ store, config, engine: /** @type {any} */ ({ configured: () => true }) });
  const scenario = { design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
    truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 },
    accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"] };

  const before = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario, idempotencyKey: "rq-none" });
  assert.equal((await store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id = $1", [before.job.id])).checkpoint.questionRef, undefined, "a study with no question records none");

  await store.saveResearchQuestion({ studyId: study.id, userId: study.userId, actor: "runtime", basis: "person_stated", patch: { question: "第一个问题" } });
  const v1 = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario: { ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }, idempotencyKey: "rq-one" });
  const row = await store.one("SELECT checkpoint, scenario_hash FROM evimed_vcr.jobs WHERE id = $1", [v1.job.id]);
  assert.deepEqual(row.checkpoint.questionRef, { id: "main", version: 1 });
  assert.equal(JSON.stringify(row.checkpoint).includes("questionRef") && v1.job.scenarioHash === row.scenario_hash, true, "the reference is the job's record; the scenario hash is untouched");

  await store.saveResearchQuestion({ studyId: study.id, userId: study.userId, actor: "runtime", basis: "person_stated",
    patch: { intercurrentEvents: [{ event: "因不良反应停药", strategy: "treatment_policy", mechanism: "" }] } });
  const [question] = await store.researchQuestions(study.id);
  assert.equal(question?.version, 2);
  const job = await store.one("SELECT * FROM evimed_vcr.jobs WHERE id = $1", [v1.job.id]);
  const bundle = { researchQuestion: question, jobs: [{ id: job.id, checkpoint: job.checkpoint }], executions: new Map([["exe_1", { jobId: job.id }]]) };
  const rows = researchQuestionPremises(resultQuestionInput(bundle, { executionId: "exe_1" }, "camd-adas-cog-11"));
  assert.deepEqual(rows.map((entry) => entry.key), ["question:earlier", "question:not_representable", "question:calibration"]);
  assert.match(rows[0].value, /第 1 版.*第 2 版/);
  assert.match(rows[1].value, /这个模拟表示不了/);

  const again = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: "design_simulation", scenario: { ...scenario, truth: { hazardRatio: 0.65, controlMedian: 6 } }, idempotencyKey: "rq-one" });
  assert.equal(again.created, false);
  assert.equal(again.job.id, v1.job.id);
  const restamped = await store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id = $1", [v1.job.id]);
  assert.deepEqual(restamped.checkpoint.questionRef, { id: "main", version: 2 }, "the identical computation requested under the current question answers it");
  assert.deepEqual(researchQuestionPremises(resultQuestionInput({ ...bundle, jobs: [{ id: job.id, checkpoint: restamped.checkpoint }] }, { executionId: "exe_1" }, "camd-adas-cog-11")).map((entry) => entry.key),
    ["question:not_representable", "question:calibration"], "no longer marked");
});
