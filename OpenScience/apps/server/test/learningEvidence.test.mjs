// What the researcher did to a run, kept as evidence (2026-10-23): a steer, a follow-up read once on the next turn, a result corrected, silence.
//
// The follow-up is the case that was missing — "no, shorter" is the first message of the next turn, and for a native-memory account nothing
// recorded it. The judge is a small model; what its answer is worth is decided in code (the quotation is a substring of the message, an unknown
// method is dropped, a rule or message carrying a credential is never kept), and a failure is no event and a counter.
import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_FOLLOW_UP_WINDOW_MS, cleanLearningEvidence, isLearningCorrection } from "@evimed/domain";
import { FollowUpJudge, LearningEvidence, LEARNING_EVIDENCE_FAILURES, followUpVerdictFrom, settleKeyFor, unsafeToKeep } from "../src/learningEvidence.mjs";
import { LearningTriggers, routinePeriodMs, ROUTINE_PERIOD_DAYS } from "../src/learningTriggers.mjs";

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);
const project = { id: "p1", userId: "u1", workspaceDir: "/nonexistent" };
const methods = [{ id: "method:learned:weekly-report", digest: "sha256:aaa", title: "周报每节三行", whenToUse: "写周报时" }];

/** A finished run in a session. @param {Record<string, any>} [extra] */
const finished = (extra = {}) => ({
  id: "run_prev", sessionId: "ses_1", status: "succeeded", effectiveAgentId: "open-domain-answer", question: "写本周周报", automated: false,
  artifacts: [], outputFiles: ["report/weekly.md"], transcript: { completeness: "complete" },
  startedAt: new Date(NOW - 40 * 60_000).toISOString(), finishedAt: new Date(NOW - 5 * 60_000).toISOString(), ...extra,
});

/** An in-memory evidence ledger with the semantics of the feedback table's learning-evidence rows. */
function memoryLedger() {
  /** @type {any[]} */ const rows = [];
  return {
    rows,
    async recordLearningEvidence(userId, { runId, projectId, key = "", occurredAt, detail }) {
      const clean = cleanLearningEvidence(detail);
      if (!clean) throw new Error("refused by the vocabulary");
      const id = `${userId}:${runId}:${clean.evidence}:${key}`;
      const held = rows.find((row) => row.id === id);
      if (held) return { event: held, created: false };
      const event = { id, userId, projectId, runId, trigger: "learning-evidence", subject: { type: "run", id: runId }, detail: clean, occurredAt: occurredAt ?? clean.at };
      rows.push(event);
      return { event, created: true };
    },
    async learningEvidenceOf(_userId, runId) { return rows.filter((row) => row.runId === runId); },
    async cleanSettledRuns(_userId, { scope, from, to }) {
      return rows.filter((row) => row.detail.scope === scope && Date.parse(row.occurredAt) >= from.getTime() && Date.parse(row.occurredAt) < to.getTime()
        && (row.detail.evidence === "silent" || (row.detail.evidence === "follow-up" && !isLearningCorrection(row.detail))) && row.detail.shape
        && !rows.some((other) => other.runId === row.runId && isLearningCorrection(other.detail)))
        .map((row) => ({ runId: row.runId, projectId: row.projectId, at: row.occurredAt, shape: row.detail.shape }));
    },
  };
}

/** @param {{ runs?: any[], answer?: string | null | (() => Promise<string | null>), refusal?: string | null, ledger?: ReturnType<typeof memoryLedger>, opened?: any[], shapes?: any, failures?: string[] }} [options] */
function setup({ runs = [finished()], answer = null, refusal = null, ledger = memoryLedger(), opened = methods, shapes = { "report/weekly.md": { format: "md", labels: ["summary", "findings"] } }, failures = [] } = {}) {
  /** @type {any[]} */ const enqueued = [];
  /** @type {string[]} */ const brought = [];
  /** @type {any[]} */ const lessons = [];
  /** @type {any[]} */ const asked = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ userId, kind, payload, options }); return { id: "job" }; }, bringForward: async (_userId, key) => { brought.push(key); return true; } };
  const triggers = {
    refusalFor: async () => refusal,
    afterCorrection: async (_project, input) => { lessons.push(input); return { queued: ["correction"], skipped: null }; },
    queue: async (_project, _run, lesson) => { lessons.push(lesson); return true; },
    guestInfluenced: async () => false,
  };
  const judge = { available: true, read: async (request, owner) => { asked.push({ request, owner }); return typeof answer === "function" ? answer() : answer; } };
  const evidence = new LearningEvidence({
    feedback: ledger, jobs, agentRuns: { list: async () => runs }, triggers: () => triggers, judge: /** @type {any} */ (judge),
    methodsOpened: async () => opened, resolveProject: async () => project, readShapes: async () => shapes, report: (reason) => failures.push(reason),
    now: () => new Date(NOW),
  });
  return { evidence, ledger, enqueued, brought, lessons, asked, failures };
}

