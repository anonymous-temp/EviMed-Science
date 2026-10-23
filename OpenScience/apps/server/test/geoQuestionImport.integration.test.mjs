import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { enqueueRound, geoMeasureState, tickProbe } from "../src/geoProbeQueue.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { startFakeProbe } from "./helpers/geoMeasureFixtures.mjs";
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl };
let database, isolated, store, service, measure;
before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoimport");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database });
  await store.ready();
  service = new GeoService({ store, config: { geoEnabled: true } });
  measure = new GeoMeasureStore(database);
});
after(async () => { await database?.close(); await isolated?.drop(); });
const owner = { id: "import-owner" };
const contract = { samplingMode: "one_shot", engines: ["deepseek"], repeats: 1, metricIds: ["M-01", "M-06"], reportPresentation: "summary", sourceBasis: "answers" };
const input = { requestKey: "original-file", contract, rows: [
  { text: "  Original question?\n", originalId: "001", originalGroup: "Buying", clientTags: ["  Client group  ", "Line1\nLine2"], pool: "P2" },
  { text: "Original question?", originalId: "002" },
] };
async function project(suffix) { return store.createProject({ userId: owner.id, projectId: `import-${suffix}`, engines: ["deepseek"], coverageDays: 90 }); }
test("immutable originals, concurrent save/start retries, runtime parity and member authorization", options, async () => {
  const p = await project("versions");
  const preview = await service.previewQuestions(owner, p.id, input);
  assert.equal(preview.plannedCalls, 2);
  const [a, b] = await Promise.all([service.saveQuestions(owner, p.id, input), service.saveQuestions(owner, p.id, input)]);
  assert.equal(a.version, b.version);
  const read = await service.questions(owner, p.id, a.version);
  assert.equal(read.groups[0].questions[0].text, input.rows[0].text);
  assert.deepEqual(read.groups[0].questions[0].clientTags, ["  Client group  ", "Line1\nLine2"]);
  assert.equal(read.groups[1].questions[0].pool, null);
  assert.equal(read.contract.samplingMode, "one_shot");
  await assert.rejects(service.saveQuestions(owner, p.id, { ...input, note: "changed" }), { code: "geo_request_key_conflict" });
  const native = await geoRuntimeWrite({ store, project: await store.getProject(owner.id, p.id), what: "questions", body: { data: { ...input, requestKey: "revision", rows: [{ text: "Edited?" }] } } });
  assert.equal(native.version, a.version + 1);
  assert.equal((await service.questions(owner, p.id, a.version)).groups[0].questions[0].text, input.rows[0].text);
  await assert.rejects(service.previewQuestions({ id: "outsider" }, p.id, input), { status: 404 });
  await store.addMember({ geoId: p.id, userId: "viewer", role: "viewer", invitedBy: owner.id });
  await assert.rejects(service.saveQuestions({ id: "viewer" }, p.id, input), { status: 403 });
  await assert.rejects(service.startDiagnosis({ id: "viewer" }, p.id, { version: 1, requestKey: "start" }), { status: 403 });
  await store.addMember({ geoId: p.id, userId: "editor", role: "editor", invitedBy: owner.id });
  const starts = await Promise.all([service.startDiagnosis({ id: "editor" }, p.id, { version: 1, requestKey: "start" }), service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start" })]);
  assert.equal(starts[0].roundId, starts[1].roundId);
  assert.equal(starts[0].planned, 2);
  await assert.rejects(service.startDiagnosis(owner, p.id, { version: 2, requestKey: "start" }), { code: "geo_request_key_conflict" });
  const jobs = (await store.query("SELECT * FROM evimed_geo.probe_jobs WHERE round_id=$1", [starts[0].roundId])).rows;
  assert.equal(jobs.length, 2);
  for (const job of jobs) await measure.insertSnapshot({ id: `snapshot-${job.id}`, userId: owner.id, roundId: starts[0].roundId, geoProjectId: p.id,
    questionId: job.question_id, engine: "deepseek", askedAt: new Date(), status: "valid", answerText: "Preserved answer", answerSha256: null,
    citations: [], screenshotSha256: null, surface: { mode: "web" }, latencyMs: 1, warnings: [], probeJobId: job.id });
  const tagged = await service.questions(owner, p.id, { round: starts[0].roundId, clientTags: ["Line1\nLine2"] });
  assert.equal(tagged.groups.flatMap((group) => group.questions).length, 1);
  const answered = await service.questions(owner, p.id, 1);
  for (const question of answered.groups.flatMap((group) => group.questions)) assert.equal(question.answers[0].snapshotId, `snapshot-${jobs.find((job) => job.question_id === question.id).id}`);
  await store.query("UPDATE evimed_geo.probe_jobs SET status='leased', lease_until=now()-interval '1 minute' WHERE round_id=$1", [starts[0].roundId]);
  await measure.recoverExpiredLeases(new Date());
  const recovered = (await store.query("SELECT status,error_code FROM evimed_geo.probe_jobs WHERE round_id=$1", [starts[0].roundId])).rows;
  assert.ok(recovered.every((job) => job.status === "done"), "preserved success before a worker crash is reconciled without another call");
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed' WHERE id=$1", [jobs[0].id]);
  assert.equal((await service.diagnosisProgress(owner, p.id, starts[0].roundId)).cells.find((cell) => cell.jobId === jobs[0].id).recoverable, false);
  await assert.rejects(service.recoverDiagnosis(owner, p.id, starts[0].roundId, { requestKey: "preserved-success", jobIds: [jobs[0].id], acknowledgeUnknown: true }), { code: "geo_recovery_invalid" });
});
test("one-shot failed and refused cells are kept after one provider call without automatic paid retries", options, async () => {
  const p = await project("calls");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Failed question" }, { text: "Refused question" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "diagnose" });
  const probe = await startFakeProbe({ ask: ({ question }) => question.startsWith("Failed") ? { rawStatus: "failed", answer: "", screenshot: null } : { answer: "抱歉，我无法提供医疗建议，请咨询专业医生。", screenshot: null } });
  try {
    const now = new Date();
    const state = geoMeasureState();
    const deps = { store: measure, config: { geoProbeUrl: probe.url, geoProbeTimeoutMs: 1000, geoWeeklyAskCap: 1500 }, state, now: () => now, maxAsks: 10 };
    const first = await tickProbe(deps);
    assert.equal(first.retried, 0);
    now.setTime(now.getTime() + 15 * 60_000);
    await tickProbe(deps);
    assert.equal(probe.asks.length, 2);
    const snapshots = (await store.query("SELECT status FROM evimed_geo.snapshots WHERE round_id=$1", [started.roundId])).rows;
    assert.deepEqual(snapshots.map((s) => s.status).sort(), ["failed", "refusal"]);
    assert.equal((await measure.round(started.roundId)).status, "partial");
    const retry = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "diagnose" });
    assert.equal(retry.roundId, started.roundId);
  } finally { await probe.close(); }
});

