// The learning loop starts by itself (owner ruling, 2026-09-19).
//
// Under the defaults it could not start at all: one producer needed 「采纳」 and
// 「我改过」 on the same deliverable (zero adoptions in production), the other a
// server-side repair round that has defaulted to 0 since 2026-09-17. These are
// the three signals that replaced them — a finished delivery, a correction,
// a repeated routine — and the lines they must not cross.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_INDUCTION_MIN_TRAJECTORIES } from "@evimed/domain";
import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import {
  LearningTriggers, ROUTINE_PERIOD_DAYS, learningTriggersFor, lessonPeers, routinePeriodMs,
} from "../src/learningTriggers.mjs";
import { DISTILLATION_TRIGGERS, buildDistillationInput } from "../src/methodDistillationRuns.mjs";

const HOUR = 3_600_000;
const PERIOD = routinePeriodMs(ROUTINE_PERIOD_DAYS);
/** A day into the routine period holding 2026-09-10, so every run below shares it. */
const BASE = Math.floor(Date.UTC(2026, 8, 10) / PERIOD) * PERIOD + 24 * HOUR;

let clock = 0;
/** A finished run as the ledger lists it, an hour after the previous one. @param {Record<string, any>} overrides */
function run(overrides = {}) {
  clock += 1;
  return {
    id: `run_${clock}`,
    sessionId: "session_1",
    status: "succeeded",
    effectiveAgentId: "clinical-evidence-synthesis",
    effectiveRouteReason: "matched:clinical-evidence-synthesis",
    artifacts: ["deliverables/d1/report.md"],
    transcript: { completeness: "complete" },
    startedAt: new Date(BASE + clock * HOUR).toISOString(),
    finishedAt: new Date(BASE + clock * HOUR + 30 * 60_000).toISOString(),
    ...overrides,
  };
}

/** One of a researcher's projects, as the store resolves it. @param {string} id @param {Record<string, any>} [overrides] */
const projectOf = (id, overrides = {}) => ({ id, userId: "user_1", archivedAt: null, ...overrides });
const routineOf = (lessons) => lessons.find((lesson) => lesson.trigger === "routine");

const triggers = (lessons) => lessons.map((lesson) => lesson.trigger);

test("a finished delivery is a lesson by itself; one that needed repairs in its own turn is the repair lesson", () => {
  const clean = run();
  assert.deepEqual(triggers(learningTriggersFor({ run: clean, runs: [clean] })), ["delivered"]);

  const repaired = run();
  const projection = { plan: { items: [{ id: "d1", attempts: 1 }, { id: "d2", attempts: 3 }] } };
  const lessons = learningTriggersFor({ run: repaired, runs: [repaired], projection });
  assert.deepEqual(triggers(lessons), ["repair_accepted"]);
  // The retired producer's key, so a job it already queued is this job.
  assert.equal(lessons[0].idempotencyKey, `distill:${repaired.id}:repair_accepted`);
  assert.equal(lessons[0].payload.inRunAttempts, 3);

  // A server-side round still counts, where a deployment turned them back on.
  const serverRepaired = run({ repairRounds: { content: 1, structural: 0 } });
  assert.deepEqual(triggers(learningTriggersFor({ run: serverRepaired, runs: [serverRepaired] })), ["repair_accepted"]);

  // A run that delivered nothing taught nothing about delivering.
  const empty = run({ artifacts: [] });
  assert.deepEqual(learningTriggersFor({ run: empty, runs: [empty] }), []);
});

test("a correction the researcher made is a lesson, whether sent mid-run or written down by the extractor", () => {
  const steered = run({ corrections: 2 });
  const lessons = learningTriggersFor({ run: steered, runs: [steered] });
  assert.deepEqual(triggers(lessons), ["correction", "delivered"]);
  assert.equal(lessons[0].payload.steeredCorrections, 2);

  const said = run();
  const extracted = learningTriggersFor({
    run: said, runs: [said],
    memoryResult: { corrections: [{ recordId: "rec_1", key: "correction.renal_dosing", scope: "user" }] },
  });
  assert.deepEqual(extracted[0].payload.corrections, [{ recordId: "rec_1", key: "correction.renal_dosing" }]);

  // A failed run still carries the researcher's rule; it delivered nothing else.
  const failed = run({ status: "failed", corrections: 1, artifacts: [] });
  assert.deepEqual(triggers(learningTriggersFor({ run: failed, runs: [failed] })), ["correction"]);
});

