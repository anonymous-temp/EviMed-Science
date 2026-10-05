// What one study's second opinions cost, replayed: the same working session
// against the policy that was running on 2026-10-04 and against this one.
//
// The module's own code never calls the reviewer; the orchestrator asks the
// platform's review queue for a pair of reviews (clinical, statistical) of the
// frozen study. The queue was asked every time the compute queue drained, with no
// run id, so a study edited in bursts paid for a pair per burst and none of it was
// attributed. Here the session is: three bursts of edits and recomputation five
// minutes apart, a quiet half hour, a package finished by a run, and the run that
// finishes the programme.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ReviewService } from "../src/reviewService.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrOrchestrator, VCR_REVIEW_QUIET_MS, vcrReviewDue } from "../src/vcrOrchestrator.mjs";
import { createVcrReviewAdapter } from "../src/vcrReview.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { vcrUsageScope } from "../src/vcrUsageScope.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "A local test PostgreSQL is required." };
/** @type {any} */
let database; let isolated; let jobs;
const MINUTE = 60_000;

const config = { reviewEnabled: true, reviewModel: "qwen3.8-max-0902", reviewApiBase: "https://review.invalid", dashscopeApiKey: "test-key",
  reviewEditorTimeoutMs: 10_000, reviewThinkingBudget: 16_000, reviewMaxOutputTokens: 32_000, userDailySpendLimit: 0, userWeeklySpendLimit: 0 };

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrreviewcost");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5000 });
  await migrateProductStore(database); await migrateUsageLedger(database);
  jobs = new ProductJobs(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development')");
});
after(async () => { await database?.close(); await isolated?.drop(); });