const verdict = (extra = {}) => JSON.stringify({ verdict: "correction", rule: "周报每一节只写三行", quote: "不对，每节只要三行", concerns: [], ...extra });

// ---------------------------------------------------------------------------------------------------- what an answer is worth

test("a judge's answer is worth what code can check of it: the quotation is in the message, the methods are the run's, nothing unsafe is kept", () => {
  const message = "不对，每节只要三行，别再写长了";
  const read = (content) => followUpVerdictFrom(content, { message, methods });
  assert.deepEqual(read(verdict({ concerns: ["method:learned:weekly-report", "method:learned:made-up"] })), {
    verdict: "correction", rule: "周报每一节只写三行", quote: "不对，每节只要三行", concerns: [{ id: "method:learned:weekly-report", digest: "sha256:aaa" }],
  }, "an unknown method is dropped, a known one carries the digest of the body the run opened");
  assert.deepEqual(read(JSON.stringify({ verdict: "accept", rule: "ignored", quote: "ignored", concerns: ["method:learned:weekly-report"] })), { verdict: "accept", rule: null, quote: null, concerns: [] });
  assert.deepEqual(read(JSON.stringify({ verdict: "none" })), { verdict: "none", rule: null, quote: null, concerns: [] });
  assert.deepEqual(read(`\`\`\`json\n${verdict()}\n\`\`\``), read(verdict()), "a fenced answer reads the same");
  assert.equal(followUpVerdictFrom(verdict({ quote: "不对， 每节只要三行" }), { message: "不对，\n每节只要三行", methods }).quote, "不对， 每节只要三行", "white space may differ");

  assert.deepEqual(read(verdict({ quote: "每一节只能有三行" })), { failure: "quote_not_found" }, "a paraphrase is not evidence, and the verdict goes with it");
  assert.deepEqual(read(verdict({ quote: null })), { failure: "quote_not_found" });
  assert.deepEqual(read(verdict({ rule: "" })), { failure: "judge_unreadable" });
  assert.deepEqual(read(verdict({ rule: "密码是 hunter2hunter2" })), { failure: "rule_unsafe" });
  assert.deepEqual(read(verdict({ verdict: "applause" })), { failure: "judge_unreadable" });
  assert.deepEqual(read("not json at all"), { failure: "judge_unreadable" });
  assert.deepEqual(read(""), { failure: "judge_unreadable" });
  assert.ok(LEARNING_EVIDENCE_FAILURES.includes("quote_not_found"));
  assert.equal(unsafeToKeep("我的手机号 13800138000"), true);
  assert.equal(unsafeToKeep("每节只要三行"), false);
});