test("the same kind of operation repeated is induced every Nth time, from all N runs", () => {
  assert.equal(METHOD_INDUCTION_MIN_TRAJECTORIES, 3, "the routine threshold is the domain's number");
  const family = [run(), run(), run(), run(), run(), run()];
  const other = run({ effectiveAgentId: "meta-analysis" });
  const ledger = [...family, other];
  const project = projectOf("paper");
  const routine = (subject) => routineOf(learningTriggersFor({ run: subject, runs: ledger, project }));

  assert.equal(routine(family[1]), undefined);
  const third = routine(family[2]);
  assert.ok(third, "the third successful run of one capability induces its routine");
  assert.deepEqual(third.payload.peers, [{ runId: family[0].id, projectId: "paper" }, { runId: family[1].id, projectId: "paper" }]);
  assert.equal(third.payload.capabilityId, "clinical-evidence-synthesis");
  assert.equal(routine(family[3]), undefined);
  assert.deepEqual(routine(family[5])?.payload.peers.map((peer) => peer.runId), [family[3].id, family[4].id]);
  assert.equal(routine(other), undefined, "another capability's first run is not part of this family");
});

test("a routine is counted across the researcher's own projects, one capability at a time", () => {
  // One question per project is what a project is for; counted per project,
  // this researcher never reached the third run of anything.
  const first = run();
  const between = run({ effectiveAgentId: "meta-analysis" });
  const second = run();
  const third = run();
  const ledgers = [
    { project: projectOf("aspirin"), runs: [first, between] },
    { project: projectOf("statins"), runs: [second] },
    { project: projectOf("renal"), runs: [third] },
  ];
  const lessons = learningTriggersFor({ run: third, runs: ledgers[2].runs, project: ledgers[2].project, ledgers });
  assert.deepEqual(routineOf(lessons)?.payload, {
    runId: third.id, trigger: "routine", capabilityId: "clinical-evidence-synthesis",
    peers: [{ runId: first.id, projectId: "aspirin" }, { runId: second.id, projectId: "statins" }],
  }, "each peer by run and by the project its transcript is in");
  assert.equal(routineOf(learningTriggersFor({ run: third, runs: ledgers[2].runs, project: ledgers[2].project })), undefined,
    "the same run counted in its own project alone is the first of its kind there");
  // Another capability's runs neither count nor break the count.
  assert.equal(routineOf(learningTriggersFor({ run: between, runs: ledgers[0].runs, project: ledgers[0].project, ledgers })), undefined);
});

test("only the researcher's own work in their own live projects is family", () => {
  const subject = () => run();
  /** @param {{ project: any, runs: any[] }} extra */
  const withPeers = (extra) => {
    const mine = [run()];
    const last = subject();
    const ledgers = [{ project: projectOf("paper"), runs: [...mine, last] }, extra];
    return routineOf(learningTriggersFor({ run: last, runs: ledgers[0].runs, project: ledgers[0].project, ledgers }));
  };
  // A control: one more of the researcher's own runs completes the routine.
  assert.ok(withPeers({ project: projectOf("other-paper"), runs: [run()] }), "the control completes the group of three");
  const excluded = [
    ["an automated run (evaluation cell, probe, harness)", { project: projectOf("other-paper"), runs: [run({ automated: true })] }],
    ["an autopilot episode", { project: projectOf("other-paper"), runs: [run({ effectiveRouteReason: "autopilot:literature-sentinel" })] }],
    ["a run that failed", { project: projectOf("other-paper"), runs: [run({ status: "failed" })] }],
    ["a run still going", { project: projectOf("other-paper"), runs: [run({ status: "running", finishedAt: null })] }],
    ["a run in an internal project", { project: projectOf(LEARNING_PROJECT_ID), runs: [run()] }],
    ["a run in an evaluation cell's project", { project: projectOf("methodeval-0123456789abcdef01234567"), runs: [run()] }],
    ["a run in an archived project", { project: projectOf("old-paper", { archivedAt: "2026-09-01T00:00:00.000Z" }), runs: [run()] }],
    ["another researcher's run", { project: projectOf("their-paper", { userId: "user_2" }), runs: [run()] }],
    ["a run finished in an earlier routine period", { project: projectOf("other-paper"), runs: [run({ finishedAt: new Date(BASE - 25 * HOUR).toISOString() })] }],
  ];
  for (const [label, extra] of excluded) assert.equal(withPeers(extra), undefined, `${label} is not family`);
});

