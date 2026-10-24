// The learning loop starts by itself (owner ruling, 2026-09-19), and since 2026-10-23 learns from what the researcher did to a run.
//
// Under the defaults it could not start at all: one producer needed 「采纳」 and 「我改过」 on the same deliverable (zero adoptions in
// production), the other a server-side repair round that has defaulted to 0 since 2026-09-17. The signals that replaced them: a
// correction (typed into the run, written down by the extractor, a result corrected in the page, or the next turn's first message
// read as one), a repaired delivery where an operator asks for it, and a routine — τ clean trajectories of one scope and one shape,
// decided when a run is settled (`routineLessonFor`). A finished delivery queues no lesson of its own any more.
import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON, METHOD_INDUCTION_MIN_TRAJECTORIES } from "@evimed/domain";
import { VERIFICATION_ROUTE_REASON } from "../src/autopilotService.mjs";
import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import {
  CONVERSATION_SCOPE, LEARNING_REFUSAL_REASONS, LearningTriggers, REPAIR_SAMPLE_PURPOSE, ROUTINE_PERIOD_DAYS, correctionLessonFor, learningRefusal, learningScopeOf,
  learningTriggersFor, lessonPeers, routineLessonFor, routinePeriodMs, routinePeriodOf,
} from "../src/learningTriggers.mjs";
import { sampledByHash } from "../src/runSampling.mjs";
import { DISTILLATION_TRIGGERS, buildDistillationInput, distillationDispatchId, lessonSignal } from "../src/methodDistillationRuns.mjs";

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
const triggers = (lessons) => lessons.map((lesson) => lesson.trigger);

test("a conversation that read clinical context, or a correction about one, queues nothing and says why", async () => {
  const home = projectOf("vcr-project");
  const clinical = run({ id: "clinical", corrections: 1 });
  const jobs = { enqueue: async () => { throw new Error("Clinical text must not reach the queue"); } };
  const refused = [];
  const worker = new LearningTriggers({ jobs, agentRuns: { list: async () => [clinical] }, canReuseRun: async (_home, entry) => entry.id !== "clinical", onRefused: (reason) => refused.push(reason) });
  assert.deepEqual(await worker.afterRun(home, clinical), { queued: [], skipped: "clinical_context" });
  assert.deepEqual(await worker.afterCorrection(home, { runId: clinical.id, event: {} }), { queued: [], skipped: "clinical_context" });
  assert.deepEqual(refused, ["clinical_context", "clinical_context"], "each refusal is counted by its reason");
});