test("the judge calls the model gateway for purpose learning with thinking off, and a failure is null, never a throw", async () => {
  const calls = [];
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "deepseek-flash", modelGatewayTimeoutMs: 5000 };
  const judge = new FollowUpJudge(config, { callModel: async (deps, call) => { calls.push({ deps, call }); return { choices: [{ message: { content: verdict() } }] }; } });
  assert.equal(judge.available, true);
  const answer = await judge.read({ message: "不对，每节只要三行", previousRequest: "写周报", methods: [] }, { userId: "u1", projectId: "p1", runId: "run_prev" });
  assert.equal(answer, verdict());
  assert.equal(calls[0].call.purpose, "learning");
  assert.deepEqual(calls[0].call.body.thinking, { type: "disabled" });
  assert.equal(calls[0].call.body.temperature, 0);
  assert.equal(calls[0].call.runId, "run_prev");
  const user = JSON.parse(calls[0].call.body.messages[1].content);
  assert.deepEqual(Object.keys(user), ["message", "previousRequest", "methods"]);
  assert.equal(await new FollowUpJudge(config, { callModel: async () => { throw Object.assign(new Error("402"), { code: "insufficient_quota" }); } })
    .read({ message: "m", previousRequest: "", methods: [] }, { userId: "u1", projectId: "p1", runId: "r" }), null);
  assert.equal(new FollowUpJudge({ deepseekProviderEnabled: false }).available, false);
});

// ---------------------------------------------------------------------------------------------------- the follow-up

test("a correction on the next turn is one evidence event, a correction lesson and a settled run, and names the methods it is about", async () => {
  const run = setup({ answer: verdict({ concerns: ["method:learned:weekly-report"] }) });
  const result = await run.evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对，每节只要三行，别再写长了", requestId: "req_9" });
  assert.deepEqual(result, { recorded: true, verdict: "correction", runId: "run_prev", queued: ["correction"] });
  assert.equal(run.ledger.rows.length, 1);
  const [event] = run.ledger.rows;
  assert.equal(event.runId, "run_prev");
  assert.deepEqual({ ...event.detail, at: undefined }, {
    evidence: "follow-up", verdict: "correction", rule: "周报每一节只写三行", quote: "不对，每节只要三行",
    concerns: [{ id: "method:learned:weekly-report", digest: "sha256:aaa" }], sessionId: "ses_1", at: undefined, scope: "conversation", endedAt: finished().finishedAt,
  }, "a corrected run carries no shape: it is in no routine's family");
  assert.equal(run.lessons.length, 1, "the correction lesson is queued through the triggers' gates");
  assert.equal(run.lessons[0].runId, "run_prev");
  assert.deepEqual(run.brought, [settleKeyFor("run_prev")], "the run is settled by this reaction and need not wait out its window");
  // The judge was shown the message, the request it answers and the cards of the methods that run opened.
  assert.equal(run.asked[0].request.previousRequest, "写本周周报");
  assert.deepEqual(run.asked[0].request.methods, [{ id: "method:learned:weekly-report", title: "周报每节三行", whenToUse: "写周报时" }]);
  assert.deepEqual(run.asked[0].owner, { userId: "u1", projectId: "p1", runId: "run_prev" });
  // The same turn read again is the same event.
  await run.evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对，每节只要三行，别再写长了", requestId: "req_9" });
  assert.equal(run.ledger.rows.length, 1);
});

test("an acceptance or a new question is evidence too, carries the shape of what the run left, and queues no lesson", async () => {
  for (const kind of ["accept", "none"]) {
    const run = setup({ answer: JSON.stringify({ verdict: kind }) });
    assert.deepEqual(await run.evidence.onNewTurn(project, { sessionId: "ses_1", text: "好的，谢谢", requestId: "req_1" }), { recorded: true, verdict: kind, runId: "run_prev", queued: [] });
    assert.deepEqual(run.ledger.rows[0].detail.shape, [{ format: "md", labels: ["summary", "findings"] }], kind);
    assert.equal(run.ledger.rows[0].detail.rule, null);
    assert.equal(run.lessons.length, 0);
  }
});