test("positions do not move: fixed periods, and a run is induced from once however often it is asked", () => {
  const project = projectOf("paper");
  // A steady pace across a period boundary. A window sliding back from each
  // run would hold a constant count here and fire on every run or on none.
  const periodEnd = Math.floor(Date.UTC(2026, 8, 10) / PERIOD) * PERIOD + PERIOD;
  const paced = Array.from({ length: 8 }, (_, index) => run({
    id: `paced_${index}`,
    finishedAt: new Date(periodEnd + (index - 4) * 24 * HOUR + HOUR).toISOString(),
  }));
  const fired = paced.filter((subject) => routineOf(learningTriggersFor({ run: subject, runs: paced, project }))).map((subject) => subject.id);
  // Four in the closing period (the 3rd fires, the 4th waits), four in the
  // next, counted from its own start (its 3rd fires).
  assert.deepEqual(fired, ["paced_2", "paced_6"]);

  // The lesson is keyed by the run alone, and the family behind it does not
  // shift when later runs arrive: asked again, the same run names the same
  // lesson and the same peers.
  const early = routineOf(learningTriggersFor({ run: paced[2], runs: paced.slice(0, 3), project }));
  const late = routineOf(learningTriggersFor({ run: paced[2], runs: paced, project }));
  assert.equal(early?.idempotencyKey, `distill:${paced[2].id}:routine`);
  assert.deepEqual(late, early);
});

test("a routine lesson is queued once, whichever of the researcher's projects it is counted from", async () => {
  // A queue that honours idempotency keys, as the product queue does.
  const jobs = {
    byKey: new Map(),
    async enqueue(userId, kind, payload, options) {
      if (!this.byKey.has(options.idempotencyKey)) this.byKey.set(options.idempotencyKey, { userId, kind, payload, options });
      return this.byKey.get(options.idempotencyKey);
    },
  };
  const here = projectOf("renal");
  const [first, second] = [run(), run()];
  const subject = run();
  const ledgers = new Map([
    ["aspirin", [first, run({ effectiveAgentId: "open-domain-answer" })]],
    ["statins", [second]],
    ["renal", [subject]],
    ["archived", [run()]],
    [LEARNING_PROJECT_ID, [run()]],
  ]);
  const read = [];
  const agentRuns = {
    list: async (project) => { read.push(project.id); return ledgers.get(project.id) ?? []; },
    runWorkflowProjection: async () => null,
  };
  const projects = async (userId) => {
    assert.equal(userId, "user_1", "only the run's own researcher's projects are asked for");
    return [projectOf("aspirin"), projectOf("statins"), here, projectOf("archived", { archivedAt: "2026-09-01T00:00:00.000Z" }),
      projectOf(LEARNING_PROJECT_ID), projectOf("foreign", { userId: "user_2" })];
  };
  const triggers = new LearningTriggers({ jobs, agentRuns, projects });
  const result = await triggers.afterRun(here, subject);
  assert.deepEqual(result.queued, ["delivered", "routine"]);
  assert.deepEqual(read.sort(), ["aspirin", "renal", "statins"], "archived, internal and foreign ledgers are never read");
  const routine = jobs.byKey.get(`distill:${subject.id}:routine`);
  assert.equal(routine.options.projectId, "renal", "filed under the run that completed it");
  assert.deepEqual(routine.payload.peers, [{ runId: first.id, projectId: "aspirin" }, { runId: second.id, projectId: "statins" }]);
  await triggers.afterRun(here, subject);
  assert.equal([...jobs.byKey.keys()].filter((key) => key.endsWith(":routine")).length, 1, "the same key twice is one lesson");

  // A plain answer never reads the other ledgers.
  read.length = 0;
  const answer = run({ effectiveAgentId: "open-domain-answer" });
  ledgers.set("renal", [subject, answer]);
  await triggers.afterRun(here, answer);
  assert.deepEqual(read, ["renal"]);
});

