// 「为该患者找试验」 on a real PostgreSQL: the page asks for a run of the matching capability that searches the registries for a patient. It
// is recorded as a pending run mark and dispatched by the rules of any programme run — the study active, the one run slot free, the
// allowance asked — so a busy slot makes it wait and say so, a second press for the same patient is the same request, and the run's end
// closes the mark without touching the study's seven steps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { HttpError } from "../src/security.mjs";
import { VcrOrchestrator, vcrTrialSearchBrief } from "../src/vcrOrchestrator.mjs";
import { skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */ let orchestrator;
/** @type {any[]} */ const dispatches = [];
/** @type {{ refuse: string | null }} */ const dispatcher = { refuse: null };
const USER = "u-ts";

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrts", withFrontier: true, users: [USER], config: { vcrStudyCpuBudget: 1_000_000 } });
  const { vcr } = fixture;
  orchestrator = new VcrOrchestrator({
    store: vcr.store, jobs: vcr.jobs, config: { vcrEnabled: true, vcrLeaseMs: 900_000 }, notifier: null, seal: vcr.seal,
    dispatchRun: async (request) => {
      if (dispatcher.refuse) throw new HttpError(402, dispatcher.refuse, "The allowance does not cover this run.");
      dispatches.push(request);
      return { runId: `run-${dispatches.length}`, sessionId: `session-${dispatches.length}`, status: "running" };
    },
  });
});
after(async () => { await fixture?.close(); });

const marks = (studyId) => fixture.vcr.store.rows("SELECT key, state, detail, dispatch_id FROM evimed_vcr.schedule_marks WHERE study_id = $1 AND key LIKE 'run:trial-search:%' ORDER BY created_at", [studyId]);

async function studyOf(name, status = "active") {
  const study = await fixture.vcr.store.createStudy({ userId: USER, projectId: `prj-${name}`, name, question: "二线 NSCLC", dataTier: "T1", intendedUse: "exploratory" });
  if (status !== "active") await fixture.vcr.store.query("UPDATE evimed_vcr.studies SET status = $2 WHERE id = $1", [study.id, status]);
  return study;
}

test("the brief names the patient and the direction, and gives the run no number to repeat", () => {
  const brief = vcrTrialSearchBrief({ study: { name: "EV-201 二线 NSCLC", question: "单臂能否用外部对照", dataTier: "T1", intendedUse: "exploratory" }, subjectKey: "P-0192" });
  assert.match(brief, /给患者找试验/);
  assert.match(brief, /P-0192/);
  assert.match(brief, /vcr-matching/);
  assert.match(brief, /EV-201 二线 NSCLC/);
  assert.ok(brief.length < 700, "a brief is a pointer into the skill, not a second copy of it");
});

test("the request is dispatched as a run of the matching capability, and the run's end closes it without moving a step", skipWithoutDatabase, async () => {
  const { vcr } = fixture;
  const study = await studyOf("dispatch");
  const stepsBefore = JSON.stringify((await vcr.store.studyById(study.id)).steps);
  const answer = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
  // Starting work answers that it was taken and which run it started — and no session to go to: the person stays on the study's page.
  assert.deepEqual(answer, { accepted: true, runId: `run-${dispatches.length}`, step: null, queuedBehind: [] });
  const sent = dispatches.at(-1);
  assert.equal(sent.question, "为 P-0192 找试验", "what a person reads of the run is a sentence of theirs, never the brief");
  assert.equal(sent.attended, true, "a person asked, so the run opens the project's runtime for them");
  assert.equal(sent.capabilityId, "vcr-matching");
  assert.equal(sent.reason, "vcr:trial-search");
  assert.equal(sent.studyId, study.id);
  assert.match(sent.brief, /P-0192/);
  assert.equal(sent.products, undefined, "the run is held to what the capability delivers, whole");
  const [mark] = await marks(study.id);
  assert.equal(mark.state, "running");
  assert.deepEqual([mark.detail.purpose, mark.detail.subjectKey], ["trial_search", "P-0192"]);

  await orchestrator.onRunFinished({ userId: USER, id: study.projectId }, { id: sent.dispatchId, dispatchId: sent.dispatchId, status: "succeeded" });
  assert.equal((await marks(study.id))[0].state, "done");
  assert.equal(JSON.stringify((await vcr.store.studyById(study.id)).steps), stepsBefore, "the seven steps do not move for a patient's search");
});

test("a second press for the same patient while one request is out is the same request; a busy slot makes it wait and says so", skipWithoutDatabase, async () => {
  const study = await studyOf("same");
  const first = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
  assert.ok(first.runId);
  const dispatched = dispatches.length;
  const again = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
  assert.deepEqual([again.accepted, again.runId, "sessionId" in again], [true, null, false], "the study's one run slot is held: taken, not started, no session");
  assert.equal(dispatches.length, dispatched, "and nothing is sent twice");
  assert.equal((await marks(study.id)).length, 1, "one request, one mark");
  // Another patient is another request: it waits for the slot.
  const other = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0201" });
  assert.equal(other.runId, null);
  assert.deepEqual((await marks(study.id)).map((mark) => [mark.detail.subjectKey, mark.state]), [["P-0192", "running"], ["P-0201", "pending"]]);
  // When the first run ends the next pass sends the second.
  const sent = dispatches.at(-1);
  await orchestrator.onRunFinished({ userId: USER, id: study.projectId }, { id: sent.dispatchId, dispatchId: sent.dispatchId, status: "succeeded" });
  assert.equal(dispatches.length, dispatched + 1);
  assert.match(dispatches.at(-1).brief, /P-0201/);
});

test("once a request is over, asking again for the same patient is a new request", skipWithoutDatabase, async () => {
  const study = await studyOf("again");
  await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
  const first = dispatches.at(-1);
  await orchestrator.onRunFinished({ userId: USER, id: study.projectId }, { id: first.dispatchId, dispatchId: first.dispatchId, status: "succeeded" });
  const second = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
  assert.ok(second.runId);
  assert.notEqual(dispatches.at(-1).dispatchId, first.dispatchId);
  assert.deepEqual((await marks(study.id)).map((mark) => mark.state), ["done", "running"]);
});

test("an allowance that does not cover the run leaves the request waiting, and a paused or unknown study refuses it by name", skipWithoutDatabase, async () => {
  const study = await studyOf("allowance");
  dispatcher.refuse = "credits_insufficient";
  try {
    const waiting = await orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "P-0192" });
    assert.equal(waiting.runId, null);
    assert.equal((await marks(study.id))[0].state, "pending", "a top-up releases it on the next pass");
  } finally { dispatcher.refuse = null; }
  const released = dispatches.length;
  await orchestrator.advance(study.id);
  assert.equal(dispatches.length, released + 1);

  const paused = await studyOf("paused", "paused");
  await assert.rejects(orchestrator.requestTrialSearch({ id: USER }, paused, { subjectKey: "P-0192" }), (error) => error.status === 409 && error.code === "vcr_study_paused");
  await assert.rejects(orchestrator.requestTrialSearch({ id: USER }, { id: "std_none" }, { subjectKey: "P-0192" }), (error) => error.status === 404 && error.code === "vcr_study_not_found");
  await assert.rejects(orchestrator.requestTrialSearch({ id: "someone-else" }, study, { subjectKey: "P-0192" }), (error) => error.status === 404, "a stranger finds no study");
  await assert.rejects(orchestrator.requestTrialSearch({ id: USER }, study, { subjectKey: "not a key!" }), (error) => error.status === 400);
});