test("nothing is recorded when there is nothing to react to, or when the message or the run may not be read", async () => {
  const text = "不对，每节只要三行";
  const ask = (options, turn = {}) => setup({ answer: verdict(), ...options }).evidence.onNewTurn(project, { sessionId: "ses_1", text, requestId: "r", ...turn });
  assert.deepEqual(await ask({ runs: [] }), { recorded: false, reason: "no_previous_run" });
  assert.deepEqual(await ask({}, { sessionId: "ses_other" }), { recorded: false, reason: "no_previous_run" });
  assert.deepEqual(await ask({ runs: [finished({ finishedAt: new Date(NOW - LEARNING_FOLLOW_UP_WINDOW_MS - 60_000).toISOString() })] }), { recorded: false, reason: "no_previous_run" }, "past the thirty minutes");
  assert.deepEqual(await ask({ runs: [finished({ status: "failed" })] }), { recorded: false, reason: "no_previous_run" });
  assert.deepEqual(await ask({ runs: [finished(), finished({ id: "run_going", status: "running", finishedAt: null })] }), { recorded: false, reason: "run_in_progress" });
  assert.deepEqual(await ask({ refusal: "clinical_context" }), { recorded: false, reason: "clinical_context" });
  assert.deepEqual(await ask({}, { text: "" }), { recorded: false, reason: "no_judge" });
  const unsafe = setup({ answer: verdict() });
  assert.deepEqual(await unsafe.evidence.onNewTurn(project, { sessionId: "ses_1", text: "我的密码是 abcdef123456，不对", requestId: "r" }), { recorded: false, reason: "sensitive" });
  assert.deepEqual(unsafe.failures, ["sensitive"]);
  assert.equal(unsafe.asked.length, 0, "a message carrying a credential never reaches the model");
});

test("a judge that fails, an answer that cannot be checked and a store that refuses are a counter and no event", async () => {
  const text = "不对，每节只要三行，别再写长了";
  const turn = { sessionId: "ses_1", text, requestId: "r" };
  const failed = setup({ answer: null });
  assert.deepEqual(await failed.evidence.onNewTurn(project, turn), { recorded: false, reason: "judge_failed" });
  const wrong = setup({ answer: verdict({ quote: "我没有说过这句话" }) });
  assert.deepEqual(await wrong.evidence.onNewTurn(project, turn), { recorded: false, reason: "quote_not_found" });
  const broken = setup({ answer: verdict() });
  broken.ledger.recordLearningEvidence = async () => { throw new Error("database down"); };
  assert.deepEqual(await broken.evidence.onNewTurn(project, turn), { recorded: false, reason: "record_failed" });
  assert.deepEqual([failed, wrong, broken].map((entry) => entry.failures), [["judge_failed"], ["quote_not_found"], ["record_failed"]]);
  for (const entry of [failed, wrong]) assert.equal(entry.ledger.rows.length, 0);
  assert.equal(failed.lessons.length + wrong.lessons.length, 0);
  // A judge that is not composed (no key) is a counter, not an error.
  const off = setup({ answer: verdict() });
  off.evidence.judge = /** @type {any} */ ({ available: false, read: async () => null });
  assert.deepEqual(await off.evidence.onNewTurn(project, turn), { recorded: false, reason: "judge_unavailable" });
  assert.deepEqual(off.failures, ["judge_unavailable"]);
});

test("only a few judgements are in flight at once; the rest are a counter, and the turn is never held", async () => {
  /** @type {(() => void)[]} */ const release = [];
  const run = setup({ answer: () => new Promise((resolve) => { release.push(() => resolve(JSON.stringify({ verdict: "none" }))); }) });
  const turns = Array.from({ length: 6 }, (_, index) => run.evidence.onNewTurn(project, { sessionId: "ses_1", text: "继续下一部分", requestId: `r${index}` }));
  await new Promise((resolve) => setImmediate(resolve));
  const busy = (await Promise.all(turns.slice(4))).map((result) => result.reason);
  assert.deepEqual(busy, ["busy", "busy"]);
  for (const done of release) done();
  const settled = await Promise.all(turns.slice(0, 4));
  assert.ok(settled.every((result) => result.recorded));
  assert.deepEqual(run.failures, ["busy", "busy"]);
});

// ---------------------------------------------------------------------------------------------------- a steer, a result corrected, a run finished