test("a family that cannot be read in full induces nothing, and says so", async () => {
  const audits = [];
  const here = projectOf("renal");
  const subject = run();
  const triggers = new LearningTriggers({
    jobs: { enqueue: async () => ({ id: "job" }) },
    agentRuns: {
      list: async (project) => {
        if (project.id === "statins") throw Object.assign(new Error("ledger unreadable"), { code: "agent_runs_corrupt" });
        return project.id === "renal" ? [subject] : [run(), run()];
      },
      runWorkflowProjection: async () => null,
    },
    projects: async () => [projectOf("aspirin"), projectOf("statins"), here],
    audit: async (event, detail) => { audits.push({ event, ...detail }); },
  });
  const result = await triggers.afterRun(here, subject);
  assert.deepEqual(result.queued, ["delivered"], "a position counted over part of the family is a wrong answer");
  assert.deepEqual(audits.map((entry) => [entry.event, entry.code, entry.detail]),
    [["learning.routine.family", "agent_runs_corrupt", "clinical-evidence-synthesis"]]);
});

test("a routine lesson's peers read in both shapes it has been queued in", () => {
  assert.deepEqual(lessonPeers({ peers: [{ runId: "run_a", projectId: "aspirin" }, { runId: "run_b", projectId: null }, { projectId: "x" }, null] }),
    [{ runId: "run_a", projectId: "aspirin" }, { runId: "run_b", projectId: null }]);
  // Queued before 2026-09-28: run ids only, every one in the lesson's own project.
  assert.deepEqual(lessonPeers({ peerRunIds: ["run_a", "", 7, "run_b"] }), [{ runId: "run_a", projectId: null }, { runId: "run_b", projectId: null }]);
  assert.deepEqual(lessonPeers({ trigger: "delivered" }), []);
});

test("the platform's own work and a plain answer never teach the researcher's loop", () => {
  const cases = [
    run({ automated: true }),
    run({ effectiveRouteReason: "autopilot:literature-sentinel" }),
    run({ effectiveAgentId: "method-distillation" }),
    run({ transcript: { completeness: "partial" } }),
    run({ transcript: undefined }),
    run({ status: "canceled", corrections: 1 }),
  ];
  for (const subject of cases) {
    assert.deepEqual(learningTriggersFor({
      run: subject, runs: [subject], internalAgent: (id) => id === "method-distillation",
    }), [], JSON.stringify(subject));
  }
  // The answer line delivers and is learned from; it is never a "routine".
  const answers = [run({ effectiveAgentId: "open-domain-answer" }), run({ effectiveAgentId: "open-domain-answer" }),
    run({ effectiveAgentId: "open-domain-answer" })];
  assert.deepEqual(triggers(learningTriggersFor({ run: answers[2], runs: answers })), ["delivered"]);
});

