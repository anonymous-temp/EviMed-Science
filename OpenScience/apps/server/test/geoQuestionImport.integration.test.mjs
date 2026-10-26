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
async function project(suffix) {
  await measure.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'GEO test','development') ON CONFLICT DO NOTHING", [owner.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'GEO test',1048576) ON CONFLICT DO NOTHING", [owner.id, `import-${suffix}`]);
  return store.createProject({ userId: owner.id, projectId: `import-${suffix}`, engines: ["deepseek"], coverageDays: 90 });
}
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

test("a busy probe is a wait for a one-shot cell too: it is asked once the probe is free, with no attempt spent and nothing failed", options, async () => {
  const p = await project("busy-wait");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Busy question" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "busy-start" });
  // Only this cell's question is busy, and only the first time it is asked (the suite's other rounds share the probe).
  const probe = await startFakeProbe({ ask: ({ question, nth }) => question === "Busy question" && nth === 1 ? { status: 409 } : { answer: "Ours is one option. ".repeat(12), screenshot: null } });
  const job = async () => (await store.query("SELECT status, attempts FROM evimed_geo.probe_jobs WHERE round_id=$1", [started.roundId])).rows[0];
  try {
    const now = new Date();
    const deps = { store: measure, config: { geoProbeUrl: probe.url, geoProbeTimeoutMs: 1000, geoWeeklyAskCap: 1500 }, state: geoMeasureState(), now: () => now, maxAsks: 10 };
    for (let tick = 0; tick < 6 && !probe.asks.some((ask) => ask.question === "Busy question"); tick += 1) { await tickProbe(deps); now.setTime(now.getTime() + 15 * 60_000); }
    const waiting = await job();
    assert.deepEqual([waiting.status, Number(waiting.attempts)], ["queued", 0], "the refusal of a busy probe cost the cell nothing");
    for (let tick = 0; tick < 6 && (await job()).status !== "done"; tick += 1) { await tickProbe(deps); now.setTime(now.getTime() + 15 * 60_000); }
    assert.equal(probe.asks.filter((ask) => ask.question === "Busy question").length, 2);
    assert.equal((await job()).status, "done");
    assert.deepEqual((await store.query("SELECT status FROM evimed_geo.snapshots WHERE round_id=$1", [started.roundId])).rows.map((row) => row.status), ["valid"]);
  } finally { await probe.close(); }
});

test("an unreachable probe host fails a one-shot cell as never sent: it is recovered without an acknowledgement", options, async () => {
  const p = await project("unreachable");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Unreachable question" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "unreachable-start" });
  // The suite's earlier rounds share the database: only this cell is asked.
  await store.query("UPDATE evimed_geo.probe_jobs SET status='skipped' WHERE status IN ('queued','leased') AND round_id<>$1", [started.roundId]);
  const probe = await startFakeProbe({ ask: () => ({ answer: "never", screenshot: null }) });
  const url = probe.url;
  await probe.close();
  const deps = { store: measure, config: { geoProbeUrl: url, geoProbeTimeoutMs: 1000, geoWeeklyAskCap: 1500 }, state: geoMeasureState(), now: () => new Date(), maxAsks: 10 };
  await tickProbe(deps);
  const [job] = (await store.query("SELECT status, error_code FROM evimed_geo.probe_jobs WHERE round_id=$1", [started.roundId])).rows;
  assert.deepEqual([job.status, job.error_code], ["failed", "geo_probe_unavailable"], "a refused connection never put the ask to the engine");
  const progress = await service.diagnosisProgress(owner, p.id, started.roundId);
  assert.equal(progress.cells[0].deliveryUnknown, false);
  const recovered = await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "unreachable-recover", jobIds: [progress.cells[0].jobId] });
  assert.equal(recovered.planned, 1);
});