test("a steer typed into the run is written as evidence when the run finishes, in the researcher's own words, and a sensitive one is not", async () => {
  const run = setup({});
  const steered = finished({ corrections: 3, steers: [
    { requestId: "req_a", text: "再短一点", at: "2026-10-23T09:50:00.000Z" },
    { requestId: "req_b", text: "我的密码是 abcdef123456", at: "2026-10-23T09:51:00.000Z" },
    { requestId: "req_c", text: "数字都带单位", at: "2026-10-23T09:52:00.000Z" },
  ] });
  await run.evidence.afterRun(project, steered);
  assert.deepEqual(run.ledger.rows.map((row) => [row.detail.evidence, row.detail.verdict, row.detail.quote, row.detail.scope]), [
    ["steer", "correction", "再短一点", "conversation"], ["steer", "correction", "数字都带单位", "conversation"],
  ]);
  assert.equal(run.ledger.rows[0].detail.at, "2026-10-23T09:50:00.000Z");
  assert.deepEqual(run.failures, ["sensitive"]);
  await run.evidence.afterRun(project, steered);
  assert.equal(run.ledger.rows.length, 2, "written again, written once");
});

test("a delivery is queued to be settled thirty minutes after it ended, once; an answer, a failure and a run with no file are not", async () => {
  const run = setup({});
  const delivery = finished();
  assert.deepEqual(await run.evidence.afterRun(project, delivery, { guestInfluence: true }), { settle: new Date(NOW - 5 * 60_000 + LEARNING_FOLLOW_UP_WINDOW_MS).toISOString() });
  assert.equal(run.enqueued.length, 1);
  assert.deepEqual([run.enqueued[0].kind, run.enqueued[0].options.idempotencyKey, run.enqueued[0].options.projectId], ["learning-evidence", "learning-evidence:settle:run_prev", "p1"]);
  assert.equal(run.enqueued[0].options.runAfter.toISOString(), new Date(NOW - 5 * 60_000 + LEARNING_FOLLOW_UP_WINDOW_MS).toISOString());
  assert.deepEqual(run.enqueued[0].payload, { runId: "run_prev", sessionId: "ses_1", guestInfluence: true });
  for (const other of [finished({ outputFiles: [] }), finished({ status: "failed" })]) assert.deepEqual(await run.evidence.afterRun(project, other), { settle: null });
  assert.equal(run.enqueued.length, 1);
});

test("a result corrected in the page is mirrored as evidence on the run it was corrected in, with the researcher's instruction unless it must not be kept", async () => {
  const run = setup({});
  await run.evidence.mirrorResultCorrected(project, { runId: "run_prev", event: { id: "feedback:result-corrected:1", occurredAt: "2026-10-23T09:30:00.000Z", detail: { instruction: "把第二节删掉" } } });
  await run.evidence.mirrorResultCorrected(project, { runId: "run_prev", event: { id: "feedback:result-corrected:2", detail: { instruction: "密码 abcdef123456 写进去" } } });
  assert.deepEqual(run.ledger.rows.map((row) => [row.detail.evidence, row.detail.verdict, row.detail.quote]), [["result-corrected", "correction", "把第二节删掉"], ["result-corrected", "correction", null]]);
  assert.equal(run.ledger.rows[0].occurredAt, "2026-10-23T09:30:00.000Z");
});

// ---------------------------------------------------------------------------------------------------- settling

/** The settle job of a run. @param {string} runId */
const settleJob = (runId = "run_prev") => ({ userId: "u1", projectId: "p1", payload: { runId, sessionId: "ses_1" } });

test("a run nobody reacted to is settled as silent, with the shape of what it left; settling twice is settling once", async () => {
  const run = setup({});
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false });
  assert.equal(run.ledger.rows.length, 1);
  const [event] = run.ledger.rows;
  assert.deepEqual([event.detail.evidence, event.detail.verdict, event.detail.scope, event.detail.sessionId], ["silent", "none", "conversation", "ses_1"]);
  assert.deepEqual(event.detail.shape, [{ format: "md", labels: ["summary", "findings"] }]);
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false });
  assert.equal(run.ledger.rows.length, 1);
});

test("a store that will not take the silence of a settled run fails the job, so the worker retries it, rather than finishing it with nothing written", async () => {
  const run = setup({});
  run.ledger.recordLearningEvidence = async () => { throw new Error("database down"); };
  await assert.rejects(() => run.evidence.settle({ job: settleJob() }), (error) => /** @type {any} */ (error).code === "learning_evidence_record_failed");
  assert.deepEqual(run.failures, ["record_failed"]);
});