test("scoped questions preserve worksheet order and retain unanswered planned cells in the selected version", options, async () => {
  const p = await project("scope");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "First", originalGroup: "A" }, { text: "Second", originalGroup: "B" }, { text: "Third", originalGroup: "A" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "scope-round" });
  await service.saveQuestions(owner, p.id, { ...input, requestKey: "scope-v2", rows: [{ text: "Latest" }] });
  const scope = { round: started.roundId, engines: ["deepseek"] };
  const view = await service.questions(owner, p.id, scope);
  const questions = view.groups.flatMap((group) => group.questions).sort((a, b) => a.originalRowIndex - b.originalRowIndex);
  assert.deepEqual(questions.map((q) => q.text), ["First", "Second", "Third"]);
  assert.ok(questions.every((q) => q.answers.length === 0));
  assert.equal(view.version, 1);
  assert.equal(view.selection.counts.planned, 3);
  const runtime = await service.runtimeRead(await store.getProject(owner.id, p.id), "questions", scope);
  assert.equal(runtime.selection.reference, view.selection.reference);
  assert.equal((await service.questions(owner, p.id)).version, 2);
  assert.equal((await service.questions(owner, p.id, { selectionRef: view.selection.reference })).selection.reference, view.selection.reference);
});

test("explicit one-generation recovery is idempotent, authorized, and excludes successful answers", options, async () => {
  const p = await project("recovery");
  await service.saveQuestions(owner, p.id, input);
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "recovery-start" });
  const jobs = (await store.query("SELECT * FROM evimed_geo.probe_jobs WHERE round_id=$1 ORDER BY id", [started.roundId])).rows;
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed',error_code='delivery_unknown_no_automatic_retry' WHERE id=$1", [jobs[0].id]);
  await store.query("UPDATE evimed_geo.probe_jobs SET status='done' WHERE id=$1", [jobs[1].id]);
  const data = { requestKey: "recover", jobIds: [jobs[0].id], acknowledgeUnknown: true };
  assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells.filter((c) => c.recoverable).length, 1);
  await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { ...data, acknowledgeUnknown: false }), { code: "geo_recovery_acknowledgment_required" });
  await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { ...data, jobIds: [jobs[1].id] }), { code: "geo_recovery_invalid" });
  await assert.rejects(service.diagnosisProgress({ id: "outsider" }, p.id, started.roundId), { status: 404 });
  await store.addMember({ geoId: p.id, userId: "recovery-viewer", role: "viewer", invitedBy: owner.id });
  await assert.rejects(service.recoverDiagnosis({ id: "recovery-viewer" }, p.id, started.roundId, data), { status: 403 });
  const [a, b] = await Promise.all([service.recoverDiagnosis(owner, p.id, started.roundId, data), service.recoverDiagnosis(owner, p.id, started.roundId, data)]);
  assert.equal(a.roundId, b.roundId);
  await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { ...data, requestKey: "again" }), { code: "geo_recovery_exhausted" });
  assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells.some((c) => c.recoverable), false);
  const progress = await service.diagnosisProgress(owner, p.id, a.roundId);
  assert.equal(progress.recoveryOf, started.roundId);
  assert.equal(progress.planned, 1);
  assert.equal(progress.cells[0].questionId, jobs[0].question_id);
  await assert.rejects(service.recoverDiagnosis(owner, p.id, a.roundId, data), { code: "geo_recovery_exhausted" });
});