test("a cell whose recovery provably never reached the provider may be recovered again; one that may have is not", options, async () => {
  const p = await project("recover-again");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Recovered twice" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "again-start" });
  const [original] = (await store.query("SELECT id FROM evimed_geo.probe_jobs WHERE round_id=$1", [started.roundId])).rows;
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed', error_code='delivery_unknown_no_automatic_retry' WHERE id=$1", [original.id]);
  const first = await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "again-1", jobIds: [original.id], acknowledgeUnknown: true });
  await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "again-early", jobIds: [original.id], acknowledgeUnknown: true }), { code: "geo_recovery_exhausted" },
    "a recovery still queued holds the cell");
  // The probe host was down when the recovery was asked: it cost nothing, so the cell has not had its chance.
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed', error_code='geo_probe_unavailable' WHERE round_id=$1", [first.roundId]);
  assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells[0].recoverable, true);
  const second = await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "again-2", jobIds: [original.id], acknowledgeUnknown: true });
  assert.notEqual(second.roundId, first.roundId);
  // This time it may have reached the provider: no third recovery.
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed', error_code='delivery_unknown_no_automatic_retry' WHERE round_id=$1", [second.roundId]);
  await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "again-3", jobIds: [original.id], acknowledgeUnknown: true }), { code: "geo_recovery_exhausted" });
  assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells[0].recoverable, false);
});

test("recovering an inclusion cell whose paid task was taken asks for the acknowledgement the tool promises", options, async () => {
  const p = await project("inclusion-held-recover");
  await service.saveQuestions(owner, p.id, { ...input, rows: [{ text: "Held inclusion" }, { text: "Failed poll" }] });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "held-start" });
  const jobs = (await store.query("SELECT j.id FROM evimed_geo.probe_jobs j JOIN evimed_geo.questions q ON q.id=j.question_id WHERE j.round_id=$1 ORDER BY q.text", [started.roundId])).rows;
  // The vendor took both tasks (each 1 算力): one was never answered within the hold, the other's poll came back failed.
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed', error_code=CASE WHEN id=$2 THEN 'failed' ELSE 'inclusion_hold_expired' END, external_ref='vendor-'||id WHERE round_id=$1",
    [started.roundId, jobs[0].id]);
  const progress = await service.diagnosisProgress(owner, p.id, started.roundId);
  assert.deepEqual(progress.cells.map((cell) => cell.deliveryUnknown), [true, true], "the page asks for the acknowledgement");
  assert.equal(progress.counts.deliveryUnknown, 2);
  for (const job of jobs) {
    await assert.rejects(service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: `held-${job.id}`, jobIds: [job.id] }), { code: "geo_recovery_acknowledgment_required" });
  }
  const recovered = await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "held-ack", jobIds: jobs.map((job) => job.id), acknowledgeUnknown: true });
  assert.equal(recovered.planned, 2);
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

test("an interleaved legacy groups write cannot discard a newly imported contract", options, async () => {
  const p = await project("legacy-race");
  const original = store.questionSets.bind(store);
  let observed, release;
  const read = new Promise((resolve) => { observed = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  store.questionSets = async (id) => { const sets = await original(id); if (id === p.id) { observed(); await resume; } return sets; };
  const pending = geoRuntimeWrite({ store, project: await store.getProject(owner.id, p.id), what: "questions", body: { data: { groups: [{ name: "Legacy", pool: "P2", questions: [{ text: "Legacy replacement", isMeasured: true }] }] } } });
  try {
    await read;
    await service.saveQuestions(owner, p.id, input);
    release();
    await assert.rejects(pending, { status: 409, code: "geo_contract_missing" });
  } finally { release(); store.questionSets = original; }
  assert.equal((await store.questionSets(p.id)).length, 1);
});

test("unmeasure refuses a stale base when an import commits after its source was read", options, async () => {
  const p = await project("unmeasure-race");
  await service.saveQuestions(owner, p.id, input);
  const questionId = (await store.questionMap(p.id, 1))[0].questions[0].id;
  const original = store.questionMap.bind(store);
  let observed, release;
  const read = new Promise((resolve) => { observed = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  store.questionMap = async (id, version) => { const groups = await original(id, version); if (id === p.id && version === 1) { observed(); await resume; } return groups; };
  const pending = service.unmeasureQuestion(owner, p.id, questionId);
  try {
    await read;
    await service.saveQuestions(owner, p.id, { ...input, requestKey: "new-base", contract: { ...contract, samplingMode: "recurring", repeats: 2 }, rows: [{ text: "Current imported question" }] });
    release();
    await assert.rejects(pending, { status: 409, code: "geo_question_not_current" });
  } finally { release(); store.questionMap = original; }
  const sets = await store.questionSets(p.id);
  assert.equal(sets.length, 2);
  assert.equal(sets[0].contract.samplingMode, "recurring");
  assert.equal((await store.questionMap(p.id, 2))[0].questions[0].text, "Current imported question");
});

test("automatic recurring confirmations honor the saved repeat agreement", options, async () => {
  const p = await project("recurring-confirm");
  await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, samplingMode: "recurring", repeats: 2 }, rows: [{ text: "Recurring question" }] });
  const questionId = (await store.questionMap(p.id, 1))[0].questions[0].id;
  const started = await enqueueRound({ store: measure }, { geoProjectId: p.id, kind: "confirm", questionIds: [questionId], engines: ["deepseek"], repeat: 10 });
  assert.equal(started.planned, 2);
  const progress = await service.diagnosisProgress(owner, p.id, started.roundId);
  assert.equal(progress.contract.repeats, 2);
});

test("definitive local inclusion validation failures retain known non-dispatch state", options, async () => {
  const p = await project("inclusion-local-failure");
  const { GeoInclusionClient } = await import("../src/geoInclusionClient.mjs");
  const { MediaMarketClient } = await import("../src/mediaMarketClient.mjs");
  let requests = 0;
  const market = new MediaMarketClient({ baseUrl: "https://fake.invalid", apiKey: "fake-test-key", minIntervalMs: 0, fetchImpl: async () => { requests += 1; throw new Error("must not call"); } });
  const inclusion = new GeoInclusionClient({ market, config: { geoInclusionEngines: ["baidu"] } });
  service.inclusion = inclusion;
  try {
    await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, engines: ["baidu"] }, rows: [{ text: "No brand words" }] });
    const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start-local-inclusion" });
    await tickProbe({ store: measure, inclusion, config: {}, state: geoMeasureState(), maxAsks: 10 });
    const progress = await service.diagnosisProgress(owner, p.id, started.roundId);
    assert.equal(requests, 0);
    assert.equal(progress.cells[0].errorCode, "media_market_request_invalid");
    assert.equal(progress.cells[0].deliveryUnknown, false);
    await service.recoverDiagnosis(owner, p.id, started.roundId, { requestKey: "recover-known-local", jobIds: [progress.cells[0].jobId] });
  } finally { service.inclusion = null; }
});