test("a run that was corrected, by a steer, a follow-up or a result, is not clean: no silence is written and no routine is looked for", async () => {
  for (const reaction of [
    { evidence: "steer", quote: "再短一点" },
    { evidence: "follow-up", verdict: "preference", rule: "以后都用表格", quote: "以后都用表格" },
    { evidence: "result-corrected", quote: "把第二节删掉" },
  ]) {
    const run = setup({});
    await run.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { ...reaction, at: new Date(NOW).toISOString(), scope: "conversation" } });
    assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "corrected", routine: false }, reaction.evidence);
    assert.equal(run.ledger.rows.length, 1);
  }
  // A follow-up that accepted it is a settlement already: no silence beside it.
  const accepted = setup({});
  await accepted.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "follow-up", verdict: "accept", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.deepEqual(await accepted.evidence.settle({ job: settleJob() }), { settled: "follow-up", routine: false });
  assert.equal(accepted.ledger.rows.length, 1);
});

test("the third clean run of one shape in a scope completes a routine; a corrected one does not count; the gates apply", async () => {
  const period = routinePeriodMs(ROUTINE_PERIOD_DAYS);
  const run = setup({});
  const at = new Date(NOW).toISOString();
  const settle = (runId) => run.evidence.settle({ job: settleJob(runId) });
  run.ledger.rows.push(
    ...["fam_1", "fam_2"].map((runId, index) => ({ id: `s${index}`, userId: "u1", projectId: index ? "other" : "p1", runId, occurredAt: at, trigger: "learning-evidence",
      detail: { evidence: "silent", verdict: "none", scope: "conversation", shape: [{ format: "md", labels: ["summary", "findings"] }], at } })),
  );
  const result = await settle("run_prev");
  assert.deepEqual(result, { settled: "silent", routine: true });
  const lesson = run.lessons.find((entry) => entry.trigger === "routine");
  assert.equal(lesson.idempotencyKey, "distill:run_prev:routine");
  assert.deepEqual(lesson.payload.peers, [{ runId: "fam_1", projectId: "p1" }, { runId: "fam_2", projectId: "other" }]);
  assert.equal(lesson.payload.scope, "conversation");

  // A family member that was later corrected is not family.
  const corrected = setup({});
  corrected.ledger.rows.push(
    { id: "a", userId: "u1", projectId: "p1", runId: "fam_1", occurredAt: at, trigger: "learning-evidence", detail: { evidence: "silent", verdict: "none", scope: "conversation", shape: [{ format: "md", labels: [] }], at } },
    { id: "b", userId: "u1", projectId: "p1", runId: "fam_2", occurredAt: at, trigger: "learning-evidence", detail: { evidence: "silent", verdict: "none", scope: "conversation", shape: [{ format: "md", labels: [] }], at } },
    { id: "c", userId: "u1", projectId: "p1", runId: "fam_2", occurredAt: at, trigger: "learning-evidence", detail: { evidence: "result-corrected", verdict: "correction", scope: "conversation", at } },
  );
  assert.deepEqual(await corrected.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false });
  assert.equal(period > 0, true);

  // Another scope's runs, and the gates.
  const other = setup({ runs: [finished({ effectiveAgentId: "geo-content" })] });
  other.ledger.rows.push(...["x", "y"].map((runId, index) => ({ id: `o${index}`, userId: "u1", projectId: "p1", runId, occurredAt: at, trigger: "learning-evidence",
    detail: { evidence: "silent", verdict: "none", scope: "conversation", shape: [{ format: "md", labels: [] }], at } })));
  assert.equal((await other.evidence.settle({ job: settleJob() })).routine, false, "the family is the scope's");
  assert.deepEqual(await setup({ refusal: "paused" }).evidence.settle({ job: settleJob() }), { settled: null, routine: false, skipped: "paused" });
  assert.deepEqual(await setup({ runs: [] }).evidence.settle({ job: settleJob() }), { settled: null, routine: false, skipped: "run_unavailable" });
});

test("a run whose files left no readable shape is settled but never counted towards a routine", async () => {
  const run = setup({ shapes: {} });
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false });
  assert.equal(run.ledger.rows[0].detail.shape, undefined);
});

