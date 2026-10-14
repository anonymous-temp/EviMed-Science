// What is going on in a study, what waits for what, and what each step found (R3, 2026-10-14): pure over the marks, the jobs and the
// rows the service gathers, so the read model and the answer of a press cannot disagree.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { VCR_ACTIVITY_TAIL_MS, VCR_STEP_NOTE_MAX, buildVcrActivity, vcrQueueOf, vcrStepSummaries } from "../src/vcrStudyStatus.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";

const NOW = new Date("2026-10-14T10:00:00.000Z");
const at = (/** @type {number} */ secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const mark = (/** @type {Record<string, any>} */ fields) => ({ key: "run:analysis", state: "running", run_id: "run_1", detail: {}, created_at: at(60), updated_at: at(5), ...fields });

test("a queued step waits for the research allowance, the run that is out, or the step whose output it needs", () => {
  const steps = {
    definition: { status: "done" }, evidence: { status: "queued", waiting: "allowance" }, population: { status: "queued" },
    patients: { status: "queued" }, comparator: { status: "running" }, trial: { status: "none" }, matching: { status: "none" },
  };
  // The allowance is named first: it is what the step's own note says it waits on.
  assert.deepEqual(vcrQueueOf({ steps, flight: { steps: ["comparator"] } }), [
    { step: "evidence", waitingFor: "allowance" }, { step: "population", waitingFor: "comparator" }, { step: "patients", waitingFor: "comparator" },
  ]);
  // The run covers population: it is running, not queued, and patients waits for the run's first step.
  assert.deepEqual(vcrQueueOf({ steps: { ...steps, evidence: { status: "done" } }, flight: { steps: ["population", "patients"] } }), []);
  // A run that covers no step (an export) is a run all the same.
  assert.deepEqual(vcrQueueOf({ steps: { population: { status: "queued" } }, flight: { steps: [] } }), [{ step: "population", waitingFor: "run" }]);
  // With nothing out, a step waits on the unfinished step it needs, or on nothing in particular.
  assert.deepEqual(vcrQueueOf({ steps: { definition: { status: "running" }, evidence: { status: "queued" } } }), [{ step: "evidence", waitingFor: "definition" }]);
  assert.deepEqual(vcrQueueOf({ steps: { definition: { status: "done" }, evidence: { status: "queued" } } }), [{ step: "evidence", waitingFor: null }]);
  assert.deepEqual(vcrQueueOf({ steps: { simulated: { status: "queued", waiting: "simulated_allowance" }, population: { status: "queued", waiting: "simulated_allowance" } } }),
    [{ step: "population", waitingFor: "simulated_allowance" }]);
});

test("the activity is null when nothing is going on, which is what a page that polls stops on", () => {
  assert.equal(buildVcrActivity({ now: NOW, steps: { definition: { status: "done" } } }), null);
  // What ended long ago is no activity.
  assert.equal(buildVcrActivity({ now: NOW, steps: {}, last: mark({ state: "done", done_at: at(120), detail: { runStatus: "succeeded", scope: [{ step: "population" }] } }) }), null);
  // Finished jobs and a study's finished runs are no activity; a job that is open is.
  assert.equal(buildVcrActivity({ now: NOW, steps: {}, jobs: [{ id: "job_1", kind: "design_simulation", state: "succeeded", progress: {}, checkpoint: {} }] }), null);
});

test("the run that is out is described by its step, its sentence, its place and what its tool calls added up to — never a percentage", () => {
  const flight = mark({
    detail: { scope: [{ step: "population" }, { step: "patients" }], purpose: "analysis", question: "构建人群、生成虚拟患者", placement: "open-runtime" },
  });
  const progress = {
    currentPhase: "write", phaseCounts: { search: 3, write: 1 }, sources: { searched: 3, included: 2, fullText: 1 }, claims: { total: 4, verified: 3 },
    deliverables: [{ status: "accepted" }, { status: "delegated" }],
  };
  const activity = buildVcrActivity({ now: NOW, steps: { population: { status: "running" }, patients: { status: "running" } }, flight, ledger: { startedAt: at(40), progress } });
  assert.ok(activity?.run);
  assert.deepEqual(activity.run, {
    id: "run_1", step: "population", steps: ["population", "patients"], label: "构建人群、生成虚拟患者", phase: "write",
    counts: { search: 3, included: 2, fullText: 1, claims: 4, claimsVerified: 3, deliverables: 2, deliverablesDone: 1 },
    startedAt: at(40), placement: "open-runtime", locked: false,
  });
  assert.doesNotMatch(JSON.stringify(activity), /percent|progress":\s*\d/);
  // A bounded run holds the project's conversation. A run that is only being sent (claimed: nothing recorded of where it went, found
  // live on the local kernel, where it read "held" for the two seconds before it was sent into the open runtime) says nothing of
  // the project: not held, no place.
  const placed = [flight, mark({ detail: { scope: [{ step: "trial" }], placement: "bounded" } }), mark({ state: "claimed", run_id: null, detail: { scope: [{ step: "trial" }] } })]
    .map((entry) => buildVcrActivity({ now: NOW, steps: {}, flight: entry })?.run);
  assert.deepEqual(placed.map((run) => [run?.placement, run?.locked]), [["open-runtime", false], ["bounded", true], [null, false]]);
  // An older mark with no sentence is told in the person's words from what it covered.
  assert.equal(buildVcrActivity({ now: NOW, steps: {}, flight: mark({ detail: { scope: [{ step: "trial" }] } }) })?.run?.label, "模拟试验方案");
  assert.equal(buildVcrActivity({ now: NOW, steps: {}, flight: mark({ run_id: null, detail: { purpose: "export", kind: "study_package" } }) })?.run?.label, "生成研究包");
});

test("the engine jobs that are open are listed with their step and their done and total, and what just ended is said for a few seconds", () => {
  const jobs = [
    { id: "job_a", kind: "design_simulation", state: "running", progress: { done: 3, total: 10 }, checkpoint: { node: "trial_scenario:scn_1@1" } },
    { id: "job_b", kind: "generate_patients_continuous", state: "queued", progress: {}, checkpoint: {} },
    { id: "job_c", kind: "forecast_trajectories", state: "awaiting_budget", progress: {}, checkpoint: {} },
    { id: "job_d", kind: "build_cohort", state: "succeeded", progress: { done: 1, total: 1 }, checkpoint: {} },
  ];
  const activity = buildVcrActivity({ now: NOW, steps: {}, jobs });
  assert.deepEqual(activity?.jobs, [
    { id: "job_a", kind: "design_simulation", state: "running", step: "trial", done: 3, total: 10 },
    { id: "job_b", kind: "generate_patients_continuous", state: "queued", step: "patients", done: null, total: null },
    { id: "job_c", kind: "forecast_trajectories", state: "awaiting_budget", step: null, done: null, total: null },
  ]);
  const ended = (/** @type {number} */ seconds, /** @type {Record<string, any>} */ detail) => buildVcrActivity({ now: NOW, steps: {},
    last: mark({ state: detail.runStatus === "succeeded" ? "done" : "failed", done_at: at(seconds), detail: { scope: [{ step: "patients" }], ...detail } }) });
  assert.deepEqual(ended(5, { runStatus: "succeeded" })?.last, { step: "patients", endedAt: at(5), outcome: "succeeded" });
  assert.equal(ended(5, { runStatus: "canceled", canceled: true })?.last?.outcome, "canceled");
  assert.equal(ended(5, { runStatus: "failed" })?.last?.outcome, "failed");
  assert.equal(ended(VCR_ACTIVITY_TAIL_MS / 1000 + 5, { runStatus: "succeeded" }), null, "past the tail the strip is gone");
  // An end the clock reads in the future is a clock disagreeing, not something just over.
  assert.equal(buildVcrActivity({ now: NOW, steps: {}, last: mark({ state: "done", done_at: new Date(NOW.getTime() + 3_600_000).toISOString(), detail: { runStatus: "succeeded" } }) }), null);
});

test("each step has at most one short finding with its one number, from what the study holds", () => {
  const bundle = {
    study: { steps: { trial: { status: "stale" } } },
    definition: { version: 2 },
    assumptions: [{ key: "a" }, { key: "b" }, { key: "c" }],
    criteria: [{}, {}, {}, {}],
    populations: [{ resultId: "res_pop", counts: {} }],
    patientSets: [{ resultId: "res_vp", counts: {} }],
    comparators: [{ resultId: "res_c1" }, { resultId: "res_c2" }],
    allResults: [
      { id: "res_pop", counts: { realPatients: 3412, generatedRecords: 0 } },
      { id: "res_vp", counts: { generatedRecords: 2000 } },
      { id: "res_c1", conclusion: "limited" }, { id: "res_c2", conclusion: "not_estimable" },
    ],
  };
  const designs = [
    { dominated: false, measures: { power: { value: 81 }, assurance: { value: 71 } } },
    { dominated: false, measures: { power: { value: 86 }, assurance: { value: 58 } } },
    { dominated: true, measures: {} },
  ];
  const summaries = vcrStepSummaries(bundle, designs);
  assert.deepEqual(summaries, {
    definition: { note: "v2", stale: false },
    evidence: { note: "3 张假设卡", stale: false },
    population: { note: "3,412 名", stale: false },
    patients: { note: "2,000 名", stale: false },
    comparator: { note: "1 条可估计", stale: false },
    trial: { note: "成功把握 58–71%", stale: true },
    matching: { note: "4 条入排标准", stale: false },
  });
  for (const entry of Object.values(summaries)) assert.ok([...String(entry.note ?? "")].length <= VCR_STEP_NOTE_MAX, entry.note);
  // A step with nothing to say is absent — and so is one whose note would not fit a step bar.
  assert.deepEqual(vcrStepSummaries({ study: { steps: {} }, assumptions: [] }, []), {});
  assert.equal(vcrStepSummaries({ study: { steps: {} }, populations: [{ resultId: "r", counts: { generatedRecords: 123456789012 } }], allResults: [] }, []).population, undefined);
});

// The `activity` payloads the activity strip is drawn from, one per state it has — written beside the page fixtures
// (`VCR_VIEWS_WRITE_FIXTURES=1`), so the web's tests draw the strip from exactly what the server sends.
const WRITE = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";
/** @param {string} name @param {unknown} value */
function check(name, value) {
  const file = path.join(FIXTURE_DIR, "activity", `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, "utf8"), `activity/${name}.json differs from what the read model now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
}

test("the activity payloads of each state the strip has are fixtures the web draws from", () => {
  const progress = {
    currentPhase: "claims", phaseCounts: { search: 4, claims: 2 }, sources: { searched: 4, included: 3, fullText: 2 }, claims: { total: 5, verified: 3 },
    deliverables: [{ status: "delegated" }],
  };
  const allSteps = (/** @type {Record<string, string>} */ status) => Object.fromEntries(
    ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"].map((step) => [step, { status: status[step] ?? "none" }]));
  const evidenceRun = mark({ key: "run:evidence", run_id: "run_ev", detail: { scope: [{ step: "evidence" }], purpose: "evidence", question: "找证据、整理假设卡", placement: "open-runtime" } });
  // A run in the open runtime, with what its tool calls added up to, and a step waiting behind it.
  check("running-with-queue", buildVcrActivity({ now: NOW, steps: allSteps({ definition: "done", evidence: "running", population: "queued" }),
    flight: evidenceRun, ledger: { startedAt: at(90), progress } }));
  // A run a worker pass sent with nobody present: it holds the project's own conversation.
  check("bounded-locked", buildVcrActivity({ now: NOW, steps: allSteps({ definition: "running" }),
    flight: mark({ key: "run:definition", run_id: "run_def", detail: { scope: [{ step: "definition" }], purpose: "definition", question: "整理研究定义", placement: "bounded" } }),
    ledger: { startedAt: at(20), progress: { currentPhase: "search", phaseCounts: { search: 1 } } } }));
  // The two seconds in which a run is being sent: it says nothing of where it went.
  check("being-sent", buildVcrActivity({ now: NOW, steps: allSteps({ definition: "done", evidence: "queued" }),
    flight: mark({ key: "run:evidence", state: "claimed", run_id: null, detail: { scope: [{ step: "evidence" }], purpose: "evidence", question: "找证据、整理假设卡" } }) }));
  // Engine work under way with no run out: the jobs and their step.
  check("jobs-only", buildVcrActivity({ now: NOW, steps: allSteps({ definition: "done", patients: "running" }), jobs: [
    { id: "job_a", kind: "generate_patients_time_to_event", state: "running", progress: { done: 1200, total: 2000 }, checkpoint: { node: "patient_set:set_1@1" } },
    { id: "job_b", kind: "design_simulation", state: "queued", progress: {}, checkpoint: { node: "trial_scenario:scn_1@1" } },
  ] }));
  // What just ended, for the seconds the strip says so — and the three outcomes.
  for (const [name, detail] of /** @type {Array<[string, Record<string, any>]>} */ ([
    ["tail-succeeded", { runStatus: "succeeded" }], ["tail-canceled", { runStatus: "canceled", canceled: true }], ["tail-failed", { runStatus: "failed" }],
  ])) {
    check(name, buildVcrActivity({ now: NOW, steps: allSteps({ definition: "done" }),
      last: mark({ state: detail.runStatus === "succeeded" ? "done" : "failed", done_at: at(6), detail: { scope: [{ step: "evidence" }], ...detail } }) }));
  }
  check("idle", buildVcrActivity({ now: NOW, steps: allSteps({ definition: "done" }) }));
});