test("a finished delivery queues no lesson of its own; one that needed repairs in its own turn is the repair lesson", () => {
  const clean = run();
  assert.deepEqual(learningTriggersFor({ run: clean, runs: [clean] }), [], "its content is the settled run and the routine over three of them");

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
  assert.deepEqual(triggers(lessons), ["correction"]);
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

// ---------------------------------------------------------------------------------------------------- routine

/** Clean runs of one scope as the evidence ledger lists them, oldest first, each with the shape of what it left. @param {number} n @param {Record<string, any>} [extra] */
const familyOf = (n, extra = {}) => Array.from({ length: n }, (_, index) => ({
  runId: `fam_${index}`, projectId: index % 2 ? "statins" : "aspirin", shape: [{ format: "docx", labels: ["summary", "findings", "next steps"] }], ...extra,
}));
const weekly = [{ format: "docx", labels: ["summary", "findings", "next steps"] }];

test("a routine is τ clean trajectories of one shape, every Nth, and is queued once per run", () => {
  assert.equal(METHOD_INDUCTION_MIN_TRAJECTORIES, 3, "the routine threshold is the domain's number");
  const subject = run({ id: "run_now" });
  const lessonAfter = (before) => routineLessonFor({ run: subject, scope: "clinical-evidence-synthesis", shape: weekly, family: familyOf(before) });

  assert.equal(lessonAfter(0), null);
  assert.equal(lessonAfter(1), null, "the second clean run of a kind is not yet a routine");
  const third = lessonAfter(2);
  assert.ok(third, "the third completes it");
  assert.deepEqual(third.payload, {
    runId: "run_now", trigger: "routine", scope: "clinical-evidence-synthesis", capabilityId: "clinical-evidence-synthesis",
    peers: [{ runId: "fam_0", projectId: "aspirin" }, { runId: "fam_1", projectId: "statins" }],
  }, "each peer by run and by the project its transcript is in");
  assert.equal(third.idempotencyKey, "distill:run_now:routine", "keyed by the run alone, so a run is induced from once however often it is settled");
  assert.equal(lessonAfter(3), null);
  assert.equal(lessonAfter(4), null);
  assert.deepEqual(lessonAfter(5)?.payload.peers.map((peer) => peer.runId), ["fam_3", "fam_4"], "the sixth fires again, from the two before it");
  // The run is counted in once, never against itself: its own row in the family is not one of its peers.
  const own = { runId: "run_now", shape: weekly };
  assert.equal(routineLessonFor({ run: subject, scope: "conversation", shape: weekly, family: [...familyOf(1), own] }), null);
  assert.deepEqual(routineLessonFor({ run: subject, scope: "conversation", shape: weekly, family: [...familyOf(2), own] })?.payload.peers.map((peer) => peer.runId), ["fam_0", "fam_1"]);
});

test("the ordinary conversation can induce a routine: its scope is `conversation`, and it is the shape that says the work is the same", () => {
  assert.equal(learningScopeOf(run({ effectiveAgentId: "open-domain-answer" })), CONVERSATION_SCOPE);
  assert.equal(learningScopeOf(run({ effectiveAgentId: null })), CONVERSATION_SCOPE, "a turn nothing routed");
  assert.equal(learningScopeOf(run({ effectiveAgentId: "geo-content" })), "geo-content");
  const subject = run({ effectiveAgentId: "open-domain-answer" });
  const lesson = routineLessonFor({ run: subject, scope: CONVERSATION_SCOPE, shape: weekly, family: familyOf(2) });
  assert.equal(lesson?.payload.capabilityId, null);
  assert.equal(lesson?.payload.scope, "conversation");
});

test("runs that left something else do not count towards a routine, and a run with no file teaches none", () => {
  const subject = run();
  const decks = [{ format: "pptx", labels: ["background", "method"] }];
  const budget = [{ format: "docx", labels: ["budget", "risks", "timeline"] }];
  const other = (shape, runId) => ({ runId, projectId: null, shape });
  assert.equal(routineLessonFor({ run: subject, scope: "s", shape: weekly, family: [...familyOf(1), other(decks, "d"), other(budget, "b")] }), null,
    "one of the same shape and two of other shapes is not three of one");
  assert.equal(routineLessonFor({ run: subject, scope: "s", shape: weekly, family: [...familyOf(1), other(decks, "d")] }), null, "and a deck is not a report");
  assert.ok(routineLessonFor({ run: subject, scope: "s", shape: weekly, family: [...familyOf(1), other([{ format: "docx", labels: ["Summary", "Findings", "Next steps", "Annex"] }], "w")] }),
    "a report with one more section is still that report");
  assert.equal(routineLessonFor({ run: subject, scope: "s", shape: [], family: familyOf(5) }), null, "no shape, no routine");
});

test("a routine's period is fixed, counted from the epoch, so positions do not move", () => {
  const edge = Math.floor(Date.UTC(2026, 8, 10) / PERIOD) * PERIOD + PERIOD;
  assert.equal(routinePeriodOf(new Date(edge - 1)) + 1, routinePeriodOf(new Date(edge)));
  assert.equal(routinePeriodOf({ finishedAt: new Date(edge + HOUR).toISOString() }), routinePeriodOf(new Date(edge + 5 * 24 * HOUR)));
  assert.equal(routinePeriodOf(new Date(edge).toISOString()), routinePeriodOf(new Date(edge)));
  assert.equal(routinePeriodOf({}), null);
});

test("a routine lesson's peers read in both shapes it has been queued in", () => {
  assert.deepEqual(lessonPeers({ peers: [{ runId: "run_a", projectId: "aspirin" }, { runId: "run_b", projectId: null }, { projectId: "x" }, null] }),
    [{ runId: "run_a", projectId: "aspirin" }, { runId: "run_b", projectId: null }]);
  // Queued before 2026-09-28: run ids only, every one in the lesson's own project.
  assert.deepEqual(lessonPeers({ peerRunIds: ["run_a", "", 7, "run_b"] }), [{ runId: "run_a", projectId: null }, { runId: "run_b", projectId: null }]);
  assert.deepEqual(lessonPeers({ trigger: "delivered" }), []);
});

// ---------------------------------------------------------------------------------------------------- gates

test("the platform's own work never teaches the researcher's loop, and each refusal has its reason", () => {
  const cases = [
    [run({ automated: true }), "not_researcher_work"],
    [run({ effectiveAgentId: "method-distillation" }), "not_researcher_work"],
    [run({ effectiveAgentId: "some-internal-capability" }), "internal_agent"],
    [run({ transcript: { completeness: "partial" } }), "transcript_incomplete"],
    [run({ transcript: undefined }), "transcript_incomplete"],
    [run({ status: "canceled", corrections: 1 }), "not_finished"],
    [run({ status: "running" }), "not_finished"],
  ];
  for (const [subject, reason] of cases) {
    const options = { run: subject, runs: [subject], internalAgent: (id) => id === "some-internal-capability" };
    assert.equal(learningRefusal(options), reason, JSON.stringify(subject));
    assert.deepEqual(learningTriggersFor(options), [], JSON.stringify(subject));
    assert.ok(LEARNING_REFUSAL_REASONS.includes(reason));
  }
  assert.equal(learningRefusal({ run: run(), runs: [], project: projectOf(LEARNING_PROJECT_ID) }), "internal_project");
  const fine = run();
  assert.equal(learningRefusal({ run: fine, runs: [fine] }), null);
});

test("an ordinary conversation is learned from by what the researcher corrected; what it left is read when the run is settled (GA21)", () => {
  const general = (extra = {}) => run({ effectiveAgentId: "open-domain-answer", effectiveRouteReason: "unrouted:open-domain", artifacts: [], ...extra });
  // A turn that left a file queues nothing at once: the settled run and the routine over three of them are its lesson.
  const turn = general({ outputFiles: ["reports/周报-10-13.docx"] });
  assert.deepEqual(learningTriggersFor({ run: turn, runs: [turn] }), []);
  // The researcher's correction is a lesson with or without a file.
  const corrected = general({ corrections: 1 });
  assert.deepEqual(triggers(learningTriggersFor({ run: corrected, runs: [corrected] })), ["correction"]);
  const both = general({ corrections: 1, outputFiles: ["reports/周报-10-13.docx"] });
  assert.deepEqual(triggers(learningTriggersFor({ run: both, runs: [both] })), ["correction"]);
  // A failed turn that left files is not a delivery.
  const failed = general({ status: "failed", outputFiles: ["reports/周报.docx"] });
  assert.deepEqual(learningTriggersFor({ run: failed, runs: [failed] }), []);
});

test("researcher-owned GEO and proactive work may teach while internal evaluations may not", () => {
  for (const [effectiveAgentId, effectiveRouteReason] of [
    ["geo-content", "geo:content"],
    ["clinical-evidence-synthesis", "autopilot:literature-sentinel"],
  ]) {
    const subject = run({ automated: true, effectiveAgentId, effectiveRouteReason, corrections: 1 });
    assert.deepEqual(triggers(learningTriggersFor({ run: subject, runs: [subject], project: projectOf("research") })), ["correction"]);
    assert.deepEqual(learningTriggersFor({ run: subject, runs: [subject], project: projectOf("acceptance-geo-0929") }), []);
    const evaluating = { ...subject, dispatchId: "methodeval_a1b2c3", effectiveRouteReason: "platform-learning" };
    assert.deepEqual(learningTriggersFor({ run: evaluating, runs: [evaluating], project: projectOf("research") }), []);
  }
});

// 2026-10-14: the independent re-check of a scheduled execution's claim (`autopilot-verify`, and the programme's `autopilot-verify:evidence`) carries no
// `automated` and no `autopilot:` prefix, so it read as the researcher's own turn; 14 of them stood in the owner's ledger beside 5 executions. The owner's
// ruling of 2026-09-29 keeps the *execution* (researcher-owned proactive work); the platform's re-check of it is not the researcher's work.
test("a verification run is not a lesson, whichever reason it carries, while the execution it checks still is", () => {
  for (const effectiveRouteReason of [VERIFICATION_ROUTE_REASON, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON]) {
    for (const extra of [{}, { automated: true }, { automated: false }]) {
      const verification = run({ effectiveAgentId: "open-domain-answer", effectiveRouteReason, outputFiles: ["verification.json"], corrections: 1, ...extra });
      assert.deepEqual(learningTriggersFor({ run: verification, runs: [verification], project: projectOf("research") }), [], `${effectiveRouteReason} ${JSON.stringify(extra)}`);
      assert.equal(learningRefusal({ run: verification, runs: [verification] }), "not_researcher_work");
    }
  }
  const episode = run({ effectiveAgentId: "open-domain-answer", effectiveRouteReason: "autopilot:routine", outputFiles: ["briefs/今日.md"], corrections: 1 });
  assert.deepEqual(triggers(learningTriggersFor({ run: episode, runs: [episode], project: projectOf("research") })), ["correction"]);
});

// ---------------------------------------------------------------------------------------------------- the queue

test("the queue is fed with one job per lesson, and nothing when the researcher paused learning", async () => {
  const subject = run({ corrections: 1 });
  const enqueued = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ userId, kind, payload, options }); return { id: "job" }; } };
  const agentRuns = { list: async () => [subject], runWorkflowProjection: async () => null };
  const project = { id: "project_1", userId: "user_1" };

  const fed = await new LearningTriggers({ jobs, agentRuns }).afterRun(project, subject, null);
  assert.deepEqual(fed, { queued: ["correction"], skipped: null });
  assert.deepEqual(enqueued.map((job) => [job.kind, job.options.idempotencyKey, job.options.projectId]), [
    ["distill", `distill:${subject.id}:correction`, "project_1"],
  ]);

  enqueued.length = 0;
  const refused = [];
  const paused = { configured: true, settings: async () => ({ learningPaused: true, recallPaused: false, pausedProjects: [] }) };
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns, memory: paused, onRefused: (reason) => refused.push(reason) }).afterRun(project, subject), { queued: [], skipped: "paused" });
  const trial = async () => ({ trialCapsuleId: "pack-1" });
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns, sessionState: trial, onRefused: (reason) => refused.push(reason) }).afterRun(project, subject),
    { queued: [], skipped: "trial" }, "a conversation trying someone else's capsule teaches the loop nothing");
  assert.equal(enqueued.length, 0);
  assert.deepEqual(refused, ["paused", "trial"]);

  // The internal-capability answer can arrive asynchronously, from the registry.
  const internal = run({ effectiveAgentId: "some-internal-capability" });
  const internalRuns = { list: async () => [internal], runWorkflowProjection: async () => null };
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns: internalRuns, internalAgent: async (id) => id === "some-internal-capability" })
    .afterRun(project, internal), { queued: [], skipped: "internal_agent" });
});