/** The reviewer's streamed answer: one located finding, the cost of reading a study (16 thousand tokens in). */
const answer = (model = "qwen3.8-max-0902") => new Response(`data: ${JSON.stringify({ id: "r", model,
  choices: [{ delta: { content: JSON.stringify({ findings: [{ kind: "none", location: "", evidence: "", fix: "" }], checklist: [], acceptance: [] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 16_000, completion_tokens: 900 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

/** One study, its orchestrator on a clock the test moves, and a reviewer that counts what it is asked. */
async function session(label) {
  const projectId = `${label}-project`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice',$1,$1,1048576)", [projectId]);
  const store = new VcrStore({ database }); await store.ready();
  const study = await store.createStudy({ userId: "alice", projectId, name: label, question: "Describe uncertainty." });
  await store.saveDefinition({ userId: "alice", studyId: study.id, pico: {}, estimand: {}, endpointType: "binary" });
  const bodies = [];
  const reviewer = new ReviewService({ config, database, jobs, store: {}, usageLedger: new UsageLedger(database),
    fetchImpl: async (_url, request) => { bodies.push(JSON.parse(request.body)); return answer(); } });
  reviewer.registerStudyReviewAdapter("vcr", { persist: async () => {} });
  await reviewer.ready();
  const service = new VcrService({ store, config: { vcrMinCell: 5 } });
  /** @type {any} */
  let adapter;
  const orchestrator = new VcrOrchestrator({ store, jobs: new VcrJobs({ store, config: {}, engine: {} }), config: { vcrEnabled: true, vcrAudience: "all" },
    queueReviews: (id, input) => adapter.queue(id, input) });
  adapter = createVcrReviewAdapter({ vcr: { store, service, orchestrator }, reviewService: reviewer });
  let edits = 0;
  return {
    study, store, service, orchestrator, adapter, bodies, projectId,
    /** A retained package of the study as it stands: its cover carries the frozen model and the report. */
    async keptPackage(runId) {
      const exported = await store.createExport({ userId: "alice", studyId: study.id, kind: "study_package" });
      const results = await store.reportSnapshot((snapshot) => service.reportModelFromStore(study, snapshot));
      return store.updateExport(exported.id, { state: "ready", runId, cover: { results, reports: [{ section: "main", template: "Original claim." }] } });
    },
    /** The researcher changes an assumption and the light half recomputes at once: a new state, and a result. */
    async edit() {
      edits += 1;
      await store.saveAssumption({ userId: "alice", studyId: study.id, key: "rate", name: "Rate", pointValue: 0.2 + edits / 100, valueSource: "assumed", sourceKind: "scenario" });
      await store.recordResult({ studyId: study.id, userId: "alice", kind: "population", subjectId: `edit-${edits}`, conclusion: "estimable", counts: { realPatients: 10 * edits }, measures: [], diagnostics: {}, tables: [] });
    },
    /**
     * Minutes pass: everything the study holds is that much older, the orchestrator's tick runs, and whatever review it
     * queued is worked off. (Ageing the rows moves the whole timeline together; the orchestrator's clock is the real one.)
     */
    async minutes(count) {
      for (const table of ["results", "reviews"]) {
        await database.query(`UPDATE evimed_vcr.${table} SET created_at = created_at - make_interval(mins => $2) WHERE study_id = $1`, [study.id, count]);
      }
      await orchestrator.advance(study.id);
      while (await reviewer.processStudyReviews("cost-worker")) { /* this isolated queue only */ }
    },
    async drain() { while (await reviewer.processStudyReviews("cost-worker")) { /* this isolated queue only */ } },
    calls: () => bodies.length,
  };
}

test("the policy asks for a review of a settled state, once: results that stand still, not yet reviewed, recent", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString();
  const due = (input) => vcrReviewDue({ now, ...input });
  assert.equal(due({ lastResultAt: at(3), lastReviewAt: null }), false, "still changing: three minutes is inside the quiet period");
  assert.equal(due({ lastResultAt: at(11), lastReviewAt: null }), true, "stood still for longer than the quiet period");
  assert.equal(due({ lastResultAt: at(11), lastReviewAt: at(5) }), false, "a review newer than the last result already has it");
  assert.equal(due({ lastResultAt: at(11), lastReviewAt: at(40) }), true, "a result newer than the last review wants one");
  assert.equal(due({ lastResultAt: at(60 * 25), lastReviewAt: null }), false, "a study last touched yesterday is not reviewed for being opened");
  assert.equal(due({ lastResultAt: null, lastReviewAt: null }), false, "no result, nothing to settle");
  assert.equal(due({ lastResultAt: "not a time", lastReviewAt: null }), false);
  assert.equal(VCR_REVIEW_QUIET_MS, 10 * MINUTE);
});

test("a working session costs four reviewer calls where it cost eight, and none is attributed to nobody", options, async () => {
  // Before: every burst's drained queue asked for a pair, on the state of that moment (what ran on 2026-10-04).
  const before = await session("before");
  const askedBefore = [];
  for (let burst = 0; burst < 3; burst += 1) {
    await before.edit();
    askedBefore.push(...(await before.adapter.queue(before.study.id, { reason: "compute_finished" })).map((row) => row.reviewId));
    await before.drain();
  }
  const exportRow = await before.keptPackage("run_pkg");
  await before.adapter.queue(before.study.id, { exportId: exportRow.id, runId: "run_pkg", reason: "package_finished" });
  await before.drain();
  await before.adapter.queue(before.study.id, { runId: "run_pkg", reason: "research_finished" });
  await before.drain();
  assert.equal(new Set(askedBefore).size, 6, "three bursts, three distinct states, a pair each");

  // After: the same session, the orchestrator deciding.
  const after = await session("after");
  await after.edit(); await after.minutes(2);
  assert.equal(after.calls(), 0, "two minutes after a burst the study is still changing");
  await after.edit(); await after.minutes(5);
  await after.edit(); await after.minutes(7);
  assert.equal(after.calls(), 0, "seven minutes after the last edit is still inside the quiet period");
  await after.minutes(5);
  assert.equal(after.calls(), 2, "once it has stood still, the state it settled into is reviewed: one pair, not three");
  await after.minutes(30);
  assert.equal(after.calls(), 2, "nothing changed, nothing is asked again");
  const kept = await after.keptPackage("run_pkg");
  await after.adapter.queue(after.study.id, { exportId: kept.id, runId: "run_pkg", reason: "package_finished" });
  await after.drain();
  assert.equal(after.calls(), 4, "a package is a new subject with a report: its pair is asked");
  await after.adapter.queue(after.study.id, { runId: "run_pkg", reason: "research_finished" });
  await after.drain();
  assert.equal(after.calls(), 4, "the finished programme's review of the state already reviewed is the review that exists");

  // The count: 8 asked of the reviewer before this change for this session, 4 now.
  assert.equal(before.calls(), 8, "before: a pair per burst, a pair for the package, none for the unchanged state");
  assert.equal(after.calls(), 4);

  // Every one of those calls is in the ledger under something that asked for it.
  const rows = (await database.query(`SELECT run_id, count(*)::int AS calls FROM evimed_usage.model_requests
    WHERE user_id='alice' AND purpose='review' AND project_id=$1 GROUP BY run_id ORDER BY run_id`, [after.projectId])).rows;
  assert.deepEqual(rows, [{ run_id: "run_pkg", calls: 2 }, { run_id: vcrUsageScope(after.projectId), calls: 2 }]);
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_usage.model_requests WHERE user_id='alice' AND purpose='review' AND run_id IS NULL`)).rows[0].n, 0);

  // And what each call is: no thinking, a bounded answer, the snapshot first.
  for (const body of after.bodies) {
    assert.equal(body.enable_thinking, false);
    assert.ok(body.max_tokens <= 8_000);
    assert.equal(body.messages.length, 2);
  }
});