test("the loop's triggers hand a finished run to the evidence ledger and the evidence ledger asks them for every gate", async () => {
  // Wired both ways, with the real triggers: afterRun hands the ledger's copy of the run over; the evidence asks the triggers whether a run may be read.
  const run = finished({ corrections: 1, steers: [{ requestId: "req_a", text: "再短一点", at: new Date(NOW).toISOString() }] });
  const ledger = memoryLedger();
  /** @type {any} */ let triggers = null;
  const jobs = { enqueue: async () => ({ id: "job" }), bringForward: async () => true };
  const evidence = new LearningEvidence({ feedback: ledger, jobs, agentRuns: { list: async () => [run] }, triggers: () => triggers, judge: null, resolveProject: async () => project,
    readShapes: async () => ({ "report/weekly.md": { format: "md", labels: ["a", "b"] } }), now: () => new Date(NOW) });
  triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => [run], runWorkflowProjection: async () => null }, evidence });
  assert.deepEqual(await triggers.afterRun(project, run), { queued: ["correction"], skipped: null });
  assert.deepEqual(ledger.rows.map((row) => row.detail.evidence), ["steer"]);
  // Paused: nothing is read, nothing recorded, and the loop says why.
  const paused = { configured: true, settings: async () => ({ learningPaused: true, recallPaused: false, pausedProjects: [] }) };
  ledger.rows.length = 0;
  triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => [run], runWorkflowProjection: async () => null }, evidence, memory: paused });
  assert.deepEqual(await triggers.afterRun(project, run), { queued: [], skipped: "paused" });
  assert.equal(ledger.rows.length, 0);
  assert.deepEqual(await evidence.onNewTurn(project, { sessionId: "ses_1", text: "继续", requestId: "r" }), { recorded: false, reason: "no_judge" });
  assert.deepEqual(await evidence.settle({ job: settleJob() }), { settled: null, routine: false, skipped: "paused" });
});

test("a plain 「不对，短一点」 on a native-memory account is one evidence event and a correction lesson through the real triggers: the loop never asks which engine holds the memory", async () => {
  const previous = finished({ id: "run_prev" });
  const ledger = memoryLedger();
  /** @type {any[]} */ const queued = [];
  const jobs = { enqueue: async (_userId, kind, payload, options) => { queued.push({ kind, payload, options }); return { id: "job" }; }, bringForward: async () => true };
  // The account's memory is the engine's own: the legacy extractor never runs for it, which is why no correction ever reached the loop.
  const native = { configured: true, settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: [], engine: "native" }), resetInstant: async () => null };
  /** @type {any} */ let triggers = null;
  const evidence = new LearningEvidence({
    feedback: ledger, jobs, agentRuns: { list: async () => [previous] }, triggers: () => triggers,
    judge: /** @type {any} */ ({ available: true, read: async () => JSON.stringify({ verdict: "correction", rule: "回答写得更短", quote: "不对，短一点", concerns: [] }) }),
    resolveProject: async () => project, readShapes: async () => ({}), now: () => new Date(NOW),
  });
  triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => [previous], runWorkflowProjection: async () => null }, evidence, memory: native });
  const result = await evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对，短一点", requestId: "req_native" });
  assert.deepEqual(result, { recorded: true, verdict: "correction", runId: "run_prev", queued: ["correction"] });
  assert.equal(ledger.rows.length, 1, "one learning-evidence event");
  assert.deepEqual([ledger.rows[0].detail.evidence, ledger.rows[0].detail.verdict, ledger.rows[0].detail.quote], ["follow-up", "correction", "不对，短一点"]);
  const lesson = queued.find((entry) => entry.kind === "distill");
  assert.equal(lesson?.payload.trigger, "correction");
  assert.equal(lesson?.payload.runId, "run_prev");
  assert.deepEqual(lesson?.payload.feedbackEventIds, [ledger.rows[0].id]);
  assert.equal(lesson?.payload.feedback[0].detail.quote, "不对，短一点", "the distillation is handed the researcher's own words");
});