test("a finished run is handed to the evidence ledger after its lessons, with the run as the ledger holds it, and a failure there is the evidence's", async () => {
  const subject = run({ corrections: 1 });
  const ledgerCopy = { ...subject, steers: [{ requestId: "req_1", text: "再短一点", at: "2026-09-10T10:00:00.000Z" }] };
  const seen = [];
  const jobs = { enqueue: async () => ({ id: "job" }) };
  const project = { id: "project_1", userId: "user_1" };
  const triggersWith = (afterRun) => new LearningTriggers({ jobs, agentRuns: { list: async () => [ledgerCopy], runWorkflowProjection: async () => null }, evidence: { afterRun } });
  assert.deepEqual(await triggersWith(async (...args) => { seen.push(args); }).afterRun(project, subject), { queued: ["correction"], skipped: null });
  assert.equal(seen[0][1].steers.length, 1, "the ledger's copy, which carries the steers");
  assert.deepEqual(seen[0][2], { guestInfluence: false });
  assert.deepEqual(await triggersWith(async () => { throw new Error("evidence store down"); }).afterRun(project, subject), { queued: ["correction"], skipped: null });
  // A run no gate let through is not handed over.
  seen.length = 0;
  const automated = run({ automated: true });
  await new LearningTriggers({ jobs, agentRuns: { list: async () => [automated], runWorkflowProjection: async () => null }, evidence: { afterRun: async () => { seen.push("called"); } } }).afterRun(project, automated);
  assert.deepEqual(seen, []);
});