test("a project's scope is what the module's runs settle with, and only the module's", async () => {
  const { vcrRunUsageScope } = await import("../src/vcrUsageScope.mjs");
  assert.equal(vcrUsageScope("pfs"), "vcr-project-pfs");
  assert.equal(vcrUsageScope("../x"), null);
  assert.equal(vcrRunUsageScope({ dispatchId: "vcr-run-definition-1", projectId: "pfs" }), "vcr-project-pfs");
  assert.equal(vcrRunUsageScope({ dispatchId: "episode-abc", projectId: "pfs" }), null, "an autopilot episode keeps its own scope");
  assert.equal(vcrRunUsageScope({ dispatchId: "vcr-run-definition-1" }), null);
});

test("the same bytes asked of the same reviewer in the same project are answered from the answer already held", options, async () => {
  const s = await session("reuse");
  await s.edit();
  const first = await s.adapter.queue(s.study.id, { reason: "results_settled" });
  await s.drain();
  assert.equal(s.calls(), 2);
  // A different subject over identical bytes (a re-asked review under another export of the same unchanged report is the
  // case this stands for): its own row, its own findings, and no call.
  const frozen = (await database.query("SELECT frozen_input, deterministic, subject FROM evimed_review.reviews WHERE id=$1", [first[0].reviewId])).rows[0];
  const service = new ReviewService({ config, database, jobs, store: {}, usageLedger: new UsageLedger(database), fetchImpl: async () => { throw new Error("no call expected"); } });
  service.registerStudyReviewAdapter("vcr", { persist: async () => {} });
  const again = await service.requestStudyReview({ userId: "alice", projectId: s.projectId }, {
    subjectRef: { kind: "vcr", studyId: s.study.id, exportId: "exp_reuse", reportRevision: "r" }, role: "clinical", nodes: frozen.subject.nodes,
    frozenInput: frozen.frozen_input, deterministic: frozen.deterministic });
  assert.notEqual(again.reviewId, first[0].reviewId);
  while (await service.processStudyReviews("reuse-worker")) { /* this isolated queue only */ }
  const row = (await database.query("SELECT status, error_code, cost, usage, model FROM evimed_review.reviews WHERE id=$1", [again.reviewId])).rows[0];
  assert.equal(row.status, "done");
  assert.equal(row.error_code, null);
  assert.equal(row.usage.reusedFrom, first[0].reviewId);
  assert.equal(Number(row.cost), 0);
  assert.equal(row.model, "qwen3.8-max-0902");
});