test("recurring measurement selects the contract version over a previously locked legacy set", options, async () => {
  const p = await project("recurring");
  await store.writeQuestionSet(owner.id, p.id, { groups: [{ name: "Legacy", pool: "P2", questions: [{ text: "Legacy question", isMeasured: true }] }] });
  await store.lockQuestionSet(p.id, 1, 1);
  await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, samplingMode: "recurring", repeats: 3 }, rows: [{ text: "Current contract question" }] });
  const selected = await measure.measuredQuestions(p.id);
  assert.equal(selected.setVersion, 2);
  assert.deepEqual(selected.questions.map((q) => q.text), ["Current contract question"]);
});

test("configured inclusion adapter reaches both HTTP service and native start without a live provider call", options, async () => {
  const p = await project("inclusion");
  const inclusion = { engines: () => ["baidu"] };
  await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, engines: ["baidu"] }, rows: [{ text: "Inclusion question" }] });
  service.inclusion = inclusion;
  try {
    const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "inclusion-start" });
    assert.equal(started.planned, 1);
    assert.deepEqual(started.absentEngines, []);
    const native = await geoRuntimeWrite({ store, project: await store.getProject(owner.id, p.id), inclusion, what: "start_diagnosis", body: { data: { version: 1, requestKey: "native-inclusion-start" } } });
    assert.equal(native.planned, 1);
    assert.equal((await service.diagnosisProgress(owner, p.id, native.roundId)).cells[0].engine, "baidu");
  } finally { service.inclusion = null; }
});

test("one-shot questions refuse every automatic sampling path including error confirmation", options, async () => {
  const p = await project("no-automatic");
  await service.saveQuestions(owner, p.id, input);
  const questions = (await store.questionMap(p.id, 1)).flatMap((group) => group.questions);
  for (const kind of ["confirm", "baseline", "weekly", "noise", "sentinel"]) {
    await assert.rejects(enqueueRound({ store: measure }, { geoProjectId: p.id, kind, questionIds: [questions[0].id], engines: ["deepseek"], repeat: 10 }), { code: "geo_round_question_invalid" });
  }
  assert.equal((await store.query("SELECT count(*)::integer AS n FROM evimed_geo.rounds WHERE geo_project_id=$1", [p.id])).rows[0].n, 0);
});

test("one-shot inclusion submit failures and failed polls cannot resubmit a paid request", options, async () => {
  await store.query("UPDATE evimed_geo.probe_jobs SET status='skipped' WHERE engine='baidu'");
  for (const mode of ["submit", "poll"]) {
    const p = await project(`inclusion-${mode}`);
    let submits = 0;
    const inclusion = { engines: () => ["baidu"], submit: async () => { submits += 1; if (mode === "submit") throw new Error("delivery unknown"); return { requestId: "held-request" }; },
      poll: async () => ({ status: "failed", hit: null, citations: [], answerText: null }) };
    service.inclusion = inclusion;
    try {
      await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, engines: ["baidu"] }, rows: [{ text: "Inclusion once" }] });
      const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start" });
      const now = new Date();
      const deps = { store: measure, inclusion, config: { geoWeeklyAskCap: 1500 }, state: geoMeasureState(), now: () => now, maxAsks: 10 };
      await tickProbe(deps);
      now.setTime(now.getTime() + 20 * 60_000);
      await tickProbe(deps);
      now.setTime(now.getTime() + 20 * 60_000);
      await tickProbe(deps);
      assert.equal(submits, 1, mode);
      assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells[0].status, "failed", mode);
    } finally { service.inclusion = null; }
  }
});

test("legacy groups edits cannot discard an imported measurement agreement", options, async () => {
  const p = await project("preserve-contract");
  await service.saveQuestions(owner, p.id, input);
  await assert.rejects(geoRuntimeWrite({ store, project: await store.getProject(owner.id, p.id), what: "questions", body: { data: { groups: [{ name: "Rewritten", pool: "P2", questions: [{ text: "Replacement", isMeasured: true }] }] } } }), { code: "geo_contract_missing" });
  assert.equal((await store.questionSets(p.id)).length, 1);
  assert.equal((await service.questions(owner, p.id)).groups[0].questions[0].text, input.rows[0].text);
});

test("known local non-dispatch failures recover without an unknown-charge acknowledgment", options, async () => {
  const p = await project("known-not-sent");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Question" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start" });
  const progress = await service.diagnosisProgress(owner, p.id, started.roundId);
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed',error_code='geo_probe_endpoint_invalid' WHERE round_id=$1", [started.roundId]);
  const updated = await service.diagnosisProgress(owner, p.id, started.roundId);
  assert.equal(updated.cells[0].deliveryUnknown, false);
  const recovered = await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "recover-known", jobIds: [progress.cells[0].jobId] });
  assert.equal(recovered.planned, 1);
});