/** A run id the hash of the repair sample puts in (or out of) a share. @param {number} share @param {boolean} taken @param {Record<string, any>} [overrides] */
function repairSampledRun(share, taken, overrides = {}) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const candidate = run({ repairRounds: { content: 1, structural: 0 }, ...overrides });
    if (sampledByHash(candidate.id, share, REPAIR_SAMPLE_PURPOSE) === taken) return candidate;
  }
  throw new Error("no run id found for the repair sample");
}

test("a delivery that needed repairs inside its run queues no lesson by default: the gate's bookkeeping is not the researcher's method (owner, 2026-10-12)", async () => {
  const project = { id: "project_1", userId: "user_1" };
  /** @type {any[]} */ const enqueued = [];
  const jobs = { enqueue: async (_userId, _kind, payload, options) => { enqueued.push({ trigger: payload.trigger, key: options.idempotencyKey }); return { id: "job" }; } };
  const counted = /** @type {boolean[]} */ ([]);
  const triggersFor = (/** @type {any[]} */ ledger, /** @type {any} */ options = {}) => new LearningTriggers({
    jobs, agentRuns: { list: async () => ledger, runWorkflowProjection: async () => ({ plan: { items: [{ id: "d1", attempts: 3 }] } }) },
    onRepairSample: (distilled) => counted.push(distilled), ...options });

  const repaired = run();
  assert.deepEqual(triggers(learningTriggersFor({ run: repaired, runs: [repaired], projection: { plan: { items: [{ id: "d1", attempts: 3 }] } } })), ["repair_accepted"]);

  // Default: none, and the skipped one is a number.
  assert.deepEqual(await triggersFor([repaired]).afterRun(project, repaired), { queued: [], skipped: null, sampledOut: ["repair_accepted"] });
  assert.deepEqual(enqueued, []);
  assert.deepEqual(counted, [false]);

  // A researcher's correction in that same run is still a lesson.
  const corrected = run({ corrections: 1 });
  assert.deepEqual(await triggersFor([corrected]).afterRun(project, corrected), { queued: ["correction"], skipped: null, sampledOut: ["repair_accepted"] });
  // A clean delivery queues nothing at the run's end.
  const clean = run();
  assert.deepEqual(await new LearningTriggers({ jobs, agentRuns: { list: async () => [clean], runWorkflowProjection: async () => null } }).afterRun(project, clean), { queued: [], skipped: null });

  // The lever: every repaired delivery restores the old behaviour; a share is a hash of the run id.
  const every = triggersFor([repaired], { repairShare: 1 });
  assert.deepEqual(await every.afterRun(project, repaired), { queued: ["repair_accepted"], skipped: null });
  const inside = repairSampledRun(0.5, true);
  const outside = repairSampledRun(0.5, false);
  const half = (/** @type {any} */ subject) => triggersFor([subject], { repairShare: 0.5 }).afterRun(project, subject);
  assert.deepEqual(await half(inside), { queued: ["repair_accepted"], skipped: null });
  assert.deepEqual(await half(outside), { queued: [], skipped: null, sampledOut: ["repair_accepted"] });
  assert.deepEqual(await half(outside), { queued: [], skipped: null, sampledOut: ["repair_accepted"] }, "the same run, the same answer");
});