test("a preserved inclusion hit rebuilds missing facts before expired lease completion without another paid call", options, async () => {
  for (const hit of [true, false]) {
    const p = await project(`inclusion-preserved-hit-${hit}`);
    await store.query("UPDATE evimed_geo.probe_jobs SET status='skipped' WHERE engine='baidu'");
    service.inclusion = { engines: () => ["baidu"] };
    try {
      await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, engines: ["baidu"] }, rows: [{ text: "Hit question" }] });
      const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start-preserved-hit" });
      await store.query("UPDATE evimed_geo.rounds SET ref=ref||$2::jsonb WHERE id=$1", [started.roundId, JSON.stringify({ evaluationBasis: { product: { brandName: "Frozen brand" } } })]);
      const job = (await store.query("SELECT * FROM evimed_geo.probe_jobs WHERE round_id=$1", [started.roundId])).rows[0];
      await store.query("UPDATE evimed_geo.probe_jobs SET status='leased',external_ref='held-request',lease_until=now()-interval '1 minute' WHERE id=$1", [job.id]);
      await measure.insertSnapshot({ id: `preserved-${job.id}`, userId: owner.id, roundId: started.roundId, geoProjectId: p.id, questionId: job.question_id, engine: "baidu", askedAt: new Date(), status: "valid", answerText: null, answerSha256: null, citations: [], screenshotSha256: null, surface: { mode: "inclusion", hit }, latencyMs: null, warnings: [], probeJobId: job.id });
      await store.query("UPDATE evimed_geo.projects SET product=$2::jsonb WHERE id=$1", [p.id, JSON.stringify({ brandName: "Renamed later" })]);
      let calls = 0;
      await tickProbe({ store: measure, inclusion: { engines: () => ["baidu"], submit: async () => { calls += 1; throw new Error("must not submit"); }, poll: async () => { calls += 1; throw new Error("must not poll"); } }, config: {}, state: geoMeasureState(), maxAsks: 10 });
      assert.equal(calls, 0);
      const rows = await measure.roundFactRows(started.roundId);
      if (hit) assert.equal(rows[0].facts.brands[0].name, "Frozen brand");
      else assert.deepEqual(rows[0].facts.brands, []);
      const { computeGeoMetrics } = await import("@evimed/domain");
      const cell = computeGeoMetrics(rows, { engines: ["baidu"], samplingMode: "one_shot" }).cells.find((entry) => entry.scope === "engine" && entry.engine === "baidu" && entry.metricId === "M-01");
      assert.equal(cell.value, hit ? 100 : 0);
      assert.equal((await service.diagnosisProgress(owner, p.id, started.roundId)).cells[0].status, "done");
    } finally { service.inclusion = null; }
  }
});