test("the queue is fed with one job per lesson, and nothing when the researcher paused learning", async () => {
  const subject = run({ corrections: 1 });
  const enqueued = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ userId, kind, payload, options }); return { id: "job" }; } };
  const agentRuns = { list: async () => [subject], runWorkflowProjection: async () => null };
  const project = { id: "project_1", userId: "user_1" };

  const fed = await new LearningTriggers({ jobs, agentRuns }).afterRun(project, subject, null);
  assert.deepEqual(fed, { queued: ["correction", "delivered"], skipped: null });
  assert.deepEqual(enqueued.map((job) => [job.kind, job.options.idempotencyKey, job.options.projectId]), [
    ["distill", `distill:${subject.id}:correction`, "project_1"],
    ["distill", `distill:${subject.id}:delivered`, "project_1"],
  ]);

  enqueued.length = 0;
  const paused = { configured: true, settings: async () => ({ learningPaused: true, recallPaused: false, pausedProjects: [] }) };
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns, memory: paused }).afterRun(project, subject), { queued: [], skipped: "paused" });
  const trial = async () => ({ trialCapsuleId: "pack-1" });
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns, sessionState: trial }).afterRun(project, subject),
    { queued: [], skipped: "trial" }, "a conversation trying someone else's capsule teaches the loop nothing");
  assert.equal(enqueued.length, 0);

  // The internal-capability answer can arrive asynchronously, from the registry.
  const internal = run({ effectiveAgentId: "source-understanding" });
  const internalRuns = { list: async () => [internal], runWorkflowProjection: async () => null };
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns: internalRuns, internalAgent: async (id) => id === "source-understanding" })
    .afterRun(project, internal), { queued: [], skipped: null });
});

test("a lesson that could not be queued is audited, and the others still go", async () => {
  const subject = run({ corrections: 1 });
  const audits = [];
  const jobs = {
    enqueue: async (_userId, _kind, payload) => {
      if (payload.trigger === "correction") throw Object.assign(new Error("full"), { code: "product_job_queue_full" });
      return { id: "job" };
    },
  };
  const result = await new LearningTriggers({
    jobs,
    agentRuns: { list: async () => [subject], runWorkflowProjection: async () => null },
    audit: async (event, detail) => { audits.push({ event, ...detail }); },
  }).afterRun({ id: "p", userId: "u" }, subject);
  assert.deepEqual(result.queued, ["delivered"]);
  assert.deepEqual(audits.map((entry) => [entry.event, entry.code, entry.detail]),
    [["learning.distill.enqueue", "product_job_queue_full", "correction"]]);
});

test("a routine induction reads every run of the family, each cleaned like the main one", () => {
  assert.ok(DISTILLATION_TRIGGERS.includes("delivered"));
  assert.ok(DISTILLATION_TRIGGERS.includes("routine"));
  const transcript = (text) => ({
    header: { completeness: "complete" },
    messages: [{ sessionId: "s", seq: 1, role: "user", parts: [{ type: "text", text }] }],
  });
  const input = buildDistillationInput({
    run: { id: "run_3", effectiveAgentId: "clinical-evidence-synthesis" },
    trigger: "routine",
    transcript: transcript("第三次综述"),
    peerRuns: [
      { runId: "run_1", transcript: transcript("第一次综述") },
      { runId: "run_2", transcript: null },
    ],
  });
  assert.equal(input.trigger, "routine");
  assert.deepEqual(input.peerRuns.map((peer) => [peer.runId, peer.transcriptCompleteness, peer.transcriptExcerpts.length]),
    [["run_1", "complete", 1], ["run_2", "unavailable", 0]]);
  // Every other trigger reads one run.
  assert.deepEqual(buildDistillationInput({ run: { id: "r" }, trigger: "delivered", transcript: null }).peerRuns, []);
});

test("the distiller sees which related methods were retired, and why", () => {
  const input = buildDistillationInput({
    run: { id: "run_4" },
    trigger: "repair_accepted",
    transcript: null,
    relatedMethods: [
      { id: "method:learned:a", payload: { contentDigest: "sha256:a", frontmatter: { name: "a" }, body: "A", status: "approved" } },
      { id: "method:learned:b", payload: { contentDigest: "sha256:b", frontmatter: { name: "b" }, body: "B", status: "retired", statusReason: "writes bookkeeping into reports" } },
    ],
  });
  assert.deepEqual(input.relatedMethods.map((method) => [method.id, method.status, method.statusReason ?? null]), [
    ["method:learned:a", "approved", null],
    ["method:learned:b", "retired", "writes bookkeeping into reports"],
  ]);
});