test("a lesson that could not be queued is audited and counted, and the others still go", async () => {
  const subject = run({ corrections: 1, repairRounds: { content: 1, structural: 0 } });
  const audits = [];
  const refused = [];
  const jobs = {
    enqueue: async (_userId, _kind, payload) => {
      if (payload.trigger === "correction") throw Object.assign(new Error("full"), { code: "product_job_queue_full" });
      return { id: "job" };
    },
  };
  const result = await new LearningTriggers({
    jobs, repairShare: 1,
    agentRuns: { list: async () => [subject], runWorkflowProjection: async () => null },
    audit: async (event, detail) => { audits.push({ event, ...detail }); },
    onRefused: (reason) => refused.push(reason),
  }).afterRun({ id: "p", userId: "u" }, subject);
  assert.deepEqual(result.queued, ["repair_accepted"]);
  assert.deepEqual(audits.map((entry) => [entry.event, entry.code, entry.detail]),
    [["learning.distill.enqueue", "product_job_queue_full", "correction"]]);
  assert.deepEqual(refused, ["enqueue_failed"]);
});

// ---------------------------------------------------------------------------------------------------- inputs

test("a routine induction reads each run of the family by its digest, never by raw lines", () => {
  assert.ok(DISTILLATION_TRIGGERS.includes("delivered"), "a job queued before 2026-10-23 is still read");
  assert.ok(DISTILLATION_TRIGGERS.includes("routine"));
  const transcript = (text) => ({
    header: { completeness: "complete" },
    messages: [{ sessionId: "s", seq: 1, role: "user", source: "user", turnStartSeq: 1, parts: [{ type: "text", text }] }],
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
  assert.deepEqual(input.peerRuns.map((peer) => [peer.runId, peer.transcriptCompleteness, peer.trajectory?.requests.map((entry) => entry.text) ?? null]),
    [["run_1", "complete", ["第一次综述"]], ["run_2", "unavailable", null]]);
  assert.deepEqual(input.transcriptExcerpts, [], "a routine carries digests and no raw lines");
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

// A correction the researcher made to a delivered result (`result-corrected`, N12) is `correction` evidence about the run
// whose result it was, and each one is its own dispatch.
const correctionEvent = (id = "feedback:result-corrected:aaaa") => ({ id, trigger: "result-corrected", runId: "run_orig",
  subject: { type: "result-version", id: `rv_${"a".repeat(64)}` }, detail: { kind: "analytic", successorOrigin: "system_generated", adoption: "not_recorded" } });

test("a correction is a lesson about the run whose result was corrected, evidence of the researcher and never an adoption", () => {
  const original = run({ id: "run_orig" });
  const lesson = correctionLessonFor({ run: original, runs: [original], project: { id: "p1" }, event: correctionEvent() });
  assert.equal(lesson?.trigger, "correction");
  assert.ok(DISTILLATION_TRIGGERS.includes(lesson?.trigger ?? ""));
  assert.equal(lesson?.payload.runId, "run_orig");
  assert.equal(lesson?.payload.dispatchKey, "feedback:result-corrected:aaaa");
  assert.deepEqual(lesson?.payload.feedbackEventIds, ["feedback:result-corrected:aaaa"]);
  assert.equal(lesson?.idempotencyKey, "distill:run_orig:correction:feedback:result-corrected:aaaa");
  // The distillation reads the event as the researcher's: it is their request, and the signal says so.
  assert.equal(lessonSignal({ trigger: "correction", feedback: lesson?.payload.feedback }), "researcher");
  const input = buildDistillationInput({ run: original, trigger: "correction", transcript: null, feedback: lesson?.payload.feedback });
  assert.equal(input.signal, "researcher");
  assert.equal(input.feedback[0].detail.adoption, "not_recorded");
});

test("a follow-up that corrected the previous run is the same lesson; one that accepted it, or asked something else, is none", () => {
  const original = run({ id: "run_orig" });
  const followUp = (verdict) => ({ id: `feedback:learning-evidence:${verdict}`, trigger: "learning-evidence", runId: "run_orig",
    subject: { type: "run", id: "run_orig" }, detail: { evidence: "follow-up", verdict, rule: "每节只要三行", quote: "不对，每节只要三行", concerns: [] } });
  for (const verdict of ["correction", "preference", "rejection"]) {
    const lesson = correctionLessonFor({ run: original, runs: [original], event: followUp(verdict) });
    assert.equal(lesson?.trigger, "correction", verdict);
    assert.equal(lesson?.payload.runId, "run_orig");
    assert.equal(lesson?.idempotencyKey, `distill:run_orig:correction:feedback:learning-evidence:${verdict}`);
  }
  for (const verdict of ["accept", "none"]) assert.equal(correctionLessonFor({ run: original, runs: [original], event: followUp(verdict) }), null, verdict);
  // A steer is the run's own correction, queued with the run (`afterRun`), and a silent run is nobody's.
  for (const evidence of ["steer", "silent"]) {
    assert.equal(correctionLessonFor({ run: original, runs: [original], event: { id: "e", trigger: "learning-evidence", detail: { evidence, verdict: "correction" } } }), null, evidence);
  }
});

test("a follow-up's lesson reaches the queue through the same gates, and the evidence of a result corrected in the page is mirrored once the gates have passed", async () => {
  const original = run({ id: "run_orig" });
  const project = { id: "project_1", userId: "user_1" };
  const enqueued = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ kind, payload, options }); return { id: "job" }; } };
  const mirrored = [];
  const evidence = { afterRun: async () => {}, mirrorResultCorrected: async (_project, input) => { mirrored.push(input.runId); } };
  const event = { id: "feedback:learning-evidence:x", trigger: "learning-evidence", detail: { evidence: "follow-up", verdict: "correction", rule: "r", quote: "不对" } };
  const triggersWith = (extra = {}) => new LearningTriggers({ jobs, agentRuns: { list: async () => [original] }, evidence, ...extra });
  assert.deepEqual(await triggersWith().afterCorrection(project, { event, runId: "run_orig" }), { queued: ["correction"], skipped: null });
  assert.equal(enqueued[0].options.projectId, "project_1");
  assert.deepEqual(mirrored, [], "a follow-up is already evidence; nothing to mirror");
  const refused = [];
  assert.deepEqual(await triggersWith({ onRefused: (reason) => refused.push(reason) }).afterCorrection(project, { event, runId: "run_gone" }), { queued: [], skipped: "run_unavailable" });
  const resultEvent = correctionEvent();
  await triggersWith().afterCorrection(project, { event: resultEvent, runId: "run_orig" });
  assert.deepEqual(mirrored, ["run_orig"]);
  // Not past the gates: not mirrored either.
  mirrored.length = 0;
  const paused = { configured: true, settings: async () => ({ learningPaused: true, recallPaused: false, pausedProjects: [] }) };
  assert.deepEqual(await triggersWith({ memory: paused }).afterCorrection(project, { event: resultEvent, runId: "run_orig" }), { queued: [], skipped: "paused" });
  assert.deepEqual(mirrored, []);
});

