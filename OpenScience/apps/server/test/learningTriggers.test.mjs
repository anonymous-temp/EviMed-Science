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
import { LearningTriggers, learningTriggersFor } from "../src/learningTriggers.mjs";
import { DISTILLATION_TRIGGERS, buildDistillationInput } from "../src/methodDistillationRuns.mjs";

let clock = 0;
/** A finished run as the ledger lists it. @param {Record<string, any>} overrides */
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
    startedAt: `2026-09-${String(10 + clock).padStart(2, "0")}T01:00:00.000Z`,
    finishedAt: `2026-09-${String(10 + clock).padStart(2, "0")}T01:30:00.000Z`,
    ...overrides,
  };
}

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
  const routineOf = (subject) => learningTriggersFor({ run: subject, runs: ledger }).find((lesson) => lesson.trigger === "routine");

  assert.equal(routineOf(family[1]), undefined);
  const third = routineOf(family[2]);
  assert.ok(third, "the third successful run of one capability induces its routine");
  assert.deepEqual(third.payload.peerRunIds, [family[0].id, family[1].id]);
  assert.equal(third.payload.capabilityId, "clinical-evidence-synthesis");
  assert.equal(routineOf(family[3]), undefined);
  assert.deepEqual(routineOf(family[5])?.payload.peerRunIds, [family[3].id, family[4].id]);
  assert.equal(routineOf(other), undefined, "another capability's first run is not part of this family");
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

test("the queue is fed with one job per lesson, and nothing when the researcher paused learning or talked incognito", async () => {
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
  const incognito = async () => ({ incognito: true });
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns, sessionState: incognito }).afterRun(project, subject),
    { queued: [], skipped: "incognito" });
  const trial = async () => ({ incognito: false, trialCapsuleId: "pack-1" });
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