test("normal inclusion completion uses the frozen brand after a project rename", options, async () => {
  const p = await project("inclusion-normal-frozen");
  await store.query("UPDATE evimed_geo.probe_jobs SET status='skipped' WHERE engine='baidu'");
  await store.query("UPDATE evimed_geo.projects SET product=$2::jsonb WHERE id=$1", [p.id, JSON.stringify({ brandName: "Original brand" })]);
  const inclusion = { engines: () => ["baidu"], submit: async () => ({ requestId: "frozen-request" }), poll: async () => ({ status: "valid", hit: true }) };
  service.inclusion = inclusion;
  try {
    await service.saveQuestions(owner, p.id, { ...input, contract: { ...contract, engines: ["baidu"] }, rows: [{ text: "Normal completed hit" }] });
    const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "start-normal-frozen" });
    const now = new Date();
    const deps = { store: measure, inclusion, config: {}, state: geoMeasureState(), now: () => now, maxAsks: 10 };
    await tickProbe(deps);
    await store.query("UPDATE evimed_geo.projects SET product=$2::jsonb WHERE id=$1", [p.id, JSON.stringify({ brandName: "Changed brand" })]);
    now.setTime(now.getTime() + 5 * 60_000);
    await tickProbe(deps);
    assert.equal((await measure.roundFactRows(started.roundId))[0].facts.brands[0].name, "Original brand");
  } finally { service.inclusion = null; }
});

test("preview and save share the real round call budget before storing an impossible agreement", options, async () => {
  const p = await project("preview-budget");
  const body = { ...input, contract: { ...contract, samplingMode: "recurring", engines: ["deepseek", "kimi"], repeats: 20 }, rows: Array.from({ length: 126 }, (_, i) => ({ text: `Question ${i}` })) };
  await assert.rejects(service.previewQuestions(owner, p.id, body), { status: 400, code: "geo_question_import_invalid" });
  await assert.rejects(service.saveQuestions(owner, p.id, body), { status: 400, code: "geo_question_import_invalid" });
  assert.equal((await store.questionSets(p.id)).length, 0);
  const admitted = await service.previewQuestions(owner, p.id, { ...body, rows: body.rows.slice(0, 125) });
  assert.equal(admitted.plannedCalls, 5000);
});

test("URL client tags are exact literal labels through PostgreSQL selection and native reads", options, async () => {
  const { geoScopeFromQuery } = await import("../src/geoReadScope.mjs");
  const p = await project("literal-url-tags");
  const labels = ["[高龄]", '["高龄"]', "逗号,标签", "Line1\nLine2"];
  await service.saveQuestions(owner, p.id, { ...input, rows: labels.map((tag, index) => ({ text: `Tagged question ${index}`, originalId: String(index), clientTags: [tag] })) });
  const started = await service.startDiagnosis(owner, p.id, { version: 1, requestKey: "literal-tag-round" });
  const jobs = (await store.query("SELECT * FROM evimed_geo.probe_jobs WHERE round_id=$1 ORDER BY created_at,id", [started.roundId])).rows;
  for (const job of jobs) await measure.insertSnapshot({ id: `tagged-${job.id}`, userId: owner.id, roundId: started.roundId, geoProjectId: p.id,
    questionId: job.question_id, engine: "deepseek", askedAt: new Date(), status: "refusal", answerText: "Preserved refusal", answerSha256: null,
    citations: [], screenshotSha256: null, surface: { mode: "web" }, latencyMs: 1, warnings: [], probeJobId: job.id });
  for (const [index, tag] of labels.entries()) {
    const query = new URLSearchParams({ round: started.roundId, clientTags: tag });
    const filter = geoScopeFromQuery(query);
    const view = await service.questions(owner, p.id, filter);
    const questions = view.groups.flatMap((group) => group.questions);
    assert.deepEqual(filter.clientTags, [tag]);
    assert.equal(questions.length, 1, tag);
    assert.equal(questions[0].originalId, String(index));
    assert.equal(view.selection.counts.snapshots, 1);
    const native = await service.runtimeRead(await store.getProject(owner.id, p.id), "questions", { round: started.roundId, clientTags: [tag] });
    assert.equal(native.selection.reference, view.selection.reference);
  }
});