test("a correction passes the gates every other lesson passes", () => {
  const original = run({ id: "run_orig" });
  const event = correctionEvent();
  assert.equal(correctionLessonFor({ run: run({ id: "run_orig", automated: true }), runs: [], event }), null, "the platform's own work");
  assert.equal(correctionLessonFor({ run: original, runs: [original], project: { id: LEARNING_PROJECT_ID }, event }), null, "an internal project");
  assert.equal(correctionLessonFor({ run: original, runs: [original], event, internalAgent: () => true }), null, "an internal capability");
  const unread = run({ id: "run_unread", transcript: { completeness: "partial" } });
  assert.equal(correctionLessonFor({ run: unread, runs: [unread], event }), null, "a transcript that cannot be read");
  assert.equal(correctionLessonFor({ run: run({ id: "r", status: "running" }), runs: [], event }), null);
  assert.equal(correctionLessonFor({ run: original, runs: [original], event: { ...event, trigger: "deliverable-edited" } }), null, "only a correction is this lesson");
});

test("two corrections of one run are two dispatches, and a lesson with no discriminator keeps the identity it always had", () => {
  const first = distillationDispatchId("run_1", "correction", "feedback:result-corrected:aaaa");
  const second = distillationDispatchId("run_1", "correction", "feedback:result-corrected:bbbb");
  assert.notEqual(first, second, "the second correction does not adopt the first one's bounded run");
  assert.equal(distillationDispatchId("run_1", "correction"), distillationDispatchId("run_1", "correction", ""));
  assert.match(first, /^method-distillation-[a-f0-9]{32}$/);
});
